// The only part of the extension that talks to Pathix or Entra.
//
// Content scripts send form snapshots; the worker answers with the connection
// status for that org (signed out, not scanned, connected to environment X).
// They also ask for hover cards, X-ray, the form event map and the table's
// change ledger, which share one response cache,
// and for the card mode (Lite or connected) and whether Lite cards carry
// their tip line, since only the worker reads extension storage.
// The options page sends sign-in and sign-out requests. Sign-in with UI only
// ever starts from the options page: a page load never opens a window. The
// toolbar popup asks only for card settings and the admin overlay's state.
//
// Both kinds of message are validated, and options requests are accepted only
// from the extension's own options page.

import { redeemCode, type AccessToken, type AuthSettings } from "../auth/authorize";
import { sameBinding } from "../auth/binding";
import { isPageMessage } from "../bridge/messages";
import { apiGet, fetchAuthConfig } from "../pathix/api";
import { forgetLegacyClientId, originPattern, settingsFrom, type ExtensionSettings } from "../pathix/settings";
import {
  ADMIN_HOST,
  ADMIN_OVERLAY_INTENT_KEY,
  ADMIN_OVERLAY_KEY,
  isAdminAppUsersRequest,
  isAdminOverlayStatusRequest,
  isAdminRoleListRequest,
  isAdminRoleRequest,
  isFromAdminPage,
  type AdminAppUsersRequest,
  type AdminAppUsersResponse,
  type AdminRoleListRequest,
  type AdminRoleListResponse,
  type AdminRoleRequest,
  type AdminRoleResponse,
} from "../runtime/admin-overlay";
import {
  cardSettingsFrom,
  isCardSettingsRequest,
  isHideTipsRequest,
  isOpenOptionsRequest,
  LOCAL_HIDE_TIPS_KEY,
  SETTINGS_KEYS,
  type CardSettings,
} from "../runtime/card-settings";
import {
  describeConnection,
  isEventMapRequest,
  isFieldCardRequest,
  isOptionsRequest,
  isSavePreviewRequest,
  isTableChangesRequest,
  isXrayRequest,
  type AccountStatus,
  type ConnectionStatus,
  type EventMapRequest,
  type EventMapResponse,
  type FieldCardRequest,
  type FieldCardResponse,
  type OptionsRequest,
  type RefreshBadgeCommand,
  type SavePreviewRequest,
  type SavePreviewResponse,
  type TableChangesRequest,
  type TableChangesResponse,
  type XrayRequest,
  type XrayResponse,
} from "../runtime/messages";
import { TabBadges } from "../runtime/badge";
import { runCommand } from "../runtime/commands";
import { formatDay } from "../runtime/dates";
import { browserOverlayDeps, completeEnableIntent, onPermissionsChanged, ReconcileQueue, reconcileAdminOverlay, type PermissionChangeDeps } from "./admin-overlay";
import { chromeTabs, PATHIX_RESET, tellTabs } from "./tabs";
import { loadAppUserChips, loadRoleBadges, loadRoleBanner } from "./admin";
import type { AdminContext } from "../card/admin";
import { ResponseCache } from "./cache";
import { ConnectionCache, isExcludedTable, resolveConnection, type Get } from "./connection";
import { loadTableChanges } from "./changes";
import { loadFormEventMap } from "./event-map";
import { loadFieldCard } from "./field-card";
import { admitFormRequest, TabOrganizations, type FormRequestScope } from "./form-requests";
import { loadSavePreview } from "./save-preview";
import {
  errorMessage,
  NOT_KEPT_TEXT,
  PathixSignIn,
  SIGNED_OUT_TEXT,
  signOutOffered,
  SignInUnavailableError,
  statusForError,
  storedSignIn,
  type StoredRefusal,
} from "./sign-in";
import { loadXray } from "./xray";

const TOKEN_KEY = "accessToken";
/** A grant the extension refused, kept so it outlives a worker restart (StoredRefusal). */
const REFUSAL_KEY = "signInRefusal";
/**
 * The sign-in the user confirmed with Sign in (src/auth/binding.ts). In local
 * storage, so a browser restart keeps it and silent sign-in resumes; sign-out
 * and a new address remove it.
 */
const BINDING_KEY = "signInBinding";
const SILENT_SIGN_IN_TIMEOUT_MS = 10_000;
const RESPONSE_TTL_MS = 10 * 60 * 1000;

