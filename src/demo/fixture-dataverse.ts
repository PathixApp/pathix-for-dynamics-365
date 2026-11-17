// Answers Dataverse Web API paths from the scrubbed fixtures in
// contract/dataverse/, the way Dataverse would route them. One router serves
// the unit tests (test/fake-dataverse.ts), the Playwright smoke test and the
// sandboxed demo page, so all three exercise the real query paths.
//
// It never touches the network: it maps a path to a fixture. The demo page
// hands it to the Dataverse client in place of the browser's network call,
// so every demo read still passes the client's allowlist.

/** Fixture name (file name without .json) to its parsed contents. */
export type Fixtures = Readonly<Record<string, unknown>>;

export interface CapturedQuery {
  name: string;
  path: string;
}

export interface Routed {
  status: number;
  body?: unknown;
}

type Row = Record<string, unknown>;

/** Rows each entity set can serve, from every fixture that holds rows of it, keyed by its id column. */
const TABLES: Record<string, { id: string; fixtures: string[] }> = {
  systemforms: { id: "formid", fixtures: ["names-forms-account-name", "forms-account-main", "forms-modified-account", "modified-forms-account-name"] },
  savedqueries: { id: "savedqueryid", fixtures: ["names-views-account-name"] },
  savedqueryvisualizations: { id: "savedqueryvisualizationid", fixtures: ["names-charts-account-name"] },
  workflows: { id: "workflowid", fixtures: ["names-processes-account-name", "workflows-account"] },
  sdkmessageprocessingsteps: { id: "sdkmessageprocessingstepid", fixtures: ["names-plugin-steps-account-name", "plugin-steps-account", "plugin-steps-update-all-tables"] },
  sdkmessageprocessingstepimages: { id: "sdkmessageprocessingstepimageid", fixtures: ["names-step-images-account-name"] },
  solutions: { id: "solutionid", fixtures: ["solutions", "solutions-update-all-tables"] },
  publishers: { id: "publisherid", fixtures: ["publishers", "publishers-update-all-tables"] },
};

/**
 * Columns a table does not have, which Dataverse answers with a 400 when a
 * $select names one. The fixtures cannot show this, since a fixture only holds
 * what was selected, so the router would otherwise answer a column the real
 * table lacks. A form has no modifiedon (its change date is publishedon): the
 * extension once read it, and Dataverse answered 400 to every form read.
 */
const MISSING_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  systemforms: ["modifiedon"],
};

function missingColumn(path: string): string | null {
  const set = /^([A-Za-z_]+)\?/.exec(path)?.[1];
  const select = /[?&]\$select=([^&]+)/.exec(path)?.[1];
  const missing = set && select ? MISSING_COLUMNS[set] : undefined;
  return missing?.find((column) => select!.split(",").includes(column)) ?? null;
}

