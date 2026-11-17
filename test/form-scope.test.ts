// A page can show more than one form: a quick create over a main form, a
// dialog or side pane, or the hidden sessions of a multi-session app. The
// snapshot is one form (Xrm.Page). These tests hold that the hover card and
// the X-ray line answer for that form's fields only, by the form id each
// field label carries, and that a label with no form id degrades to the old
// behaviour instead of hiding the field.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import type { XrayEntry } from "../src/card/xray";
import { containerOnForm, formIdFromLabels, formIdOfLabelId, formOnPage, formRelation, labelFormId } from "../src/content/form-scope";
import { HoverController } from "../src/content/hover-controller";
import { XrayLines } from "../src/content/xray-lines";

const MAIN_FORM = "8448b78f-8f42-454e-8e2a-f8196b0419af";
const QUICK_CREATE = "1f2e3d4c-0000-4000-8000-00000000c0de";
const labelId = (formId: string, control: string, n = 1) => `id-${formId}-${n}-${control}-field-label`;

interface FakeField {
  control: string;
  /** The label's id; none means the container has no label. */
  label?: string;
  /** Drawn on screen (a visible session), or hidden. */
  drawn?: boolean;
  /** The label sits outside the container, so the line has no place there. */
  labelOutside?: boolean;
}

type FakeContainer = ReturnType<typeof fakeContainer>;

/** A field container, with just the DOM the hover card, the X-ray line and form-scope read. */
function fakeContainer(field: FakeField) {
  const dataId = `${field.control}-FieldSectionItemContainer`;
  const drawn = field.drawn ?? true;
  const after = vi.fn();
  const container = {
    dataId,
    isConnected: true,
    firstElementChild: null as unknown,
    label: null as null | { id: string; parentElement: unknown; isConnected: boolean; after: typeof after; contains: (node: unknown) => boolean },
    getAttribute: (name: string) => (name === "data-id" ? dataId : null),
    getBoundingClientRect: () => ({ width: drawn ? 200 : 0, height: drawn ? 20 : 0 }),
    getClientRects: () => (drawn ? [{}] : []),
    contains: (node: unknown) => node === container || (!field.labelOutside && node === container.label),
    querySelector: (selector: string) => {
      const suffix = /^\[id\$="(.+)"\]$/.exec(selector)?.[1];
      if (suffix && container.label?.id.endsWith(suffix)) return container.label;
      // labelOf's exact forms ([data-id="..."], [id="..."]) find nothing: a real label has neither.
      return null;
    },
    querySelectorAll: () => [],
    closest: () => container,
    style: { display: "block", flexDirection: "row", flexWrap: "nowrap" },
    after,
  };
  if (field.label !== undefined) {
    container.label = { id: field.label, parentElement: field.labelOutside ? null : container, isConnected: true, after, contains: () => false };
  }
  return container;
}

/**
 * A document holding the containers, in order. It answers the data-id
 * selector for a control's containers, and the label-id selector formOnPage
 * uses to ask whether any field label names a form.
 */
function fakeRoot(containers: FakeContainer[]) {
  return {
    querySelectorAll: (selector: string) => {
      const dataId = /^\[data-id="(.+)"\]$/.exec(selector)?.[1];
      return containers.filter((container) => container.dataId === dataId);
    },
    querySelector: (selector: string) => {
      const anchor = /^\[id\^="(.+)" i\]\[id\$="(.+)"\]$/.exec(selector);
      if (!anchor) return null;
      const [, prefix, suffix] = anchor;
      return containers.map((container) => container.label).find((label) => !!label && label.id.toLowerCase().startsWith(prefix!.toLowerCase()) && label.id.endsWith(suffix!)) ?? null;
    },
  };
}

const asElement = (value: unknown) => value as Element;
const drawn = (container: Element) => (container as unknown as FakeContainer).getClientRects().length > 0;