// Keyed by org and host: the host is only a fallback for matching an
// environment, and the admin center has no Dynamics host to offer it, so a
// "not scanned" learned there must not be taken for the form's answer.
const connections = new ConnectionCache((organizationId, host) => resolveFresh(organizationId, host), Date.now);
const responses = new ResponseCache(RESPONSE_TTL_MS);

// --- settings and auth -------------------------------------------------------

async function loadSettings(): Promise<ExtensionSettings | null> {
  const settings = settingsFrom(await chrome.storage.local.get("pathixUrl"));
  if (!settings) return null;
  const granted = await chrome.permissions.contains({ origins: [originPattern(settings.pathixUrl)] });
  return granted ? settings : null;
}

// Sign-in settings come from the Pathix's /config, and the token lives in
// session storage. The decisions are in ./sign-in.ts.
const signIn = new PathixSignIn({
  readConfig: (pathixUrl) => fetchAuthConfig(pathixUrl, fetch),
  redirectUri: () => chrome.identity.getRedirectURL(),
  async launch(url, interactive) {
    const redirect = await chrome.identity.launchWebAuthFlow({
      url,
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: SILENT_SIGN_IN_TIMEOUT_MS,
    });
    if (!redirect) throw new Error("The sign-in window closed without a response.");
    return redirect;
  },
  redeem: (settings, code, verifier) => redeemCode(settings, code, verifier, fetch, Date.now),
  loadToken: async () => ((await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as AccessToken | undefined) ?? null,
  saveToken: (token) => chrome.storage.session.set({ [TOKEN_KEY]: token }),
  removeToken: () => chrome.storage.session.remove(TOKEN_KEY),
  loadRefusal: async () => ((await chrome.storage.session.get(REFUSAL_KEY))[REFUSAL_KEY] as StoredRefusal | undefined) ?? null,
  saveRefusal: (refusal) => chrome.storage.session.set({ [REFUSAL_KEY]: refusal }),
  removeRefusal: () => chrome.storage.session.remove(REFUSAL_KEY),
  loadBinding: async () => (await chrome.storage.local.get(BINDING_KEY))[BINDING_KEY],
  saveBinding: (binding) => chrome.storage.local.set({ [BINDING_KEY]: binding }),
  removeBinding: () => chrome.storage.local.remove(BINDING_KEY),
  // Cards and the badge then learn "not set up" on their next request, not after a cached "connected" runs out.
  onUnavailable: () => disconnect(),
  now: Date.now,
});

// --- form snapshots from content scripts -------------------------------------

function connectionFor(organizationId: string, host: string): Promise<ConnectionStatus> {
  return connections.get(organizationId, host);
}

function clearCaches(): void {
  connections.clear();
  responses.clear();
}

/**
 * Forgets everything learned from Pathix, badges included: sign-out, or a new
 * address. Open forms are told too, so X-ray's lines do not keep showing
 * Pathix's counts.
 */
function disconnect(): void {
  clearCaches();
  void clearBadges();
  void tellTabs(chromeTabs(chrome), PATHIX_RESET);
}

async function resolveFresh(organizationId: string, host: string): Promise<ConnectionStatus> {
  const settings = await loadSettings();
  if (!settings) return { kind: "notConfigured" };
  try {
    // The admin center names the organization only, so its environment is matched on the id alone.
    const pageHost = host === ADMIN_HOST ? null : host;
    return await resolveConnection(organizationId, pageHost, await pathixGet(settings));
  } catch (error) {
    return statusForError(error);
  }
}

/** A GET against the user's Pathix that signs in silently when it needs to. */
async function pathixGet(settings: ExtensionSettings): Promise<Get> {
  const getToken = signIn.tokenSource(await signIn.settingsFor(settings.pathixUrl));
  return (path) => apiGet(settings.pathixUrl, path, getToken, fetch);
}

// --- toolbar badge -------------------------------------------------------------

const badges = new TabBadges({
  setText: (tabId, text) => chrome.action.setBadgeText({ tabId, text }),
  setTitle: (tabId, title) => chrome.action.setTitle({ tabId, title }),
  defaultTitle: chrome.runtime.getManifest().action?.default_title ?? "Pathix",
});

// The one badge look; the text and tooltip are per tab. Colors need no permission.
void chrome.action.setBadgeBackgroundColor({ color: "#0060aa" });
void chrome.action.setBadgeTextColor({ color: "#ffffff" });

/** Tab ids need no permission; a stale badge on a tab that is no longer connected must not linger. */
async function clearBadges(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await badges.clearAll(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
  } catch {
    // Nothing to clear if the tabs cannot be listed.
  }
}

// --- hover cards and X-ray ------------------------------------------------------

type Connected = Extract<ConnectionStatus, { kind: "connected" }>;

/**
 * Resolves the org, then runs `load` with a GET that goes through the shared
 * response cache, scoped to the environment's latest Completed scan.
 */
async function withConnection<R>(
  organizationId: string,
  host: string,
  load: (status: Connected, settings: ExtensionSettings, get: Get) => Promise<R>,
): Promise<R | { kind: "status"; status: ConnectionStatus }> {
  const status = await connectionFor(organizationId, host);
  // Before the first Completed scan there is nothing to show; the card says
  // so rather than show an empty card (DESIGN.md, "Absence is not evidence").
  if (status.kind !== "connected" || status.latestCompletedScanAt === null) return { kind: "status", status };
  const settings = await loadSettings();
  if (!settings) return { kind: "status", status: { kind: "notConfigured" } };
  try {
    const scope = `${status.environmentId}|${status.latestCompletedScanAt}`;
    return await load(status, settings, responses.wrap(await pathixGet(settings), scope));
  } catch (error) {
    return { kind: "status", status: statusForError(error) };
  }
}

function fieldCardFor(request: FieldCardRequest): Promise<FieldCardResponse> {
  return withConnection(request.organizationId, request.host, (status, settings, get) =>
    loadFieldCard(
      {
        pathixUrl: settings.pathixUrl,
        environmentId: status.environmentId,
        environmentName: status.environmentName,
        scanCompletedAt: status.latestCompletedScanAt,
        scanStartedAt: status.latestCompletedScanStartedAt ?? null,
        table: request.table,
        column: request.column,
        tableExcluded: isExcludedTable(status, request.table),
      },
      get,
      formatScanDate,
      (iso) => formatDay(iso),
    ),
  );
}

function xrayFor(request: XrayRequest): Promise<XrayResponse> {
  return withConnection(request.organizationId, request.host, (status, _settings, get) =>
    loadXray(
      {
        environmentId: status.environmentId,
        environmentName: status.environmentName,
        scanCompletedAt: status.latestCompletedScanAt,
        table: request.table,
        columns: request.columns,
        tableExcluded: isExcludedTable(status, request.table),
      },
      get,
      formatScanDate,
    ),
  );
}

function tableChangesFor(request: TableChangesRequest): Promise<TableChangesResponse> {
  return withConnection(request.organizationId, request.host, (status, settings, get) =>
    loadTableChanges(
      {
        pathixUrl: settings.pathixUrl,
        environmentId: status.environmentId,
        environmentName: status.environmentName,
        scanCompletedAt: status.latestCompletedScanAt,
        scanStartedAt: status.latestCompletedScanStartedAt ?? null,
        table: request.table,
        formatDate: formatScanDate,
        formatDay: (iso) => formatDay(iso),
      },
      get,
    ),
  );
}

function eventMapFor(request: EventMapRequest): Promise<EventMapResponse> {
  return withConnection(request.organizationId, request.host, (status, _settings, get) =>
    loadFormEventMap(
      {
        environmentId: status.environmentId,
        scanCompletedAt: status.latestCompletedScanAt,
        table: request.table,
        formId: request.formId,
        formatDate: formatScanDate,
      },
      get,
    ),
  );
}

// --- Power Platform admin center overlay (M14) ------------------------------------

/**
 * The admin center names the Dataverse organization and nothing else, so the
 * environment is matched on the organization id alone. Anything short of a
 * connected environment with a Completed scan answers "none": the page stays
 * silent.
 */
async function withAdminConnection<R extends { kind: string }>(
  organizationId: string,
  load: (context: AdminContext, get: Get) => Promise<R>,
): Promise<R | { kind: "none" }> {
  const answered = await withConnection(organizationId, ADMIN_HOST, async (status, settings, get) =>
    load(
      {
        pathixUrl: settings.pathixUrl,
        environmentId: status.environmentId,
        // withConnection only calls this with a Completed scan.
        scanCompletedAt: status.latestCompletedScanAt!,
        formatDate: formatScanDate,
      },
      get,
    ),
  );
  return isStatus(answered) ? { kind: "none" } : answered;
}

function isStatus(answered: { kind: string }): answered is { kind: "status"; status: ConnectionStatus } {
  return answered.kind === "status";
}

const adminRoleFor = (request: AdminRoleRequest): Promise<AdminRoleResponse> =>
  withAdminConnection(request.organizationId, (context, get) => loadRoleBanner(context, request.roleId, get));

const adminRoleListFor = (request: AdminRoleListRequest): Promise<AdminRoleListResponse> =>
  withAdminConnection(request.organizationId, (context, get) => loadRoleBadges(context, request.roleIds, get));

const adminAppUsersFor = (request: AdminAppUsersRequest): Promise<AdminAppUsersResponse> =>
  withAdminConnection(request.organizationId, (context, get) => loadAppUserChips(context, request.appIds, get));

const adminOverlay = new ReconcileQueue(() => reconcileAdminOverlay(browserOverlayDeps(chrome, ADMIN_OVERLAY_KEY)));

function savePreviewFor(request: SavePreviewRequest): Promise<SavePreviewResponse> {
  return withConnection(request.organizationId, request.host, (status, _settings, get) =>
    loadSavePreview(
      {
        environmentId: status.environmentId,
        environmentName: status.environmentName,
        scanCompletedAt: status.latestCompletedScanAt,
        table: request.table,
        message: request.message,
        columns: request.columns,
        formId: request.formId,
        formatDate: formatScanDate,
      },
      get,
    ),
  );
}

function formatScanDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// --- card mode and tips ----------------------------------------------------------

async function cardSettings(): Promise<CardSettings> {
  const local = await chrome.storage.local.get([...SETTINGS_KEYS]);
  return cardSettingsFrom(local, await managedPolicy());
}

/** The organization's policy; empty when none is set or the browser has no managed storage. */
async function managedPolicy(): Promise<Record<string, unknown>> {
  try {
    return (await chrome.storage.managed.get(null)) ?? {};
  } catch {
    return {};
  }
}

async function hideTips(): Promise<CardSettings> {
  await chrome.storage.local.set({ [LOCAL_HIDE_TIPS_KEY]: true });
  return cardSettings();
}

// --- options page -------------------------------------------------------------

/**
 * Sign in, sign out and the account line. Only Sign in, for the settings the
 * page showed the user, starts a sign-in for settings the user has not
 * confirmed. Loading the page signs in silently only for the confirmed
 * binding; sign-out signs nothing in.
 */
async function handleOptionsRequest(request: OptionsRequest): Promise<AccountStatus> {
  if (request.kind === "signOut") {
    await signIn.signOut();
    disconnect();
  }

  const settings = await loadSettings();
  if (!settings) return accountStatus(null);

  let authSettings: AuthSettings;
  try {
    // Read fresh: the options page is where a change on the Pathix side should
    // show. It also forgets a refused grant, so this request asks Entra once more.
    authSettings = await signIn.settingsFor(settings.pathixUrl, { fresh: true });
  } catch (error) {
    clearCaches();
    if (error instanceof SignInUnavailableError) return accountStatus(settings, { signInUnavailable: error.reason });
    // Pathix did not answer, so whether it offers sign-in is unknown. Only the stored token is reported.
    return accountStatus(settings, { pathixUnreachable: errorMessage(error) });
  }

  const { offered, confirmed, changes } = await signIn.confirmation(authSettings);
  const shown: AccountNotes = { offered, changed: changes };
  if (request.kind === "signOut" || (request.kind === "accountStatus" && !confirmed)) return accountStatus(settings, shown);
  if (request.kind === "signIn" && !sameBinding(request.binding, offered)) {
    // The page showed other settings, or none: show these, and sign in on the next click.
    return accountStatus(settings, { ...shown, error: request.binding === null ? null : SHOWN_SETTINGS_CHANGED_TEXT });
  }

  const result = request.kind === "signIn" ? await signIn.confirm(authSettings) : await signIn.token(authSettings, { interactive: false });
  clearCaches();
  const notes: AccountNotes = result.kind === "token" ? { offered, changed: [] } : shown;
  if (result.kind === "refused") return accountStatus(settings, { ...notes, signInUnavailable: result.reason });
  if (result.kind === "notKept") return accountStatus(settings, { ...notes, error: result.signedOut ? SIGNED_OUT_TEXT : NOT_KEPT_TEXT });
  return accountStatus(settings, { ...notes, error: result.kind === "signedOut" && request.kind === "signIn" ? result.reason : null });
}

/** Why Sign in did not start: /config no longer says what the page showed. Shown after "Sign-in did not complete: ". */
const SHOWN_SETTINGS_CHANGED_TEXT = "Pathix's sign-in settings changed while this page was open. Check them below and select Sign in again.";

type AccountNotes = Partial<Pick<AccountStatus, "error" | "signInUnavailable" | "pathixUnreachable" | "offered" | "changed">>;

/**
 * Signed in only with an unexpired token for this Pathix, under the binding
 * the user confirmed. Settings that changed since then hold sign-in until the
 * user selects Sign in again, so the page does not say signed in meanwhile.
 */
async function accountStatus(settings: ExtensionSettings | null, notes: AccountNotes = {}): Promise<AccountStatus> {
  const stored: unknown = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY];
  const binding: unknown = (await chrome.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const kept = storedSignIn(stored, binding, settings?.pathixUrl ?? null, Date.now());
  const held = (notes.changed?.length ?? 0) > 0;
  return {
    configured: settings !== null,
    signedIn: kept.signedIn && !held,
    account: held ? null : kept.account,
    error: null,
    signInUnavailable: null,
    pathixUnreachable: null,
    offered: null,
    changed: [],
    // Sign out removes both, so it is offered while either is stored.
    signOutOffered: signOutOffered(stored, binding),
    ...notes,
  };
}

/** The organization ids each tab asked about since its page loaded (src/background/form-requests.ts). */
const tabOrganizations = new TabOrganizations();

/**
 * A form request from one of the extension's content scripts, for the host of
 * the tab that sent it, about one of the few organizations that tab may ask
 * about. Anything else gets no answer, which a card shows as "did not answer".
 */
function isFormRequestFrom(message: FormRequestScope, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (admitFormRequest(message, sender, tabOrganizations)) return true;
  console.warn(`[pathix] tab ${sender.tab?.id ?? "unknown"}: refused a request for another host, or for too many organizations`);
  return false;
}

function isFromOptionsPage(sender: chrome.runtime.MessageSender): boolean {
  return isFromExtensionPage(sender, "options.html");
}

function isFromExtensionPage(sender: chrome.runtime.MessageSender, page: string): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(page));
}

