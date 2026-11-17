// The form event map, connected half (M10): the same panel as Lite, filled
// from Pathix's GET /environments/{id}/forms/{formId}/handlers.
//
// HAND-WRITTEN ANSWERS. No real answer from that endpoint has been captured
// yet (the endpoint was not yet released when this was written). Every Pathix answer below is written
// by hand in the shape of the contract (contract/pathix-api.slice.json) and
// checked against its schema by `conformsToContract`, so the tests assert the
// extension's logic against the contract and never claim what a real Pathix
// returns. The live check in the PR compares the panel with a real answer.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { ResponseCache } from "../src/background/cache";
import { loadFormEventMap } from "../src/background/event-map";
import {
  FORM_FROM_LABELS,
  buildConnectedEventMap,
  buildEventMap,
  connectedHeadline,
  FORM_NOT_IN_SCAN,
  FORM_NOT_PARSED,
  FORM_OTHER_TABLE,
  HANDLERS_FAILED,
  HANDLERS_NOT_RECORDED,
  HANDLERS_UNSUPPORTED,
  HANDLERS_UNREADABLE,
  NOT_MODELED_UNKNOWN,
  ORDER_NOT_RECORDED,
  type ConnectedEventMapContext,
  type EventMapModel,
} from "../src/card/event-map";
import { parseFormXml } from "../src/card/locked";
import { EventMapController } from "../src/content/event-map-controller";
import type { EventMapView } from "../src/content/event-map-view";
import { apiGet, type FormHandler, type FormHandlers } from "../src/pathix/api";
import { isEventMapRequest, type EventMapResponse } from "../src/runtime/messages";
import { fixture } from "./fake-dataverse";

const FORM_ID = "5c4a0000-0000-4000-8000-000000000321";
const ENV_ID = "5c4a0000-0000-4000-8000-0000000000e1";
const SCAN_ID = "5c4a0000-0000-4000-8000-0000000000a1";
const SCAN_AT = "2026-10-05T14:30:00Z";

const context: ConnectedEventMapContext = {
  table: "account",
  formId: FORM_ID,
  scanCompletedAt: SCAN_AT,
  formatDate: (iso) => `<${iso}>`,
};

// --- hand-written answers, in the contract's shape --------------------------------------

function handler(over: Partial<FormHandler> = {}): FormHandler {
  return {
    event: "onload",
    scope: "Form",
    scopeName: null,
    column: null,
    function: "Contoso.AccountForm.onLoad",
    library: "cr1ff_accountcreditlimittest",
    scriptComponentId: null,
    isEnabled: true,
    passExecutionContext: true,
    hasParameters: false,
    isPlatformLoaded: false,
    ordinal: null,
    ...over,
  };
}

/** A modeled answer. Ordinals are stamped in list order unless `ordered` is false. */
function modeled(handlers: FormHandler[], over: Partial<FormHandlers> = {}): FormHandlers {
  const ordered = over.ordered ?? true;
  return {
    formId: FORM_ID,
    formName: "Account",
    table: "account",
    scope: { environmentId: ENV_ID, scanId: SCAN_ID, scannedAt: SCAN_AT },
    coverage: "modeled",
    notModeledReason: null,
    ordered,
    handlers: ordered ? handlers.map((h, index) => ({ ...h, ordinal: index })) : handlers.map((h) => ({ ...h, ordinal: null })),
    ...over,
  };
}

function notModeled(reason: string | null): FormHandlers {
  return modeled([], { coverage: "notModeled", notModeledReason: reason, ordered: false, handlers: null });
}

const ok = (data: FormHandlers) => ({ kind: "ok" as const, data });
const mapOf = (data: FormHandlers) => buildConnectedEventMap(context, ok(data));

const lines = (model: EventMapModel) =>
  model.groups.map(
    (group) =>
      `${group.title}: ${group.rows
        .map((row) => `${row.position ? `${row.position}. ` : ""}${row.functionName}${row.enabled === false ? " [disabled]" : ""}${row.enabled === null ? " [enabled not stated]" : ""}${row.internal ? " [internal]" : ""}`)
        .join(" | ")}`,
  );

// --- the contract ------------------------------------------------------------------------

type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema };
const slice = JSON.parse(readFileSync("contract/pathix-api.slice.json", "utf8")) as { components: { schemas: Record<string, Schema> } };

/** Every property the schema declares is present and nothing else is, so a hand-written answer cannot drift from the contract. */
function conformsToContract(value: unknown, schemaName: string): string[] {
  const schema = slice.components.schemas[schemaName];
  if (!schema || typeof value !== "object" || value === null) return [`${schemaName}: not an object`];
  const declared = Object.keys(schema.properties ?? {}).sort();
  const present = Object.keys(value).sort();
  const problems: string[] = [];
  if (JSON.stringify(declared) !== JSON.stringify(present)) problems.push(`${schemaName}: has ${present.join(",")}, the contract declares ${declared.join(",")}`);
  const record = value as Record<string, unknown>;
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
    const actual = record[name] === null ? "null" : Array.isArray(record[name]) ? "array" : typeof record[name] === "number" && Number.isInteger(record[name]) ? "integer" : typeof record[name];
    const allowed = types.length === 0 || types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!allowed) problems.push(`${schemaName}.${name}: ${actual} is not ${types.join("|")}`);
  }
  return problems;
}

