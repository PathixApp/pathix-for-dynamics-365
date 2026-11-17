// Lite's Dataverse queries, one function per query. Each one matches a query
// in contract/dataverse/queries.json, and its answer type is the slice of that
// fixture the extension reads.
//
// Names and ids are checked before they go into a path, so nothing from the
// page can change the shape of a query.

import { isGuid, isLogicalName } from "../bridge/messages";
import type { LiveSource } from "../card/freshness";
import type { DataverseGet, DataverseResult } from "./client";

/** Dataverse's component type for a column (attribute). */
export const ATTRIBUTE_COMPONENT_TYPE = 2;

/** Ids per In(...) filter, which keeps every request URL short. */
const IN_CHUNK = 50;

export interface ODataCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** Fixture: attribute-account-*.json. */
export interface AttributeMetadataId {
  MetadataId: string;
}

/** Fixture: dependents-account-*.json. One row per tracked dependency. */
export interface DependentComponent {
  dependentcomponenttype: number;
  dependentcomponentobjectid: string;
  dependentcomponentparentid: string;
  dependencytype: number;
}

export function retrieveAttributeMetadataId(
  get: DataverseGet,
  table: string,
  column: string,
): Promise<DataverseResult<AttributeMetadataId>> {
  assertLogicalName(table);
  assertLogicalName(column);
  return get(`EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')?$select=MetadataId`);
}

export function retrieveDependentComponents(
  get: DataverseGet,
  attributeMetadataId: string,
): Promise<DataverseResult<ODataCollection<DependentComponent>>> {
  assertGuid(attributeMetadataId);
  return get(`RetrieveDependentComponents(ObjectId=${attributeMetadataId},ComponentType=${ATTRIBUTE_COMPONENT_TYPE})`);
}

// --- names of dependent components ----------------------------------------------

/** Fixture: names-forms-account-name.json. */
export interface FormName {
  formid: string;
  name: string | null;
}

/** Fixture: names-views-account-name.json. */
export interface ViewName {
  savedqueryid: string;
  name: string | null;
}

/** Fixture: names-charts-account-name.json. */
export interface ChartName {
  savedqueryvisualizationid: string;
  name: string | null;
}

/** Fixture: names-processes-account-name.json. `category` tells a business rule from a flow. */
export interface ProcessName {
  workflowid: string;
  name: string | null;
  category: number | null;
}

/** Fixture: names-plugin-steps-account-name.json. */
export interface PluginStepName {
  sdkmessageprocessingstepid: string;
  name: string | null;
}

/**
 * Fixture: names-step-images-account-name.json. `name` is often empty in real
 * orgs, so the card falls back to the alias, then to the parent step's name.
 */
export interface StepImageName {
  sdkmessageprocessingstepimageid: string;
  name: string | null;
  entityalias: string | null;
  _sdkmessageprocessingstepid_value: string | null;
}

/** Fixture: name-relationship-account-name.json. */
export interface RelationshipName {
  SchemaName: string | null;
}

/** Fixture: name-attribute-account-name.json. */
export interface AttributeName {
  LogicalName: string | null;
  EntityLogicalName: string | null;
}

export function retrieveFormNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<FormName[]>> {
  return inChunks(get, ids, (chunk) => `systemforms?$select=formid,name&$filter=${inFilter("formid", chunk)}`);
}

export function retrieveViewNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<ViewName[]>> {
  return inChunks(get, ids, (chunk) => `savedqueries?$select=savedqueryid,name&$filter=${inFilter("savedqueryid", chunk)}`);
}

export function retrieveChartNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<ChartName[]>> {
  return inChunks(
    get,
    ids,
    (chunk) => `savedqueryvisualizations?$select=savedqueryvisualizationid,name&$filter=${inFilter("savedqueryvisualizationid", chunk)}`,
  );
}

export function retrieveProcessNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<ProcessName[]>> {
  return inChunks(get, ids, (chunk) => `workflows?$select=workflowid,name,category&$filter=${inFilter("workflowid", chunk)}`);
}

export function retrievePluginStepNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<PluginStepName[]>> {
  return inChunks(
    get,
    ids,
    (chunk) => `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name&$filter=${inFilter("sdkmessageprocessingstepid", chunk)}`,
  );
}