// --- wiring --------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isOptionsRequest(message)) {
    if (!isFromOptionsPage(sender)) return false;
    void handleOptionsRequest(message).then(sendResponse);
    return true;
  }

  if (isCardSettingsRequest(message) || isHideTipsRequest(message)) {
    if (sender.id !== chrome.runtime.id) return false;
    void (message.kind === "hideTips" ? hideTips() : cardSettings()).then(sendResponse);
    return true;
  }

  // A card's "Open options" button. Content scripts cannot open the options
  // page themselves.
  if (isOpenOptionsRequest(message)) {
    if (sender.id !== chrome.runtime.id) return false;
    void chrome.runtime.openOptionsPage().then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }

  if (isFieldCardRequest(message)) {
    if (!isFormRequestFrom(message, sender)) return false;
    void fieldCardFor(message).then(sendResponse);
    return true;
  }

  if (isXrayRequest(message)) {
    if (!isFormRequestFrom(message, sender)) return false;
    void xrayFor(message).then(sendResponse);
    return true;
  }

  if (isTableChangesRequest(message)) {
    if (!isFormRequestFrom(message, sender)) return false;
    void tableChangesFor(message).then(sendResponse);
    return true;
  }

  // The admin center overlay's page script, on the admin host only.
  if (isAdminRoleRequest(message) || isAdminRoleListRequest(message) || isAdminAppUsersRequest(message)) {
    if (!isFromAdminPage(sender, chrome.runtime.id)) return false;
    const answer =
      message.kind === "adminRole"
        ? adminRoleFor(message)
        : message.kind === "adminRoleList"
          ? adminRoleListFor(message)
          : adminAppUsersFor(message);
    void answer.then(sendResponse, () => sendResponse({ kind: "none" }));
    return true;
  }

  // The options page or the toolbar popup asks the worker to reconcile the
  // registration and report. Both carry the same switch.
  if (isAdminOverlayStatusRequest(message)) {
    if (!isFromOptionsPage(sender) && !isFromExtensionPage(sender, "popup.html")) return false;
    void adminOverlay.request().then(sendResponse);
    return true;
  }

  if (isEventMapRequest(message)) {
    if (!isFormRequestFrom(message, sender)) return false;
    void eventMapFor(message).then(sendResponse);
    return true;
  }

  if (isSavePreviewRequest(message)) {
    if (!isFormRequestFrom(message, sender)) return false;
    void savePreviewFor(message).then(sendResponse);
    return true;
  }

  // Validated again rather than trusting the content script: the check is
  // cheap and keeps this the one place a bad message is refused.
  if (!isPageMessage(message) || message.kind !== "formSnapshot") return false;
  if (!isFormRequestFrom(message, sender)) return false;
  void connectionFor(message.organizationId, message.host).then((status) => {
    void badges.apply(sender.tab?.id, status);
    console.info(`[pathix] tab ${sender.tab?.id ?? "unknown"}: ${message.table} on ${message.host}, ${describeConnection(status)}`);
    sendResponse(status);
  });
  return true;
});

