// Turns X-ray mode on and off and keeps it in step with the form.
//
// Switched by the toolbar popup or toggled by the toggle-xray keyboard
// command, relayed by the service worker (no page key handler). While
// on, a new form re-runs it; edits on the same form do not, since they change
// no writers. The counts are written into the form as one line under each
// label (xray-lines.ts), which watches the form itself and puts a line back
// when the form re-renders, including when a tab's fields first appear.
//
// X-ray is connected-only: the counts are Pathix's. In Lite there is no Pathix
// to ask, and the panel says so. No line is written.

import type { FormSnapshot } from "../bridge/messages";
import { unmarkedLine, XRAY_LEGEND, type XrayModel } from "../card/xray";
import { NO_ANSWER, stateForConnection, stateLine } from "../card/states";
import type { XrayRequest, XrayResponse } from "../runtime/messages";
import type { XrayLines } from "./xray-lines";
import type { XrayView } from "./xray-view";

export class XrayController {
  private on = false;
  private snapshot: FormSnapshot | null = null;
  /** The form id the page reported: it alone scopes which fields get a line (form-scope.ts). */
  private pageFormId: string | null = null;
  private formKey = "";
  private request = 0;

  constructor(
    private readonly view: XrayView,
    private readonly lines: XrayLines,
    private readonly fetchXray: (request: XrayRequest) => Promise<XrayResponse | undefined>,
  ) {
    view.setOnClose(() => this.turnOff());
    // A field with no place for its line is said in the panel, never left silent.
    lines.setOnUnmarked((count) => view.setNote(count > 0 ? unmarkedLine(count) : null));
  }

  /** The keyboard command (toggle-xray, relayed by the service worker). */
  toggle(): void {
    if (this.on) this.turnOff();
    else this.turnOn();
  }

  /** Whether X-ray is on, for the toolbar popup's switch. */
  get isOn(): boolean {
    return this.on;
  }

  /**
   * The user signed out, or the Pathix address changed: the lines on the form
   * are Pathix's, so they come off now. An X-ray that is on asks again, and
   * its panel says what the connection is now (for example, not signed in).
   */
  reset(): void {
    if (!this.on) return;
    this.request++;
    this.lines.clear();
    void this.run();
  }

  /** The toolbar popup's switch: turns X-ray on or off, the same way the keyboard command's toggle() does. */
  setOn(on: boolean): void {
    if (on !== this.on) this.toggle();
  }

  setSnapshot(snapshot: FormSnapshot | null, pageFormId: string | null = snapshot?.formId ?? null): void {
    this.snapshot = snapshot;
    this.pageFormId = pageFormId;
    // The page's own form id is in the key too: it decides which fields get a
    // line, and can arrive later than an id read from the labels that equals it.
    const key = snapshot ? `${formKeyOf(snapshot)}|${pageFormId}` : "";
    if (key === this.formKey) return;
    this.formKey = key;
    if (this.on) void this.run();
  }

  private turnOn(): void {
    this.on = true;
    void this.run();
  }

  /** Removes the panel and every line from the page. */
  private turnOff(): void {
    this.on = false;
    this.request++;
    this.lines.clear();
    this.view.hide();
  }

  private async run(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.lines.clear();
      this.view.showMessage("Open a record form to see the X-ray.");
      return;
    }

    const request = ++this.request;
    this.lines.clear();
    this.view.showMessage("Loading the X-ray from Pathix…");
    let response: XrayResponse | undefined;
    try {
      response = await this.fetchXray({
        kind: "xray",
        organizationId: snapshot.organizationId,
        host: snapshot.host,
        table: snapshot.table,
        columns: [...new Set(snapshot.columns.map((entry) => entry.column))],
      });
    } catch {
      response = undefined;
    }
    if (request !== this.request || !this.on) return;

    if (response?.kind === "xray") {
      this.draw(response.model, snapshot);
    } else {
      const state = response?.kind === "status" ? stateForConnection(response.status) : null;
      this.view.showMessage(stateLine(state ?? NO_ANSWER));
    }
  }

  private draw(model: XrayModel, snapshot: FormSnapshot): void {
    const byColumn = new Map(model.entries.map((entry) => [entry.column, entry]));
    this.lines.show(
      snapshot.columns.flatMap(({ control, column }) => {
        const entry = byColumn.get(column);
        return entry ? [{ control, entry }] : [];
      }),
      this.pageFormId,
    );
    this.view.showLegend(model.scopeLine, XRAY_LEGEND);
  }
}

function formKeyOf(snapshot: FormSnapshot): string {
  return `${snapshot.organizationId}|${snapshot.table}|${snapshot.formId}|${snapshot.columns.map((c) => c.control).join(",")}`;
}
