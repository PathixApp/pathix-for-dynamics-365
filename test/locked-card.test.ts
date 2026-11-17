// "Why can't I edit this field?" (M3), built from the real fixtures in
// contract/dataverse/ through the fake Dataverse.

import { describe, expect, it } from "vitest";
import { PATHIX_SITE } from "../src/card/lite";
import {
  CHECK_MARKS,
  findControl,
  LOCKED_TIP,
  LOCKED_TITLE,
  parseFormXml,
  SYSTEM_ADMINISTRATOR_PROFILE,
  type CheckLine,
  type LockedCardModel,
} from "../src/card/locked";
import { createDataverseClient } from "../src/dataverse/client";
import { loadLockedCard } from "../src/lite/locked";
import { fakeDataverse, fixture, ORIGIN } from "./fake-dataverse";

const FORM_ID = "5c4a0000-0000-4000-8000-000000000021";
const USER = "systemusers(5c4a0000-0000-4000-8000-000000000002)";
const PROCESSES = "workflows?$select=workflowid,name,category,mode,type";
// The table's Write privilege. The read privileges (src/lite/visibility.ts) go through the same function, asked for prvRead names.
const PRIVILEGES = `${USER}/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvWrite`;
const READ_PRIVILEGES = `${USER}/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p1)?@p1=['prvRead`;
const MY_TEAMS = `${USER}/teammembership_association`;
// The user's teams in contract/dataverse/my-teams.json (captured from a test environment),
// in the order Dataverse listed them, and the roles they hold. The role
// TEAM_ROLE (held by the team TEAM) grants Write on account at depth mask 4
// in role-write-privilege-account.json.
const TEAMS = fixture<{ value: Array<{ teamid: string }> }>("my-teams").value.map((team) => team.teamid);
const TEAM_ROLES = fixture<{ value: Array<{ roleid: string }> }>("team-roles").value.map((row) => row.roleid);
const TEAM = "5c4a0000-0000-4000-8000-000000000304";
const TEAM_ROLE = "5c4a0000-0000-4000-8000-000000000313";
const WRITE_ACCOUNT = "5c4a0000-0000-4000-8000-000000000298";

function setup() {
  const server = fakeDataverse();
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

async function locked(
  column: string,
  options: { control?: string; formId?: string | null; showTips?: boolean; server?: ReturnType<typeof setup> } = {},
): Promise<LockedCardModel> {
  const { get } = options.server ?? setup();
  return loadLockedCard(get, {
    table: "account",
    column,
    control: options.control ?? column,
    formId: options.formId === undefined ? FORM_ID : options.formId,
    showTips: options.showTips ?? true,
  });
}

function byTopic(model: LockedCardModel, topic: string): CheckLine {
  const found = model.lines.find((line) => line.topic === topic);
  if (!found) throw new Error(`no line ${topic}`);
  return found;
}

const TOPICS = ["The platform", "Column security", "The form", "Business rules", "Your access to the table", "Form scripts", "The record"];

function securedColumn(server: ReturnType<typeof setup>["server"]) {
  server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='creditlimit')?$select=IsSecured", {
    IsSecured: true,
    IsValidForUpdate: true,
  });
}

function permission(profile: string, canupdate: number, column = "creditlimit") {
  return { attributelogicalname: column, canupdate, _fieldsecurityprofileid_value: profile };
}

describe("the checklist, from the fixtures", () => {
  it("finds the form definition setting a control read-only", async () => {
    const model = await locked("pathix_legalofficer");
    expect(model.title).toBe(LOCKED_TITLE);
    expect(byTopic(model, "The form")).toMatchObject({ state: "cause", text: "The definition of Account sets this control read-only." });
  });

  it("rules out what it can read for creditlimit and marks the rest", async () => {
    const model = await locked("creditlimit");
    expect(model.lines.map((line) => `${CHECK_MARKS[line.state]} ${line.topic}`)).toEqual([
      "✓ The platform",
      "✓ Column security",
      "✓ The form",
      "✓ Business rules",
      "✓ Your access to the table",
      "? Form scripts",
      "? The record",
    ]);
    expect(model.headline).toBe("Lite ruled out everything it can read. 2 things it cannot check are marked ?.");
    expect(byTopic(model, "Your access to the table").text).toBe("Your security roles grant Write on every account record.");
  });

  it("names the OnLoad scripts that might lock it, and never claims they do", async () => {
    const line = byTopic(await locked("creditlimit"), "Form scripts");
    expect(line.state).toBe("unknown");
    expect(line.text).toMatch(/might lock it/);
    expect(line.names).toEqual(["OnLoad: AppCommon.Account.Instance.ra_onload in AppCommon/Account/Account_main_system_library.js (internal handler)"]);
    expect(line.text).toBe("These form scripts might lock it. 2 more handlers run on other events: setadditionalparams, OnSave. Lite cannot read what they do.");
  });

  it("always shows every line, in order", async () => {
    const { server } = { server: setup() };
    server.server.failWhen("", 500);
    const model = await locked("creditlimit", { server });
    expect(model.lines.map((line) => line.topic)).toEqual(TOPICS);
    expect(model.lines.every((line) => line.state === "unknown")).toBe(true);
    expect(model.headline).toBe("Lite ruled out everything it can read. 7 things it cannot check are marked ?.");
  });
});

