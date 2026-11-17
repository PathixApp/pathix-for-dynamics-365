// Renders the hover card inside a closed shadow root, so D365's styles cannot
// reach it and its styles cannot reach D365.
//
// The look mirrors the Pathix UI's graph popover and its Touchpoints table
// (kind chips, confidence dots): the same tokens, type scale and kind chips,
// so the card reads as Pathix inside D365.
//
// The same frame serves both modes (DESIGN.md, "Lite and connected"): a Lite
// card carries a LITE chip and "Live from Dataverse" where a connected card
// says "As of <scan date>". The footer slot holds "Open in Pathix" when
// connected, and in Lite the one tip line naming what the card cannot see and
// what Pathix does about it.
//
// Every string from Pathix or Dataverse is customer-authored metadata (component names), so
// text goes in through textContent only, and the mark is built with
// createElementNS. The fitness test bans innerHTML and its relatives here.

import { CHANGED_BADGE, LIVE_LABEL, changedBadgeTitle } from "../card/freshness";
import { LITE_CHIP_TITLE, LIVE_FROM_DATAVERSE, unnamedLine, type DependencyGroup, type LiteCardModel, type TipLine } from "../card/lite";
import { CHECK_MARKS, type CheckLine, type LockedCardModel } from "../card/locked";
import { microsoftLine, type FiringGroup, type FiringItem, type FiringSet, type RegisteredCardModel } from "../card/registered";
import { minimumText, type CardFindings, type CardHistory, type CardRow, type FieldCardModel, type FormsRow } from "../card/model";
import type { ImageLine, RowImages } from "../card/triggers";
import type { CardState } from "../card/states";
import { connectedBrief, liteBrief, type LiteBriefSource } from "../card/brief";
import { COPY_LABELS, copyText } from "./copy-brief";
import { findingsIcon } from "./findings-icon";
import type { CardMode } from "../runtime/card-settings";

const CARD_WIDTH = 400;
/** The card's title: the dialog's name, and where focus lands when the card is opened on purpose. */
const TITLE_ID = "pathix-card-title";
const SUBTITLE_ID = "pathix-card-subtitle";
const GAP = 6;
const SVG_NS = "http://www.w3.org/2000/svg";

