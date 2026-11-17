// The form event map (M10, Lite), built from the real form fixture in
// contract/dataverse/ and from a hand-written stand-in for the cases the real
// one lacks (tab events, control events, OnChange per column, disabled
// handlers): contract/dataverse/forms-account-events.json.

import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventMap, EVENT_MAP_TIP, headlineFor, type EventMapModel } from "../src/card/event-map";
import { PATHIX_SITE } from "../src/card/lite";
import { parseFormXml } from "../src/card/locked";
import { createDataverseClient } from "../src/dataverse/client";
import type { FormSnapshot } from "../src/bridge/messages";
import { EventMapController } from "../src/content/event-map-controller";
import { functionName, type EventMapView } from "../src/content/event-map-view";
import { loadEventMap } from "../src/lite/event-map";
import { fakeDataverse, fixture, ORIGIN } from "./fake-dataverse";
import type { CardSettings } from "../src/runtime/card-settings";

const FORM_ID = "5c4a0000-0000-4000-8000-000000000021";
const CASES_FORM_ID = "5c4a0000-0000-4000-8000-000000000321";

function setup() {
  const server = fakeDataverse();
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

async function mapOf(options: { formId?: string | null; showTips?: boolean; cases?: boolean; server?: ReturnType<typeof setup> } = {}): Promise<EventMapModel> {
  const { server, get } = options.server ?? setup();
  if (options.cases) server.answerWhen("systemforms", fixture("forms-account-events"));
  return loadEventMap(get, {
    table: "account",
    formId: options.formId === undefined ? (options.cases ? CASES_FORM_ID : FORM_ID) : options.formId,
    showTips: options.showTips ?? true,
  });
}

const lines = (model: EventMapModel) =>
  model.groups.map((group) => `${group.title}: ${group.rows.map((row) => `${row.functionName}${row.enabled ? "" : " [disabled]"}${row.internal ? " [internal]" : ""}`).join(" | ")}`);

describe("the map of the real Account form", () => {
  it("lists every handler, with the platform's own tagged and not hidden", async () => {
    const model = await mapOf();
    expect(model.kind).toBe("known");
    expect(model.formName).toBe("Account");
    expect(lines(model)).toEqual([
      "OnLoad: AppCommon.Account.Instance.ra_onload [internal]",
      "OnSave: Contoso.AccountForm.onSave",
      "Control parentaccountid: SetAdditionalParams: AppCommon.Account.Instance.parentaccountid_setadditionalparams [internal]",
    ]);
    expect(model.groups[1]!.rows[0]).toEqual({ functionName: "Contoso.AccountForm.onSave", library: "cr1ff_accountcreditlimittest", enabled: true, internal: false });
    expect(model.headline).toBe("3 handlers are registered on this form: 2 loaded by the platform.");
  });

  it("makes exactly one request, the form definition query the checklist already makes", async () => {
    const { server, get } = setup();
    await mapOf({ server: { server, get } });
    expect(server.requests).toHaveLength(1);
    expect(decodeURIComponent(server.requests[0]!)).toContain("systemforms?$select=formid,name,formxml&$filter=");
  });
});

describe("the map of the stand-in form", () => {
  it("covers form, column, tab and control events and disabled handlers, in the order the form runs them", async () => {
    const model = await mapOf({ cases: true });
    expect(lines(model)).toEqual([
      "OnLoad: AppCommon.Account.Instance.ra_onload [internal] | Contoso.AccountForm.onLoad | Contoso.AccountForm.oldOnLoad [disabled]",
      "OnSave: Contoso.AccountForm.onSave",
      "OnChange: creditlimit: Contoso.AccountForm.onCreditLimitChange | Contoso.AccountForm.audit [disabled]",
      "OnChange: telephone1: Contoso.AccountForm.onPhoneChange",
      "Tab SUMMARY_TAB: TabStateChange: Contoso.AccountForm.onTabState",
      "Control primarycontactid: PreSearch: Contoso.AccountForm.filterContacts",
    ]);
    expect(model.headline).toBe("9 handlers are registered on this form: 2 disabled, 1 loaded by the platform.");
    expect(model.groups[2]!.rows.map((row) => row.library)).toEqual(["cr1ff_accountcreditlimittest", "cr1ff_accountaudit"]);
  });

  it("resolves a control's id even though its events come before the control in the definition", () => {
    const form = fixture<{ value: Array<{ formxml: string }> }>("forms-account-events").value[0]!;
    const control = parseFormXml(form.formxml).allHandlers.find((handler) => handler.scope === "control");
    expect(control).toMatchObject({ control: "primarycontactid", controlColumn: "primarycontactid", event: "presearch" });
  });

  it("leaves the checklist's list as it was: enabled handlers only", () => {
    const form = fixture<{ value: Array<{ formxml: string }> }>("forms-account-events").value[0]!;
    const parsed = parseFormXml(form.formxml);
    expect(parsed.allHandlers).toHaveLength(9);
    expect(parsed.handlers).toHaveLength(7);
    expect(parsed.handlers.every((handler) => handler.enabled)).toBe(true);
    expect(parsed.complete).toBe(true);
  });
});

describe("absence is not evidence", () => {
  const unknown = (model: EventMapModel) => {
    expect(model.kind).toBe("unknown");
    expect(model.groups).toEqual([]);
    expect(model.headline).not.toMatch(/no handlers|0 handlers/i);
  };

  it("is unknown when the page did not say which form is open", async () => {
    const model = await mapOf({ formId: null });
    unknown(model);
    expect(model.headline).toBe("The page did not say which form is open, so Lite could not read its handlers.");
  });

  it("says it has no access when the read is forbidden", async () => {
    const server = setup();
    server.server.failWhen("systemforms", 403);
    const model = await mapOf({ server });
    unknown(model);
    expect(model.headline).toBe("You don't have access to form definitions.");
  });

  it("is unknown when the read fails", async () => {
    const server = setup();
    server.server.failWhen("systemforms", 500);
    unknown(await mapOf({ server }));
  });

  it("is unknown when Dataverse returns no row for the form", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [] });
    unknown(await mapOf({ server }));
  });

  it("is unknown when the answer is a partial list", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: "<form />" }], "@odata.nextLink": `${ORIGIN}/api/data/v9.2/systemforms?$skiptoken=x` });
    unknown(await mapOf({ server }));
  });

  it("is unknown when the definition has no content", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: null }] });
    unknown(await mapOf({ server }));
  });

  it("is unknown when the definition is cut short", async () => {
    const full = fixture<{ value: Array<{ formxml: string }> }>("forms-account-main").value[0]!.formxml;
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: full.slice(0, full.length - 200) }] });
    unknown(await mapOf({ server }));
  });

  it("says a form has no handlers only when the whole definition was read", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: FORM_ID, name: "Account", formxml: `<form><tabs><tab name="a"><columns /></tab></tabs></form>` }] });
    const model = await mapOf({ server });
    expect(model).toMatchObject({ kind: "known", groups: [], headline: "This form's definition registers no handlers." });
  });
});

