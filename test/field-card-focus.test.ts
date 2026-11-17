// The field card for keyboard and screen reader users (WCAG 2.1.1, 2.4.3,
// 4.1.2). A card opened on purpose (the popup's button, the open-field-card
// command, an X-ray line) takes focus, and Escape or the close button gives it
// back to where it was. A card opened by hover never takes focus. While focus
// is inside a card, the pointer neither closes it nor opens another.
//
// Scrolling closes the card only when the anchored field moved or left the
// viewport, checked once a frame: D365 scrolls on its own.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { fieldMoved, focusFirstIn, HoverController } from "../src/content/hover-controller";

type Listener = (event: { target?: unknown; isTrusted?: boolean; key?: string }) => void;

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A control as focusFirstIn reads it: its attributes, whether it is disabled or hidden, and whether it is drawn. */
function control(options: { tabindex?: string; disabled?: boolean; hidden?: boolean; drawn?: boolean; refuses?: boolean } = {}) {
  const node = {
    isConnected: true,
    disabled: options.disabled ?? false,
    getAttribute: (name: string) => (name === "tabindex" ? (options.tabindex ?? null) : null),
    matches: () => false,
    closest: (selector: string) => (options.hidden && selector.includes("aria-hidden") ? {} : null),
    getClientRects: () => (options.drawn === false ? [] : [{}]),
    getBoundingClientRect: () => (options.drawn === false ? { width: 0, height: 0 } : { width: 100, height: 20 }),
    focus: vi.fn(() => {
      if (!options.refuses) doc.activeElement = node;
    }),
  };
  return node;
}

function fakeContainer(controlName: string, rect: Rect = { top: 100, left: 20, bottom: 130, right: 300 }) {
  const input = control();
  return {
    isConnected: true,
    rect,
    input,
    /** The field's controls, as the fallback finds them. */
    querySelectorAll: () => [input],
    querySelector: () => null,
    getAttribute: (name: string) => (name === "data-id" ? `${controlName}-FieldSectionItemContainer` : null),
    getBoundingClientRect() {
      return this.rect;
    },
  };
}

/** A focusable node inside a field's container, as findFieldTarget sees it. */
function inputIn(container: unknown) {
  return { isConnected: true, focus: vi.fn(), closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) };
}

/** A label: inside the field, not editable, so hovering it opens the card. */
function labelIn(container: unknown) {
  return { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) };
}

const OUTSIDE = { closest: () => null };

const snapshot = {
  organizationId: "5c4a0000-0000-4000-8000-000000000003",
  host: "contoso.crm.dynamics.com",
  table: "account",
  formId: "5c4a0000-0000-4000-8000-000000000021",
  columns: [
    { control: "creditlimit", column: "creditlimit" },
    { control: "name", column: "name" },
  ],
  dirtyColumns: [],
  lockedControls: [],
} as unknown as FormSnapshot;

let documentListeners: Record<string, Listener>;
let windowListeners: Record<string, Listener>;
let frames: Array<() => void>;
let doc: { activeElement: unknown; addEventListener: (type: string, fn: Listener) => void };

