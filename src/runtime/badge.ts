// The toolbar icon's badge: how old the environment's latest Completed scan
// is, with the environment's name in the tooltip. It is set on the tab of a
// D365 form that is connected to Pathix, and cleared everywhere else. It is
// the toolbar's own state (chrome.action needs no permission), never a banner
// or a mark on the page.
//
// Lite shows nothing: it has no scan to age and no environment name from
// Pathix (it would take another Dataverse read to get the org's name), and a
// "Lite" badge would only be a nudge. Absence is not evidence: a scan age that
// cannot be read is "?", never "0d".

import { scanAgeBadge, scanAgeWords } from "./dates";
import type { ConnectionStatus } from "./messages";

export interface BadgeState {
  /** At most four characters. */
  text: string;
  title: string;
}

/** The badge for a tab's connection status; null means no badge: clear it. */
export function badgeFor(status: ConnectionStatus, now: number = Date.now()): BadgeState | null {
  if (status.kind !== "connected") return null;
  const { environmentName, latestCompletedScanAt } = status;
  return {
    text: scanAgeBadge(latestCompletedScanAt, now),
    title: `Pathix: ${environmentName}\n${scanAgeLine(latestCompletedScanAt, now, status.latestCompletedScanUnknown === true)}\n${CLICK_LINE}`,
  };
}

/** The tooltip's last line: what a click on the button does. */
export const CLICK_LINE = "Click for X-ray, the event map and more.";

/**
 * The scan's age as a sentence, for the tooltip and the toolbar popup: "Latest
 * Completed scan 3 days ago". With no scan date, "unknown" when Pathix's list
 * was at its cap (one may be older than the list), never "no Completed scan yet".
 */
export function scanAgeLine(latestCompletedScanAt: string | null, now: number = Date.now(), unknown = false): string {
  if (latestCompletedScanAt !== null) return `Latest Completed scan ${scanAgeWords(latestCompletedScanAt, now)}`;
  return unknown ? "Latest Completed scan unknown" : "No Completed scan yet";
}

/** The toolbar calls the badge uses, so a test can stand in for chrome.action. */
export interface BadgeDeps {
  setText(tabId: number, text: string): Promise<unknown>;
  setTitle(tabId: number, title: string): Promise<unknown>;
  /** The title the button has with no badge. */
  defaultTitle: string;
}

/**
 * Sets and clears the badge per tab. Every snapshot rewrites it, with no
 * "unchanged" shortcut: Chrome can clear a tab's badge on its own (a page
 * move), and a refresh must then put it back. Two toolbar calls per form edit
 * cost nothing, and there is no per-tab state to prune when a tab closes.
 */
export class TabBadges {
  constructor(private readonly deps: BadgeDeps) {}

  /** Sets or clears one tab's badge from its connection status. A tab that is gone is not an error. */
  async apply(tabId: number | undefined, status: ConnectionStatus, now: number = Date.now()): Promise<void> {
    if (tabId === undefined) return;
    const badge = badgeFor(status, now);
    try {
      await Promise.all([
        this.deps.setText(tabId, badge?.text ?? ""),
        this.deps.setTitle(tabId, badge?.title ?? this.deps.defaultTitle),
      ]);
    } catch {
      // The tab closed between the snapshot and the call.
    }
  }

  /** The tab loaded a new page, which starts with no badge. */
  async reset(tabId: number): Promise<void> {
    await this.apply(tabId, { kind: "notConfigured" });
  }

  /** Clears the badge on every tab: sign-out, or a new Pathix address. */
  async clearAll(tabIds: number[]): Promise<void> {
    await Promise.all(tabIds.map((tabId) => this.reset(tabId)));
  }
}
