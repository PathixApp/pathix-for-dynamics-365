// After a store update the content script in an open tab is left behind:
// every call to the extension throws "Extension context invalidated". These
// tests hold that the content script notices, takes down what it runs, and
// says one thing on the card ("Pathix was updated. Reload this page to use
// it."), never "did not answer" and never a mode or connection it no longer
// knows.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { EXTENSION_UPDATED, NO_ANSWER, stateLine } from "../src/card/states";
import { ContextWatch, isContextInvalidated } from "../src/content/extension-context";
import { HoverController } from "../src/content/hover-controller";

const INVALIDATED = new Error("Extension context invalidated.");

function watch(alive = true) {
  const state = { alive, interval: null as null | (() => void), cleared: 0 };
  const context = new ContextWatch({
    alive: () => state.alive,
    setInterval: (handler) => {
      state.interval = handler;
      return 7;
    },
    clearInterval: () => void state.cleared++,
  });
  const gone = vi.fn();
  context.onGone(gone);
  return { context, state, gone };
}

describe("noticing that the extension changed under the page", () => {
  it("knows the browser's error, as an Error or as text", () => {
    expect(isContextInvalidated(INVALIDATED)).toBe(true);
    expect(isContextInvalidated("Extension context invalidated.")).toBe(true);
    expect(isContextInvalidated(new Error("Could not establish connection. Receiving end does not exist."))).toBe(false);
    expect(isContextInvalidated(undefined)).toBe(false);
  });

  it("notices a call that throws it, once, and still fails the call", async () => {
    const { context, gone } = watch();
    await expect(context.call(() => Promise.reject(INVALIDATED))).rejects.toBe(INVALIDATED);
    expect(context.isGone).toBe(true);
    const send = vi.fn(async () => "answer");
    await expect(context.call(send)).rejects.toThrow(/invalidated/);
    expect(send).not.toHaveBeenCalled();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("notices a call that throws synchronously, as chrome.runtime.sendMessage does", async () => {
    const { context, gone } = watch();
    await expect(
      context.call(() => {
        throw INVALIDATED;
      }),
    ).rejects.toBe(INVALIDATED);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("does not take an ordinary failure for an update", async () => {
    const { context, gone } = watch();
    await expect(context.call(() => Promise.reject(new Error("worker restarting")))).rejects.toThrow("worker restarting");
    expect(context.isGone).toBe(false);
    expect(gone).not.toHaveBeenCalled();
    await expect(context.call(async () => "answer")).resolves.toBe("answer");
  });

  it("notices on its timer when the runtime id goes, with no call made, and stops the timer", () => {
    const { context, state, gone } = watch();
    context.start();
    state.interval!();
    expect(gone).not.toHaveBeenCalled();
    state.alive = false;
    state.interval!();
    state.interval!();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(state.cleared).toBe(1);
  });

  it("starts no timer when the extension is already gone", () => {
    const { context, state, gone } = watch(false);
    context.start();
    expect(state.interval).toBeNull();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("runs every teardown step even when one throws", () => {
    const { context, state } = watch();
    const later = vi.fn();
    context.onGone(() => {
      throw new Error("boom");
    });
    context.onGone(later);
    state.alive = false;
    context.check();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("the card once the extension changed under the page", () => {
  type Listener = (event: { target: unknown; isTrusted?: boolean }) => void;
  let listeners: Record<string, Listener>;

  const container = {
    getAttribute: (name: string) => (name === "data-id" ? "name-FieldSectionItemContainer" : null),
    getBoundingClientRect: () => ({}),
    querySelector: () => null,
  };
  const field = { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) };
  const snapshot = {
    organizationId: "5c4a0000-0000-4000-8000-000000000003",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: null,
    columns: [{ control: "name", column: "name" }],
    dirtyColumns: [],
    lockedControls: [],
  } as unknown as FormSnapshot;

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = {};
    vi.stubGlobal("document", { activeElement: null, addEventListener: (type: string, fn: Listener) => void (listeners[type] = fn) });
    vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function harness(settings: () => Promise<unknown>) {
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      setOnOpenOptions: () => undefined,
      takeFocus: () => undefined,
      hasFocus: false,
      showMessage: vi.fn(),
      showState: vi.fn(),
      showCard: vi.fn(),
      contains: () => false,
      hide: vi.fn(),
      isOpen: false,
    };
    const sources = { settings: vi.fn(settings), connectedCard: vi.fn(async () => undefined), liteCards: vi.fn() };
    const controller = new HoverController(view as never, sources as never);
    controller.attach();
    controller.setSnapshot(snapshot);
    return { controller, view, sources };
  }

  const hover = async () => {
    listeners.mouseover!({ target: field, isTrusted: true });
    await vi.advanceTimersByTimeAsync(1000);
  };

  it("says to reload the page, asks nothing, and names no mode", async () => {
    const { controller, view, sources } = harness(async () => ({ mode: "lite", showTips: true }));
    controller.extensionGone();
    await hover();
    expect(sources.settings).not.toHaveBeenCalled();
    expect(sources.liteCards).not.toHaveBeenCalled();
    expect(view.showState).toHaveBeenCalledWith(expect.anything(), "account", "name", EXTENSION_UPDATED, null);
  });

  it("says to reload the page when the settings call is what finds the extension gone", async () => {
    let controller: HoverController;
    const built = harness(async () => {
      controller.extensionGone();
      throw INVALIDATED;
    });
    controller = built.controller;
    await hover();
    expect(built.view.showState).toHaveBeenLastCalledWith(expect.anything(), "account", "name", EXTENSION_UPDATED, null);
  });

  it("still says the extension did not answer for any other failure, with no mode claimed", async () => {
    const { view } = harness(async () => {
      throw new Error("worker restarting");
    });
    await hover();
    expect(view.showState).toHaveBeenLastCalledWith(expect.anything(), "account", "name", NO_ANSWER, null);
  });

  it("reads as one plain sentence pair", () => {
    expect(stateLine(EXTENSION_UPDATED)).toBe("Pathix was updated. Reload this page to use it.");
    expect(EXTENSION_UPDATED.action).toBeNull();
  });
});

describe("the content script's wiring", () => {
  const content = readFileSync("src/content/content.ts", "utf8");

  it("calls the extension only through the watch", () => {
    expect(content.match(/chrome\.runtime\.sendMessage\(/g)).toHaveLength(1);
    expect(content).toContain("context.call(() => chrome.runtime.sendMessage(message)");
  });

  it("takes down its timers, listeners, X-ray lines and open panels when the extension is gone", () => {
    const teardown = /function teardown\(\): void \{([\s\S]*?)\n {2}\}/.exec(content)?.[1] ?? "";
    for (const step of [
      "labelFormId.cancel()",
      "window.clearInterval(badgeTimer)",
      'document.removeEventListener("visibilitychange", refreshBadge)',
      'window.removeEventListener("focus", refreshBadge)',
      'navigation?.removeEventListener("navigatesuccess", refreshBadge)',
      "xray.setOn(false)",
      "eventMap.close()",
      "whatChanged.close()",
      "savePreview.close()",
      "hover.extensionGone()",
    ]) {
      expect(teardown).toContain(step);
    }
    expect(content).toContain("context.onGone(teardown);");
    expect(content).toContain("context.start();");
  });
});
