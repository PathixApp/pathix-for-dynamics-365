// Review R4: a list Dataverse filters by the user's own Read depth is never
// read as the whole list (DESIGN.md, "Absence is not evidence").
//
// Classic workflows and business rules are owned by users, and teams and roles
// by business units. A user who reads them below Organization depth gets HTTP
// 200 with only the rows they can see. Lite asks RetrieveUserSetOfPrivilegesByNames
// for prvReadWorkflow, prvReadTeam and prvReadRole, and below Global it marks
// those lists as possibly incomplete on every surface that reads them.

import { describe, expect, it } from "vitest";
import { buildConnectedLockedCard, type LiveUserFacts } from "../src/card/locked-connected";
import { privilegeLine, type CheckLine, type LockedCardModel, type Single } from "../src/card/locked";
import { createDataverseClient } from "../src/dataverse/client";
import type { UserPrivileges } from "../src/dataverse/queries";
import { loadLiteChanges } from "../src/lite/changes";
import { loadLockedCard } from "../src/lite/locked";
import { loadRegisteredCard } from "../src/lite/registered";
import { loadUserSecurity } from "../src/lite/user-security";
import { loadTeamPrivileges } from "../src/lite/locked";
import {
  hiddenOf,
  limitTo,
  PRIVILEGE_SET_INCLUDES_TEAM_ROLES,
  teamRolesHidden,
  visibilityOf,
  widestUnfilteredDepth,
  type ReadVisibility,
} from "../src/lite/visibility";
import { fakeDataverse, fixture, ORIGIN } from "./fake-dataverse";

const USER = "systemusers(5c4a0000-0000-4000-8000-000000000002)";
const READ_PRIVILEGES = `${USER}/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvRead`;
const WRITE_PRIVILEGE = `${USER}/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvWrite`;
const STEPS = "sdkmessageprocessingsteps?";
const PROCESSES = "workflows?$select=workflowid,name,category,mode,type";
const FORM_ID = "5c4a0000-0000-4000-8000-000000000021";
const MY_TEAMS = `${USER}/teammembership_association`;
/** The signed-in user's business unit in contract/dataverse/whoami.json. */
const MY_UNIT = fixture<{ BusinessUnitId: string }>("whoami").BusinessUnitId;
const OTHER_UNIT = "5c4a0000-0000-4000-8000-000000000501";
const NO_FILTER = "00000000-0000-0000-0000-000000000000";
const team = (n: number, unit: string | null) => ({ teamid: `5c4a0000-0000-4000-8000-0000000006${String(n).padStart(2, "0")}`, name: `Team ${n}`, teamtype: 0, _businessunitid_value: unit });

type Depths = { workflow?: string; team?: string; role?: string };

/** The read privileges' answer, Global unless told otherwise; a depth of "" leaves the privilege out. */
function readDepths({ workflow = "Global", team = "Global", role = "Global" }: Depths = {}) {
  const row = (PrivilegeName: string, Depth: string) => (Depth === "" ? [] : [{ PrivilegeName, Depth, RecordFilterId: NO_FILTER }]);
  return { RolePrivileges: [...row("prvReadWorkflow", workflow), ...row("prvReadTeam", team), ...row("prvReadRole", role)] };
}

