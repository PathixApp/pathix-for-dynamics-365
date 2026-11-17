// The toolbar popup: the primary way into every form feature (DESIGN.md,
// "Entry points"). Its words and enabled states (src/popup/model.ts), the
// messages it sends and the answer it accepts (src/runtime/messages.ts), and
// the page's structure.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stateForConnection } from "../src/card/states";
import { modeLine } from "../src/options/connection-view";
import { adminStatusLine } from "../src/options/admin-toggle";
import {
  CHECKING_PATHIX,
  LITE_NOTE,
  NO_FORM_NOTE,
  NO_FORM_OR_RELOAD_NOTE,
  NO_SHORTCUT,
  PATHIX_TIMED_OUT,
  popupView,
  RELOAD_NOTE,
  secondaryText,
  tabKindOf,
  USES_PATHIX,
  type ConnectionCheck,
  type PopupInput,
  type TabKind,
} from "../src/popup/model";
import { scanAgeLine } from "../src/runtime/badge";
import { bindingsFrom, shortcutSettingsUrl } from "../src/runtime/commands";
import {
  isConnectionStatus,
  isConnectionStatusAnswer,
  isConnectionStatusQuery,
  isContentCommand,
  isFormState,
  isFormStateQuery,
  isOpenFeatureCommand,
  isSetXrayCommand,
  isToggleXrayCommand,
  type ConnectionStatus,
  type FormState,
} from "../src/runtime/messages";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const connected = (latestCompletedScanAt: string | null): ConnectionStatus => ({
  kind: "connected",
  environmentId: "env-1",
  environmentName: "Contoso Dev",
  latestCompletedScanAt,
});

const SCANNED = connected(new Date(NOW - 3 * DAY).toISOString());

function form(overrides: Partial<FormState> = {}): FormState {
  return { kind: "formState", form: true, xray: false, ...overrides };
}

const answered = (status: ConnectionStatus | null): ConnectionCheck => ({ kind: "answered", status });

/** Keys a user set at the browser's shortcuts page. Only the popup's own command has a suggested key. */
const USER_BINDINGS: PopupInput["bindings"] = {
  "toggle-xray": "Alt+Shift+X",
  "open-event-map": "Alt+Shift+E",
  "open-what-changed": "Alt+Shift+C",
  "open-save-preview": null,
  "open-field-card": null,
};

function input(overrides: Partial<PopupInput> = {}): PopupInput {
  return {
    formState: form(),
    connection: answered(SCANNED),
    tab: "dynamics",
    storedMode: "connected",
    pathixUrl: "https://pathix.contoso.com",
    now: NOW,
    bindings: USER_BINDINGS,
    ...overrides,
  };
}

