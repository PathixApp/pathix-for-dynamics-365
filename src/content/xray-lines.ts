// X-ray v2: one line written into the form under each field,
// `W: 7 +1✦  R: 8  F: 5  <flag> 0`. Into the form, but not of it:
//
// - Each line is our own host element, <pathix-xray-line>, with a CLOSED shadow
//   root, so D365's styles and scripts cannot reach it and ours cannot reach
//   D365. Everything inside is set with textContent or createElementNS.
// - D365's own nodes are never modified: the code only reads them to find a
//   place, and inserts our host as a sibling. The line gets its own row: it
//   goes after the label's nearest ancestor whose parent stacks its children
//   vertically (see place()), never inside a no-wrap flex row, where it would
//   squeeze the label (a side label went one character wide on a real form).
// - The form re-renders often (tabs, saves, field changes) and drops foreign
//   nodes. A MutationObserver puts a missing or misplaced line back.
// - The form also changes layout without changing its nodes: a narrower window
//   can turn side labels into top labels, by a class or a media query. A class
//   or style change inside a field (that field only), a field container
//   changing size, or the window resizing makes the line's place be worked out
//   again, so it never stays in a row that has become a no-wrap row. Class
//   changes above the fields (Fluent UI toggles focus classes on the body on
//   every click and Tab) are ignored: a layout switch they cause shows as a
//   container size change. Our host has no class or style of its own, so none
//   of this can loop.
// - The page can hold more than one form (a quick create, a dialog, the hidden
//   sessions of a multi-session app). A line goes on the snapshot's form only:
//   a container whose label names another form gets none and is not counted
//   below, and of several containers for one control, the one on this form,
//   and drawn, is chosen (form-scope.ts).
// - A visible field that has no place for a line is counted, and the X-ray
//   panel says how many could not be marked: a missing line never reads as
//   "nothing". A hidden field is not counted, since nothing is missing there.
// - A field whose container leaves the page loses its line outright, so no
//   line (or its click handler) outlives the field it was written for.
// - clear() removes every host and stops the observer.
// - Each line is a button, so it is keyboard-reachable, and it opens the card.
//
// Names, never values (DESIGN.md): the DOM is read for control containers by
// data-id, for labels by id, and for the computed layout of the label's
// ancestors. No text is read out of a D365 node. Nothing read here is kept
// beyond the placement, or sent anywhere.

import { aiDescription, aiSuffix, formatCount, lineParts, type XrayEntry } from "../card/xray";
import { findingsIcon } from "./findings-icon";
import { containerOnForm, formOnPage, isRendered } from "./form-scope";

const CONTAINER_SUFFIX = "-FieldSectionItemContainer";
const LABEL_SUFFIX = "-field-label";
const TAG = "pathix-xray-line";

const STYLE = `
:host { all: initial; display: block; width: 100%; align-self: stretch; box-sizing: border-box; margin: 1px 0 2px; }
.line {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%; box-sizing: border-box;
  margin: 0; padding: 0 4px; border: 0; border-radius: 3px; background: #eef3f8; color: #3b4651;
  font: 11px/16px "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; cursor: pointer; text-align: left;
}
.line:hover { background: #deecf9; color: #11161c; }
.line:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.part { white-space: pre; }
.ai { font-weight: 600; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.findings { display: inline-flex; align-items: center; gap: 3px; }
.findings svg { display: block; flex: none; }
`;

const TITLE =
  "W: writes to the column. R: reads of it. +N✦: N more that are AI-derived (unverified). F: forms that carry it. Flag: open findings. Select to open the card.";

/** One field the X-ray writes a line for. */
export interface LineTarget {
  control: string;
  entry: XrayEntry;
}

interface Line {
  host: HTMLElement;
  /** The closed root. Kept here: a closed root cannot be read back from the host. */
  root: ShadowRoot;
  entry: XrayEntry | null;
  /** The field container this line was last placed for. It is the one watched for size. */
  container: Element | null;
  /** Where the line goes, as last worked out; reused while the label and the anchor are the same nodes. */
  spot: Spot | null;
  /**
   * The container had no place for a line, worked out for this label. Kept
   * until the container's size or a class or style inside it changes, so a
   * pass while typing reads no computed style for it.
   */
  noPlace: { label: Element | null; visible: boolean } | null;
}