/** A path under /api/data/v9.2/, already decoded, to the answer the fixtures give. */
export function createFixtureRouter(fixtures: Fixtures, queries: readonly CapturedQuery[]): (path: string) => Routed {
  const fixture = <T = Row>(name: string): T => {
    if (!(name in fixtures)) throw new Error(`No fixture ${name}.`);
    return fixtures[name] as T;
  };
  // Captured queries with no placeholders, served by their exact path, e.g.
  // plugin-steps-account and workflows-account.
  const exact = new Map(queries.filter((query) => !query.path.includes("{")).map((query) => [query.path, query.name]));
  // Fixture names allow only dashes, so a column's underscores become dashes:
  // account.pathix_legalofficer is attribute-account-pathix-legalofficer.
  // Logical names never hold a dash, so the mapping is one to one.
  const attributeFixtures = Object.keys(fixtures).filter((name) => /^attribute-account-[a-z0-9-]+$/.test(name));
  const relationshipFixtures = Object.keys(fixtures).filter((name) => name.startsWith("name-relationship-"));
  const respond = (status: number, body?: unknown): Routed => ({ status, body });

  return (path) => {
    const absent = missingColumn(path);
    if (absent) {
      const set = /^([A-Za-z_]+)\?/.exec(path)![1]!;
      return respond(400, { error: { code: "0x80060888", message: `Could not find a property named '${absent}' on type 'Microsoft.Dynamics.CRM.${set.replace(/s$/, "")}'.` } });
    }
    const named = exact.get(path);
    if (named) return respond(200, fixture(named));

    let match = /^EntityDefinitions\(LogicalName='account'\)\/Attributes\(LogicalName='([a-z0-9_]+)'\)\?\$select=([A-Za-z,]+)$/.exec(path);
    if (match) {
      const name = `attribute-account-${match[1]!.replace(/_/g, "-")}`;
      if (!attributeFixtures.includes(name)) return respond(404);
      const row = fixture<Row>(name);
      return respond(200, Object.fromEntries(match[2]!.split(",").map((column) => [column, row[column] ?? null])));
    }

    // The signed-in user, addressed by the id WhoAmI returns.
    const userId = fixture<{ UserId: string }>("whoami").UserId;
    match = /^systemusers\(([0-9a-f-]{36})\)\/(.+?)(\?.*)?$/.exec(path);
    if (match) {
      if (match[1] !== userId) return respond(404);
      if (match[2] === "systemuserprofiles_association") return respond(200, fixture("my-field-security-profiles"));
      if (match[2] === "teammembership_association") return respond(200, fixture("my-teams"));
      if (match[2] === "Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)") {
        const asked = new Set([...(match[3] ?? "").matchAll(/'(prv[A-Za-z0-9_]+)'/g)].map((name) => name[1]));
        // The table's Write privilege and the read privileges come from two fixtures; one answer holds what was asked.
        type Privileges = { RolePrivileges: Array<{ PrivilegeName: string }> };
        const body = fixture<Privileges>("my-privileges-account");
        const rows = [...body.RolePrivileges, ...fixture<Privileges>("my-read-privileges").RolePrivileges];
        return respond(200, { ...body, RolePrivileges: rows.filter((privilege) => asked.has(privilege.PrivilegeName)) });
      }
      return respond(404);
    }

    // What the user's teams hold: the rows of one fixture for the teams in the
    // filter, or for the one privilege.
    match = /^(teamrolescollection|teamprofilescollection)\?\$select=([a-z,]+)&\$filter=Microsoft\.Dynamics\.CRM\.In\(PropertyName='teamid',PropertyValues=\[([^\]]*)\]\)$/.exec(path);
    if (match) {
      const teams = new Set(match[3]!.split(",").map((value) => value.replace(/'/g, "")));
      const rows = fixture<{ value: Row[] }>(match[1] === "teamrolescollection" ? "team-roles" : "team-profiles").value;
      return respond(200, { value: rows.filter((row) => teams.has(String(row.teamid))).map((row) => pick(row, match![2]!)) });
    }
    match = /^roleprivilegescollection\?\$select=([a-z,]+)&\$filter=privilegeid eq ([0-9a-f-]{36}) and Microsoft\.Dynamics\.CRM\.In\(PropertyName='roleid',PropertyValues=\[([^\]]*)\]\)$/.exec(path);
    if (match) {
      const roles = new Set(match[3]!.split(",").map((value) => value.replace(/'/g, "")));
      const rows = fixture<{ value: Row[] }>("role-write-privilege-account").value;
      return respond(200, { value: rows.filter((row) => row.privilegeid === match![2] && roles.has(String(row.roleid))).map((row) => pick(row, match![1]!)) });
    }

    match = /^RetrieveDependentComponents\(ObjectId=([0-9a-f-]{36}),ComponentType=2\)$/.exec(path);
    if (match) {
      const attribute = attributeFixtures.find((name) => fixture<{ MetadataId: string }>(name).MetadataId === match![1]);
      const dependents = attribute?.replace("attribute-", "dependents-");
      return dependents && dependents in fixtures ? respond(200, fixture(dependents)) : respond(404);
    }

    // One relationship per fixture; the one whose MetadataId was asked answers.
    match = /^RelationshipDefinitions\(([0-9a-f-]{36})\)\?\$select=SchemaName$/.exec(path);
    if (match) {
      const relationship = relationshipFixtures.find((name) => fixture<{ MetadataId: string }>(name).MetadataId === match![1]);
      return relationship ? respond(200, fixture(relationship)) : respond(404);
    }

    match = /^EntityDefinitions\(([0-9a-f-]{36})\)\/Attributes\(([0-9a-f-]{36})\)\?\$select=LogicalName,EntityLogicalName$/.exec(path);
    if (match) return single(fixture("name-attribute-account-name"), match[2]!);

    match = /^([a-z]+)\?\$select=([a-z_,]+)&\$filter=Microsoft\.Dynamics\.CRM\.In\(PropertyName='([a-z]+)',PropertyValues=\[([^\]]*)\]\)$/.exec(path);
    if (match) {
      const [, set, select, property, values] = match;
      const table = TABLES[set!];
      if (!table || table.id !== property) return respond(400);
      const ids = new Set(values!.split(",").map((value) => value.replace(/'/g, "")));
      const columns = select!.split(",");
      // One row per id, merged across every fixture that holds it, so a name
      // lookup and a full definition of the same form both answer.
      const merged = new Map<string, Row>();
      for (const row of table.fixtures.flatMap((name) => fixture<{ value: Row[] }>(name).value)) {
        const id = String(row[property!]);
        if (ids.has(id)) merged.set(id, { ...merged.get(id), ...row });
      }
      const rows = [...merged.values()].map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
      return respond(200, { value: rows });
    }

    return respond(404);
  };
}

function pick(row: Row, select: string): Row {
  return Object.fromEntries(select.split(",").map((column) => [column, row[column] ?? null]));
}

function single(body: { MetadataId: string }, id: string): Routed {
  return body.MetadataId === id ? { status: 200, body } : { status: 404 };
}