function setup(depths: Depths | "fails" = {}) {
  const server = fakeDataverse();
  if (depths === "fails") server.failWhen(READ_PRIVILEGES, 500);
  else server.answerWhen(READ_PRIVILEGES, readDepths(depths));
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

/** Nothing registered on the table at all: no steps, no processes. */
function emptyTable(server: ReturnType<typeof fakeDataverse>) {
  server.answerWhen(STEPS, { value: [] });
  server.answerWhen(PROCESSES, { value: [] });
}

function byTopic(model: LockedCardModel, topic: string): CheckLine {
  const found = model.lines.find((entry) => entry.topic === topic);
  if (!found) throw new Error(`no line ${topic}`);
  return found;
}

const ok = <T>(value: T): Single<T> => ({ kind: "ok", value });

describe("the depth Dataverse returns", () => {
  const answer = (...rows: Array<{ PrivilegeName: string; Depth: string; RecordFilterId?: unknown }>) => ok<UserPrivileges>({ RolePrivileges: rows });

  it("is whole only at Global with no record filter", () => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: "Global", RecordFilterId: NO_FILTER }), "prvReadWorkflow")).toBe("all");
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: "Global", RecordFilterId: "" }), "prvReadWorkflow")).toBe("all");
  });

  // Review L2: only "" and the empty GUID are no filter.
  it.each([
    ["null", null, "some"],
    ["a number", 42, "some"],
    ["an object", { id: NO_FILTER }, "some"],
    ["a filter's id", "5c4a0000-0000-4000-8000-000000000999", "some"],
  ])("reads Global with a RecordFilterId of %s as filtered", (_label, filter, expected) => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: "Global", RecordFilterId: filter }), "prvReadWorkflow")).toBe(expected);
  });

  it("reads Global with no RecordFilterId at all as unknown", () => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: "Global" }), "prvReadWorkflow")).toBe("unknown");
  });

  it("names the widest depth held with no record filter", () => {
    expect(widestUnfilteredDepth(answer({ PrivilegeName: "prvReadRole", Depth: "Local", RecordFilterId: NO_FILTER }, { PrivilegeName: "prvReadRole", Depth: "Deep", RecordFilterId: NO_FILTER }), "prvReadRole")).toBe("Deep");
    expect(widestUnfilteredDepth(answer({ PrivilegeName: "prvReadRole", Depth: "Global", RecordFilterId: "x" }, { PrivilegeName: "prvReadRole", Depth: "Local", RecordFilterId: NO_FILTER }), "prvReadRole")).toBe("Local");
    expect(widestUnfilteredDepth(answer({ PrivilegeName: "prvReadRole", Depth: "Global" }), "prvReadRole")).toBeNull();
    expect(widestUnfilteredDepth({ kind: "failed" }, "prvReadRole")).toBeNull();
  });

  it.each(["Basic", "Local", "Deep"])("is some at %s", (depth) => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: depth }), "prvReadWorkflow")).toBe("some");
  });

  it("is some at Global narrowed by a record filter", () => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadTeam", Depth: "Global", RecordFilterId: "5c4a0000-0000-4000-8000-000000000999" }), "prvReadTeam")).toBe("some");
  });

  it("takes the widest of several roles", () => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadRole", Depth: "Local" }, { PrivilegeName: "prvReadRole", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }), "prvReadRole")).toBe("all");
  });

  it("is unknown when the privilege is not named, the depth has no name, or the read failed", () => {
    expect(visibilityOf(answer({ PrivilegeName: "prvReadTeam", Depth: "Global" }), "prvReadWorkflow")).toBe("unknown");
    expect(visibilityOf(answer({ PrivilegeName: "prvReadWorkflow", Depth: "Everywhere" }), "prvReadWorkflow")).toBe("unknown");
    expect(visibilityOf({ kind: "failed" }, "prvReadWorkflow")).toBe("unknown");
    expect(visibilityOf({ kind: "forbidden" }, "prvReadWorkflow")).toBe("unknown");
    expect(visibilityOf(ok({ RolePrivileges: null } as unknown as UserPrivileges), "prvReadWorkflow")).toBe("unknown");
  });

  it("marks a list incomplete, and says why, only when some rows may be hidden", () => {
    const list = { kind: "ok" as const, value: [1], complete: true };
    expect(limitTo(list, "all")).toBe(list);
    expect(limitTo(list, "some")).toEqual({ kind: "ok", value: [1], complete: false, hidden: "some" });
    expect(limitTo({ kind: "failed" }, "some")).toEqual({ kind: "failed" });
    expect(hiddenOf("all", "all")).toBeUndefined();
    expect(hiddenOf("unknown", "some")).toBe("some");
    expect(hiddenOf("all", "unknown")).toBe("unknown");
  });

  it("is asked once, for the three read privileges, as the signed-in user", async () => {
    const { server, get } = setup();
    await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const asked = server.requests.map(decodeURIComponent).filter((url) => url.includes("prvRead"));
    expect(asked).toEqual([`${ORIGIN}/api/data/v9.2/${USER}/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvReadWorkflow','prvReadTeam','prvReadRole']`]);
  });
});