export function retrieveStepImageNames(get: DataverseGet, ids: string[]): Promise<DataverseResult<StepImageName[]>> {
  return inChunks(
    get,
    ids,
    (chunk) =>
      `sdkmessageprocessingstepimages?$select=sdkmessageprocessingstepimageid,name,entityalias,_sdkmessageprocessingstepid_value&$filter=${inFilter("sdkmessageprocessingstepimageid", chunk)}`,
  );
}

export function retrieveRelationshipName(get: DataverseGet, relationshipId: string): Promise<DataverseResult<RelationshipName>> {
  assertGuid(relationshipId);
  return get(`RelationshipDefinitions(${relationshipId})?$select=SchemaName`);
}

export function retrieveAttributeName(
  get: DataverseGet,
  entityId: string,
  attributeId: string,
): Promise<DataverseResult<AttributeName>> {
  assertGuid(entityId);
  assertGuid(attributeId);
  return get(`EntityDefinitions(${entityId})/Attributes(${attributeId})?$select=LogicalName,EntityLogicalName`);
}

// --- registered to fire (M2) -------------------------------------------------------

/** Fixture: plugin-steps-account.json. One row per step registered on the table, any message. */
export interface PluginStepRegistration {
  sdkmessageprocessingstepid: string;
  name: string | null;
  /** 10 pre-validation, 20 pre-operation, 40 post-operation; others are platform stages. */
  stage: number;
  /** 0 synchronous, 1 asynchronous. */
  mode: number;
  rank: number | null;
  /** Comma-separated column names; null or empty means every update. */
  filteringattributes: string | null;
  /** 0 enabled, 1 disabled. */
  statecode: number;
  solutionid: string | null;
  sdkmessageid: { name: string | null } | null;
  /** When the step was last saved, imported or turned on or off (M11). Null or absent when not read. */
  modifiedon?: string | null;
}

/**
 * Fixture: solutions.json. The publisher link, and the unique name, which
 * tells the Active solution (a step's unmanaged top layer) apart. Managed
 * state is packaging, never authorship, and is not read.
 */
export interface SolutionPublisher {
  solutionid: string;
  uniquename: string | null;
  _publisherid_value: string | null;
}

/** Fixture: publishers.json. */
export interface Publisher {
  publisherid: string;
  uniquename: string | null;
  friendlyname: string | null;
}

/** Fixture: workflows-account.json. Classic workflows (category 0) and business rules (category 2). */
export interface ProcessRegistration {
  workflowid: string;
  name: string | null;
  /** 0 classic workflow, 2 business rule. */
  category: number;
  /** For a classic workflow: 0 background, 1 real-time. */
  mode: number | null;
  /** 1 definition, 2 activation. */
  type: number;
  /** 0 draft, 1 activated. */
  statecode: number;
  triggeronupdateattributelist: string | null;
  /** For a real-time workflow: 20 before the change is saved, 40 after. */
  updatestage: number | null;
  _parentworkflowid_value: string | null;
  /** When the process was last saved, activated or deactivated (M11). Null or absent when not read. */
  modifiedon?: string | null;
}

export function retrievePluginStepsForTable(get: DataverseGet, table: string): Promise<DataverseResult<ODataCollection<PluginStepRegistration>>> {
  assertLogicalName(table);
  return get(
    "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon" +
      "&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode)" +
      `&$filter=sdkmessagefilterid/primaryobjecttypecode eq '${table}'&$orderby=stage,rank`,
  );
}

/**
 * Fixture: plugin-steps-update-all-tables.json. Steps registered on Update or
 * UpdateMultiple with no message filter: they fire on an update of every
 * table, so the table's own query (filtered on the message filter's table)
 * never sees them. The Lite "what changed" panel reads their modifiedon
 * from the same answer, so the two share one cached request.
 */
export function retrievePluginStepsForAllTables(get: DataverseGet): Promise<DataverseResult<ODataCollection<PluginStepRegistration>>> {
  return get(
    "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon" +
      "&$expand=sdkmessageid($select=name)" +
      "&$filter=_sdkmessagefilterid_value eq null and (sdkmessageid/name eq 'Update' or sdkmessageid/name eq 'UpdateMultiple')&$orderby=stage,rank",
  );
}

