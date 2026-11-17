// Smoke test for the save preview (M12), driven in real Chromium.
//
// The real preview is connected-only and needs a Pathix to answer, which this
// smoke does not have (the Lite path, with the real extension, is in
// lite.smoke.ts). So this bundles the same modules the content script uses
// (the controller, the view and the model builder) and runs them against a fake
// model-driven form, with a HAND-WRITTEN answer in the shape of the contract
// (GET /tables/{logicalName}/save-pipeline). It checks what only
// a browser can: that the controller's open() opens the panel, that it sits in a closed
// shadow root, that it reads as one timeline in the order Pathix sends the
// lanes, that the save marker sits at the main operation lane, that Microsoft's
// internal stage and the deprecated stage are lanes with tags, that the folds
// open (a lane of only Microsoft entries is one line), that editing a column
// asks again with names only, and that Escape closes it.

import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

let browser: Browser;
let bundle: string;

test.beforeAll(async () => {
  const executablePath = process.env.PATHIX_SMOKE_CHROMIUM;
  if (executablePath && !existsSync(executablePath)) throw new Error(`No browser at ${executablePath}.`);
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chromium" });
  const result = await build({
    stdin: {
      contents: `
        export { SavePreviewController } from "./src/content/save-preview-controller";
        export { SavePreviewView } from "./src/content/save-preview-view";
        export { buildSavePreview } from "./src/card/save-preview";`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "PathixSavePreview",
    target: "chrome113",
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

test.afterAll(async () => {
  await browser?.close();
});

const IDS = { org: "5c4a0000-0000-4000-8000-000000000003", form: "5c4a0000-0000-4000-8000-000000000021" };

// HAND-WRITTEN: no real answer is captured yet. Every kind of entry and marker is in it once.
const entry = (name: string, extra: Record<string, unknown> = {}, trigger: Record<string, unknown> = {}) => ({
  componentId: "5c4a0000-0000-4000-8000-000000000100",
  componentName: name,
  componentType: "PluginStep",
  isSystem: false,
  trigger: { message: "Update", stage: "PostOperation", executionMode: "Synchronous", table: "account", filteringColumns: ["creditlimit"], firesOnEveryUpdate: false, hasRowFilter: null, ...trigger },
  matchedColumns: ["creditlimit"],
  executionOrder: 1,
  orderUnknown: false,
  tiedOrder: false,
  allTables: false,
  conditional: false,
  rowFilterUnknown: false,
  ...extra,
});

const ANSWER = {
  table: "account",
  message: "Update",
  columns: ["creditlimit", "name"],
  browseMode: false,
  scope: { environmentId: "5c4a0000-0000-4000-8000-000000000001", scanId: "5c4a0000-0000-4000-8000-000000000002", scannedAt: "2026-10-03T02:30:00Z" },
  // One timeline: a lane per stage present, in the order Pathix sends them, Asynchronous last.
  lanes: [
    { lane: "PreValidation", stage: 10, kind: "pipeline", ordered: true, entries: [entry("Validate owner", {}, { stage: "PreValidation" })] },
    {
      lane: "InternalPreOperationBeforeExternalPlugins",
      stage: 15,
      kind: "platformInternal",
      ordered: true,
      entries: [
        entry("Platform pre A", { isSystem: true, executionOrder: 1 }, { stage: "InternalPreOperationBeforeExternalPlugins" }),
        entry("Platform pre B", { isSystem: true, executionOrder: 2 }, { stage: "InternalPreOperationBeforeExternalPlugins" }),
      ],
    },
    { lane: "PreOperation", stage: 20, kind: "pipeline", ordered: true, entries: [entry("Default region", { executionOrder: 1, tiedOrder: true }), entry("Default currency", { executionOrder: 1, tiedOrder: true }), entry("Real-time workflow", { componentType: "ClassicWorkflow", executionOrder: null, orderUnknown: true })] },
    { lane: "MainOperation", stage: 30, kind: "mainOperation", ordered: true, entries: [entry("Main step", { executionOrder: 1 }, { stage: "MainOperation" })] },
    { lane: "PostOperation", stage: 40, kind: "pipeline", ordered: true, entries: [entry("Notify sales", { executionOrder: 5, allTables: true }), entry("Platform audit", { isSystem: true, executionOrder: 9 })] },
    { lane: "PostOperationDeprecated", stage: 50, kind: "deprecated", ordered: true, entries: [entry("Legacy customer step", { executionOrder: 1 }, { stage: "PostOperationDeprecated" })] },
    { lane: "Asynchronous", stage: null, kind: "asynchronous", ordered: false, entries: [entry("Sync to ERP", { componentType: "ModernFlow", executionOrder: null, conditional: true }), entry("Index record", { componentType: "ModernFlow", executionOrder: null, rowFilterUnknown: true, matchedColumns: null }, { firesOnEveryUpdate: true, filteringColumns: [] })] },
  ],
  unplaced: [entry("Stage unknown step", { executionOrder: null, orderUnknown: true }, { stage: null, executionMode: null })],
  serverBusinessRules: [{ componentId: "5c4a0000-0000-4000-8000-000000000005", componentName: "Lock closed accounts", isSystem: false }],
  excludedDisabled: 2,
  clientLayer: {
    formId: IDS.form,
    coverage: "modeled",
    notModeledReason: null,
    ordered: false,
    handlers: [{ library: "new_/account.js", function: "Account.onSave", isEnabled: true, isPlatformLoaded: false, scriptComponentId: null }],
  },
  disclosures: ["registeredNotWrites", "asyncUnordered", "cascadesNotFollowed", "platformFeaturesNotListed", "flowScopeNotModeled", "clientOrderNotKept"],
};

const SNAPSHOT = {
  organizationId: IDS.org,
  host: "contoso.crm.dynamics.com",
  table: "account",
  formId: IDS.form,
  saveKind: "update",
  dirtyColumns: ["name"],
  alwaysSubmitColumns: ["creditlimit"],
};

/** What the popup's button and the keyboard command both reach: the controller's open(). */
async function openPreview(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { controller: { open(): void } }).controller.open());
}

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><main id="form" style="padding:24px"><input id="field" value="sample value" /></main></body></html>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ answer, snapshot }) => {
      const w = window as unknown as Record<string, any>;
      const lib = w.PathixSavePreview;
      w.requests = [];
      w.answer = answer;
      w.failNext = false;
      const context = { environmentName: "Contoso", scanCompletedAt: "2026-10-03T02:30:00Z", table: "account", message: "Update", columnsSent: ["creditlimit", "name"], columnsWithheld: 0, formRequested: true, formatDate: () => "Oct 2" };
      w.controller = new lib.SavePreviewController(new lib.SavePreviewView(), {
        settings: async () => ({ mode: "connected", showTips: true }),
        savePreview: async (request: unknown) => {
          w.requests.push(request);
          const data = w.failNext ? null : w.answer;
          return { kind: "savePreview", model: lib.buildSavePreview(context, w.failNext ? { kind: "failed", status: 404, detail: "Table account is not in the latest scan." } : { kind: "ok", data }) };
        },
        hideTips: async () => undefined,
      });
      w.controller.attach();
      w.controller.setSnapshot(snapshot);
    },
    { answer: ANSWER, snapshot: SNAPSHOT },
  );
  return page;
}