// Pathix UI design tokens, light theme.
const STYLE = `
:host { all: initial; }
.card {
  position: fixed; z-index: 2147483646; box-sizing: border-box; width: ${CARD_WIDTH}px; max-height: 60vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: #ffffff; color: #11161c; border: 1px solid #7e8b99; border-radius: 6px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
  font: 12px/1.45 Geist, "Segoe UI", system-ui, -apple-system, sans-serif; font-variant-numeric: tabular-nums;
}
.scroll { overflow: auto; }
.head { padding: 8px 12px; border-bottom: 1px solid #e6e8eb; }
.title-row { display: flex; align-items: center; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; height: 16px; padding: 0 4px; border-radius: 2px; flex: none;
  font-size: 9px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; background: #f3f2f1; color: #605e5c;
}
.chip.lite { background: #deecf9; color: #004578; }
.title { flex: 1; min-width: 0; font: 600 13px/1.4 "Geist Mono", "Cascadia Mono", Consolas, monospace; word-break: break-all; }
.title:focus { outline: none; }
.title:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.subtitle { margin-top: 2px; display: flex; align-items: center; gap: 6px; color: #4a5560; font: 11px/1.4 "Geist Mono", "Cascadia Mono", Consolas, monospace; }
.as-of { margin-left: auto; font: 11px/1.4 Geist, "Segoe UI", system-ui, sans-serif; }
.icon-button {
  flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid transparent; border-radius: 9px; background: transparent; color: #4a5560; font: 600 11px/1 Geist, "Segoe UI", sans-serif; cursor: pointer;
}
.copy-button {
  flex: none; height: 18px; padding: 0 6px; border: 1px solid #e6e8eb; border-radius: 9px; background: transparent; color: #4a5560;
  font: 600 11px/1 Geist, "Segoe UI", sans-serif; cursor: pointer;
}
.copy-button:hover { background: #f3f4f6; color: #11161c; }
.copy-button:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.icon-button:hover, .icon-button[aria-expanded="true"] { border-color: #e6e8eb; background: #f3f4f6; color: #11161c; }
.icon-button:focus-visible, a:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.info { padding: 8px 12px; border-bottom: 1px solid #e6e8eb; background: #f3f4f6; color: #4a5560; }
.info p { margin: 2px 0; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 4px; color: #11161c; }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid #e6e8eb; }
.stat { padding: 6px 12px; }
.stat-value { font-size: 16px; font-weight: 600; }
.stat.qualifier .stat-value { color: #4a5560; }
.stat-label { font-size: 11px; color: #4a5560; }
.findings { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid #e6e8eb; }
.findings .section-label { padding: 0; display: inline-flex; align-items: center; gap: 4px; }
.history { padding: 6px 12px; border-bottom: 1px solid #e6e8eb; }
.history.is-unknown { color: #4a5560; }
.live-tag { display: inline-block; padding: 0 4px; margin-right: 4px; border-radius: 2px; font-size: 10px; font-weight: 600; background: #deecf9; color: #004578; }
.tag.fresh { padding: 0 4px; border-radius: 2px; letter-spacing: 0; text-transform: none; font-weight: 600; background: #fff4ce; color: #846904; }
.severity { padding: 1px 6px; border-radius: 2px; font-size: 11px; }
.section-label { padding: 8px 12px 2px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #4a5560; }
.rows { margin: 0; padding: 0; list-style: none; }
.row { display: flex; align-items: flex-start; gap: 6px; padding: 4px 12px; border-bottom: 1px solid #e6e8eb; }
.row:last-child { border-bottom: 0; }
.row .chip { margin-top: 1px; min-width: 22px; justify-content: center; }
.conf { flex: none; width: 10px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
.dot { width: 6px; height: 6px; border-radius: 3px; background: #4a5560; }
.dot.deterministic { background: #107c10; }
.spark { font-size: 9px; line-height: 1; color: #0060aa; }
.body { flex: 1; min-width: 0; }
.name-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: #4a5560; }
.trigger { font-size: 11px; color: #4a5560; }
.expand {
  display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent;
  color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.expand:hover .name { text-decoration: underline; }
.expand:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.caret { color: #4a5560; font-size: 10px; transition: transform 0.1s; }
.expand[aria-expanded="true"] .caret { transform: rotate(90deg); }
.members { margin: 2px 0 0; padding: 0; list-style: none; font-size: 11px; color: #4a5560; }
.note { padding: 4px 12px 8px; color: #4a5560; }
.more { display: block; padding: 4px 12px 8px; }
.message { padding: 8px 12px; color: #4a5560; }
.state { padding: 8px 12px; color: #4a5560; overflow: auto; }
.state-title { margin-bottom: 2px; color: #11161c; font-weight: 600; }
.state-action {
  margin-top: 6px; padding: 2px 8px; border: 1px solid #7e8b99; border-radius: 4px; background: #ffffff; color: #11161c;
  font: 600 11px/1.6 Geist, "Segoe UI", system-ui, sans-serif; cursor: pointer;
}
.state-action:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.headline { padding: 8px 12px 4px; }
.contrast { padding: 6px 12px; border-bottom: 1px solid #e6e8eb; color: #4a5560; }
.coverage, .related { padding: 6px 12px; border-bottom: 1px solid #e6e8eb; color: #4a5560; }
.tip { flex: 1; min-width: 0; margin: 0; font-size: 11px; color: #4a5560; }
.tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid #e6e8eb; }
.tab {
  padding: 6px 8px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #4a5560;
  font: 600 11px/1.4 Geist, "Segoe UI", system-ui, sans-serif; cursor: pointer;
}
.tab[aria-selected="true"] { color: #11161c; border-bottom-color: #0078d4; }
.tab:focus-visible { outline: 2px solid #0078d4; outline-offset: -2px; }
.view-title { padding: 8px 12px 0; font-weight: 600; }
.unknown { display: flex; gap: 6px; padding: 2px 12px; color: #4a5560; }
.unknown-mark { flex: none; width: 14px; height: 14px; border-radius: 7px; background: #fff4ce; color: #846904; font-size: 10px; font-weight: 700; text-align: center; line-height: 14px; }
.group-note { padding: 0 12px 2px; font-size: 11px; color: #4a5560; }
.edits { margin-top: 6px; border-top: 1px solid #e6e8eb; background: #fafbfc; }
.edits .headline { padding-top: 6px; }
.edits .expand { align-items: flex-start; }
.wrap { min-width: 0; }
.check { flex: none; width: 16px; height: 16px; margin-top: 1px; border-radius: 8px; text-align: center; font: 700 11px/16px Geist, "Segoe UI", sans-serif; }
.check.is-ruledOut { background: #dff6dd; color: #107c10; }
.check.is-cause { background: #fde7e9; color: #a4262c; }
.check.is-unknown { background: #fff4ce; color: #846904; }
.check.is-checking { background: #edebe9; color: #323130; }
.check-topic { font-weight: 600; }
.columns { font-family: "Geist Mono", "Cascadia Mono", Consolas, monospace; }
.members li { overflow-wrap: anywhere; }
.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none;
  padding: 6px 12px; border-top: 1px solid #e6e8eb; background: #f3f4f6;
}
a { color: #0060aa; text-decoration: none; }
a:hover { text-decoration: underline; }
.mark { flex: none; display: block; }
`;

// The Pathix UI's kind chip colors; anything else gets the neutral chip.
const KIND_COLORS: Record<string, [string, string]> = {
  PluginStep: ["#deecf9", "#004578"],
  ClassicWorkflow: ["#dde3eb", "#3a4a5e"],
  Dialog: ["#e1d8f1", "#5c2e91"],
  BusinessRule: ["#f3d9e7", "#984063"],
  ModernFlow: ["#d8d8f1", "#3a3a8a"],
  FormScript: ["#fed9cc", "#a2451f"],
  Form: ["#daf1d4", "#176b2e"],
  CanvasApp: ["#e6f3c4", "#4a6f0e"],
};

