import { describe, expect, it } from "vitest";
import {
  CHANNEL,
  SNAPSHOT_VERSION,
  helloMessage,
  isHelloMessage,
  isPageMessage,
  type FormSnapshot,
} from "../src/bridge/messages";

function validSnapshot(): FormSnapshot {
  return {
    channel: CHANNEL,
    kind: "formSnapshot",
    version: SNAPSHOT_VERSION,
    organizationId: "c0de0000-0000-4000-8000-000000000003",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: "8448b78f-8f42-454e-8e2a-f8196b0419af",
    columns: [
      { control: "name", column: "name" },
      { control: "header_ownerid", column: "ownerid" },
      { control: "new_CustomControl", column: "new_creditlimit" },
    ],
    dirtyColumns: ["name"],
    lockedControls: ["header_ownerid"],
    saveKind: "update",
    alwaysSubmitColumns: ["statecode"],
    quickViewColumns: [{ control: "contactquickform.emailaddress1", table: "contact", column: "emailaddress1" }],
  };
}

describe("isPageMessage", () => {
  it("accepts a well-formed snapshot", () => {
    expect(isPageMessage(validSnapshot())).toBe(true);
  });

  it("accepts a snapshot with no form id", () => {
    expect(isPageMessage({ ...validSnapshot(), formId: null })).toBe(true);
  });

  it("accepts the no-form message", () => {
    expect(isPageMessage({ channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason: "noXrm" })).toBe(true);
  });

  it("rejects a no-form message without a reason, or with free text as the reason", () => {
    expect(isPageMessage({ channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION })).toBe(false);
    const freeText = { channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason: "Contoso" };
    expect(isPageMessage(freeText)).toBe(false);
  });

  it.each([
    ["the record id", { recordId: "11111111-2222-4333-8444-555555555555" }],
    ["the record name", { primaryName: "Contoso" }],
    ["field values", { values: { name: "Contoso" } }],
    ["the page URL", { url: "https://contoso.crm.dynamics.com/main.aspx?id=1" }],
  ])("rejects a snapshot that also carries %s", (_label, extra) => {
    expect(isPageMessage({ ...validSnapshot(), ...extra })).toBe(false);
  });

  it("rejects a column entry that carries a value", () => {
    const snapshot = validSnapshot();
    const columns = [{ control: "name", column: "name", value: "Contoso" }];
    expect(isPageMessage({ ...snapshot, columns })).toBe(false);
  });

  it.each([
    ["a name with a space", "Contoso Ltd"],
    ["an email address", "dana@contoso.com"],
    ["uppercase", "Account"],
    ["a number-led name", "1account"],
    ["an over-long name", "a".repeat(129)],
  ])("rejects a table that is %s", (_label, table) => {
    expect(isPageMessage({ ...validSnapshot(), table })).toBe(false);
  });

  it("rejects a dirty column that is not a logical name", () => {
    expect(isPageMessage({ ...validSnapshot(), dirtyColumns: ["Contoso Ltd"] })).toBe(false);
  });

  it.each([
    ["an edit's value next to its name", [{ column: "name", value: "Contoso" }]],
    ["a name and value pair", [["name", "Contoso"]]],
    ["a number", [42]],
    ["a value shaped like a name but over-long", ["a".repeat(129)]],
    ["an email address", ["dana@contoso.com"]],
  ])("rejects dirty columns that carry %s", (_label, dirtyColumns) => {
    expect(isPageMessage({ ...validSnapshot(), dirtyColumns })).toBe(false);
  });

  it.each([
    ["a value next to the control name", [{ control: "name", value: "Contoso" }]],
    ["a reason as free text", ["Locked by business rule"]],
    ["a boolean", [true]],
    ["an over-long name", ["a".repeat(129)]],
  ])("rejects locked controls that carry %s", (_label, lockedControls) => {
    expect(isPageMessage({ ...validSnapshot(), lockedControls })).toBe(false);
  });

  it("rejects a snapshot without locked controls, or with an oversized list", () => {
    const { lockedControls: _dropped, ...without } = validSnapshot();
    expect(isPageMessage(without)).toBe(false);
    expect(isPageMessage({ ...validSnapshot(), lockedControls: Array.from({ length: 2001 }, () => "name") })).toBe(false);
  });

  it("rejects dirty columns that are not a list, or an oversized list", () => {
    expect(isPageMessage({ ...validSnapshot(), dirtyColumns: { name: "Contoso" } })).toBe(false);
    expect(isPageMessage({ ...validSnapshot(), dirtyColumns: Array.from({ length: 2001 }, () => "name") })).toBe(false);
  });

  it.each(["create", "update", null])("accepts the save kind %s", (saveKind) => {
    expect(isPageMessage({ ...validSnapshot(), saveKind })).toBe(true);
  });

  it.each([
    ["free text", "Contoso Ltd"],
    ["a form type number", 2],
    ["another word", "delete"],
    ["an object", { kind: "update", id: "11111111-2222-4333-8444-555555555555" }],
    ["undefined", undefined],
  ])("rejects a save kind that is %s", (_label, saveKind) => {
    expect(isPageMessage({ ...validSnapshot(), saveKind })).toBe(false);
  });

  it.each([
    ["an edit's value next to its name", [{ column: "name", value: "Contoso" }]],
    ["a mode as free text", ["Always submit"]],
    ["a number", [42]],
    ["an email address", ["dana@contoso.com"]],
    ["an over-long name", ["a".repeat(129)]],
  ])("rejects always-submitted columns that carry %s", (_label, alwaysSubmitColumns) => {
    expect(isPageMessage({ ...validSnapshot(), alwaysSubmitColumns })).toBe(false);
  });

  it("rejects a snapshot without the save preview's inputs, or with an oversized list", () => {
    const { alwaysSubmitColumns: _a, ...withoutColumns } = validSnapshot();
    expect(isPageMessage(withoutColumns)).toBe(false);
    const { saveKind: _k, ...withoutKind } = validSnapshot();
    expect(isPageMessage(withoutKind)).toBe(false);
    expect(isPageMessage({ ...validSnapshot(), alwaysSubmitColumns: Array.from({ length: 2001 }, () => "name") })).toBe(false);
    expect(isPageMessage({ ...validSnapshot(), alwaysSubmitColumns: { statecode: "Active" } })).toBe(false);
  });

  it.each([
    ["a value in place of the column", { control: "contactquickform.emailaddress1", table: "contact", column: "someone@contoso.com" }],
    ["a table that is not a logical name", { control: "contactquickform.emailaddress1", table: "Primary Contact", column: "emailaddress1" }],
    ["an extra key", { control: "contactquickform.emailaddress1", table: "contact", column: "emailaddress1", value: "x" }],
    ["no table", { control: "contactquickform.emailaddress1", column: "emailaddress1" }],
    // The inner name alone could be one of the form's own controls (Account's telephone1).
    ["the inner control's name alone", { control: "emailaddress1", table: "contact", column: "emailaddress1" }],
    ["two dots in the control", { control: "a.contactquickform.emailaddress1", table: "contact", column: "emailaddress1" }],
  ])("rejects a quick view column with %s", (_label, entry) => {
    expect(isPageMessage({ ...validSnapshot(), quickViewColumns: [entry] })).toBe(false);
  });

  it("rejects a snapshot without quick view columns, or with an oversized list", () => {
    const { quickViewColumns: _q, ...withoutQuickViews } = validSnapshot();
    expect(isPageMessage(withoutQuickViews)).toBe(false);
    const entry = { control: "qv.name", table: "contact", column: "name" };
    expect(isPageMessage({ ...validSnapshot(), quickViewColumns: Array.from({ length: 2001 }, () => entry) })).toBe(false);
  });

  it("rejects a host carrying a path", () => {
    expect(isPageMessage({ ...validSnapshot(), host: "contoso.crm.dynamics.com/main.aspx" })).toBe(false);
  });

  it("rejects an organization id that is not a GUID", () => {
    expect(isPageMessage({ ...validSnapshot(), organizationId: "contoso" })).toBe(false);
  });

  it("rejects messages from another channel or version", () => {
    expect(isPageMessage({ ...validSnapshot(), channel: "other" })).toBe(false);
    expect(isPageMessage({ ...validSnapshot(), version: 2 })).toBe(false);
  });

  it("rejects a no-form message with extra keys", () => {
    const message = { channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason: "noXrm", table: "account" };
    expect(isPageMessage(message)).toBe(false);
  });

  it("rejects an oversized column list", () => {
    const columns = Array.from({ length: 2001 }, () => ({ control: "name", column: "name" }));
    expect(isPageMessage({ ...validSnapshot(), columns })).toBe(false);
  });

  it.each([null, undefined, "snapshot", 42, []])("rejects %s", (value) => {
    expect(isPageMessage(value)).toBe(false);
  });
});

describe("isHelloMessage", () => {
  it("accepts the hello the content script sends", () => {
    expect(isHelloMessage(helloMessage())).toBe(true);
  });

  it("is never mistaken for a page message, or the reverse", () => {
    expect(isPageMessage(helloMessage())).toBe(false);
    expect(isHelloMessage({ channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason: "noXrm" })).toBe(false);
  });

  it("rejects a hello with extra keys", () => {
    expect(isHelloMessage({ ...helloMessage(), table: "account" })).toBe(false);
  });
});
