// "Why can't I edit this field?" on the connected card: the form and column
// security from Pathix's scan, the signed-in user's own state live.

import { describe, expect, it } from "vitest";
import {
  buildConnectedLockedCard,
  CONNECTED_LOCKED_STATUS,
  lockedFactsFrom,
  type LiveUserFacts,
  type LockedPathixFacts,
} from "../src/card/locked-connected";
import { SYSTEM_ADMINISTRATOR_PROFILE, type CheckLine, type LockedCardModel } from "../src/card/locked";
import { createDataverseClient } from "../src/dataverse/client";
import { loadUserSecurity } from "../src/lite/user-security";
import type { FieldDependents, FormControlSummary } from "../src/pathix/api";
import { fakeDataverse, ORIGIN } from "./fake-dataverse";

const FORM = "5c4a0000-0000-4000-8000-000000000021";
const CREDIT_TEAM = "5c4a0000-0000-4000-8000-000000000205";
const OTHER_FORM = "5c4a0000-0000-4000-8000-000000000022";
const context = { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM };

function control(controlId: string | null, overrides: Partial<FormControlSummary> = {}): FormControlSummary {
  return { controlId, locked: false, hidden: false, location: "body", embed: null, ...overrides };
}

function pathix(overrides: Partial<LockedPathixFacts> = {}): LockedPathixFacts {
  return {
    forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit")] }],
    security: { secured: false, updateProfiles: [] },
    ...overrides,
  };
}

const ok = <T>(value: T) => ({ kind: "ok" as const, value });

function user(overrides: Partial<LiveUserFacts> = {}): LiveUserFacts {
  return {
    writePrivilege: ok("prvWriteAccount"),
    privileges: ok({ RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] }),
    teamPrivileges: ok({ teamCount: 0, depths: [] }),
    mine: ok([]),
    team: ok({ teamCount: 0, profileIds: [] }),
    ...overrides,
  };
}

function line(model: LockedCardModel, topic: string): CheckLine {
  const found = model.lines.find((entry) => entry.topic === topic);
  if (!found) throw new Error(`no line ${topic}`);
  return found;
}

const build = (facts: LockedPathixFacts = pathix(), live: LiveUserFacts | null = user(), overrides = {}) =>
  buildConnectedLockedCard({ ...context, ...overrides }, facts, live);

