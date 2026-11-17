// Registers the admin center page script at runtime (M14), only while the user
// has turned the overlay on and granted the admin host.
//
// The manifest has no content script for this host. The script is registered
// with chrome.scripting.registerContentScripts after the user grants the host
// permission, and unregistered when they turn the overlay off or the browser
// reports the permission removed. `reconcileAdminOverlay` makes the
// registration match the setting and the permission, and is safe to call at any
// time: on worker start, on a setting change, on a permission change.
//
// The script matches exactly one host. It never matches a sign-in host or any
// other host (test/admin-overlay.test.ts pins the pattern).

import {
  ADMIN_HOST_PATTERN,
  ADMIN_INTENT_TTL_MS,
  ADMIN_SCRIPT_FILE,
  ADMIN_SCRIPT_ID,
  type AdminOverlayStatus,
} from "../runtime/admin-overlay";

/** The script as registered. Isolated world, top frame only, after the page is idle. */
export const ADMIN_SCRIPT_REGISTRATION = {
  id: ADMIN_SCRIPT_ID,
  matches: [ADMIN_HOST_PATTERN],
  js: [ADMIN_SCRIPT_FILE],
  runAt: "document_idle",
  world: "ISOLATED",
  allFrames: false,
  persistAcrossSessions: true,
} as const;

export interface RegisteredScript {
  id: string;
  matches?: string[];
}

/** The slice of chrome.scripting, chrome.storage and chrome.permissions the reconciliation uses. */
export interface OverlayDeps {
  getRegistered(): Promise<RegisteredScript[]>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  /** Is the admin host permission held right now. */
  hasPermission(): Promise<boolean>;
  /** The setting: did the user turn the overlay on. */
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  /** Tell open admin tabs to remove what they drew. Called after an unregister. */
  notifyOff(): Promise<void>;
}

/**
 * Makes the registration match what the user asked for and the browser granted.
 * - on and granted: the script is registered for exactly the admin host;
 * - anything else: it is not, and open admin tabs are told to clean up;
 * - on but not granted (the user removed the permission in the browser): the
 *   setting follows the permission and goes off, so the toggle never shows on
 *   without the host.
 */
export async function reconcileAdminOverlay(deps: OverlayDeps): Promise<AdminOverlayStatus> {
  try {
    const [enabledSetting, granted] = await Promise.all([deps.isEnabled(), deps.hasPermission()]);
    if (enabledSetting && !granted) await deps.setEnabled(false);
    const wanted = enabledSetting && granted;

    const existing = await deps.getRegistered();
    const current = existing.find((script) => script.id === ADMIN_SCRIPT_ID);

    if (wanted) {
      if (current && !matchesExactlyTheAdminHost(current)) {
        await deps.unregister();
        await deps.register();
      } else if (!current) {
        await deps.register();
      }
      return { enabled: true, registered: true, error: null };
    }

    if (current) {
      await deps.unregister();
      await deps.notifyOff();
    }
    return { enabled: false, registered: false, error: null };
  } catch (error) {
    return { enabled: false, registered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface IntentDeps {
  /** The recorded click time, or anything else when there is none. */
  readIntent(): Promise<unknown>;
  clearIntent(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  now(): number;
}

/**
 * The admin host permission was just granted. If the user clicked to turn the
 * overlay on within the last few minutes, store the setting: the page that
 * asked (the toolbar popup) may have closed with the prompt before it could.
 * The intent is cleared either way, so it is used once. Answers whether it
 * turned the setting on.
 */
export async function completeEnableIntent(deps: IntentDeps): Promise<boolean> {
  const at = await deps.readIntent();
  if (typeof at !== "number") return false;
  await deps.clearIntent();
  const age = deps.now() - at;
  if (age < 0 || age > ADMIN_INTENT_TTL_MS) return false;
  await deps.setEnabled(true);
  return true;
}

export interface PermissionChangeDeps {
  /** Finishes a turn-on the user started in the last minute (completeEnableIntent). */
  completeIntent(): Promise<boolean>;
  reconcile(): Promise<unknown>;
}

/**
 * Any permission change reconciles, whichever origins the browser names: the
 * user can remove the admin host in the browser's own settings, and the
 * registration and the setting must follow. A grant of the admin host first
 * finishes a turn-on the user started; a grant with no such click turns
 * nothing on, since reconciling never turns the setting on.
 */
export async function onPermissionsChanged(kind: "added" | "removed", permissions: { origins?: string[] }, deps: PermissionChangeDeps): Promise<void> {
  if (kind === "added" && permissions.origins?.includes(ADMIN_HOST_PATTERN)) await deps.completeIntent().catch(() => false);
  await deps.reconcile();
}

function matchesExactlyTheAdminHost(script: RegisteredScript): boolean {
  return script.matches?.length === 1 && script.matches[0] === ADMIN_HOST_PATTERN;
}

/**
 * One reconciliation at a time. A setting change and a permission change often
 * arrive together, and two overlapping runs would both try to register the
 * same script id, which the browser refuses.
 */
export class ReconcileQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly run: () => Promise<AdminOverlayStatus>) {}

  request(): Promise<AdminOverlayStatus> {
    const next = this.tail.then(this.run, this.run);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** The real browser behind OverlayDeps. */
export function browserOverlayDeps(
  chromeApi: Pick<typeof chrome, "scripting" | "permissions" | "storage" | "tabs">,
  key: string,
): OverlayDeps {
  return {
    async getRegistered() {
      return chromeApi.scripting.getRegisteredContentScripts({ ids: [ADMIN_SCRIPT_ID] });
    },
    register: () => chromeApi.scripting.registerContentScripts([{ ...ADMIN_SCRIPT_REGISTRATION, matches: [...ADMIN_SCRIPT_REGISTRATION.matches], js: [...ADMIN_SCRIPT_REGISTRATION.js] }]),
    unregister: () => chromeApi.scripting.unregisterContentScripts({ ids: [ADMIN_SCRIPT_ID] }),
    hasPermission: () => chromeApi.permissions.contains({ origins: [ADMIN_HOST_PATTERN] }),
    async isEnabled() {
      return (await chromeApi.storage.local.get(key))[key] === true;
    },
    setEnabled: (enabled) => chromeApi.storage.local.set({ [key]: enabled }),
    async notifyOff() {
      // Tab ids need no permission. A tab without the script has no listener, so the send fails and is ignored.
      const tabs = await chromeApi.tabs.query({});
      await Promise.all(
        tabs.flatMap((tab) =>
          tab.id === undefined ? [] : [chromeApi.tabs.sendMessage(tab.id, { kind: "adminOverlayOff" }).catch(() => undefined)],
        ),
      );
    },
  };
}
