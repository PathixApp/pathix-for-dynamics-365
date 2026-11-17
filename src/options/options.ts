// The options page: where the user points the extension at their Pathix and
// signs in, or removes the address to go back to Lite. The address is all the
// user enters: the extension's client ID and scope come from Pathix's /config.
// Interactive sign-in only ever starts here, from a button, after the page has
// shown what it trusts. It also holds the tips setting.

import type { SignInBinding } from "../auth/binding";
import { fetchAuthConfig } from "../pathix/api";
import { LEGACY_CLIENT_ID_KEY, originPattern, originToRelease, parsePathixUrl } from "../pathix/settings";
import { LOCAL_HIDE_TIPS_KEY, modeFor, tipsHiddenByPolicy } from "../runtime/card-settings";
import type { AdminOverlayStatus } from "../runtime/admin-overlay";
import type { AccountStatus, OptionsRequest } from "../runtime/messages";
import { adminStatusLine, chromeToggleDeps, chromeWatchDeps, turnOverlayOff, turnOverlayOn, watchOverlayStatus, type ToggleResult } from "./admin-toggle";
import { accountView, modeLine, savedErrorLine, savedLine, type Tone, type TrustLine } from "./connection-view";

const form = element<HTMLFormElement>("settings");
const urlInput = element<HTMLInputElement>("pathix-url");
const settingsStatus = element<HTMLElement>("settings-status");
const accountStatus = element<HTMLElement>("account-status");
const signInButton = element<HTMLButtonElement>("sign-in");
const signOutButton = element<HTMLButtonElement>("sign-out");
const signInTrust = element<HTMLElement>("sign-in-trust");
const signInTrustList = element<HTMLElement>("sign-in-trust-list");
const modeStatus = element<HTMLElement>("mode-status");
const removeButton = element<HTMLButtonElement>("remove-address");
const hideTipsInput = element<HTMLInputElement>("hide-tips");
const tipsPolicy = element<HTMLElement>("tips-policy");
const adminOverlayInput = element<HTMLInputElement>("admin-overlay");
const adminStatus = element<HTMLElement>("admin-status");

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`options.html is missing #${id}`);
  return found as T;
}

function show(target: HTMLElement, text: string, tone: Tone): void {
  target.textContent = text;
  target.dataset.tone = tone;
}

async function saveSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const url = parsePathixUrl(urlInput.value);
  if (!url.ok) return show(settingsStatus, url.error, "error");

  // Asked first, while the click still counts as a user gesture.
  const granted = await chrome.permissions.request({ origins: [originPattern(url.value)] });
  if (!granted) return show(settingsStatus, "The extension needs permission to reach your Pathix.", "error");

  const previous = (await chrome.storage.local.get("pathixUrl")).pathixUrl;
  // A new address makes the service worker drop the token, the confirmed
  // sign-in and any refused grant (its storage listener): the new address
  // signs in only after the user selects Sign in for it.
  await chrome.storage.local.set({ pathixUrl: url.value });
  // A client ID an earlier build asked for is never read; tidy it away.
  await chrome.storage.local.remove(LEGACY_CLIENT_ID_KEY);
  // The old address is not reached any more, so its permission goes too.
  const release = originToRelease(previous, url.value);
  if (release) await chrome.permissions.remove({ origins: [release] }).catch(() => false);
  urlInput.value = url.value;

  try {
    const line = savedLine(await fetchAuthConfig(url.value, fetch));
    show(settingsStatus, line.text, line.tone);
  } catch (error) {
    const line = savedErrorLine((error as Error).message);
    show(settingsStatus, line.text, line.tone);
  }
  await refreshMode();
  await refreshAccount();
}

// Back to Lite: forget the address, the token and the permission to reach it.
async function removeAddress(): Promise<void> {
  const stored = await chrome.storage.local.get("pathixUrl");
  await send({ kind: "signOut" });
  await chrome.storage.local.remove(["pathixUrl", LEGACY_CLIENT_ID_KEY]);
  // The same guard as a new address: an address an earlier build saved on the
  // admin center's host must not take the admin overlay's permission with it.
  const release = originToRelease(stored.pathixUrl, null);
  if (release) await chrome.permissions.remove({ origins: [release] }).catch(() => false);
  urlInput.value = "";
  show(settingsStatus, "Address removed. Cards are back in Lite.", "neutral");
  await refreshMode();
  await refreshAccount();
}