describe("the form a field label names", () => {
  it("is read from a real D365 label id, lower case", () => {
    expect(formIdOfLabelId(labelId(MAIN_FORM.toUpperCase(), "name"), "name")).toBe(MAIN_FORM);
    expect(formIdOfLabelId(labelId(MAIN_FORM, "name", 12), "name")).toBe(MAIN_FORM);
  });

  it("is not read from another control's label, an id with no form id, or a control name the bridge rejects", () => {
    expect(formIdOfLabelId(labelId(MAIN_FORM, "parentaccountname"), "name")).toBeNull();
    expect(formIdOfLabelId("id-x-1-name-field-label", "name")).toBeNull();
    expect(formIdOfLabelId("name-field-label", "name")).toBeNull();
    expect(formIdOfLabelId(labelId(MAIN_FORM, "a.b"), "a.b")).toBeNull();
  });

  it("is null for a container with no label", () => {
    expect(labelFormId(asElement(fakeContainer({ control: "name" })), "name")).toBeNull();
  });

  it("says this form, another form, or neither when either side has no form id", () => {
    const main = asElement(fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") }));
    const quick = asElement(fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name") }));
    const bare = asElement(fakeContainer({ control: "name", label: "label-name-field-label" }));
    expect(formRelation(main, "name", MAIN_FORM)).toBe("same");
    expect(formRelation(main, "name", MAIN_FORM.toUpperCase())).toBe("same");
    expect(formRelation(quick, "name", MAIN_FORM)).toBe("other");
    expect(formRelation(bare, "name", MAIN_FORM)).toBe("unknown");
    expect(formRelation(quick, "name", null)).toBe("unknown");
  });

  it("is on the page when any field label names the form", () => {
    const root = fakeRoot([fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM.toUpperCase(), "telephone1") })]);
    expect(formOnPage(root as never, MAIN_FORM)).toBe(true);
    expect(formOnPage(root as never, QUICK_CREATE)).toBe(false);
    expect(formOnPage(root as never, "not a guid")).toBe(false);
  });
});

describe("choosing a control's container when the page shows two forms", () => {
  const main = () => fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
  const quick = (drawnOnPage = true) => fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name"), drawn: drawnOnPage });

  it("takes this form's container, even when another form's comes first in the page", () => {
    const [q, m] = [quick(), main()];
    expect(containerOnForm(fakeRoot([q, m]) as never, "name", MAIN_FORM, drawn)).toEqual({ container: m, drawnElsewhere: false });
  });

  it("takes none when the only container is on another form, and says it is drawn there", () => {
    const anchor = fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM, "telephone1") });
    expect(containerOnForm(fakeRoot([quick(), anchor]) as never, "name", MAIN_FORM, drawn)).toEqual({ container: null, drawnElsewhere: true });
    expect(containerOnForm(fakeRoot([quick(false), anchor]) as never, "name", MAIN_FORM, drawn)).toEqual({ container: null, drawnElsewhere: false });
  });

  // M2: the label-id rule is verified for body fields only. If no label on the
  // page names the page's form, a label naming another id proves nothing.
  it("rules nothing out when no field label on the page names this form", () => {
    const header = fakeContainer({ control: "header_ownerid", label: labelId(QUICK_CREATE, "header_ownerid") });
    const bare = fakeContainer({ control: "name", label: "label-name-field-label" });
    expect(containerOnForm(fakeRoot([header, bare]) as never, "header_ownerid", MAIN_FORM, drawn)).toEqual({ container: header, drawnElsewhere: false });
    const q = quick();
    expect(containerOnForm(fakeRoot([q]) as never, "name", MAIN_FORM, drawn)).toEqual({ container: q, drawnElsewhere: false });
  });

  // Round 2, M2: nothing ruled out (no label names this form), yet the quick
  // create's copy comes first and is drawn. Its label names another form, so it
  // ranks below the main form's copy, whose label names none.
  it("ranks a label naming another form below one naming none, even when nothing is ruled out", () => {
    const q = quick();
    const bare = fakeContainer({ control: "name", label: "label-name-field-label" });
    expect(containerOnForm(fakeRoot([q, bare]) as never, "name", MAIN_FORM, drawn)).toEqual({ container: bare, drawnElsewhere: false });
  });

  it("asks whether the form is on the page only when a label names another form", () => {
    const formIsOnPage = vi.fn(() => true);
    containerOnForm(fakeRoot([main()]) as never, "name", MAIN_FORM, drawn, formIsOnPage);
    expect(formIsOnPage).not.toHaveBeenCalled();
    containerOnForm(fakeRoot([quick(), main()]) as never, "name", MAIN_FORM, drawn, formIsOnPage);
    expect(formIsOnPage).toHaveBeenCalledTimes(1);
  });

  // Round 2, H1: body labels name this form, and a header, business process or
  // composite flyout label names another id. Those labels are not verified to
  // carry the form id, so they never rule the field out.
  it.each(["header_ownerid", "header_process_stepname", "address1_composite_compositionLinkControl_address1_line1"])(
    "never rules out %s, whatever its label names",
    (control) => {
      const field = fakeContainer({ control, label: labelId(QUICK_CREATE, control) });
      const body = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
      expect(formRelation(asElement(field), control, MAIN_FORM)).toBe("unknown");
      expect(containerOnForm(fakeRoot([body, field]) as never, control, MAIN_FORM, drawn)).toEqual({ container: field, drawnElsewhere: false });
    },
  );

  it("keeps a container whose label names no form: unknown is not another form", () => {
    const bare = fakeContainer({ control: "name", label: "label-name-field-label" });
    const anchor = fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM, "telephone1") });
    expect(containerOnForm(fakeRoot([bare, anchor]) as never, "name", MAIN_FORM, drawn).container).toBe(bare);
    expect(containerOnForm(fakeRoot([quick(), bare, anchor]) as never, "name", MAIN_FORM, drawn).container).toBe(bare);
  });

  it("prefers the container whose label names this form over one that names none", () => {
    const bare = fakeContainer({ control: "name", label: "label-name-field-label" });
    const m = main();
    expect(containerOnForm(fakeRoot([bare, m]) as never, "name", MAIN_FORM, drawn).container).toBe(m);
  });

  it("prefers the drawn one when two sessions show the same form", () => {
    const hidden = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name"), drawn: false });
    const shown = main();
    expect(containerOnForm(fakeRoot([hidden, shown]) as never, "name", MAIN_FORM, drawn).container).toBe(shown);
  });

  it("with no form id from the page, keeps every container and prefers the drawn one", () => {
    const hidden = quick(false);
    const shown = main();
    expect(containerOnForm(fakeRoot([hidden, shown]) as never, "name", null, drawn).container).toBe(shown);
    expect(containerOnForm(fakeRoot([hidden]) as never, "name", null, drawn).container).toBe(hidden);
  });
});