function answerConforms(answer: FormHandlers): string[] {
  return [
    ...conformsToContract(answer, "FormHandlersResponse"),
    ...conformsToContract(answer.scope, "FormHandlersScopeResponse"),
    ...(answer.handlers ?? []).flatMap((h) => conformsToContract(h, "FormHandlerResponse")),
  ];
}

/** A hand-written sample of Pathix's typed 404 body. Only its being a non-empty string matters. */
const NOT_IN_SCAN_SAMPLE = "No form with this id is in the environment's latest completed scan.";

describe("the hand-written answers match the contract", () => {
  it("has every declared property and the declared types", () => {
    for (const answer of [modeled([handler(), handler({ event: "onchange", column: "creditlimit", isEnabled: null })]), notModeled("formNotParsed"), modeled([])]) {
      expect(answerConforms(answer)).toEqual([]);
    }
  });

  it("catches an answer that does not match", () => {
    expect(answerConforms({ ...modeled([]), extra: 1 } as never)).not.toEqual([]);
    expect(conformsToContract({ ...handler(), isEnabled: "yes" }, "FormHandlerResponse")).not.toEqual([]);
  });
});

// --- the map -----------------------------------------------------------------------------

describe("connected: form, column, tab and control events", () => {
  const answer = modeled([
    handler({ event: "TabStateChange", scope: "Tab", scopeName: "SUMMARY_TAB", function: "Contoso.AccountForm.onTabState" }),
    handler({ event: "presearch", scope: "Control", scopeName: "primarycontactid", column: "primarycontactid", function: "Contoso.AccountForm.filterContacts" }),
    handler({ event: "onload", function: "AppCommon.Account.Instance.ra_onload", library: "AppCommon/Account/Account_main_system_library.js", isPlatformLoaded: true }),
    handler({ event: "onload" }),
    handler({ event: "onsave", function: "Contoso.AccountForm.onSave" }),
    handler({ event: "onchange", column: "telephone1", function: "Contoso.AccountForm.onPhoneChange" }),
    handler({ event: "onchange", column: "creditlimit", function: "Contoso.AccountForm.onCreditLimitChange" }),
    handler({ event: "onchange", scope: "Control", scopeName: "address1_composite", column: "address1_line1", function: "Contoso.AccountForm.onAddress" }),
  ]);

  it("groups them as the Lite map does and numbers them in the order the form lists them, only where an event has two or more", () => {
    const model = mapOf(answer);
    expect(model).toMatchObject({ mode: "connected", kind: "known", table: "account", orderNote: null, tip: null });
    expect(lines(model)).toEqual([
      "OnLoad: 1. AppCommon.Account.Instance.ra_onload [internal] | 2. Contoso.AccountForm.onLoad",
      "OnSave: Contoso.AccountForm.onSave",
      "OnChange: creditlimit: Contoso.AccountForm.onCreditLimitChange",
      "OnChange: telephone1: Contoso.AccountForm.onPhoneChange",
      "Tab SUMMARY_TAB: TabStateChange: Contoso.AccountForm.onTabState",
      "Control address1_composite: OnChange (address1_line1): Contoso.AccountForm.onAddress",
      "Control primarycontactid: PreSearch: Contoso.AccountForm.filterContacts",
    ]);
  });

  it("carries each row's library", () => {
    const model = mapOf(answer);
    expect(model.groups[0]!.rows[0]).toEqual({
      functionName: "AppCommon.Account.Instance.ra_onload",
      library: "AppCommon/Account/Account_main_system_library.js",
      enabled: true,
      internal: true,
      position: 1,
    });
    expect(model.groups[0]!.rows[1]!.library).toBe("cr1ff_accountcreditlimittest");
  });

  it("says As of the scan's date, and names the table", () => {
    expect(mapOf(answer).status).toBe(`As of <${SCAN_AT}>`);
  });

  it("falls back to the latest Completed scan's date when the answer carries none", () => {
    const model = mapOf(modeled([handler()], { scope: { environmentId: ENV_ID, scanId: SCAN_ID, scannedAt: null } }));
    expect(model.status).toBe(`As of <${SCAN_AT}>`);
  });

  it("an event with no label of ours shows as the form wrote it, and a scope Pathix adds later still lists", () => {
    const model = mapOf(modeled([handler({ event: "OnRecordSelect", scope: "Control", scopeName: "contacts_grid" }), handler({ event: "onload", scope: "Ribbon" })]));
    expect(model.groups.map((group) => group.title).sort()).toEqual(["Control contacts_grid: OnRecordSelect", "Elsewhere in the definition: OnLoad"]);
  });

  it("an unnamed tab or control is shown as unnamed, not dropped", () => {
    const model = mapOf(modeled([handler({ event: "TabStateChange", scope: "Tab", scopeName: null }), handler({ event: "presearch", scope: "Control", scopeName: null })]));
    expect(model.groups.map((group) => group.title)).toEqual(["Tab (unnamed): TabStateChange", "Control (unnamed): PreSearch"]);
  });
});

