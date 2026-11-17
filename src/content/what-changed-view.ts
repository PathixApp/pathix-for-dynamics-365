// Draws the "What changed" panel in one closed shadow root, fixed to the
// viewport, the way the form event map is. Text goes in through textContent
// only; component names are customer-authored metadata (see the card's
// fitness rule). The panel holds the headline, the changes grouped by day or
// scan, a "?" with what the list cannot see, and the one footer line: in Lite
// what Pathix does, when connected a link to the full ledger.

import { CHANGED_BADGE, LIVE_LABEL } from "../card/freshness";
import type { ChangeRow, WhatChangedModel } from "../card/what-changed";
import { changedBadge, element, iconButton, kindChip, link, pathixMark, tipParts } from "./card-view";
import { PANEL_STYLE } from "./event-map-view";

const STYLE = `${PANEL_STYLE}
.group-title { padding: 8px 12px 0; }
.rows { padding: 0 12px 4px; }
.change { padding: 3px 0; }
.change .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
.change .chip { background: #f3f2f1; color: #4a5560; font-size: 9px; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.what { color: #4a5560; font-size: 11px; padding-left: 0; }
.tag.fresh { background: #fff4ce; color: #846904; }
.live-tag { display: inline-block; padding: 0 4px; margin-right: 4px; border-radius: 2px; font-size: 10px; font-weight: 600; background: #deecf9; color: #004578; }
.fresh-line { padding: 0 12px 4px; }
.unknowns { padding: 0 12px 4px; color: #4a5560; }
.unknowns p, .note { margin: 2px 0; }
.note { padding: 0 12px; color: #4a5560; }
.more { display: block; padding: 2px 12px 6px; }
`;

export class WhatChangedView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private panel: HTMLElement | null = null;
  private onClose: () => void = () => undefined;
  private onHideTips: () => void = () => undefined;

  constructor() {
    this.host = document.createElement("pathix-what-changed");
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
    this.render([element("p", "headline", message)], null);
  }

  showChanges(model: WhatChangedModel): void {
    const body: HTMLElement[] = [element("p", "headline", model.headline)];
    if (model.freshness) {
      const line = element("p", "fresh-line");
      line.append(element("span", "live-tag", LIVE_LABEL), document.createTextNode(model.freshness));
      body.push(line);
    }
    for (const group of model.groups) {
      if (group.title) body.push(element("div", "group-title", group.title));
      const list = element("ul", "rows");
      for (const row of group.rows) list.append(rowItem(row));
      body.push(list);
    }
    if (model.note) body.push(element("p", "note", model.note));
    if (model.more) {
      const more = link(model.more.href, model.more.text);
      more.className = "more";
      body.push(more);
    }
    if (model.unknowns.length > 0) {
      const unknowns = element("div", "unknowns");
      for (const line of model.unknowns) unknowns.append(element("p", "", line));
      body.push(unknowns);
    }
    this.render(body, model);
  }

  hide(): void {
    this.panel?.remove();
    this.panel = null;
    this.host.remove();
  }

  private render(body: HTMLElement[], model: WhatChangedModel | null): void {
    // Showing a message and then the list replaces the panel, so carry focus
    // across the swap instead of letting it fall to the page.
    // First drawn, focus goes to the close button. Drawn again with focus inside (the answer
    // arrived, or a sign-out asked again), it goes to the heading, never back to the close button.
    const first = this.panel === null;
    const hadFocus = !first && this.root.activeElement !== null && this.panel!.contains(this.root.activeElement);
    this.panel?.remove();
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const panel = element("div", "panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Pathix: what changed on this table");

    const head = element("div", "head");
    const titleRow = element("div", "title-row");
    if (model?.mode === "lite") titleRow.append(element("span", "chip", "Lite"));
    const heading = element("span", "title", "What changed on this table");
    heading.tabIndex = -1;
    titleRow.append(heading);
    const infoPanel = element("div", "info");
    infoPanel.hidden = true;
    if (model) {
      for (const line of model.info) infoPanel.append(element("p", "", line));
      const toggle = iconButton("?", "What the change list shows");
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        infoPanel.hidden = !infoPanel.hidden;
        toggle.setAttribute("aria-expanded", String(!infoPanel.hidden));
      });
      titleRow.append(toggle);
    }
    const close = iconButton("×", "Close what changed");
    close.addEventListener("click", () => this.onClose());
    titleRow.append(close);
    head.append(titleRow);
    if (model) {
      const subtitle = element("div", "subtitle");
      subtitle.append(element("span", "", model.table), element("span", "as-of", model.status));
      head.append(subtitle);
    }

    const scroll = element("div", "scroll");
    scroll.append(infoPanel, ...body);
    panel.append(head, scroll, this.footer(model));
    this.root.append(panel);
    this.panel = panel;
    if (first) close.focus();
    else if (hadFocus) heading.focus();
  }

  // The one footer line. In Lite it says what the list cannot see and what
  // Pathix does, the word "Pathix" the link, with a button that turns tips off
  // for good. When connected it links to the full ledger.
  private footer(model: WhatChangedModel | null): HTMLElement {
    const foot = element("div", "foot");
    const tip = model?.tip ?? null;
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
    } else if (model?.openUrl) {
      const text = element("p", "tip");
      text.append(link(model.openUrl, "Open this table's changes in Pathix"));
      foot.append(text);
    } else {
      foot.append(element("span", ""));
    }
    foot.append(pathixMark());
    return foot;
  }
}

export function rowItem(row: ChangeRow): HTMLElement {
  const item = element("li", "change");
  const line = element("div", "line");
  if (row.kind) line.append(kindChip(row.kind, row.kindLabel, row.colorType));
  line.append(element("span", "name", row.text));
  for (const tag of row.tags) line.append(element("span", "tag", tag));
  if (row.changedSinceScan) {
    line.append(changedBadge(CHANGED_BADGE, row.colorType === "Form"));
  }
  item.append(line, element("div", "what", row.detail));
  return item;
}