export function retrieveSolutionPublishers(get: DataverseGet, ids: string[]): Promise<DataverseResult<SolutionPublisher[]>> {
  return inChunks(get, ids, (chunk) => `solutions?$select=solutionid,uniquename,_publisherid_value&$filter=${inFilter("solutionid", chunk)}`);
}

export function retrievePublishers(get: DataverseGet, ids: string[]): Promise<DataverseResult<Publisher[]>> {
  return inChunks(get, ids, (chunk) => `publishers?$select=publisherid,uniquename,friendlyname&$filter=${inFilter("publisherid", chunk)}`);
}

export function retrieveProcessesForTable(get: DataverseGet, table: string): Promise<DataverseResult<ODataCollection<ProcessRegistration>>> {
  assertLogicalName(table);
  return get(
    "workflows?$select=workflowid,name,category,mode,type,statecode,primaryentity,scope,triggeroncreate,triggerondelete," +
      "triggeronupdateattributelist,createstage,updatestage,deletestage,processtriggerscope,_parentworkflowid_value,modifiedon" +
      `&$filter=primaryentity eq '${table}' and (category eq 0 or category eq 2) and (type eq 1 or type eq 2)`,
  );
}

// --- what changed (M11) ------------------------------------------------------------

/**
 * Fixture: forms-modified-account.json. The table's active forms and when each
 * was last published. A form has no `modifiedon` in Dataverse (a read that
 * selects it answers 400), so `publishedon` is its change date: an edit that
 * is not published does not move it, and publishing again with no change does.
 */
export interface FormModified {
  formid: string;
  name: string | null;
  /** 2 main, 6 quick view, 7 quick create, 11 card, 12 main (interactive experience). */
  type: number | null;
  publishedon: string | null;
}

export function retrieveFormsForTable(get: DataverseGet, table: string): Promise<DataverseResult<ODataCollection<FormModified>>> {
  assertLogicalName(table);
  return get(`systemforms?$select=formid,name,type,publishedon&$filter=objecttypecode eq '${table}' and formactivationstate eq 1`);
}

/**
 * One row of a live freshness read: the component's id, under its own id
 * column, and its change date, under modifiedon (publishedon for a form). The
 * queries are modified-*-account-name in contract/dataverse/queries.json.
 */
export type ModifiedRow = Record<string, string | null>;

/**
 * The live change date of components Pathix already knows, by id, from the
 * table that holds them (src/card/freshness.ts names the table and the date
 * column per component type).
 */
export function retrieveModifiedOn(get: DataverseGet, source: LiveSource, ids: string[]): Promise<DataverseResult<ModifiedRow[]>> {
  const { entitySet, idColumn, changeColumn } = source;
  assertLogicalName(entitySet);
  assertLogicalName(idColumn);
  assertLogicalName(changeColumn);
  return inChunks(get, ids, (chunk) => `${entitySet}?$select=${idColumn},${changeColumn}&$filter=${inFilter(idColumn, chunk)}`);
}

// --- why can't I edit this field? (M3) -------------------------------------------

/** Fixture: whoami.json. The user id, and the user's business unit, which says which teams' roles the user can read. */
export interface WhoAmI {
  UserId: string;
  BusinessUnitId?: string;
}

/**
 * Fixture: entity-privileges-account.json (stand-in). The table's privileges
 * as its definition names them. Write is not always prvWrite<SchemaName>:
 * activity tables such as email share prvWriteActivity.
 */
export interface EntityPrivileges {
  /**
   * CanBeRecordFilter: a role may narrow this privilege with a record filter.
   * A team role's depth (roleprivilegescollection) carries no filter, so where
   * this is true or absent a team-held Organization depth is not every record.
   */
  Privileges: Array<{ Name: string; PrivilegeType: string; PrivilegeId?: string; CanBeRecordFilter?: unknown }> | null;
}

/** Fixture: attribute-account-*.json. */
export interface AttributeEditability {
  IsSecured: boolean | null;
  IsValidForUpdate: boolean | null;
}

/** Fixture: field-permissions-account.json. canupdate is 4 when allowed, 0 when not. */
export interface FieldPermission {
  attributelogicalname: string;
  canupdate: number | null;
  _fieldsecurityprofileid_value: string | null;
}

/** Fixtures: field-security-profiles.json, my-field-security-profiles.json. */
export interface FieldSecurityProfile {
  fieldsecurityprofileid: string;
  name: string | null;
}