describe("the popup's connection line", () => {
  it("names the environment and the scan's age when connected, in the badge's words", () => {
    const { connection } = popupView(input());
    expect(connection).toEqual({ heading: "Connected to Contoso Dev", detail: "Latest Completed scan 3 days ago", tone: "ok", openOptions: false });
    expect(connection.detail).toBe(scanAgeLine(SCANNED.kind === "connected" ? SCANNED.latestCompletedScanAt : null, NOW));
  });

  it("says Lite in the options page's words, whatever the tab answered", () => {
    const lite = modeLine("lite", null);
    expect(popupView(input({ storedMode: "lite", formState: null })).connection.heading).toBe(lite);
    expect(popupView(input({ storedMode: "lite", connection: answered({ kind: "notConfigured" }) })).connection).toEqual({
      heading: lite,
      detail: null,
      tone: "neutral",
      openOptions: false,
    });
  });

  it("takes the mode from storage, read fresh, never from the tab", () => {
    expect(popupView(input({ storedMode: "lite" })).connection.heading).toBe(modeLine("lite", null));
    expect(popupView(input({ storedMode: "connected" })).connection.heading).toBe("Connected to Contoso Dev");
  });

  it.each<[string, ConnectionStatus, boolean, "neutral" | "error"]>([
    ["signed out", { kind: "signedOut", reason: "no token" }, true, "neutral"],
    ["not set up", { kind: "notConfigured" }, true, "neutral"],
    ["refused", { kind: "unauthorized", status: 403 }, false, "error"],
    ["not scanned", { kind: "notScanned" }, false, "neutral"],
    ["unreachable", { kind: "error", message: "down" }, false, "error"],
    ["no Completed scan", connected(null), false, "neutral"],
  ])("uses the card's words when %s, with an options button only where the fix is there", (_label, status, openOptions, tone) => {
    const state = stateForConnection(status)!;
    expect(popupView(input({ connection: answered(status) })).connection).toEqual({ heading: state.title, detail: state.text, tone, openOptions });
  });

  it("says connected mode and asks for a form on a tab with no form", () => {
    const { connection } = popupView(input({ formState: null }));
    expect(connection.heading).toBe(modeLine("connected", "https://pathix.contoso.com"));
    expect(connection.detail).toBe("Open a Dynamics 365 record form to see its environment and scan.");
    expect(connection.openOptions).toBe(false);
  });

  it("says it is checking Pathix while the connection has not come back", () => {
    expect(popupView(input({ connection: { kind: "checking" } })).connection).toEqual({
      heading: modeLine("connected", "https://pathix.contoso.com"),
      detail: CHECKING_PATHIX,
      tone: "neutral",
      openOptions: false,
    });
  });

  it("says Pathix did not answer in time, never 'connected' and never 'no form'", () => {
    const { connection } = popupView(input({ connection: { kind: "timedOut" } }));
    expect(connection.detail).toBe(PATHIX_TIMED_OUT);
    expect(connection.tone).toBe("neutral");
  });

  it("says the extension did not answer when a form is open but no status came back", () => {
    const { connection } = popupView(input({ connection: answered(null) }));
    expect(connection.detail).toMatch(/did not answer/);
  });
});