// The admin center overlay's registration follows the setting and the host
// permission. It is reconciled when the worker starts (the browser may have
// restarted, or the permission may have been removed from the browser's own
// settings while the worker slept), when the setting changes, and when the
// permission is added or removed.
void adminOverlay.request();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ADMIN_OVERLAY_KEY in changes) void adminOverlay.request();
});
// Every permission change reconciles. A grant can arrive after the page that
// asked for it closed (the prompt closes the toolbar popup): the recorded
// intent finishes turning it on. A grant made elsewhere turns nothing on.
const permissionChange: PermissionChangeDeps = {
  completeIntent: () =>
    completeEnableIntent({
      readIntent: async () => (await chrome.storage.local.get(ADMIN_OVERLAY_INTENT_KEY))[ADMIN_OVERLAY_INTENT_KEY],
      clearIntent: () => chrome.storage.local.remove(ADMIN_OVERLAY_INTENT_KEY),
      setEnabled: (enabled) => chrome.storage.local.set({ [ADMIN_OVERLAY_KEY]: enabled }),
      now: Date.now,
    }),
  reconcile: () => adminOverlay.request(),
};
chrome.permissions.onAdded.addListener((permissions) => void onPermissionsChanged("added", permissions, permissionChange));
chrome.permissions.onRemoved.addListener((permissions) => void onPermissionsChanged("removed", permissions, permissionChange));

