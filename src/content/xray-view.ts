// Draws X-ray's panel: the scope line, what the letters mean, and a close
// button, or a one-line message while loading or when Pathix cannot answer.
// The counts themselves are written into the form by XrayLines
// (xray-lines.ts); this panel is fixed to the viewport, in one closed shadow
// root. Text goes in through textContent only (see the card's fitness rule).

const STYLE = `
:host { all: initial; }
.legend {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483645; max-width: 340px; box-sizing: border-box;
  background: #ffffff; color: #1b1f24; border: 1px solid #c8ced6; border-radius: 8px; padding: 10px 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); font: 12px/1.45 "Segoe UI", system-ui, sans-serif;
}
.legend-top { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.legend-top span { flex: 1; }
.legend p { margin: 4px 0; }
.muted { color: #57606a; }
.close { border: 0; background: transparent; color: #57606a; font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; }
.close:focus-visible { outline: 2px solid #0b5cad; outline-offset: 2px; }
`;

export class XrayView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private legend: HTMLElement | null = null;
  private onClose: () => void = () => undefined;
  private noteText: string | null = null;
  private noteElement: HTMLElement | null = null;

  constructor() {
    this.host = document.createElement("pathix-xray");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
  }

  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }

  /** Shows the panel with a message only, while loading or when Pathix cannot answer. */
  showMessage(message: string): void {
    this.mount();
    this.renderLegend([message]);
  }

  showLegend(scopeLine: string, legendLines: string[]): void {
    this.mount();
    this.renderLegend([scopeLine, ...legendLines]);
  }

  hide(): void {
    this.legend?.remove();
    this.legend = null;
    this.noteElement = null;
    this.noteText = null;
    this.host.remove();
  }

  /** One more line under the legend, for what the counts left out; null removes it. Kept across a redraw. */
  setNote(text: string | null): void {
    this.noteText = text;
    this.renderNote();
  }

  private renderNote(): void {
    this.noteElement?.remove();
    this.noteElement = null;
    if (!this.legend || this.noteText === null) return;
    const note = document.createElement("p");
    note.className = "note";
    note.setAttribute("role", "status");
    note.textContent = this.noteText;
    this.legend.append(note);
    this.noteElement = note;
  }

  private mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  private renderLegend(lines: string[]): void {
    this.legend?.remove();
    const legend = document.createElement("div");
    legend.className = "legend";
    legend.setAttribute("role", "region");
    legend.setAttribute("aria-label", "Pathix X-ray legend");

    const top = document.createElement("div");
    top.className = "legend-top";
    const title = document.createElement("span");
    title.textContent = "Pathix X-ray";
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Turn off X-ray");
    close.textContent = "×";
    close.addEventListener("click", () => this.onClose());
    top.append(title, close);
    legend.append(top);

    lines.forEach((line, index) => {
      const paragraph = document.createElement("p");
      if (index > 0) paragraph.className = "muted";
      paragraph.textContent = line;
      legend.append(paragraph);
    });
    this.root.append(legend);
    this.legend = legend;
    this.renderNote();
  }
}
