// The options page's "Admin center overlay" switch (M14).
//
// Turning it on records the intent (not awaited), then asks for the admin host
// from the click itself (a permission request needs a user gesture, so it is
// the first thing awaited), then stores the setting. The prompt can close the
// toolbar popup before the setting is stored; the worker then finishes from
// the recorded intent when the permission arrives. The service worker sees the setting and the permission change
// and registers the page script; this module asks it for the result so the
// page can say what actually happened.
//
// Turning it off stores the setting first, then removes the permission, so the
// worker unregisters the script and tells open admin tabs to clean up.

// The options page and the toolbar popup both carry the switch, and share this
// module: the same order, the same gesture rule, the same words.

import {
  ADMIN_HOST_PATTERN,
  ADMIN_OVERLAY_INTENT_KEY,
  ADMIN_OVERLAY_KEY,
  type AdminOverlayStatus,
  type AdminOverlayStatusRequest,
} from "../runtime/admin-overlay";

export interface ToggleDeps {
  /** Records "the user asked to turn it on", fire-and-forget: it must not delay the permission request. */
  recordIntent(): void;
  clearIntent(): Promise<void>;
  requestPermission(origins: string[]): Promise<boolean>;
  removePermission(origins: string[]): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  /** Asks the service worker to reconcile and report. */
  status(): Promise<AdminOverlayStatus>;
}

export type ToggleResult =
  | { ok: true; status: AdminOverlayStatus }
  | { ok: false; reason: "denied" | "failed"; message: string; status: AdminOverlayStatus | null };

export const DENIED_MESSAGE = "The browser did not grant access to the Power Platform admin center, so the overlay stays off.";

export async function turnOverlayOn(deps: ToggleDeps): Promise<ToggleResult> {
  try {
    // Not awaited: the request below must start while the click still counts as a user gesture.
    deps.recordIntent();
    // Only the admin host is asked for.
    const granted = await deps.requestPermission([ADMIN_HOST_PATTERN]);
    if (!granted) {
      await deps.clearIntent().catch(() => undefined);
      return { ok: false, reason: "denied", message: DENIED_MESSAGE, status: null };
    }

    await deps.setEnabled(true);
    await deps.clearIntent().catch(() => undefined);
    const status = await deps.status();
    if (!status.enabled || !status.registered) {
      return { ok: false, reason: "failed", message: status.error ?? "The overlay did not start.", status };
    }
    return { ok: true, status };
  } catch (error) {
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error), status: null };
  }
}

export async function turnOverlayOff(deps: ToggleDeps): Promise<ToggleResult> {
  try {
    // A turn-on the user started and then reversed must not finish later.
    await deps.clearIntent().catch(() => undefined);
    await deps.setEnabled(false);
    await deps.removePermission([ADMIN_HOST_PATTERN]).catch(() => false);
    const status = await deps.status();
    return { ok: true, status };
  } catch (error) {
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error), status: null };
  }
}

/** What the switch shows for the worker's report: on only when enabled and registered. */
export function adminStatusLine(status: AdminOverlayStatus | null): { on: boolean; text: string; tone: "ok" | "error" | "neutral" } {
  const on = status?.enabled === true && status.registered;
  if (status?.error) return { on, text: `The overlay did not start: ${status.error}`, tone: "error" };
  if (on) return { on, text: "On. Reload open admin center tabs to see it.", tone: "ok" };
  return { on, text: "Off.", tone: "neutral" };
}

export interface WatchDeps {
  /** Calls `listener` when the browser grants or removes any permission. */
  onPermissionChange(listener: () => void): void;
  /** Calls `listener` when the overlay setting changes in storage. */
  onSettingChange(listener: () => void): void;
  /** Asks the service worker to reconcile and report. */
  status(): Promise<AdminOverlayStatus>;
}

/**
 * Keeps an open page's switch true to the browser. The admin host can be
 * removed (or granted) outside the extension, in the browser's own site
 * settings; the worker reconciles, and the switch shows what it found. While
 * the page's own toggle is running (`busy`), its result is what shows, and the
 * page calls `supersede()` when the toggle starts so an earlier answer cannot
 * land after it. Only the latest answer is drawn.
 */
export function watchOverlayStatus(deps: WatchDeps, render: (status: AdminOverlayStatus | null) => void, busy: () => boolean): OverlayWatch {
  let asked = 0;
  const refresh = () => {
    if (busy()) return;
    const ask = ++asked;
    void deps.status().then(
      (status) => ask === asked && !busy() && render(status),
      () => ask === asked && !busy() && render(null),
    );
  };
  deps.onPermissionChange(refresh);
  deps.onSettingChange(refresh);
  return { refresh, supersede: () => void asked++ };
}

export interface OverlayWatch {
  /** Asks the worker now and draws its answer: the page's first read, so a toggle supersedes it too. */
  refresh(): void;
  /**
   * The page's own toggle is starting: an answer asked for before it is
   * dropped, so it can never land after the toggle's own result.
   */
  supersede(): void;
}

/** The real browser behind WatchDeps, for an extension page. */
export function chromeWatchDeps(api: typeof chrome): WatchDeps {
  return {
    onPermissionChange(listener) {
      api.permissions.onAdded.addListener(() => listener());
      api.permissions.onRemoved.addListener(() => listener());
    },
    onSettingChange(listener) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && ADMIN_OVERLAY_KEY in changes) listener();
      });
    },
    status: chromeToggleDeps(api).status,
  };
}

/** The real browser calls, for an extension page (the options page or the popup). */
export function chromeToggleDeps(api: typeof chrome): ToggleDeps {
  return {
    recordIntent: () => void api.storage.local.set({ [ADMIN_OVERLAY_INTENT_KEY]: Date.now() }).catch(() => undefined),
    clearIntent: () => api.storage.local.remove(ADMIN_OVERLAY_INTENT_KEY),
    requestPermission: (origins) => api.permissions.request({ origins }),
    removePermission: (origins) => api.permissions.remove({ origins }),
    setEnabled: (enabled) => api.storage.local.set({ [ADMIN_OVERLAY_KEY]: enabled }),
    status: async () => (await api.runtime.sendMessage({ kind: "adminOverlayStatus" } satisfies AdminOverlayStatusRequest)) as AdminOverlayStatus,
  };
}