describe("the form id the labels carry, when the page did not say", () => {
  it("is the one form every drawn label names", () => {
    const root = fakeRoot([
      fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") }),
      fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM, "telephone1", 2) }),
      fakeContainer({ control: "fax", label: "label-fax-field-label" }),
    ]);
    expect(formIdFromLabels(root as never, ["name", "telephone1", "fax", "notrendered"], drawn)).toBe(MAIN_FORM);
  });

  it("is unknown when the drawn labels name two forms, or none", () => {
    const two = fakeRoot([
      fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name") }),
      fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") }),
    ]);
    expect(formIdFromLabels(two as never, ["name"], drawn)).toBeNull();
    expect(formIdFromLabels(fakeRoot([fakeContainer({ control: "name", label: "label-name-field-label" })]) as never, ["name"], drawn)).toBeNull();
    expect(formIdFromLabels(fakeRoot([]) as never, ["name"], drawn)).toBeNull();
  });

  // M1: a hidden session's Account form, while the open Contact's labels have not rendered.
  it("never reads a hidden container, so a hidden session's form is not taken for the open one", () => {
    const hiddenAccount = fakeContainer({ control: "telephone1", label: labelId(QUICK_CREATE, "telephone1"), drawn: false });
    expect(formIdFromLabels(fakeRoot([hiddenAccount]) as never, ["telephone1"], drawn)).toBeNull();
    const shownContact = fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM, "telephone1") });
    expect(formIdFromLabels(fakeRoot([hiddenAccount, shownContact]) as never, ["telephone1"], drawn)).toBe(MAIN_FORM);
  });

  // M2: header and business process stage fields are not verified to carry the form id, so they cannot veto it.
  it("ignores header fields when deciding the form", () => {
    const root = fakeRoot([
      fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") }),
      fakeContainer({ control: "header_process_stepname", label: labelId(QUICK_CREATE, "header_process_stepname") }),
      fakeContainer({ control: "header_ownerid", label: labelId(QUICK_CREATE, "header_ownerid") }),
    ]);
    expect(formIdFromLabels(root as never, ["name", "header_process_stepname", "header_ownerid"], drawn)).toBe(MAIN_FORM);
  });
});