/** The host goes right after `anchor`. Worked out from `label`, inside `container`. */
interface Spot {
  container: Element;
  label: Element | null;
  anchor: Element;
}

export class XrayLines {
  private readonly lines = new Map<string, Line>();
  private targets: LineTarget[] = [];
  /** The form id the page reported: lines go on that form's fields only. Null when the page did not say. */
  private formId: string | null = null;
  /** Visible fields drawn only on a form ruled to be another: counted as not marked, never silent. */
  private readonly elsewhere = new Set<string>();
  private observer: MutationObserver | null = null;
  private resizes: ResizeObserver | null = null;
  /** Each watched container's last reported size; null until the browser's first report. */
  private readonly sizes = new Map<Element, string | null>();
  /** Fields whose place a layout change forgot, for the next pass. */
  private readonly pending = new Set<string>();
  /** The next pass covers every field: the form's nodes changed, or the window resized. */
  private fullPass = false;
  private frame = 0;
  private unmarkedCount = 0;
  private onUnmarked: (count: number) => void = () => undefined;
  private readonly onWindowResize = () => this.relayout(null);

  /** `onOpen` is called with the control, its container and the line's button when a line is chosen. */
  constructor(private readonly onOpen: (control: string, container: Element, line: HTMLElement) => void) {}

  /** The button of the line for `control` while it is in the page, or null: where a card's focus can go back to after a redraw. */
  buttonFor(control: string): HTMLElement | null {
    const line = this.lines.get(control);
    return line?.host.isConnected ? line.root.querySelector<HTMLElement>("button.line") : null;
  }

  /** How many lines are in the page right now. */
  get placed(): number {
    return [...this.lines.values()].filter((line) => line.host.isConnected).length;
  }

  /** How many visible fields have no place for a line. */
  get unmarked(): number {
    return this.unmarkedCount;
  }

  /** How many field containers are watched for size: one per line, never one that left. */
  get watching(): number {
    return this.sizes.size;
  }

  /** Called when the number of rendered fields with no line changes. */
  setOnUnmarked(handler: (count: number) => void): void {
    this.onUnmarked = handler;
  }

  /**
   * Writes (or updates) a line for every target whose field is rendered on the
   * form `formId` names, and keeps them there.
   */
  show(targets: LineTarget[], formId: string | null): void {
    this.targets = targets;
    this.formId = formId;
    const wanted = new Set(targets.map((target) => target.control));
    for (const control of [...this.lines.keys()]) {
      if (!wanted.has(control)) this.drop(control);
    }
    for (const control of [...this.elsewhere]) {
      if (!wanted.has(control)) this.elsewhere.delete(control);
    }
    this.reconcile();
    this.observe();
  }

  /** Removes every line and stops watching the form. */
  clear(): void {
    cancelAnimationFrame(this.frame);
    this.pending.clear();
    this.fullPass = false;
    this.observer?.disconnect();
    this.observer = null;
    this.resizes?.disconnect();
    this.resizes = null;
    this.sizes.clear();
    window.removeEventListener("resize", this.onWindowResize);
    for (const line of this.lines.values()) line.host.remove();
    this.lines.clear();
    this.targets = [];
    this.formId = null;
    this.elsewhere.clear();
    this.report(0);
  }

