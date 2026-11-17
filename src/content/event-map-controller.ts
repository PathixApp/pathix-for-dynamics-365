// Opens and closes the form event map and keeps it in step with the form.
//
// The toolbar popup or a keyboard command opens it (open()); Escape or the
// close button closes it. Keys are manifest commands, never page key handlers. While it is
// open, a different form re-runs it. Edits on the same form do not, since
// they change no handlers.
//
// In Lite the map reads the form's definition from Dataverse. When connected
// it asks the service worker for the handlers in Pathix's latest Completed
// scan, keyed by the form's id. Only the organization, host, table and form
// id leave the page's snapshot; no value is read.

import type { FormSnapshot } from "../bridge/messages";
import { FORM_FROM_LABELS, type EventMapContext, type EventMapModel } from "../card/event-map";
import { NO_ANSWER, stateForConnection, stateLine } from "../card/states";
import type { CardSettings } from "../runtime/card-settings";
import type { EventMapRequest, EventMapResponse } from "../runtime/messages";
import type { EventMapView } from "./event-map-view";

export interface EventMapSources {
  settings(): Promise<CardSettings | undefined>;
  /** Lite: the form's definition, read from Dataverse. */
  load(context: EventMapContext): Promise<EventMapModel>;
  /** Connected: the handlers in Pathix's latest scan, through the service worker. */
  connectedMap(request: EventMapRequest): Promise<EventMapResponse | undefined>;
  hideTips(): Promise<void>;
}

export class EventMapController {
  private on = false;
  /** The mode the panel last answered in: a Lite panel holds no Pathix answer, so a sign-out leaves it alone. */
  private lastMode: CardSettings["mode"] | null = null;
  private snapshot: FormSnapshot | null = null;
  /** The form id the page reported; the snapshot's may have been read from the labels instead. */
  private pageFormId: string | null = null;
  private formKey = "";
  private request = 0;

  constructor(
    private readonly view: EventMapView,
    private readonly sources: EventMapSources,
  ) {
    view.setOnClose(() => this.turnOff());
    view.setOnHideTips(() => void this.sources.hideTips().catch(() => undefined));
  }

  attach(): void {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") this.close();
      },
      { capture: true },
    );
  }

  /**
   * Opens the panel, or leaves it open: the toolbar popup's button and the
   * keyboard command both call this (DESIGN.md, "Entry points").
   */
  open(): void {
    if (!this.on) this.turnOn();
  }

  /** Closes the panel, as Escape and its close button do. */
  close(): void {
    if (this.on) this.turnOff();
  }

  /**
   * The user signed out, or the Pathix address changed: an open panel asks
   * again, so it never keeps showing what Pathix answered before.
   */
  reset(): void {
    if (this.on && this.lastMode !== "lite") void this.run();
  }

  /**
   * `pageFormId` is the form id the page reported. When the snapshot's differs,
   * it was read from the field labels, and the map says so. It defaults to the
   * snapshot's.
   */
  setSnapshot(snapshot: FormSnapshot | null, pageFormId: string | null = snapshot?.formId ?? null): void {
    this.snapshot = snapshot;
    this.pageFormId = pageFormId;
    const key = snapshot ? `${snapshot.organizationId}|${snapshot.table}|${snapshot.formId}` : "";
    if (key === this.formKey) return;
    this.formKey = key;
    if (this.on) void this.run();
  }

  private turnOn(): void {
    this.on = true;
    void this.run();
  }

  private turnOff(): void {
    this.on = false;
    this.request++;
    this.view.hide();
  }

  private async run(): Promise<void> {
    // Take a new request number first, even when there is no form: a read
    // still in flight for the form the user just left must not draw its map.
    const request = ++this.request;
    const current = () => request === this.request && this.on;
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.view.showMessage("Open a record form to see its event map.");
      return;
    }
    const settings = await this.sources.settings().catch(() => undefined);
    if (!current()) return;
    this.lastMode = settings?.mode ?? null;
    // No answer about the mode (for example, the extension was reloaded under
    // this tab) is no answer, as on the card: never a Lite map in a connected install.
    if (!settings) {
      this.view.showMessage(stateLine(NO_ANSWER));
      return;
    }
    if (settings.mode === "connected") {
      await this.runConnected(snapshot, current);
      return;
    }
    await this.runLite(snapshot, settings, current);
  }

  private async runLite(snapshot: FormSnapshot, settings: CardSettings, current: () => boolean): Promise<void> {
    this.view.showMessage("Reading the form's definition from Dataverse…", "lite");
    // The footer line points a Lite user at what Pathix does, only when settings say so.
    const showTips = settings.showTips;
    let model: EventMapModel | undefined;
    try {
      model = await this.sources.load({ table: snapshot.table, formId: snapshot.formId, showTips });
    } catch {
      model = undefined;
    }
    if (!current()) return;
    if (model) this.view.showMap(this.withFormSource(model, snapshot));
    else this.view.showMessage("Could not read this form's definition from Dataverse.", "lite");
  }

  /** The map, noting that its form came from the field labels when the page did not report one. */
  private withFormSource(model: EventMapModel, snapshot: FormSnapshot): EventMapModel {
    const fromLabels = snapshot.formId !== null && snapshot.formId !== this.pageFormId;
    return fromLabels ? { ...model, formSource: FORM_FROM_LABELS } : model;
  }

  private async runConnected(snapshot: FormSnapshot, current: () => boolean): Promise<void> {
    if (!snapshot.formId) {
      this.view.showMessage("The page did not say which form is open, so Pathix could not be asked about its handlers.");
      return;
    }
    this.view.showMessage("Loading from Pathix…");
    const response = await this.sources
      .connectedMap({ kind: "eventMap", organizationId: snapshot.organizationId, host: snapshot.host, table: snapshot.table, formId: snapshot.formId })
      .catch(() => undefined);
    if (!current()) return;
    if (response?.kind === "eventMap") {
      this.view.showMap(this.withFormSource(response.model, snapshot));
      return;
    }
    // No answer is a state of its own, never an empty map.
    const state = response?.kind === "status" ? stateForConnection(response.status) : null;
    this.view.showMessage(stateLine(state ?? NO_ANSWER));
  }
}