describe("the hover card on a page with two forms", () => {
  type Listener = (event: { target: unknown; isTrusted?: boolean }) => void;
  let listeners: Record<string, Listener>;
  let doc: { activeElement: unknown; addEventListener: (type: string, fn: Listener) => void; querySelector: (selector: string) => unknown };

  const snapshot = {
    organizationId: "5c4a0000-0000-4000-8000-000000000003",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: MAIN_FORM,
    columns: [{ control: "name", column: "name" }],
    dirtyColumns: [],
    lockedControls: [],
  } as unknown as FormSnapshot;

  const mainField = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
  const quickField = fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name") });

  function stubPage(containers: FakeContainer[]) {
    listeners = {};
    doc = { activeElement: null, addEventListener: (type, fn) => void (listeners[type] = fn), querySelector: fakeRoot(containers).querySelector };
    vi.stubGlobal("document", doc);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    stubPage([quickField, mainField]);
    vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function harness(snapshotFormId: string | null = MAIN_FORM, pageFormId?: string | null) {
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
    const controller = new HoverController(view as never, { settings, connectedCard: vi.fn(async () => undefined) } as never);
    controller.attach();
    controller.setSnapshot({ ...snapshot, formId: snapshotFormId } as FormSnapshot, pageFormId);
    return { controller, settings };
  }

  const hover = (container: FakeContainer) => {
    listeners.mouseover!({ target: { closest: (selector: string) => (selector.includes("FieldSectionItemContainer") ? container : null) }, isTrusted: true });
    vi.advanceTimersByTime(1000);
  };

  it("opens no card for the quick create's field of the same name", () => {
    const { settings } = harness();
    hover(quickField);
    expect(settings).not.toHaveBeenCalled();
  });

  it("opens the card for this form's field", () => {
    const { settings } = harness();
    hover(mainField);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("opens the card for a field whose label names no form, and for any field when the page gave no form id", () => {
    const { settings } = harness();
    hover(fakeContainer({ control: "name", label: "label-name-field-label" }));
    expect(settings).toHaveBeenCalledTimes(1);
    const unknownForm = harness(null);
    hover(quickField);
    expect(unknownForm.settings).toHaveBeenCalledTimes(1);
  });

  // M2: a header or BPF label carrying another id on a page whose labels never name the form.
  // Round 2, H1: the page's body labels name this form; the header field's label names another id.
  it("opens the card for a header or business process field whose label carries another id", () => {
    const headerField = fakeContainer({ control: "header_process_stepname", label: labelId(QUICK_CREATE, "header_process_stepname") });
    stubPage([mainField, headerField]);
    const view = harness();
    view.controller.setSnapshot({ ...snapshot, columns: [{ control: "header_process_stepname", column: "stepname" }] } as FormSnapshot);
    hover(headerField);
    expect(view.settings).toHaveBeenCalledTimes(1);
  });

  it("opens the card when no label on the page names this form, whatever the hovered label names", () => {
    stubPage([quickField]);
    const { settings } = harness();
    hover(quickField);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  // M1: an id read from the labels goes with requests but never scopes fields.
  it("rules nothing out by a form id the page did not report", () => {
    const { settings } = harness(QUICK_CREATE, null);
    hover(mainField);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("does not open the quick create's focused field from the keyboard command", () => {
    const { controller, settings } = harness();
    doc.activeElement = { closest: () => quickField };
    expect(controller.openFocused()).toBe("noCard");
    doc.activeElement = { closest: () => mainField };
    expect(controller.openFocused()).toBe("opened");
    expect(settings).toHaveBeenCalledTimes(1);
  });
});

describe("the X-ray line on a page with two forms", () => {
  const entry: XrayEntry = { column: "name", writers: 2, aiWriters: 0, readers: 1, aiReaders: 0, forms: 1, findings: 0 };

  /** An element the line's own drawing can build: it is never read back. */
  function ownElement(): Record<string, unknown> {
    const node: Record<string, unknown> = {};
    for (const method of ["append", "addEventListener", "replaceChildren", "remove", "setAttribute"]) node[method] = () => undefined;
    node.attachShadow = () => ownElement();
    node.isConnected = false;
    return node;
  }

  function stubPage(containers: FakeContainer[]) {
    const root = fakeRoot(containers);
    vi.stubGlobal("document", {
      ...root,
      body: {},
      createElement: () => ownElement(),
      createElementNS: () => ownElement(),
      createTextNode: () => ({}),
    });
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    vi.stubGlobal("getComputedStyle", (element: { style?: unknown }) => element.style ?? { display: "block", flexDirection: "row", flexWrap: "nowrap" });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }

  afterEach(() => void vi.unstubAllGlobals());

  it("goes under this form's field, never the quick create's that comes first in the page", () => {
    const quick = fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name") });
    const main = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
    stubPage([quick, main]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "name", entry }], MAIN_FORM);
    expect(main.label!.after).toHaveBeenCalledTimes(1);
    expect(quick.label!.after).not.toHaveBeenCalled();
    expect(lines.unmarked).toBe(0);
  });

  it("does not count the quick create's copy when this form's field has its line", () => {
    const quick = fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name"), labelOutside: true });
    const main = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
    stubPage([quick, main]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "name", entry }], MAIN_FORM);
    expect(lines.unmarked).toBe(0);
  });

  // M2: a field ruled to be on another form is counted, so a wrong ruling is never silent.
  it("counts a visible field drawn only on a form ruled to be another, and not a hidden one", () => {
    const quick = fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name") });
    const anchor = fakeContainer({ control: "telephone1", label: labelId(MAIN_FORM, "telephone1") });
    stubPage([quick, anchor]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "name", entry }], MAIN_FORM);
    expect(quick.label!.after).not.toHaveBeenCalled();
    expect(lines.unmarked).toBe(1);
    lines.clear();
    expect(lines.unmarked).toBe(0);

    stubPage([fakeContainer({ control: "name", label: labelId(QUICK_CREATE, "name"), drawn: false }), anchor]);
    const hidden = new XrayLines(() => undefined);
    hidden.show([{ control: "name", entry }], MAIN_FORM);
    expect(hidden.unmarked).toBe(0);
  });

  // Round 2, H1: body labels name this form, so the page is anchored; the header label names another id.
  it("writes the line under a header field whose label carries another id, on a page whose body labels name this form", () => {
    const body = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name") });
    const header = fakeContainer({ control: "header_ownerid", label: labelId(QUICK_CREATE, "header_ownerid") });
    stubPage([body, header]);
    const lines = new XrayLines(() => undefined);
    lines.show(
      [
        { control: "name", entry },
        { control: "header_ownerid", entry },
      ],
      MAIN_FORM,
    );
    expect(header.label!.after).toHaveBeenCalledTimes(1);
    expect(lines.unmarked).toBe(0);
  });

  it("writes the line when no label on the page names this form, whatever this label names", () => {
    const header = fakeContainer({ control: "header_ownerid", label: labelId(QUICK_CREATE, "header_ownerid") });
    stubPage([header]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "header_ownerid", entry }], MAIN_FORM);
    expect(header.label!.after).toHaveBeenCalledTimes(1);
  });

  it("still counts this form's visible field that has no place for a line", () => {
    const main = fakeContainer({ control: "name", label: labelId(MAIN_FORM, "name"), labelOutside: true });
    stubPage([main]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "name", entry }], MAIN_FORM);
    expect(lines.unmarked).toBe(1);
  });

  it("keeps writing a line under a field whose label names no form", () => {
    const bare = fakeContainer({ control: "name", label: "label-name-field-label" });
    stubPage([bare]);
    const lines = new XrayLines(() => undefined);
    lines.show([{ control: "name", entry }], MAIN_FORM);
    expect(bare.label!.after).toHaveBeenCalledTimes(1);
  });
});

