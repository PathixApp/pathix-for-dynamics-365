// Smoke test (M4): load the unpacked build into Chromium, open a fake
// model-driven form, and check that the Lite hover card renders and X-ray
// toggles. The cards live in closed shadow roots, which page scripts cannot
// see; the test reads them through the DevTools protocol, as a person would
// read the screen.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { refusalFor } from "../src/dataverse/allowlist";
import { FORM_URL, serveFakeD365 } from "./fake-d365";

const DIST = resolve("dist");

let context: BrowserContext;
let extensionId: string;
/** Every Web API path the extension asked the fake D365 for. */
let requests: string[];

test.beforeAll(async () => {
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("No build in dist/. Run npm run build first.");
  const browser = process.env.PATHIX_SMOKE_CHROMIUM
    ? { executablePath: process.env.PATHIX_SMOKE_CHROMIUM }
    : // Playwright's full Chromium: its headless-only shell cannot load extensions.
      { channel: "chromium" };
  context = await chromium.launchPersistentContext("", {
    ...browser,
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  requests = await serveFakeD365(context);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

/** Every text node on the page, closed shadow roots included. */
async function screenText(page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
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

/** Clicks the first element with this class inside the card's closed shadow root, with a real mouse click. */
async function clickByClass(page: Page, className: string): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const find = (node: DomNode): DomNode | null => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf("class");
    if (at !== -1 && attributes[at + 1]?.split(" ").includes(className)) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const target = find(root);
  if (!target?.backendNodeId) throw new Error(`No .${className} in the page.`);
  const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: target.backendNodeId })) as { model: { content: number[] } };
  await cdp.detach();
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
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

/**
 * Sends the tab a content command from the service worker, as the worker does
 * for a keyboard command. Headless Chromium cannot press a browser-level
 * command key (chrome.commands), so the test starts one step later: the
 * message the worker's onCommand sends. The routing from command name to
 * message is unit-tested in test/commands.test.ts.
 */
async function command(page: Page, message: { kind: string }): Promise<void> {
  await page.bringToFront();
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab!.id!, m);
  }, message);
}

async function openForm(): Promise<{ page: Page; logs: string[] }> {
  requests.length = 0;
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(FORM_URL);
  await expect.poll(() => logs.some((line) => line.includes("[pathix] account form, 3 bound controls"))).toBe(true);
  return { page, logs };
}

test("the Lite hover card renders on a model-driven form", async () => {
  const { page } = await openForm();
  await page.hover("#label-creditlimit");
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  const text = await screenText(page);
  expect(text).toContain("Lite");
  expect(text).toContain("Live from Dataverse");
  // The table's own 10 steps and 20 registered on Update for every table.
  expect(text).toContain("30 plugin steps are registered to fire when this column changes.");
  // The word "Pathix" is its own text node: the link to pathix.app.
  expect(text).toContain("Registered isn't the same as writes. \nPathix\n reads plugin code, scripts and flows to show what actually writes this column.");
  expect(text).not.toContain("What Pathix reads");

  // Every Dataverse read stayed on the Lite allowlist, and none read a business table.
  expect(requests.length).toBeGreaterThan(0);
  for (const path of requests) expect(refusalFor(path), path).toBeNull();
  expect(requests.some((path) => path.startsWith("accounts"))).toBe(false);
  await page.close();
});

test("Copy as brief puts the Lite card's names and counts on the clipboard", async () => {
  const { page } = await openForm();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(FORM_URL).origin });
  await page.hover("#label-creditlimit");
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  await clickByClass(page, "copy-button");
  await expect.poll(() => screenText(page)).toContain("Copied");
  const brief = await page.evaluate(() => navigator.clipboard.readText());
  expect(brief).toContain("Pathix Lite brief: account.creditlimit");
  expect(brief).toContain("30 plugin steps are registered to fire when this column changes.");
  // Lite rules: no writers, no Pathix number, no link.
  expect(brief).not.toMatch(/\bwriters?\b/i);
  expect(brief).not.toMatch(/https?:\/\//);
  await page.close();
});