describe("connected: platform-loaded and disabled handlers", () => {
  it("tags platform-loaded handlers and does not hide them", () => {
    const model = mapOf(modeled([handler({ isPlatformLoaded: true }), handler()]));
    expect(model.groups[0]!.rows.map((row) => row.internal)).toEqual([true, false]);
    expect(model.headline).toBe("Pathix's scan found 2 handlers registered on this form: 1 loaded by the platform.");
  });

  it("marks a disabled handler and counts it", () => {
    const model = mapOf(modeled([handler(), handler({ function: "Contoso.AccountForm.oldOnLoad", isEnabled: false })]));
    expect(lines(model)).toEqual(["OnLoad: 1. Contoso.AccountForm.onLoad | 2. Contoso.AccountForm.oldOnLoad [disabled]"]);
    expect(model.headline).toBe("Pathix's scan found 2 handlers registered on this form: 1 disabled.");
  });

  it("does not assume a handler is on when the form did not state its enabled flag", () => {
    const model = mapOf(modeled([handler({ isEnabled: null })]));
    expect(model.groups[0]!.rows[0]!.enabled).toBeNull();
    expect(lines(model)).toEqual(["OnLoad: Contoso.AccountForm.onLoad [enabled not stated]"]);
    expect(model.headline).toBe("Pathix's scan found 1 handler registered on this form: 1 with enabled not stated.");
  });

  it("counts a one-handler form in the singular", () => {
    expect(connectedHeadline([{ functionName: "a", library: "b", enabled: true, internal: false }])).toBe("Pathix's scan found 1 handler registered on this form.");
  });
});

describe("connected: ordered false is not a run order", () => {
  const unordered = modeled([handler({ function: "b" }), handler({ function: "a" })], { ordered: false });

  it("says the order was not recorded in that scan, and numbers nothing", () => {
    const model = mapOf(unordered);
    expect(model.kind).toBe("known");
    expect(model.orderNote).toBe(ORDER_NOT_RECORDED);
    expect(ORDER_NOT_RECORDED).toMatch(/did not record the order/);
    expect(model.groups.flatMap((group) => group.rows).every((row) => row.position === undefined)).toBe(true);
    expect(model.info.join(" ")).not.toContain("numbered in the order");
  });

  it("keeps the rows in the order Pathix sent them (its sort), never re-sorting by a made-up sequence", () => {
    expect(mapOf(unordered).groups[0]!.rows.map((row) => row.functionName)).toEqual(["b", "a"]);
  });

  it("does not trust ordered true when a row has no position", () => {
    const answer = modeled([handler({ function: "a" }), handler({ function: "b" })]);
    answer.handlers![1]!.ordinal = null;
    const model = mapOf(answer);
    expect(model.orderNote).toBe(ORDER_NOT_RECORDED);
    expect(model.groups[0]!.rows.every((row) => row.position === undefined)).toBe(true);
  });

  it("says nothing about order for a single handler", () => {
    expect(mapOf(modeled([handler()], { ordered: false })).orderNote).toBeNull();
  });

  it("when ordered, lists each event by position even if the answer arrives shuffled", () => {
    const answer = modeled([handler({ function: "first" }), handler({ function: "second" }), handler({ function: "third" })]);
    answer.handlers = [answer.handlers![2]!, answer.handlers![0]!, answer.handlers![1]!];
    expect(lines(mapOf(answer))).toEqual(["OnLoad: 1. first | 2. second | 3. third"]);
  });

  it("says handlers are numbered only when at least one event shows numbers", () => {
    const single = mapOf(modeled([handler({ function: "a" }), handler({ event: "onsave", function: "b" })]));
    expect(lines(single)).toEqual(["OnLoad: a", "OnSave: b"]);
    expect(single.info.join(" ")).not.toContain("numbered in the order");
  });

  it("when ordered, the numbers restart under each event", () => {
    const model = mapOf(modeled([handler({ function: "a" }), handler({ event: "onsave", function: "b" }), handler({ function: "c" })]));
    expect(lines(model)).toEqual(["OnLoad: 1. a | 2. c", "OnSave: b"]);
    expect(model.info.join(" ")).toContain("numbered in the order the form's definition lists them");
  });
});

describe("connected: notModeled is unknown, with its reason, never no handlers", () => {
  const unknownWith = (answer: FormHandlers, headline: string) => {
    const model = mapOf(answer);
    expect(model).toMatchObject({ mode: "connected", kind: "unknown", groups: [], orderNote: null, headline });
    expect(model.headline).not.toMatch(/no handlers|0 handlers|registers no/i);
    return model;
  };

  it("formNotParsed", () => {
    unknownWith(notModeled("formNotParsed"), FORM_NOT_PARSED);
    expect(FORM_NOT_PARSED).toBe("Pathix could not read this form's definition in its latest scan, so it cannot list the form's handlers.");
  });

  it("handlersNotRecorded", () => {
    unknownWith(notModeled("handlersNotRecorded"), HANDLERS_NOT_RECORDED);
    expect(HANDLERS_NOT_RECORDED).toMatch(/may predate handler capture/);
  });

  it("a reason this extension does not know, or none", () => {
    unknownWith(notModeled("somethingNew"), NOT_MODELED_UNKNOWN);
    unknownWith(notModeled(null), NOT_MODELED_UNKNOWN);
  });

  it("is unknown even if handlers came with it, since the coverage is what Pathix said", () => {
    unknownWith({ ...notModeled("formNotParsed"), handlers: [handler()] }, FORM_NOT_PARSED);
  });

  it("an empty list under modeled is the one way to say the scan found none", () => {
    const model = mapOf(modeled([]));
    expect(model).toMatchObject({ kind: "known", groups: [], headline: "Pathix's scan found no script handlers registered on this form." });
  });

  it("says in the info that unknown is never read as no handlers", () => {
    expect(mapOf(notModeled("formNotParsed")).info.join(" ")).toContain("It never reads that as a form with no handlers.");
  });
});