describe("the platform", () => {
  it("is the cause when Dataverse does not allow updates to the column", async () => {
    const { server, get } = setup();
    server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='creditlimit')?$select=IsSecured", {
      IsSecured: false,
      IsValidForUpdate: false,
    });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "The platform").state).toBe("cause");
    expect(model.headline).toMatch(/^Lite found 1 likely cause\./);
  });
});

describe("a definition that does not say", () => {
  it.each([
    ["IsValidForUpdate", "The platform", "This column's definition does not say whether Dataverse allows updates to it."],
    ["IsSecured", "Column security", "This column's definition does not say whether the column is secured."],
  ])("marks %s: null as ?, never ✓", async (property, topic, text) => {
    const { server, get } = setup();
    server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes(LogicalName='creditlimit')?$select=IsSecured", {
      IsSecured: false,
      IsValidForUpdate: true,
      [property]: null,
    });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, topic)).toMatchObject({ state: "unknown", text });
  });
});

describe("column security", () => {
  it("rules out a column the user's own profile can update, and names the profile", async () => {
    const { server, get } = setup();
    securedColumn(server);
    server.answerWhen("fieldpermissions", { value: [permission("5c4a0000-0000-4000-8000-000000000203", 4)] });
    server.answerWhen(`${USER}/systemuserprofiles_association`, {
      value: [{ fieldsecurityprofileid: "5c4a0000-0000-4000-8000-000000000203", name: "sim Bank Ops" }],
    });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Column security")).toMatchObject({ state: "ruledOut", names: ["sim Bank Ops"] });
  });

  it("rules out a column for a holder of the System Administrator profile", async () => {
    const { server, get } = setup();
    securedColumn(server);
    server.answerWhen(`${USER}/systemuserprofiles_association`, { value: [{ fieldsecurityprofileid: SYSTEM_ADMINISTRATOR_PROFILE, name: "System Administrator" }] });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Column security").state).toBe("ruledOut");
  });

  it("is the cause when no profile grants update on the column", async () => {
    const { server, get } = setup();
    securedColumn(server);
    server.answerWhen("fieldpermissions", { value: [permission("5c4a0000-0000-4000-8000-000000000203", 0), permission("5c4a0000-0000-4000-8000-000000000204", 4, "telephone1")] });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Column security")).toMatchObject({ state: "cause", text: "The column is secured, and no column security profile grants update on it." });
  });

  it("cannot tell when another profile grants update and the user's teams could not be read, and names who grants it", async () => {
    const { server, get } = setup();
    securedColumn(server);
    server.failWhen(MY_TEAMS, 500);
    server.answerWhen("fieldpermissions", { value: [permission("5c4a0000-0000-4000-8000-000000000203", 4), permission("5c4a0000-0000-4000-8000-000000000204", 4)] });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    // The fixture user holds only a profile named System Administrator, under a
    // scrubbed id: Lite does not trust the name, so it cannot rule this out.
    expect(byTopic(model, "Column security")).toMatchObject({ state: "unknown", names: ["sim Bank Ops", "sim Permit Staff"] });
    expect(byTopic(model, "Column security").text).toMatch(/A team you are in might\. Could not read your teams' column security profiles\./);
  });

  it.each([
    ["systemuserprofiles_association", 403, "You don't have access to your column security profiles."],
    ["fieldpermissions", 403, "You don't have access to column security permissions."],
    ["fieldpermissions", 500, "Could not read column security permissions."],
  ])("says so when %s answers %i", async (prefix, status, text) => {
    const { server, get } = setup();
    securedColumn(server);
    server.failWhen(prefix === "systemuserprofiles_association" ? `${USER}/${prefix}` : prefix, status);
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Column security")).toMatchObject({ state: "unknown", text: `The column is secured. ${text}` });
  });

  it("treats a second page of permissions as unread, never as no grant", async () => {
    const { server, get } = setup();
    securedColumn(server);
    server.answerWhen("fieldpermissions", { value: [], "@odata.nextLink": "next" });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Column security").state).toBe("unknown");
  });

  it("reads column security only for a secured column", async () => {
    const { server, get } = setup();
    await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(server.requests.some((url) => /fieldpermissions|fieldsecurityprofiles|systemuserprofiles|teamprofilescollection/.test(url))).toBe(false);
  });
});

describe("the form", () => {
  it("says so when the page gave no form id", async () => {
    const model = await locked("creditlimit", { formId: null });
    expect(byTopic(model, "The form")).toMatchObject({ state: "unknown", text: "The page did not say which form is open." });
    expect(byTopic(model, "Form scripts").state).toBe("unknown");
  });

  it("says you don't have access to form definitions, on both form lines", async () => {
    const { server } = { server: setup() };
    server.server.failWhen("systemforms", 403);
    const model = await locked("creditlimit", { server });
    expect(byTopic(model, "The form").text).toBe("You don't have access to form definitions.");
    expect(byTopic(model, "Form scripts").text).toBe("You don't have access to form definitions.");
  });

  it("cannot tell for a control it does not find", async () => {
    const model = await locked("creditlimit", { control: "header_creditlimit" });
    expect(byTopic(model, "The form")).toMatchObject({ state: "unknown", text: "Lite could not find this control in the definition of Account." });
  });

  it("finds the second copy of a column the page names with a number", () => {
    const controls = [
      { id: "pathix_legalofficer", column: "pathix_legalofficer", disabled: true, embed: null },
      { id: "pathix_legalofficer", column: "pathix_legalofficer", disabled: false, embed: null },
    ];
    expect(findControl(controls, "pathix_legalofficer")?.disabled).toBe(true);
    expect(findControl(controls, "pathix_legalofficer1")?.disabled).toBe(false);
    expect(findControl(controls, "pathix_legalofficer2")).toBeNull();
    expect(findControl(controls, "telephone1")).toBeNull();
  });

  it("finds the second copy of an id that ends in a digit", () => {
    const controls = [
      { id: "emailaddress1", column: "emailaddress1", disabled: false, embed: null },
      { id: "emailaddress1", column: "emailaddress1", disabled: true, embed: null },
    ];
    expect(findControl(controls, "emailaddress1")?.disabled).toBe(false);
    expect(findControl(controls, "emailaddress11")?.disabled).toBe(true);
    expect(findControl(controls, "emailaddress12")).toBeNull();
  });
});

describe("business rules", () => {
  it("names an active business rule that uses the column, and cannot say whether it locks it", async () => {
    const { server, get } = setup();
    const rule = { workflowid: "5c4a0000-0000-4000-8000-000000000990", name: "Lock credit limit", category: 2, type: 1, statecode: 1, _parentworkflowid_value: null };
    server.answerWhen(PROCESSES, { value: [rule] });
    server.answerWhen("RetrieveDependentComponents", {
      value: [{ dependentcomponenttype: 29, dependentcomponentobjectid: rule.workflowid, dependentcomponentparentid: "00000000-0000-0000-0000-000000000000", dependencytype: 2 }],
    });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Business rules")).toMatchObject({
      state: "unknown",
      text: "1 active business rule uses this column. Lite cannot read whether it locks it.",
      names: ["Lock credit limit"],
    });
  });

  it("rules out the table's active rules when none uses the column", async () => {
    const { server, get } = setup();
    server.answerWhen(PROCESSES, { value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000991", name: "Other", category: 2, type: 1, statecode: 1 }] });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Business rules")).toMatchObject({ state: "ruledOut", text: "No active business rule uses this column." });
  });

  it("cannot rule out business rules from a read with more pages", async () => {
    const { server, get } = setup();
    server.answerWhen(PROCESSES, {
      value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000993", name: "Other", category: 2, type: 1, statecode: 1 }],
      "@odata.nextLink": "next",
    });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Business rules")).toMatchObject({
      state: "unknown",
      text: "Lite could not read every page of processes Dataverse returned, so it could not check them all.",
    });
  });

  it("cannot tell when dependency tracking fails", async () => {
    const { server, get } = setup();
    server.answerWhen(PROCESSES, { value: [{ workflowid: "5c4a0000-0000-4000-8000-000000000992", name: "Other", category: 2, type: 1, statecode: 1 }] });
    server.failWhen("RetrieveDependentComponents", 500);
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Business rules").state).toBe("unknown");
  });

  it("says you don't have access to business rules", async () => {
    const { server } = { server: setup() };
    server.server.failWhen("workflows", 403);
    expect(byTopic(await locked("creditlimit", { server }), "Business rules").text).toBe("You don't have access to business rules.");
  });
});