beforeEach(() => {
  vi.useFakeTimers();
  documentListeners = {};
  windowListeners = {};
  frames = [];
  doc = { activeElement: OUTSIDE, addEventListener: (type, fn) => void (documentListeners[type] = fn) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: Listener) => void (windowListeners[type] = fn),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness() {
  const view = {
    isOpen: false,
    hasFocus: false,
    setOnClose: () => undefined,
    setOnHideTips: () => undefined,
    setOnOpenOptions: () => undefined,
    takeFocus: vi.fn(),
    showMessage: vi.fn(() => void (view.isOpen = true)),
    showState: vi.fn(() => void (view.isOpen = true)),
    showCard: vi.fn(() => void (view.isOpen = true)),
    contains: (node: unknown) => node === view,
    hide: vi.fn(() => {
      view.isOpen = false;
      view.hasFocus = false;
    }),
  };
  const settings = vi.fn(async () => ({ mode: "connected" as const, showTips: true }));
  const sources = { settings, connectedCard: vi.fn(async () => undefined) };
  const controller = new HoverController(view as never, sources as never);
  controller.attach();
  controller.setSnapshot(snapshot);
  return { controller, view, settings };
}

const escape = () => documentListeners.keydown!({ target: OUTSIDE, key: "Escape", isTrusted: true });

describe("a card opened on purpose", () => {
  it("takes focus when the popup or the command opens it, and Escape gives focus back to the field", async () => {
    const { controller, view } = harness();
    const input = inputIn(fakeContainer("creditlimit"));
    doc.activeElement = input;
    expect(controller.openFocused()).toBe("opened");
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    // Told just before the first draw, once: later draws of the same request do not take focus again.
    expect(view.takeFocus).toHaveBeenCalledTimes(1);
    expect(view.takeFocus.mock.invocationCallOrder[0]).toBeLessThan(view.showMessage.mock.invocationCallOrder[0]!);
    // The card drew and moved focus to its title.
    view.hasFocus = true;
    escape();
    expect(view.hide).toHaveBeenCalled();
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("gives focus back to the field that last had it, when the popup took focus off the form", async () => {
    const { controller, view } = harness();
    const input = inputIn(fakeContainer("creditlimit"));
    documentListeners.focusin!({ target: input, isTrusted: true });
    doc.activeElement = OUTSIDE;
    expect(controller.openFocused()).toBe("opened");
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = true;
    escape();
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("takes focus when an X-ray line opens it, and gives it back to the line", async () => {
    const { controller, view } = harness();
    const line = { isConnected: true, focus: vi.fn() };
    controller.openFor("creditlimit", fakeContainer("creditlimit") as never, line);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    expect(view.takeFocus).toHaveBeenCalledTimes(1);
    view.hasFocus = true;
    escape();
    expect(line.focus).toHaveBeenCalledTimes(1);
  });

  it("does not move focus on close when focus had already left the card", async () => {
    const { controller, view } = harness();
    const input = inputIn(fakeContainer("creditlimit"));
    doc.activeElement = input;
    controller.openFocused();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = false;
    escape();
    expect(view.hide).toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
  });

  it("gives focus to the field's control when D365 replaced the node that had it", async () => {
    const { controller, view } = harness();
    const container = fakeContainer("creditlimit");
    const input = inputIn(container);
    doc.activeElement = input;
    controller.openFocused();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = true;
    // An on-change script re-rendered the input: the node focus came from is gone.
    input.isConnected = false;
    escape();
    expect(input.focus).not.toHaveBeenCalled();
    expect(container.input.focus).toHaveBeenCalledTimes(1);
  });

  it("never focuses a field on the next form when the card closes because the form went away", async () => {
    const { controller, view } = harness();
    const container = fakeContainer("creditlimit");
    const input = inputIn(container);
    doc.activeElement = input;
    controller.openFocused();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = true;
    input.isConnected = false;
    controller.setSnapshot(null);
    expect(view.hide).toHaveBeenCalled();
    expect(container.input.focus).not.toHaveBeenCalled();
  });

  it("gives focus back to the X-ray line redrawn for the same field, when the one it came from is gone", async () => {
    const { controller, view } = harness();
    const old = { isConnected: true, focus: vi.fn() };
    const redrawn = { isConnected: true, focus: vi.fn() };
    const container = fakeContainer("creditlimit");
    controller.openFor("creditlimit", container as never, old, () => redrawn);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = true;
    old.isConnected = false;
    escape();
    expect(old.focus).not.toHaveBeenCalled();
    expect(redrawn.focus).toHaveBeenCalledTimes(1);
    expect(container.input.focus).not.toHaveBeenCalled();
  });

  it("does not leave focus-taking behind for a later hover card when the open ended without a draw", async () => {
    const { controller, view } = harness();
    doc.activeElement = inputIn(fakeContainer("creditlimit"));
    controller.openFocused();
    // The form went away before the card drew: no draw, and nothing told to take focus.
    controller.setSnapshot(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.takeFocus).not.toHaveBeenCalled();
    controller.setSnapshot(snapshot);
    documentListeners.mouseover!({ target: labelIn(fakeContainer("name")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    expect(view.takeFocus).not.toHaveBeenCalled();
  });

  it("stays open, and opens no other card, while focus is inside it and the pointer moves", async () => {
    const { controller, view, settings } = harness();
    doc.activeElement = inputIn(fakeContainer("creditlimit"));
    controller.openFocused();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    view.hasFocus = true;
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    documentListeners.mouseover!({ target: labelIn(fakeContainer("name")), isTrusted: true });
    vi.advanceTimersByTime(2000);
    expect(view.hide).not.toHaveBeenCalled();
    expect(settings).toHaveBeenCalledTimes(1);
  });
});

describe("a card opened by hover", () => {
  it("never takes focus", async () => {
    const { view } = harness();
    documentListeners.mouseover!({ target: labelIn(fakeContainer("creditlimit")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    expect(view.takeFocus).not.toHaveBeenCalled();
  });

  it("closes when the pointer leaves it even with focus inside, after a click on one of its links, and focuses no field", async () => {
    const { view } = harness();
    const container = fakeContainer("creditlimit");
    documentListeners.mouseover!({ target: labelIn(container), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    // A click on its "?" or "Open in Pathix" left focus in it.
    documentListeners.pointerdown!({ isTrusted: true });
    documentListeners.focusin!({ target: view, isTrusted: true });
    view.hasFocus = true;
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(view.hide).toHaveBeenCalled();
    // The mouse user did not come from the field: focusing it could open a lookup's flyout.
    expect(container.input.focus).not.toHaveBeenCalled();
  });

  it("holds like a card opened on purpose once a key moves focus into it", async () => {
    const { view } = harness();
    documentListeners.mouseover!({ target: labelIn(fakeContainer("creditlimit")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    documentListeners.keydown!({ target: OUTSIDE, key: "Tab", isTrusted: true });
    documentListeners.focusin!({ target: view, isTrusted: true });
    view.hasFocus = true;
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(view.hide).not.toHaveBeenCalled();
  });

  it("does not hold for a Tab pressed on the form while focus stays out of it", async () => {
    const { view } = harness();
    documentListeners.mouseover!({ target: labelIn(fakeContainer("creditlimit")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    documentListeners.keydown!({ target: OUTSIDE, key: "Tab", isTrusted: true });
    documentListeners.pointerdown!({ isTrusted: true });
    documentListeners.focusin!({ target: view, isTrusted: true });
    view.hasFocus = true;
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(view.hide).toHaveBeenCalled();
  });

  it("does not carry an earlier purposeful card's return target into a hover card", async () => {
    const { controller, view } = harness();
    const input = inputIn(fakeContainer("creditlimit"));
    doc.activeElement = input;
    controller.openFocused();
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalledTimes(1));
    // Focus left the card; the user hovers another field, then clicks into its card and moves away.
    view.hasFocus = false;
    documentListeners.mouseover!({ target: labelIn(fakeContainer("name")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalledTimes(2));
    documentListeners.pointerdown!({ isTrusted: true });
    view.hasFocus = true;
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(view.hide).toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
  });

  it("still closes when the pointer leaves it", async () => {
    const { view } = harness();
    documentListeners.mouseover!({ target: labelIn(fakeContainer("creditlimit")), isTrusted: true });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(view.showState).toHaveBeenCalled());
    documentListeners.mouseover!({ target: OUTSIDE, isTrusted: true });
    vi.advanceTimersByTime(1000);
    expect(view.hide).toHaveBeenCalled();
  });
});

describe("scrolling while a card is open", () => {
  async function openCard() {
    const h = harness();
    const container = fakeContainer("creditlimit");
    h.controller.openFor("creditlimit", container as never);
    await vi.waitFor(() => expect(h.view.showState).toHaveBeenCalled());
    return { ...h, container };
  }

  it("keeps the card when the field did not move, as when D365 scrolls something else", async () => {
    const { view } = await openCard();
    windowListeners.scroll!({});
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(view.hide).not.toHaveBeenCalled();
  });

  it("closes the card when the field moved", async () => {
    const { view, container } = await openCard();
    container.rect = { top: 60, left: 20, bottom: 90, right: 300 };
    windowListeners.scroll!({});
    frames.shift()!();
    expect(view.hide).toHaveBeenCalled();
  });

  it("checks once a frame, however many scroll events arrive", async () => {
    await openCard();
    for (let i = 0; i < 20; i += 1) windowListeners.scroll!({});
    expect(frames).toHaveLength(1);
  });

  it("does nothing when no card is open", () => {
    harness();
    windowListeners.scroll!({});
    expect(frames).toHaveLength(0);
  });
});

describe("the field's first control that takes focus", () => {
  it("skips controls out of the tab order, disabled, hidden from assistive technology or not drawn", () => {
    const skipped = [control({ tabindex: "-1" }), control({ disabled: true }), control({ hidden: true }), control({ drawn: false })];
    const real = control();
    expect(focusFirstIn({ querySelectorAll: () => [...skipped, real] } as never)).toBe(true);
    for (const node of skipped) expect(node.focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(real);
  });

  it("moves on from a control that does not take focus, and leaves focus alone when none does", () => {
    const refuses = control({ refuses: true });
    const next = control();
    expect(focusFirstIn({ querySelectorAll: () => [refuses, next] } as never)).toBe(true);
    expect(doc.activeElement).toBe(next);
    doc.activeElement = OUTSIDE;
    expect(focusFirstIn({ querySelectorAll: () => [control({ refuses: true }), control({ tabindex: "-1" })] } as never)).toBe(false);
    expect(doc.activeElement).toBe(OUTSIDE);
  });
});

describe("whether a field moved", () => {
  const viewport = { width: 1200, height: 800 };
  const at = { top: 100, left: 20, bottom: 130, right: 300 };

  it("ignores a pixel of rounding", () => {
    expect(fieldMoved(at, { ...at, top: 100.6, bottom: 130.6 }, viewport)).toBe(false);
  });

  it("is a move when the field shifts", () => {
    expect(fieldMoved(at, { top: 80, left: 20, bottom: 110, right: 300 }, viewport)).toBe(true);
    expect(fieldMoved(at, { top: 100, left: 60, bottom: 130, right: 340 }, viewport)).toBe(true);
  });

  it("is a move when the field is off screen, or there is no earlier place", () => {
    expect(fieldMoved({ top: 900, left: 20, bottom: 930, right: 300 }, { top: 900, left: 20, bottom: 930, right: 300 }, viewport)).toBe(true);
    expect(fieldMoved(null, at, viewport)).toBe(true);
  });
});

describe("the card view", () => {
  const view = readFileSync("src/content/card-view.ts", "utf8");

  it("is a dialog named by its title, which is where focus lands", () => {
    expect(view).toContain('card.setAttribute("role", "dialog");');
    expect(view).toContain('card.setAttribute("aria-labelledby", TITLE_ID);');
    expect(view).toContain("title.id = TITLE_ID;");
    expect(view).toContain("title.tabIndex = -1;");
    expect(view).toMatch(/querySelector<HTMLElement>\(`#\$\{TITLE_ID\}`\)\?\.focus\(/);
  });

  it("goes inside body, where assistive technology reaches it, in a closed shadow root", () => {
    expect(view).toContain("(document.body ?? document.documentElement).append(this.host)");
    expect(view).toContain('attachShadow({ mode: "closed" })');
    expect(view).toContain(":host { all: initial; }");
  });
});
