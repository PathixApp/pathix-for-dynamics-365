// The admin center overlay follows the browser's permission, whichever way it
// changes. The user can remove the admin host in the browser's own site
// settings: the worker reconciles on every permission change (so the
// registration goes and the setting follows), and an open options page or
// popup redraws its switch. A grant made elsewhere turns nothing on.

import { describe, expect, it, vi } from "vitest";
import { onPermissionsChanged, reconcileAdminOverlay, type OverlayDeps } from "../src/background/admin-overlay";
import { watchOverlayStatus, type WatchDeps } from "../src/options/admin-toggle";
import { ADMIN_HOST_PATTERN, type AdminOverlayStatus } from "../src/runtime/admin-overlay";

describe("the worker on a permission change", () => {
  function deps() {
    const log: string[] = [];
    return {
      log,
      deps: {
        completeIntent: vi.fn(async () => {
          log.push("completeIntent");
          return false;
        }),
        reconcile: vi.fn(async () => void log.push("reconcile")),
      },
    };
  }

  it.each([
    ["the admin host", [ADMIN_HOST_PATTERN]],
    ["another origin, as a site-settings change may report it", ["https://admin.powerplatform.microsoft.com/"]],
    ["no origins at all", undefined],
  ])("reconciles when %s is removed", async (_label, origins) => {
    const { deps: d, log } = deps();
    await onPermissionsChanged("removed", origins ? { origins } : {}, d);
    expect(log).toEqual(["reconcile"]);
  });

  it("finishes a recorded turn-on before reconciling when the admin host is granted", async () => {
    const { deps: d, log } = deps();
    await onPermissionsChanged("added", { origins: [ADMIN_HOST_PATTERN] }, d);
    expect(log).toEqual(["completeIntent", "reconcile"]);
  });

  it("reconciles on any other grant, without touching the intent", async () => {
    const { deps: d, log } = deps();
    await onPermissionsChanged("added", { origins: ["https://pathix.contoso.test/*"] }, d);
    expect(log).toEqual(["reconcile"]);
  });

  it("still reconciles when finishing the intent fails", async () => {
    const { deps: d, log } = deps();
    d.completeIntent.mockRejectedValueOnce(new Error("storage"));
    await onPermissionsChanged("added", { origins: [ADMIN_HOST_PATTERN] }, d);
    expect(log).toEqual(["reconcile"]);
  });

  it("never turns the overlay on for a grant the user did not ask for here", async () => {
    // Granted in the browser's settings, setting off: reconciling registers nothing and leaves the setting off.
    const calls: string[] = [];
    const overlay: OverlayDeps = {
      getRegistered: async () => [],
      register: async () => void calls.push("register"),
      unregister: async () => void calls.push("unregister"),
      hasPermission: async () => true,
      isEnabled: async () => false,
      setEnabled: async (enabled) => void calls.push(`setEnabled(${enabled})`),
      notifyOff: async () => void calls.push("notifyOff"),
    };
    await onPermissionsChanged("added", { origins: [ADMIN_HOST_PATTERN] }, { completeIntent: async () => false, reconcile: () => reconcileAdminOverlay(overlay) });
    expect(calls).toEqual([]);
  });
});

describe("an open page's switch", () => {
  const ON: AdminOverlayStatus = { enabled: true, registered: true, error: null };
  const OFF: AdminOverlayStatus = { enabled: false, registered: false, error: null };

  function harness(answers: Array<AdminOverlayStatus | Error>) {
    const listeners: { permission?: () => void; setting?: () => void } = {};
    const pending: Array<() => void> = [];
    const deps: WatchDeps = {
      onPermissionChange: (listener) => void (listeners.permission = listener),
      onSettingChange: (listener) => void (listeners.setting = listener),
      status: vi.fn(
        () =>
          new Promise<AdminOverlayStatus>((resolve, reject) => {
            const answer = answers.shift()!;
            pending.push(() => (answer instanceof Error ? reject(answer) : resolve(answer)));
          }),
      ),
    };
    const rendered: Array<AdminOverlayStatus | null> = [];
    let busy = false;
    const watch = watchOverlayStatus(deps, (status) => rendered.push(status), () => busy);
    return { listeners, pending, rendered, deps, watch, setBusy: (value: boolean) => void (busy = value) };
  }

  const settle = async (pending: Array<() => void>) => {
    for (const answer of pending.splice(0)) answer();
    await new Promise((done) => setTimeout(done, 0));
  };

  it("redraws when the permission is removed in the browser's settings", async () => {
    const { listeners, pending, rendered } = harness([OFF]);
    listeners.permission!();
    await settle(pending);
    expect(rendered).toEqual([OFF]);
  });

  it("redraws when the setting changes, for example when the worker turns it off", async () => {
    const { listeners, pending, rendered } = harness([OFF]);
    listeners.setting!();
    await settle(pending);
    expect(rendered).toEqual([OFF]);
  });

  it("draws only the latest answer", async () => {
    const { listeners, pending, rendered } = harness([ON, OFF]);
    listeners.permission!();
    listeners.setting!();
    await settle(pending);
    expect(rendered).toEqual([OFF]);
  });

  it("leaves the switch to the page's own toggle while it runs", async () => {
    const { listeners, pending, rendered, deps, setBusy } = harness([OFF]);
    setBusy(true);
    listeners.permission!();
    expect(deps.status).not.toHaveBeenCalled();
    setBusy(false);
    listeners.permission!();
    await settle(pending);
    expect(rendered).toEqual([OFF]);
  });

  it("drops an answer asked before the page's own toggle started, even if it lands after the toggle finished", async () => {
    const { listeners, pending, rendered, watch, setBusy } = harness([ON]);
    listeners.permission!();
    // The user clicks the switch: the toggle supersedes the answer in flight, runs, and finishes.
    watch.supersede();
    setBusy(true);
    setBusy(false);
    await settle(pending);
    expect(rendered).toEqual([]);
  });

  it("draws the page's first read, and a toggle started before it answers supersedes it too", async () => {
    const first = harness([OFF]);
    first.watch.refresh();
    await settle(first.pending);
    expect(first.rendered).toEqual([OFF]);

    const raced = harness([ON]);
    raced.watch.refresh();
    raced.watch.supersede();
    await settle(raced.pending);
    expect(raced.rendered).toEqual([]);
  });

  it("draws unknown, never on, when the worker does not answer", async () => {
    const { listeners, pending, rendered } = harness([new Error("no worker")]);
    listeners.permission!();
    await settle(pending);
    expect(rendered).toEqual([null]);
  });
});
