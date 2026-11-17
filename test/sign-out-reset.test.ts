// Sign-out sticks on the form too (DESIGN.md, "Sign out sticks"). X-ray's
// lines are Pathix's counts, written into the form, so signing out (or a new
// Pathix address) takes them down in every open tab: the worker tells each
// tab, and an X-ray that is on clears its lines and asks again, which then
// says the user is not signed in. An open card closes.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { PATHIX_RESET, tellTabs } from "../src/background/tabs";
import { EventMapController } from "../src/content/event-map-controller";
import { HoverController } from "../src/content/hover-controller";
import { SavePreviewController } from "../src/content/save-preview-controller";
import { WhatChangedController } from "../src/content/what-changed-controller";
import { XrayController } from "../src/content/xray-controller";
import { isPathixResetCommand } from "../src/runtime/messages";
import { pathixResetListener } from "../src/runtime/toolbar";

const flush = () => new Promise((done) => setTimeout(done, 0));

describe("the worker tells every tab", () => {
  it("sends the reset to each tab with an id, and a tab with no content script is ignored", async () => {
    const sent: number[] = [];
    const tabs = {
      query: vi.fn(async () => [{ id: 1 }, {}, { id: 2 }, { id: 3 }]),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        expect(message).toEqual({ kind: "pathixReset" });
        if (tabId === 2) throw new Error("Receiving end does not exist.");
        sent.push(tabId);
      }),
    };
    await tellTabs(tabs, PATHIX_RESET);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([1, 3]);
  });

  it("never throws when the tabs cannot be listed", async () => {
    await expect(tellTabs({ query: async () => Promise.reject(new Error("no")), sendMessage: vi.fn() }, PATHIX_RESET)).resolves.toBeUndefined();
  });

  it("does so whenever it forgets Pathix: on sign-out and on a new address", () => {
    const worker = readFileSync("src/background/service-worker.ts", "utf8");
    const disconnect = worker.slice(worker.indexOf("function disconnect(): void {"));
    expect(disconnect.slice(0, disconnect.indexOf("\n}\n"))).toContain("void tellTabs(chromeTabs(chrome), PATHIX_RESET);");
    expect(worker).toMatch(/if \(request\.kind === "signOut"\) \{\s*await signIn\.signOut\(\);\s*disconnect\(\);/);
    expect(worker).toMatch(/void signIn\.forget\(\);\s*disconnect\(\);/);
  });
});