test("Lite puts nothing on the toolbar badge", async () => {
  const { page } = await openForm();
  const worker = context.serviceWorkers()[0]!;
  const badges = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map(async (tab) => ({ text: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) })));
  });
  expect(badges.length).toBeGreaterThan(0);
  for (const badge of badges) {
    expect(badge.text).toBe("");
    expect(badge.title).toContain("X-ray, event map, what changed and save preview for Dynamics 365 forms");
  }
  await page.close();
});

test("a locked field opens on the checklist", async () => {
  const { page } = await openForm();
  await page.hover("#label-pathix_legalofficer");
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Why can't I edit this field?");
  expect(await screenText(page)).toContain("The definition of Account sets this control read-only.");
  await page.close();
});

test("X-ray toggles", async () => {
  const { page } = await openForm();
  await command(page, { kind: "toggleXray" });
  await expect(page.locator("pathix-xray")).toHaveCount(1);
  // X-ray is connected-only. In Lite there is no Pathix to ask, so it says so,
  // writes no line into the form and shows no Pathix number (the line itself is
  // in xray-line.smoke.ts).
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Pathix is not set up.");
  await expect(page.locator("pathix-xray-line")).toHaveCount(0);
  const text = await screenText(page);
  expect(text).not.toMatch(/\bW: |\bR: |\bF: /);
  await command(page, { kind: "toggleXray" });
  await expect(page.locator("pathix-xray")).toHaveCount(0);
  await expect(page.locator("pathix-xray-line")).toHaveCount(0);
  await page.close();
});