describe("Fires on change", () => {
  const card = (get: ReturnType<typeof setup>["get"]) => loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });

  it("says nothing is registered only when the user reads every process", async () => {
    const { server, get } = setup();
    emptyTable(server);
    expect((await card(get)).headline).toBe("No plugin steps, classic workflows or business rules are registered to fire when this column changes.");
  });

  it("is an honest unknown when the user reads processes below Organization depth", async () => {
    const { server, get } = setup({ workflow: "Local" });
    emptyTable(server);
    const model = await card(get);
    expect(model.headline).toBe("Of what Lite could read, nothing is registered to fire when this column changes.");
    expect(model.unknowns).toContain(
      "You can see only some classic workflows and business rules. Your security roles do not let you read all of them, so some may be missing.",
    );
  });

  it("is an honest unknown when Lite could not read the depth", async () => {
    const { server, get } = setup("fails");
    emptyTable(server);
    const model = await card(get);
    expect(model.headline).toBe("Of what Lite could read, nothing is registered to fire when this column changes.");
    expect(model.unknowns).toContain("Lite could not check whether you can see all classic workflows and business rules, so some may be missing.");
  });

  it("counts what it found as at least N", async () => {
    const { server, get } = setup({ workflow: "Basic" });
    server.answerWhen(STEPS, { value: [] });
    server.answerWhen(PROCESSES, {
      value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000901", name: "Recalc credit", category: 0, mode: 0, type: 1, statecode: 1, triggeronupdateattributelist: "creditlimit" }],
    });
    expect((await card(get)).headline).toBe("At least 1 classic workflow is registered to fire when this column changes.");
  });

  it("does not hedge plugin steps, which the organization owns", async () => {
    const { get } = setup({ workflow: "Local" });
    const model = await card(get);
    expect(model.unknowns.some((line) => /plugin step/i.test(line))).toBe(false);
  });
});