export class CardView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private card: HTMLElement | null = null;
  /** The next card drawn takes focus: it was opened on purpose, not by hover. */
  private focusNext = false;
  /** The Lite tab last chosen, kept while the page is open. */
  private liteTab: LiteTab = "registered";
  private onClose: () => void = () => undefined;
  private onHideTips: () => void = () => undefined;
  private onOpenOptions: () => void = () => undefined;

  constructor() {
    this.host = document.createElement("pathix-field-card");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
  }

  get isOpen(): boolean {
    return this.card !== null;
  }

  contains(node: Node | null): boolean {
    return !!node && (node === this.host || this.host.contains(node));
  }

  /** Whether focus is inside the card. */
  get hasFocus(): boolean {
    return this.card !== null && this.root.activeElement !== null;
  }

  /**
   * The card was opened on purpose (the popup, the command or an X-ray line):
   * the next draw moves focus to its title. The controller calls this just
   * before that draw, so it never carries over to a later hover card. A redraw
   * of the same field updates the card in place around its title, so focus
   * stays put and a screen reader does not announce the dialog again.
   */
  takeFocus(): void {
    this.focusNext = true;
  }

  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }

  setOnHideTips(handler: () => void): void {
    this.onHideTips = handler;
  }

  setOnOpenOptions(handler: () => void): void {
    this.onOpenOptions = handler;
  }

  /**
   * An empty or error state: what happened, and what to do next. A null mode
   * is not known (the extension did not say), and the header claims neither.
   */
  showState(anchor: DOMRect, table: string, column: string, state: CardState, mode: CardMode | null): void {
    const card = this.frame(`${table}.${column}`);
    const lite = mode === "lite";
    card.append(this.header({ table, column, lite, secured: false, status: lite ? LIVE_FROM_DATAVERSE : null, info: null, brief: null }));
    const body = element("div", "state");
    body.dataset.state = state.kind;
    body.append(element("div", "state-title", state.title), element("div", "", state.text));
    if (state.action === "openOptions") {
      const button = element("button", "state-action", "Open options") as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => this.onOpenOptions());
      body.append(button);
    }
    card.append(body);
    card.append(this.footer(null));
    this.place(card, anchor);
  }

  showMessage(anchor: DOMRect, table: string, column: string, message: string, mode: CardMode | null): void {
    const card = this.frame(`${table}.${column}`);
    const lite = mode === "lite";
    card.append(this.header({ table, column, lite, secured: false, status: lite ? LIVE_FROM_DATAVERSE : null, info: null, brief: null }));
    // Still loading: assistive technology waits for the content before reading it. The next draw replaces it.
    const loading = element("div", "message", message);
    loading.setAttribute("aria-busy", "true");
    card.append(loading);
    card.append(this.footer(null));
    this.place(card, anchor);
  }

  /**
   * The connected card. `contrast` is the line comparing Dataverse's tracking with Pathix's writers.
   * `locked` is "Why can't I edit this field?", only for a control the form shows read-only.
   * `related` says the field is another record's, shown in a quick view; null for the form's own field.
   */
  showCard(anchor: DOMRect, model: FieldCardModel, contrast: string | null = null, locked: LockedCardModel | null = null, related: string | null = null): void {
    const subject = `${model.table}.${model.column}`;
    // Drawn again for the same field (the live check's badges arrive after the
    // first draw): keep what the reader has opened and where focus is.
    // Only a card an earlier showCard drew counts, not the loading message or
    // another kind of card, whose controls sit in other places.
    const previous = this.card;
    const carried = previous?.dataset.drawnBy === "showCard" && previous.dataset.subject === subject ? this.carriedState() : null;
    const card = this.frame(subject);
    card.dataset.drawnBy = "showCard";
    const info = this.infoPanel([...model.info, ...(locked?.info ?? [])], true);
    card.append(this.header({ table: model.table, column: model.column, lite: false, secured: model.secured, status: model.asOf, info, brief: () => connectedBrief(model, contrast, locked) }));
    card.append(info);

    const scroll = element("div", "scroll");
    if (related) scroll.append(element("div", "related", related));
    if (locked) scroll.append(...lockedBody(locked));
    // A column the latest scan does not hold has no counts: an empty answer about it is not zero.
    if (!model.notInScan) scroll.append(stats(model));
    if (contrast && !model.notInScan) scroll.append(element("div", "contrast", contrast));
    if (model.coverageWarning) scroll.append(element("div", "coverage", `Readers are a minimum. ${model.coverageWarning}`));
    if (model.findings) scroll.append(findingsLine(model.findings));
    if (model.history) scroll.append(historyLine(model.history));
    if (model.freshness) scroll.append(freshnessLine(model.freshness));
    scroll.append(element("div", "section-label", "Writers"));
    if (model.emptyLine) {
      scroll.append(element("div", "note", model.emptyLine));
    } else {
      const list = element("ul", "rows");
      for (const row of model.rows) list.append(row.type === "forms" ? formsRow(row) : writerRow(row));
      scroll.append(list);
    }
    if (model.moreCount > 0) {
      const more = link(model.openUrl, `+${model.moreCount} more in Pathix`);
      more.className = "more";
      scroll.append(more);
    }
    card.append(scroll);
    card.append(this.footer({ kind: "open", href: model.openUrl }));
    this.place(card, anchor, carried ? (live) => this.restoreState(live, carried) : undefined);
  }

  /** Which "?" panel and expanders are open, and which control has focus, in the card on screen. */
  private carriedState(): CarriedState | null {
    const card = this.card;
    if (!card) return null;
    const controls = Array.from(card.querySelectorAll<HTMLElement>("button, a"));
    const expanded = controls.flatMap((control, index) => (control.getAttribute("aria-expanded") === "true" ? [index] : []));
    const focused = this.root.activeElement ? controls.indexOf(this.root.activeElement as HTMLElement) : -1;
    return { expanded, focused };
  }

  /** Opens the expanders that were open, and focuses the control that had focus. Answers whether it moved focus. */
  private restoreState(card: HTMLElement, state: CarriedState): boolean {
    const controls = Array.from(card.querySelectorAll<HTMLElement>("button, a"));
    for (const index of state.expanded) controls[index]?.click();
    const focused = state.focused >= 0 ? controls[state.focused] : undefined;
    focused?.focus();
    return focused !== undefined;
  }

  /**
   * Lite's two cards for one column behind tabs: what is registered to fire
   * when it changes, and what Dataverse tracks as depending on it. Each tab
   * carries its own "?" text and its own footer line. `related` says the
   * field is another record's, shown in a quick view, above the tabs.
   */
  showLiteCards(anchor: DOMRect, cards: LiteCards, related: string | null = null): void {
    const { registered, dependencies } = cards;
    const card = this.frame(`${registered.table}.${registered.column}`);
    const info = this.infoPanel([], false);
    // The brief is of the tab the reader is looking at.
    let shown: LiteTab = "registered";
    const brief = () => liteBrief(briefSource(shown, cards));
    card.append(this.header({ table: registered.table, column: registered.column, lite: true, secured: false, status: registered.status, info, brief }));
    card.append(info);
    if (related) card.append(element("div", "related", related));

    const tabs = element("div", "tabs");
    tabs.setAttribute("role", "tablist");
    const scroll = element("div", "scroll");
    scroll.setAttribute("role", "tabpanel");
    let foot = element("div", "foot");
    card.append(tabs, scroll, foot);

    const views: Array<{ id: LiteTab; label: string; info: string[]; tip: TipLine | null; render: () => HTMLElement[] }> = [
      { id: "registered", label: "Fires on change", info: registered.info, tip: registered.tip, render: () => registeredBody(registered) },
      { id: "dependencies", label: "Dependencies", info: dependencies.info, tip: dependencies.tip, render: () => dependenciesBody(dependencies) },
    ];
    const { locked } = cards;
    if (locked) views.unshift({ id: "locked", label: "Why locked?", info: locked.info, tip: locked.tip, render: () => lockedBody(locked) });
    const buttons = views.map((view) => {
      const button = element("button", "tab", view.label) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => select(view.id));
      tabs.append(button);
      return button;
    });

    const select = (id: LiteTab) => {
      if (id !== "locked") this.liteTab = id;
      const view = views.find((candidate) => candidate.id === id) ?? views[0]!;
      shown = view.id;
      buttons.forEach((button, index) => button.setAttribute("aria-selected", String(views[index] === view)));
      info.replaceChildren(...view.info.map((line) => element("p", "", line)));
      scroll.replaceChildren(...view.render());
      const next = this.footer(view.tip ? { kind: "tip", tip: view.tip } : null);
      foot.replaceWith(next);
      foot = next;
    };
    // Hovering a locked field is the one action: its card opens on the checklist.
    select(locked ? "locked" : this.liteTab === "locked" ? "registered" : this.liteTab);
    this.place(card, anchor);
  }

  hide(): void {
    this.card?.remove();
    this.card = null;
    this.focusNext = false;
    this.host.remove();
  }

  // The dialog is named by its title (the column), which is also where focus
  // lands when the card is opened on purpose. The card on screen stays until
  // place() swaps or updates it.
  private frame(subject: string): HTMLElement {
    const card = element("div", "card");
    card.dataset.subject = subject;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-labelledby", TITLE_ID);
    card.setAttribute("aria-describedby", SUBTITLE_ID);
    return card;
  }

  private header(options: HeaderOptions): HTMLElement {
    const { table, column, lite, secured, status, info, brief } = options;
    const head = element("div", "head");
    const titleRow = element("div", "title-row");
    const title = element("div", "title", column);
    title.id = TITLE_ID;
    title.setAttribute("role", "heading");
    title.setAttribute("aria-level", "2");
    title.tabIndex = -1;
    titleRow.append(element("span", "chip", "Column"), title);
    if (lite) {
      const chip = element("span", "chip lite", "Lite");
      chip.title = LITE_CHIP_TITLE;
      titleRow.append(chip);
    }
    if (info) titleRow.append(infoToggle(info));
    if (brief) titleRow.append(copyButton(brief));
    const close = iconButton("×", "Close");
    close.addEventListener("click", () => this.onClose());
    titleRow.append(close);

    const subtitle = element("div", "subtitle", table);
    subtitle.id = SUBTITLE_ID;
    if (secured) {
      const chip = element("span", "chip", "Secured");
      chip.title = "Column-secured (field security). Details behind the ?.";
      subtitle.append(chip);
    }
    if (status) subtitle.append(element("span", "as-of", status));
    head.append(titleRow, subtitle);
    return head;
  }

  // The confidence legend is a Pathix vocabulary; a Lite card makes no such claim.
  private infoPanel(lines: string[], legend: boolean): HTMLElement {
    const panel = element("div", "info");
    panel.id = "pathix-card-info";
    panel.hidden = true;
    if (legend) {
      const items = element("div", "legend");
      items.append(legendItem(confidenceMark("deterministic"), "Deterministic"));
      items.append(legendItem(confidenceMark("aiDerived"), "AI-derived (unverified)"));
      items.append(legendItem(confidenceMark("other"), "Unresolved"));
      panel.append(items);
    }
    for (const line of lines) panel.append(element("p", "", line));
    return panel;
  }

  private footer(slot: FooterSlot | null): HTMLElement {
    const foot = element("div", "foot");
    if (slot?.kind === "open") foot.append(link(slot.href, "Open in Pathix →"));
    else if (slot?.kind === "tip") foot.append(...this.tipLine(slot.tip));
    else foot.append(element("span", ""));
    foot.append(pathixMark());
    return foot;
  }

  // The tip line, its word "Pathix" a link, with a button that turns tips off
  // for good.
  private tipLine(tip: TipLine): HTMLElement[] {
    const text = element("p", "tip");
    text.append(...tipParts(tip).map((part) => (part.link ? link(tip.href, part.text) : document.createTextNode(part.text))));
    const dismiss = iconButton("×", "Don't show tips");
    dismiss.addEventListener("click", () => {
      text.remove();
      dismiss.remove();
      this.onHideTips();
    });
    return [text, dismiss];
  }

  // Below the field, flipping above when there is no room; never off-screen.
  // The host goes inside body, so assistive technology reaches it with the
  // page; the closed shadow root and `all: initial` still keep D365's styles out.
  //
  // A draw for the field already on screen is grafted into the card there,
  // around its title, which never leaves the page: focus on the title stays
  // and the dialog is not announced again. `restore` puts back a control's
  // focus that a redraw replaced; with nothing to restore, focus that was in
  // the card falls back to its title rather than to the page.
  private place(next: HTMLElement, anchor: DOMRect, restore?: (card: HTMLElement) => boolean): void {
    if (!this.host.isConnected) (document.body ?? document.documentElement).append(this.host);
    const old = this.card;
    const hadFocus = this.hasFocus;
    let card = next;
    if (old && old.isConnected && old.dataset.subject === next.dataset.subject && graft(old, next)) {
      card = old;
    } else {
      old?.remove();
      this.root.append(next);
    }
    this.card = card;
    const title = () => card.querySelector<HTMLElement>(`#${TITLE_ID}`)?.focus({ preventScroll: true });
    if (this.focusNext) title();
    this.focusNext = false;
    const restored = restore?.(card) ?? false;
    if (hadFocus && !restored && this.root.activeElement === null) title();

    const width = Math.min(CARD_WIDTH, window.innerWidth - 2 * GAP);
    const left = Math.min(Math.max(GAP, anchor.left), window.innerWidth - width - GAP);
    const height = card.getBoundingClientRect().height;
    const below = anchor.bottom + GAP;
    const top = below + height <= window.innerHeight - GAP ? below : Math.max(GAP, anchor.top - GAP - height);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.width = `${width}px`;
  }
}

