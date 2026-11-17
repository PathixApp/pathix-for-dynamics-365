// Fitness test for "Metadata only, in both modes" (DESIGN.md, "Names, never
// values"): every Lite request goes through one client, and the client sends
// nothing outside a pinned allowlist of metadata tables and functions.
//
// If this fails because a milestone needs a new table, change the pinned list
// in the same pull request and say why. Never add a business table, audit
// data or plugin-trace logs.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EXPANDABLE, FILTER_REQUIRED, METADATA_ENTITY_SETS, METADATA_FUNCTIONS, USER_BOUND } from "../scripts/capture-dataverse-fixtures.mjs";
import {
  LITE_ENTITY_SETS,
  LITE_EXPANDS,
  LITE_FILTERS,
  LITE_FILTERED,
  LITE_FUNCTION_CALLS,
  LITE_FUNCTIONS,
  LITE_NAVIGATIONS,
  LITE_SELECTS,
  LITE_USER_BOUND,
  refusalFor,
} from "../src/dataverse/allowlist";
import { createDataverseClient, DATAVERSE_TIMEOUT_MS, DataverseRefusedError, MAX_CACHE_ENTRIES, type FetchLike } from "../src/dataverse/client";
import { liveRefFor } from "../src/card/freshness";
import { inFilter } from "../src/dataverse/queries";
import { loadLiteChanges, loadLiveModified } from "../src/lite/changes";
import { loadDependenciesCard } from "../src/lite/dependencies";
import { loadUserSecurity } from "../src/lite/user-security";
import { loadLockedCard } from "../src/lite/locked";
import { loadRegisteredCard } from "../src/lite/registered";
import { fakeDataverse, ORIGIN } from "./fake-dataverse";

const API = `${ORIGIN}/api/data/v9.2/`;