describe("Why locked?", () => {
  const locked = (get: ReturnType<typeof setup>["get"]) =>
    loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });

  describe("business rules", () => {
    it("rules them out only when the user reads every process", async () => {
      const { server, get } = setup();
      server.answerWhen(PROCESSES, { value: [] });
      expect(byTopic(await locked(get), "Business rules")).toMatchObject({ state: "ruledOut", text: "No business rule is active on this table." });
    });

    it("is ? when the user sees only some", async () => {
      const { server, get } = setup({ workflow: "Local" });
      server.answerWhen(PROCESSES, { value: [] });
      expect(byTopic(await locked(get), "Business rules")).toMatchObject({
        state: "unknown",
        text: "You can see only some business rules, so Lite could not check them all. Of the business rules Lite can see, none is active on this table.",
      });
    });

    it("is ? when Lite could not read the depth", async () => {
      const { server, get } = setup("fails");
      server.answerWhen(PROCESSES, { value: [] });
      expect(byTopic(await locked(get), "Business rules")).toMatchObject({
        state: "unknown",
        text: "Lite could not check whether you can see all business rules. Of the business rules Lite can see, none is active on this table.",
      });
    });

    it("is ? when the active rules the user sees do not use the column", async () => {
      const { server, get } = setup({ workflow: "Deep" });
      server.answerWhen(PROCESSES, { value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000902", name: "Other rule", category: 2, type: 1, statecode: 1 }] });
      expect(byTopic(await locked(get), "Business rules")).toMatchObject({
        state: "unknown",
        text: "You can see only some business rules, so Lite could not check them all. Of the active business rules Lite can see, none uses this column.",
      });
    });
  });

  describe("your access to the table", () => {
    const noOwnWrite = { RolePrivileges: [{ PrivilegeName: "prvReadAccount", Depth: "Global" }] };
    const access = async (depths: Depths | "fails", teams?: unknown[]) => {
      const { server, get } = setup(depths);
      server.answerWhen(WRITE_PRIVILEGE, noOwnWrite);
      // None of the roles the user's teams hold grants Write.
      server.answerWhen("roleprivilegescollection", { value: [] });
      if (teams) server.answerWhen(MY_TEAMS, { value: teams });
      return byTopic(await locked(get), "Your access to the table");
    };

    it("is the cause only when the user reads every team and role", async () => {
      expect(await access({})).toMatchObject({ state: "cause", text: "Neither your security roles nor the roles of your teams grant Write on account." });
    });

    // Review round 2, L1: the line names what may be missing.
    it("is ? naming the teams when the user sees only some teams", async () => {
      expect(await access({ team: "Local" })).toMatchObject({
        state: "unknown",
        text: "Your own security roles do not grant Write on account. You can see only some teams in your organization, so Lite may have missed one you are in. A role a team holds might grant it.",
      });
    });

    it("is ? naming the roles when roles are read below Global", async () => {
      expect(await access({ role: "Local" })).toMatchObject({
        state: "unknown",
        text: "Your own security roles do not grant Write on account. Lite could not check whether you can see all the roles your teams hold. A role a team holds might grant it.",
      });
    });

    it("is ? with no team listed, when the user may not see their teams", async () => {
      expect(await access({ team: "Local" }, [])).toMatchObject({ state: "unknown" });
    });

    it("is the cause with no team at all, whatever the depth on roles", async () => {
      expect(await access({ role: "Basic" }, [])).toMatchObject({ state: "cause", text: "Your security roles do not grant Write on account." });
    });

    // Review round 2, M1: whether the depth is anchored at the user's own
    // unit is not verified (PRIVILEGE_SET_INCLUDES_TEAM_ROLES is "unknown"),
    // so a team in the user's own unit is not taken as reached either.
    it.each([
      ["in the user's unit", MY_UNIT],
      ["in another unit", OTHER_UNIT],
    ])("is ? at Business Unit depth for a team %s, while that is unverified", async (_label, unit) => {
      expect(await access({ role: "Local" }, [team(1, unit)])).toMatchObject({ state: "unknown" });
    });

    it("is the cause for teams in any business unit when roles are read at Global", async () => {
      expect(await access({}, [team(1, OTHER_UNIT)])).toMatchObject({ state: "cause" });
    });

    it("is ? naming both when Lite could not read the depth", async () => {
      expect(await access("fails")).toMatchObject({
        state: "unknown",
        text: "Your own security roles do not grant Write on account. Lite could not check whether you can see all your teams and their roles. A role a team holds might grant it.",
      });
    });

    it("keeps a grant it found, whatever it cannot see", async () => {
      const { server, get } = setup({ team: "Basic", role: "Basic" });
      server.answerWhen(WRITE_PRIVILEGE, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] });
      expect(byTopic(await locked(get), "Your access to the table")).toMatchObject({ state: "ruledOut" });
    });

    // Review M1: a record filter narrows Organization depth.
    it("does not say every record when the Write grant has a record filter", async () => {
      const { server, get } = setup();
      server.answerWhen(WRITE_PRIVILEGE, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "5c4a0000-0000-4000-8000-000000000999" }] });
      server.answerWhen("roleprivilegescollection", { value: [] });
      expect(byTopic(await locked(get), "Your access to the table")).toMatchObject({
        state: "unknown",
        text: "Your security roles grant Write on the account records a record filter selects. Lite does not read whether this record is one of them.",
      });
    });

    // Review round 2, H1: a team role's depth mask carries no record filter.
    describe("a team role's Organization depth", () => {
      const TEAM_ROLE = "5c4a0000-0000-4000-8000-000000000313";
      const WRITE_ACCOUNT = "5c4a0000-0000-4000-8000-000000000298";
      const teamOnly = async (filterable: boolean | undefined) => {
        const { server, get } = setup();
        server.answerWhen("EntityDefinitions(LogicalName='account')?$select=Privileges", {
          Privileges: [{ Name: "prvWriteAccount", PrivilegeType: "Write", PrivilegeId: WRITE_ACCOUNT, ...(filterable === undefined ? {} : { CanBeRecordFilter: filterable }) }],
        });
        server.answerWhen(WRITE_PRIVILEGE, noOwnWrite);
        server.answerWhen("roleprivilegescollection", { value: [{ roleid: TEAM_ROLE, privilegeid: WRITE_ACCOUNT, privilegedepthmask: 8 }] });
        return byTopic(await locked(get), "Your access to the table");
      };

      it("is every record only when the privilege cannot take a record filter", async () => {
        expect(await teamOnly(false)).toMatchObject({ state: "ruledOut", text: "A role you hold through a team grants Write on every account record." });
      });

      it.each([
        ["can take one", true],
        ["does not say", undefined],
      ])("is ? when the privilege %s", async (_label, filterable) => {
        expect(await teamOnly(filterable)).toMatchObject({
          state: "unknown",
          text: "A role you hold through a team grants Write on every account record, unless a record filter narrows it. Lite cannot read a team role's record filter.",
        });
      });
    });

    it("does not say every record when the answer gives no RecordFilterId", async () => {
      const { server, get } = setup();
      server.answerWhen(WRITE_PRIVILEGE, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global" }] });
      server.answerWhen("roleprivilegescollection", { value: [] });
      expect(byTopic(await locked(get), "Your access to the table")).toMatchObject({ state: "unknown" });
    });
  });

  describe("column security", () => {
    const columnLine = async (depths: Depths, permissions: unknown[]) => {
      const { server, get } = setup(depths);
      server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='creditlimit')?$select=IsSecured", { IsSecured: true, IsValidForUpdate: true });
      server.answerWhen("fieldpermissions", { value: permissions });
      return byTopic(await locked(get), "Column security");
    };
    const grant = (profile: string, canupdate: number) => ({ attributelogicalname: "creditlimit", canupdate, _fieldsecurityprofileid_value: profile });

    it("is the cause only when the user reads every team", async () => {
      expect(await columnLine({}, [grant("5c4a0000-0000-4000-8000-000000000203", 0)])).toMatchObject({ state: "cause" });
    });

    it("is ? when no profile grants update and the user sees only some teams", async () => {
      expect(await columnLine({ team: "Local" }, [grant("5c4a0000-0000-4000-8000-000000000203", 0)])).toMatchObject({
        state: "unknown",
        text: "The column is secured, and none of your own profiles grant update. A team you are in might hold System Administrator. You can see only some teams in your organization, so Lite may have missed one you are in.",
      });
    });

    it("is ? when profiles grant update, the user holds none, and the user sees only some teams", async () => {
      const line = await columnLine({ team: "Deep" }, [grant("5c4a0000-0000-4000-8000-000000000203", 4)]);
      expect(line.state).toBe("unknown");
      expect(line.text).toMatch(/^The column is secured, and none of your own profiles grant update\. A team you are in might\. You can see only some teams in your organization, so Lite may have missed one you are in\./);
    });

    // Review M2: column security uses only the teams, so roles read at Business Unit depth do not hedge it.
    it("is the cause when the user reads every team, whatever the depth on roles", async () => {
      expect((await columnLine({ role: "Local" }, [grant("5c4a0000-0000-4000-8000-000000000203", 0)])).state).toBe("cause");
    });
  });
});

