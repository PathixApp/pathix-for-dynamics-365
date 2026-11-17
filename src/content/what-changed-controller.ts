// Opens and closes the "What changed" panel and keeps it in step with the form.
//
// The toolbar popup or a keyboard command opens it (open()); Escape or the
// close button closes it. Keys are manifest commands, never page key handlers. While it is
// open, a different table or form re-runs it. Edits on the same form do not,
// since they change no components.
//
// In Lite the panel reads the table's components and their modified dates
// from Dataverse. When connected it asks the service worker for Pathix's
// change ledger, shows it at once, then reads the live modified date of the
// components in it, from Dataverse, to badge any that changed since the scan
// (the freshness case). Only the table's name leaves the page's
// snapshot, and no value is read.

import type { FormSnapshot } from "../bridge/messages";
import { stateForConnection, stateLine, NO_ANSWER } from "../card/states";
import type { LiveModified, LiveRef } from "../card/freshness";
import {
  applyChangesFreshness,
  liveRefsOfChanges,
  type LiteChangesContext,
  type WhatChangedModel,
} from "../card/what-changed";
import type { CardSettings } from "../runtime/card-settings";
import type { TableChangesRequest, TableChangesResponse } from "../runtime/messages";
import type { WhatChangedView } from "./what-changed-view";

export interface WhatChangedSources {
  settings(): Promise<CardSettings | undefined>;
  liteChanges(context: Omit<LiteChangesContext, "now">): Promise<WhatChangedModel>;
  connectedChanges(request: TableChangesRequest): Promise<TableChangesResponse | undefined>;
  /** The live modified date of each component, from Dataverse. Components it could not read are left out. */
  liveModified(refs: LiveRef[]): Promise<LiveModified>;
  hideTips(): Promise<void>;
}

export class WhatChangedController {
  private on = false;
  /** The mode the panel last answered in: a Lite panel holds no Pathix answer, so a sign-out leaves it alone. */
  private lastMode: CardSettings["mode"] | null = null;
  private snapshot: FormSnapshot | null = null;
  private formKey = "";
  private request = 0;

  constructor(
    private readonly view: WhatChangedView,
    private readonly sources: WhatChangedSources,
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
    // still in flight for the form the user just left must not draw its list.
    const request = ++this.request;
    const current = () => request === this.request && this.on;
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.view.showMessage("Open a record form to see what changed on its table.");
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
      this.view.showMessage("Reading the table's components from Dataverse…");
      // The footer line points a Lite user at what Pathix does, only when settings say so.
      const model = await this.sources.liteChanges({ table: snapshot.table, showTips: settings.showTips }).catch(() => undefined);
      if (!current()) return;
      if (model) this.view.showChanges(model);
      else this.view.showMessage("Could not read this table's components from Dataverse.");
      return;
    }

    this.view.showMessage("Loading from Pathix…");
    const response = await this.sources
      .connectedChanges({ kind: "tableChanges", organizationId: snapshot.organizationId, host: snapshot.host, table: snapshot.table })
      .catch(() => undefined);
    if (!current()) return;
    if (response?.kind !== "changes") {
      const state = response?.kind === "status" ? stateForConnection(response.status) : null;
      this.view.showMessage(stateLine(state ?? NO_ANSWER));
      return;
    }

    // The ledger is Pathix's answer and shows at once. The live check is a
    // second, separate read; when it cannot run, the components are unknown.
    this.view.showChanges(response.model);
    const refs = liveRefsOfChanges(response.model);
    if (refs.length === 0) return;
    const live = await this.sources.liveModified(refs).catch(() => null);
    if (!current()) return;
    this.view.showChanges(applyChangesFreshness(response.model, live));
  }
}