describe("the form line, from Pathix's scan", () => {
  it("rules out a control the scan does not show read-only", () => {
    expect(line(build(), "The form")).toMatchObject({ state: "ruledOut", text: "The scan of Account does not show this control read-only." });
  });

  it("is the cause when the scan shows the control read-only", () => {
    const facts = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit", { locked: true })] }] });
    expect(line(build(facts), "The form")).toMatchObject({ state: "cause", text: "The scan of Account shows this control read-only." });
  });

  it("names a quick view or form component control as the cause, in the form's own terms", () => {
    const quick = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit", { locked: true, embed: "quickView" })] }] });
    expect(line(build(quick), "The form").text).toContain("shows this control as a quick view");
    const component = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit", { locked: true, embed: "formComponent" })] }] });
    expect(line(build(component), "The form").text).toContain("shows this control as a form component");
  });

  it("matches the hovered control by id, among a column's several controls", () => {
    const facts = pathix({
      forms: [
        {
          formId: FORM,
          name: "Account",
          controls: [control("header_creditlimit", { locked: true, location: "header" }), control("creditlimit"), control("creditlimit1", { locked: true })],
        },
      ],
    });
    expect(line(build(facts, user(), { control: "creditlimit" }), "The form").state).toBe("ruledOut");
    expect(line(build(facts, user(), { control: "header_creditlimit" }), "The form").state).toBe("cause");
    expect(line(build(facts, user(), { control: "creditlimit1" }), "The form").state).toBe("cause");
  });

  it("is unknown for a control missing from the list, and never takes the form's own answer for it", () => {
    // Every listed control is locked, so a form-level fold would say "read-only"; the unlisted one is unknown.
    const facts = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit", { locked: true })] }] });
    const result = line(build(facts, user(), { control: "header_process_creditlimit" }), "The form");
    expect(result.state).toBe("unknown");
    expect(result.text).toBe(
      "Pathix does not list a control named header_process_creditlimit on Account. The form may have changed since the scan, or the control may sit somewhere Pathix does not read, such as the process header.",
    );
  });

  it("finds the second copy of a repeated formxml id, the way the page names it", () => {
    // The live Account form lists parentaccountid twice with the SAME id (the second hosts a form
    // component); the page names the second copy "parentaccountid1". Pathix keeps formxml order.
    const facts = pathix({
      forms: [
        {
          formId: FORM,
          name: "Account",
          controls: [control("parentaccountid"), control("parentaccountid", { locked: true, embed: "formComponent" })],
        },
      ],
    });
    expect(line(build(facts, user(), { control: "parentaccountid" }), "The form").state).toBe("ruledOut");
    const second = line(build(facts, user(), { control: "parentaccountid1" }), "The form");
    expect(second.state).toBe("cause");
    expect(second.text).toContain("form component");
    // Two copies only: a third name is not listed.
    expect(line(build(facts, user(), { control: "parentaccountid2" }), "The form").state).toBe("unknown");
  });

  it("finds the second copy of an id that ends in a digit, which the page names with another digit", () => {
    // The live contact form lists emailaddress1 twice with the same id; the page names the second "emailaddress11".
    const facts = pathix({
      forms: [
        {
          formId: FORM,
          name: "Contact",
          controls: [control("emailaddress1"), control("emailaddress1", { locked: true })],
        },
      ],
    });
    expect(line(build(facts, user(), { control: "emailaddress1" }), "The form").state).toBe("ruledOut");
    expect(line(build(facts, user(), { control: "emailaddress11" }), "The form").state).toBe("cause");
    // Only two copies, and no id "emailaddress": a third name is unknown, never a wrong answer.
    expect(line(build(facts, user(), { control: "emailaddress12" }), "The form").state).toBe("unknown");
  });

  it("prefers an exact id over the numbered reading", () => {
    const facts = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("address1"), control("address", { locked: true })] }] });
    expect(line(build(facts, user(), { control: "address1" }), "The form").state).toBe("ruledOut");
  });

  it("does not match a control id by case or by prefix", () => {
    const facts = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("CreditLimit", { locked: true })] }] });
    expect(line(build(facts), "The form").state).toBe("unknown");
  });

  it("is unknown when Pathix has no read of the column on the open form", () => {
    const facts = pathix({ forms: [{ formId: OTHER_FORM, name: "Other", controls: [control("creditlimit", { locked: true })] }] });
    expect(line(build(facts), "The form")).toMatchObject({
      state: "unknown",
      text: "Pathix has no read of this column on the open form. The form may be newer than its latest scan.",
    });
  });

  it("is unknown when the form's controls were not kept", () => {
    const facts = pathix({ forms: [{ formId: FORM, name: "Account", controls: null }] });
    expect(line(build(facts), "The form")).toMatchObject({ state: "unknown", text: "Pathix did not keep the controls of Account." });
  });

  it("is unknown when the page did not say which form is open, or the forms could not be read", () => {
    expect(line(build(pathix(), user(), { formId: null }), "The form").text).toBe("The page did not say which form is open.");
    expect(line(build(pathix({ forms: null })), "The form").state).toBe("unknown");
  });

  it("compares form ids without regard to case", () => {
    expect(line(build(pathix(), user(), { formId: FORM.toUpperCase() }), "The form").state).toBe("ruledOut");
  });
});