async function refreshMode(): Promise<void> {
  const stored = await chrome.storage.local.get("pathixUrl");
  const mode = modeFor(stored);
  removeButton.hidden = mode !== "connected";
  show(modeStatus, modeLine(mode, typeof stored.pathixUrl === "string" ? stored.pathixUrl : null), "neutral");
}

async function loadTips(): Promise<void> {
  const local = await chrome.storage.local.get(LOCAL_HIDE_TIPS_KEY);
  let managed: Record<string, unknown> = {};
  try {
    managed = (await chrome.storage.managed.get(null)) ?? {};
  } catch {
    // No managed storage in this browser: no policy applies.
  }
  const byPolicy = tipsHiddenByPolicy(managed);
  hideTipsInput.checked = byPolicy || local[LOCAL_HIDE_TIPS_KEY] === true;
  hideTipsInput.disabled = byPolicy;
  tipsPolicy.hidden = !byPolicy;
}

async function send(request: OptionsRequest): Promise<AccountStatus> {
  return (await chrome.runtime.sendMessage(request)) as AccountStatus;
}

async function runAccountAction(request: OptionsRequest): Promise<void> {
  signInButton.disabled = signOutButton.disabled = true;
  try {
    renderAccount(await send(request));
  } finally {
    signInButton.disabled = signOutButton.disabled = false;
  }
}

async function refreshAccount(): Promise<void> {
  renderAccount(await send({ kind: "accountStatus" }));
}

/** What the page last showed for Sign in to trust. Sign in sends it back, and the worker signs in only if /config still says it. */
let offered: SignInBinding | null = null;

function renderAccount(status: AccountStatus): void {
  const view = accountView(status);
  offered = status.offered;
  signInButton.hidden = !view.signIn;
  signOutButton.hidden = !view.signOut;
  show(accountStatus, view.line.text, view.line.tone);
  renderTrust(view.trust);
}

function renderTrust(lines: TrustLine[] | null): void {
  signInTrust.hidden = lines === null;
  signInTrustList.replaceChildren(
    ...(lines ?? []).flatMap((line) => {
      const term = document.createElement("dt");
      term.textContent = line.label;
      const value = document.createElement("dd");
      value.textContent = line.value;
      return [term, value];
    }),
  );
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get("pathixUrl");
  if (typeof stored.pathixUrl === "string") urlInput.value = stored.pathixUrl;
}

// --- Power Platform admin center overlay (M14) -----------------------------------------

const adminDeps = chromeToggleDeps(chrome);

function renderAdminOverlay(status: AdminOverlayStatus | null): void {
  const line = adminStatusLine(status);
  adminOverlayInput.checked = line.on;
  show(adminStatus, line.text, line.tone);
}

function renderToggleResult(result: ToggleResult): void {
  if (result.ok) return renderAdminOverlay(result.status);
  renderAdminOverlay(result.status);
  show(adminStatus, result.message, "error");
}

// The admin host can be removed or granted in the browser's own settings while this page is open.
const adminWatch = watchOverlayStatus(chromeWatchDeps(chrome), renderAdminOverlay, () => adminOverlayInput.disabled);

adminOverlayInput.addEventListener("change", () => {
  // The permission request runs inside this handler, from the click's gesture.
  const wanted = adminOverlayInput.checked;
  adminOverlayInput.disabled = true;
  adminWatch.supersede();
  void (wanted ? turnOverlayOn(adminDeps) : turnOverlayOff(adminDeps))
    .then(renderToggleResult)
    .finally(() => (adminOverlayInput.disabled = false));
});

form.addEventListener("submit", (event) => void saveSettings(event));
removeButton.addEventListener("click", () => void removeAddress());
hideTipsInput.addEventListener("change", () => void chrome.storage.local.set({ [LOCAL_HIDE_TIPS_KEY]: hideTipsInput.checked }));
signInButton.addEventListener("click", () => void runAccountAction({ kind: "signIn", binding: offered }));
signOutButton.addEventListener("click", () => void runAccountAction({ kind: "signOut" }));
void loadSettings().then(refreshMode).then(refreshAccount);
void loadTips();
// The first read goes through the watch, so a toggle started before it answers supersedes it.
adminWatch.refresh();