test("the form event map opens, lists the form's handlers, tags the platform's own, and closes", async () => {
  const { page } = await openForm();
  await command(page, { kind: "openEventMap" });
  await expect(page.locator("pathix-event-map")).toHaveCount(1);
  // Opened by a command, focus was on the close button; the loaded map moved it to the heading, not back to close.
  await expect.poll(() => axFocus(page).then((state) => state.focused), { timeout: 10_000 }).not.toMatch(/^button:Close/);
  expect(await focusedTag(page)).toBe("pathix-event-map");
  // A function name is one text node per dotted part (it may wrap after each dot): join them back.
  const mapText = async () => (await screenText(page)).replace(/(?<!^\d+)\.\n(?=[A-Za-z_$])/gm, ".");
  await expect.poll(mapText, { timeout: 10_000 }).toContain("Contoso.AccountForm.onSave");
  const text = await mapText();
  expect(text).toContain("Form event map");
  expect(text).toContain("AppCommon.Account.Instance.ra_onload");
  expect(text).toContain("internal");
  expect(text).toContain("3 handlers are registered on this form: 2 loaded by the platform.");
  // Lite: no writers, no Pathix number; the one footer line names what Pathix does.
  expect(text).not.toMatch(/\bwriters?\b/i);
  expect(text).toContain("A form definition can't show what a handler does.");
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-event-map")).toHaveCount(0);
  await command(page, { kind: "openEventMap" });
  await expect(page.locator("pathix-event-map")).toHaveCount(1);
  // The command opens; it never closes an open panel. Escape does.
  await command(page, { kind: "openEventMap" });
  await expect(page.locator("pathix-event-map")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-event-map")).toHaveCount(0);
  await page.close();
});

test("what changed opens, reads the table's components' modified and published dates, and closes", async () => {
  const { page } = await openForm();
  await command(page, { kind: "openWhatChanged" });
  await expect(page.locator("pathix-what-changed")).toHaveCount(1);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toMatch(/modified or published in the last 30 days\./);
  const text = await screenText(page);
  expect(text).toContain("What changed on this table");
  expect(text).toContain("Live from Dataverse");
  // Lite: no writers, no Pathix number; the one footer line names what Pathix does.
  expect(text).not.toMatch(/\bwriters?\b/i);
  expect(text).toContain("A modified or published date can't say what changed.");
  // A form has no modifiedon: its date is publishedon, and a form row says "Published".
  expect(requests.some((path) => path.startsWith("systemforms?$select=formid,name,type,publishedon"))).toBe(true);
  expect(requests.some((path) => path.startsWith("systemforms") && path.includes("modifiedon"))).toBe(false);
  expect(text).toMatch(/Published /);
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-what-changed")).toHaveCount(0);
  await command(page, { kind: "openWhatChanged" });
  await expect(page.locator("pathix-what-changed")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-what-changed")).toHaveCount(0);
  await page.close();
});

test("the save preview says it needs Pathix in Lite, asks Pathix for nothing, and closes", async () => {
  const { page } = await openForm();
  await command(page, { kind: "openSavePreview" });
  await expect(page.locator("pathix-save-preview")).toHaveCount(1);
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("The save preview needs Pathix.");
  const text = await screenText(page);
  expect(text).toContain("Save preview");
  // Lite: no Pathix result, no writers; the one footer line names what Pathix does.
  expect(text).not.toMatch(/writers?|registered to fire (on this save|on the server)|form OnSave handler|Nothing is registered/i);
  expect(text).toContain("Lite can't tell what a save runs, or in what order.");
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-save-preview")).toHaveCount(0);
  await command(page, { kind: "openSavePreview" });
  await expect(page.locator("pathix-save-preview")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-save-preview")).toHaveCount(0);
  await page.close();
});

test("the page itself has no shortcut keys: Alt+Shift letters reach the field, and open nothing", async () => {
  const { page } = await openForm();
  const input = page.locator('[data-id="name-FieldSectionItemContainer"] input');
  await input.fill("");
  await input.focus();
  // A bubble-phase listener on the window runs after any capture-phase handler,
  // so it sees whether anything called preventDefault on the real, trusted keys.
  // (A synthetic KeyboardEvent would prove nothing: the extension ignores untrusted events.)
  await page.evaluate(() => {
    const w = window as unknown as { prevented: boolean[] };
    w.prevented = [];
    window.addEventListener("keydown", (event) => void w.prevented.push(event.defaultPrevented));
  });
  const keys = ["Alt+Shift+X", "Alt+Shift+E", "Alt+Shift+C", "Alt+Shift+S", "Alt+Shift+P"];
  for (const key of keys) await page.keyboard.press(key);
  for (const tag of ["pathix-xray", "pathix-event-map", "pathix-what-changed", "pathix-save-preview"]) await expect(page.locator(tag)).toHaveCount(0);
  // Nothing called preventDefault on them: the page saw every keydown unhandled.
  const prevented = await page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented);
  expect(prevented.length).toBeGreaterThanOrEqual(keys.length);
  expect(prevented.filter(Boolean)).toEqual([]);
  await page.close();
});

test("the field card command opens the card for the field that has focus", async () => {
  const { page } = await openForm();
  await page.locator('[data-id="creditlimit-FieldSectionItemContainer"] input').focus();
  await command(page, { kind: "openFieldCard" });
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  await page.close();
});

/** The tag of the element that has focus in the page: a closed shadow root shows as its host. */
function focusedTag(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? "");
}

/** Whether focus is on the input of a field, by its control name. */
function focusIsOn(page: Page, control: string): Promise<boolean> {
  return page.evaluate((name) => document.activeElement === document.querySelector(`[data-id="${name}-FieldSectionItemContainer"] input`), control);
}

/** The accessibility tree's focused node, and the card dialog's busy state, as a screen reader is given them. */
async function axFocus(page: Page): Promise<{ focused: string; busy: boolean | null }> {
  const cdp = await context.newCDPSession(page);
  type Prop = { name: string; value: { value?: unknown } };
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: Array<{ role?: { value?: string }; name?: { value?: string }; properties?: Prop[] }>;
  };
  await cdp.detach();
  const has = (node: { properties?: Prop[] }, name: string) => node.properties?.find((property) => property.name === name)?.value.value;
  // The document itself also reads as focused: the innermost focused node is the one that has focus.
  const focused = nodes.filter((node) => has(node, "focused") === true).at(-1);
  const dialog = nodes.find((node) => node.role?.value === "dialog");
  return { focused: `${focused?.role?.value ?? ""}:${focused?.name?.value ?? ""}`, busy: dialog ? has(dialog, "busy") === true : null };
}

/** The accessibility tree's dialogs, by name, as a screen reader is given them. */
async function dialogNames(page: Page): Promise<string[]> {
  const cdp = await context.newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
  await cdp.detach();
  return nodes.filter((node) => node.role?.value === "dialog").map((node) => node.name?.value ?? "");
}