/**
 * Moves `next`'s content into `old` around old's title: at each level from the
 * title up to the card, old's other children go and next's take their place,
 * and each kept element takes next's attributes. The title itself never leaves
 * the page. False, with nothing changed, when the two are not built alike.
 */
function graft(old: HTMLElement, next: HTMLElement): boolean {
  const oldPath = pathUp(old.querySelector<HTMLElement>(`#${TITLE_ID}`), old);
  const nextPath = pathUp(next.querySelector<HTMLElement>(`#${TITLE_ID}`), next);
  if (!oldPath || !nextPath || oldPath.length !== nextPath.length) return false;
  if (oldPath.some((node, index) => node.tagName !== nextPath[index]!.tagName)) return false;
  for (let level = 1; level < oldPath.length; level += 1) {
    const [keptChild, parent] = [oldPath[level - 1]!, oldPath[level]!];
    const [newChild, newParent] = [nextPath[level - 1]!, nextPath[level]!];
    for (const child of Array.from(parent.childNodes)) if (child !== keptChild) child.remove();
    const siblings = Array.from(newParent.childNodes);
    const at = siblings.indexOf(newChild);
    keptChild.before(...siblings.slice(0, at));
    keptChild.after(...siblings.slice(at + 1));
  }
  oldPath.forEach((node, index) => copyAttributes(nextPath[index]!, node));
  return true;
}