describe("connected: an answer that is not the contract's shape is no answer", () => {
  it.each([
    ["modeled with null handlers", { ...modeled([]), handlers: null }],
    ["a coverage nobody defined", { ...modeled([]), coverage: "partial" }],
    ["another form's answer", { ...modeled([handler()]), formId: "5c4a0000-0000-4000-8000-000000000999" }],
    ["handlers that are not objects", { ...modeled([]), handlers: ["x"] }],
    ["no coverage", { ...modeled([]), coverage: undefined }],
    ["a table that is not a string", { ...modeled([handler()]), table: 7 }],
    ["a form name that is not a string", { ...modeled([handler()]), formName: { name: "Account" } }],
    ["not an object", null],
  ])("%s is unknown", (_name, bad) => {
    const model = buildConnectedEventMap(context, { kind: "ok", data: bad as never });
    expect(model).toMatchObject({ kind: "unknown", groups: [], headline: HANDLERS_UNREADABLE });
  });

  it("accepts the form id in either case", () => {
    expect(mapOf({ ...modeled([handler()]), formId: FORM_ID.toUpperCase() }).kind).toBe("known");
  });
});

// The answer names the form and its table. The form id may have
// come from the field labels and be another form's.
describe("connected: the form's name, and an answer for another table", () => {
  it("names the form in the subtitle, as Lite does", () => {
    expect(mapOf(modeled([handler()])).formName).toBe("Account");
    expect(mapOf(modeled([handler()], { formName: "  Account Main  " })).formName).toBe("Account Main");
    expect(mapOf(modeled([handler()], { formName: " " })).formName).toBeNull();
  });

  it("names the form when Pathix cannot say what it registers", () => {
    expect(mapOf({ ...notModeled("formNotParsed"), formName: "Account" })).toMatchObject({ kind: "unknown", headline: FORM_NOT_PARSED, formName: "Account" });
  });

  it("refuses an answer whose table is not the open form's, under any coverage, and never names that form", () => {
    for (const data of [modeled([handler()], { table: "contact", formName: "Contact" }), { ...notModeled("formNotParsed"), table: "contact", formName: "Contact" }, modeled([], { table: "contact" })]) {
      const model = mapOf(data);
      expect(model).toMatchObject({ kind: "unknown", groups: [], headline: FORM_OTHER_TABLE, formName: null, table: "account" });
      expect(model.headline).not.toMatch(/no handlers|0 handlers|registers no/i);
    }
    expect(FORM_OTHER_TABLE).toBe("Pathix answered for a form on another table, so its handlers are not shown. Which handlers this form registers is unknown.");
  });

  it("matches the table in either case", () => {
    expect(mapOf(modeled([handler()], { table: "Account" })).kind).toBe("known");
  });

  it("takes an answer with no table, from an older Pathix or a form the scan does not know, as before", () => {
    const { formName: _name, table: _table, ...older } = modeled([handler()]);
    expect(mapOf(older as FormHandlers)).toMatchObject({ kind: "known", formName: null });
    expect(mapOf(modeled([handler()], { table: null, formName: null }))).toMatchObject({ kind: "known", formName: null });
  });
});

describe("connected: a 404 and a failed request", () => {
  it("Pathix's typed 404 says the form is not in its latest scan", () => {
    const model = buildConnectedEventMap(context, { kind: "notInScan" });
    expect(model).toMatchObject({ mode: "connected", kind: "unknown", groups: [], headline: FORM_NOT_IN_SCAN });
    expect(FORM_NOT_IN_SCAN).toBe("This form is not in Pathix's latest scan, so Pathix cannot list its handlers.");
    expect(model.headline).not.toMatch(/no handlers|0 handlers|registers no/i);
    expect(model.info.join(" ")).not.toContain("older than");
  });

  it("a failed request is unknown, never an empty map", () => {
    const model = buildConnectedEventMap(context, { kind: "failed" });
    expect(model).toMatchObject({ kind: "unknown", groups: [], headline: HANDLERS_FAILED });
    expect(model.headline).not.toMatch(/no handlers|0 handlers|registers no/i);
  });

  it("only Pathix's typed 404 gets the not-in-scan wording", () => {
    expect(buildConnectedEventMap(context, { kind: "failed" }).headline).not.toBe(FORM_NOT_IN_SCAN);
    expect(buildConnectedEventMap(context, { kind: "noEndpoint" }).headline).not.toBe(FORM_NOT_IN_SCAN);
  });

  it("a 404 that is not Pathix's typed one is unknown and claims nothing about the scan", () => {
    const model = buildConnectedEventMap(context, { kind: "noEndpoint" });
    expect(model).toMatchObject({ mode: "connected", kind: "unknown", groups: [], headline: HANDLERS_UNSUPPORTED });
    expect(model.headline).not.toMatch(/not in .*scan|no handlers|0 handlers/i);
  });
});

// --- parity with the Lite map -------------------------------------------------------------

