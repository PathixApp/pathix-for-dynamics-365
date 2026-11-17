// What the toolbar popup says and which of its controls work, from the active
// tab's answers and the stored mode. No DOM here, so the words and the enabled
// states are tested without a page (test/popup.test.ts).
//
// The tab answers in two parts. The form state (is a record form open, is
// X-ray on) comes at once from the content script's own state. The mode is
// read fresh from storage each time the popup opens, so adding or removing a
// Pathix address shows without reloading the tab. The
// connection status can wait on Pathix (a silent sign-in, then its reads), so
// it comes separately; until it does, only the connection line says
// "Checking Pathix…". The form actions never wait on it.
//
// The connection words are the ones the cards and the badge already use
// (card/states.ts, runtime/badge.ts, options/connection-view.ts). The popup
// adds only the lines about the form section.

import { isDynamicsOrgHost } from "../bridge/org-host";
import { stateForConnection } from "../card/states";
import { scanAgeLine } from "../runtime/badge";
import type { CardMode } from "../runtime/card-settings";
import type { CommandName } from "../runtime/commands";
import type { ConnectionStatus, FormState, OpenFeatureCommand } from "../runtime/messages";
import { modeLine, type Tone } from "../options/connection-view";

/** Where the tab's connection status stands. */
export type ConnectionCheck =
  | { kind: "checking" }
  | { kind: "answered"; status: ConnectionStatus | null }
  /** The tab did not answer within the popup's bound. */
  | { kind: "timedOut" };

/**
 * What the popup knows about the active tab without asking it: a Dynamics 365
 * page (its content script should be there), another page, or unknown (the
 * browser did not tell the popup the tab's address).
 */
export type TabKind = "dynamics" | "other" | "unknown";

export interface PopupInput {
  /** The active tab's content script's answer; null when the tab has none or it did not answer. */
  formState: FormState | null;
  connection: ConnectionCheck;
  tab: TabKind;
  /** The mode, read fresh from extension storage when the popup opens; null when storage could not be read. */
  storedMode: CardMode | null;
  pathixUrl: string | null;
  now: number;
  /** Each command's current key, from chrome.commands.getAll(); null or missing when it has none. */
  bindings: Partial<Record<CommandName, string | null>>;
}

export interface ConnectionView {
  heading: string;
  detail: string | null;
  tone: Tone;
  /** Offer a button that opens the options page: the fix is there. */
  openOptions: boolean;
}

export interface ActionView {
  command: OpenFeatureCommand["kind"];
  label: string;
  /** The key the browser has for it now, or null when the user has none set. */
  shortcut: string | null;
  enabled: boolean;
  /** Why it is off when a form is open, in words. */
  reason: string | null;
}

export interface FormView {
  enabled: boolean;
  /** One line under the section: why its controls are off, or what they need. */
  note: string | null;
  xray: { on: boolean; enabled: boolean; shortcut: string | null; reason: string | null };
  actions: ActionView[];
}

export interface PopupView {
  connection: ConnectionView;
  form: FormView;
}

export const NO_FORM_NOTE = "Open a Dynamics 365 record form to use these.";
/** The tab is a Dynamics 365 page but its content script did not answer: the extension was reloaded or updated under it. */
export const RELOAD_NOTE = "Reload this page to use Pathix on it.";
/** The popup could not tell which kind of page this is, so it says both. */
export const NO_FORM_OR_RELOAD_NOTE =
  "Open a Dynamics 365 record form to use these. If one is open, reload the page. US Government (GCC High and DoD) and China clouds are not supported yet.";
/** In Lite, on X-ray and Save preview: what they use, never an upgrade nudge. */
export const USES_PATHIX = "Uses your organization's Pathix";
export const LITE_NOTE = "X-ray and Save preview use your organization's Pathix. Set its address in Options.";
/** The button that opens the hover card from the keyboard or a screen reader: no hover needed. */
export const FIELD_CARD_LABEL = "Card for the selected field";
/** The page answered that no field on the form has focus, so no card opened. */
export const NO_FIELD_SELECTED = "No field on the form is selected. Click a field or move to it with Tab, then try again.";
/** The page answered that the field with focus has no column on this form, so it has no card. */
export const NO_CARD_FOR_FIELD = "The selected field has no card. Pick another field.";
/** Shown in place of a key the browser has none for. */
export const NO_SHORTCUT = "No shortcut";
export const CHECKING_PATHIX = "Checking Pathix…";
export const PATHIX_TIMED_OUT = "Pathix did not answer in time. Open this window again to check.";
export const SETTINGS_UNREADABLE = "The extension could not read its settings";
export const SETTINGS_UNREADABLE_DETAIL = "Lite or connected is unknown. Close this window and open it again.";
const NO_FORM_CONNECTION = "Open a Dynamics 365 record form to see its environment and scan.";
const NO_ANSWER_DETAIL = "The extension did not answer for this form. Reload the page and try again.";