test("keyboard only: the card opens for the field reached with Tab, takes focus, and Escape gives it back", async () => {
  const { page } = await openForm();
  await page.bringToFront();
  // Real key presses: the first Tab reaches Account Name, the second Credit Limit.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await focusIsOn(page, "creditlimit")).toBe(true);

  // The command a shortcut sends; the popup's button sends the same one (popup.smoke.ts).
  await command(page, { kind: "openFieldCard" });
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  // Focus moved into the card, which a screen reader is given as a dialog named by its column.
  await expect.poll(() => focusedTag(page)).toBe("pathix-field-card");
  await expect.poll(() => dialogNames(page)).toContain("creditlimit");
  // The load redrew the card in place: focus is still on its title, and it is no longer busy.
  await expect.poll(() => axFocus(page)).toEqual({ focused: "heading:creditlimit", busy: false });

  // Tab moves through the card's own controls.
  await page.keyboard.press("Tab");
  expect(await focusedTag(page)).toBe("pathix-field-card");

  // Escape closes it and puts focus back on the field.
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-field-card")).toHaveCount(0);
  expect(await focusIsOn(page, "creditlimit")).toBe(true);

  // D365 re-renders a field's control after a save or an on-change script: focus goes to the new one, not the page.
  await command(page, { kind: "openFieldCard" });
  await expect.poll(() => focusedTag(page)).toBe("pathix-field-card");
  await page.evaluate(() => {
    const old = document.querySelector('[data-id="creditlimit-FieldSectionItemContainer"] input')!;
    old.replaceWith(old.cloneNode(true));
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("pathix-field-card")).toHaveCount(0);
  expect(await focusIsOn(page, "creditlimit")).toBe(true);
  await page.close();
});

/** The card's title node and the loading message's busy flag, read through the DevTools protocol (the root is closed). */
async function cardNodes(page: Page): Promise<{ title: number | null; busy: boolean }> {
  const cdp = await context.newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  let title: number | null = null;
  let busy = false;
  const walk = (node: DomNode) => {
    const attributes = node.attributes ?? [];
    for (let i = 0; i < attributes.length; i += 2) {
      if (attributes[i] === "id" && attributes[i + 1] === "pathix-card-title") title = node.backendNodeId ?? null;
      if (attributes[i] === "aria-busy" && attributes[i + 1] === "true") busy = true;
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return { title, busy };
}

test("the card updates in place as it loads: the same title node keeps focus, and nothing stays busy", async () => {
  const { page } = await openForm();
  await page.bringToFront();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  // Hold Dataverse's answers so the loading card can be read before the content replaces it.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/data/v9.2/**", async (route) => {
    await held;
    await route.fallback();
  });
  await command(page, { kind: "openFieldCard" });
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Reading Dataverse");
  const loading = await cardNodes(page);
  expect(loading.title).not.toBeNull();
  expect(loading.busy).toBe(true);
  await expect.poll(() => axFocus(page)).toMatchObject({ focused: "heading:creditlimit" });

  release();
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  const loaded = await cardNodes(page);
  // The very same node: it never left the page, so focus stayed and the dialog was not announced again.
  expect(loaded.title).toBe(loading.title);
  expect(loaded.busy).toBe(false);
  expect(await axFocus(page)).toEqual({ focused: "heading:creditlimit", busy: false });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.close();
});

test("a card opened by hover does not take focus", async () => {
  const { page } = await openForm();
  const input = page.locator('[data-id="name-FieldSectionItemContainer"] input');
  await input.focus();
  await page.hover("#label-creditlimit");
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  expect(await focusIsOn(page, "name")).toBe(true);
  // The card sits inside body, so assistive technology reaches it with the page.
  expect(await page.evaluate(() => document.querySelector("pathix-field-card")?.parentElement === document.body)).toBe(true);
  await page.close();
});

test("the demo page shows the cards without a Dynamics 365 environment", async () => {
  const page = await context.newPage();
  const network: string[] = [];
  page.on("request", (request) => network.push(request.url()));
  await page.goto(`chrome-extension://${extensionId}/demo.html`);
  await page.hover('label[for="f-creditlimit"]');
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("Registered to fire when this changes");
  expect(network.filter((url) => !url.startsWith(`chrome-extension://${extensionId}/`))).toEqual([]);
  await page.close();
});
