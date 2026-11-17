// Draws the form event map's panel in one closed shadow root, fixed to the
// viewport, the way X-ray's legend is. Text goes in through textContent only;
// the handler names are customer-authored metadata (see the card's fitness
// rule). The panel holds the headline, the handlers grouped by event, a "?"
// with what the map cannot see, and the one footer line.

import type { EventMapModel, EventMapRow } from "../card/event-map";
import { element, iconButton, link, pathixMark, tipParts } from "./card-view";

export const PANEL_STYLE = `
:host { all: initial; }
.panel {
  position: fixed; top: 56px; right: 16px; z-index: 2147483645; box-sizing: border-box; width: 420px; max-width: calc(100vw - 32px); max-height: 70vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: #ffffff; color: #11161c; border: 1px solid #7e8b99; border-radius: 6px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
  font: 12px/1.45 Geist, "Segoe UI", system-ui, -apple-system, sans-serif;
}
.head { padding: 8px 12px; border-bottom: 1px solid #e6e8eb; }
.title-row { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.title-row .title { flex: 1; min-width: 0; }
.title-row .title:focus { outline: none; }
.title-row .title:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.chip {
  display: inline-flex; align-items: center; height: 16px; padding: 0 4px; border-radius: 2px; flex: none;
  font-size: 9px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; background: #deecf9; color: #004578;
}
.subtitle { margin-top: 2px; display: flex; gap: 6px; color: #4a5560; font: 11px/1.4 "Geist Mono", "Cascadia Mono", Consolas, monospace; }
.subtitle .as-of { margin-left: auto; font: 11px/1.4 Geist, "Segoe UI", system-ui, sans-serif; }
.subtitle .form-source { font: italic 11px/1.4 Geist, "Segoe UI", system-ui, sans-serif; }
.icon-button {
  flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid transparent; border-radius: 9px; background: transparent; color: #4a5560; font: 600 11px/1 Geist, "Segoe UI", sans-serif; cursor: pointer;
}
.icon-button:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.scroll { overflow: auto; }
.headline { padding: 8px 12px 4px; }
.info { margin: 0; padding: 4px 12px 8px; color: #4a5560; }
.info p { margin: 2px 0; }
.group-title { padding: 6px 12px 0; font-weight: 600; }
.rows { margin: 0; padding: 0 12px 4px; list-style: none; }
.row { display: flex; align-items: baseline; gap: 4px; padding: 1px 0; }
.entry { flex: 1; min-width: 0; overflow-wrap: break-word; }
.fn { margin-right: 4px; font: 11px/1.45 "Geist Mono", "Cascadia Mono", Consolas, monospace; }
.lib { margin-right: 4px; color: #4a5560; font-size: 11px; }
.tag { display: inline-block; margin-right: 4px; padding: 0 4px; border-radius: 2px; font-size: 10px; font-weight: 600; background: #f3f2f1; color: #605e5c; }
.tag.off { background: #fff4ce; color: #846904; }
.pos { flex: none; min-width: 1.4em; color: #4a5560; font-size: 11px; }
.order-note { margin: 0; padding: 2px 12px 6px; color: #4a5560; }
.is-off .fn { text-decoration: line-through; color: #4a5560; }
.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none;
  padding: 6px 12px; border-top: 1px solid #e6e8eb; background: #f3f4f6;
}
.tip { flex: 1; min-width: 0; margin: 0; font-size: 11px; color: #4a5560; }
a { color: #0060aa; text-decoration: none; }
a:hover { text-decoration: underline; }
.mark { flex: none; display: block; }
`;