export function popupView(input: PopupInput): PopupView {
  const mode = input.storedMode;
  return { connection: connectionView(input, mode), form: formView(input, mode) };
}

/** The words under a control: why it is off, else its key, else that it has none. */
export function secondaryText(shortcut: string | null, reason: string | null = null): string {
  return reason ?? shortcut ?? NO_SHORTCUT;
}

/** A tab's kind from its address, read for the host only. Undefined: the browser did not say. */
export function tabKindOf(url: string | undefined): TabKind {
  if (url === undefined || url === "") return "unknown";
  try {
    const { protocol, hostname } = new URL(url);
    // The hosts the content script acts on: a Dynamics 365 org (src/bridge/org-host.ts), not every dynamics.com page.
    return protocol === "https:" && isDynamicsOrgHost(hostname) ? "dynamics" : "other";
  } catch {
    return "unknown";
  }
}

function connectionView(input: PopupInput, mode: CardMode | null): ConnectionView {
  // Unknown, never guessed: the form's actions still work, and their panels say what they need.
  if (mode === null) return { heading: SETTINGS_UNREADABLE, detail: SETTINGS_UNREADABLE_DETAIL, tone: "error", openOptions: false };
  if (mode === "lite") return { heading: modeLine("lite", null), detail: null, tone: "neutral", openOptions: false };

  const heading = modeLine("connected", input.pathixUrl);
  if (input.formState?.form !== true) return neutral(heading, NO_FORM_CONNECTION);
  const check = input.connection;
  if (check.kind === "checking") return neutral(heading, CHECKING_PATHIX);
  if (check.kind === "timedOut") return neutral(heading, PATHIX_TIMED_OUT);
  const status = check.status;
  if (status === null) return neutral(heading, NO_ANSWER_DETAIL);
  if (status.kind === "connected" && status.latestCompletedScanAt !== null) {
    return {
      heading: `Connected to ${status.environmentName}`,
      detail: scanAgeLine(status.latestCompletedScanAt, input.now),
      tone: "ok",
      openOptions: false,
    };
  }
  // Every other status has a card state; "connected" with no scan is "No Completed scan yet".
  const state = stateForConnection(status)!;
  const tone = state.kind === "unauthorized" || state.kind === "pathixUnreachable" ? "error" : "neutral";
  return { heading: state.title, detail: state.text, tone, openOptions: state.action === "openOptions" };
}

function neutral(heading: string, detail: string): ConnectionView {
  return { heading, detail, tone: "neutral", openOptions: false };
}

function formView(input: PopupInput, mode: CardMode | null): FormView {
  const { formState, bindings } = input;
  const enabled = formState?.form === true;
  const lite = mode === "lite";
  const key = (command: CommandName) => bindings[command] ?? null;
  const xrayOn = enabled && formState?.xray === true;
  return {
    enabled,
    note: enabled ? (lite ? LITE_NOTE : null) : noFormNote(formState, input.tab),
    xray: {
      on: xrayOn,
      // X-ray is Pathix's answer. In Lite the switch is off, but stays usable to turn off an X-ray already on.
      enabled: enabled && (!lite || xrayOn),
      shortcut: key("toggle-xray"),
      reason: lite ? USES_PATHIX : null,
    },
    actions: [
      { command: "openEventMap", label: "Event map", shortcut: key("open-event-map"), enabled, reason: null },
      { command: "openWhatChanged", label: "What changed", shortcut: key("open-what-changed"), enabled, reason: null },
      {
        command: "openSavePreview",
        label: "Save preview",
        shortcut: key("open-save-preview"),
        // Save preview is Pathix's answer; in Lite the panel would only say so.
        enabled: enabled && !lite,
        reason: lite ? USES_PATHIX : null,
      },
      // The card works in both modes, for the field that has focus on the form.
      { command: "openFieldCard", label: FIELD_CARD_LABEL, shortcut: key("open-field-card"), enabled, reason: null },
    ],
  };
}

function noFormNote(formState: FormState | null, tab: TabKind): string {
  // The content script answered: this D365 page has no record form open.
  if (formState !== null) return NO_FORM_NOTE;
  if (tab === "dynamics") return RELOAD_NOTE;
  if (tab === "other") return NO_FORM_NOTE;
  return NO_FORM_OR_RELOAD_NOTE;
}