  /**
   * Puts back any line the form dropped or moved. Returns how many lines are in
   * the page. With `only`, the pass covers those fields alone: a size or class
   * change in one field re-places that field without a document-wide query per
   * target.
   *
   * Two phases. First every read: the containers, the labels, the computed
   * styles of the label's ancestors and, for a field with no place, whether it
   * is drawn at all. Then every write. A read after a write would force the page
   * to lay out again, once per field.
   */
  reconcile(only?: ReadonlySet<string>): number {
    const plans: Array<{ control: string; entry: XrayEntry; line: Line | null }> = [];
    // Whether any label names the form: one page-wide query per pass, and only when a label names another form.
    let onPage: boolean | undefined;
    const formIsOnPage = () => (onPage ??= this.formId !== null && formOnPage(document, this.formId));
    for (const { control, entry } of this.targets) {
      if (only && !only.has(control)) continue;
      const { container, drawnElsewhere } = containerOnForm(document, control, this.formId, isRendered, formIsOnPage);
      if (drawnElsewhere) this.elsewhere.add(control);
      else this.elsewhere.delete(control);
      if (!container) {
        plans.push({ control, entry, line: null });
        continue;
      }
      const line = this.lineFor(control);
      if (line.container !== container) this.moveTo(line, container);
      this.decide(line, container, control);
      plans.push({ control, entry, line });
    }

    for (const { control, entry, line } of plans) {
      if (!line) {
        // The field left the page (its tab is not rendered). Drop its line
        // whole, so nothing of it holds on to D365's nodes; a new one is
        // written when the field comes back.
        this.drop(control);
        continue;
      }
      if (line.entry !== entry) {
        this.fill(line, control, entry);
        line.entry = entry;
      }
      if (!line.spot) line.host.remove();
      else if (line.spot.anchor.nextElementSibling !== line.host) line.spot.anchor.after(line.host);
    }
    // Our own inserts, moves and removals are already queued for the observer.
    // Drop them here, so the observer only ever sees changes the form made,
    // including the form removing just our host.
    this.observer?.takeRecords();
    this.report([...this.lines.values()].filter((line) => line.noPlace?.visible).length + this.elsewhere.size);
    return this.placed;
  }

  private report(unmarked: number): void {
    if (unmarked === this.unmarkedCount) return;
    this.unmarkedCount = unmarked;
    this.onUnmarked(unmarked);
  }

  /**
   * Works out where the line goes, reading only. A place is worked out again
   * only when the label or the anchor is no longer the node it was, or after a
   * layout change forgot it; a container found to have no place keeps that
   * verdict the same way. With no place that would not squeeze the field, the
   * line is left out: no line is better than a broken form.
   */
  private decide(line: Line, container: Element, control: string): void {
    const label = labelOf(container, control);
    if (line.spot && stillHolds(line.spot, container, label)) return;
    if (!line.spot && line.noPlace && line.noPlace.label === label) return;
    line.spot = spotFor(container, label);
    // Read with the verdict, still before any write: a hidden field (display: none, or no size) is not missing a line.
    line.noPlace = line.spot ? null : { label, visible: isRendered(container) };
  }

  /**
   * The layout changed: forget where the lines go, and any "no place" verdict,
   * for every line whose field is inside `scope`, and place those again on the
   * next frame. With no scope (the window resized) every line is placed again.
   */
  private relayout(scope: Element | null): void {
    if (scope === null) this.fullPass = true;
    for (const [control, line] of this.lines) {
      if (!line.container || (scope && !scope.contains(line.container))) continue;
      line.spot = null;
      line.noPlace = null;
      this.pending.add(control);
    }
    if (scope === null || this.pending.size > 0) this.schedule();
  }

  /** Checks the lines of fields inside `container` on the next frame, keeping where they go unless that no longer holds. */
  private recheck(container: Element): void {
    let any = false;
    for (const [control, line] of this.lines) {
      if (!line.container || !container.contains(line.container)) continue;
      this.pending.add(control);
      any = true;
    }
    if (any) this.schedule();
  }

  /** The field's container is a new node: watch it instead of the old one, and work the place out afresh. */
  private moveTo(line: Line, container: Element): void {
    if (line.container) this.unwatch(line.container);
    line.container = container;
    line.spot = null;
    line.noPlace = null;
    this.watchSize(container);
  }

