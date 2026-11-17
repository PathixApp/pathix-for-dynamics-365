// What Lite may ask Dataverse for (DESIGN.md, "Names, never values").
//
// Lite reads metadata tables and functions only: never business records,
// audit data or plugin-trace logs. Every request goes through the client in
// client.ts, which refuses a path outside this list before anything is sent.
// test/dataverse-client.test.ts pins the list: adding to it is a reviewed
// change, never a quiet one.

/** Metadata entity sets a Lite request may start from. No business tables. */
export const LITE_ENTITY_SETS: ReadonlySet<string> = new Set([
  "EntityDefinitions",
  "RelationshipDefinitions",
  "systemforms",
  "savedqueries",
  "savedqueryvisualizations",
  "workflows",
  "sdkmessageprocessingsteps",
  "sdkmessageprocessingstepimages",
  // M2: a plugin step's owning solution and its publisher, the only valid
  // signal for telling Microsoft-shipped steps from the customer's (DESIGN.md,
  // "Authorship comes from the publisher").
  "solutions",
  "publishers",
  // M3: column security, for "why can't I edit this field?".
  "fieldsecurityprofiles",
  "fieldpermissions",
  // M6: security the signed-in user holds through their teams (the user's
  // own security state). The roles and
  // column security profiles of the teams the user is in, and who holds one
  // table privilege through which role. Each takes one fixed filter, in
  // LITE_FILTERED, so none can be read as a whole list.
  "teamrolescollection",
  "teamprofilescollection",
  "roleprivilegescollection",
]);

/** Unbound metadata functions a Lite request may call. */
export const LITE_FUNCTIONS: ReadonlySet<string> = new Set(["RetrieveDependentComponents", "WhoAmI"]);

/**
 * The whole call each function takes: its parameters by name and type, and
 * nothing after them. A function takes no query option at all, so no
 * $expand, $select or $filter can ride on one, and a server's paging link
 * may add only its $skiptoken, which the client strips before this check.
 * RetrieveDependentComponents takes a column's MetadataId and the column
 * component type, 2, the only one Lite asks about.
 */
export const LITE_FUNCTION_CALLS: ReadonlyMap<string, RegExp> = new Map([
  ["RetrieveDependentComponents", /^RetrieveDependentComponents\(ObjectId=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12},ComponentType=2\)$/],
  ["WhoAmI", /^WhoAmI$/],
]);

/**
 * What Lite may ask about the signed-in user, by the id WhoAmI returns: their
 * own column security profiles and their own privileges on a table (M3), and
 * the teams they are a member of (M6).
 * systemusers is reachable only through these; a plain read of a user record
 * is refused.
 */
export const LITE_USER_BOUND: ReadonlySet<string> = new Set([
  "systemuserprofiles_association",
  "teammembership_association",
  "Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames",
]);

/** Navigation inside a metadata path, e.g. EntityDefinitions(...)/Attributes(...). */
export const LITE_NAVIGATIONS: ReadonlySet<string> = new Set(["Attributes"]);

/**
 * The only lookups Lite may $expand, by the entity set they hang off. Both
 * point at metadata tables (the SDK message and its filter), each expand
 * needs its own $select, and nothing nests. Any other expand is refused, so
 * one cannot walk from a metadata row to a business record.
 */
export const LITE_EXPANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sdkmessageprocessingsteps", new Set(["sdkmessageid", "sdkmessagefilterid"])],
]);

/**
 * The columns each resource may $select: exactly the ones queries.ts selects,
 * so a metadata table cannot hand over a column Lite never reads, such as a
 * step's unsecure configuration (often a connection string) or a workflow's
 * xaml. Keyed by the path with its parentheses removed, e.g.
 * "EntityDefinitions/Attributes", or by the expanded lookup's name.
 * test/dataverse-client.test.ts derives this table from every Lite request
 * and fails when the two differ.
 */