describe("parity: the same form in Lite and from Pathix", () => {
  /** The stand-in form's definition, and the answer Pathix's mapper would write for it (a hand-written conversion). */
  const form = fixture<{ value: Array<{ formid: string; name: string; formxml: string }> }>("forms-account-events").value[0]!;
  const parsed = parseFormXml(form.formxml);

  /**
   * Pathix's documented sort when a scan did not record the order (FormHandlersQuery.SortDeterministically):
   * scope, scope name, event, library, function, each compared ignoring case. Form, Tab, Control is the enum order.
   */
  const SCOPES = ["Form", "Tab", "Control"];
  const byText = (a: string | null, b: string | null) => (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase(), "en", { sensitivity: "base" });
  const sortedByPathix = (rows: FormHandler[]): FormHandler[] =>
    [...rows].sort(
      (a, b) =>
        SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope) ||
        byText(a.scopeName, b.scopeName) ||
        byText(a.event, b.event) ||
        byText(a.library, b.library) ||
        byText(a.function, b.function),
    );

  const asPathix = (ordered: boolean): FormHandlers => {
    const rows = parsed.allHandlers.map((h, index) =>
      handler({
          event: h.event,
          scope: h.scope === "form" ? "Form" : h.scope === "tab" ? "Tab" : "Control",
          scopeName: h.scope === "tab" ? h.tab : h.scope === "control" ? h.control : null,
          column: h.scope === "control" ? h.controlColumn : h.attribute,
          function: h.functionName,
          library: h.library,
          isEnabled: h.enabled,
          isPlatformLoaded: h.internal,
          ordinal: index,
        }),
    );
    return modeled(ordered ? rows : sortedByPathix(rows), { ordered, formName: form.name });
  };

  const lite = buildEventMap({ table: "account", formId: FORM_ID, showTips: true }, { kind: "ok", value: [{ formid: FORM_ID, name: form.name, formxml: form.formxml }] });
  const bare = (model: EventMapModel) => model.groups.map((group) => ({ title: group.title, rows: group.rows.map(({ functionName, library, enabled, internal }) => ({ functionName, library, enabled, internal })) }));

  it("lists the same events, libraries, functions, enabled flags and platform tags, under the same titles", () => {
    expect(answerConforms(asPathix(true))).toEqual([]);
    expect(lite.kind).toBe("known");
    expect(bare(mapOf(asPathix(true)))).toEqual(bare(lite));
    expect(mapOf(asPathix(true)).formName).toBe(lite.formName);
  });

  it("when the scan did not record the order, Pathix sends its own sort: the same groups and rows, in no claimed sequence", () => {
    const unordered = asPathix(false);
    expect(answerConforms(unordered)).toEqual([]);
    // The answer really is in a different order from the form's.
    expect(unordered.handlers!.map((h) => h.function)).not.toEqual(asPathix(true).handlers!.map((h) => h.function));
    const model = mapOf(unordered);
    const rowSets = (m: EventMapModel) => bare(m).map((group) => ({ title: group.title, rows: group.rows.map((r) => JSON.stringify(r)).sort() }));
    // Same titles, same group order, same set of rows in each. Row order is not compared with Lite's, which is the form's own.
    expect(rowSets(model)).toEqual(rowSets(lite));
    // Within each group the rows follow the library-then-function order the note describes, and none is numbered.
    for (const group of model.groups) {
      const keys = group.rows.map((row) => [row.library, row.functionName] as const);
      const sorted = [...keys].sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1]));
      expect(keys).toEqual(sorted);
      expect(group.rows.every((row) => row.position === undefined)).toBe(true);
    }
    expect(model.orderNote).toBe(ORDER_NOT_RECORDED);
  });

  it("titles a control's event with its bound column when the control id differs from it, in both modes", () => {
    const xml =
      '<form><tabs><tab name="T"><columns><column><sections><section name="S"><rows><row>' +
      '<cell id="{c1}"><events><event name="onchange" application="false" active="false"><Handlers><Handler functionName="Contoso.Currency.onIso" libraryName="cr1ff_currency" handlerUniqueId="{h1}" enabled="true" /></Handlers></event></events>' +
      '<control id="isocurrencycode_uci" classid="{c}" datafieldname="isocurrencycode" /></cell>' +
      "</row></rows></section></sections></column></columns></tab></tabs></form>";
    const liteModel = buildEventMap({ table: "transactioncurrency", formId: FORM_ID, showTips: true }, { kind: "ok", value: [{ formid: FORM_ID, name: "Information", formxml: xml }] });
    const parsedHandlers = parseFormXml(xml).allHandlers;
    expect(parsedHandlers).toHaveLength(1);
    expect(parsedHandlers[0]).toMatchObject({ control: "isocurrencycode_uci", controlColumn: "isocurrencycode" });
    const pathix = modeled([handler({ event: "onchange", scope: "Control", scopeName: "isocurrencycode_uci", column: "isocurrencycode", function: "Contoso.Currency.onIso", library: "cr1ff_currency" })]);
    const titles = (m: EventMapModel) => m.groups.map((group) => group.title);
    expect(titles(liteModel)).toEqual(["Control isocurrencycode_uci: OnChange (isocurrencycode)"]);
    expect(titles(mapOf(pathix))).toEqual(titles(liteModel));
  });

  it("covers all nine handlers, disabled and platform-loaded included", () => {
    const model = mapOf(asPathix(true));
    expect(model.groups.flatMap((group) => group.rows)).toHaveLength(9);
    expect(model.headline).toBe("Pathix's scan found 9 handlers registered on this form: 2 disabled, 1 loaded by the platform.");
  });
});