describe("your access to the table", () => {
  const privileges = (depth: string | null) => ({
    RolePrivileges: [
      { PrivilegeName: "prvReadAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" },
      ...(depth ? [{ PrivilegeName: "prvWriteAccount", Depth: depth }] : []),
    ],
  });

  it("is the cause with no Write privilege", async () => {
    const { server } = { server: setup() };
    server.server.answerWhen(PRIVILEGES, privileges(null));
    server.server.answerWhen("roleprivilegescollection", { value: [] });
    expect(byTopic(await locked("creditlimit", { server }), "Your access to the table")).toMatchObject({
      state: "cause",
      text: "Neither your security roles nor the roles of your teams grant Write on account.",
    });
  });

  it.each([
    ["Basic", "records you own or that are shared with you"],
    ["Local", "records in your business unit"],
    ["Deep", "records in your business unit and the ones below it"],
  ])("cannot tell at %s depth, since Lite does not read the record's owner", async (depth, words) => {
    const { server } = { server: setup() };
    server.server.answerWhen(PRIVILEGES, privileges(depth));
    // Only the user's own roles: the captured team role grants Write too.
    server.server.answerWhen("roleprivilegescollection", { value: [] });
    expect(byTopic(await locked("creditlimit", { server }), "Your access to the table")).toMatchObject({
      state: "unknown",
      text: `Your security roles grant Write on ${words}. Lite does not read who owns this record.`,
    });
  });

  it("asks for the Write privilege the table's definition names", async () => {
    const { server } = { server: setup() };
    await locked("creditlimit", { server });
    const asked = server.server.requests.map(decodeURIComponent).find((url) => url.includes("RetrieveUserSetOfPrivilegesByNames") && url.includes("prvWrite"));
    expect(asked).toMatch(/@p1=\['prvWriteAccount'\]$/);
  });

  it("uses an activity table's shared Write privilege, never prvWrite<SchemaName>", async () => {
    const { server, get } = setup();
    server.answerWhen("EntityDefinitions(LogicalName='email')?$select=Privileges", {
      Privileges: [
        { Name: "prvReadActivity", PrivilegeType: "Read" },
        { Name: "prvWriteActivity", PrivilegeType: "Write" },
      ],
    });
    server.answerWhen(PRIVILEGES, { RolePrivileges: [{ PrivilegeName: "prvWriteActivity", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] });
    const model = await loadLockedCard(get, { table: "email", column: "subject", control: "subject", formId: null, showTips: true });
    const asked = server.requests.map(decodeURIComponent).filter((url) => url.includes("RetrieveUserSetOfPrivilegesByNames") && url.includes("prvWrite"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/@p1=\['prvWriteActivity'\]$/);
    expect(asked[0]).not.toContain("prvWriteEmail");
    expect(byTopic(model, "Your access to the table")).toMatchObject({ state: "ruledOut", text: "Your security roles grant Write on every email record." });
  });

  it("cannot check your access when the table's definition names no Write privilege", async () => {
    const { server, get } = setup();
    server.answerWhen("EntityDefinitions(LogicalName='account')?$select=Privileges", { Privileges: [{ Name: "prvReadAccount", PrivilegeType: "Read" }] });
    const model = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
    expect(byTopic(model, "Your access to the table")).toMatchObject({
      state: "unknown",
      text: "This table's definition does not name a Write privilege, so Lite could not check yours.",
    });
    expect(server.requests.map(decodeURIComponent).some((url) => url.includes("RetrieveUserSetOfPrivilegesByNames") && url.includes("prvWrite"))).toBe(false);
  });

  it.each([
    ["WhoAmI", 500, "Could not read your privileges."],
    [PRIVILEGES, 403, "You don't have access to your privileges."],
    ["EntityDefinitions(LogicalName='account')?$select=Privileges", 403, "You don't have access to this table's privileges."],
  ])("says so when %s answers %i", async (prefix, status, text) => {
    const { server } = { server: setup() };
    server.server.failWhen(prefix, status);
    server.server.answerWhen("roleprivilegescollection", { value: [] });
    expect(byTopic(await locked("creditlimit", { server }), "Your access to the table")).toMatchObject({ state: "unknown", text });
  });
});

describe("form scripts", () => {
  const formxml = (events: string) =>
    `<form><events>${events}</events><tabs><control id="creditlimit" datafieldname="creditlimit" disabled="false" /></tabs></form>`;
  const handler = (fn: string, enabled = "true") => `<Handler functionName="${fn}" libraryName="new_/account.js" enabled="${enabled}" />`;

  function withForm(xml: string) {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: xml }] });
    return server;
  }

  it("names the column's onChange handlers and counts the other columns' ones", async () => {
    const xml = formxml(
      `<event name="onchange" attribute="creditlimit" application="false" active="true"><Handlers>${handler("Contoso.creditChanged")}${handler("Contoso.off", "false")}</Handlers></event>` +
        `<event name="onchange" attribute="telephone1" application="false" active="true"><Handlers>${handler("Contoso.phone")}</Handlers></event>`,
    );
    const line = byTopic(await locked("creditlimit", { server: withForm(xml) }), "Form scripts");
    expect(line).toMatchObject({ state: "unknown", names: ["On change: Contoso.creditChanged in new_/account.js"] });
    expect(line.text).toBe("These form scripts might lock it. 1 more handler runs on other events: another column's OnChange. Lite cannot read what they do.");
  });

  it("cannot rule out other columns' onChange handlers", async () => {
    const xml = formxml(`<event name="onchange" attribute="telephone1"><Handlers>${handler("Contoso.phone")}</Handlers></event>`);
    const line = byTopic(await locked("creditlimit", { server: withForm(xml) }), "Form scripts");
    expect(line).toMatchObject({ state: "unknown", names: [] });
  });

  it.each([
    ["OnSave", `<event name="onsave"><Handlers>${handler("Contoso.save")}</Handlers></event>`],
    ["TabStateChange", `<event name="TabStateChange"><Handlers>${handler("Contoso.tab")}</Handlers></event>`],
    ["OnReadyStateComplete", `<event name="onreadystatecomplete" control="IFRAME_x"><Handlers>${handler("Contoso.frame")}</Handlers></event>`],
    ["PreSearch", `<event name="PreSearch" attribute="primarycontactid"><Handlers>${handler("Contoso.filter")}</Handlers></event>`],
    ["an internal handler", `<event name="setadditionalparams"><InternalHandlers>${handler("Platform.params")}</InternalHandlers></event>`],
  ])("cannot rule out a handler on %s, and counts it", async (_label, events) => {
    const line = byTopic(await locked("creditlimit", { server: withForm(formxml(events)) }), "Form scripts");
    expect(line).toMatchObject({ state: "unknown", names: [] });
    expect(line.text).toMatch(/^No form script runs on load or when this column changes\. 1 more handler runs on other events: .+\. Lite cannot read whether they lock it\.$/);
  });

  it("names the events the other handlers run on, once each", async () => {
    const xml = formxml(
      `<event name="onsave"><Handlers>${handler("Contoso.save")}${handler("Contoso.audit")}</Handlers></event>` +
        `<event name="tabstatechange"><Handlers>${handler("Contoso.tab")}</Handlers></event>`,
    );
    expect(byTopic(await locked("creditlimit", { server: withForm(xml) }), "Form scripts").text).toBe(
      "No form script runs on load or when this column changes. 3 more handlers run on other events: OnSave, TabStateChange. Lite cannot read whether they lock it.",
    );
  });

  it("does not rule out scripts when the definition could not be read in full", async () => {
    // The tab layout is cut off before the form-level events that follow it.
    const xml = `<form><tabs><tab name="SUMMARY_TAB"><columns><column><sections><section><rows><row><cell><control id="creditlimit" datafieldname="creditlimit" disabled="false" /></cell></row>`;
    const line = byTopic(await locked("creditlimit", { server: withForm(xml) }), "Form scripts");
    expect(line.state).toBe("unknown");
    expect(line.text).toBe("Could not read this form's definition in full, so Lite could not tell what scripts it runs.");
  });

  // Review R5: command bar enable rules, PCF controls and app-level scripts are not in formxml.
  it("never rules out scripts, even when the form has no enabled handler on any event", async () => {
    const xml = formxml(`<event name="onsave"><Handlers>${handler("Contoso.save", "false")}</Handlers></event>`);
    expect(byTopic(await locked("creditlimit", { server: withForm(xml) }), "Form scripts")).toMatchObject({
      state: "unknown",
      text: "This form has no enabled event handlers. Lite does not read command bar scripts, control scripts or app-level scripts, which can also lock a field.",
    });
  });

  it("never rules out scripts on a form with no events at all", async () => {
    const line = byTopic(await locked("creditlimit", { server: withForm(formxml("")) }), "Form scripts");
    expect(line.state).toBe("unknown");
    expect(line.text).toMatch(/^This form has no enabled event handlers\. Lite does not read command bar scripts/);
  });
});