describe("lockedFactsFrom", () => {
  const dependents = (results: FieldDependents["results"]): FieldDependents => ({ results });
  const formRow = (overrides: Partial<FieldDependents["results"][number]> = {}) => ({
    componentId: "row-1",
    componentName: "Account",
    componentType: "Form",
    confidence: "Declared",
    referenceKind: "Display",
    sourceId: FORM.toUpperCase(),
    formControls: [control("creditlimit")],
    ...overrides,
  });

  it("keeps a form's Display row, with its form id lower-cased", () => {
    const facts = lockedFactsFrom(dependents([formRow(), { componentId: "p", componentType: "PluginStep", confidence: "Parsed" }]), null);
    expect(facts.forms).toEqual([{ formId: FORM, name: "Account", controls: [control("creditlimit")] }]);
  });

  it("ignores a form row that is not a Display read, and a row that is not a form", () => {
    const facts = lockedFactsFrom(dependents([formRow({ referenceKind: "Filter" }), formRow({ componentType: "SavedQuery" })]), null);
    expect(facts.forms).toEqual([]);
  });

  it("reads controls as unknown on a row from an older Pathix, which sends none", () => {
    const { formControls: _unused, referenceKind: _kind, ...old } = formRow();
    expect(lockedFactsFrom(dependents([old]), null).forms).toEqual([{ formId: FORM, name: "Account", controls: null }]);
  });

  it("is unknown, not empty, when the dependents could not be read", () => {
    expect(lockedFactsFrom(null, null).forms).toBeNull();
  });

  it("lists the profiles that grant update, and is unknown when the permissions could not be read", () => {
    const permissions = {
      isSecured: true,
      grants: [
        { profileId: CREDIT_TEAM, profileName: "Credit team", canUpdate: true, userCount: 2, teamCount: 0 },
        { profileId: "5c4a0000-0000-4000-8000-000000000299", profileName: "Readers", canUpdate: false, userCount: 9, teamCount: 1 },
      ],
    };
    expect(lockedFactsFrom(null, permissions).security).toEqual({ secured: true, updateProfiles: [{ id: CREDIT_TEAM, name: "Credit team" }], sharedWith: null, sharingIncomplete: false });
    expect(lockedFactsFrom(null, { ...permissions, sharePrincipalCount: 0, shareRecordCount: 0 }).security?.sharedWith).toBe(0);
    expect(lockedFactsFrom(null, { ...permissions, sharePrincipalCount: 3, shareRecordCount: 5 }).security?.sharedWith).toBe(3);
    // Only an explicit true says the counts are a floor (a current Pathix sets it on every secured column).
    expect(lockedFactsFrom(null, { ...permissions, sharePrincipalCount: 3, shareCoverageIncomplete: true }).security?.sharingIncomplete).toBe(true);
    expect(lockedFactsFrom(null, { ...permissions, sharePrincipalCount: 3, shareCoverageIncomplete: false }).security?.sharingIncomplete).toBe(false);
    expect(lockedFactsFrom(null, null).security).toBeNull();
  });
});

