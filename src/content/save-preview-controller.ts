// Opens and closes the save preview and keeps it in step with the form.
//
// The toolbar popup or a keyboard command opens it (open()); Escape or the
// close button closes it. Keys are manifest commands, never page key handlers. While it is
// open, a change to what the save would send re-runs it: a different table or
// form, the form turning from create to update, or a column becoming edited.
// A save preview depends on the dirty set, unlike the event map and "What
// changed", which do not.
//
// Connected mode only. In Lite the panel says so: the order a save runs in is
// Pathix's answer, not Dataverse metadata. Only names leave the page's
// snapshot: the table, create or update, the form's definition id and column
// logical names. No value and no record id are read, and none are sent.

import type { FormSnapshot } from "../bridge/messages";
import { saveColumns, SAVE_PREVIEW_LITE_LINE, SAVE_PREVIEW_TIP } from "../card/save-preview";
import { stateForConnection, stateLine, NO_ANSWER } from "../card/states";
import type { CardSettings } from "../runtime/card-settings";
import type { SavePreviewRequest, SavePreviewResponse } from "../runtime/messages";
import type { SavePreviewView } from "./save-preview-view";

export interface SavePreviewSources {
  settings(): Promise<CardSettings | undefined>;
  savePreview(request: SavePreviewRequest): Promise<SavePreviewResponse | undefined>;
  hideTips(): Promise<void>;
}

export class SavePreviewController {
  private on = false;
  /** The mode the panel last answered in: a Lite panel holds no Pathix answer, so a sign-out leaves it alone. */
  private lastMode: CardSettings["mode"] | null = null;
  private snapshot: FormSnapshot | null = null;
  private inputKey = "";
  private request = 0;

  constructor(
    private readonly view: SavePreviewView,
    private readonly sources: SavePreviewSources,
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

  setSnapshot(snapshot: FormSnapshot | null): void {
    this.snapshot = snapshot;
    const key = inputKeyOf(snapshot);
    if (key === this.inputKey) return;
    this.inputKey = key;
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
    // still in flight for what the user just changed must not draw its answer.
    const request = ++this.request;
    const current = () => request === this.request && this.on;
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.view.showMessage("Open a record form to preview its save.");
      return;
    }
    if (snapshot.saveKind === null) {
      this.view.showMessage("This form is not open for creating or editing a record, or the page did not say, so there is no save to preview.");
      return;
    }
    const settings = await this.sources.settings().catch(() => undefined);
    if (!current()) return;
    this.lastMode = settings?.mode ?? null;
    if (!settings) {
      this.view.showMessage(stateLine(NO_ANSWER));
      return;
    }
    if (settings.mode === "lite") {
      this.view.showLite(SAVE_PREVIEW_LITE_LINE, settings.showTips ? SAVE_PREVIEW_TIP : null);
      return;
    }

    this.view.showMessage("Loading from Pathix…");
    const response = await this.sources.savePreview(requestFor(snapshot, snapshot.saveKind)).catch(() => undefined);
    if (!current()) return;
    if (response?.kind === "savePreview") {
      this.view.showPreview(response.model);
      return;
    }
    const state = response?.kind === "status" ? stateForConnection(response.status) : null;
    this.view.showMessage(stateLine(state ?? NO_ANSWER));
  }
}

/** The names a save would send, and the table and form they go with. Update only; a create sends none. */
function requestFor(snapshot: FormSnapshot, saveKind: "create" | "update"): SavePreviewRequest {
  const update = saveKind === "update";
  return {
    kind: "savePreview",
    organizationId: snapshot.organizationId,
    host: snapshot.host,
    table: snapshot.table,
    message: update ? "Update" : "Create",
    formId: snapshot.formId,
    columns: update ? saveColumns(snapshot.dirtyColumns, snapshot.alwaysSubmitColumns) : [],
  };
}

// What a re-run depends on. On a create the columns do not matter, so edits do not re-run it.
function inputKeyOf(snapshot: FormSnapshot | null): string {
  if (!snapshot) return "";
  const columns = snapshot.saveKind === "update" ? saveColumns(snapshot.dirtyColumns, snapshot.alwaysSubmitColumns).join(",") : "";
  return [snapshot.organizationId, snapshot.table, snapshot.formId, snapshot.saveKind, columns].join("|");
}
