// Smoke test for the toolbar popup: every form feature is one click from the
// toolbar icon (DESIGN.md, "Entry points").
//
// Headless Chromium has no toolbar to click, so the test opens popup.html as
// an extension page in its own tab. The popup acts on the active tab of its
// window, so the test brings the fake form's tab to the front and then loads
// the popup in the background tab: chrome.tabs.query({ active: true,
// currentWindow: true }) then finds the form, as it would from the real
// toolbar. Everything after that (the question to the content script, the
// commands, the panels) is the real path.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { FORM_URL, serveFakeD365 } from "./fake-d365";

const DIST = resolve("dist");

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("No build in dist/. Run npm run build first.");
  const browser = process.env.PATHIX_SMOKE_CHROMIUM ? { executablePath: process.env.PATHIX_SMOKE_CHROMIUM } : { channel: "chromium" };
  context = await chromium.launchPersistentContext("", {
    ...browser,
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  await serveFakeD365(context);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

async function openForm(): Promise<Page> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(FORM_URL);
  await expect.poll(() => logs.some((line) => line.includes("[pathix] account form, 3 bound controls"))).toBe(true);
  return page;
}

/** Opens the popup for `target`: the target is the active tab, and the popup loads behind it. */
async function openPopupFor(target: Page): Promise<Page> {
  const popup = await context.newPage();
  await target.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#connection-heading-text")).not.toHaveText("Checking this tab…", { timeout: 20_000 });
  return popup;
}

/** The browser's current keys, as chrome.commands.getAll() reports them; "" when a command has none. */
async function bindings(): Promise<Record<string, string>> {
  const worker = context.serviceWorkers()[0]!;
  const all = await worker.evaluate(() => chrome.commands.getAll());
  return Object.fromEntries(all.map((command) => [command.name ?? "", command.shortcut ?? ""]));
}

/** Saves a Pathix address without granting it: the cards' mode is connected, and the connection reads "not set up". */
async function setPathixAddress(url: string | null): Promise<void> {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (value) => {
    if (value === null) await chrome.storage.local.remove("pathixUrl");
    else await chrome.storage.local.set({ pathixUrl: value });
  }, url);
}

/** Sends the tab a content command from the worker, as a keyboard command does. */
async function command(page: Page, message: { kind: string }): Promise<void> {
  await page.bringToFront();
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab!.id!, m);
  }, message);
}

function feature(popup: Page, name: string) {
  return popup.getByRole("button", { name: new RegExp(`^${name}`) });
}

test("on a record form, the popup says Lite and opens the event map with one click", async () => {
  const form = await openForm();
  const popup = await openPopupFor(form);

  await expect(popup.locator("#connection-heading-text")).toHaveText("Lite mode: cards read Dataverse metadata as you.");
  await expect(feature(popup, "Event map")).toBeEnabled();
  // Each button shows the key the browser has for it now, or "No shortcut".
  const keys = await bindings();
  await expect(feature(popup, "Event map")).toContainText(keys["open-event-map"] || "No shortcut");
  await expect(feature(popup, "What changed")).toContainText(keys["open-what-changed"] || "No shortcut");
  await expect(feature(popup, "What changed")).toBeEnabled();
  // X-ray and Save preview are Pathix's answers: off alike in Lite, with the same reason in words.
  await expect(feature(popup, "Save preview")).toBeDisabled();
  await expect(feature(popup, "Save preview")).toContainText("Uses your organization's Pathix");
  const xray = popup.getByRole("switch", { name: "X-ray" });
  await expect(xray).toHaveAttribute("aria-checked", "false");
  await expect(xray).toBeDisabled();
  await expect(popup.locator("#xray-shortcut")).toHaveText("Uses your organization's Pathix");
  await expect(popup.locator("#form-note")).toHaveText("X-ray and Save preview use your organization's Pathix. Set its address in Options.");

  await feature(popup, "Event map").click();
  await expect(form.locator("pathix-event-map")).toHaveCount(1);
  await popup.close().catch(() => undefined);

  // Opening it again from the popup leaves it open: the button opens, it does not toggle.
  const again = await openPopupFor(form);
  await feature(again, "Event map").click();
  await expect(form.locator("pathix-event-map")).toHaveCount(1);
  await again.close().catch(() => undefined);
  await form.close();
});

test("the popup's field card button opens the card for the selected field, which takes focus", async () => {
  const form = await openForm();
  await form.bringToFront();
  await form.keyboard.press("Tab");
  await form.keyboard.press("Tab");
  const popup = await openPopupFor(form);
  await feature(popup, "Card for the selected field").click();
  await expect(form.locator("pathix-field-card")).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => form.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("pathix-field-card");
  await popup.close().catch(() => undefined);
  await form.close();
});

