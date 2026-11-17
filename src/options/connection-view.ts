// What the options page says about the Pathix connection and the account, and
// which account buttons it offers. No DOM here, so the copy and the buttons
// are tested without a page (test/options.test.ts).
//
// When a Pathix offers the extension no sign-in, the page says why and what
// to ask for, and offers no Sign in button. For a reason read from /config,
// the service worker asks nothing of Entra. After a grant it refused, it asks
// nothing more until this page reads /config again, the address changes or
// five minutes pass (PathixSignIn in src/background/sign-in.ts).

//
// Before Sign in, the page shows what the user is about to trust: the Pathix
// address, the tenant, where Entra signs them in, and the API. Only that click
// confirms them (src/auth/binding.ts).

import { entraHostOf } from "../auth/authority";
import { apiIdentifier, type BindingChange, type SignInBinding } from "../auth/binding";
import { REDIRECT_TEXT, type AuthConfigResult, type SignInUnavailable } from "../pathix/api";
import type { CardMode } from "../runtime/card-settings";
import type { AccountStatus } from "../runtime/messages";

export type Tone = "ok" | "error" | "neutral";

export interface StatusLine {
  text: string;
  tone: Tone;
}

export interface TrustLine {
  label: string;
  value: string;
}

export interface AccountView {
  line: StatusLine;
  signIn: boolean;
  signOut: boolean;
  /** What Sign in would trust, shown next to the button. Null when there is no Sign in, or nothing to show. */
  trust: TrustLine[] | null;
}

/** The settings Sign in would confirm, as the page lists them. */
export function trustLines(binding: SignInBinding): TrustLine[] {
  return [
    { label: "Pathix address", value: binding.pathixUrl },
    { label: "Tenant ID", value: binding.tenantId },
    { label: "Sign-in host", value: entraHostOf(binding.authority) ?? binding.authority },
    { label: "API", value: apiIdentifier(binding.apiScope) },
  ];
}

const CHANGE_NAMES: Record<BindingChange, string> = {
  tenant: "the tenant",
  signInHost: "the sign-in host",
  client: "the extension's app registration",
  scope: "the API",
};

/** What changed since the user signed in to this address. Sign-in waits for them to check and select Sign in. */
export function changedText(changes: BindingChange[]): string {
  const names = changes.map((change) => CHANGE_NAMES[change]);
  const list = names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Pathix's sign-in settings changed since you signed in: ${list}. Check them below, then select Sign in.`;
}

const UNAVAILABLE: Record<SignInUnavailable, string> = {
  signInOff: "This Pathix does not have Entra sign-in configured. Ask your Pathix administrator to set it up.",
  olderPathix:
    "This Pathix is an older version that does not offer sign-in for the extension. Ask your Pathix administrator to update Pathix.",
  notRegistered: "This Pathix has no browser extension registration. Ask your Pathix administrator to set one up.",
  invalidRegistration: "The extension registration on this Pathix looks wrong. Ask your Pathix administrator to check it.",
  grantsMoreThanRead:
    "The extension registration on this Pathix grants more than read access. Ask your Pathix administrator to remove the other permissions and their consent.",
};

/** Why this Pathix offers the extension no sign-in, and what to ask the administrator for. */
export function signInUnavailableText(reason: SignInUnavailable): string {
  return UNAVAILABLE[reason];
}

/** The line under the address after Save and connect when /config could not be read. */
export function savedErrorLine(message: string): StatusLine {
  if (message === REDIRECT_TEXT) return { text: `Saved. ${REDIRECT_TEXT}`, tone: "error" };
  return { text: `Saved, but Pathix did not answer as expected: ${message}`, tone: "error" };
}

/** The line under the address after Save and connect, from what Pathix's /config said. */
export function savedLine(result: AuthConfigResult): StatusLine {
  if (result.ok) return { text: `Found Pathix. It signs in through tenant ${result.config.tenantId}.`, tone: "ok" };
  return { text: "Saved, but the extension cannot sign in to this Pathix.", tone: "error" };
}

/** The account section: one line, and the buttons that make sense with it. */
export function accountView(status: AccountStatus): AccountView {
  // Offered while a token or a confirmed sign-in is stored, even one the
  // current settings no longer match: Sign out removes both.
  const signOut = status.signedIn || status.signOutOffered;
  if (!status.configured) return { line: neutral("Save your Pathix address first."), signIn: false, signOut, trust: null };
  if (status.signInUnavailable) {
    return { line: { text: signInUnavailableText(status.signInUnavailable), tone: "error" }, signIn: false, signOut, trust: null };
  }
  const signIn = !status.signedIn;
  const trust = signIn && status.offered ? trustLines(status.offered) : null;
  const signedInText = status.signedIn ? `Signed in as ${status.account ?? "an unnamed account"}.` : "Not signed in.";
  // Pathix did not answer: say so, and claim nothing beyond the stored token. Sign in stays as a retry.
  if (status.pathixUnreachable !== null) {
    return { line: { text: `${signedInText} ${unreachableText(status.pathixUnreachable)}`, tone: "error" }, signIn, signOut, trust };
  }
  if (status.error) return { line: { text: `Sign-in did not complete: ${status.error}`, tone: "error" }, signIn, signOut, trust };
  if (status.changed.length > 0) return { line: { text: changedText(status.changed), tone: "error" }, signIn, signOut, trust };
  return { line: { text: signedInText, tone: status.signedIn ? "ok" : "neutral" }, signIn, signOut, trust };
}

/**
 * Pathix did not answer /config, which says nothing about sign-in. A redirect
 * is an answer, so it is said on its own, not as "could not reach Pathix".
 */
export function unreachableText(detail: string): string {
  const text = detail.replace(/\s+/g, " ").trim();
  if (text === REDIRECT_TEXT) return text;
  if (text === "") return "Could not reach Pathix just now.";
  return `Could not reach Pathix just now. Details: ${text}${/[.!?]$/.test(text) ? "" : "."}`;
}

/** Which mode the cards are in, for the options page and the toolbar popup. */
export function modeLine(mode: CardMode, pathixUrl: string | null): string {
  if (mode === "lite") return "Lite mode: cards read Dataverse metadata as you.";
  return pathixUrl ? `Connected mode: cards come from ${pathixUrl}.` : "Connected mode.";
}

function neutral(text: string): StatusLine {
  return { text, tone: "neutral" };
}