describe("the popup's form section", () => {
  it("enables X-ray and every button on an open form when connected, each with the browser's current key", () => {
    const { form: view } = popupView(input());
    expect(view.enabled).toBe(true);
    expect(view.note).toBeNull();
    expect(view.xray).toEqual({ on: false, enabled: true, shortcut: "Alt+Shift+X", reason: null });
    expect(view.actions).toEqual([
      { command: "openEventMap", label: "Event map", shortcut: "Alt+Shift+E", enabled: true, reason: null },
      { command: "openWhatChanged", label: "What changed", shortcut: "Alt+Shift+C", enabled: true, reason: null },
      { command: "openSavePreview", label: "Save preview", shortcut: null, enabled: true, reason: null },
      { command: "openFieldCard", label: "Card for the selected field", shortcut: null, enabled: true, reason: null },
    ]);
  });

  it.each<[string, ConnectionCheck]>([
    ["while Pathix is still being checked", { kind: "checking" }],
    ["when Pathix did not answer in time", { kind: "timedOut" }],
    ["when Pathix could not be reached", answered({ kind: "error", message: "down" })],
  ])("keeps every form action usable %s", (_label, connection) => {
    const view = popupView(input({ connection })).form;
    expect(view.enabled).toBe(true);
    expect(view.xray.enabled).toBe(true);
    for (const action of view.actions) expect(action.enabled).toBe(true);
  });

  it("shows a key the user set in the browser, and 'No shortcut' for one they cleared", () => {
    const view = popupView(input({ bindings: { "toggle-xray": "", "open-save-preview": "Ctrl+Shift+9" } as never })).form;
    expect(view.actions.find((action) => action.command === "openSavePreview")!.shortcut).toBe("Ctrl+Shift+9");
    // bindingsFrom turns the browser's empty string into null; a missing entry reads the same.
    expect(popupView(input({ bindings: bindingsFrom([{ name: "toggle-xray", shortcut: "" }]) })).form.xray.shortcut).toBeNull();
    expect(popupView(input({ bindings: {} })).form.actions.map((action) => action.shortcut)).toEqual([null, null, null, null]);
    expect(popupView(input({ bindings: { "open-field-card": "Ctrl+Shift+8" } })).form.actions.find((action) => action.command === "openFieldCard")!.shortcut).toBe("Ctrl+Shift+8");
  });

  it("writes the secondary line as the reason, else the key, else 'No shortcut'", () => {
    expect(secondaryText("Alt+Shift+E")).toBe("Alt+Shift+E");
    expect(secondaryText(null)).toBe(NO_SHORTCUT);
    expect(NO_SHORTCUT).toBe("No shortcut");
    expect(secondaryText("Alt+Shift+E", USES_PATHIX)).toBe("Uses your organization's Pathix");
  });

  it("reflects X-ray's current state", () => {
    expect(popupView(input({ formState: form({ xray: true }) })).form.xray.on).toBe(true);
  });

  it("disables X-ray and Save preview alike in Lite, with the same neutral reason and one line about Options", () => {
    const view = popupView(input({ storedMode: "lite" })).form;
    const save = view.actions.find((action) => action.command === "openSavePreview")!;
    expect(save).toMatchObject({ enabled: false, reason: USES_PATHIX });
    expect(view.xray).toMatchObject({ enabled: false, on: false, reason: USES_PATHIX });
    // The field card reads Dataverse in Lite: it stays usable.
    expect(view.actions.filter((action) => action.enabled).map((action) => action.command)).toEqual(["openEventMap", "openWhatChanged", "openFieldCard"]);
    expect(view.note).toBe(LITE_NOTE);
    expect(LITE_NOTE).toBe("X-ray and Save preview use your organization's Pathix. Set its address in Options.");
    // Copy rules: no upgrade nudge.
    for (const text of [USES_PATHIX, LITE_NOTE]) expect(text).not.toMatch(/upgrade|buy|unlock|pro\b/i);
  });

  it("in Lite, still lets an X-ray that is already on be turned off", () => {
    expect(popupView(input({ storedMode: "lite", formState: form({ xray: true }) })).form.xray).toMatchObject({ on: true, enabled: true });
  });

  it.each<[string, FormState | null, TabKind, string]>([
    ["a page that is not D365", null, "other", NO_FORM_NOTE],
    ["a D365 page with no record form", form({ form: false, xray: true }), "dynamics", NO_FORM_NOTE],
    ["a D365 page whose content script did not answer (the extension was reloaded)", null, "dynamics", RELOAD_NOTE],
    ["a page whose address the browser did not give", null, "unknown", NO_FORM_OR_RELOAD_NOTE],
  ])("disables every control, without hiding it, on %s, and says why", (_label, formState, tab, note) => {
    const view = popupView(input({ formState, tab })).form;
    expect(view.enabled).toBe(false);
    expect(view.note).toBe(note);
    expect(view.xray).toMatchObject({ on: false, enabled: false });
    expect(view.actions).toHaveLength(4);
    for (const action of view.actions) expect(action.enabled).toBe(false);
  });

  it("says which form to open, or to reload, in one line", () => {
    expect(NO_FORM_NOTE).toBe("Open a Dynamics 365 record form to use these.");
    expect(RELOAD_NOTE).toBe("Reload this page to use Pathix on it.");
    expect(NO_FORM_OR_RELOAD_NOTE).toBe(
      "Open a Dynamics 365 record form to use these. If one is open, reload the page. US Government (GCC High and DoD) and China clouds are not supported yet.",
    );
  });

  // D3: the extension acts only on <org>.crm*.dynamics.com. The popup cannot
  // see the tab's address, so where the tab did not answer it also says which
  // clouds the extension does not run on yet.
  it("says the GCC High, DoD and China clouds are not supported where the tab did not answer", () => {
    expect(popupView(input({ formState: null, tab: "unknown" })).form.note).toContain("US Government (GCC High and DoD) and China clouds are not supported yet.");
    expect(popupView(input({ formState: form({ form: false, xray: false }), tab: "dynamics" })).form.note).not.toContain("Government");
  });

  it.each<[string | undefined, TabKind]>([
    ["https://contoso.crm.dynamics.com/main.aspx?etn=account&id=1", "dynamics"],
    ["https://contoso.crm4.dynamics.com/", "dynamics"],
    ["http://contoso.crm.dynamics.com/", "other"],
    ["https://dynamics.com.evil.example/", "other"],
    // The content script does nothing on dynamics.com pages that are not an org: they never answer, and are not told to reload.
    ["https://businesscentral.dynamics.com/", "other"],
    ["https://contoso.operations.dynamics.com/", "other"],
    ["https://contoso.crm.microsoftdynamics.us/", "other"],
    ["https://pathix.contoso.com/", "other"],
    ["chrome://extensions/", "other"],
    [undefined, "unknown"],
    ["", "unknown"],
    ["not a url", "unknown"],
  ])("reads %s as %s, from the host only", (url, kind) => {
    expect(tabKindOf(url)).toBe(kind);
  });
});