// --- copy ----------------------------------------------------------------------------------

describe("copy", () => {
  const models = (): EventMapModel[] => [
    mapOf(modeled([handler(), handler({ isEnabled: false })])),
    mapOf(modeled([handler({ function: "b" }), handler()], { ordered: false })),
    mapOf(modeled([])),
    mapOf(notModeled("formNotParsed")),
    mapOf(notModeled("handlersNotRecorded")),
    mapOf(notModeled(null)),
    buildConnectedEventMap(context, { kind: "notInScan" }),
    buildConnectedEventMap(context, { kind: "failed" }),
  ];

  it("uses no em dash and no footer tip", () => {
    for (const model of models()) {
      const text = JSON.stringify({ ...model, groups: [] });
      expect(text).not.toContain("—");
      expect(text).not.toContain("\\u2014");
      expect(model.tip).toBeNull();
    }
  });

  it("never calls a script a writer: that is the column cards' claim", () => {
    for (const model of models()) expect(JSON.stringify(model)).not.toMatch(/writers?\b/i);
  });

  it("every unknown model has no rows and no count", () => {
    for (const model of models().filter((m) => m.kind === "unknown")) {
      expect(model.groups).toEqual([]);
      expect(model.headline).not.toMatch(/\d/);
    }
  });
});

// --- the service worker's read --------------------------------------------------------------

