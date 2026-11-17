// Empty and error states, one wording for every card and for the X-ray
// legend. Each says what happened and what to do next, in one or two short
// sentences. None of them shows a count: a card that did not get an answer
// never says zero (DESIGN.md, "Absence is not evidence").

import type { ConnectionStatus } from "../runtime/messages";

export type CardStateKind =
  | "notConfigured"
  | "signedOut"
  | "unauthorized"
  | "notScanned"
  | "noCompletedScan"
  | "completedScanUnknown"
  | "pathixUnreachable"
  | "dataverseError"
  | "noAnswer"
  | "extensionUpdated";

export interface CardState {
  kind: CardStateKind;
  title: string;
  text: string;
  /** A fix the user can make from the extension's options page, if there is one. */
  action: "openOptions" | null;
}

const MAX_DETAIL = 160;

/** The state a connection status puts a connected card in, or null when it can show one. */
export function stateForConnection(status: ConnectionStatus): CardState | null {
  switch (status.kind) {
    case "notConfigured":
      return {
        kind: "notConfigured",
        title: "Pathix is not set up",
        text: "Connect to your organization's Pathix in the extension's options.",
        action: "openOptions",
      };
    case "signedOut":
      return {
        kind: "signedOut",
        title: "Signed out of Pathix",
        text: "Sign in from the extension's options to see what Pathix found.",
        action: "openOptions",
      };
    case "unauthorized":
      return {
        kind: "unauthorized",
        title: "Pathix refused your account",
        text: `Pathix answered HTTP ${status.status}. Ask your Pathix administrator to give you access to the Pathix API.`,
        action: null,
      };
    case "notScanned":
      if (status.otherHost) {
        return {
          kind: "notScanned",
          title: "Pathix knows this organization under another address",
          text: `Pathix knows this organization under a different address (${status.otherHost}). The environment's address may have changed since it was added to Pathix. Your Pathix administrator can check it.`,
          action: null,
        };
      }
      if (status.noAddress) {
        return {
          kind: "notScanned",
          title: "Pathix has no address for this environment",
          text: "Pathix lists this organization without an address, so the extension cannot check that this page is that environment. Your Pathix administrator can check it.",
          action: null,
        };
      }
      return {
        kind: "notScanned",
        title: "No matching Pathix environment",
        text: "Pathix has no environment that matches this organization.",
        action: null,
      };
    case "connected":
      if (status.latestCompletedScanAt !== null) return null;
      return status.latestCompletedScanUnknown
        ? {
            kind: "completedScanUnknown",
            title: "Latest Completed scan unknown",
            text: `None of the latest scans Pathix lists for ${status.environmentName} is Completed, so the extension cannot tell which scan Pathix answers from. Check the scans in Pathix.`,
            action: null,
          }
        : {
            kind: "noCompletedScan",
            title: "No Completed scan yet",
            text: `Pathix has not finished a scan of ${status.environmentName} yet. Cards fill in after the first scan completes.`,
            action: null,
          };
    case "error":
      return {
        kind: "pathixUnreachable",
        title: "Could not reach Pathix",
        text: ["Check your connection and try again.", detail(status.message)].filter(Boolean).join(" "),
        action: null,
      };
  }
}

export const DATAVERSE_ERROR: CardState = {
  kind: "dataverseError",
  title: "Could not read Dataverse",
  text: "Reload the page and try again. If it keeps happening, your session may have expired.",
  action: null,
};

export const NO_ANSWER: CardState = {
  kind: "noAnswer",
  title: "The extension did not answer",
  text: "Reload the page and try again.",
  action: null,
};

/**
 * The extension was updated, reloaded or removed while the page was open, so
 * this page's copy of it can no longer reach the extension
 * (src/content/extension-context.ts). It says nothing about the mode or
 * Pathix: neither is known any more.
 */
export const EXTENSION_UPDATED: CardState = {
  kind: "extensionUpdated",
  title: "Pathix was updated",
  text: "Reload this page to use it.",
  action: null,
};

/** One line, for the X-ray legend. */
export function stateLine(state: CardState): string {
  return `${state.title}. ${state.text}`;
}

function detail(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  if (text.length > MAX_DETAIL) return `Details: ${text.slice(0, MAX_DETAIL - 3)}...`;
  return `Details: ${text}${/[.!?]$/.test(text) ? "" : "."}`;
}
