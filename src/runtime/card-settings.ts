// Which mode the cards are in, and whether Lite cards carry their tip line.
//
// - No Pathix address saved means Lite. Saving one on the options page moves
//   to connected cards; removing it moves back. Nothing is reinstalled.
// - The tip line is off when the user turns it off (on the options page or
//   from the card), or when the organization's policy turns it off for
//   everyone. The policy is chrome.storage.managed, declared by
//   managed_schema.json; a user cannot turn it back on.
//
// The content script cannot read extension storage (test/page-source.test.ts),
// so it asks the service worker, which answers from these functions.

export type CardMode = "lite" | "connected";

export interface CardSettings {
  mode: CardMode;
  showTips: boolean;
}

/** chrome.storage.local, set by the user. */
export const LOCAL_HIDE_TIPS_KEY = "hideTips";
/** chrome.storage.managed, set by the organization. Must match static/managed_schema.json. */
export const POLICY_HIDE_TIPS_KEY = "hideTips";

export const SETTINGS_KEYS = ["pathixUrl", LOCAL_HIDE_TIPS_KEY] as const;

export function modeFor(local: Record<string, unknown>): CardMode {
  return typeof local.pathixUrl === "string" && local.pathixUrl !== "" ? "connected" : "lite";
}

export function tipsHiddenByPolicy(managed: Record<string, unknown>): boolean {
  return managed[POLICY_HIDE_TIPS_KEY] === true;
}

export function cardSettingsFrom(local: Record<string, unknown>, managed: Record<string, unknown>): CardSettings {
  return {
    mode: modeFor(local),
    showTips: local[LOCAL_HIDE_TIPS_KEY] !== true && !tipsHiddenByPolicy(managed),
  };
}

/** Content script to service worker: "which card do I show, and with a tip?" */
export interface CardSettingsRequest {
  kind: "cardSettings";
}

/** Content script to service worker: the user dismissed the tip line for good. */
export interface HideTipsRequest {
  kind: "hideTips";
}

/** Content script to service worker: a card's "Open options" button. */
export interface OpenOptionsRequest {
  kind: "openOptions";
}

export function isOpenOptionsRequest(value: unknown): value is OpenOptionsRequest {
  return isOnlyKind(value, "openOptions");
}

export function isCardSettingsRequest(value: unknown): value is CardSettingsRequest {
  return isOnlyKind(value, "cardSettings");
}

export function isHideTipsRequest(value: unknown): value is HideTipsRequest {
  return isOnlyKind(value, "hideTips");
}

export function isCardSettings(value: unknown): value is CardSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (settings.mode === "lite" || settings.mode === "connected") && typeof settings.showTips === "boolean";
}

function isOnlyKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1 && (value as { kind?: unknown }).kind === kind;
}