/** The title, its ancestors, and the card, from the bottom up; null when the title is missing. */
function pathUp(title: HTMLElement | null, card: HTMLElement): HTMLElement[] | null {
  if (!title) return null;
  const path: HTMLElement[] = [title];
  let node: HTMLElement = title;
  while (node !== card) {
    if (!node.parentElement) return null;
    node = node.parentElement;
    path.push(node);
  }
  return path;
}

function copyAttributes(from: HTMLElement, to: HTMLElement): void {
  for (const name of to.getAttributeNames()) if (!from.hasAttribute(name)) to.removeAttribute(name);
  for (const name of from.getAttributeNames()) to.setAttribute(name, from.getAttribute(name)!);
}

interface HeaderOptions {
  table: string;
  column: string;
  lite: boolean;
  secured: boolean;
  /** "As of <scan date>" when connected, "Live from Dataverse" in Lite. */
  status: string | null;
  info: HTMLElement | null;
  /** The plain-text brief the Copy button writes, built when it is clicked; null for no button. */
  brief: (() => string) | null;
}

type FooterSlot = { kind: "open"; href: string } | { kind: "tip"; tip: TipLine };

interface CarriedState {
  /** Positions, among the card's buttons and links, of the expanders that are open. */
  expanded: number[];
  /** Position of the control that has focus; -1 for none. */
  focused: number;
}

