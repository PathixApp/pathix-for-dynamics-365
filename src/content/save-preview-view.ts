// Draws the save preview's panel in one closed shadow root, fixed to the
// viewport, the way the form event map and "What changed" are. Text goes in
// through textContent only; component, function and library names are
// customer-authored metadata (see the card's fitness rule).
//
// The panel reads top to bottom as the save does: the form's OnSave handlers,
// then ONE timeline of server lanes in the order Pathix sends them, with the
// save itself drawn at the main operation lane, the asynchronous lane marked
// as unordered, then the lists that have no place in the sequence. A lane whose
// entries all come from Microsoft publishers is one line with its count. Every
// marker is text, not only style.

import { LIVE_LABEL } from "../card/freshness";
import {
  microsoftEntriesLine,
  type PreviewInputs,
  type PreviewItem,
  type PreviewList,
  type PreviewSave,
  type SavePreviewModel,
} from "../card/save-preview";
import type { TipLine } from "../card/lite";
import { element, iconButton, kindChip, link, pathixMark, tipParts } from "./card-view";
import { PANEL_STYLE } from "./event-map-view";

const STYLE = `${PANEL_STYLE}
.panel { width: 460px; }
.inputs { padding: 0 12px 4px; color: #4a5560; overflow-wrap: anywhere; }
.code { padding: 0 3px; border-radius: 2px; background: #f3f4f6; color: #11161c; font: 11px/1.45 "Geist Mono", "Cascadia Mono", Consolas, monospace; }
.live-tag { display: inline-block; padding: 0 4px; margin-right: 4px; border-radius: 2px; font-size: 10px; font-weight: 600; background: #deecf9; color: #004578; }
.section-label { padding: 8px 12px 2px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #4a5560; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.section-label .tag { letter-spacing: 0; text-transform: none; }
.group-note { padding: 0 12px 2px; font-size: 11px; color: #4a5560; }
.row { align-items: flex-start; flex-wrap: nowrap; padding: 3px 0; }
.row .chip { margin-top: 1px; min-width: 22px; justify-content: center; background: #f3f2f1; color: #4a5560; }
.body { flex: 1; min-width: 0; }
.name-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.detail { font-size: 11px; color: #4a5560; overflow-wrap: anywhere; }
.tag.order { background: #deecf9; color: #004578; }
.tag.warn { background: #fff4ce; color: #846904; }
.expand { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left; }
.expand:hover .name { text-decoration: underline; }
.expand:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.caret { color: #4a5560; font-size: 10px; transition: transform 0.1s; }
.expand[aria-expanded="true"] .caret { transform: rotate(90deg); }
.members { margin: 2px 0 0; padding: 0 12px 0 0; list-style: none; font-size: 11px; color: #4a5560; }
.collapsed-body { padding: 0 12px 4px; }
.collapsed-body .group-note { padding-left: 0; }
.members li { overflow-wrap: anywhere; }
.unknown { display: flex; gap: 6px; padding: 2px 12px; color: #4a5560; }
.unknown-mark { flex: none; width: 14px; height: 14px; border-radius: 7px; background: #fff4ce; color: #846904; font-size: 10px; font-weight: 700; text-align: center; line-height: 14px; }
.save-marker { margin: 8px 12px 2px; padding: 4px 8px; border-radius: 2px; background: #deecf9; color: #004578; font-weight: 600; text-align: center; }
.disclosures { margin: 0; padding: 0 12px 8px 28px; color: #4a5560; }
.disclosures li { margin: 2px 0; }
.disclosure-title { padding: 10px 12px 2px; font-weight: 600; }
`;