describe("parseFormXml", () => {
  it("reads the real form: its controls and handlers", () => {
    const form = fixture<{ value: Array<{ formxml: string }> }>("forms-account-main").value[0]!;
    const parsed = parseFormXml(form.formxml);
    expect(parsed.controls.find((control) => control.id === "creditlimit")).toEqual({ id: "creditlimit", column: "creditlimit", disabled: false, embed: null });
    expect(parsed.controls.filter((control) => control.disabled).map((control) => control.id)).toEqual(["pathix_legalofficer"]);
    expect(parsed.handlers.map((handler) => `${handler.event} ${handler.functionName} ${handler.internal}`)).toEqual([
      "setadditionalparams AppCommon.Account.Instance.parentaccountid_setadditionalparams true",
      "onload AppCommon.Account.Instance.ra_onload true",
      "onsave Contoso.AccountForm.onSave false",
    ]);
  });

  it("decodes entities in names", () => {
    const parsed = parseFormXml(`<event name="onload"><Handlers><Handler functionName="a&amp;b" libraryName="x" /></Handlers></event>`);
    expect(parsed.handlers[0]?.functionName).toBe("a&b");
  });
});

describe("checklist copy", () => {
  it("never says writers, never shows a Pathix number, and uses no em dashes", async () => {
    for (const column of ["creditlimit", "pathix_legalofficer", "name"]) {
      const text = JSON.stringify({ ...(await locked(column)), lines: (await locked(column)).lines.map((line) => ({ ...line, names: [] })) });
      expect(text).not.toMatch(/writer/i);
      expect(text).not.toMatch(/Pathix found/);
      expect(text).not.toContain("—");
    }
  });

  it("carries a footer line naming what it cannot see and what Pathix does", async () => {
    const model = await locked("creditlimit");
    expect(model.tip).toEqual(LOCKED_TIP);
    expect(model.tip?.text).toBe("This checks your own access only. Pathix maps who can edit this column across your organization.");
    expect(model.tip?.linkText).toBe("Pathix");
    expect(model.tip?.href).toBe(PATHIX_SITE);
    expect((await locked("creditlimit", { showTips: false })).tip).toBeNull();
  });
});