export type LiteTab = "locked" | "registered" | "dependencies";

/** The Lite cards for one column. */
export interface LiteCards {
  registered: RegisteredCardModel;
  dependencies: LiteCardModel;
  /** "Why can't I edit this field?", only for a control the form shows read-only. */
  locked: LockedCardModel | null;
}

// --- pieces ----------------------------------------------------------------------

/** What a stat shows when its count could not be loaded: the same "?" as every unknown state. */
export const UNKNOWN_STAT = "?";

/** A tip line split around its link word, so the word "Pathix" is the link. */
export function tipParts(tip: TipLine): Array<{ text: string; link: boolean }> {
  const at = tip.text.indexOf(tip.linkText);
  if (at === -1) return [{ text: `${tip.text} `, link: false }, { text: tip.linkText, link: true }];
  const parts = [
    { text: tip.text.slice(0, at), link: false },
    { text: tip.linkText, link: true },
    { text: tip.text.slice(at + tip.linkText.length), link: false },
  ];
  return parts.filter((part) => part.text !== "");
}

function stats(model: FieldCardModel): HTMLElement {
  const grid = element("div", "stats");
  for (const stat of model.stats) {
    const cell = element("div", stat.qualifier ? "stat qualifier" : "stat");
    // "?", never 0: a count we could not load is not a count of nothing.
    const value = element("div", "stat-value", stat.value === null ? UNKNOWN_STAT : minimumText(stat.value, stat.minimum));
    // "≥3" is read out as words: Pathix says its scan could not see every one.
    if (stat.minimum && stat.value !== null) value.setAttribute("aria-label", `at least ${stat.value}`);
    cell.append(value);
    cell.append(element("div", "stat-label", stat.label));
    grid.append(cell);
  }
  return grid;
}

// The Pathix UI's severity chip tones: Critical and High share the high pair.
const SEVERITY_TONES: Record<string, [string, string]> = {
  Critical: ["#fde7e9", "#a4262c"],
  High: ["#fde7e9", "#a4262c"],
  Medium: ["#fff4ce", "#846904"],
  Low: ["#f3f2f1", "#605e5c"],
  Info: ["#f3f2f1", "#4a5560"],
};

// The popover's Findings line: highest open severity and the count, linking to
// the column's findings tab in Pathix. The flag is the same icon X-ray writes
// under each label; the word beside it already names it, so it is hidden from
// assistive technology here.
function findingsLine(findings: CardFindings): HTMLElement {
  const line = element("div", "findings");
  const label = element("span", "section-label");
  label.append(findingsIcon(true), element("span", "", "Findings"));
  line.append(label);
  if (findings.openCount === 0) {
    line.append(element("span", "stat-label", "No open findings"));
    return line;
  }
  if (findings.severity) {
    const chip = element("span", "severity", findings.severity.toLowerCase());
    const [background, color] = SEVERITY_TONES[findings.severity] ?? SEVERITY_TONES.Low!;
    chip.style.background = background;
    chip.style.color = color;
    line.append(chip);
  }
  line.append(link(findings.href, `${findings.openCount} open finding${findings.openCount === 1 ? "" : "s"}`));
  return line;
}

// "Changed 3 times since Aug 12", linking to the column's page in Pathix, where
// its history panel is. A failed read says "unknown"; no history hides the line.
function historyLine(history: CardHistory): HTMLElement {
  if (history.kind === "unknown") return element("div", "history is-unknown", history.text);
  const line = element("div", "history");
  line.append(link(history.href, history.text));
  return line;
}

// The live check's one line, labelled "live": what Dataverse says right now
// next to what Pathix knew as of its scan.
function freshnessLine(text: string): HTMLElement {
  const line = element("div", "history");
  line.append(element("span", "live-tag", LIVE_LABEL), document.createTextNode(text));
  return line;
}

export function changedBadge(text: string, isForm: boolean, count = 1): HTMLElement {
  const badge = element("span", "tag fresh");
  badge.append(element("span", "live-tag", LIVE_LABEL), document.createTextNode(text));
  badge.title = changedBadgeTitle(isForm, count);
  return badge;
}

export function writerRow(row: CardRow): HTMLLIElement {
  const item = element("li", "row") as HTMLLIElement;

  const chip = element("span", "chip", row.kind);
  const colors = KIND_COLORS[row.componentType];
  if (colors) {
    chip.style.background = colors[0];
    chip.style.color = colors[1];
  }
  chip.title = row.kindLabel;

  const conf = confidenceMark(row.confidence);
  conf.title = row.confidenceLabel;
  conf.setAttribute("role", "img");
  conf.setAttribute("aria-label", row.confidenceLabel);

  const body = element("div", "body");
  const nameLine = element("div", "name-line");
  const name = element("span", "name", row.name);
  name.title = row.name;
  nameLine.append(name);
  if (row.human) nameLine.append(element("span", "tag", "human"));
  if (row.microsoft) nameLine.append(element("span", "tag", "microsoft"));
  if (row.changedSinceScan) nameLine.append(changedBadge(CHANGED_BADGE, row.kind === "FRM"));
  body.append(nameLine);
  for (const trigger of row.triggers) {
    body.append(element("div", "trigger", trigger.label));
    if (trigger.scope) body.append(element("div", "trigger", trigger.scope));
    if (trigger.rowFilter) body.append(element("div", "trigger", trigger.rowFilter));
  }
  if (row.moreTriggers > 0) body.append(element("div", "trigger", `+${row.moreTriggers} more ${row.moreTriggers === 1 ? "trigger" : "triggers"} in Pathix`));
  if (row.images) body.append(...imageNodes(row.images));

  item.append(chip, conf, body);
  return item;
}

