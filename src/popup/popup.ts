// The toolbar popup: the primary way into every form feature. Clicking the
// toolbar icon opens it; the keyboard shortcuts are accelerators (DESIGN.md,
// "Entry points").
//
// This file is the browser and the DOM: it gives PopupSession (./session.ts)
// the real chrome calls and draws each view it hands back. What to ask the tab,
// how long to wait, and which state to show are the session's, and are tested
// there with fakes (test/popup-session.test.ts). The words and the enabled
// states come from ./model.ts.
//
// The tab id comes from chrome.tabs.query, which needs no permission for the id
// alone. If the browser also gives the tab's address, the session reads its
// host only, to tell "reload this Dynamics page" from "open one", and keeps
// nothing. Without the tabs permission Chromium gives none (measured
// 2026-10-09), so the popup usually says both.

import { adminStatusLine, chromeToggleDeps, chromeWatchDeps, turnOverlayOff, turnOverlayOn, watchOverlayStatus, type ToggleResult } from "../options/admin-toggle";
import { modeFor } from "../runtime/card-settings";
import { bindingsFrom, shortcutSettingsUrl } from "../runtime/commands";
import type { OpenFeatureCommand } from "../runtime/messages";
import type { AdminOverlayStatus } from "../runtime/admin-overlay";
import { secondaryText, type PopupView } from "./model";
import { PopupSession } from "./session";

const DEMO_PAGE = "demo.html";

const connectionHeading = element<HTMLElement>("connection-heading-text");
const connectionDetail = element<HTMLElement>("connection-detail");
const fixInOptions = element<HTMLButtonElement>("fix-in-options");
const formNote = element<HTMLElement>("form-note");
const xraySwitch = element<HTMLButtonElement>("xray");
const xrayShortcut = element<HTMLElement>("xray-shortcut");
const commandStatus = element<HTMLElement>("command-status");
const adminSwitch = element<HTMLButtonElement>("admin-overlay");
const adminStatus = element<HTMLElement>("admin-status");
const features = Array.from(document.querySelectorAll<HTMLButtonElement>("button.feature"));

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup.html is missing #${id}`);
  return found as T;
}

function render(view: PopupView): void {
  const { connection, form } = view;
  connectionHeading.textContent = connection.heading;
  connectionHeading.dataset.tone = connection.tone;
  connectionDetail.textContent = connection.detail ?? "";
  connectionDetail.hidden = connection.detail === null;
  fixInOptions.hidden = !connection.openOptions;

  formNote.textContent = form.note ?? "";
  formNote.hidden = form.note === null;
  xraySwitch.disabled = !form.xray.enabled;
  xraySwitch.setAttribute("aria-checked", String(form.xray.on));
  setKeyShortcut(xraySwitch, form.xray.shortcut);
  xrayShortcut.textContent = secondaryText(form.xray.shortcut, form.xray.reason);

  for (const button of features) {
    const action = form.actions.find((candidate) => candidate.command === button.dataset.command);
    if (!action) continue;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = action.label;
    const secondary = document.createElement("span");
    secondary.className = "shortcut";
    secondary.textContent = secondaryText(action.shortcut, action.reason);
    button.replaceChildren(label, secondary);
    button.disabled = !action.enabled;
    setKeyShortcut(button, action.shortcut);
  }
}

function setKeyShortcut(target: HTMLElement, shortcut: string | null): void {
  if (shortcut) target.setAttribute("aria-keyshortcuts", shortcut);
  else target.removeAttribute("aria-keyshortcuts");
}

const session = new PopupSession({
  async activeTab() {
    // Only the id, and the address when the browser gives one. Never the title.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { id: tab.id, url: tab.url } : undefined;
  },
  send: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  async settings() {
    const stored = await chrome.storage.local.get("pathixUrl");
    return { mode: modeFor(stored), pathixUrl: typeof stored.pathixUrl === "string" ? stored.pathixUrl : null };
  },
  // The browser's current keys. The user may have changed or cleared any of them.
  bindings: async () => bindingsFrom(await chrome.commands.getAll()),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  render,
  commandStatus: (text) => void (commandStatus.textContent = text),
  close: () => window.close(),
});

// --- Power Platform admin center overlay: the options page's switch, shared logic ---

const adminDeps = chromeToggleDeps(chrome);

function renderAdmin(status: AdminOverlayStatus | null, message?: string): void {
  const line = adminStatusLine(status);
  adminSwitch.setAttribute("aria-checked", String(line.on));
  adminStatus.textContent = message ?? line.text;
  adminStatus.dataset.tone = message === undefined ? line.tone : "error";
}

function renderToggleResult(result: ToggleResult): void {
  if (result.ok) renderAdmin(result.status);
  else renderAdmin(result.status, result.message);
}

// The admin host can be removed or granted in the browser's own settings while the popup is open.
const adminWatch = watchOverlayStatus(chromeWatchDeps(chrome), (status) => renderAdmin(status), () => adminSwitch.disabled);

adminSwitch.addEventListener("click", () => {
  // The permission request runs inside this handler, from the click's gesture.
  const wanted = adminSwitch.getAttribute("aria-checked") !== "true";
  adminSwitch.disabled = true;
  adminWatch.supersede();
  void (wanted ? turnOverlayOn(adminDeps) : turnOverlayOff(adminDeps))
    .then(renderToggleResult)
    .finally(() => (adminSwitch.disabled = false));
});

// --- wiring ----------------------------------------------------------------------

for (const button of features) {
  button.addEventListener("click", () => void session.openFeature(button.dataset.command as OpenFeatureCommand["kind"]));
}
xraySwitch.addEventListener("click", () => void session.toggleXray());
fixInOptions.addEventListener("click", () => void chrome.runtime.openOptionsPage().then(() => window.close()));
element<HTMLButtonElement>("open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage().then(() => window.close()));
element<HTMLButtonElement>("shortcut-settings").addEventListener("click", () => {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData?.brands;
  void chrome.tabs.create({ url: shortcutSettingsUrl(brands, navigator.userAgent) }).then(() => window.close());
});
element<HTMLButtonElement>("open-demo").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(DEMO_PAGE) }).then(() => window.close());
});

void session.start();
// The first read goes through the watch, so a toggle started before it answers supersedes it.
adminWatch.refresh();