/** Every text node on the page, closed shadow roots included, read through the DevTools protocol. */
async function screenText(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  const texts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 3 && node.parentName !== "STYLE" && node.parentName !== "SCRIPT") texts.push(node.nodeValue ?? "");
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk({ ...child, parentName: node.nodeName });
  };
  walk(root);
  return texts.join("\n");
}

interface DomNode {
  backendNodeId?: number;
  attributes?: string[];
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentName?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/** The aria-expanded value of every fold toggle in the panel, in page order. */
async function expandStates(page: Page): Promise<Array<string | undefined>> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  const states: Array<string | undefined> = [];
  const walk = (node: DomNode) => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf("class");
    if (at !== -1 && attributes[at + 1]?.split(" ").includes("expand")) {
      const expanded = attributes.indexOf("aria-expanded");
      states.push(expanded === -1 ? undefined : attributes[expanded + 1]);
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return states;
}

/** Clicks the nth element (the first by default) with this class inside the panel's closed shadow root, with a real mouse click. */
async function clickByClass(page: Page, className: string, nth = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const matches: DomNode[] = [];
  const find = (node: DomNode) => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf("class");
    if (at !== -1 && attributes[at + 1]?.split(" ").includes(className)) matches.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) find(child);
  };
  find(root);
  const target = matches[nth];
  if (!target?.backendNodeId) throw new Error(`No .${className} in the page.`);
  // The panel scrolls, so bring the toggle into view before measuring where to click.
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId });
  const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: target.backendNodeId })) as { model: { content: number[] } };
  await cdp.detach();
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

const at = (text: string, needle: string): number => {
  const index = text.indexOf(needle);
  expect(index, `"${needle}" is on the panel`).toBeGreaterThanOrEqual(0);
  return index;
};

test("open() opens the preview in a closed shadow root and Escape closes it", async () => {
  const page = await openPage();
  await openPreview(page);
  await expect(page.locator("pathix-save-preview")).toHaveCount(1);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("registered to fire on the server");
  // Closed: the page's own script cannot reach into it.
  expect(await page.evaluate(() => document.querySelector("pathix-save-preview")!.shadowRoot)).toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-save-preview")).toHaveCount(0);
  await openPreview(page);
  await expect(page.locator("pathix-save-preview")).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { controller: { close(): void } }).controller.close());
  await expect(page.locator("pathix-save-preview")).toHaveCount(0);
  await page.close();
});