// A plugin step's images under its trigger. No answer from Pathix is "unknown", never "no images".
function imageNodes(images: RowImages): HTMLElement[] {
  if (images.kind === "unknown") return [element("div", "trigger", "Images: unknown")];
  return images.lines.map((image: ImageLine) => element("div", "trigger", image.text));
}

// One row for every customer form; the names open below it on demand.
export function formsRow(row: FormsRow): HTMLLIElement {
  const item = element("li", "row") as HTMLLIElement;
  const chip = element("span", "chip", "FRM");
  const [background, color] = KIND_COLORS.Form!;
  chip.style.background = background;
  chip.style.color = color;
  chip.title = "Form";

  // Forms are placed on the form by platform structure: always Deterministic.
  const conf = confidenceMark("deterministic");
  conf.title = "Deterministic";
  conf.setAttribute("role", "img");
  conf.setAttribute("aria-label", "Deterministic");

  const body = element("div", "body");
  const toggle = element("button", "expand") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "name", `${row.count} ${row.count === 1 ? "form" : "forms"}`));
  toggle.append(element("span", "tag", "human"));
  toggle.append(element("span", "caret", "▸"));
  const members = element("ul", "members");
  members.hidden = true;
  for (const name of row.names) members.append(element("li", "", name));
  toggle.addEventListener("click", () => {
    members.hidden = !members.hidden;
    toggle.setAttribute("aria-expanded", String(!members.hidden));
  });
  body.append(toggle);
  if (row.changedSinceScan) body.append(changedBadge(`${row.changedSinceScan} changed since scan`, true, row.changedSinceScan));
  body.append(members);

  item.append(chip, conf, body);
  return item;
}

// One kind of tracked dependency, e.g. "22 views"; the names open below it.
function groupRow(group: DependencyGroup): HTMLLIElement {
  const item = element("li", "row") as HTMLLIElement;
  const chip = element("span", "chip", group.kind);
  const colors = KIND_COLORS[group.colorType];
  if (colors) {
    chip.style.background = colors[0];
    chip.style.color = colors[1];
  }
  chip.title = group.kindLabel;

  const body = element("div", "body");
  const toggle = element("button", "expand") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "name", group.label));
  toggle.append(element("span", "caret", "▸"));
  const members = element("ul", "members");
  members.hidden = true;
  for (const name of group.names) members.append(element("li", "", name));
  if (group.unnamedCount > 0) members.append(element("li", "", unnamedLine(group.unnamedCount)));
  toggle.addEventListener("click", () => {
    members.hidden = !members.hidden;
    toggle.setAttribute("aria-expanded", String(!members.hidden));
  });
  body.append(toggle, members);

  item.append(chip, body);
  return item;
}

function dependenciesBody(model: LiteCardModel): HTMLElement[] {
  const nodes = [element("div", "headline", model.headline)];
  if (model.groups.length > 0) {
    nodes.push(element("div", "section-label", "Tracked dependencies"));
    const list = element("ul", "rows");
    for (const group of model.groups) list.append(groupRow(group));
    nodes.push(list);
  }
  return nodes;
}

function lockedBody(model: LockedCardModel): HTMLElement[] {
  const list = element("ul", "rows");
  for (const check of model.lines) list.append(checkRow(check));
  return [element("div", "view-title", model.title), element("div", "headline", model.headline), list];
}

const CHECK_LABELS: Record<CheckLine["state"], string> = { ruledOut: "Ruled out", cause: "The cause", unknown: "Cannot check", checking: "Checking" };

function checkRow(check: CheckLine): HTMLLIElement {
  const row = element("li", "row") as HTMLLIElement;
  const mark = element("span", `check is-${check.state}`, CHECK_MARKS[check.state]);
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", CHECK_LABELS[check.state]);
  mark.title = CHECK_LABELS[check.state];
  const body = element("div", "body");
  const topic = element("div", "check-topic");
  // Only the signed-in user's own state is read live, and it says so.
  if (check.live) topic.append(element("span", "live-tag", LIVE_LABEL));
  topic.append(document.createTextNode(check.topic));
  body.append(topic, element("div", "", check.text));
  if (check.names.length > 0) {
    const names = element("ul", "members");
    for (const name of check.names) names.append(element("li", "", name));
    body.append(names);
  }
  row.append(mark, body);
  return row;
}

function registeredBody(model: RegisteredCardModel): HTMLElement[] {
  const nodes = [element("div", "view-title", model.title), ...firingNodes(model)];
  if (model.edits) {
    const edits = element("div", "edits");
    edits.append(element("div", "section-label", "Your unsaved edits"));
    // Logical names, so not in the label's capitals.
    edits.append(element("div", "group-note columns", model.edits.columns.join(", ")));
    const toggle = element("button", "expand") as HTMLButtonElement;
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.append(element("span", "wrap", model.edits.headline), element("span", "caret", "▸"));
    const head = element("div", "headline");
    head.append(toggle);
    const body = element("div", "");
    body.hidden = true;
    body.append(...firingNodes(model.edits, false));
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    });
    edits.append(head, body);
    nodes.push(edits);
  }
  return nodes;
}