export const LITE_SELECTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    EntityDefinitions: ["Privileges"],
    "EntityDefinitions/Attributes": ["EntityLogicalName", "IsSecured", "IsValidForUpdate", "LogicalName", "MetadataId"],
    RelationshipDefinitions: ["SchemaName"],
    systemforms: ["formid", "formxml", "name", "publishedon", "type"],
    savedqueries: ["modifiedon", "name", "savedqueryid"],
    savedqueryvisualizations: ["modifiedon", "name", "savedqueryvisualizationid"],
    workflows: [
      "_parentworkflowid_value",
      "category",
      "createstage",
      "deletestage",
      "mode",
      "modifiedon",
      "name",
      "primaryentity",
      "processtriggerscope",
      "scope",
      "statecode",
      "triggeroncreate",
      "triggerondelete",
      "triggeronupdateattributelist",
      "type",
      "updatestage",
      "workflowid",
    ],
    sdkmessageprocessingsteps: ["filteringattributes", "mode", "modifiedon", "name", "rank", "sdkmessageprocessingstepid", "solutionid", "stage", "statecode"],
    sdkmessageprocessingstepimages: ["_sdkmessageprocessingstepid_value", "entityalias", "name", "sdkmessageprocessingstepimageid"],
    solutions: ["_publisherid_value", "solutionid", "uniquename"],
    publishers: ["friendlyname", "publisherid", "uniquename"],
    fieldsecurityprofiles: ["fieldsecurityprofileid", "name"],
    fieldpermissions: ["_fieldsecurityprofileid_value", "attributelogicalname", "cancreate", "canread", "canupdate", "entityname", "fieldpermissionid"],
    teamrolescollection: ["roleid", "teamid"],
    teamprofilescollection: ["fieldsecurityprofileid", "teamid"],
    roleprivilegescollection: ["privilegedepthmask", "privilegeid", "roleid"],
    systemuserprofiles_association: ["fieldsecurityprofileid", "name"],
    teammembership_association: ["_businessunitid_value", "name", "teamid", "teamtype"],
    // Expanded lookups.
    sdkmessageid: ["name"],
    sdkmessagefilterid: ["primaryobjecttypecode"],
  }).map(([resource, columns]) => [resource, new Set(columns)]),
);

/** The query options an entity set query may carry. Anything else ($apply, fetchXml, savedQuery, $compute...) is refused. */
const QUERY_OPTIONS: ReadonlySet<string> = new Set(["$select", "$filter", "$orderby", "$expand"]);

/** Why a path was refused, or null when it stays on the allowlist. */
export function refusalFor(path: string): string | null {
  // A backslash or any percent-encoding is refused too. The URL parser turns
  // "\" into "/" and "%2e%2e" into "..", which could walk a path that looks
  // like EntityDefinitions(...) out to a business table, and Dataverse reads
  // "%24expand" as "$expand", which would slip an expand past the checks
  // below. Lite's own queries never need a "%".
  if (/^[a-z]+:|^\/|\.\.|\\|%|\$batch|\$metadata|#/i.test(path)) {
    return "must be a relative Web API path with no batch, metadata document, backslash or percent-encoding";
  }
  const [resource = "", query = ""] = splitOnce(path, "?");
  const [first = "", ...rest] = resource.split("/").map((segment) => splitOnce(segment, "(")[0] ?? "");

  if (LITE_FUNCTIONS.has(first)) {
    if (rest.length > 0) return `${first} takes no further path`;
    if (path.includes("?")) return `${first} takes no query options`;
    return LITE_FUNCTION_CALLS.get(first)?.test(resource) ? null : `${first} takes only the parameters Lite writes`;
  }
  if (first === "systemusers") return userBoundRefusal(resource, query);
  if (!LITE_ENTITY_SETS.has(first)) return `${first} is not an allowlisted metadata table or function`;
  const outside = rest.find((segment) => !LITE_NAVIGATIONS.has(segment));
  if (outside !== undefined) return `${outside} is not an allowlisted metadata navigation`;
  if (!/(^|&)\$select=[^&]+/.test(query)) return "an entity set query needs $select";
  const selectKey = [first, ...rest].join("/");
  return optionsRefusal(first, selectKey, query) ?? filteredRefusal(first, query) ?? expandRefusal(first, query);
}

/**
 * Each option at most once and from QUERY_OPTIONS; $select and $orderby name
 * only pinned columns; $filter has one of the shapes LITE_FILTERS pins for
 * the set (the security sets in LITE_FILTERED check their own).
 */