test("reads as one timeline in the order Pathix sends the lanes, with the save at the main operation", async () => {
  const page = await openPage();
  await openPreview(page);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Notify sales");
  const text = await screenText(page);

  const order = [
    "Client: OnSave handlers on this form",
    "Account.onSave",
    "Pre-validation",
    "Validate owner",
    "Internal pre-operation, before external plugins",
    "Microsoft internal stage 15",
    "Pre-operation",
    "Default region",
    "The record is saved",
    "Main operation",
    "Main step",
    "Post-operation",
    "Notify sales",
    "Post-operation (deprecated)",
    "deprecated post-operation stage 50",
    "Legacy customer step",
    "Asynchronous",
    "Sync to ERP",
    "Business rules on the server",
    "Lock closed accounts",
    "Position unknown",
    "Stage unknown step",
    "What this does not show",
  ].map((needle) => at(text, needle));
  expect(order).toEqual([...order].sort((a, b) => a - b));

  // The headline: the form handler, twelve in the lanes and one with no stage, a rule, and the disabled ones.
  expect(text).toContain("1 form OnSave handler, 13 registered to fire on the server, 1 entity business rule on the server, and 2 disabled.");
  // The edits it was matched against, labelled live.
  expect(text).toContain("live");
  expect(text).toContain("Update. Matched on the columns this save sends:");
  // Each logical name is its own node, set in code style.
  expect(text).toContain("creditlimit\n, \nname");
  await page.close();
});

test("writes every marker as text, marks the asynchronous lane unordered, and renders every disclosure code", async () => {
  const page = await openPage();
  await openPreview(page);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Notify sales");
  const text = await screenText(page);

  for (const marker of ["tied order", "Order unknown", "all tables", "row filter set", "row filter unknown", "unordered", "No order. These are not a sequence.", "Registered at post operation"]) {
    expect(text, marker).toContain(marker);
  }
  expect(text).toContain("Matched: creditlimit");
  expect(text).toContain("Fires on any update");
  // The client layer is not a sequence: Pathix does not keep the order.
  expect(text).toContain("Not a sequence: Pathix does not keep the order of a form's handlers.");

  for (const sentence of [
    "Registered to fire is not the same as writes.",
    "Asynchronous work has no guaranteed order.",
    "Single hop only.",
    "Platform features are not modeled: autonumber, duplicate detection and rollups.",
    "A cloud flow's owner or business unit scope can skip it.",
    "Pathix does not keep the order of a form's handlers within an event",
  ]) {
    expect(text, sentence).toContain(sentence);
  }
  // Nothing on the panel claims a write or a run. Only the two sentences that deny it say the word.
  expect(text.replace(/Registered to fire is not the same as (runs or )?writes\./g, "")).not.toMatch(/\bwrites?\b|will run/i);
  await page.close();
});

test("folds Microsoft-published entries behind one line that opens on a click, a whole lane of them included", async () => {
  const page = await openPage();
  await openPreview(page);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("1 Microsoft-shipped entry");
  // The internal lane holds only Microsoft entries, so it is one line with its count (first toggle). The
  // post-operation lane folds its one Microsoft entry (second toggle). Both start closed.
  expect(await screenText(page)).toContain("2 Microsoft-shipped entries");
  expect(await expandStates(page)).toEqual(["false", "false"]);
  await clickByClass(page, "expand", 0);
  expect(await expandStates(page)).toEqual(["true", "false"]);
  expect(await screenText(page)).toContain("Platform pre A (Order 1");
  await clickByClass(page, "expand", 1);
  expect(await expandStates(page)).toEqual(["true", "true"]);
  expect(await screenText(page)).toContain("Platform audit (Order 9");
  await clickByClass(page, "expand", 0);
  expect(await expandStates(page)).toEqual(["false", "true"]);
  await page.close();
});

test("asks again, with names only, when a column becomes edited", async () => {
  const page = await openPage();
  await openPreview(page);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Notify sales");
  await page.evaluate((snapshot) => {
    const w = window as unknown as { controller: { setSnapshot(s: unknown): void } };
    w.controller.setSnapshot({ ...snapshot, dirtyColumns: ["name", "telephone1"] });
  }, SNAPSHOT);
  await expect.poll(() => page.evaluate(() => (window as unknown as { requests: unknown[] }).requests.length)).toBe(2);
  const requests = await page.evaluate(() => (window as unknown as { requests: unknown[] }).requests);
  expect(requests).toEqual([
    { kind: "savePreview", organizationId: IDS.org, host: "contoso.crm.dynamics.com", table: "account", message: "Update", formId: IDS.form, columns: ["creditlimit", "name"] },
    { kind: "savePreview", organizationId: IDS.org, host: "contoso.crm.dynamics.com", table: "account", message: "Update", formId: IDS.form, columns: ["creditlimit", "name", "telephone1"] },
  ]);
  // Names only: no value, no record id in what was sent.
  expect(JSON.stringify(requests)).not.toContain("sample value");
  await page.close();
});

test("a request that failed reads as unknown, never as nothing fires", async () => {
  const page = await openPage();
  await page.evaluate(() => void ((window as unknown as { failNext: boolean }).failNext = true));
  await openPreview(page);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("does not hold the table account");
  const text = await screenText(page);
  expect(text).toContain("unknown");
  expect(text).not.toMatch(/Nothing is registered|None registered/);
  await page.close();
});