export class SavePreviewView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private panel: HTMLElement | null = null;
  private onClose: () => void = () => undefined;
  private onHideTips: () => void = () => undefined;

  constructor() {
    this.host = document.createElement("pathix-save-preview");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
  }

  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }

  setOnHideTips(handler: () => void): void {
    this.onHideTips = handler;
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  /** A one-line message while loading, or when there is nothing to read. */
  showMessage(message: string): void {
    this.render([element("p", "headline", message)], null, null);
  }

  /** Lite has no save preview. It says so, and what Pathix does; the tip is shown only when settings say so. */
  showLite(message: string, tip: TipLine | null): void {
    this.render([element("p", "headline", message)], null, tip);
  }

  showPreview(model: SavePreviewModel): void {
    const body: HTMLElement[] = [element("p", "headline", model.headline)];
    body.push(inputsLine(model.inputs));
    for (const section of model.sections) body.push(...(section.kind === "save" ? [saveMarker(section)] : listNodes(section)));
    if (model.disclosures.length > 0) {
      body.push(element("div", "disclosure-title", "What this does not show"));
      const disclosures = element("ul", "disclosures");
      for (const text of model.disclosures) disclosures.append(element("li", "", text));
      body.push(disclosures);
    }
    this.render(body, model, null);
  }

  hide(): void {
    this.panel?.remove();
    this.panel = null;
    this.host.remove();
  }

  private render(body: HTMLElement[], model: SavePreviewModel | null, tip: TipLine | null): void {
    // Showing a message and then the preview replaces the panel, so carry
    // focus across the swap instead of letting it fall to the page.
    // First drawn, focus goes to the close button. Drawn again with focus inside (the answer
    // arrived, or a sign-out asked again), it goes to the heading, never back to the close button.
    const first = this.panel === null;
    const hadFocus = !first && this.root.activeElement !== null && this.panel!.contains(this.root.activeElement);
    this.panel?.remove();
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const panel = element("div", "panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Pathix: save preview");

    const head = element("div", "head");
    const titleRow = element("div", "title-row");
    const heading = element("span", "title", "Save preview");
    heading.tabIndex = -1;
    titleRow.append(heading);
    const infoPanel = element("div", "info");
    infoPanel.hidden = true;
    if (model) {
      for (const line of model.info) infoPanel.append(element("p", "", line));
      const toggle = iconButton("?", "What the save preview shows");
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        infoPanel.hidden = !infoPanel.hidden;
        toggle.setAttribute("aria-expanded", String(!infoPanel.hidden));
      });
      titleRow.append(toggle);
    }
    const close = iconButton("×", "Close save preview");
    close.addEventListener("click", () => this.onClose());
    titleRow.append(close);
    head.append(titleRow);
    if (model) {
      const subtitle = element("div", "subtitle");
      subtitle.append(element("span", "", `${model.table}: ${model.message}`), element("span", "as-of", model.status));
      head.append(subtitle);
    }

    const scroll = element("div", "scroll");
    scroll.append(infoPanel, ...body);
    panel.append(head, scroll, this.footer(tip));
    this.root.append(panel);
    this.panel = panel;
    if (first) close.focus();
    else if (hadFocus) heading.focus();
  }

  // The one footer line. In Lite it says what the preview cannot see and what
  // Pathix does, the word "Pathix" the link, with a button that turns tips off
  // for good. Connected, there is only the mark.
  private footer(tip: TipLine | null): HTMLElement {
    const foot = element("div", "foot");
    if (tip) {
      const text = element("p", "tip");
      text.append(...tipParts(tip).map((part) => (part.link ? link(tip.href, part.text) : document.createTextNode(part.text))));
      const dismiss = iconButton("×", "Don't show tips");
      dismiss.addEventListener("click", () => {
        text.remove();
        dismiss.remove();
        this.onHideTips();
      });
      foot.append(text, dismiss);
    } else {
      foot.append(element("span", ""));
    }
    foot.append(pathixMark());
    return foot;
  }
}

function saveMarker(section: PreviewSave): HTMLElement {
  const marker = element("div", "save-marker", section.text);
  marker.setAttribute("role", "separator");
  marker.setAttribute("aria-label", section.text);
  return marker;
}