describe("parsing the definition", () => {
  it("is complete only for one balanced form element", () => {
    expect(parseFormXml("<form><tabs /></form>").complete).toBe(true);
    expect(parseFormXml("<form><tabs>").complete).toBe(false);
    expect(parseFormXml("<form></form><form></form>").complete).toBe(false);
    expect(parseFormXml("<tabs></tabs>").complete).toBe(false);
    expect(parseFormXml("<form><a></b></form>").complete).toBe(false);
  });

  it("ignores comments, CDATA and quoted angle brackets", () => {
    const parsed = parseFormXml(
      `<form><!-- <event name="onload"> --><events><event name="onsave"><Handlers><Handler functionName="a" libraryName="x&gt;y" parameters="1 > 0" /></Handlers></event></events><x><![CDATA[<form>]]></x></form>`,
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.allHandlers).toMatchObject([{ event: "onsave", functionName: "a", library: "x>y", scope: "form" }]);
  });

  it("handles an event with no handlers and a self-closing event", () => {
    const parsed = parseFormXml(`<form><events><event name="onload" /><event name="onsave"><Handlers /></event></events></form>`);
    expect(parsed.allHandlers).toEqual([]);
    expect(parsed.complete).toBe(true);
  });
});

describe("the headline", () => {
  it("counts in platform terms", () => {
    expect(headlineFor([])).toBe("This form's definition registers no handlers.");
  });
});

describe("copy and footer", () => {
  it("carries the one footer line, and none when tips are off", async () => {
    expect((await mapOf()).tip).toEqual(EVENT_MAP_TIP);
    expect(EVENT_MAP_TIP.href).toBe(PATHIX_SITE);
    expect((await mapOf({ showTips: false })).tip).toBeNull();
    expect((await mapOf({ formId: null, showTips: false })).tip).toBeNull();
  });

  it("never says writers, shows no Pathix number and uses no em dash", async () => {
    for (const model of [await mapOf(), await mapOf({ cases: true }), await mapOf({ formId: null })]) {
      const text = JSON.stringify({ ...model, groups: [] });
      expect(text).not.toMatch(/writers?\b/i);
      expect(text).not.toMatch(/Pathix found/);
      expect(text).not.toContain("—");
    }
  });

  it("says what the map cannot see", async () => {
    expect((await mapOf()).info).toContain(
      "A handler that a script adds at run time, for example with addOnChange, is not in the definition and is not listed.",
    );
  });
});