// The headline, a "?" line for each source Lite could not read, then the groups.
function firingNodes(set: FiringSet, withHeadline = true): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (withHeadline) nodes.push(element("div", "headline", set.headline));
  for (const line of set.unknowns) {
    const row = element("div", "unknown");
    const mark = element("span", "unknown-mark", "?");
    mark.setAttribute("aria-label", "Unknown");
    row.append(mark, element("span", "", line));
    nodes.push(row);
  }
  for (const group of set.groups) nodes.push(...firingGroup(group));
  return nodes;
}

function firingGroup(group: FiringGroup): HTMLElement[] {
  const nodes = [element("div", "section-label", `${group.title} (${group.items.length + group.microsoft.length})`)];
  if (group.note) nodes.push(element("div", "group-note", group.note));
  const list = element("ul", "rows");
  for (const item of group.items) list.append(firingRow(item));
  if (group.microsoft.length > 0) list.append(microsoftRow(group.microsoft));
  nodes.push(list);
  return nodes;
}

function firingRow(item: FiringItem): HTMLLIElement {
  const row = element("li", "row") as HTMLLIElement;
  const body = element("div", "body");
  const nameLine = element("div", "name-line");
  const name = element("span", "name", item.name);
  name.title = item.name;
  nameLine.append(name);
  body.append(nameLine, element("div", "trigger", item.detail));
  row.append(kindChip(item.kind, item.kindLabel, item.colorType), body);
  return row;
}

// Steps from Microsoft publishers, folded behind one toggle so they do not
// drown the customer's own.
function microsoftRow(items: FiringItem[]): HTMLLIElement {
  const row = element("li", "row") as HTMLLIElement;
  const body = element("div", "body");
  const toggle = element("button", "expand") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "name", microsoftLine(items.length)), element("span", "caret", "▸"));
  const members = element("ul", "members");
  members.hidden = true;
  for (const item of items) members.append(element("li", "", `${item.name} (${item.detail})`));
  toggle.addEventListener("click", () => {
    members.hidden = !members.hidden;
    toggle.setAttribute("aria-expanded", String(!members.hidden));
  });
  body.append(toggle, members);
  row.append(kindChip("PLG", "Plugin step", "PluginStep"), body);
  return row;
}

export function kindChip(kind: string, label: string, colorType: string): HTMLElement {
  const chip = element("span", "chip", kind);
  const colors = KIND_COLORS[colorType];
  if (colors) {
    chip.style.background = colors[0];
    chip.style.color = colors[1];
  }
  chip.title = label;
  return chip;
}

function confidenceMark(kind: CardRow["confidence"]): HTMLElement {
  const wrap = element("span", "conf");
  wrap.append(kind === "aiDerived" ? element("span", "spark", "✦") : element("span", kind === "deterministic" ? "dot deterministic" : "dot"));
  return wrap;
}

function legendItem(mark: HTMLElement, label: string): HTMLElement {
  const item = element("span", "");
  item.append(mark, document.createTextNode(label));
  return item;
}

function infoToggle(panel: HTMLElement): HTMLButtonElement {
  const button = iconButton("?", "What this card shows");
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
  return button;
}

function briefSource(tab: LiteTab, cards: LiteCards): LiteBriefSource {
  if (tab === "locked" && cards.locked) return { kind: "locked", model: cards.locked };
  if (tab === "dependencies") return { kind: "dependencies", model: cards.dependencies };
  return { kind: "registered", model: cards.registered };
}

// One click copies the card's brief; the label says what happened for a moment.
function copyButton(brief: () => string): HTMLButtonElement {
  const button = element("button", "copy-button", COPY_LABELS.idle) as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-label", "Copy as brief");
  button.title = "Copy a plain-text brief of this card: names and counts, never values";
  let reset: number | undefined;
  button.addEventListener("click", () => {
    void copyText(brief()).then((copied) => {
      button.textContent = copied ? COPY_LABELS.done : COPY_LABELS.failed;
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        button.textContent = COPY_LABELS.idle;
      }, 2000);
    });
  });
  return button;
}

export function iconButton(text: string, label: string): HTMLButtonElement {
  const button = element("button", "icon-button", text) as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

export function link(href: string, text: string): HTMLAnchorElement {
  const anchor = element("a", "", text) as HTMLAnchorElement;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

export function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The Pathix mark, 28 x 14. */
export function pathixMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "mark");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 56 28");
  svg.setAttribute("fill", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Pathix");
  // A title as well as the label: some screen readers and checkers name an SVG only by its title.
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = "Pathix";
  svg.append(title);
  const ink = "#11161c";
  const accent = "#0078d4";
  const parts: Array<[string, Record<string, string>]> = [
    ["line", { x1: "10", y1: "14", x2: "22", y2: "14", stroke: ink, "stroke-width": "2" }],
    ["line", { x1: "34", y1: "14", x2: "46", y2: "14", stroke: ink, "stroke-width": "2" }],
    ["circle", { cx: "6", cy: "14", r: "4", fill: "none", stroke: ink, "stroke-width": "2" }],
    ["circle", { cx: "28", cy: "14", r: "6", fill: accent, stroke: accent, "stroke-width": "2" }],
    ["circle", { cx: "50", cy: "14", r: "4", fill: "none", stroke: ink, "stroke-width": "2" }],
  ];
  for (const [tag, attributes] of parts) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}