// Team-held access (M6). Nobody has verified whether Dataverse's answer for
// the user's privileges counts team roles, so the card reads the teams' roles
// itself. These tests hold it correct whichever way that answer goes.
describe("access held through a team", () => {
  const none = { RolePrivileges: [{ PrivilegeName: "prvReadAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] };
  const holders = (...rows: Array<[string, number]>) => ({
    value: rows.map(([roleid, privilegedepthmask]) => ({ roleid, privilegeid: WRITE_ACCOUNT, privilegedepthmask })),
  });
  const accessLine = async (server: ReturnType<typeof setup>) => byTopic(await locked("creditlimit", { server }), "Your access to the table");

  it("rules out the table for a user whose only Write comes from a team role", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, 8]));
    expect(await accessLine(server)).toMatchObject({ state: "ruledOut", text: "A role you hold through a team grants Write on every account record." });
  });

  it("gives the same answer when Dataverse's own answer already counts the team's role", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] });
    server.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, 8]));
    expect(await accessLine(server)).toMatchObject({ state: "ruledOut", text: "Your security roles grant Write on every account record." });
  });

  it.each([
    [1, "records the team owns or that are shared with it, and possibly records you own"],
    [2, "records in the team's business unit"],
    [4, "records in the team's business unit and the ones below it"],
    // A mask also carries bits for entity references; the widest depth bit wins.
    [1 + 16, "records the team owns or that are shared with it, and possibly records you own"],
  ])("cannot tell at team depth mask %i, since Lite does not read the record's owner", async (mask, words) => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, mask]));
    expect(await accessLine(server)).toMatchObject({
      state: "unknown",
      text: `A role you hold through a team grants Write on ${words}. Lite does not read who owns this record.`,
    });
  });

  it("says a depth it has no name for is one it does not know", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, 16]));
    expect(await accessLine(server)).toMatchObject({
      state: "unknown",
      text: "Your security roles grant Write at a depth Lite does not know. Lite does not read who owns this record.",
    });
  });

  it("takes the widest depth across the user's own roles and their teams", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Local" }] });
    server.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, 4]));
    expect(await accessLine(server)).toMatchObject({
      text: "A role you hold through a team grants Write on records in the team's business unit and the ones below it. Lite does not read who owns this record.",
    });
  });

  it("ignores a role that holds Write but that none of the user's teams holds", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen("roleprivilegescollection", holders(["5c4a0000-0000-4000-8000-000000000312", 8]));
    expect(await accessLine(server)).toMatchObject({ state: "cause" });
  });

  it("asks whether the roles the teams hold have the privilege the table's definition names, not for every role that does", async () => {
    const server = setup();
    await locked("creditlimit", { server });
    const asked = server.server.requests.map(decodeURIComponent);
    const quoted = (ids: string[]) => ids.map((id) => `'${id}'`).join(",");
    expect(asked.some((url) => url.endsWith(`roleprivilegescollection?$select=roleid,privilegeid,privilegedepthmask&$filter=privilegeid eq ${WRITE_ACCOUNT} and Microsoft.Dynamics.CRM.In(PropertyName='roleid',PropertyValues=[${quoted(TEAM_ROLES)}])`))).toBe(true);
    expect(asked.some((url) => url.includes(`teamrolescollection?$select=teamid,roleid&$filter=Microsoft.Dynamics.CRM.In(PropertyName='teamid',PropertyValues=[${quoted(TEAMS)}])`))).toBe(true);
    expect(TEAMS).toContain(TEAM);
    expect(TEAM_ROLES).toContain(TEAM_ROLE);
  });

  it("is the cause with no team, and reads no team roles", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen(MY_TEAMS, { value: [] });
    expect(await accessLine(server)).toMatchObject({ state: "cause", text: "Your security roles do not grant Write on account." });
    expect(server.server.requests.some((url) => /teamrolescollection|roleprivilegescollection/.test(url))).toBe(false);
  });

  it("is the cause when the user's teams hold no roles", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen("teamrolescollection", { value: [] });
    expect(await accessLine(server)).toMatchObject({ state: "cause" });
    expect(server.server.requests.some((url) => /roleprivilegescollection/.test(url))).toBe(false);
  });

  it.each([
    [MY_TEAMS, 403, "You don't have access to the roles of your teams."],
    [MY_TEAMS, 500, "Could not read the roles of your teams."],
    ["teamrolescollection", 403, "You don't have access to the roles of your teams."],
    ["teamrolescollection", 404, "Could not read the roles of your teams."],
    ["roleprivilegescollection", 500, "Could not read the roles of your teams."],
  ])("cannot rule out a grant from a team when %s answers %i", async (prefix, status, unread) => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.failWhen(prefix, status);
    expect(await accessLine(server)).toMatchObject({
      state: "unknown",
      text: `Your own security roles do not grant Write on account. ${unread} A role a team holds might grant it.`,
    });
  });

  it("keeps a grant it did read when the other source could not be read", async () => {
    const own = setup();
    own.server.answerWhen(PRIVILEGES, { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] });
    own.server.failWhen(MY_TEAMS, 500);
    expect(await accessLine(own)).toMatchObject({ state: "ruledOut" });

    const team = setup();
    team.server.failWhen(PRIVILEGES, 500);
    team.server.answerWhen("roleprivilegescollection", holders([TEAM_ROLE, 8]));
    expect(await accessLine(team)).toMatchObject({ state: "ruledOut", text: "A role you hold through a team grants Write on every account record." });
  });

  it("stays unknown, not a cause, when the user's own answer failed and their teams grant nothing", async () => {
    const server = setup();
    server.server.failWhen(PRIVILEGES, 500);
    server.server.answerWhen("roleprivilegescollection", { value: [] });
    expect(await accessLine(server)).toMatchObject({ state: "unknown", text: "Could not read your privileges." });
  });

  it("treats a list of memberships with more pages than the client followed as unread", async () => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen(MY_TEAMS, { value: [{ teamid: TEAM, name: "t", teamtype: 0 }], "@odata.nextLink": "next" });
    expect(await accessLine(server)).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["a team row with no id", MY_TEAMS, { value: [{ name: "t" }] }],
    ["a team id that is not a GUID", MY_TEAMS, { value: [{ teamid: "x') or 1 eq 1", name: "t" }] }],
    ["a team role row with no role", "teamrolescollection", { value: [{ teamid: TEAM }] }],
    ["a depth that is not a number", "roleprivilegescollection", { value: [{ roleid: TEAM_ROLE, privilegedepthmask: "8" }] }],
    ["a depth row with no depth", "roleprivilegescollection", { value: [{ roleid: TEAM_ROLE }] }],
  ])("reads %s as unknown, never as no grant", async (_label, prefix, body) => {
    const server = setup();
    server.server.answerWhen(PRIVILEGES, none);
    server.server.answerWhen(prefix, body);
    expect(await accessLine(server)).toMatchObject({ state: "unknown" });
  });

  it("cannot read the team side when the table's definition carries no privilege id, and still reads the user's own", async () => {
    const server = setup();
    server.server.answerWhen("EntityDefinitions(LogicalName='account')?$select=Privileges", { Privileges: [{ Name: "prvWriteAccount", PrivilegeType: "Write" }] });
    server.server.answerWhen(PRIVILEGES, none);
    expect(await accessLine(server)).toMatchObject({ state: "unknown", text: expect.stringContaining("Could not read the roles of your teams.") });
    expect(server.server.requests.some((url) => /roleprivilegescollection/.test(url))).toBe(false);
  });

  it("asks nothing about teams when the table names no Write privilege and the column is not secured", async () => {
    const server = setup();
    server.server.answerWhen("EntityDefinitions(LogicalName='account')?$select=Privileges", { Privileges: [{ Name: "prvReadAccount", PrivilegeType: "Read" }] });
    await locked("creditlimit", { server });
    expect(server.server.requests.some((url) => /teammembership_association|teamrolescollection/.test(url))).toBe(false);
  });

  it("says in the info lines that teams are read", async () => {
    const model = await locked("creditlimit");
    expect(model.info.join(" ")).toMatch(/through a team/);
    expect(model.info.join(" ")).not.toMatch(/not ones that come through a team/);
  });
});