export class EventMapView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private panel: HTMLElement | null = null;
  private onClose: () => void = () => undefined;
  private onHideTips: () => void = () => undefined;

  constructor() {
    this.host = document.createElement("pathix-event-map");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_STYLE;
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

  /** A one-line message while loading or when nothing could be drawn. `mode` is the one answering, when known: a Lite message keeps the Lite chip. */
  showMessage(message: string, mode: EventMapModel["mode"] | null = null): void {
    this.render([element("p", "headline", message)], null, null, null, mode);
  }

  showMap(model: EventMapModel): void {
    const body: HTMLElement[] = [element("p", "headline", model.headline)];
    // The scan did not record the order: say so before the rows, which are then not a sequence.
    if (model.orderNote) body.push(element("p", "order-note", model.orderNote));
    for (const group of model.groups) {
      body.push(element("div", "group-title", group.title));
      const list = element("ul", "rows");
      for (const row of group.rows) list.append(rowItem(row));
      body.push(list);
    }
    this.render(body, model, model.info, model.tip, model.mode);
  }

  hide(): void {
    this.panel?.remove();
    this.panel = null;
    this.host.remove();
  }

  private render(body: HTMLElement[], model: EventMapModel | null, info: string[] | null, tip: EventMapModel["tip"], mode: EventMapModel["mode"] | null): void {
    // Showing a message and then the map replaces the panel, so carry focus
    // across the swap instead of letting it fall to the page.
    // First drawn, focus goes to the close button. Drawn again with focus inside (the answer
    // arrived, or a sign-out asked again), it goes to the heading, never back to the close button.
    const first = this.panel === null;
    const hadFocus = !first && this.root.activeElement !== null && this.panel!.contains(this.root.activeElement);
    this.panel?.remove();
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const panel = element("div", "panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Pathix form event map");

    const head = element("div", "head");
    const titleRow = element("div", "title-row");
    if (mode === "lite") titleRow.append(element("span", "chip", "Lite"));
    const heading = element("span", "title", "Form event map");
    heading.tabIndex = -1;
    titleRow.append(heading);
    const infoPanel = element("div", "info");
    infoPanel.hidden = true;
    if (info) {
      for (const line of info) infoPanel.append(element("p", "", line));
      const toggle = iconButton("?", "What the form event map shows");
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        infoPanel.hidden = !infoPanel.hidden;
        toggle.setAttribute("aria-expanded", String(!infoPanel.hidden));
      });
      titleRow.append(toggle);
    }
    const close = iconButton("×", "Close the form event map");
    close.addEventListener("click", () => this.onClose());
    titleRow.append(close);
    head.append(titleRow);
    if (model) {
      const subtitle = element("div", "subtitle");
      subtitle.append(element("span", "", model.formName ? `${model.table} · ${model.formName}` : model.table));
      if (model.formSource) subtitle.append(element("span", "form-source", model.formSource));
      subtitle.append(element("span", "as-of", model.status));
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

  // The one footer line: what the map cannot see and what Pathix does, the
  // word "Pathix" the link, and a button that turns tips off for good.
  private footer(tip: EventMapModel["tip"]): HTMLElement {
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

// The number sits in its own column, so it stays on the first line when a
// long name wraps; the name, library and tags flow in the second.
function rowItem(row: EventMapRow): HTMLElement {
  const item = element("li", row.enabled === false ? "row is-off" : "row");
  if (row.position !== undefined) item.append(element("span", "pos", `${row.position}.`));
  const entry = element("span", "entry");
  entry.append(functionName(row.functionName || "unnamed function"), document.createTextNode(" "));
  if (row.library) entry.append(element("span", "lib", `in ${row.library}`), document.createTextNode(" "));
  if (row.enabled === false) entry.append(element("span", "tag off", "disabled"));
  if (row.enabled === null) entry.append(element("span", "tag off", "enabled not stated"));
  if (row.internal) entry.append(element("span", "tag", "internal"));
  item.append(entry);
  return item;
}

/**
 * A function name that may wrap after each dot and nowhere else:
 * "Contoso.AccountForm.onLoad" breaks between its parts, never inside one.
 * Each part is a text node, with a <wbr> after its dot; no markup from strings.
 */
export function functionName(name: string): HTMLElement {
  const span = element("span", "fn");
  const parts = name.split(/(?<=\.)/);
  parts.forEach((part, index) => {
    span.append(document.createTextNode(part));
    if (index < parts.length - 1) span.append(document.createElement("wbr"));
  });
  return span;
}