/**
 * Fixtures: my-privileges-account.json, my-read-privileges.json (stand-in).
 * Depth is a string: "Basic", "Local", "Deep" or "Global". RecordFilterId is
 * the empty GUID unless a record filter narrows the privilege.
 */
export interface UserPrivileges {
  RolePrivileges: Array<{ PrivilegeName: string; Depth: string; RecordFilterId?: unknown }>;
}

/** The id Dataverse writes for "no record filter". */
const NO_RECORD_FILTER = "00000000-0000-0000-0000-000000000000";

/**
 * Whether a privilege row is narrowed by a record filter. Only an empty
 * string or the empty GUID is "none". Any other value, a string or not, is
 * "filtered". A row with no RecordFilterId at all is "unknown": the answer
 * did not say.
 */
export function recordFilterOf(row: { RecordFilterId?: unknown }): "none" | "filtered" | "unknown" {
  if (!("RecordFilterId" in row)) return "unknown";
  const id = row.RecordFilterId;
  return typeof id === "string" && (id === "" || id.toLowerCase() === NO_RECORD_FILTER) ? "none" : "filtered";
}

/**
 * Fixture: my-teams.json (stand-in). The teams the user is a member of, from
 * their own membership. Access teams (type 1) are listed too and hold no roles.
 */
export interface MyTeam {
  teamid: string;
  name: string | null;
  teamtype: number | null;
  /** The team's business unit: which of the user's Read depths on roles reaches the team's roles. Absent from fixtures captured before it was read. */
  _businessunitid_value?: string | null;
}

/** Fixture: team-roles.json (stand-in). One row per role a team holds. */
export interface TeamRole {
  teamid: string;
  roleid: string;
}

/** Fixture: team-profiles.json (stand-in). One row per column security profile a team holds. */
export interface TeamProfile {
  teamid: string;
  fieldsecurityprofileid: string;
}

/**
 * Fixture: role-write-privilege-account.json (stand-in). One row per role that
 * holds the table's Write privilege. privilegedepthmask is a bit mask: 1 Basic,
 * 2 Local, 4 Deep, 8 Global.
 */
export interface RolePrivilegeDepth {
  roleid: string;
  privilegeid: string;
  privilegedepthmask: number;
}

/** Fixture: forms-account-main.json. */
export interface FormDefinition {
  formid: string;
  name: string | null;
  formxml: string | null;
}

export function retrieveWhoAmI(get: DataverseGet): Promise<DataverseResult<WhoAmI>> {
  return get("WhoAmI");
}

export function retrieveEntityPrivileges(get: DataverseGet, table: string): Promise<DataverseResult<EntityPrivileges>> {
  assertLogicalName(table);
  return get(`EntityDefinitions(LogicalName='${table}')?$select=Privileges`);
}

export function retrieveAttributeEditability(get: DataverseGet, table: string, column: string): Promise<DataverseResult<AttributeEditability>> {
  assertLogicalName(table);
  assertLogicalName(column);
  return get(`EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')?$select=IsSecured,IsValidForUpdate`);
}

export function retrieveFieldPermissions(get: DataverseGet, table: string): Promise<DataverseResult<ODataCollection<FieldPermission>>> {
  assertLogicalName(table);
  return get(
    `fieldpermissions?$select=fieldpermissionid,entityname,attributelogicalname,canread,cancreate,canupdate,_fieldsecurityprofileid_value&$filter=entityname eq '${table}'`,
  );
}

export function retrieveFieldSecurityProfiles(get: DataverseGet): Promise<DataverseResult<ODataCollection<FieldSecurityProfile>>> {
  return get("fieldsecurityprofiles?$select=fieldsecurityprofileid,name");
}

export function retrieveMyFieldSecurityProfiles(get: DataverseGet, userId: string): Promise<DataverseResult<ODataCollection<FieldSecurityProfile>>> {
  assertGuid(userId);
  return get(`systemusers(${userId})/systemuserprofiles_association?$select=fieldsecurityprofileid,name`);
}