function optionsRefusal(entitySet: string, selectKey: string, query: string): string | null {
  const seen = new Set<string>();
  for (const option of query.split("&")) {
    const [name = "", value = ""] = splitOnce(option, "=");
    if (!QUERY_OPTIONS.has(name)) return `${name || "an empty option"} is not a query option Lite uses`;
    if (seen.has(name)) return `${name} may appear only once`;
    seen.add(name);
    if (name === "$select") {
      const refusal = selectRefusal(selectKey, value);
      if (refusal) return refusal;
    }
    if (name === "$orderby" && !orderbyAllowed(selectKey, value)) return "$orderby may name only selectable columns";
    if (name === "$filter" && !LITE_FILTERED.has(entitySet) && !(LITE_FILTERS.get(entitySet) ?? []).some((pattern) => pattern.test(value))) {
      return `$filter on ${entitySet} must be one of the shapes Lite writes`;
    }
  }
  return null;
}

/** Why a $select list is refused for a resource, or null when every column is pinned in LITE_SELECTS. */
export function selectRefusal(resource: string, list: string): string | null {
  if (!/^[A-Za-z_]+(,[A-Za-z_]+)*$/.test(list)) return "$select must list plain column names";
  const pinned = LITE_SELECTS.get(resource);
  const outside = list.split(",").filter((column) => !pinned?.has(column));
  return outside.length === 0 ? null : `${resource} may not select ${outside.join(", ")}`;
}

function orderbyAllowed(resource: string, list: string): boolean {
  const pinned = LITE_SELECTS.get(resource);
  return list.split(",").every((item) => {
    const match = /^([A-Za-z_]+)(?: (?:asc|desc))?$/.exec(item);
    return !!match && !!pinned?.has(match[1]!);
  });
}

const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// A GUID list as an In(...) filter writes it: 'a','b'.
const GUID_LIST = `'${GUID}'(?:,'${GUID}')*`;
// A privilege name in the @p1 list.
const PRIVILEGE = "'prv[A-Za-z0-9_]+'";

/**
 * The user id a systemusers(<id>)/... path addresses, or null for any other
 * path. The client checks it against the id WhoAmI returned.
 */
export function userIdOf(path: string): string | null {
  return new RegExp(`^systemusers\\((${GUID})\\)`).exec(path)?.[1]?.toLowerCase() ?? null;
}

// systemusers(<id>)/<one of LITE_USER_BOUND>, and nothing else.
function userBoundRefusal(resource: string, query: string): string | null {
  const match = new RegExp(`^systemusers\\(${GUID}\\)/([A-Za-z_.]+)(\\(PrivilegeNames=@p1\\))?$`).exec(resource);
  const bound = match?.[1];
  if (!match || !bound || !LITE_USER_BOUND.has(bound)) {
    return `systemusers may only be addressed by id to call ${[...LITE_USER_BOUND].join(" or ")}`;
  }
  if (bound === "systemuserprofiles_association" || bound === "teammembership_association") {
    if (match[2]) return `${bound} takes no parameters`;
    if (!/^\$select=[A-Za-z_]+(,[A-Za-z_]+)*$/.test(query)) return `${bound} needs $select and nothing else`;
    return selectRefusal(bound, query.slice("$select=".length));
  }
  if (!match[2]) return "RetrieveUserSetOfPrivilegesByNames takes PrivilegeNames=@p1";
  if (!new RegExp(`^@p1=\\[${PRIVILEGE}(,${PRIVILEGE})*\\]$`).test(query)) return "@p1 must be a list of privilege names";
  return null;
}

/**
 * The one $filter each security set takes, written out in full. These sets
 * hold every team's and every role's links, so a query for one is refused
 * unless it asks for exactly what the card needs: the roles or profiles of
 * the named teams, or whether the named roles hold one named privilege.
 */
export const LITE_FILTERED: ReadonlyMap<string, RegExp> = new Map([
  ["teamrolescollection", new RegExp(`^Microsoft\\.Dynamics\\.CRM\\.In\\(PropertyName='teamid',PropertyValues=\\[${GUID_LIST}\\]\\)$`)],
  ["teamprofilescollection", new RegExp(`^Microsoft\\.Dynamics\\.CRM\\.In\\(PropertyName='teamid',PropertyValues=\\[${GUID_LIST}\\]\\)$`)],
  ["roleprivilegescollection", new RegExp(`^privilegeid eq ${GUID} and Microsoft\\.Dynamics\\.CRM\\.In\\(PropertyName='roleid',PropertyValues=\\[${GUID_LIST}\\]\\)$`)],
]);