function listNodes(section: PreviewList): HTMLElement[] {
  if (section.collapsed) return collapsedNodes(section);
  const label = element("div", "section-label");
  label.append(element("span", "", labelText(section)));
  if (section.laneTag) label.append(element("span", "tag order", section.laneTag));
  if (section.unordered) label.append(element("span", "tag warn", "unordered"));
  const nodes: HTMLElement[] = [label];
  for (const note of section.notes) nodes.push(element("div", "group-note", note));
  if (section.unknownLine) {
    const row = element("div", "unknown");
    const mark = element("span", "unknown-mark", "?");
    mark.setAttribute("aria-label", "Unknown");
    row.append(mark, element("span", "", section.unknownLine));
    nodes.push(row);
    return nodes;
  }
  if (section.count === 0 && section.emptyLine) {
    nodes.push(element("div", "group-note", section.emptyLine));
    return nodes;
  }
  const rows = element("ul", "rows");
  for (const item of section.items) rows.append(itemRow(item));
  if (section.microsoft.length > 0) rows.append(microsoftRow(section.microsoft));
  nodes.push(rows);
  return nodes;
}

function labelText(section: PreviewList): string {
  return section.count === null ? section.title : `${section.title} (${section.count})`;
}

// A lane whose entries all come from Microsoft publishers: one line with the lane's name, its count and
// its tag, which opens in place to the notes and the entries. The lane is never dropped.
function collapsedNodes(section: PreviewList): HTMLElement[] {
  const label = element("div", "section-label");
  const toggle = element("button", "expand") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "", labelText(section)), element("span", "caret", "▸"));
  label.append(toggle);
  if (section.laneTag) label.append(element("span", "tag order", section.laneTag));
  if (section.unordered) label.append(element("span", "tag warn", "unordered"));
  label.append(element("span", "tag", microsoftEntriesLine(section.microsoft.length)));

  const open = element("div", "collapsed-body");
  open.hidden = true;
  for (const note of section.notes) open.append(element("div", "group-note", note));
  open.append(memberList(section.microsoft));
  toggle.addEventListener("click", () => {
    open.hidden = !open.hidden;
    toggle.setAttribute("aria-expanded", String(!open.hidden));
  });
  return [label, open];
}

function memberList(items: PreviewItem[]): HTMLElement {
  const members = element("ul", "members");
  for (const item of items) {
    const detail = [item.order, ...item.lines, ...item.tags].filter(Boolean).join(" · ");
    members.append(element("li", "", detail ? `${item.name} (${detail})` : item.name));
  }
  return members;
}

function itemRow(item: PreviewItem): HTMLLIElement {
  const row = element("li", "row") as HTMLLIElement;
  const body = element("div", "body");
  const nameLine = element("div", "name-line");
  if (item.order) nameLine.append(element("span", item.order === "Order unknown" ? "tag warn" : "tag order", item.order));
  const name = element("span", "name", item.name);
  name.title = item.name;
  nameLine.append(name);
  for (const tag of item.tags) nameLine.append(element("span", "tag warn", tag));
  body.append(nameLine);
  for (const line of item.lines) body.append(element("div", "detail", line));
  if (item.chip) row.append(kindChip(item.chip.kind, item.chip.label, item.chip.colorType));
  row.append(body);
  return row;
}

// Entries from Microsoft publishers, folded behind one toggle so they do not
// drown the customer's own. They keep their order and markers inside the fold.
function microsoftRow(items: PreviewItem[]): HTMLLIElement {
  const row = element("li", "row") as HTMLLIElement;
  const body = element("div", "body");
  const toggle = element("button", "expand") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "name", microsoftEntriesLine(items.length)), element("span", "caret", "▸"));
  const members = memberList(items);
  members.hidden = true;
  toggle.addEventListener("click", () => {
    members.hidden = !members.hidden;
    toggle.setAttribute("aria-expanded", String(!members.hidden));
  });
  body.append(toggle, members);
  row.append(body);
  return row;
}

/** What the save was matched against, each column's logical name in code style. */
function inputsLine(inputs: PreviewInputs): HTMLElement {
  const line = element("p", "inputs");
  if (inputs.live) line.append(element("span", "live-tag", LIVE_LABEL));
  const columns = inputs.columns;
  if (!columns) {
    line.append(document.createTextNode(inputs.text));
    return line;
  }
  line.append(document.createTextNode(`${columns.lead} `));
  columns.names.forEach((name, index) => {
    if (index > 0) line.append(document.createTextNode(", "));
    line.append(element("code", "code", name));
  });
  if (columns.more > 0) line.append(document.createTextNode(` +${columns.more} more`));
  line.append(document.createTextNode(`. ${columns.trail}`));
  return line;
}