describe("the roles of the user's teams", () => {
  const reach = (overrides: Partial<ReadVisibility> = {}): ReadVisibility => ({
    workflows: "all",
    teams: "all",
    roles: "some",
    roleDepth: "Local",
    businessUnitId: MY_UNIT,
    ...overrides,
  });

  it("hides nothing with no team, whatever Lite knows about roles", () => {
    expect(teamRolesHidden(reach({ roles: "unknown", roleDepth: null }), [])).toBeUndefined();
    expect(teamRolesHidden(reach({ roleDepth: "Basic" }), [])).toBeUndefined();
  });

  it("hides nothing when roles are read at Global", () => {
    expect(teamRolesHidden(reach({ roles: "all", roleDepth: "Global" }), [team(1, OTHER_UNIT)])).toBeUndefined();
  });

  it("is unverified today: the switch is unknown", () => {
    expect(PRIVILEGE_SET_INCLUDES_TEAM_ROLES).toBe("unknown");
  });

  describe("while it is unknown whether the user's own answer counts team roles", () => {
    it.each([
      ["Local", MY_UNIT],
      ["Local", OTHER_UNIT],
      ["Deep", MY_UNIT],
    ] as const)("treats %s depth as unknown for a team in %s", (depth, unit) => {
      expect(teamRolesHidden(reach({ roleDepth: depth }), [team(1, unit)], "unknown")).toBe("unknown");
    });

    it("still takes Global as every role", () => {
      expect(teamRolesHidden(reach({ roles: "all", roleDepth: "Global" }), [team(1, OTHER_UNIT)], "unknown")).toBeUndefined();
    });

    it("is the default", () => {
      expect(teamRolesHidden(reach(), [team(1, MY_UNIT)])).toBe("unknown");
    });
  });

  describe("once it is known that the user's own answer does not count team roles", () => {
    it.each([
      ["Local, team in the user's unit", { roleDepth: "Local" as const }, MY_UNIT, undefined],
    ["Deep, team in the user's unit", { roleDepth: "Deep" as const }, MY_UNIT, undefined],
    ["Local, team in another unit", { roleDepth: "Local" as const }, OTHER_UNIT, "some"],
    ["Deep, team in another unit", { roleDepth: "Deep" as const }, OTHER_UNIT, "unknown"],
    ["Basic, which Lite does not rely on", { roleDepth: "Basic" as const }, MY_UNIT, "unknown"],
    ["the team's unit not given", { roleDepth: "Local" as const }, null, "some"],
    ["the user's unit not given", { roleDepth: "Local" as const, businessUnitId: null }, MY_UNIT, "some"],
    ["roles read only through a record filter", { roleDepth: null }, MY_UNIT, "some"],
    ["the depth on roles unknown", { roles: "unknown" as const, roleDepth: null }, MY_UNIT, "unknown"],
  ])("with %s", (_label, overrides, unit, expected) => {
    expect(teamRolesHidden(reach(overrides), [team(1, unit)], false)).toBe(expected);
  });

    it("takes some over unknown across teams", () => {
      expect(teamRolesHidden(reach({ roleDepth: "Deep" }), [team(1, OTHER_UNIT), team(2, null)], false)).toBe("some");
    });

    // Review round 2, L3.
    it("matches business units whatever the case of their GUIDs", () => {
      expect(teamRolesHidden(reach({ businessUnitId: MY_UNIT.toLowerCase() }), [team(1, MY_UNIT.toUpperCase())], false)).toBeUndefined();
    });
  });

  describe("how the switch reaches Why locked?'s Write line", () => {
    const visible = (overrides: Partial<ReadVisibility>) => Promise.resolve(reach(overrides));
    const myTeams = (unit: string) => Promise.resolve(ok([team(1, unit)]));
    const hiddenWith = async (includesTeamRoles: boolean | "unknown", unit: string, overrides: Partial<ReadVisibility> = {}) => {
      const answer = await loadTeamPrivileges(setup().get, myTeams(unit), "5c4a0000-0000-4000-8000-000000000298", visible(overrides), { recordFilterable: false, includesTeamRoles });
      return answer.kind === "ok" ? { hidden: answer.value.hidden, part: answer.value.hiddenPart } : answer;
    };

    it("false: a team in the user's unit at Business Unit depth is reached", async () => {
      expect(await hiddenWith(false, MY_UNIT)).toEqual({ hidden: undefined, part: undefined });
    });

    it("false: a team in another unit is not", async () => {
      expect(await hiddenWith(false, OTHER_UNIT)).toEqual({ hidden: "some", part: "roles" });
    });

    it("unknown: neither is", async () => {
      expect(await hiddenWith("unknown", MY_UNIT)).toEqual({ hidden: "unknown", part: "roles" });
    });

    it("true: nothing a team holds can hide a grant from the user's own answer", async () => {
      expect(await hiddenWith(true, OTHER_UNIT, { teams: "some" })).toEqual({ hidden: undefined, part: undefined });
    });
  });
});