describe("the panel and its controller", () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const view = strip(readFileSync("src/content/event-map-view.ts", "utf8"));
  const controller = strip(readFileSync("src/content/event-map-controller.ts", "utf8"));

  it("is our own element in a closed shadow root and sets text only through textContent", () => {
    expect(view).toContain('attachShadow({ mode: "closed" })');
    expect(view).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(view).toMatch(/\.textContent = /);
  });

  it("makes no network call, reads no page text and never touches the bridge or storage", () => {
    for (const text of [view, controller]) {
      expect(text).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|chrome\.|localStorage|document\.cookie/);
      expect(text).not.toMatch(/\.textContent(?!\s*=[^=])/);
    }
  });

  it("reads only the table and the form id from the snapshot", () => {
    const reads = [...controller.matchAll(/snapshot\.(\w+)/g)].map((match) => match[1]);
    // host rides along only to ask the worker which Pathix environment this org is.
    expect(new Set(reads)).toEqual(new Set(["organizationId", "host", "table", "formId"]));
  });

  it("every file under src/content that touches the map sits in the list of known files", () => {
    const files = readdirSync("src/content").filter((file) => file.startsWith("event-map"));
    expect(files.sort()).toEqual(["event-map-controller.ts", "event-map-view.ts"]);
  });
});

describe("a long function name", () => {
  // Enough of document to build the name's nodes.
  interface Node {
    tag: string;
    className?: string;
    textContent?: string;
    children: Node[];
    append(...nodes: Node[]): void;
  }
  const node = (tag: string, text?: string): Node => ({
    tag,
    ...(text === undefined ? {} : { textContent: text }),
    children: [],
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    },
  });
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => node(tag), createTextNode: (text: string) => node("#text", text) });
  });
  afterEach(() => void vi.unstubAllGlobals());

  const parts = (name: string) => (functionName(name) as unknown as Node).children.map((child) => (child.tag === "#text" ? child.textContent : `<${child.tag}>`));

  it("may break after each dot and nowhere else, never inside a part", () => {
    expect(parts("Contoso.AccountForm.onLoad")).toEqual(["Contoso.", "<wbr>", "AccountForm.", "<wbr>", "onLoad"]);
  });

  it("has no break when there is no dot", () => {
    expect(parts("onLoad")).toEqual(["onLoad"]);
  });

  it("does not wrap anywhere by CSS, which would break inside a word", () => {
    const view = readFileSync("src/content/event-map-view.ts", "utf8");
    expect(view).not.toContain("overflow-wrap: anywhere");
    expect(view).not.toMatch(/word-break:\s*break-all/);
  });
});

describe("the controller's ordering", () => {
  const snapshot = { organizationId: "org", table: "account", formId: FORM_ID } as unknown as FormSnapshot;
  const model = { kind: "known", formName: "Account", headline: "1 handler", groups: [], info: [], tips: [] } as unknown as EventMapModel;

  function harness(settings: unknown = { mode: "lite", showTips: false }) {
    let resolve: (value: EventMapModel) => void = () => undefined;
    const calls: string[] = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      showMessage: (message: string) => calls.push(`message: ${message}`),
      showMap: () => calls.push("map"),
      hide: () => calls.push("hide"),
    };
    const load = vi.fn(() => new Promise<EventMapModel>((done) => (resolve = done)));
    const sources = {
      settings: async () => (settings ?? undefined) as CardSettings | undefined,
      load,
      connectedMap: async () => undefined,
      hideTips: async () => undefined,
    };
    const controller = new EventMapController(view as unknown as EventMapView, sources);
    return { controller, calls, load, resolve: (value: EventMapModel) => resolve(value) };
  }

  // A connected install whose worker did not answer (the extension was
  // reloaded under an open tab) must not fall back to a Lite map.
  it("says the extension did not answer when the mode is not known, and reads nothing from Dataverse", async () => {
    const { controller, calls, load } = harness(null);
    controller.setSnapshot(snapshot);
    controller.open();
    await new Promise((done) => setTimeout(done, 0));
    expect(load).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("message: The extension did not answer. Reload the page and try again.");
  });

  it("does not draw a map that finishes after the user left the form", async () => {
    const { controller, calls, resolve } = harness();
    controller.setSnapshot(snapshot);
    controller.open();
    await new Promise((done) => setTimeout(done, 0));
    controller.setSnapshot(null);
    resolve(model);
    await new Promise((done) => setTimeout(done, 0));
    expect(calls).not.toContain("map");
    expect(calls.at(-1)).toBe("message: Open a record form to see its event map.");
  });
});