// A new Pathix address, or none, invalidates everything learned from the old
// one: its sign-in settings, the token, the confirmed binding and any refused
// grant. The new address signs in only after the user selects Sign in for it.
// Saving the same address again changes nothing. A change to the tips setting
// invalidates nothing.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("pathixUrl" in changes)) return;
  if (changes.pathixUrl!.oldValue === changes.pathixUrl!.newValue) return;
  void signIn.forget();
  disconnect();
});

// An earlier build stored the client ID the user typed. Nothing reads it now.
chrome.runtime.onInstalled.addListener((details) => {
  void forgetLegacyClientId(details.reason, (key) => chrome.storage.local.remove(key));
});

// A tab that loads a new page starts with no badge; the page's own form
// snapshot sets it again if it is a connected D365 form. (The event carries no
// URL without the tabs permission, so it only tells us a page is loading.)
// When it finishes, ask the tab's content script to re-send its last snapshot.
// A tab that left D365 has no content script, so the send fails and its badge
// stays cleared. The message carries no address.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void badges.reset(tabId);
    tabOrganizations.reset(tabId);
  }
  if (changeInfo.status === "complete") {
    const refresh: RefreshBadgeCommand = { kind: "refreshBadge" };
    chrome.tabs.sendMessage(tabId, refresh).catch(() => {
      // No content script here: not a D365 page, nothing to refresh.
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabOrganizations.reset(tabId));

// The toolbar button opens the popup (manifest action.default_popup), so
// the action click event never fires and the worker has no click to handle.
// The popup talks to the active tab's content script itself, and opens the
// demo on a page that has none.

// Keyboard shortcuts are manifest commands (src/runtime/commands.ts). The
// browser owns the keys; the worker sends the tab the same content command the
// popup would. The tab id needs no permission.
chrome.commands.onCommand.addListener((command, tab) => {
  void runCommand(command, tab?.id, {
    send: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    activeTabId: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
  });
});