  /** One pass on the next frame: every field after a change to the form's nodes or the window, else only the fields that changed. */
  private schedule(full = false): void {
    if (full) this.fullPass = true;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const only = this.fullPass ? undefined : new Set(this.pending);
      this.fullPass = false;
      this.pending.clear();
      this.reconcile(only);
    });
  }

  /**
   * Watches a field container's size, with no read: the browser's first report
   * counts as a change, so a top/side label switch that lands before it is
   * not missed. That first report, like our own line arriving, costs one pass
   * for that field that finds the line in place and writes nothing.
   */
  private watchSize(container: Element): void {
    if (this.sizes.has(container)) return;
    this.resizes ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const last = this.sizes.get(entry.target);
        if (last === undefined) continue;
        const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        this.sizes.set(entry.target, size);
        if (last !== size) this.relayout(entry.target);
      }
    });
    this.sizes.set(container, null);
    this.resizes.observe(container);
  }

  private drop(control: string): void {
    const line = this.lines.get(control);
    if (!line) return;
    line.host.remove();
    if (line.container) this.unwatch(line.container);
    this.lines.delete(control);
  }

  private unwatch(container: Element): void {
    if (!this.sizes.delete(container)) return;
    this.resizes?.unobserve(container);
  }

  private lineFor(control: string): Line {
    const existing = this.lines.get(control);
    if (existing) return existing;
    const host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "closed" });
    const line: Line = { host, root, entry: null, container: null, spot: null, noPlace: null };
    this.lines.set(control, line);
    return line;
  }

  private fill(line: Line, control: string, entry: XrayEntry): void {
    const style = document.createElement("style");
    style.textContent = STYLE;

    const button = document.createElement("button");
    button.className = "line";
    button.type = "button";
    button.title = TITLE;
    for (const { text, ai } of lineParts(entry)) {
      const part = document.createElement("span");
      part.className = "part";
      part.textContent = text;
      if (ai > 0) part.append(document.createTextNode(" "), aiMark(ai));
      button.append(part);
    }
    const findings = document.createElement("span");
    findings.className = "findings";
    // The count is beside the icon, but it does not say "finding": the icon keeps its name.
    findings.append(findingsIcon(false), document.createTextNode(formatCount(entry.findings)));
    button.append(findings);
    // The container may be a different node after a re-render: ask for it when
    // chosen, and hold no D365 node in the handler. A line that can be chosen
    // is in the page, so its field's container is there too.
    // Only the user's own click (or Enter or Space on the button) opens the card, never one a page script dispatched.
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const container = this.containerOf(control);
      // The line is the place focus goes back to when the card closes.
      if (container) this.onOpen(control, container, button);
    });

    line.root.replaceChildren(style, button);
  }

  /** The field's container on the snapshot's form: never one on another form the page also shows. */
  private containerOf(control: string): Element | null {
    return containerOnForm(document, control, this.formId, isRendered).container;
  }

  private observe(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => {
      let all = false;
      for (const record of records) {
        if (record.type === "attributes") {
          this.onLayoutAttribute(record.target);
          continue;
        }
        const reach = reachOf(record);
        if (reach === "all") all = true;
        // A change inside one field (typing, a validation message, the form
        // removing just our line): that field's line alone is checked again.
        else if (reach) this.recheck(reach);
      }
      if (all) this.schedule(true);
    });
    this.observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      // A class or style that changes how a field lays out. Our host sets neither, so this cannot loop.
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", this.onWindowResize);
  }

  /**
   * A class or style changed. Inside a field (or on its container), that
   * field's line alone is placed again. Above the fields it is ignored: the
   * body's focus classes change on every click and Tab, and a layout switch
   * from a class up there changes the containers' size, which is watched.
   */
  private onLayoutAttribute(target: Node): void {
    if (!(target instanceof Element) || target.localName === TAG) return;
    const container = target.closest(CONTAINER_SELECTOR);
    if (container) this.relayout(container);
  }
}

/**
 * "+1✦", marked in text, not only in style (DESIGN.md, "Confidence
 * vocabulary"). A screen reader hears "1 more AI-derived (unverified)"
 * instead of the symbol, and a pointer over it shows the same words.
 */