/** The user's own depth on each named privilege, e.g. the Write privilege a table's definition names. */
export function retrieveMyPrivileges(get: DataverseGet, userId: string, privilegeNames: string[]): Promise<DataverseResult<UserPrivileges>> {
  assertGuid(userId);
  if (privilegeNames.length === 0) throw new Error("No privilege names.");
  for (const name of privilegeNames) {
    if (!isPrivilegeName(name)) throw new Error(`${JSON.stringify(name)} is not a privilege name.`);
  }
  const names = privilegeNames.map((name) => `'${name}'`).join(",");
  return get(`systemusers(${userId})/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=[${names}]`);
}

/**
 * The user's own depth on reading the tables Lite lists that users or business
 * units own: classic workflows and business rules, teams, and roles. Below
 * Global, Dataverse lists only the rows the user can see (src/lite/visibility.ts).
 */
export function retrieveMyReadPrivileges(get: DataverseGet, userId: string): Promise<DataverseResult<UserPrivileges>> {
  return retrieveMyPrivileges(get, userId, ["prvReadWorkflow", "prvReadTeam", "prvReadRole"]);
}

/** The teams the signed-in user is a member of. */
export function retrieveMyTeams(get: DataverseGet, userId: string): Promise<DataverseResult<ODataCollection<MyTeam>>> {
  assertGuid(userId);
  return get(`systemusers(${userId})/teammembership_association?$select=teamid,name,teamtype,_businessunitid_value`);
}

/** The roles those teams hold. Dataverse's own answer for the user's privileges may or may not count these; this reads them directly. */
export function retrieveTeamRoles(get: DataverseGet, teamIds: string[]): Promise<DataverseResult<TeamRole[]>> {
  return inChunks(get, teamIds, (chunk) => `teamrolescollection?$select=teamid,roleid&$filter=${inFilter("teamid", chunk)}`);
}

/** The column security profiles those teams hold. */
export function retrieveTeamProfiles(get: DataverseGet, teamIds: string[]): Promise<DataverseResult<TeamProfile[]>> {
  return inChunks(get, teamIds, (chunk) => `teamprofilescollection?$select=teamid,fieldsecurityprofileid&$filter=${inFilter("teamid", chunk)}`);
}

/** The depth at which each of the named roles holds one privilege. Only the roles the user's teams hold are asked about. */
export function retrieveRolesHoldingPrivilege(get: DataverseGet, privilegeId: string, roleIds: string[]): Promise<DataverseResult<RolePrivilegeDepth[]>> {
  assertGuid(privilegeId);
  return inChunks(
    get,
    roleIds,
    (chunk) => `roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq ${privilegeId} and ${inFilter("roleid", chunk)}`,
  );
}

export function isPrivilegeName(name: string): boolean {
  return /^prv[A-Za-z0-9_]+$/.test(name);
}

export function retrieveFormDefinition(get: DataverseGet, formId: string): Promise<DataverseResult<FormDefinition[]>> {
  return inChunks(get, [formId], (chunk) => `systemforms?$select=formid,name,formxml&$filter=${inFilter("formid", chunk)}`);
}

// --- helpers ------------------------------------------------------------------------

export function inFilter(property: string, ids: string[]): string {
  assertLogicalName(property);
  ids.forEach(assertGuid);
  return `Microsoft.Dynamics.CRM.In(PropertyName='${property}',PropertyValues=[${ids.map((id) => `'${id}'`).join(",")}])`;
}

/**
 * One request per chunk of ids; any chunk failing fails the whole answer. The
 * client follows each chunk's pages itself, so a chunk that still has a
 * nextLink could not be read in full: rows would be missing, so it fails too.
 */
async function inChunks<T>(
  get: DataverseGet,
  ids: string[],
  path: (chunk: string[]) => string,
): Promise<DataverseResult<T[]>> {
  const distinct = [...new Set(ids)];
  const rows: T[] = [];
  for (let start = 0; start < distinct.length; start += IN_CHUNK) {
    const result = await get<ODataCollection<T>>(path(distinct.slice(start, start + IN_CHUNK)));
    if (!result.ok) return result;
    if (result.data["@odata.nextLink"]) return { ok: false, kind: "failed", status: null };
    rows.push(...result.data.value);
  }
  return { ok: true, data: rows };
}

function assertLogicalName(name: string): void {
  if (!isLogicalName(name)) throw new Error(`${JSON.stringify(name)} is not a logical name.`);
}

function assertGuid(id: string): void {
  if (!isGuid(id)) throw new Error(`${JSON.stringify(id)} is not a GUID.`);
}