describe("column security, from Pathix's grants and the user's own profiles", () => {
  // The grants carry the profile's id, which is what matches; the names only show.
  const ids: Record<string, string> = {
    "Credit team": CREDIT_TEAM,
    Auditors: "5c4a0000-0000-4000-8000-000000000207",
    A: "5c4a0000-0000-4000-8000-000000000208",
  };
  /** A secured column. `sharedWith` is what Pathix found of per-record sharing: 0 by default, "none found". */
  const secured = (names: string[], sharedWith: number | null = 0, sharingIncomplete = false) =>
    pathix({ security: { secured: true, updateProfiles: names.map((name) => ({ id: ids[name]!, name })), sharedWith, sharingIncomplete } });
  const profile = (name: string, id = "5c4a0000-0000-4000-8000-000000000203") => ({ fieldsecurityprofileid: id, name });

  it("rules out a column that is not secured", () => {
    expect(line(build(), "Column security")).toMatchObject({ state: "ruledOut", text: "The column is not secured." });
  });

  it("rules out a column when a profile the user holds grants update, matched by id", () => {
    const result = line(build(secured(["Credit team"]), user({ mine: ok([profile("Credit team", CREDIT_TEAM.toUpperCase())]) })), "Column security");
    expect(result).toMatchObject({ state: "ruledOut", live: true, names: ["Credit team"] });
    expect(result.text).toBe("The column is secured, and a profile you hold grants update.");
  });

  it("still matches a profile that was renamed after the scan, because the id is the same", () => {
    const renamed = user({ mine: ok([profile("Sales Leads", CREDIT_TEAM)]) });
    const result = line(build(secured(["Credit team"]), renamed), "Column security");
    expect(result).toMatchObject({ state: "ruledOut", names: ["Credit team"] });
  });

  it("does not match a different profile that happens to share the name", () => {
    // The user holds a profile named "Credit team" with another id; the one that grants update is not theirs.
    const sameName = user({ mine: ok([profile("Credit team", "5c4a0000-0000-4000-8000-000000000999")]) });
    const result = line(build(secured(["Credit team"]), sameName), "Column security");
    expect(result).toMatchObject({ state: "unknown", names: ["Credit team"] });
    expect(result.text).toContain("you hold none of them");
  });

  it("counts a profile a team holds by id", () => {
    const team = ok({ teamCount: 1, profileIds: [CREDIT_TEAM] });
    expect(line(build(secured(["Credit team"]), user({ team })), "Column security").state).toBe("ruledOut");
  });

  it("rules out a holder of the System Administrator profile, by id, yourself or through a team", () => {
    const own = user({ mine: ok([profile("System Administrator", SYSTEM_ADMINISTRATOR_PROFILE)]) });
    expect(line(build(secured(["Credit team"]), own), "Column security").text).toContain("You hold the System Administrator profile, which");
    const viaTeam = user({ team: ok({ teamCount: 1, profileIds: [SYSTEM_ADMINISTRATOR_PROFILE] }) });
    expect(line(build(secured(["Credit team"]), viaTeam), "Column security").text).toContain("through a team");
  });

  // Review round 1: a share count of 0 is also what a capped read and an older
  // scan answer, so it never makes the line a cause. The line says what Pathix found.
  it("is unknown when profiles grant update and the user holds none of them, since records can share the column", () => {
    const result = line(build(secured(["Credit team", "Auditors"]), user({ mine: ok([profile("Someone else")]) })), "Column security");
    expect(result).toMatchObject({ state: "unknown", live: true, names: ["Auditors", "Credit team"] });
  });

  it("is unknown when no profile grants update and Pathix found no sharing, and says that is not proof", () => {
    expect(line(build(secured([])), "Column security")).toMatchObject({
      state: "unknown",
      text: "The column is secured. No column security profile grants update. Records can still share the column. Pathix did not find sharing for this column. That does not prove there is none.",
    });
  });

  it("is never a cause, whatever the share count", () => {
    for (const sharedWith of [0, 1, null]) {
      expect(line(build(secured([], sharedWith)), "Column security").state).toBe("unknown");
      expect(line(build(secured(["Credit team"], sharedWith), user({ mine: ok([profile("Someone else")]) })), "Column security").state).toBe("unknown");
    }
  });

  // Item 14: per-record field sharing bypasses profiles, so "only system
  // administrators can update it" was never something the card could know.
  it("is unknown when no profile grants update and sharing is not known, or was found", () => {
    expect(line(build(secured([], null)), "Column security")).toMatchObject({
      state: "unknown",
      text: "The column is secured. No column security profile grants update. Records can still share the column.",
    });
    expect(line(build(secured([], 2)), "Column security")).toMatchObject({
      state: "unknown",
      text: "The column is secured. No column security profile grants update. Records can still share the column, and Pathix found it shared with 2 principals.",
    });
    const user1 = user({ mine: ok([profile("Someone else")]) });
    expect(line(build(secured(["Credit team"], null), user1), "Column security").state).toBe("unknown");
  });

  // shareCoverageIncomplete makes the count a floor and 0 not measured. A
  // current Pathix sets it on every secured column, because the scanner sees
  // few or none of the shares, so the note names that limit.
  it("says at least, when the counts are incomplete and Pathix found some", () => {
    expect(line(build(secured([], 2, true)), "Column security")).toMatchObject({
      state: "unknown",
      text: "The column is secured. No column security profile grants update. Records can still share the column. Pathix found it shared with at least 2 principals. Dataverse shows Pathix's scanner few or none of a column's record shares, so there may be more.",
    });
    expect(line(build(secured([], 1, true)), "Column security").text).toContain("at least 1 principal.");
  });

  it("says sharing was not measured, never that none was found, when the counts are incomplete", () => {
    for (const sharedWith of [0, null]) {
      const result = line(build(secured([], sharedWith, true)), "Column security");
      expect(result).toMatchObject({
        state: "unknown",
        text: "The column is secured. No column security profile grants update. Records can still share the column. Dataverse shows Pathix's scanner few or none of a column's record shares, so Pathix cannot say whether this column is shared.",
      });
      expect(result.text).not.toMatch(/did not find/);
    }
    const holdsNone = line(build(secured(["Credit team"], 0, true), user({ mine: ok([profile("Someone else")]) })), "Column security");
    expect(holdsNone).toMatchObject({
      state: "unknown",
      text: "The column is secured. Profiles grant update, but you hold none of them, yourself or through a team. Records can still share the column. Dataverse shows Pathix's scanner few or none of a column's record shares, so Pathix cannot say whether this column is shared. Profiles that grant update:",
    });
  });

  // The flag is a standing limit, not a scan failure, so the note never says the scan fell short.
  it("never says the scan failed to read sharing when the counts are incomplete", () => {
    for (const sharedWith of [0, 1, 2, null]) {
      const text = line(build(secured([], sharedWith, true)), "Column security").text;
      expect(text).not.toMatch(/could not read|in its scan|came back short/i);
      expect(text).toContain("scanner few or none");
    }
  });

  it("never says only system administrators can update it", () => {
    for (const sharedWith of [0, 1, null]) {
      expect(line(build(secured([], sharedWith)), "Column security").text).not.toMatch(/only system administrators/i);
    }
  });

  it("cannot rule it out when the user's own profiles could not be read, and says why", () => {
    const result = line(build(secured(["Credit team"]), user({ mine: { kind: "forbidden" } })), "Column security");
    expect(result.state).toBe("unknown");
    expect(result.text).toContain("You don't have access to your column security profiles.");
  });

  it("cannot call it a cause when the user's teams could not be read, since a team might hold System Administrator", () => {
    const result = line(build(secured([]), user({ team: { kind: "failed" } })), "Column security");
    expect(result.state).toBe("unknown");
    expect(result.text).toContain("A team you are in might hold System Administrator.");
  });

  it("keeps a match it did read when something else could not be read", () => {
    const result = line(build(secured(["Credit team"]), user({ mine: ok([profile("Credit team", CREDIT_TEAM)]), team: { kind: "failed" } })), "Column security");
    expect(result.state).toBe("ruledOut");
  });

  it("is unknown when Pathix could not give the column's security, and when the live read did not run", () => {
    expect(line(build(pathix({ security: null })), "Column security").state).toBe("unknown");
    expect(line(build(secured(["Credit team"]), null), "Column security")).toMatchObject({ state: "unknown", live: true });
  });

  it("never treats a secured column as unsecured when Pathix could not answer", () => {
    expect(line(build(pathix({ security: null })), "Column security").text).not.toMatch(/not secured/);
  });
});

