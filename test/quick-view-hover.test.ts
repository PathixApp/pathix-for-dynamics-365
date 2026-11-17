// A field inside a quick view (another record's form, shown
// read-only on this one) opens the card for the quick view's own table and
// column, with a line saying where it comes from. The Primary Contact quick
// view on Account, as captured live.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { quickViewLine } from "../src/card/quick-view";
import { HoverController } from "../src/content/hover-controller";

type Listener = (event: { target: unknown; isTrusted?: boolean }) => void;

const MAIN_FORM = "5c4a0000-0000-4000-8000-000000000021";
/** The quick view form's id, which the inner field's label may carry. */
const QUICK_VIEW_FORM = "5c4a0000-0000-4000-8000-000000000248";
/** As captured live: the quick view's name, a dot, and the inner control's (bare column) name. */
const EMAIL = "contactquickform.emailaddress1";
const QV_PHONE = "contactquickform.telephone1";

function fakeContainer(control: string, labelFormId: string | null = null) {
  const label = labelFormId ? { id: `id-${labelFormId}-1-${control}-field-label` } : null;
  return {
    isConnected: true,
    getAttribute: (name: string) => (name === "data-id" ? `${control}-FieldSectionItemContainer` : null),
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 20, right: 200, width: 200, height: 20 }),
    getClientRects: () => [{}],
    querySelector: (selector: string) => (label && selector.includes(`-${control}-field-label`) ? label : null),
  };
}

const snapshot = {
  organizationId: "5c4a0000-0000-4000-8000-000000000003",
  host: "contoso.crm.dynamics.com",
  table: "account",
  formId: MAIN_FORM,
  // Account's own telephone1 shares its name with the quick view's inner telephone1.
  columns: [
    { control: "name", column: "name" },
    { control: "telephone1", column: "telephone1" },
  ],
  dirtyColumns: ["name"],
  // The form reports the quick view's fields as read-only too; that is not what makes them locked.
  lockedControls: [EMAIL],
  saveKind: "update",
  alwaysSubmitColumns: [],
  quickViewColumns: [
    { control: EMAIL, table: "contact", column: "emailaddress1" },
    { control: QV_PHONE, table: "contact", column: "telephone1" },
  ],
} as unknown as FormSnapshot;

const LITE_CARDS = { registered: { table: "contact", column: "emailaddress1" }, dependencies: {}, locked: null };
const CARD = { table: "contact", column: "emailaddress1", notInScan: false, platformDependentCount: 0, platformCountRead: true, stats: [], rows: [], locked: null };

let listeners: Record<string, Listener>;

beforeEach(() => {
  vi.useFakeTimers();
  listeners = {};
  // A label on the page names the main form, so a label naming another form would rule a plain field out.
  const mainLabel = { id: `id-${MAIN_FORM}-1-name-field-label` };
  vi.stubGlobal("document", {
    activeElement: null,
    addEventListener: (type: string, fn: Listener) => void (listeners[type] = fn),
    querySelector: (selector: string) => (selector.includes(MAIN_FORM) ? mainLabel : null),
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined, innerWidth: 1000, innerHeight: 800 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness(mode: "lite" | "connected") {
  const view = {
    setOnClose: () => undefined,
    setOnHideTips: () => undefined,
    setOnOpenOptions: () => undefined,
    takeFocus: () => undefined,
    hasFocus: false,
    showMessage: vi.fn(),
    showState: vi.fn(),
    showCard: vi.fn(),
    showLiteCards: vi.fn(),
    contains: () => false,
    hide: () => undefined,
    isOpen: false,
  };
  const sources = {
    settings: vi.fn(async () => ({ mode, showTips: true })),
    connectedCard: vi.fn(async () => ({ kind: "card" as const, card: CARD })),
    liteCards: vi.fn(async () => LITE_CARDS),
    userSecurity: vi.fn(async () => ({})),
    liveModified: vi.fn(async () => new Map()),
    hideTips: async () => undefined,
    openOptions: async () => undefined,
  };
  const controller = new HoverController(view as never, sources as never);
  controller.attach();
  controller.setSnapshot(snapshot);
  return { view, sources };
}

async function hover(container: unknown): Promise<void> {
  listeners.mouseover!({ target: { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) }, isTrusted: true });
  await vi.advanceTimersByTimeAsync(1000);
}

describe("hovering a field inside a quick view", () => {
  it("in Lite, reads the quick view's table and column, with none of this form's edits, id or locks", async () => {
    const { view, sources } = harness("lite");
    await hover(fakeContainer(EMAIL));
    expect(sources.liteCards).toHaveBeenCalledWith({
      table: "contact",
      column: "emailaddress1",
      control: EMAIL,
      formId: null,
      dirtyColumns: [],
      locked: false,
      showTips: true,
    });
    expect(view.showLiteCards).toHaveBeenCalledWith(expect.anything(), LITE_CARDS, quickViewLine("contact"));
  });

  it("when connected, asks Pathix for the quick view's table and column, and shows the line in place of the checklist", async () => {
    const { view, sources } = harness("connected");
    await hover(fakeContainer(EMAIL));
    expect(sources.connectedCard).toHaveBeenCalledWith(expect.objectContaining({ kind: "fieldCard", table: "contact", column: "emailaddress1" }));
    expect(view.showCard).toHaveBeenCalledWith(expect.anything(), CARD, expect.anything(), null, quickViewLine("contact"));
    // No checklist, so none of the user's own live reads it pairs with.
    expect(sources.userSecurity).not.toHaveBeenCalled();
  });

  it("opens even when the field's label names the quick view's form, not this one", async () => {
    const { sources } = harness("lite");
    await hover(fakeContainer(EMAIL, QUICK_VIEW_FORM));
    expect(sources.liteCards).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a quick view field the snapshot does not list", async () => {
    const { sources } = harness("lite");
    await hover(fakeContainer("contactquickform.mobilephone"));
    expect(sources.settings).not.toHaveBeenCalled();
  });

  it("tells the quick view's telephone1 from the form's own telephone1", async () => {
    const { sources } = harness("lite");
    await hover(fakeContainer(QV_PHONE));
    expect(sources.liteCards).toHaveBeenCalledWith(expect.objectContaining({ table: "contact", column: "telephone1", control: QV_PHONE }));
  });

  it("opens the form's own telephone1 on the form's table, with no quick view line", async () => {
    const { view, sources } = harness("lite");
    await hover(fakeContainer("telephone1"));
    expect(sources.liteCards).toHaveBeenCalledWith(expect.objectContaining({ table: "account", column: "telephone1", control: "telephone1", formId: MAIN_FORM }));
    expect(view.showLiteCards).toHaveBeenCalledWith(expect.anything(), LITE_CARDS, null);
  });

  it("leaves the form's own fields as they were: this table, this form, no quick view line", async () => {
    const { view, sources } = harness("lite");
    await hover(fakeContainer("name"));
    expect(sources.liteCards).toHaveBeenCalledWith(expect.objectContaining({ table: "account", column: "name", formId: MAIN_FORM, dirtyColumns: ["name"] }));
    expect(view.showLiteCards).toHaveBeenCalledWith(expect.anything(), LITE_CARDS, null);
  });
});

describe("the quick view line", () => {
  it("names the related table, says the field is read-only here, and follows the copy rules", () => {
    const line = quickViewLine("contact");
    expect(line).toBe("A quick view shows this contact column from the related record, read-only. Open the contact to edit it.");
    expect(line).not.toMatch(/[—–]/);
    expect(line).not.toMatch(/\bwriters?\b/i);
  });
});