// Round 2, L2: an id read from the labels was shown first, then the page
// reports the same id. The key must change, so the lines get the page's id.
describe("the X-ray when the page reports the id the labels gave", () => {
  it("draws again with the page's form id", async () => {
    const { XrayController } = await import("../src/content/xray-controller");
    const shown: Array<string | null> = [];
    const view = { setOnClose: () => undefined, showMessage: () => undefined, showLegend: () => undefined, hide: () => undefined, setNote: () => undefined };
    const lines = { setOnUnmarked: () => undefined, clear: () => undefined, show: (_targets: unknown, formId: string | null) => void shown.push(formId) };
    const fetchXray = vi.fn(async () => ({ kind: "xray", model: { entries: [{ column: "name" }], scopeLine: "" } }));
    const controller = new XrayController(view as never, lines as never, fetchXray as never);
    const fromLabels = { organizationId: "o", table: "account", formId: MAIN_FORM, columns: [{ control: "name", column: "name" }] } as unknown as FormSnapshot;
    controller.setSnapshot(fromLabels, null);
    controller.setOn(true);
    await new Promise((done) => setTimeout(done, 0));
    controller.setSnapshot(fromLabels, MAIN_FORM);
    await new Promise((done) => setTimeout(done, 0));
    expect(shown).toEqual([null, MAIN_FORM]);
  });
});
