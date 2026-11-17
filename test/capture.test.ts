import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createScrubber, fillPlaceholders, keepFields, parseOrg, scrubRun, validateQuery } from "../scripts/capture-dataverse-fixtures.mjs";

const ORG_HOST = "orgreal01.crm4.dynamics.com";

// Shaped like real answers: a step with its expanded message, a form with
// curly-brace GUIDs in its XML, a lookup to a user with its formatted value.
const sample = {
  "@odata.context": `https://${ORG_HOST}/api/data/v9.2/$metadata#sdkmessageprocessingsteps`,
  value: [
    {
      "@odata.etag": 'W/"123456"',
      sdkmessageprocessingstepid: "3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c",
      name: "Fabrikam.Plugins: Update of account",
      solutionid: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      sdkmessageid: { "@odata.etag": 'W/"9"', name: "Update", sdkmessageid: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918" },
      _impersonatinguserid_value: "11112222-3333-4444-8555-666677778888",
      "_impersonatinguserid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "systemuser",
      "_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue": "Jane Realperson",
    },
    {
      formxml: '<form><cell id="{3F2A9C1E-7B4D-4E8A-9C1F-2D3E4F5A6B7C}"/><a href="https://portal.realcorp.com/help">help</a></form>',
      primaryownerid: "00000000-0000-0000-0000-000000000000",
      fullname: "Jane Realperson",
      internalemailaddress: "jane@realcorp.onmicrosoft.com",
      note: "Ask jane@realcorp.onmicrosoft.com or see https://learn.microsoft.com/power-apps on orgreal01.",
      namespace: "http://www.w3.org/2001/XMLSchema",
      uniquename: "org1a2b3c4d",
    },
  ],
};

describe("createScrubber", () => {
  const scrubbed = createScrubber(ORG_HOST).scrub(sample);
  const text = JSON.stringify(scrubbed);

  it("leaves nothing real behind", () => {
    for (const real of [ORG_HOST, "orgreal01", "org1a2b3c4d", "Realperson", "realcorp", "jane@", "3f2a9c1e", "a1b2c3d4", "7e6d5c4b", "11112222"]) {
      expect(text.toLowerCase()).not.toContain(real.toLowerCase());
    }
  });

  it("drops etags at every depth", () => {
    expect(text).not.toContain("@odata.etag");
  });

  it("puts the scrubbed host in the context URL", () => {
    expect(scrubbed["@odata.context"]).toBe("https://contoso.crm.dynamics.com/api/data/v9.2/$metadata#sdkmessageprocessingsteps");
  });

  it("maps a GUID to the same synthetic GUID everywhere, keeping its case", () => {
    const [step, form] = scrubbed.value;
    expect(step.sdkmessageprocessingstepid).toMatch(/^5c4a0000-0000-4000-8000-\d{12}$/);
    expect(form.formxml).toContain(`{${step.sdkmessageprocessingstepid.toUpperCase()}}`);
    expect(step.solutionid).not.toBe(step.sdkmessageprocessingstepid);
  });

  it("keeps the null GUID", () => {
    expect(scrubbed.value[1].primaryownerid).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("replaces user names, emails and domains consistently", () => {
    const [step, form] = scrubbed.value;
    expect(step["_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue"]).toBe("User 1");
    expect(form.fullname).toBe("User 1");
    expect(form.internalemailaddress).toBe("user1@contoso.com");
    expect(form.note).toBe("Ask user1@contoso.com or see https://learn.microsoft.com/power-apps on contoso.");
    expect(form.formxml).toContain("https://domain1.example.com/help");
  });

  it("keeps metadata that names no one", () => {
    const [step, form] = scrubbed.value;
    expect(step.name).toBe("Fabrikam.Plugins: Update of account");
    expect(step.sdkmessageid.name).toBe("Update");
    expect(form.namespace).toBe("http://www.w3.org/2001/XMLSchema");
  });

  it("shares one map across files in a run", () => {
    const scrubber = createScrubber(ORG_HOST);
    const first = scrubber.scrub({ id: "3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c" });
    const second = scrubber.scrub({ ref: "3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c" });
    expect(second.ref).toBe(first.id);
  });
});

// Dataverse names some teams "<32 hex>_1". An earlier change scrubbed six of those by
// hand; the run now does it, through the same map as a hyphenated GUID, without
// renumbering anything else. In the test environment the hex is not the team's own id
// (nor any GUID the capture reads), so those names take the separate range.
describe("GUIDs written without hyphens", () => {
  const TEAM = "9d3c1a2b-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
  const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";
  const LATER = "2b3c4d5e-6f70-4a8b-9cad-1e2f3a4b5c6d";
  const bare = (guid: string) => guid.replaceAll("-", "");
  const run = (answers: Array<[string, unknown]>) =>
    Object.fromEntries((scrubRun(ORG_HOST, answers) as Array<[string, string]>).map(([name, file]) => [name, JSON.parse(file)]));

  it("maps a team's hyphenless name through its id, even when the name comes first in the run", () => {
    const files = run([
      ["names", { value: [{ name: `${bare(TEAM)}_1` }] }],
      ["teams", { value: [{ teamid: TEAM }] }],
    ]);
    expect(files.teams.value[0].teamid).toBe("5c4a0000-0000-4000-8000-000000000001");
    expect(files.names.value[0].name).toBe("5c4a0000000040008000000000000001_1");
  });

  it("numbers the hyphenated GUIDs exactly as a run without hyphenless ones would", () => {
    const answers = (withBare: boolean): Array<[string, unknown]> => [
      ["first", { value: [{ id: OTHER, ...(withBare ? { name: `${bare("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")}_1` } : {}) }] }],
      ["second", { value: [{ teamid: TEAM, name: withBare ? `${bare(TEAM)}_1` : "Sales" }, { id: LATER }] }],
    ];
    const withBare = run(answers(true));
    const without = run(answers(false));
    expect(withBare.first.value[0].id).toBe(without.first.value[0].id);
    expect(withBare.second.value[0].teamid).toBe(without.second.value[0].teamid);
    expect(withBare.second.value[1].id).toBe(without.second.value[1].id);
    expect(without.second.value[1].id).toBe("5c4a0000-0000-4000-8000-000000000003");
  });

  it("gives a hyphenless GUID the run never saw hyphenated a number from its own range", () => {
    const files = run([["names", { value: [{ name: `${bare(TEAM)}_1` }, { id: OTHER }] }]]);
    expect(files.names.value[0].name).toBe("5c4a0000000040008001000000000001_1");
    expect(files.names.value[1].id).toBe("5c4a0000-0000-4000-8000-000000000001");
  });

  it("keeps the case, leaves the null GUID and longer hex runs alone, and needs the hex run to end", () => {
    const files = run([
      ["teams", { value: [{ teamid: TEAM }] }],
      [
        "names",
        {
          value: [
            { name: bare(TEAM).toUpperCase() },
            { name: "00000000000000000000000000000000_1" },
            { name: `${bare(TEAM)}ab` },
          ],
        },
      ],
    ]);
    expect(files.names.value[0].name).toBe("5C4A0000000040008000000000000001");
    expect(files.names.value[1].name).toBe("00000000000000000000000000000000_1");
    expect(files.names.value[2].name).toBe(`${bare(TEAM)}ab`);
  });

  it("reproduces every committed fixture byte for byte from a raw-equivalent run, the six bare-GUID team names included", () => {
    // Every captured fixture, in the order queries.json runs them, with each
    // synthetic GUID swapped back for a made-up real one in both its forms.
    // Scrubbing that run must give back the committed files exactly: no
    // renumbering, and the hyphenless team names land where a capture puts them.
    const names = (JSON.parse(readFileSync("contract/dataverse/queries.json", "utf8")) as Array<{ name: string }>).map((query) => query.name);
    const committed = names
      .filter((name) => existsSync(`contract/dataverse/${name}.json`))
      .map((name) => [name, readFileSync(`contract/dataverse/${name}.json`, "utf8")] as const)
      .filter(([, text]) => !text.includes('"_standIn"'));
    const unscrub = (text: string) =>
      text
        .replace(/5c4a0000-0000-4000-(800[01])-([0-9]{12})/gi, (whole, range: string, n: string) => {
          const real = `${range === "8000" ? "e7d1f00d" : "b0a1f00d"}-1234-4abc-9def-${n}`;
          return whole === whole.toUpperCase() ? real.toUpperCase() : real;
        })
        .replace(/5c4a00000000400080(0[01])([0-9]{12})/gi, (whole, range: string, n: string) => {
          const real = `${range === "00" ? "e7d1f00d" : "b0a1f00d"}12344abc9def${n}`;
          return whole === whole.toUpperCase() ? real.toUpperCase() : real;
        });
    const raw = committed.map(([name, text]) => [name, JSON.parse(unscrub(text))] as [string, unknown]);
    expect(raw.find(([name]) => name === "my-teams")![1]).not.toEqual(JSON.parse(committed.find(([name]) => name === "my-teams")![1]));

    const rerun = new Map(scrubRun("roundtrip.crm.dynamics.com", raw) as Array<[string, string]>);
    for (const [name, text] of committed) expect(rerun.get(name), name).toBe(text);
    const teams = JSON.parse(rerun.get("my-teams")!) as { value: Array<{ name: string }> };
    expect(teams.value.filter((team) => /^5c4a0000000040008001[0-9]{12}_1$/.test(team.name))).toHaveLength(6);
  });
});

describe("validateQuery", () => {
  const query = (path: string) => ({ name: "q", purpose: "test", path });

  it.each([
    "WhoAmI",
    "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')?$select=LogicalName,IsSecured",
    "RetrieveDependentComponents(ObjectId={attribute-account-name.MetadataId},ComponentType=2)",
    "sdkmessageprocessingsteps?$select=name&$expand=sdkmessageid($select=name)&$filter=sdkmessagefilterid/primaryobjecttypecode eq 'account'",
    "systemusers({whoami.UserId})/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvReadAccount']",
    "systemusers({whoami.UserId})/teammembership_association?$select=teamid,name,teamtype",
    "teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=[{my-teams[].teamid}])",
    "roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq {entity-privileges-account.Privileges[PrivilegeType=Write].PrivilegeId} and Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=[{team-roles[].roleid}])",
  ])("accepts %s", (path) => {
    expect(() => validateQuery(query(path))).not.toThrow();
  });

  it.each([
    ["a business table", "accounts?$select=name", /not an allowlisted/],
    ["a read of the user record", "systemusers({whoami.UserId})?$select=fullname", /systemusers may only/],
    ["the users list", "systemusers?$select=fullname", /systemusers may only/],
    ["audit data", "audits?$select=changedata", /not an allowlisted/],
    ["plugin trace logs", "plugintracelogs?$select=messageblock", /not an allowlisted/],
    ["a metadata table without $select", "workflows?$filter=category eq 0", /needs \$select/],
    ["an expand to a user", "workflows?$select=name&$expand=ownerid($select=fullname)", /not an allowlisted lookup/],
    ["a nested expand to a user", "solutions?$select=uniquename&$expand=publisherid($select=uniquename;$expand=createdby($select=fullname))", /not an allowlisted lookup/],
    ["an expand without $select", "solutions?$select=uniquename&$expand=publisherid", /needs its own \$select/],
    ["an absolute URL", "https://evil.example.com/WhoAmI", /relative Web API path/],
    ["the team roles of every team", "teamrolescollection?$select=teamid,roleid", /needs a \$filter/],
    ["a user's roles", "systemusers({whoami.UserId})/systemuserroles_association?$select=name", /systemusers may only/],
    ["a batch", "$batch", /relative Web API path/],
    ["navigation out of metadata", "workflows(00000000-0000-0000-0000-000000000000)/workflow_logs?$select=name", /not an allowlisted metadata navigation/],
  ])("refuses %s", (_label, path, error) => {
    expect(() => validateQuery(query(path))).toThrow(error);
  });

  it("refuses a query with no purpose or a bad name", () => {
    expect(() => validateQuery({ name: "Bad Name", purpose: "x", path: "WhoAmI" })).toThrow(/name/);
    expect(() => validateQuery({ name: "q", purpose: "", path: "WhoAmI" })).toThrow(/purpose/);
  });

  it("passes every committed query", () => {
    const queries = JSON.parse(readFileSync("contract/dataverse/queries.json", "utf8")) as unknown[];
    expect(queries.length).toBeGreaterThan(0);
    for (const committed of queries) expect(() => validateQuery(committed)).not.toThrow();
  });
});

describe("fillPlaceholders", () => {
  it("fills a GUID from an earlier answer", () => {
    const answers = new Map([["whoami", { UserId: "11112222-3333-4444-8555-666677778888" }]]);
    expect(fillPlaceholders("systemusers({whoami.UserId})/x", answers)).toBe("systemusers(11112222-3333-4444-8555-666677778888)/x");
  });

  it("refuses anything that is not a GUID", () => {
    const answers = new Map([["whoami", { UserId: "x') or 1 eq 1" }]]);
    expect(() => fillPlaceholders("systemusers({whoami.UserId})/x", answers)).toThrow(/no GUID/);
  });

  it("fills a list placeholder with every distinct GUID across rows, quoted", () => {
    const a = "aaaaaaaa-0000-4000-8000-000000000001";
    const b = "bbbbbbbb-0000-4000-8000-000000000002";
    const answers = new Map([["steps", { value: [{ solutionid: b }, { solutionid: a }, { solutionid: b }, { solutionid: null }] }]]);
    expect(fillPlaceholders("In(PropertyValues=[{steps[].solutionid}])", answers)).toBe(`In(PropertyValues=['${a}','${b}'])`);
  });

  it("refuses a list placeholder holding anything that is not a GUID", () => {
    const answers = new Map([["steps", { value: [{ solutionid: "x') or 1 eq 1" }] }]]);
    expect(() => fillPlaceholders("[{steps[].solutionid}]", answers)).toThrow(/no GUIDs/);
    expect(() => fillPlaceholders("[{steps[].solutionid}]", new Map([["steps", { value: [] }]]))).toThrow(/no GUIDs/);
  });
});

describe("fillPlaceholders: one row by a field's value", () => {
  const relationship = "aaaaaaaa-0000-4000-8000-000000000010";
  const attribute = "bbbbbbbb-0000-4000-8000-000000000002";
  const table = "cccccccc-0000-4000-8000-000000000016";
  const answers = new Map([
    [
      "deps",
      {
        value: [
          { dependentcomponenttype: 26, dependentcomponentobjectid: "dddddddd-0000-4000-8000-000000000026" },
          { dependentcomponenttype: 10, dependentcomponentobjectid: relationship },
          { dependentcomponenttype: 2, dependentcomponentobjectid: attribute, dependentcomponentparentid: table },
        ],
      },
    ],
  ]);

  it("fills a GUID from the first row whose field matches", () => {
    expect(fillPlaceholders("RelationshipDefinitions({deps[dependentcomponenttype=10].dependentcomponentobjectid})", answers)).toBe(
      `RelationshipDefinitions(${relationship})`,
    );
    expect(
      fillPlaceholders(
        "EntityDefinitions({deps[dependentcomponenttype=2].dependentcomponentparentid})/Attributes({deps[dependentcomponenttype=2].dependentcomponentobjectid})",
        answers,
      ),
    ).toBe(`EntityDefinitions(${table})/Attributes(${attribute})`);
  });

  it("refuses when no row matches or the field is not a GUID", () => {
    expect(() => fillPlaceholders("{deps[dependentcomponenttype=93].dependentcomponentobjectid}", answers)).toThrow(/no row/);
    expect(() => fillPlaceholders("{deps[dependentcomponenttype=26].dependentcomponentparentid}", answers)).toThrow(/no row/);
  });
});

describe("fillPlaceholders: a row of a named list", () => {
  const privilege = "dddddddd-0000-4000-8000-000000000031";
  const answers = new Map([
    [
      "entity-privileges-account",
      {
        Privileges: [
          { PrivilegeType: "Read", PrivilegeId: "dddddddd-0000-4000-8000-000000000030" },
          { PrivilegeType: "Write", PrivilegeId: privilege },
        ],
      },
    ],
  ]);

  it("reads the row from the named list instead of value", () => {
    expect(fillPlaceholders("privilegeid eq {entity-privileges-account.Privileges[PrivilegeType=Write].PrivilegeId}", answers)).toBe(
      `privilegeid eq ${privilege}`,
    );
  });

  it("refuses when the list has no such row", () => {
    expect(() => fillPlaceholders("{entity-privileges-account.Privileges[PrivilegeType=Append].PrivilegeId}", answers)).toThrow(/no row/);
    expect(() => fillPlaceholders("{entity-privileges-account.Nothing[PrivilegeType=Write].PrivilegeId}", answers)).toThrow(/no row/);
  });
});

describe("keepFields", () => {
  it("keeps only the listed properties on each row", () => {
    const answer = { "@odata.context": "ctx", value: [{ a: 1, b: 2, c: 3 }, { a: 4, c: 6 }] };
    expect(keepFields(answer, ["a", "b"])).toEqual({ "@odata.context": "ctx", value: [{ a: 1, b: 2 }, { a: 4 }] });
  });

  it("leaves an answer alone when no fields are listed", () => {
    const answer = { value: [{ a: 1 }] };
    expect(keepFields(answer, undefined)).toBe(answer);
  });
});

describe("org unique name", () => {
  it("is scrubbed when glued onto another name", () => {
    const scrubbed = createScrubber(ORG_HOST).scrub({ uniquename: "DefaultPublisherorg1a2b3c4d" });
    expect(scrubbed.uniquename).toBe("DefaultPublishercontoso");
  });
});

describe("parseOrg", () => {
  it("keeps the origin of a Dataverse address", () => {
    expect(parseOrg(["--org", "https://contoso.crm.dynamics.com/main.aspx"])).toBe("https://contoso.crm.dynamics.com");
  });

  it("refuses anything else", () => {
    expect(() => parseOrg([])).toThrow(/Usage/);
    expect(() => parseOrg(["--org", "http://contoso.crm.dynamics.com"])).toThrow(/https/);
    expect(() => parseOrg(["--org", "https://evil.example.com"])).toThrow(/dynamics\.com/);
  });
});
