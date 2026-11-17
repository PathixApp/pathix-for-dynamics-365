// A script on a *.dynamics.com page can build a fake field container and
// dispatch mouseover or focusin on it, which would drive Pathix and Dataverse
// reads with no user there. The browser marks such events untrusted, and the
// hover card ignores them.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { HoverController } from "../src/content/hover-controller";

type Listener = (event: { target: unknown; isTrusted: boolean; key?: string }) => void;

const container = {
  isConnected: true,
  getAttribute: (name: string) => (name === "data-id" ? "name-FieldSectionItemContainer" : null),
  getBoundingClientRect: () => ({}),
  querySelector: () => null,
};
const field = { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) };
const OUTSIDE = { closest: () => null };

const snapshot = {
  organizationId: "5c4a0000-0000-4000-8000-000000000003",
  host: "contoso.crm.dynamics.com",
  table: "account",
  formId: null,
  columns: [{ control: "name", column: "name" }],
  dirtyColumns: [],
  lockedControls: [],
} as unknown as FormSnapshot;

let listeners: Record<string, Listener>;
let doc: { activeElement: unknown; addEventListener: (type: string, fn: Listener) => void };

beforeEach(() => {
  vi.useFakeTimers();
  listeners = {};
  doc = { activeElement: OUTSIDE, addEventListener: (type, fn) => void (listeners[type] = fn) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    hide: vi.fn(),
    isOpen: true,
  };
  const settings = vi.fn(async () => ({ mode: "connected" as const, showTips: true }));
  const controller = new HoverController(view as never, { settings, connectedCard: vi.fn(async () => undefined) } as never);
  controller.attach();
  controller.setSnapshot(snapshot);
  return { controller, view, settings };
}

describe("events a page script dispatched", () => {
  it("opens no card for an untrusted mouseover, and does for the user's own", () => {
    const { settings } = harness();
    listeners.mouseover!({ target: field, isTrusted: false });
    vi.advanceTimersByTime(1000);
    expect(settings).not.toHaveBeenCalled();
    listeners.mouseover!({ target: field, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("does not remember an untrusted focusin as the field the command opens", () => {
    const { controller, settings } = harness();
    listeners.focusin!({ target: field, isTrusted: false });
    expect(controller.openFocused()).toBe("noField");
    listeners.focusin!({ target: field, isTrusted: true });
    expect(controller.openFocused()).toBe("opened");
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("does not close the card for an untrusted Escape", () => {
    const { view } = harness();
    listeners.keydown!({ target: OUTSIDE, key: "Escape", isTrusted: false });
    expect(view.hide).not.toHaveBeenCalled();
    listeners.keydown!({ target: OUTSIDE, key: "Escape", isTrusted: true });
    expect(view.hide).toHaveBeenCalled();
  });

  it("opens no card from an untrusted click on an X-ray line", () => {
    const lines = readFileSync("src/content/xray-lines.ts", "utf8");
    expect(lines).toMatch(/button\.addEventListener\("click", \(event\) => \{\s*if \(!event\.isTrusted\) return;/);
  });
});