/** A logical name as queries.ts writes it into a filter, quoted. */
const QUOTED_NAME = "'[a-z][a-z0-9_]*'";
/** An In(...) filter on one id column, as inFilter writes it. */
const inOn = (column: string) => `Microsoft\\.Dynamics\\.CRM\\.In\\(PropertyName='${column}',PropertyValues=\\[${GUID_LIST}\\]\\)`;
const exactly = (pattern: string) => new RegExp(`^${pattern}$`);

/**
 * Every $filter Lite writes, by entity set, as a pattern with typed
 * placeholders: a GUID list for In(...), a quoted logical name for a table.
 * A filter of any other shape is refused, so a filter cannot test a column
 * Lite does not select (contains(configuration, ...), length(xaml) ...),
 * reach a user through a lookup, or call a function. A set with no entry
 * takes no filter. test/dataverse-client.test.ts checks every Lite request
 * matches a pin and every pin is used.
 */
export const LITE_FILTERS: ReadonlyMap<string, readonly RegExp[]> = new Map([
  ["systemforms", [exactly(inOn("formid")), exactly(`objecttypecode eq ${QUOTED_NAME} and formactivationstate eq 1`)]],
  ["savedqueries", [exactly(inOn("savedqueryid"))]],
  ["savedqueryvisualizations", [exactly(inOn("savedqueryvisualizationid"))]],
  ["workflows", [exactly(inOn("workflowid")), exactly(`primaryentity eq ${QUOTED_NAME} and \\(category eq 0 or category eq 2\\) and \\(type eq 1 or type eq 2\\)`)]],
  [
    "sdkmessageprocessingsteps",
    [
      exactly(inOn("sdkmessageprocessingstepid")),
      exactly(`sdkmessagefilterid/primaryobjecttypecode eq ${QUOTED_NAME}`),
      // Steps on Update for every table: no message filter, the message by name.
      exactly("_sdkmessagefilterid_value eq null and \\(sdkmessageid/name eq 'Update' or sdkmessageid/name eq 'UpdateMultiple'\\)"),
    ],
  ],
  ["sdkmessageprocessingstepimages", [exactly(inOn("sdkmessageprocessingstepimageid"))]],
  ["solutions", [exactly(inOn("solutionid"))]],
  ["publishers", [exactly(inOn("publisherid"))]],
  ["fieldpermissions", [exactly(`entityname eq ${QUOTED_NAME}`)]],
]);

// A filtered set takes only a plain $select and its one fixed $filter.
function filteredRefusal(entitySet: string, query: string): string | null {
  const pattern = LITE_FILTERED.get(entitySet);
  if (!pattern) return null;
  const options = query.split("&");
  const filters = options.filter((option) => option.startsWith("$filter="));
  const selects = options.filter((option) => /^\$select=[A-Za-z_]+(,[A-Za-z_]+)*$/.test(option));
  if (options.length !== 2 || filters.length !== 1 || selects.length !== 1) return `${entitySet} takes only $select and its one $filter`;
  return pattern.test(filters[0]!.slice("$filter=".length)) ? null : `${entitySet} takes only its one fixed $filter`;
}

// An expand must be a list of allowlisted lookups, each with only its own
// $select of plain property names: sdkmessageid($select=name).
function expandRefusal(entitySet: string, query: string): string | null {
  // Anything that mentions $expand counts, wherever it hides, and must then
  // be exactly one well-formed $expand option.
  const options = query.split("&").filter((option) => /\$expand/i.test(option));
  if (options.length === 0) return null;
  const allowed = LITE_EXPANDS.get(entitySet);
  if (!allowed) return `${entitySet} takes no $expand`;
  if (options.length > 1) return "only one $expand";
  if (!options[0]!.startsWith("$expand=")) return "$expand must be its own query option";
  const items = options[0]!.slice("$expand=".length).split(/,(?![^(]*\))/);
  for (const item of items) {
    const match = /^([a-z_]+)\(\$select=([A-Za-z_]+(?:,[A-Za-z_]+)*)\)$/.exec(item);
    if (!match) return `$expand=${item} must be an allowlisted lookup with only its own $select`;
    if (!allowed.has(match[1]!)) return `${match[1]} is not an allowlisted lookup to expand`;
    const refusal = selectRefusal(match[1]!, match[2]!);
    if (refusal) return refusal;
  }
  return null;
}

function splitOnce(text: string, separator: string): string[] {
  const index = text.indexOf(separator);
  return index === -1 ? [text] : [text.slice(0, index), text.slice(index + 1)];
}
