// Smoke test for the connected form event map (M10): the panel drawn in real
// Chromium from Pathix-shaped answers. The real map is connected-only and needs
// a Pathix to answer, which this smoke does not have, so it bundles the same
// two modules the content script uses (the model builder and the panel view)
// and feeds them hand-written answers in the contract's shape. It checks what
// only a browser can: the panel is our own element in a closed shadow root, and
// what a reader sees on screen for each case: the order numbered only when the
// scan recorded it, disabled and not-stated handlers marked, platform-loaded
// handlers tagged, and an unknown map that never reads as "no handlers".
//
// The Lite map in the extension build is in lite.smoke.ts.

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
        import { EventMapView } from "./src/content/event-map-view";
        import { buildConnectedEventMap } from "./src/card/event-map";
        window.PathixMap = { EventMapView, buildConnectedEventMap };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    target: "chrome113",
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

test.afterAll(async () => {
  await browser?.close();
});

const FORM_ID = "5c4a0000-0000-4000-8000-000000000321";

// Hand-written in the shape of GET /environments/{id}/forms/{formId}/handlers.
const handler = (over: Record<string, unknown>) => ({
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
});

const answer = (handlers: unknown[], over: Record<string, unknown> = {}) => ({
  formId: FORM_ID,
  scope: { environmentId: FORM_ID, scanId: FORM_ID, scannedAt: "2026-10-05T14:30:00Z" },
  coverage: "modeled",
  notModeledReason: null,
  ordered: true,
  handlers,
  ...over,
});

const ORDERED = answer([
  handler({ function: "AppCommon.Account.Instance.ra_onload", library: "AppCommon/Account/Account_main_system_library.js", isPlatformLoaded: true, ordinal: 0 }),
  handler({ function: "Contoso.AccountForm.onLoad", ordinal: 1 }),
  handler({ function: "Contoso.AccountForm.oldOnLoad", isEnabled: false, ordinal: 2 }),
  handler({ event: "onsave", function: "Contoso.AccountForm.onSave", isEnabled: null, ordinal: 3 }),
]);

const UNORDERED = answer(
  [handler({ function: "Contoso.AccountForm.a" }), handler({ function: "Contoso.AccountForm.b" })],
  { ordered: false },
);

