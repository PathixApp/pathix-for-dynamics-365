// The open-field-card keyboard command: the content script opens the card for
// the field that has focus, or the field that last had it. It replaced the
// page's Alt+Shift+P key handler; the key is now the browser's to assign.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { HoverController } from "../src/content/hover-controller";

type Listener = (event: { target: unknown; isTrusted?: boolean; key?: string }) => void;

function fakeContainer(control: string, connected = true) {
  return {
    isConnected: connected,
    getAttribute: (name: string) => (name === "data-id" ? `${control}-FieldSectionItemContainer` : null),
    getBoundingClientRect: () => ({}),
    querySelector: () => null,
  };
}

/** A node inside a field's container, as findFieldTarget sees it. */
function nodeIn(container: unknown) {
  return { closest: () => container };
}

const OUTSIDE = { closest: () => null };

const snapshot = {
  organizationId: "5c4a0000-0000-4000-8000-000000000003",
  host: "contoso.crm.dynamics.com",
  table: "account",
  formId: "5c4a0000-0000-4000-8000-000000000021",
  columns: [{ control: "creditlimit", column: "creditlimit" }],
  dirtyColumns: [],
  lockedControls: [],
} as unknown as FormSnapshot;

let listeners: Record<string, Listener>;
let doc: { activeElement: unknown; addEventListener: (type: string, fn: Listener) => void };

beforeEach(() => {
  listeners = {};
  doc = { activeElement: OUTSIDE, addEventListener: (type, fn) => void (listeners[type] = fn) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
});

afterEach(() => void vi.unstubAllGlobals());

function harness() {
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
    hide: () => undefined,
    isOpen: false,
  };
  const settings = vi.fn(async () => ({ mode: "connected" as const, showTips: true }));
  const sources = { settings, connectedCard: vi.fn(async () => undefined) };
  const controller = new HoverController(view as never, sources as never);
  controller.attach();
  controller.setSnapshot(snapshot);
  return { controller, settings };
}

describe("the open-field-card command", () => {
  it("opens the card for the field that has focus", () => {
    const { controller, settings } = harness();
    doc.activeElement = nodeIn(fakeContainer("creditlimit"));
    expect(controller.openFocused()).toBe("opened");
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("opens the card for the field that last had focus, when focus has moved off the form", () => {
    const { controller, settings } = harness();
    listeners.focusin!({ target: nodeIn(fakeContainer("creditlimit")), isTrusted: true });
    doc.activeElement = OUTSIDE;
    expect(controller.openFocused()).toBe("opened");
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the last focused field is no longer on the page", () => {
    const { controller, settings } = harness();
    listeners.focusin!({ target: nodeIn(fakeContainer("creditlimit", false)), isTrusted: true });
    expect(controller.openFocused()).toBe("noField");
    expect(settings).not.toHaveBeenCalled();
  });

  it("does nothing with no field focused, or a field the form does not bind", () => {
    const { controller, settings } = harness();
    expect(controller.openFocused()).toBe("noField");
    doc.activeElement = nodeIn(fakeContainer("telephone1"));
    expect(controller.openFocused()).toBe("noCard");
    expect(settings).not.toHaveBeenCalled();
  });

  it("listens for focus and Escape only: no key opens the card from the page", () => {
    harness();
    // pointerdown only notes that the pointer, not a key, moved last.
    expect(Object.keys(listeners).sort()).toEqual(["focusin", "keydown", "mouseover", "pointerdown"]);
  });
});