test("the popup's field card button says so when no field is selected, and stays open", async () => {
  const form = await openForm();
  const popup = await openPopupFor(form);
  await expect(feature(popup, "Card for the selected field")).toBeEnabled();
  await feature(popup, "Card for the selected field").click();
  await expect(popup.locator("#command-status")).toHaveText("No field on the form is selected. Click a field or move to it with Tab, then try again.");
  expect(popup.isClosed()).toBe(false);
  await expect(form.locator("pathix-field-card")).toHaveCount(0);
  await popup.close().catch(() => undefined);
  await form.close();
});

test("the popup's What changed button opens the panel", async () => {
  const form = await openForm();
  const popup = await openPopupFor(form);
  await feature(popup, "What changed").click();
  await expect(form.locator("pathix-what-changed")).toHaveCount(1);
  await popup.close().catch(() => undefined);
  await form.close();
});

test("the X-ray switch turns X-ray on and off, and shows its state when the popup opens again", async () => {
  // Connected mode: an address is saved (not granted, so the connection says it is not set up).
  await setPathixAddress("https://pathix.contoso.test");
  const form = await openForm();
  const popup = await openPopupFor(form);
  await expect(popup.locator("#connection-heading-text")).toHaveText("Pathix is not set up", { timeout: 25_000 });
  await expect(popup.getByRole("button", { name: "Open options" })).toBeVisible();
  const xray = popup.getByRole("switch", { name: "X-ray" });
  const key = (await bindings())["toggle-xray"];
  if (key) await expect(xray).toHaveAttribute("aria-keyshortcuts", key);
  else await expect(xray).not.toHaveAttribute("aria-keyshortcuts", /.*/);
  await expect(popup.locator("#xray-shortcut")).toHaveText(key || "No shortcut");
  await xray.click();
  await expect(xray).toHaveAttribute("aria-checked", "true");
  await expect(form.locator("pathix-xray")).toHaveCount(1);
  await popup.close();

  const reopened = await openPopupFor(form);
  const switchAgain = reopened.getByRole("switch", { name: "X-ray" });
  await expect(switchAgain).toHaveAttribute("aria-checked", "true");
  await switchAgain.click();
  await expect(switchAgain).toHaveAttribute("aria-checked", "false");
  await expect(form.locator("pathix-xray")).toHaveCount(0);
  await reopened.close();
  await form.close();
  await setPathixAddress(null);
});

test("in Lite, an X-ray that is on shows on in the popup and can be turned off there", async () => {
  const form = await openForm();
  await command(form, { kind: "toggleXray" });
  await expect(form.locator("pathix-xray")).toHaveCount(1);
  const popup = await openPopupFor(form);
  const xray = popup.getByRole("switch", { name: "X-ray" });
  await expect(xray).toHaveAttribute("aria-checked", "true");
  await expect(xray).toBeEnabled();
  await xray.click();
  await expect(form.locator("pathix-xray")).toHaveCount(0);
  await popup.close().catch(() => undefined);
  await form.close();
});

test("on a page that is not Dynamics 365, the form section is disabled, not hidden, and Open demo works", async () => {
  const other = await context.newPage();
  await other.goto(`chrome-extension://${extensionId}/options.html`);
  const popup = await openPopupFor(other);

  // Without the tabs permission the browser gives the popup no tab address, so it cannot tell this page
  // from a Dynamics page whose content script is gone, and says both.
  await expect(popup.locator("#form-note")).toHaveText("Open a Dynamics 365 record form to use these. If one is open, reload the page. US Government (GCC High and DoD) and China clouds are not supported yet.");
  for (const name of ["Event map", "What changed", "Save preview", "Card for the selected field"]) {
    await expect(feature(popup, name)).toBeVisible();
    await expect(feature(popup, name)).toBeDisabled();
  }
  await expect(popup.getByRole("switch", { name: "X-ray" })).toBeDisabled();
  await expect(popup.getByRole("switch", { name: "Show Pathix in the admin center" })).toBeEnabled();
  await expect(popup.getByRole("button", { name: "Change keyboard shortcuts" })).toBeEnabled();

  const demo = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Open demo" }).click();
  const demoPage = await demo;
  await expect(demoPage).toHaveURL(`chrome-extension://${extensionId}/demo.html`);
  await demoPage.close();
  await popup.close().catch(() => undefined);
  await other.close();
});