describe("column security held through a team", () => {
  const BANK_OPS = "5c4a0000-0000-4000-8000-000000000203";
  const PERMIT = "5c4a0000-0000-4000-8000-000000000204";
  const columnLine = async (server: ReturnType<typeof setup>) => byTopic(await locked("creditlimit", { server }), "Column security");
  const secured = () => {
    const server = setup();
    securedColumn(server.server);
    server.server.answerWhen("fieldpermissions", { value: [permission(BANK_OPS, 4), permission(PERMIT, 4)] });
    return server;
  };
  const teamProfiles = (...ids: string[]) => ({ value: ids.map((fieldsecurityprofileid) => ({ teamid: TEAM, fieldsecurityprofileid })) });

  it("rules out a column a profile the user's team holds can update, and names it", async () => {
    const server = secured();
    server.server.answerWhen("teamprofilescollection", teamProfiles(BANK_OPS));
    server.server.answerWhen("fieldsecurityprofiles", { value: [{ fieldsecurityprofileid: BANK_OPS, name: "sim Bank Ops" }] });
    expect(await columnLine(server)).toMatchObject({
      state: "ruledOut",
      text: "The column is secured, and a profile you hold through a team grants update.",
      names: ["sim Bank Ops"],
    });
  });

  it("rules out a column for a team that holds the System Administrator profile", async () => {
    const server = secured();
    server.server.answerWhen("teamprofilescollection", teamProfiles(SYSTEM_ADMINISTRATOR_PROFILE));
    expect(await columnLine(server)).toMatchObject({ state: "ruledOut" });
    expect((await columnLine(server)).text).toMatch(/through a team/);
  });

  it("is the cause when profiles grant update and the user holds none, in person or through a team", async () => {
    const server = secured();
    expect(await columnLine(server)).toMatchObject({ state: "cause", names: ["sim Bank Ops", "sim Permit Staff"] });
  });

  it("is the cause with no team at all", async () => {
    const server = secured();
    server.server.answerWhen(MY_TEAMS, { value: [] });
    expect(await columnLine(server)).toMatchObject({ state: "cause" });
    expect(server.server.requests.some((url) => /teamprofilescollection/.test(url))).toBe(false);
  });

  it.each([
    [MY_TEAMS, 403, "You don't have access to your teams' column security profiles."],
    ["teamprofilescollection", 500, "Could not read your teams' column security profiles."],
    ["teamprofilescollection", 404, "Could not read your teams' column security profiles."],
  ])("cannot rule out a team's profile when %s answers %i", async (prefix, status, unread) => {
    const server = secured();
    server.server.failWhen(prefix, status);
    const line = await columnLine(server);
    expect(line.state).toBe("unknown");
    expect(line.text).toContain(`A team you are in might. ${unread}`);
  });

  it.each([
    [MY_TEAMS, 403, "You don't have access to your teams' column security profiles."],
    ["teamprofilescollection", 500, "Could not read your teams' column security profiles."],
  ])("cannot call it a cause when no profile grants update and %s answers %i, since a team might hold System Administrator", async (prefix, status, unread) => {
    const server = setup();
    securedColumn(server.server);
    server.server.answerWhen("fieldpermissions", { value: [] });
    server.server.failWhen(prefix, status);
    const line = await columnLine(server);
    expect(line.state).toBe("unknown");
    expect(line.text).toContain("A team you are in might hold System Administrator.");
    expect(line.text).toContain(unread);
  });

  describe("when the user's own profiles could not be read", () => {
    const failOwn = (server: ReturnType<typeof secured>) => server.server.failWhen(`${USER}/systemuserprofiles_association`, 500);

    it("still rules out a column a team's profile can update", async () => {
      const server = secured();
      failOwn(server);
      server.server.answerWhen("teamprofilescollection", teamProfiles(BANK_OPS));
      expect(await columnLine(server)).toMatchObject({
        state: "ruledOut",
        text: "The column is secured, and a profile you hold through a team grants update.",
      });
    });

    it("still rules out a column for a team that holds the System Administrator profile", async () => {
      const server = secured();
      failOwn(server);
      server.server.answerWhen("teamprofilescollection", teamProfiles(SYSTEM_ADMINISTRATOR_PROFILE));
      expect(await columnLine(server)).toMatchObject({ state: "ruledOut" });
    });

    it("cannot tell when no team profile grants update, since the user's own might", async () => {
      const server = secured();
      failOwn(server);
      server.server.answerWhen("teamprofilescollection", teamProfiles());
      expect(await columnLine(server)).toMatchObject({
        state: "unknown",
        text: "The column is secured. Could not read your column security profiles.",
      });
    });

    it("cannot tell when no profile grants update at all, since the user's own might be System Administrator", async () => {
      const server = secured();
      failOwn(server);
      server.server.answerWhen("fieldpermissions", { value: [] });
      expect((await columnLine(server)).state).toBe("unknown");
    });
  });

  it("treats a profile row with no id as unread", async () => {
    const server = secured();
    server.server.answerWhen("teamprofilescollection", { value: [{ teamid: TEAM }] });
    expect((await columnLine(server)).state).toBe("unknown");
  });
});