// Review L3: a count from a list read in part is not the whole count.
describe("Fires on change, business rules Lite cannot match", () => {
  it("says the rules it can see, and that there may be more", async () => {
    const { server, get } = setup({ workflow: "Local" });
    server.answerWhen(PROCESSES, { value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000902", name: "Rule", category: 2, type: 1, statecode: 1 }] });
    server.failWhen("RetrieveDependentComponents", 500);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.unknowns).toContain("Could not read whether the 1 active business rule Lite can see uses this column. There may be more.");
  });
});

describe("What changed", () => {
  const changes = (get: ReturnType<typeof setup>["get"]) => loadLiteChanges(get, { table: "account", showTips: true, now: Date.parse("2026-10-30T00:00:00Z") });

  it("says some processes may be missing when the user sees only some", async () => {
    const { get } = setup({ workflow: "Local" });
    const model = await changes(get);
    expect(model.unknowns).toContain(
      "You can see only some classic workflows and business rules. Your security roles do not let you read all of them, so some may be missing.",
    );
  });

  it("never says nothing changed from a list it read in part", async () => {
    const { server, get } = setup({ workflow: "Local" });
    server.answerWhen(STEPS, { value: [] });
    server.answerWhen(PROCESSES, { value: [] });
    server.answerWhen("systemforms?$select=formid,name,type,publishedon", { value: [] });
    expect((await changes(get)).headline).toBe("Of what Lite could read, nothing was modified or published in the last 30 days.");
  });

  it("hedges nothing when the user reads every process", async () => {
    const { get } = setup();
    expect((await changes(get)).unknowns).toEqual([]);
  });
});

describe("the connected checklist's live lines", () => {
  const pathixFacts = { forms: null, security: { secured: true, updateProfiles: [{ id: "5c4a0000-0000-4000-8000-000000000203", name: "Credit" }] } };

  it("reads team visibility live, and does not call a hidden team list a cause", async () => {
    const { server, get } = setup({ team: "Local" });
    server.answerWhen(WRITE_PRIVILEGE, { RolePrivileges: [] });
    server.answerWhen("roleprivilegescollection", { value: [] });
    const facts = await loadUserSecurity(get, "account");
    expect(facts.team).toMatchObject({ kind: "ok", value: { hidden: "some" } });
    expect(facts.teamPrivileges).toMatchObject({ kind: "ok", value: { hidden: "some" } });

    const model = buildConnectedLockedCard({ table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID }, pathixFacts, facts);
    const access = byTopic(model, "Your access to the table");
    expect(access).toMatchObject({
      state: "unknown",
      text: "Your own security roles do not grant Write on account. You can see only some teams in your organization, so this card may have missed one you are in. A role a team holds might grant it.",
    });
    expect(byTopic(model, "Column security").text).toContain("You can see only some teams in your organization, so this card may have missed one you are in.");
  });

  it("names the reader in the unknown case", () => {
    const team = ok({ teamCount: 2, depths: [], hidden: "unknown" as const });
    expect(privilegeLine("account", ok("prvWriteAccount"), ok({ RolePrivileges: [] }), team, "This card").text).toBe(
      "Your own security roles do not grant Write on account. This card could not check whether you can see all your teams and their roles. A role a team holds might grant it.",
    );
  });

  it("leaves the facts unhedged when the user reads every team and role", async () => {
    const { get } = setup();
    const facts: LiveUserFacts = await loadUserSecurity(get, "account");
    expect(facts.team.kind === "ok" && facts.team.value.hidden).toBeFalsy();
    expect(facts.teamPrivileges?.kind === "ok" && facts.teamPrivileges.value.hidden).toBeFalsy();
  });
});

describe("the stand-in fixture", () => {
  it("is marked as hand-written and holds the three read privileges, each once", () => {
    const standIn = fixture<{ _standIn?: string; RolePrivileges: Array<{ PrivilegeName: string; Depth: string }> }>("my-read-privileges");
    expect(standIn._standIn).toMatch(/Hand-written stand-in/);
    expect(standIn.RolePrivileges.map((row) => row.PrivilegeName).sort()).toEqual(["prvReadRole", "prvReadTeam", "prvReadWorkflow"]);
  });
});