function aiMark(ai: number): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "ai";
  mark.title = aiDescription(ai);
  const shown = document.createElement("span");
  shown.ariaHidden = "true";
  shown.textContent = aiSuffix(ai);
  const spoken = document.createElement("span");
  spoken.className = "sr";
  spoken.textContent = aiDescription(ai);
  mark.append(shown, spoken);
  return mark;
}

const CONTAINER_SELECTOR = `[data-id$="${CONTAINER_SUFFIX}"]`;

/**
 * Which lines a change to the form's nodes concerns: the one field it happened
 * in (its container), every field when it added or removed a container (or a
 * node holding one, such as a tab's section), or none. Everything else on the
 * page, such as spinners, notifications and grids, is skipped, so a busy page
 * does not run a query per target on every frame. Our own changes never get
 * here (reconcile drops them), so a removed line is the form's doing and is
 * put back.
 */
function reachOf(record: MutationRecord): Element | "all" | null {
  const target = record.target;
  const targetElement = target instanceof Element ? target : target.parentElement;
  const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  for (const node of changed) {
    if (!(node instanceof Element) || node.localName === TAG) continue;
    if (node.matches(CONTAINER_SELECTOR) || node.querySelector(CONTAINER_SELECTOR)) return "all";
  }
  return targetElement?.closest(CONTAINER_SELECTOR) ?? null;
}

function stillHolds(spot: Spot, container: Element, label: Element | null): boolean {
  return spot.container === container && spot.label === label && spot.anchor.isConnected && container.contains(spot.anchor) && (label === null || spot.anchor.contains(label));
}

/**
 * Climbs from the label (or, with none, from the container's first child) to
 * the nearest node whose parent lays its children out vertically, stopping at
 * the field's container. The host goes right after that node, so it has a row
 * of its own, left-aligned with the field. On a side-labelled field that is
 * after the [label column, control column] row, inside the column that holds
 * it; on a top-labelled field it is right under the label's row.
 */
function spotFor(container: Element, label: Element | null): Spot | null {
  let node = label ?? container.firstElementChild;
  // A label outside the container, or none at all, gives no place.
  if (!node || !container.contains(node) || node === container) return null;
  while (node !== container) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    if (stacksVertically(parent)) return { container, label, anchor: node };
    node = parent;
  }
  return null;
}

const BLOCK_DISPLAYS: ReadonlySet<string> = new Set(["block", "flow-root", "list-item"]);

/**
 * Whether the element puts a block child on a line of its own: a block box
 * (`block`, `flow-root`, `list-item`), a flex column, or a flex row that
 * wraps. Everything else (grid, inline boxes, tables, `display: contents`) is
 * not known to, so the climb goes on to the next ancestor.
 */
export function stacksVertically(element: Element): boolean {
  const style = getComputedStyle(element);
  if (BLOCK_DISPLAYS.has(style.display)) return true;
  if (style.display !== "flex" && style.display !== "inline-flex") return false;
  return style.flexDirection.startsWith("column") || style.flexWrap.startsWith("wrap");
}

/**
 * The field's label. D365 gives it an id of the form
 * `id-<form id>-<n>-<control>-field-label` and no data-id, so the id is matched
 * by suffix. The leading "-" keeps `name` from matching `parentaccountname`:
 * control names have no hyphen. The exact forms come first. Last, any
 * <label> in the container that is not part of the control itself: a two-option
 * or multiselect control draws labels of its own, and those are never the anchor.
 */
export function labelOf(container: Element, control: string): Element | null {
  const escaped = CSS.escape(control);
  const name = `${escaped}${LABEL_SUFFIX}`;
  const exact = container.querySelector(`[data-id="${name}"], [id="${name}"]`) ?? container.querySelector(`[id$="-${name}"]`);
  if (exact) return exact;
  const inControl = `[data-id^="${escaped}.fieldControl"], [data-id$=".fieldControl-pcf-container-id"]`;
  return Array.from(container.querySelectorAll("label")).find((label) => !label.closest(inControl)) ?? null;
}