// Parity with Pathix (DESIGN.md, "Lite and connected"): a control that
// displays another form is locked, whatever its disabled flag says. The shapes
// are the ones counted in a test environment on 2026-10-07: 6 forms carry a quick view,
// and the Account form carries one quick view and two form components.
describe("quick views and form components", () => {
  it("reads them from the real form, as Pathix reads it", () => {
    const form = fixture<{ value: Array<{ formxml: string }> }>("forms-account-main").value[0]!;
    const embeds = parseFormXml(form.formxml).controls.filter((control) => control.embed);
    expect(embeds.map((control) => [control.id, control.embed])).toEqual([
      ["parentaccountid", "formComponent"],
      ["pathix_legalofficer", "formComponent"],
      ["contactquickform", "quickView"],
    ]);
  });

  it("treats the control of a quick view as the cause, though its disabled flag is false", async () => {
    const model = await locked("primarycontactid", { control: "contactquickform" });
    expect(byTopic(model, "The form")).toMatchObject({
      state: "cause",
      text: "The definition of Account shows this control as a quick view. A quick view displays another record's form and cannot be edited here.",
    });
  });

  it("treats the host of a form component as the cause", async () => {
    const model = await locked("parentaccountid", { control: "parentaccountid1" });
    expect(byTopic(model, "The form")).toMatchObject({
      state: "cause",
      text: "The definition of Account shows this control as a form component. A form component displays another form and cannot be edited here.",
    });
  });

  it("finds the embed on the second copy of a column the page names with a number", async () => {
    const model = await locked("pathix_legalofficer", { control: "pathix_legalofficer1" });
    expect(byTopic(model, "The form").state).toBe("cause");
    expect(byTopic(model, "The form").text).toContain("form component");
  });

  it("does not take an ordinary control for an embed", async () => {
    expect((await locked("creditlimit")).lines.find((line) => line.topic === "The form")?.state).toBe("ruledOut");
  });

  const component = (host: string, forms: string) =>
    `<form><tabs><tab><columns><column><sections><section><rows><row><cell><control id="host" datafieldname="host" uniqueid="{${host}}" disabled="false" /></cell></row></rows></section></sections></column></columns></tab></tabs>` +
    `<controlDescriptions><controlDescription forControl="{${host}}"><customControl name="MscrmControls.ModelForm.ModelFormControl"><parameters><QuickForms type="SingleLine.Text" static="true">${forms}</QuickForms></parameters></customControl></controlDescription></controlDescriptions></form>`;
  const ONE_FORM = "&lt;QuickForms&gt;&lt;QuickFormIds&gt;&lt;QuickFormId entityname=&quot;account&quot;&gt;b053a39a-041a-4356-acef-ddf00182762b&lt;/QuickFormId&gt;&lt;/QuickFormIds&gt;&lt;/QuickForms&gt;";

  it("matches a form component host by shape, ignoring the braces and the case of its id", () => {
    const controls = parseFormXml(component("14422729-51E8-4823-A4C9-9E6BDD80126E", ONE_FORM).replace("{14422729-51E8-4823-A4C9-9E6BDD80126E}\" disabled", "{14422729-51e8-4823-a4c9-9e6bdd80126e}\" disabled")).controls;
    expect(controls.map((control) => control.embed)).toEqual(["formComponent"]);
  });

  it("does not take a custom control that names no form for a form component", () => {
    const none = "&lt;QuickForms&gt;&lt;QuickFormIds /&gt;&lt;/QuickForms&gt;";
    expect(parseFormXml(component("14422729-51e8-4823-a4c9-9e6bdd80126e", none)).controls.map((control) => control.embed)).toEqual([null]);
  });

  it("keeps a quick view host apart from the form components", () => {
    const xml =
      `<form><control id="q" uniqueid="{aaaaaaaa-0000-4000-8000-000000000001}"><parameters><QuickForms>&lt;QuickFormIds&gt;&lt;QuickFormId&gt;x&lt;/QuickFormId&gt;&lt;/QuickFormIds&gt;</QuickForms></parameters></control>` +
      `<controlDescriptions><controlDescription forControl="{aaaaaaaa-0000-4000-8000-000000000001}"><customControl><parameters><QuickForms>&lt;QuickFormId&gt;x&lt;/QuickFormId&gt;</QuickForms></parameters></customControl></controlDescription></controlDescriptions></form>`;
    expect(parseFormXml(xml).controls.map((control) => control.embed)).toEqual(["quickView"]);
  });

  it("cannot rule out a control when the definition was read only in part", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: `<form><control id="creditlimit" datafieldname="creditlimit" disabled="false">` }] });
    const model = await locked("creditlimit", { server });
    expect(byTopic(model, "The form")).toMatchObject({
      state: "unknown",
      text: "Could not read the definition of Account in full, so Lite could not tell whether it locks this control.",
    });
  });
});