describe("the popup's messages", () => {
  it.each(["openEventMap", "openWhatChanged", "openSavePreview", "openFieldCard"])("accepts %s with nothing else on it", (kind) => {
    expect(isOpenFeatureCommand({ kind })).toBe(true);
    expect(isContentCommand({ kind })).toBe(true);
    expect(isOpenFeatureCommand({ kind, table: "account" })).toBe(false);
  });

  it("accepts toggleXray with nothing else on it", () => {
    expect(isToggleXrayCommand({ kind: "toggleXray" })).toBe(true);
    expect(isContentCommand({ kind: "toggleXray" })).toBe(true);
    expect(isToggleXrayCommand({ kind: "toggleXray", on: true })).toBe(false);
  });

  it("accepts setXray only with a boolean", () => {
    expect(isSetXrayCommand({ kind: "setXray", on: true })).toBe(true);
    expect(isSetXrayCommand({ kind: "setXray", on: false })).toBe(true);
    expect(isSetXrayCommand({ kind: "setXray", on: "true" })).toBe(false);
    expect(isSetXrayCommand({ kind: "setXray" })).toBe(false);
    expect(isSetXrayCommand({ kind: "setXray", on: true, extra: 1 })).toBe(false);
  });

  it("accepts the form state query with nothing else on it", () => {
    expect(isFormStateQuery({ kind: "formState" })).toBe(true);
    expect(isFormStateQuery({ kind: "formState", url: "https://x" })).toBe(false);
  });

  it.each([null, undefined, "openEventMap", [], { kind: "openOptions" }, { kind: "refreshBadge" }])("refuses %j", (value) => {
    expect(isContentCommand(value)).toBe(false);
  });

  it("accepts a well-formed form state", () => {
    expect(isFormState(form())).toBe(true);
    expect(isFormState(form({ form: false, xray: true }))).toBe(true);
  });

  it("accepts the connection query and a well-formed answer", () => {
    expect(isConnectionStatusQuery({ kind: "connectionStatus" })).toBe(true);
    expect(isContentCommand({ kind: "connectionStatus" })).toBe(true);
    expect(isConnectionStatusQuery({ kind: "connectionStatus", host: "x" })).toBe(false);
    expect(isConnectionStatusAnswer({ kind: "connectionStatus", connection: SCANNED })).toBe(true);
    expect(isConnectionStatusAnswer({ kind: "connectionStatus", connection: null })).toBe(true);
    expect(isConnectionStatusAnswer({ kind: "connectionStatus", connection: { kind: "connected", environmentName: "x" } })).toBe(false);
    expect(isConnectionStatusAnswer({ kind: "connectionStatus", connection: { kind: "notScanned", note: "x" } })).toBe(false);
    expect(isConnectionStatusAnswer({ kind: "connectionStatus", connection: null, url: "https://x" })).toBe(false);
  });

  it.each<[string, unknown]>([
    ["an extra field", { ...form(), url: "https://contoso.crm.dynamics.com/main.aspx?id=1" }],
    ["a missing field", { kind: "formState", form: true }],
    ["a mode riding along", { ...form(), mode: "lite" }],
    ["a non-boolean form", { ...form(), form: "yes" }],
    ["an unknown mode", { ...form(), mode: "pro" }],
    ["a connection riding along", { ...form(), connection: null }],
  ])("refuses a form state with %s", (_label, value) => {
    expect(isFormState(value)).toBe(false);
  });

  it.each<ConnectionStatus>([
    { kind: "notConfigured" },
    { kind: "signedOut", reason: "x" },
    { kind: "unauthorized", status: 401 },
    { kind: "notScanned" },
    connected(null),
    connected("2026-10-01T00:00:00Z"),
    { kind: "error", message: "down" },
  ])("accepts the connection status %j", (status) => {
    expect(isConnectionStatus(status)).toBe(true);
  });

  it.each<ConnectionStatus>([
    { kind: "notScanned", otherHost: "contoso.crm4.dynamics.com" },
    { kind: "notScanned", noAddress: true },
    { kind: "connected", environmentId: "e", environmentName: "Dev", latestCompletedScanAt: null, latestCompletedScanUnknown: true },
    {
      kind: "connected",
      environmentId: "e",
      environmentName: "Dev",
      latestCompletedScanAt: "2026-10-01T00:00:00Z",
      latestCompletedScanStartedAt: "2026-10-01T00:00:00Z",
      excludedTables: ["account", "contact"],
    },
  ])("accepts the optional fields the worker sends: %j", (status) => {
    expect(isConnectionStatus(status)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an otherHost that is not a host", { kind: "notScanned", otherHost: "https://x/y" }],
    ["a noAddress that is not true", { kind: "notScanned", noAddress: false }],
    ["both another host and no address", { kind: "notScanned", otherHost: "contoso.crm4.dynamics.com", noAddress: true }],
    ["a latestCompletedScanUnknown that is not true", { ...SCANNED, latestCompletedScanUnknown: false }],
    ["excluded tables that are not logical names", { ...SCANNED, excludedTables: ["Account Name"] }],
    ["a missing required field", { kind: "connected", environmentId: "e", environmentName: "Dev" }],
    ["an unknown field", { ...SCANNED, record: "x" }],
  ])("refuses a connection status with %s", (_label, status) => {
    expect(isConnectionStatus(status)).toBe(false);
  });

  it("refuses a connection status with an unknown kind or a very long text", () => {
    expect(isConnectionStatus({ kind: "maybe" })).toBe(false);
    expect(isConnectionStatus({ kind: "error", message: "x".repeat(5000) })).toBe(false);
  });
});

describe("the shortcut settings link", () => {
  const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  it("opens Edge's page in Edge, from the brands or the user agent", () => {
    expect(shortcutSettingsUrl([{ brand: "Microsoft Edge" }, { brand: "Chromium" }], CHROME_UA)).toBe("edge://extensions/shortcuts");
    expect(shortcutSettingsUrl(undefined, EDGE_UA)).toBe("edge://extensions/shortcuts");
  });

  it("opens Chrome's page in Chrome, from the brands or the user agent", () => {
    expect(shortcutSettingsUrl([{ brand: "Google Chrome" }, { brand: "Chromium" }], EDGE_UA)).toBe("chrome://extensions/shortcuts");
    expect(shortcutSettingsUrl(undefined, CHROME_UA)).toBe("chrome://extensions/shortcuts");
  });

  it("is one line in the popup, under the form's buttons", () => {
    expect(readFileSync("static/popup.html", "utf8")).toContain('<button id="shortcut-settings" type="button" class="link">Change keyboard shortcuts</button>');
    expect(readFileSync("src/popup/popup.ts", "utf8")).toContain("chrome.tabs.create({ url: shortcutSettingsUrl(brands, navigator.userAgent) })");
  });

  it("reads the keys from the browser, never from a list of its own", () => {
    expect(readFileSync("src/popup/popup.ts", "utf8")).toContain("bindingsFrom(await chrome.commands.getAll())");
  });
});

describe("the popup page", () => {
  const html = readFileSync("static/popup.html", "utf8");
  const script = readFileSync("src/popup/popup.ts", "utf8");

  it("is built and loaded like the options page", () => {
    expect(readFileSync("build.mjs", "utf8")).toContain('popup: "src/popup/popup.ts"');
    expect(html).toContain('<script src="popup.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="options.css" />');
  });

  it("uses real switches and buttons, labelled in words", () => {
    for (const id of ["xray", "admin-overlay"]) {
      expect(html).toMatch(new RegExp(`<button id="${id}" type="button" role="switch" aria-checked="false" aria-labelledby="[a-z-]+"`));
    }
    expect(html.match(/<button type="button" class="feature" data-command="open(EventMap|WhatChanged|SavePreview|FieldCard)" disabled><\/button>/g)).toHaveLength(4);
    expect(html).toContain('>Options</button>');
    expect(html).toContain('>Open demo</button>');
    expect(html).toContain('lang="en-US"');
  });

  it("shows the form controls disabled, never hidden, until the tab answers", () => {
    expect(html).not.toMatch(/id="xray"[^>]*hidden/);
    expect(html).not.toMatch(/class="feature"[^>]*hidden/);
  });

  it("finds the tab without the tabs permission and opens the demo itself", () => {
    expect(script).toContain("chrome.tabs.query({ active: true, currentWindow: true })");
    expect(script).toContain('const DEMO_PAGE = "demo.html";');
    expect(script).toContain("chrome.tabs.create({ url: chrome.runtime.getURL(DEMO_PAGE) })");
    // From the tab: its id, and its address, which the session reads only through tabKindOf (the host). Never the title.
    expect(script.match(/tab\??\.(id|url|title|pendingUrl|favIconUrl)/g)).toEqual(["tab.id", "tab.url"]);
    const session = readFileSync("src/popup/session.ts", "utf8");
    expect(session.match(/tab\??\.(url|title|pendingUrl|favIconUrl)/g)).toEqual(["tab?.url"]);
    expect(session).toContain("tab: tabKindOf(tab?.url)");
  });

  it("checks the tab's answers before using them", () => {
    const session = readFileSync("src/popup/session.ts", "utf8");
    expect(session).toContain("isFormState(answer) ? answer : null");
    expect(session).toContain("isConnectionStatusAnswer(answer)");
  });

  it("shares the admin overlay switch's logic and words with the options page", () => {
    expect(script).toMatch(/import \{ adminStatusLine, chromeToggleDeps, chromeWatchDeps, turnOverlayOff, turnOverlayOn, watchOverlayStatus/);
    expect(readFileSync("src/options/options.ts", "utf8")).toMatch(/import \{ adminStatusLine, chromeToggleDeps, chromeWatchDeps, turnOverlayOff, turnOverlayOn, watchOverlayStatus/);
    // Both keep the switch true to a permission removed or granted in the browser's own settings.
    for (const page of [script, readFileSync("src/options/options.ts", "utf8")]) {
      expect(page).toMatch(/const adminWatch = watchOverlayStatus\(chromeWatchDeps\(chrome\), /);
      // The toggle supersedes an answer asked before it, so that answer cannot land after the toggle's result.
      expect(page).toMatch(/\.disabled = true;\s*adminWatch\.supersede\(\);/);
      // The first read goes through the watch too, so the toggle supersedes it.
      expect(page).toContain("adminWatch.refresh();");
      expect(page).not.toMatch(/void adminDeps\.status\(\)|refreshAdminOverlay/);
    }
    expect(adminStatusLine({ enabled: true, registered: true, error: null } as never)).toEqual({
      on: true,
      text: "On. Reload open admin center tabs to see it.",
      tone: "ok",
    });
  });

  it("writes its copy without em dashes, and marks the product name", () => {
    for (const text of [html, script, readFileSync("src/popup/model.ts", "utf8")]) expect(text).not.toContain("—");
    expect(html).toContain("Pathix™ for Dynamics 365");
    expect(html).not.toContain("®");
  });
});