describe("the Lite allowlist", () => {
  it("is pinned", () => {
    expect([...LITE_ENTITY_SETS].sort()).toEqual([
      "EntityDefinitions",
      "RelationshipDefinitions",
      "fieldpermissions",
      "fieldsecurityprofiles",
      "publishers",
      "roleprivilegescollection",
      "savedqueries",
      "savedqueryvisualizations",
      "sdkmessageprocessingstepimages",
      "sdkmessageprocessingsteps",
      "solutions",
      "systemforms",
      "teamprofilescollection",
      "teamrolescollection",
      "workflows",
    ]);
    expect([...LITE_FUNCTIONS]).toEqual(["RetrieveDependentComponents", "WhoAmI"]);
    expect([...LITE_FUNCTION_CALLS.keys()]).toEqual([...LITE_FUNCTIONS]);
    expect([...LITE_USER_BOUND].sort()).toEqual([
      "Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames",
      "systemuserprofiles_association",
      "teammembership_association",
    ]);
    expect([...LITE_FILTERED.keys()].sort()).toEqual(["roleprivilegescollection", "teamprofilescollection", "teamrolescollection"]);
    expect([...LITE_NAVIGATIONS]).toEqual(["Attributes"]);
    expect([...LITE_EXPANDS].map(([set, lookups]) => [set, [...lookups].sort()])).toEqual([
      ["sdkmessageprocessingsteps", ["sdkmessagefilterid", "sdkmessageid"]],
    ]);
  });

  it("asks about the user only what the fixture capture may ask", () => {
    expect([...LITE_USER_BOUND].filter((bound) => !USER_BOUND.has(bound))).toEqual([]);
  });

  it("filters every set the fixture capture says must be filtered, and no other", () => {
    expect([...LITE_FILTERED.keys()].sort()).toEqual([...FILTER_REQUIRED].sort());
  });

  it("expands only lookups the fixture capture may expand", () => {
    const lookups = [...LITE_EXPANDS.values()].flatMap((set) => [...set]);
    expect(lookups.filter((lookup) => !EXPANDABLE.has(lookup))).toEqual([]);
  });

  it("stays inside what the fixture capture may read, so every Lite query can be captured", () => {
    expect([...LITE_ENTITY_SETS].filter((set) => !METADATA_ENTITY_SETS.has(set))).toEqual([]);
    expect([...LITE_FUNCTIONS].filter((fn) => !METADATA_FUNCTIONS.has(fn))).toEqual([]);
  });

  it.each([
    "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')?$select=MetadataId",
    "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)",
    "systemforms?$select=formid,name&$filter=Microsoft.Dynamics.CRM.In(PropertyName='formid',PropertyValues=['5c4a0000-0000-4000-8000-000000000021'])",
    "RelationshipDefinitions(5c4a0000-0000-4000-8000-000000000013)?$select=SchemaName",
    "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode)&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'&$orderby=stage,rank",
    "solutions?$select=solutionid,_publisherid_value&$filter=Microsoft.Dynamics.CRM.In(PropertyName='solutionid',PropertyValues=['5c4a0000-0000-4000-8000-000000000076'])",
    "publishers?$select=publisherid,uniquename,friendlyname&$filter=Microsoft.Dynamics.CRM.In(PropertyName='publisherid',PropertyValues=['5c4a0000-0000-4000-8000-000000000195'])",
    "WhoAmI",
    "systemusers(5c4a0000-0000-4000-8000-000000000002)/systemuserprofiles_association?$select=fieldsecurityprofileid,name",
    "systemusers(5c4a0000-0000-4000-8000-000000000002)/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvWriteAccount','prvReadAccount']",
    "systemusers(5c4a0000-0000-4000-8000-000000000002)/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvReadWorkflow','prvReadTeam','prvReadRole']",
    "fieldpermissions?$select=attributelogicalname,canupdate&$filter=entityname eq 'account'",
    "systemusers(5c4a0000-0000-4000-8000-000000000002)/teammembership_association?$select=teamid,name,teamtype",
    "teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301'])",
    "teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301','5c4a0000-0000-4000-8000-000000000302'])",
    "teamprofilescollection?$select=teamid,fieldsecurityprofileid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301'])",
    "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq 5c4a0000-0000-4000-8000-000000000298 and Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=['5c4a0000-0000-4000-8000-000000000311','5c4a0000-0000-4000-8000-000000000312'])",
  ])("accepts %s", (path) => {
    expect(refusalFor(path)).toBeNull();
  });

  it.each([
    ["a business table", "accounts?$select=name"],
    ["contacts", "contacts?$select=fullname"],
    ["audit data", "audits?$select=changedata"],
    ["plugin trace logs", "plugintracelogs?$select=messageblock"],
    ["the user record", "systemusers?$select=fullname"],
    ["WhoAmI with a query", "WhoAmI?$select=UserId"],
    ["WhoAmI with a path", "WhoAmI/x"],
    ["WhoAmI with parameters", "WhoAmI(UserId=5c4a0000-0000-4000-8000-000000000002)"],
    // Review X3: a function takes its pinned parameters and no query option.
    ["dependents with an expand", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)?$expand=createdby($select=fullname)"],
    ["dependents with a $select", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)?$select=dependentcomponentobjectid"],
    ["dependents with a $filter", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)?$filter=dependentcomponenttype eq 29"],
    ["dependents with an empty query", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)?"],
    ["dependents with an extra parameter", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2,Extra=1)"],
    ["dependents with a parameter alias", "RetrieveDependentComponents(ObjectId=@p1,ComponentType=2)?@p1=5c4a0000-0000-4000-8000-000000000004"],
    ["dependents of an object id that is not a GUID", "RetrieveDependentComponents(ObjectId='x',ComponentType=2)"],
    ["dependents of another component type", "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=1)"],
    ["dependents with the parameters swapped", "RetrieveDependentComponents(ComponentType=2,ObjectId=5c4a0000-0000-4000-8000-000000000004)"],
    ["dependents with no parameters", "RetrieveDependentComponents"],
    ["a user's record", "systemusers(5c4a0000-0000-4000-8000-000000000002)?$select=fullname"],
    ["a user's manager", "systemusers(5c4a0000-0000-4000-8000-000000000002)/parentsystemuserid?$select=fullname"],
    ["users by name", "systemusers?$select=systemuserid&$filter=fullname eq 'Dana'"],
    ["a user's roles", "systemusers(5c4a0000-0000-4000-8000-000000000002)/systemuserroles_association?$select=name"],
    ["a user's profiles with no $select", "systemusers(5c4a0000-0000-4000-8000-000000000002)/systemuserprofiles_association"],
    ["a user's profiles with an expand", "systemusers(5c4a0000-0000-4000-8000-000000000002)/systemuserprofiles_association?$select=name&$expand=x($select=y)"],
    ["a user's profiles by name instead of id", "systemusers(fullname='Dana')/systemuserprofiles_association?$select=name"],
    ["privileges with free text", "systemusers(5c4a0000-0000-4000-8000-000000000002)/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['x') or 1 eq 1']"],
    ["privileges with an extra option", "systemusers(5c4a0000-0000-4000-8000-000000000002)/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvWriteAccount']&$select=x"],
    ["every team's roles", "teamrolescollection?$select=teamid,roleid"],
    ["team roles filtered by something else", "teamrolescollection?$select=teamid,roleid&$filter=roleid eq 5c4a0000-0000-4000-8000-000000000311"],
    ["team roles filtered by a value that is not a GUID", "teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['x') or 1 eq 1'])"],
    ["team roles with a second filter option", "teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301'])&$filter=teamid ne null"],
    ["team roles with an expand", "teamrolescollection?$select=teamid,roleid&$expand=teamid($select=name)&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301'])"],
    ["team profiles with no filter", "teamprofilescollection?$select=teamid,fieldsecurityprofileid"],
    ["every role's privileges", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask"],
    ["role privileges filtered by role", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=roleid eq 5c4a0000-0000-4000-8000-000000000311"],
    ["one privilege across every role", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq 5c4a0000-0000-4000-8000-000000000298"],
    ["role privileges for roles, with no privilege", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=['5c4a0000-0000-4000-8000-000000000311'])"],
    ["role privileges with a second condition", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq 5c4a0000-0000-4000-8000-000000000298 and Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=['5c4a0000-0000-4000-8000-000000000311']) or privilegeid ne null"],
    ["role privileges with free text in the role list", "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq 5c4a0000-0000-4000-8000-000000000298 and Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=['x') or 1 eq 1'])"],
    ["role privileges with a filter that is not one privilege", "roleprivilegescollection?$select=roleid&$filter=privilegeid eq 5c4a0000-0000-4000-8000-000000000298 or privilegeid ne null"],
    ["the teams list", "teams?$select=name"],
    ["a team's roles by team id", "teams(5c4a0000-0000-4000-8000-000000000301)/teamroles_association?$select=name"],
    ["the roles list", "roles?$select=name"],
    ["a user's teams with an extra option", "systemusers(5c4a0000-0000-4000-8000-000000000002)/teammembership_association?$select=teamid&$filter=name eq 'x'"],
    ["a user's teams with no $select", "systemusers(5c4a0000-0000-4000-8000-000000000002)/teammembership_association"],
    ["another user's teams by name", "systemusers(fullname='Dana')/teammembership_association?$select=teamid"],
    ["a metadata table without $select", "workflows?$filter=category eq 0"],
    ["an empty $select", "workflows?$select=&$filter=category eq 0"],
    ["an expand", "workflows?$select=name&$expand=ownerid($select=fullname)"],
    ["an expand of a step's owner, a user record", "sdkmessageprocessingsteps?$select=name&$expand=createdby($select=fullname)"],
    ["an expand of a step's impersonating user", "sdkmessageprocessingsteps?$select=name&$expand=impersonatinguserid($select=fullname)"],
    ["an expand without its own $select", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid"],
    ["a nested expand", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name;$expand=createdby($select=fullname))"],
    ["an expand with a filter inside", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name;$filter=name eq 'x')"],
    ["two expand options", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name)&$expand=createdby($select=fullname)"],
    ["an expand in another case", "sdkmessageprocessingsteps?$select=name&$EXPAND=createdby($select=fullname)"],
    ["an allowed lookup listed beside one that is not", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name),modifiedby($select=fullname)"],
    ["an expand on a table that takes none", "solutions?$select=name&$expand=sdkmessageid($select=name)"],
    ["a solution's components", "solutioncomponents?$select=objectid"],
    ["navigation out of metadata", "workflows(5c4a0000-0000-4000-8000-000000000035)/workflow_logs?$select=name"],
    ["an attribute's option set navigation", "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')/OptionSet?$select=Options"],
    ["an absolute URL", "https://evil.example.com/api/data/v9.2/WhoAmI"],
    ["a protocol-relative URL", "//evil.example.com/x"],
    ["a rooted path", "/api/data/v9.2/accounts?$select=name"],
    ["a parent path", "../../accounts?$select=name"],
    ["a backslash parent path", "EntityDefinitions(LogicalName='account')\\..\\accounts?$select=name"],
    ["an encoded parent path behind a backslash", "EntityDefinitions(LogicalName='account')\\%2e%2e\\accounts?$select=name"],
    ["an encoded parent path", "EntityDefinitions(LogicalName='account')/%2E%2E/accounts?$select=name"],
    ["an encoded slash", "EntityDefinitions(LogicalName='account')%2F..%2Faccounts?$select=name"],
    ["a batch", "$batch"],
    ["the metadata document", "$metadata"],
    ["an encoded expand", "sdkmessageprocessingsteps?$select=name&%24expand=createdby($select=fullname)"],
    ["an encoded expand in another case", "sdkmessageprocessingsteps?$select=name&%24EXPAND=createdby($select=fullname)"],
    ["an encoded batch", "%24batch"],
    ["an encoded metadata document", "%24metadata"],
    ["an encoded quote", "fieldpermissions?$select=canupdate&$filter=entityname eq %27account%27"],
    // Columns: only what queries.ts selects (LITE_SELECTS).
    ["a step's unsecure configuration", "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,configuration"],
    ["a step's configuration beside pinned columns", "sdkmessageprocessingsteps?$select=name,stage,configuration&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'"],
    ["a workflow's xaml", "workflows?$select=workflowid,xaml&$filter=primaryentity eq 'account'"],
    ["a cloud flow's clientdata", "workflows?$select=clientdata"],
    ["a step image's attributes", "sdkmessageprocessingstepimages?$select=sdkmessageprocessingstepimageid,attributes"],
    ["a form's description", "systemforms?$select=formid,description"],
    ["an attribute's option set", "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')?$select=MetadataId,OptionSet"],
    ["a table's attributes as a column", "EntityDefinitions(LogicalName='account')?$select=Attributes"],
    ["a column selected with a space", "workflows?$select=workflowid, xaml"],
    ["a user's teams with a column that is not pinned", "systemusers(5c4a0000-0000-4000-8000-000000000002)/teammembership_association?$select=teamid,emailaddress"],
    ["a user's profiles with a column that is not pinned", "systemusers(5c4a0000-0000-4000-8000-000000000002)/systemuserprofiles_association?$select=name,description"],
    ["an expanded message with a column that is not pinned", "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name,customizationlevel)"],
    ["a team role link with a column that is not pinned", "teamrolescollection?$select=teamid,roleid,teamroleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=['5c4a0000-0000-4000-8000-000000000301'])"],
    // Options: only $select, $filter, $orderby and $expand, each once.
    ["an aggregation", "sdkmessageprocessingsteps?$select=name&$apply=groupby((configuration))"],
    ["fetchXml", "workflows?$select=name&fetchXml=<fetch><entity name='account'><attribute name='name'/></entity></fetch>"],
    ["a saved query", "workflows?$select=name&savedQuery=5c4a0000-0000-4000-8000-000000000021"],
    ["a computed column", "workflows?$select=name&$compute=xaml as x"],
    ["two $select options", "workflows?$select=name&$select=xaml"],
    ["an option in another case", "workflows?$select=name&$FILTER=createdby/fullname eq 'Dana'"],
    ["a trailing empty option", "workflows?$select=name&"],
    // Filters and order: no lookup path or lambda beyond the ones queries.ts writes.
    ["a filter through a lookup to a user's name", "sdkmessageprocessingsteps?$select=name&$filter=createdby/fullname eq 'Dana'"],
    ["a filter over a workflow's notes", "workflows?$select=name&$filter=workflow_annotation/any(n:n/subject ne null)"],
    ["a lambda with no path", "workflows?$select=name&$filter=workflow_annotation/all(n:true)"],
    ["a lambda spelled with a space", "workflows?$select=name&$filter=workflow_annotation/any (n:true)"],
    ["the pinned step filter with an extra condition", "sdkmessageprocessingsteps?$select=name&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account' or createdby/fullname eq 'Dana'"],
    ["the pinned step filter on another set", "workflows?$select=name&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'"],
    ["an order through a lookup", "sdkmessageprocessingsteps?$select=name&$orderby=createdby/fullname"],
    ["an order by a column that is not pinned", "sdkmessageprocessingsteps?$select=name&$orderby=configuration"],
  ])("refuses %s", (_label, path) => {
    expect(refusalFor(path)).not.toBeNull();
  });

  it("pins a filter shape for every set Lite filters, and none for the sets it reads whole", () => {
    expect([...LITE_FILTERS.keys()].sort()).toEqual([
      "fieldpermissions",
      "publishers",
      "savedqueries",
      "savedqueryvisualizations",
      "sdkmessageprocessingstepimages",
      "sdkmessageprocessingsteps",
      "solutions",
      "systemforms",
      "workflows",
    ]);
    expect([...LITE_FILTERS.values()].flat()).toHaveLength(13);
  });

  // Review round 1: a filter with no lookup path used to pass unchecked.
  it.each([
    ["a test of a step's unsecure configuration", "sdkmessageprocessingsteps?$select=name&$filter=contains(configuration,'Password=')"],
    ["a test of a workflow's xaml", "workflows?$select=name&$filter=contains(xaml,'x')"],
    ["a test of a flow's definition", "workflows?$select=name&$filter=startswith(clientdata,'{')"],
    ["the length of a workflow's xaml", "workflows?$select=name&$filter=length(xaml) gt 1000"],
    ["who created a step", "sdkmessageprocessingsteps?$select=name&$filter=_createdby_value eq 5c4a0000-0000-4000-8000-000000000002"],
    ["the signed-in user's steps", "sdkmessageprocessingsteps?$select=name&$filter=Microsoft.Dynamics.CRM.EqualUserId(PropertyName='createdby')"],
    ["a test of a profile's description", "fieldsecurityprofiles?$select=name&$filter=contains(description,'x')"],
    ["a pinned shape with an extra condition", "workflows?$select=name&$filter=primaryentity eq 'account' and (category eq 0 or category eq 2) and (type eq 1 or type eq 2) and contains(xaml,'x')"],
    ["an In(...) on another column", "solutions?$select=solutionid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='_createdby_value',PropertyValues=['5c4a0000-0000-4000-8000-000000000002'])"],
    ["an In(...) with free text", "publishers?$select=publisherid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='publisherid',PropertyValues=['x') or contains(description,'y'])"],
    ["a table name that is not a logical name", "fieldpermissions?$select=canupdate&$filter=entityname eq 'Account' or canread eq 4"],
    ["a filter on a set Lite reads whole", "EntityDefinitions?$select=Privileges&$filter=LogicalName eq 'account'"],
  ])("refuses a filter Lite does not write: %s", (_label, path) => {
    expect(refusalFor(path)).not.toBeNull();
  });

  it.each([
    "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name)&$filter=_sdkmessagefilterid_value eq null and (sdkmessageid/name eq 'Update' or sdkmessageid/name eq 'UpdateMultiple')&$orderby=stage,rank",
  ])("accepts the steps registered for every table: %s", (path) => {
    expect(refusalFor(path)).toBeNull();
  });

  it.each([
    ["another message by name", "sdkmessageprocessingsteps?$select=name&$filter=_sdkmessagefilterid_value eq null and (sdkmessageid/name eq 'Update' or sdkmessageid/name eq 'Delete')"],
    ["a message's other column", "sdkmessageprocessingsteps?$select=name&$filter=_sdkmessagefilterid_value eq null and (sdkmessageid/createdby eq 'Update' or sdkmessageid/name eq 'UpdateMultiple')"],
    ["the pattern with an extra condition", "sdkmessageprocessingsteps?$select=name&$filter=_sdkmessagefilterid_value eq null and (sdkmessageid/name eq 'Update' or sdkmessageid/name eq 'UpdateMultiple') or createdby/fullname eq 'Dana'"],
  ])("refuses a near copy of it: %s", (_label, path) => {
    expect(refusalFor(path)).not.toBeNull();
  });
});

describe("createDataverseClient", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("refuses a path outside the allowlist without sending anything", async () => {
    const fetchFn = vi.fn<FetchLike>();
    const get = createDataverseClient(ORIGIN, fetchFn);
    await expect(get("accounts?$select=name")).rejects.toBeInstanceOf(DataverseRefusedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a path that only leaves the allowlist once the URL parser resolves it", async () => {
    const fetchFn = vi.fn<FetchLike>();
    const get = createDataverseClient(ORIGIN, fetchFn);
    await expect(get("EntityDefinitions(LogicalName='account')\\%2e%2e\\accounts?$select=name")).rejects.toBeInstanceOf(DataverseRefusedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    "sdkmessageprocessingsteps?$select=name&%24expand=createdby($select=fullname)",
    "sdkmessageprocessingsteps?$select=name&%24EXPAND=createdby($select=fullname)",
    "%24batch",
    "%24metadata",
  ])("refuses %s, which Dataverse would decode, without sending anything", async (path) => {
    const fetchFn = vi.fn<FetchLike>();
    const get = createDataverseClient(ORIGIN, fetchFn);
    await expect(get(path)).rejects.toBeInstanceOf(DataverseRefusedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe("systemusers", () => {
    const ME = "5c4a0000-0000-4000-8000-000000000002";
    const SOMEONE_ELSE = "5c4a0000-0000-4000-8000-000000000099";
    const profiles = (id: string) => `systemusers(${id})/systemuserprofiles_association?$select=fieldsecurityprofileid,name`;
    const privileges = (id: string) =>
      `systemusers(${id})/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvWriteAccount']`;

    function signedIn() {
      const fetchFn = vi.fn<FetchLike>(async (url) => (url.endsWith("/WhoAmI") ? ok({ UserId: ME.toUpperCase() }) : ok({ value: [] })));
      return { fetchFn, get: createDataverseClient(ORIGIN, fetchFn) };
    }

    it("addresses the user WhoAmI returned", async () => {
      const { fetchFn, get } = signedIn();
      await get("WhoAmI");
      expect(await get(profiles(ME))).toEqual({ ok: true, data: { value: [] } });
      expect(await get(privileges(ME))).toMatchObject({ ok: true });
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["profiles", profiles],
      ["privileges", privileges],
    ])("refuses another user's %s before anything is sent", async (_label, path) => {
      const { fetchFn, get } = signedIn();
      await get("WhoAmI");
      await expect(get(path(SOMEONE_ELSE))).rejects.toBeInstanceOf(DataverseRefusedError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("refuses any user before WhoAmI has answered", async () => {
      const { fetchFn, get } = signedIn();
      await expect(get(profiles(ME))).rejects.toBeInstanceOf(DataverseRefusedError);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("refuses any user when WhoAmI failed", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => new Response("{}", { status: 500 }));
      const get = createDataverseClient(ORIGIN, fetchFn);
      await get("WhoAmI");
      await expect(get(profiles(ME))).rejects.toBeInstanceOf(DataverseRefusedError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("sends a same-origin GET under /api/data/v9.2/", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok({ MetadataId: "x" }));
    const get = createDataverseClient(ORIGIN, fetchFn);
    await get("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')?$select=MetadataId");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${API}EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')?$select=MetadataId`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined();
  });

  it.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "notFound"],
    [500, "failed"],
  ])("reports HTTP %i as %s, never as an empty answer", async (status, kind) => {
    const get = createDataverseClient(ORIGIN, async () => new Response("{}", { status }));
    expect(await get("workflows?$select=name")).toEqual({ ok: false, kind, status });
  });

  it("reports a network failure as failed", async () => {
    const get = createDataverseClient(ORIGIN, async () => {
      throw new TypeError("network");
    });
    expect(await get("workflows?$select=name")).toEqual({ ok: false, kind: "failed", status: null });
  });

  it("reads a path once while fresh, shares concurrent reads, and does not keep failures", async () => {
    let time = 0;
    let status = 500;
    const fetchFn = vi.fn<FetchLike>(async () => (status === 200 ? ok({ value: [] }) : new Response("{}", { status })));
    const get = createDataverseClient(ORIGIN, fetchFn, () => time);

    await get("workflows?$select=name");
    status = 200;
    await Promise.all([get("workflows?$select=name"), get("workflows?$select=name")]);
    await get("workflows?$select=name");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    time = 6 * 60 * 1000;
    await get("workflows?$select=name");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

// Review R6: a page that never answers used to leave a Lite card on "Reading Dataverse…".
describe("a Dataverse that does not answer in time", () => {
  const PATH = "workflows?$select=name";
  const silent: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  function clock() {
    const controllers: AbortController[] = [];
    return {
      timeout: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
      fire: () => controllers.at(-1)!.abort(new DOMException("The operation timed out.", "TimeoutError")),
      started: () => controllers.length,
    };
  }
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 50 && !ready(); i++) await Promise.resolve();
  };

  it("gives each page 15 seconds by default, and sends the signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ value: [] }), { status: 200 }));
    await createDataverseClient(ORIGIN, fetchFn)(PATH);
    expect(DATAVERSE_TIMEOUT_MS).toBe(15_000);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetchFn.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it("is a failed read marked timedOut, never an empty answer, and is not kept", async () => {
    const time = clock();
    let answers = false;
    const fetchFn = vi.fn<FetchLike>((url, init) => (answers ? Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 })) : silent(url, init)));
    const get = createDataverseClient(ORIGIN, fetchFn, Date.now, time.timeout);

    const both = Promise.all([get(PATH), get(PATH)]);
    await until(() => time.started() === 1);
    time.fire();
    const timedOut = { ok: false, kind: "failed", status: null, timedOut: true };
    expect(await both).toEqual([timedOut, timedOut]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    answers = true;
    expect(await get(PATH)).toEqual({ ok: true, data: { value: [] } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("says so on the card, as an unknown", async () => {
    // Every read runs out of time at once.
    const expired = () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const get = createDataverseClient(ORIGIN, silent, Date.now, expired);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("Lite could not read what is registered to fire when this column changes.");
    expect(model.unknowns).toContain("Could not read classic workflows and business rules. Dataverse did not answer in time.");
  });

  // Review L7: the abort also covers a body that stalls after the answer began.
  it("times out a body that never finishes, and does not keep it", async () => {
    const expired = () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const stalls: FetchLike = async (_url, init) =>
      ({ ok: true, status: 200, json: () => silent("", init) }) as unknown as Response;
    const fetchFn = vi.fn(stalls);
    const get = createDataverseClient(ORIGIN, fetchFn, Date.now, expired);
    expect(await get(PATH)).toEqual({ ok: false, kind: "failed", status: null, timedOut: true });
    await get(PATH);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("says so on the dependencies card, never as no dependencies", async () => {
    const expired = () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const model = await loadDependenciesCard(createDataverseClient(ORIGIN, silent, Date.now, expired), { table: "account", column: "name", showTips: true });
    expect(model.headline).toBe("Could not read Dataverse's dependency tracking for this column. Dataverse did not answer in time.");
  });
});

describe("paging", () => {
  const STEPS = "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'";
  const row = (n: number) => ({ sdkmessageprocessingstepid: `5c4a0000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`, name: `Step ${n}` });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  type Page = { value: unknown[]; "@odata.nextLink"?: string };
  // What Dataverse sends: the same query, percent-encoded, plus a $skiptoken.
  const link = (resource: string, query: string, token: string) =>
    `${API}${resource}?${encodeURI(query).replace(/'/g, "%27")}&$skiptoken=${encodeURIComponent(token)}`;
  const STEPS_RESOURCE = "sdkmessageprocessingsteps";
  const STEPS_QUERY = "$select=sdkmessageprocessingstepid,name&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'";

  // The client sends URLs as the URL parser writes them (spaces and quotes encoded).
  const href = (url: string) => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };

  function serve(pages: Record<string, unknown>) {
    const requests: string[] = [];
    const byHref = new Map(Object.entries(pages).map(([url, page]) => [href(url), page]));
    const fetchFn: FetchLike = async (input) => {
      requests.push(input);
      const page = byHref.get(input);
      return page === undefined ? new Response("{}", { status: 404 }) : ok(page);
    };
    return { fetchFn, requests };
  }

  it("follows @odata.nextLink and returns every page's rows", async () => {
    const second = link(STEPS_RESOURCE, STEPS_QUERY, "<cookie page=2/>");
    const third = link(STEPS_RESOURCE, STEPS_QUERY, "<cookie page=3/>");
    const server = serve({
      [`${API}${STEPS}`]: { value: [row(1), row(2)], "@odata.nextLink": second },
      [second]: { value: [row(3)], "@odata.nextLink": third },
      [third]: { value: [row(4)] },
    });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(result.ok && result.data.value).toEqual([row(1), row(2), row(3), row(4)]);
    expect(result.ok && result.data["@odata.nextLink"]).toBeUndefined();
    expect(server.requests).toEqual([`${API}${STEPS}`, second, third].map(href));
  });

  it("serves two pages of plugin steps to the registered card, which then reads the same as with one page", async () => {
    const fake = fakeDataverse();
    const stepsPath = "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode)&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'&$orderby=stage,rank";
    const whole = ((await (await fake.fetch(`${API}${stepsPath}`, { method: "GET" })).json()) as Page).value;
    expect(whole.length).toBeGreaterThan(1);

    const next = `${API}${stepsPath}&$skiptoken=${encodeURIComponent("<cookie page=2/>")}`;
    const pages: Record<string, unknown> = {
      [`${API}${stepsPath}`]: { value: whole.slice(0, 1), "@odata.nextLink": next },
      [next]: { value: whole.slice(1) },
    };
    const get = createDataverseClient(ORIGIN, async (input, init) => (input in pages ? ok(pages[input]) : fake.fetch(input, init)));
    const context = { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true };
    const paged = await loadRegisteredCard(get, context);
    const single = await loadRegisteredCard(createDataverseClient(ORIGIN, fake.fetch), context);
    expect(paged).toEqual(single);
  });

  it("stops at a link to another origin and leaves the answer incomplete", async () => {
    const evil = "https://evil.example.com/api/data/v9.2/sdkmessageprocessingsteps?$select=name&$skiptoken=x";
    const server = serve({ [`${API}${STEPS}`]: { value: [row(1)], "@odata.nextLink": evil } });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(result.ok && result.data.value).toEqual([row(1)]);
    expect(result.ok && result.data["@odata.nextLink"]).toBe(evil);
    expect(server.requests).toEqual([href(`${API}${STEPS}`)]);
  });

  it.each([
    ["a business table on the same origin", `${API}accounts?$select=name&$skiptoken=x`],
    ["another allowlisted table", `${API}workflows?$select=name&$skiptoken=x`],
    ["a path outside the API root", `${ORIGIN}/api/data/v9.1/${STEPS_RESOURCE}?$select=name&$skiptoken=x`],
    ["a parent path", `${API}${STEPS_RESOURCE}/../accounts?$select=name&$skiptoken=x`],
    ["an encoded parent path", `${API}${STEPS_RESOURCE}/%2e%2e/accounts?$select=name&$skiptoken=x`],
    ["a link with credentials", `https://user:secret@contoso.crm.dynamics.com/api/data/v9.2/${STEPS_RESOURCE}?$select=name&$skiptoken=x`],
    ["a link with a fragment", `${API}${STEPS_RESOURCE}?$select=name&$skiptoken=x#frag`],
    ["a relative link", "next"],
    ["a link with no $skiptoken", `${API}${STEPS_RESOURCE}?${encodeURI(STEPS_QUERY)}`],
    ["a link that adds an expand to a user record", `${API}${STEPS_RESOURCE}?$select=name&$expand=createdby($select=fullname)&$skiptoken=x`],
    ["a link that drops $select", `${API}${STEPS_RESOURCE}?$filter=name eq 'x'&$skiptoken=x`],
    ["a link that smuggles a second option in after the token", `${API}${STEPS_RESOURCE}?$select=name&$skiptoken=x&%24expand=createdby($select=fullname)`],
    ["a link that selects the step's configuration", `${API}${STEPS_RESOURCE}?$select=name,configuration&$skiptoken=x`],
    ["a link that filters through a user lookup", `${API}${STEPS_RESOURCE}?$select=name&$filter=createdby%2Ffullname eq 'Dana'&$skiptoken=x`],
    ["a link that tests the step's configuration", `${API}${STEPS_RESOURCE}?$select=name&$filter=contains(configuration,'Password%3D')&$skiptoken=x`],
  ])("does not follow %s", async (_label, nextLink) => {
    const server = serve({ [`${API}${STEPS}`]: { value: [row(1)], "@odata.nextLink": nextLink } });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(server.requests).toEqual([href(`${API}${STEPS}`)]);
    expect(result.ok && result.data["@odata.nextLink"]).toBe(nextLink);
  });

  it("does not follow a link that names another user", async () => {
    const ME = "5c4a0000-0000-4000-8000-000000000002";
    const OTHER = "5c4a0000-0000-4000-8000-000000000099";
    const path = (id: string) => `systemusers(${id})/systemuserprofiles_association?$select=fieldsecurityprofileid,name`;
    const server = serve({
      [`${API}WhoAmI`]: { UserId: ME },
      [`${API}${path(ME)}`]: { value: [{ name: "p" }], "@odata.nextLink": `${API}${path(OTHER)}&$skiptoken=x` },
    });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    await get("WhoAmI");
    const result = await get<Page>(path(ME));
    expect(server.requests).toEqual([`${API}WhoAmI`, href(`${API}${path(ME)}`)]);
    expect(result.ok && result.data["@odata.nextLink"]).toBeDefined();
  });

  // Review X3: a function's paging link may add its $skiptoken and nothing else.
  describe("a function's paging link", () => {
    const DEPENDENTS = "RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2)";
    const dependent = (n: number) => ({ dependentcomponentobjectid: `5c4a0000-0000-4000-8000-0000000008${String(n).padStart(2, "0")}` });

    it("is followed when it adds only a $skiptoken", async () => {
      const next = `${API}${DEPENDENTS}?$skiptoken=${encodeURIComponent("<cookie page=2/>")}`;
      const server = serve({ [`${API}${DEPENDENTS}`]: { value: [dependent(1)], "@odata.nextLink": next }, [next]: { value: [dependent(2)] } });
      const result = await createDataverseClient(ORIGIN, server.fetchFn)<Page>(DEPENDENTS);
      expect(server.requests).toEqual([`${API}${DEPENDENTS}`, next].map(href));
      expect(result.ok && result.data.value).toEqual([dependent(1), dependent(2)]);
    });

    it.each([
      ["an expand into a user record", `${API}${DEPENDENTS}?$expand=createdby($select=fullname)&$skiptoken=x`],
      ["an expand into systemusers", `${API}${DEPENDENTS}?$expand=systemuser($select=fullname,internalemailaddress)&$skiptoken=x`],
      ["a $select", `${API}${DEPENDENTS}?$select=dependentcomponentobjectid&$skiptoken=x`],
      ["a $filter", `${API}${DEPENDENTS}?$filter=dependentcomponenttype eq 29&$skiptoken=x`],
      ["an extra parameter", `${API}RetrieveDependentComponents(ObjectId=5c4a0000-0000-4000-8000-000000000004,ComponentType=2,Extra=1)?$skiptoken=x`],
    ])("is not followed when it adds %s", async (_label, nextLink) => {
      const server = serve({ [`${API}${DEPENDENTS}`]: { value: [dependent(1)], "@odata.nextLink": nextLink } });
      const result = await createDataverseClient(ORIGIN, server.fetchFn)<Page>(DEPENDENTS);
      expect(server.requests).toEqual([href(`${API}${DEPENDENTS}`)]);
      expect(result.ok && result.data["@odata.nextLink"]).toBe(nextLink);
    });
  });

  it("keeps what it has, marked incomplete, when a later page fails", async () => {
    const second = link(STEPS_RESOURCE, STEPS_QUERY, "<cookie page=2/>");
    const server = serve({ [`${API}${STEPS}`]: { value: [row(1)], "@odata.nextLink": second } });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(server.requests).toEqual([`${API}${STEPS}`, second].map(href));
    expect(result.ok && result.data.value).toEqual([row(1)]);
    expect(result.ok && result.data["@odata.nextLink"]).toBe(second);
  });

  it("does not keep an incomplete answer: the next read asks again and can get the whole list", async () => {
    const second = link(STEPS_RESOURCE, STEPS_QUERY, "<cookie page=2/>");
    let secondPageFails = true;
    const requests: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      requests.push(input);
      if (input === href(`${API}${STEPS}`)) return ok({ value: [row(1)], "@odata.nextLink": second });
      if (input === href(second) && !secondPageFails) return ok({ value: [row(2)] });
      return new Response("{}", { status: 500 });
    };
    const get = createDataverseClient(ORIGIN, fetchFn);

    const partial = await get<Page>(STEPS);
    expect(partial.ok && partial.data["@odata.nextLink"]).toBe(second);

    secondPageFails = false;
    const whole = await get<Page>(STEPS);
    expect(whole.ok && whole.data.value).toEqual([row(1), row(2)]);
    expect(whole.ok && whole.data["@odata.nextLink"]).toBeUndefined();
    expect(requests).toHaveLength(4);

    // The whole answer is kept as usual.
    await get<Page>(STEPS);
    expect(requests).toHaveLength(4);
  });

  it("stops when a link repeats", async () => {
    const again = link(STEPS_RESOURCE, STEPS_QUERY, "<cookie page=2/>");
    const server = serve({
      [`${API}${STEPS}`]: { value: [row(1)], "@odata.nextLink": again },
      [again]: { value: [row(2)], "@odata.nextLink": again },
    });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(server.requests).toEqual([`${API}${STEPS}`, again].map(href));
    expect(result.ok && result.data["@odata.nextLink"]).toBe(again);
  });

  it("stops after a fixed number of pages", async () => {
    const pages: Record<string, unknown> = { [`${API}${STEPS}`]: { value: [row(0)], "@odata.nextLink": link(STEPS_RESOURCE, STEPS_QUERY, "p1") } };
    for (let n = 1; n <= 40; n++) {
      pages[link(STEPS_RESOURCE, STEPS_QUERY, `p${n}`)] = { value: [row(n)], "@odata.nextLink": link(STEPS_RESOURCE, STEPS_QUERY, `p${n + 1}`) };
    }
    const server = serve(pages);
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    const result = await get<Page>(STEPS);
    expect(server.requests).toHaveLength(20);
    expect(result.ok && result.data.value).toHaveLength(20);
    expect(result.ok && result.data["@odata.nextLink"]).toBeDefined();
  });

  it("leaves an answer that is not a collection alone", async () => {
    const server = serve({ [`${API}WhoAmI`]: { UserId: "x", "@odata.nextLink": "next" } });
    const get = createDataverseClient(ORIGIN, server.fetchFn);
    expect(await get("WhoAmI")).toEqual({ ok: true, data: { UserId: "x", "@odata.nextLink": "next" } });
  });
});

describe("inFilter", () => {
  it("refuses anything that is not a GUID", () => {
    expect(() => inFilter("formid", ["x') or 1 eq 1"])).toThrow(/not a GUID/);
    expect(() => inFilter("formid) or (1", ["5c4a0000-0000-4000-8000-000000000021"])).toThrow(/not a logical name/);
  });
});

// Runs every Lite read the extension makes against the fixtures, records each
// request, and checks the whole set against the allowlist and the captured
// queries. A new query that is not in contract/dataverse/queries.json fails here.
describe("every Lite request", () => {
  const queries = JSON.parse(readFileSync("contract/dataverse/queries.json", "utf8")) as Array<{ path: string }>;

  async function recordedRequests(): Promise<string[]> {
    const server = fakeDataverse();
    const get = createDataverseClient(ORIGIN, server.fetch);
    for (const column of ["name", "creditlimit", "telephone1", "primarycontactid", "doesnotexist"]) {
      await loadDependenciesCard(get, { table: "account", column, showTips: true });
      await loadRegisteredCard(get, { table: "account", column, dirtyColumns: ["name", "telephone1"], showTips: true });
    }
    // The connected card's checklist reads the signed-in user's own state, as the Lite one does.
    await loadUserSecurity(get, "account");
    // With an active business rule, the registered card also reads dependency tracking.
    const withRule = fakeDataverse();
    withRule.answerWhen("workflows?$select=workflowid,name,category,mode", {
      value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000999", name: "Rule", category: 2, type: 1, statecode: 1 }],
    });
    await loadRegisteredCard(createDataverseClient(ORIGIN, withRule.fetch), {
      table: "account",
      column: "creditlimit",
      dirtyColumns: ["name"],
      showTips: true,
    });
    // The checklist, on a secured column so column security is read too.
    const secured = fakeDataverse();
    secured.answerWhen("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='creditlimit')?$select=IsSecured", {
      IsSecured: true,
      IsValidForUpdate: true,
    });
    secured.answerWhen("workflows?$select=workflowid,name,category,mode", {
      value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000999", name: "Rule", category: 2, type: 1, statecode: 1 }],
    });
    for (const column of ["creditlimit", "pathix_legalofficer"]) {
      await loadLockedCard(createDataverseClient(ORIGIN, secured.fetch), {
        table: "account",
        column,
        control: column,
        formId: "5c4a0000-0000-4000-8000-000000000021",
        showTips: true,
      });
    }
    // M11: the "what changed" panel, and the live freshness read for every kind of component it can ask about.
    const changes = fakeDataverse();
    const changesGet = createDataverseClient(ORIGIN, changes.fetch);
    await loadLiteChanges(changesGet, { table: "account", showTips: true, now: Date.now() });
    await loadLiveModified(
      changesGet,
      ["PluginStep", "ClassicWorkflow", "BusinessRule", "Dialog", "Action", "ModernFlow", "Form", "SavedQuery", "Chart"].map(
        (type) => liveRefFor(type, "5c4a0000-0000-4000-8000-000000000021")!,
      ),
    );
    return [...server.requests, ...withRule.requests, ...secured.requests, ...changes.requests];
  }

  it("stays on the allowlist and under /api/data/v9.2/ on the page's origin", async () => {
    const requests = await recordedRequests();
    expect(requests.length).toBeGreaterThan(10);
    for (const read of [
      "sdkmessageprocessingsteps?",
      "_sdkmessagefilterid_value%20eq%20null",
      "solutions?",
      "publishers?",
      "workflows?",
      "RetrieveDependentComponents",
      "WhoAmI",
      "fieldpermissions?",
      "fieldsecurityprofiles?",
      "systemuserprofiles_association",
      "RetrieveUserSetOfPrivilegesByNames",
      // Review R4: the user's read depth on processes, teams and roles.
      "@p1=['prvReadWorkflow','prvReadTeam','prvReadRole']",
      "teammembership_association",
      "teamrolescollection?",
      "teamprofilescollection?",
      "roleprivilegescollection?",
      "formxml",
      "systemforms?$select=formid,name,type,publishedon",
      "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,modifiedon",
      "workflows?$select=workflowid,modifiedon",
      "systemforms?$select=formid,publishedon",
      "savedqueries?$select=savedqueryid,modifiedon",
      "savedqueryvisualizations?$select=savedqueryvisualizationid,modifiedon",
    ]) {
      expect(requests.some((url) => url.includes(read) || decodeURIComponent(url).includes(read)), read).toBe(true);
    }
    for (const url of requests) {
      expect(url.startsWith(API)).toBe(true);
      expect(refusalFor(decodeURIComponent(url.slice(API.length)))).toBeNull();
    }
  });

  it("selects exactly the pinned columns of each resource: a query that selects a new column fails here until the pin says so", async () => {
    const selected = new Map<string, Set<string>>();
    const add = (resource: string, list: string) => {
      const columns = selected.get(resource) ?? new Set<string>();
      for (const column of list.split(",")) columns.add(column);
      selected.set(resource, columns);
    };
    for (const url of await recordedRequests()) {
      const [resource = "", query = ""] = decodeURIComponent(url.slice(API.length)).split("?");
      const segments = resource.split("/").map((segment) => segment.replace(/\(.*$/, ""));
      // systemusers(<id>)/<association> is keyed by the association.
      const key = segments[0] === "systemusers" ? segments.slice(1).join("/") : segments.join("/");
      const select = /(?:^|&)\$select=([^&]+)/.exec(query)?.[1];
      if (select) add(key, select);
      for (const [, lookup = "", list = ""] of query.matchAll(/([a-z_]+)\(\$select=([A-Za-z_,]+)\)/g)) add(lookup, list);
    }
    const sortedTable = (table: ReadonlyMap<string, ReadonlySet<string>>) =>
      Object.fromEntries([...table].map(([resource, columns]) => [resource, [...columns].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    expect(sortedTable(LITE_SELECTS)).toEqual(sortedTable(selected));
  });

  it("filters with a pinned shape on every request, and uses every pin", async () => {
    const used = new Set<RegExp>();
    for (const url of await recordedRequests()) {
      const [resource = "", query = ""] = decodeURIComponent(url.slice(API.length)).split("?");
      const filter = query.split("&").find((option) => option.startsWith("$filter="))?.slice("$filter=".length);
      if (filter === undefined) continue;
      const set = resource.replace(/\(.*$/, "");
      const pins = LITE_FILTERED.has(set) ? [LITE_FILTERED.get(set)!] : (LITE_FILTERS.get(set) ?? []);
      const match = pins.find((pattern) => pattern.test(filter));
      expect(match, `${set} $filter=${filter}`).toBeDefined();
      used.add(match!);
    }
    expect([...LITE_FILTERS.values()].flat().filter((pattern) => !used.has(pattern)).map(String)).toEqual([]);
  });

  it("selects only fields a captured query selects from the same table", async () => {
    const shape = (path: string) => {
      const [resource = "", query = ""] = path.split("?");
      const table = resource.replace(/\([^)]*\)/g, "");
      const select = /(?:^|&)\$select=([^&]+)/.exec(query)?.[1]?.split(",") ?? [];
      return { table, select };
    };
    const captured = queries.map((query) => shape(query.path));

    for (const url of await recordedRequests()) {
      const request = shape(decodeURIComponent(url.slice(API.length)));
      const match = captured.find((query) => query.table === request.table && request.select.every((field) => query.select.includes(field)));
      expect(match, `no captured query in contract/dataverse/queries.json covers ${request.table} $select=${request.select.join(",")}`).toBeDefined();
    }
  });
});

describe("the Lite client's cache", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const path = (n: number) => `EntityDefinitions(LogicalName='t${n}')/Attributes(LogicalName='name')?$select=MetadataId`;

  function client(maxEntries: number) {
    let clock = 0;
    const fetchFn = vi.fn<FetchLike>(async () => ok({ LogicalName: "t" }));
    const get = createDataverseClient(ORIGIN, fetchFn, () => clock, undefined, maxEntries);
    return { get, fetchFn, tick: (ms: number) => void (clock += ms) };
  }

  it("serves a fresh answer from memory", async () => {
    const { get, fetchFn } = client(10);
    await get(path(1));
    await get(path(1));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("asks again once an answer has expired, and drops the expired one", async () => {
    const { get, fetchFn, tick } = client(10);
    await get(path(1));
    tick(5 * 60 * 1000);
    await get(path(1));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps at most its cap, dropping the least recently read first", async () => {
    const { get, fetchFn } = client(2);
    await get(path(1));
    await get(path(2));
    // Reading 1 again makes 2 the least recently read.
    await get(path(1));
    await get(path(3));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await get(path(1));
    await get(path(3));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await get(path(2));
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("caps the cache by default", () => {
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(0);
    expect(MAX_CACHE_ENTRIES).toBeLessThanOrEqual(500);
  });
});