describe("the content script hears it", () => {
  it("resets on the extension's own message, and ignores anything else", () => {
    const reset = vi.fn();
    const respond = vi.fn();
    const listener = pathixResetListener("ext-id", reset);
    listener({ kind: "pathixReset" }, { id: "other" }, respond);
    listener({ kind: "pathixReset", host: "x" }, { id: "ext-id" }, respond);
    listener({ kind: "refreshBadge" }, { id: "ext-id" }, respond);
    expect(reset).not.toHaveBeenCalled();
    listener({ kind: "pathixReset" }, { id: "ext-id" }, respond);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true);
  });

  it("accepts the reset with nothing on it", () => {
    expect(isPathixResetCommand({ kind: "pathixReset" })).toBe(true);
    expect(isPathixResetCommand({ kind: "pathixReset", extra: 1 })).toBe(false);
    expect(isPathixResetCommand(null)).toBe(false);
  });

  it("asks again on everything that shows Pathix: the card first, then X-ray and the three panels", () => {
    const content = readFileSync("src/content/content.ts", "utf8");
    expect(content).toMatch(
      /pathixResetListener\(chrome\.runtime\.id, \(\) => \{\s*hover\.reset\(\);\s*xray\.reset\(\);\s*eventMap\.reset\(\);\s*whatChanged\.reset\(\);\s*savePreview\.reset\(\);/,
    );
  });

});

describe("the panels on reset", () => {
  const panelSnapshot = {
    organizationId: "5c4a0000-0000-4000-8000-000000000003",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: "5c4a0000-0000-4000-8000-000000000021",
    columns: [{ control: "name", column: "name" }],
    dirtyColumns: ["name"],
    alwaysSubmitColumns: [],
    lockedControls: [],
    saveKind: "update",
  } as unknown as FormSnapshot;

  /** Any method a panel calls on its view or its sources, as a spy; settings answer in `mode`. */
  function fakes(mode: "connected" | "lite") {
    const spies = new Map<string, ReturnType<typeof vi.fn>>();
    const spy = (name: string) => {
      if (!spies.has(name)) spies.set(name, vi.fn(async () => undefined));
      return spies.get(name)!;
    };
    const view = new Proxy({}, { get: (_target, name) => spy(`view.${String(name)}`) });
    const settings = vi.fn(async () => ({ mode, showTips: true }));
    const sources = new Proxy({}, { get: (_target, name) => (name === "settings" ? settings : spy(`sources.${String(name)}`)) });
    return { view, sources, settings };
  }

  const panels = {
    "event map": (view: unknown, sources: unknown) => new EventMapController(view as never, sources as never),
    "what changed": (view: unknown, sources: unknown) => new WhatChangedController(view as never, sources as never),
    "save preview": (view: unknown, sources: unknown) => new SavePreviewController(view as never, sources as never),
  };

  it.each(Object.keys(panels) as Array<keyof typeof panels>)("the %s asks again when it is open and connected", async (name) => {
    const { view, sources, settings } = fakes("connected");
    const panel = panels[name](view, sources);
    panel.setSnapshot(panelSnapshot);
    panel.open();
    await flush();
    expect(settings).toHaveBeenCalledTimes(1);
    panel.reset();
    await flush();
    expect(settings).toHaveBeenCalledTimes(2);
  });

  it.each(Object.keys(panels) as Array<keyof typeof panels>)("the %s is left alone when it last answered in Lite, or is closed", async (name) => {
    const { view, sources, settings } = fakes("lite");
    const panel = panels[name](view, sources);
    panel.setSnapshot(panelSnapshot);
    panel.reset();
    expect(settings).not.toHaveBeenCalled();
    panel.open();
    await flush();
    panel.reset();
    await flush();
    expect(settings).toHaveBeenCalledTimes(1);
  });
});

describe("X-ray on reset", () => {
  const snapshot = { organizationId: "o", host: "contoso.crm.dynamics.com", table: "account", formId: null, columns: [{ control: "name", column: "name" }] } as unknown as FormSnapshot;

  function harness() {
    const messages: string[] = [];
    const view = { setOnClose: () => undefined, showMessage: (text: string) => messages.push(text), showLegend: vi.fn(), hide: vi.fn(), setNote: () => undefined };
    const lines = { setOnUnmarked: () => undefined, clear: vi.fn(), show: vi.fn() };
    const fetchXray = vi.fn(async (): Promise<unknown> => ({ kind: "xray", model: { entries: [{ column: "name", writers: 1 }], scopeLine: "" } }));
    const controller = new XrayController(view as never, lines as never, fetchXray as never);
    controller.setSnapshot(snapshot);
    return { controller, view, lines, fetchXray, messages };
  }

  it("clears the lines and asks again, and the panel then says the user is signed out", async () => {
    const { controller, lines, fetchXray, messages } = harness();
    controller.setOn(true);
    await flush();
    expect(lines.show).toHaveBeenCalledTimes(1);
    lines.clear.mockClear();
    fetchXray.mockResolvedValueOnce({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    controller.reset();
    expect(lines.clear).toHaveBeenCalled();
    await flush();
    expect(fetchXray).toHaveBeenCalledTimes(2);
    expect(lines.show).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)).toMatch(/sign/i);
  });

  it("does nothing when X-ray is off", () => {
    const { controller, lines, fetchXray } = harness();
    controller.reset();
    expect(lines.clear).not.toHaveBeenCalled();
    expect(fetchXray).not.toHaveBeenCalled();
  });
});

describe("the card on reset", () => {
  const container = {
    isConnected: true,
    getAttribute: (name: string) => (name === "data-id" ? "name-FieldSectionItemContainer" : null),
    getBoundingClientRect: () => ({}),
    querySelector: () => null,
  };
  const formSnapshot = {
    organizationId: "5c4a0000-0000-4000-8000-000000000003",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: null,
    columns: [{ control: "name", column: "name" }],
    dirtyColumns: [],
    lockedControls: [],
  } as unknown as FormSnapshot;

  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, addEventListener: () => undefined });
    vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
  });
  afterEach(() => void vi.unstubAllGlobals());

  function harness(mode: "connected" | "lite") {
    const view = {
      isOpen: false,
      hasFocus: true,
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      setOnOpenOptions: () => undefined,
      takeFocus: vi.fn(),
      showMessage: vi.fn(() => void (view.isOpen = true)),
      showState: vi.fn(() => void (view.isOpen = true)),
      showLiteCards: vi.fn(() => void (view.isOpen = true)),
      contains: () => false,
      hide: vi.fn(),
    };
    const sources = {
      settings: vi.fn(async () => ({ mode, showTips: true })),
      connectedCard: vi.fn(async (): Promise<unknown> => undefined),
      liteCards: vi.fn(async () => ({ registered: {}, dependencies: {}, locked: null })),
    };
    const controller = new HoverController(view as never, sources as never);
    controller.setSnapshot(formSnapshot);
    return { controller, view, sources };
  }

  it("asks Pathix again for an open card, keeps it open and moves no focus, and says what the connection is now", async () => {
    const { controller, view, sources } = harness("connected");
    controller.openFor("name", container as never);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalledTimes(1));
    sources.connectedCard.mockResolvedValueOnce({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    controller.reset();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalledTimes(2));
    expect(sources.connectedCard).toHaveBeenCalledTimes(2);
    expect(view.hide).not.toHaveBeenCalled();
    // Only the first draw of the card took focus; the reset's draws keep it where it is.
    expect(view.takeFocus).toHaveBeenCalledTimes(1);
    const [, , , state] = view.showState.mock.calls.at(-1) as unknown as [unknown, unknown, unknown, { kind: string }];
    expect(state.kind).toBe("signedOut");
  });

  it("never draws an answer still in flight from before the reset; the re-ask's answer is drawn", async () => {
    const { controller, view, sources } = harness("connected");
    let answerOld: (value: unknown) => void = () => undefined;
    sources.connectedCard.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)));
    controller.openFor("name", container as never);
    await vi.waitFor(() => expect(sources.connectedCard).toHaveBeenCalledTimes(1));
    sources.connectedCard.mockResolvedValueOnce({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    controller.reset();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalledTimes(1));
    // The old request answers late, with what Pathix said before the sign-out.
    answerOld({ kind: "status", status: { kind: "notScanned" } });
    await flush();
    expect(view.showState).toHaveBeenCalledTimes(1);
    const [, , , state] = view.showState.mock.calls[0] as unknown as [unknown, unknown, unknown, { kind: string }];
    expect(state.kind).toBe("signedOut");
  });

  it("lets a hover card that is already closing close, without asking again", async () => {
    vi.useFakeTimers();
    try {
      const listeners: Record<string, (event: unknown) => void> = {};
      vi.stubGlobal("document", { activeElement: null, addEventListener: (type: string, fn: (event: unknown) => void) => void (listeners[type] = fn) });
      // The fake clock's timers, not the ones the stub took before it was installed.
      vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
      const { controller, view, sources } = harness("connected");
      controller.attach();
      const label = { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) };
      listeners.mouseover!({ target: label, isTrusted: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(view.showState).toHaveBeenCalledTimes(1);
      // The pointer left: the card is in its short hide delay when the reset arrives.
      listeners.mouseover!({ target: { closest: () => null }, isTrusted: true });
      controller.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources.settings).toHaveBeenCalledTimes(1);
      expect(view.hide).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a Lite card alone: it holds no Pathix answer", async () => {
    const { controller, view, sources } = harness("lite");
    controller.openFor("name", container as never);
    await vi.waitFor(() => expect(view.showLiteCards).toHaveBeenCalledTimes(1));
    controller.reset();
    await new Promise((done) => setTimeout(done, 0));
    expect(sources.settings).toHaveBeenCalledTimes(1);
    expect(view.hide).not.toHaveBeenCalled();
  });

  it("does nothing with no card open", () => {
    const { controller, sources } = harness("connected");
    controller.reset();
    expect(sources.settings).not.toHaveBeenCalled();
  });
});

describe("the admin center on reset", () => {
  it("hears the reset from the extension and asks again", () => {
    const admin = readFileSync("src/admin/admin.ts", "utf8");
    expect(admin).toMatch(/else if \(isPathixResetCommand\(message\)\) controller\.pathixReset\(\);/);
  });
});