async function show(page: Page, read: unknown): Promise<void> {
  await page.evaluate(
    ({ read, formId }) => {
      const w = window as unknown as {
        PathixMap: { EventMapView: new () => { showMap(model: unknown): void }; buildConnectedEventMap(context: unknown, read: unknown): unknown };
        view?: { showMap(model: unknown): void };
      };
      const model = w.PathixMap.buildConnectedEventMap(
        { table: "account", formId, scanCompletedAt: "2026-10-05T14:30:00Z", formatDate: (iso: string) => iso },
        read,
      );
      // One panel per page, redrawn in place, as the controller does.
      w.view ??= new w.PathixMap.EventMapView();
      w.view.showMap(model);
    },
    { read, formId: FORM_ID },
  );
}

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><main>form</main></body></html>`);
  await page.addScriptTag({ content: bundle });
  return page;
}

/**
 * Every text node on the page, closed shadow roots included, read through the
 * DevTools protocol. A function name is one text node per dotted part (it may
 * wrap after each dot), so the parts are joined back.
 */
async function screenText(page: Page): Promise<string> {
  return (await textNodes(page)).replace(/(?<!^\d+)\.\n(?=[A-Za-z_$])/gm, ".");
}

/** The class names and boxes of the panel's nodes with `className`, through the DevTools protocol. */
async function boxes(page: Page, className: string): Promise<Array<{ top: number; height: number }>> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: BoxNode };
  const found: BoxNode[] = [];
  const walk = (node: BoxNode) => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf("class");
    if (at !== -1 && attributes[at + 1]?.split(" ").includes(className)) found.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  const result: Array<{ top: number; height: number }> = [];
  for (const node of found) {
    const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId })) as { model: { content: number[]; height: number } };
    result.push({ top: model.content[1]!, height: model.height });
  }
  await cdp.detach();
  return result;
}

interface BoxNode {
  backendNodeId?: number;
  attributes?: string[];
  children?: BoxNode[];
  shadowRoots?: BoxNode[];
}

/** The accessibility tree's images, by name, as a screen reader is given them. */
async function imageNames(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
  await cdp.detach();
  return nodes.filter((node) => node.role?.value === "image" || node.role?.value === "img").map((node) => node.name?.value ?? "");
}

async function textNodes(page: Page): Promise<string> {
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
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentName?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

test("the connected map numbers the order the scan recorded, marks disabled and not-stated handlers, and tags the platform's own", async () => {
  const page = await openPage();
  await show(page, { kind: "ok", data: ORDERED });
  await expect(page.locator("pathix-event-map")).toHaveCount(1);
  // Closed shadow root: the page's own script cannot reach into it.
  expect(await page.evaluate(() => document.querySelector("pathix-event-map")!.shadowRoot)).toBeNull();

  const text = await screenText(page);
  expect(text).toContain("Form event map");
  expect(text).toContain("As of 2026-10-05T14:30:00Z");
  expect(text).toContain("Pathix's scan found 4 handlers registered on this form: 1 disabled, 1 with enabled not stated, 1 loaded by the platform.");
  expect(text).toContain("AppCommon.Account.Instance.ra_onload");
  expect(text).toContain("internal");
  expect(text).toContain("disabled");
  expect(text).toContain("enabled not stated");
  expect(text).toContain("1.");
  expect(text).toContain("3.");
  // OnSave has one handler: a lone handler is not a sequence, so only OnLoad's three are numbered.
  expect(text.match(/^\d+\.$/gm)).toEqual(["1.", "2.", "3."]);
  // The footer's mark is named for a screen reader.
  expect(await imageNames(page)).toContain("Pathix");
  // Connected: no Lite chip, no Lite footer line.
  expect(text).not.toContain("Lite");
  expect(text).not.toContain("A form definition can't show what a handler does.");
  await page.close();
});

test("a long function name wraps after a dot, never mid-word, with its number on the first line", async () => {
  const page = await openPage();
  const long = "Contoso.Sales.Forms.AccountMainFormExtensions.CreditLimitValidation.onLoadOfTheAccountForm";
  await show(page, { kind: "ok", data: answer([handler({ function: long, ordinal: 0 }), handler({ function: "Contoso.AccountForm.onLoad", ordinal: 1 })]) });
  const text = await textNodes(page);
  // Each break opportunity is after a dot: every part but the last ends with one.
  expect(text).toContain("Contoso.\nSales.\nForms.\nAccountMainFormExtensions.\nCreditLimitValidation.\nonLoadOfTheAccountForm");
  const [number] = await boxes(page, "pos");
  const [name] = await boxes(page, "fn");
  // The name wrapped onto more than one line, and the number sits on its first.
  expect(name!.height).toBeGreaterThan(20);
  expect(Math.abs(number!.top - name!.top)).toBeLessThan(4);
  await page.close();
});

test("the connected map does not number handlers when the scan did not record the order", async () => {
  const page = await openPage();
  await show(page, { kind: "ok", data: UNORDERED });
  const text = await screenText(page);
  expect(text).toContain("Pathix did not record the order of these handlers in its latest scan.");
  expect(text).toContain("Contoso.AccountForm.a");
  expect(text).toContain("Contoso.AccountForm.b");
  expect(text).not.toMatch(/^\d+\.$/m);
  await page.close();
});

test("an unknown map says why and never reads as no handlers", async () => {
  const page = await openPage();
  for (const [read, phrase] of [
    [{ kind: "ok", data: answer([], { coverage: "notModeled", notModeledReason: "formNotParsed", ordered: false, handlers: null }) }, "Pathix could not read this form's definition in its latest scan"],
    [{ kind: "ok", data: answer([], { coverage: "notModeled", notModeledReason: "handlersNotRecorded", ordered: false, handlers: null }) }, "may predate handler capture"],
    [{ kind: "notInScan" }, "This form is not in Pathix's latest scan"],
    [{ kind: "failed" }, "Could not read this form's handlers from Pathix."],
  ] as const) {
    await show(page, read);
    const text = await screenText(page);
    expect(text).toContain(phrase);
    // The "?" text explains that unknown is not read as an empty form, so check the headline's words, not the whole panel.
    expect(text).not.toMatch(/found no script handlers|\b0 handlers|registers no/i);
    expect(text).not.toContain("Pathix's scan found");
  }
  await page.close();
});