describe("loadFormEventMap: the Pathix read", () => {
  const loadContext = { ...context, environmentId: ENV_ID };
  const answer = (result: unknown) => {
    const paths: string[] = [];
    const get = (async (path: string) => {
      paths.push(path);
      return result;
    }) as never;
    return { get, paths };
  };

  it("asks for the environment's form by its id, and nothing else", async () => {
    const { get, paths } = answer({ ok: true, data: modeled([handler()]) });
    const response = await loadFormEventMap(loadContext, get);
    expect(paths).toEqual([`/environments/${ENV_ID}/forms/${FORM_ID}/handlers`]);
    expect(response).toMatchObject({ kind: "eventMap", model: { kind: "known", mode: "connected" } });
  });

  it("is a path the contract declares, with the parameters it declares", () => {
    const slicePaths = JSON.parse(readFileSync("contract/pathix-api.slice.json", "utf8")) as {
      paths: Record<string, { get: { parameters: Array<{ name: string; in: string; required?: boolean }> } }>;
    };
    const declared = slicePaths.paths["/environments/{id}/forms/{formId}/handlers"]?.get.parameters ?? [];
    expect(declared.map((p) => `${p.in}:${p.name}`)).toEqual(["path:id", "path:formId"]);
  });

  it("turns Pathix's typed 404 (a form not in the latest scan) into the not-in-scan map", async () => {
    // Whatever the message says: the check does not depend on Pathix's wording.
    for (const detail of [NOT_IN_SCAN_SAMPLE, "Form not found.", "reworded by a later Pathix", "x"]) {
      const typed = { ok: false, kind: "failed", message: "Pathix answered 404.", status: 404, detail };
      const response = await loadFormEventMap(loadContext, answer(typed).get);
      expect(response).toMatchObject({ kind: "eventMap", model: { kind: "unknown", headline: FORM_NOT_IN_SCAN } });
    }
  });

  it("does not turn a 404 without a message into the not-in-scan map: a Pathix with no such route says nothing about the scan", async () => {
    for (const detail of [undefined, "", "  "]) {
      const result = { ok: false, kind: "failed", message: "Pathix answered 404.", status: 404, ...(detail === undefined ? {} : { detail }) };
      const response = await loadFormEventMap(loadContext, answer(result).get);
      expect(response).toMatchObject({ kind: "eventMap", model: { kind: "unknown", headline: HANDLERS_UNSUPPORTED, groups: [] } });
    }
  });

  it("turns any other failure into an unknown map, never an empty one", async () => {
    for (const result of [
      { ok: false, kind: "failed", message: "Pathix answered 500.", status: 500 },
      { ok: false, kind: "failed", message: "network down" },
    ]) {
      const response = await loadFormEventMap(loadContext, answer(result).get);
      expect(response).toMatchObject({ kind: "eventMap", model: { kind: "unknown", headline: HANDLERS_FAILED, groups: [] } });
    }
  });

  it("replaces the panel with a sign-in problem, as the cards do", async () => {
    expect(await loadFormEventMap(loadContext, answer({ ok: false, kind: "signedOut" }).get)).toEqual({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    expect(await loadFormEventMap(loadContext, answer({ ok: false, kind: "unauthorized", status: 403 }).get)).toEqual({
      kind: "status",
      status: { kind: "unauthorized", status: 403 },
    });
  });

  it("goes through the response cache the cards share, scoped to the scan; a 404 is not kept", async () => {
    let calls = 0;
    const get = (async () => {
      calls++;
      return { ok: true, data: modeled([handler()]) };
    }) as never;
    const cache = new ResponseCache(60_000);
    await loadFormEventMap(loadContext, cache.wrap(get, "env|scan-1"));
    await loadFormEventMap(loadContext, cache.wrap(get, "env|scan-1"));
    expect(calls).toBe(1);
    await loadFormEventMap(loadContext, cache.wrap(get, "env|scan-2"));
    expect(calls).toBe(2);

    let misses = 0;
    const missing = (async () => {
      misses++;
      return { ok: false, kind: "failed", message: "Pathix answered 404.", status: 404 };
    }) as never;
    await loadFormEventMap(loadContext, cache.wrap(missing, "env|scan-3"));
    await loadFormEventMap(loadContext, cache.wrap(missing, "env|scan-3"));
    expect(misses).toBe(2);
  });
});

describe("apiGet tells a 404 from other failures", () => {
  const reply = (status: number) => (async () => new Response("not found", { status })) as unknown as typeof fetch;
  const token = async () => "token";

  it("carries the HTTP status on a failed answer", async () => {
    expect(await apiGet("https://pathix.example", "/x", token, reply(404))).toEqual({ ok: false, kind: "failed", message: "Pathix answered 404.", status: 404 });
    expect(await apiGet("https://pathix.example", "/x", token, reply(500))).toMatchObject({ ok: false, kind: "failed", status: 500 });
  });

  it("keeps the JSON string body of a 404, which is how Pathix's typed NotFound arrives", async () => {
    const typed = (async () => new Response(JSON.stringify(NOT_IN_SCAN_SAMPLE), { status: 404, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    expect(await apiGet("https://pathix.example", "/x", token, typed)).toEqual({ ok: false, kind: "failed", message: "Pathix answered 404.", status: 404, detail: NOT_IN_SCAN_SAMPLE });
  });

  it("has no detail on a 404 with an empty, blank, HTML or object body, or on any other status", async () => {
    const bodies = ["", JSON.stringify(""), JSON.stringify("  "), "<html>Not Found</html>", JSON.stringify({ title: "Not Found" })];
    for (const body of bodies) {
      const route = (async () => new Response(body, { status: 404 })) as unknown as typeof fetch;
      expect(await apiGet("https://pathix.example", "/x", token, route)).toEqual({ ok: false, kind: "failed", message: "Pathix answered 404.", status: 404 });
    }
    const typed500 = (async () => new Response(JSON.stringify(NOT_IN_SCAN_SAMPLE), { status: 500 })) as unknown as typeof fetch;
    expect(await apiGet("https://pathix.example", "/x", token, typed500)).toEqual({ ok: false, kind: "failed", message: "Pathix answered 500.", status: 500 });
  });

  it("leaves it off when the request itself failed", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await apiGet("https://pathix.example", "/x", token, down)).toEqual({ ok: false, kind: "failed", message: "offline" });
  });
});

describe("the request between the content script and the worker", () => {
  const good = { kind: "eventMap", organizationId: FORM_ID, host: "contoso.crm.dynamics.com", table: "account", formId: FORM_ID };

  it("is logical names, a host and two guids, and nothing else", () => {
    expect(isEventMapRequest(good)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isEventMapRequest({ ...good, column: "name" })).toBe(false);
    expect(isEventMapRequest({ ...good, formId: "not-a-guid" })).toBe(false);
    expect(isEventMapRequest({ ...good, formId: null })).toBe(false);
    expect(isEventMapRequest({ ...good, formId: `${FORM_ID}/../x` })).toBe(false);
    expect(isEventMapRequest({ ...good, table: "account; drop" })).toBe(false);
    expect(isEventMapRequest({ ...good, host: "https://contoso.crm.dynamics.com/x" })).toBe(false);
    expect(isEventMapRequest({ ...good, organizationId: "x" })).toBe(false);
    expect(isEventMapRequest({ ...good, kind: "tableChanges" })).toBe(false);
    expect(isEventMapRequest(null)).toBe(false);
  });
});

// --- the controller ----------------------------------------------------------------------------

describe("the controller in connected mode", () => {
  const snapshot = {
    organizationId: ENV_ID,
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: FORM_ID,
  } as unknown as FormSnapshot;
  const model = mapOf(modeled([handler()]));
  const settle = () => new Promise((done) => setTimeout(done, 0));

  function harness(mode: "lite" | "connected" | undefined = "connected") {
    let resolve: (value: EventMapResponse | undefined) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const calls: string[] = [];
    const sent: unknown[] = [];
    const maps: EventMapModel[] = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      showMessage: (message: string) => calls.push(`message: ${message}`),
      showMap: (shown: EventMapModel) => {
        maps.push(shown);
        calls.push(`map: ${shown.mode}`);
      },
      hide: () => calls.push("hide"),
    };
    const sources = {
      settings: async () => (mode ? { mode, showTips: true } : undefined),
      load: async () => {
        calls.push("lite read");
        return { ...model, mode: "lite" as const };
      },
      connectedMap: (request: unknown) => {
        sent.push(request);
        return new Promise<EventMapResponse | undefined>((done, fail) => {
          resolve = done;
          reject = fail;
        });
      },
      hideTips: async () => undefined,
    };
    const controller = new EventMapController(view as unknown as EventMapView, sources as never);
    return { controller, calls, sent, maps, resolve: (value: EventMapResponse | undefined) => resolve(value), reject: (reason: unknown) => reject(reason) };
  }

  // Pathix's answer names neither the form nor its table. When the form id was
  // read from the page's labels (the page reported none), the map says so.
  it("says the form was read from the field labels when the page did not report one", async () => {
    const fromLabels = harness();
    fromLabels.controller.setSnapshot(snapshot, null);
    fromLabels.controller.open();
    await settle();
    fromLabels.resolve({ kind: "eventMap", model });
    await settle();
    expect(fromLabels.maps.at(-1)?.formSource).toBe("Form read from the page's field labels");
    expect(FORM_FROM_LABELS).toBe("Form read from the page's field labels");

    const fromPage = harness();
    fromPage.controller.setSnapshot(snapshot);
    fromPage.controller.open();
    await settle();
    fromPage.resolve({ kind: "eventMap", model });
    await settle();
    expect(fromPage.maps.at(-1)?.formSource ?? null).toBeNull();
  });

  it("shows the form's source in the subtitle", () => {
    const view = readFileSync("src/content/event-map-view.ts", "utf8");
    expect(view).toContain('if (model.formSource) subtitle.append(element("span", "form-source", model.formSource));');
  });

  it("asks the worker for the form's handlers, with names and ids only, and draws the answer", async () => {
    const { controller, calls, sent, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    expect(calls).toEqual(["message: Loading from Pathix…"]);
    expect(sent).toEqual([{ kind: "eventMap", organizationId: ENV_ID, host: "contoso.crm.dynamics.com", table: "account", formId: FORM_ID }]);
    resolve({ kind: "eventMap", model });
    await settle();
    expect(calls.at(-1)).toBe("map: connected");
    expect(calls).not.toContain("lite read");
  });

  it("shows a sign-in or setup problem as a message, never as a map", async () => {
    const { controller, calls, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    resolve({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    await settle();
    expect(calls.at(-1)).toBe("message: Signed out of Pathix. Sign in from the extension's options to see what Pathix found.");
    expect(calls.some((call) => call.startsWith("map"))).toBe(false);
  });

  it("shows no answer from the worker as a message, never as a map", async () => {
    const { controller, calls, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    resolve(undefined);
    await settle();
    expect(calls.at(-1)).toBe("message: The extension did not answer. Reload the page and try again.");
  });

  it("treats a rejected request as no answer", async () => {
    const { controller, calls, reject } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    reject(new Error("worker restarted"));
    await settle();
    expect(calls.at(-1)).toBe("message: The extension did not answer. Reload the page and try again.");
  });

  it("does not ask when the page did not say which form is open", async () => {
    const { controller, calls, sent } = harness();
    controller.setSnapshot({ ...snapshot, formId: null } as FormSnapshot);
    controller.open();
    await settle();
    expect(sent).toEqual([]);
    expect(calls.at(-1)).toBe("message: The page did not say which form is open, so Pathix could not be asked about its handlers.");
  });

  it("does not draw an answer that arrives after the user left the form", async () => {
    const { controller, calls, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    controller.setSnapshot(null);
    resolve({ kind: "eventMap", model });
    await settle();
    expect(calls.some((call) => call.startsWith("map"))).toBe(false);
    expect(calls.at(-1)).toBe("message: Open a record form to see its event map.");
  });

  it("does not draw an answer that arrives after the panel was closed", async () => {
    const { controller, calls, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    controller.close();
    resolve({ kind: "eventMap", model });
    await settle();
    expect(calls.some((call) => call.startsWith("map"))).toBe(false);
    expect(calls.at(-1)).toBe("hide");
  });

  it("asks again for a different form", async () => {
    const { controller, sent } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    controller.setSnapshot({ ...snapshot, formId: "5c4a0000-0000-4000-8000-000000000555" } as FormSnapshot);
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("keeps the Lite chip on the loading and the could-not-read messages in Lite, and none on a connected message", async () => {
    const shown: Array<[string, unknown]> = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      showMessage: (message: string, mode?: unknown) => shown.push([message, mode ?? null]),
      showMap: () => undefined,
      hide: () => undefined,
    };
    const failing = {
      settings: async () => ({ mode: "lite" as const, showTips: true }),
      load: async () => {
        throw new Error("dataverse down");
      },
      connectedMap: async () => undefined,
      hideTips: async () => undefined,
    };
    const lite = new EventMapController(view as unknown as EventMapView, failing as never);
    lite.setSnapshot(snapshot);
    lite.open();
    await settle();
    expect(shown).toEqual([
      ["Reading the form's definition from Dataverse…", "lite"],
      ["Could not read this form's definition from Dataverse.", "lite"],
    ]);

    shown.length = 0;
    const connected = new EventMapController(view as unknown as EventMapView, { ...failing, settings: async () => ({ mode: "connected" as const, showTips: true }) } as never);
    connected.setSnapshot(snapshot);
    connected.open();
    await settle();
    expect(shown[0]).toEqual(["Loading from Pathix…", null]);
    expect(shown.every(([, mode]) => mode !== "lite")).toBe(true);
  });

  it("stays Lite in Lite: it reads Dataverse and asks Pathix for nothing", async () => {
    const { controller, calls, sent } = harness("lite");
    controller.setSnapshot(snapshot);
    controller.open();
    await settle();
    expect(sent).toEqual([]);
    expect(calls).toContain("lite read");
    expect(calls.at(-1)).toBe("map: lite");
  });
});