describe("your access, live", () => {
  it("is read from the user's own state and labelled live", () => {
    expect(line(build(), "Your access to the table")).toMatchObject({
      state: "ruledOut",
      live: true,
      text: "Your security roles grant Write on every account record.",
    });
  });

  it("is the cause when the user's roles grant no Write", () => {
    const none = user({ privileges: ok({ RolePrivileges: [] }) });
    expect(line(build(pathix(), none), "Your access to the table").state).toBe("cause");
  });

  it("speaks as the card, never as Lite", () => {
    const depth = user({ privileges: ok({ RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Local" }] }) });
    const text = line(build(pathix(), depth), "Your access to the table").text;
    expect(text).toBe("Your security roles grant Write on records in your business unit. This card does not read who owns this record.");
  });

  it("is unknown when the live read did not run", () => {
    expect(line(build(pathix(), null), "Your access to the table")).toMatchObject({ state: "unknown", live: true, text: "Could not read your access to the table." });
  });
});

describe("the whole checklist", () => {
  it("shows every line in order, naming what it does not check", () => {
    const model = build();
    expect(model.lines.map((entry) => entry.topic)).toEqual([
      "The form",
      "Column security",
      "Your access to the table",
      "Business rules and form scripts",
      "The platform",
      "The record",
    ]);
    expect(model.lines.slice(3).every((entry) => entry.state === "unknown" && !entry.live)).toBe(true);
    expect(model.status).toBe(CONNECTED_LOCKED_STATUS);
  });

  it("labels only the user's own state live", () => {
    const live = (model: LockedCardModel) => model.lines.filter((entry) => entry.live).map((entry) => entry.topic);
    // A column that is not secured is a fact about the column, from the scan.
    expect(live(build())).toEqual(["Your access to the table"]);
    expect(live(build(pathix({ security: { secured: true, updateProfiles: [] } })))).toEqual(["Column security", "Your access to the table"]);
  });

  it("counts the causes and the things it cannot check", () => {
    const locked = pathix({ forms: [{ formId: FORM, name: "Account", controls: [control("creditlimit", { locked: true })] }] });
    expect(build(locked).headline).toBe("Found 1 likely cause. 3 things it cannot check are marked ?.");
    expect(build().headline).toBe("Everything this card can read is ruled out. 3 things it cannot check are marked ?.");
  });

  it("makes no Lite claim and uses no em dash", () => {
    const text = JSON.stringify(build(pathix({ security: { secured: true, updateProfiles: [{ id: "5c4a0000-0000-4000-8000-000000000208", name: "A" }] } }), user({ privileges: ok({ RolePrivileges: [] }) })));
    expect(text).not.toMatch(/Lite/);
    expect(text).not.toContain("—");
  });

  it("is unknown across the live lines, and still answers the form, when nothing live could be read", () => {
    const model = build(pathix({ security: { secured: true, updateProfiles: [{ id: "5c4a0000-0000-4000-8000-000000000208", name: "A" }] } }), null);
    expect(model.lines.map((entry) => entry.state)).toEqual(["ruledOut", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });
});

describe("loadUserSecurity", () => {
  function setup() {
    const server = fakeDataverse();
    return { server, get: createDataverseClient(ORIGIN, server.fetch) };
  }

  it("reads the user's own profiles, teams and access, from the fixtures", async () => {
    const { get } = setup();
    const facts = await loadUserSecurity(get, "account");
    expect(facts.writePrivilege).toEqual(ok("prvWriteAccount"));
    expect(facts.privileges?.kind).toBe("ok");
    expect(facts.mine.kind).toBe("ok");
    // Captured from a test environment: the user is in 8 teams, and none holds a column security profile.
    expect(facts.team).toEqual(ok({ teamCount: 8, profileIds: [] }));
  });

  it("asks only about the user and the table: no form, no business rule, no attribute definition", async () => {
    const { server, get } = setup();
    await loadUserSecurity(get, "account");
    const asked = server.requests.map(decodeURIComponent).join("\n");
    expect(asked).not.toMatch(/systemforms|workflows|Attributes\(|RetrieveDependentComponents|fieldpermissions/);
  });

  it("never reads the org's profile list, even when a team holds a profile", async () => {
    const { server, get } = setup();
    server.answerWhen("teamprofilescollection", { value: [{ teamid: "5c4a0000-0000-4000-8000-000000000304", fieldsecurityprofileid: "5c4a0000-0000-4000-8000-000000000205" }] });
    const facts = await loadUserSecurity(get, "account");
    expect(facts.team).toEqual(ok({ teamCount: 8, profileIds: ["5c4a0000-0000-4000-8000-000000000205"] }));
    expect(server.requests.map(decodeURIComponent).filter((url) => url.includes("fieldsecurityprofiles?")).length).toBe(0);
  });

  it("keeps each failure apart, as unknown", async () => {
    const { server, get } = setup();
    server.failWhen("systemusers", 403);
    server.failWhen("teams", 500);
    const facts = await loadUserSecurity(get, "account");
    expect(facts.mine.kind).not.toBe("ok");
    expect(facts.team.kind).not.toBe("ok");
  });

  it("makes the same requests whether the column is secured or not, since Pathix says which it is", async () => {
    const a = setup();
    const b = setup();
    await loadUserSecurity(a.get, "account");
    b.server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes", { IsSecured: true });
    await loadUserSecurity(b.get, "account");
    expect(a.server.requests).toEqual(b.server.requests);
  });
});
