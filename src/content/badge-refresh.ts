// Keeps the toolbar badge's scan age current on a tab that stays open.
//
// The page posts a snapshot only when the form changes. This remembers the last
// form snapshot and re-sends it when the tab comes to the front, every few
// minutes while it is in front, and when the worker or the page's own
// navigation event says the page finished a move. The worker answers from its
// connection cache and rewrites the badge, which also restores one Chrome cleared.
//
// The badge describes the environment, not the form. So a move to a grid or a
// dashboard (no form) keeps the last snapshot, and the age keeps advancing.
// Only a new page load, which starts a fresh content script, drops it. The
// snapshot is the same names-only message the page already sent.
//
// This code never reads the page address (names, never values: the address of
// a record form carries the record id). A move is noticed from events that
// carry no address: the worker's tab update and the Navigation API event.

import type { FormSnapshot, PageMessage } from "../bridge/messages";

export interface BadgeRefreshDeps {
  relay(snapshot: FormSnapshot): void;
  isVisible(): boolean;
}

export class BadgeRefresh {
  private last: FormSnapshot | null = null;

  constructor(private readonly deps: BadgeRefreshDeps) {}

  /** A page message arrived. A noForm message keeps the last form snapshot on purpose. */
  onPageMessage(message: PageMessage): void {
    if (message.kind === "formSnapshot") this.last = message;
  }

  /** Re-sends the last form snapshot when the tab is in front. */
  refresh(): void {
    if (this.last && this.deps.isVisible()) this.deps.relay(this.last);
  }
}
