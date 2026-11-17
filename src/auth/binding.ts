// The confirmed sign-in binding: the Pathix address and the Entra settings the
// user agreed to sign in with, by selecting Sign in on the options page after
// it showed them. It is written only when that interactive sign-in succeeds,
// and kept in chrome.storage.local so it outlives a browser restart.
//
// A Pathix's /config is anonymous, so a look-alike address could serve a copy
// of a real organization's settings. Without a binding, the extension would
// sign in silently against them and hand that address a real Pathix.Read
// token. With one, a silent sign-in happens only when what /config says now is
// exactly what the user confirmed; anything new waits for a click.

import { entraHostOf, entraTenantOf } from "./authority";
import { isLoginHint } from "./claims";

export interface SignInBinding {
  pathixUrl: string;
  /** https://<Entra host>/<tenantId> */
  authority: string;
  tenantId: string;
  /** The extension's app registration. */
  clientId: string;
  /** api://<api>/Pathix.Read */
  apiScope: string;
  /**
   * The account the user signed in as when they confirmed, from the token's
   * claims (loginHintClaim). Not part of what is confirmed: sameBinding
   * ignores it. Sent only to Entra, as login_hint on a silent sign-in, so a
   * browser signed in to several Entra accounts renews this one. A binding
   * written by an earlier build has none.
   */
  loginHint?: string;
}

const BINDING_KEYS = ["pathixUrl", "authority", "tenantId", "clientId", "apiScope"];

/** What differs between the binding the user confirmed and what this Pathix's /config says now. */
export type BindingChange = "tenant" | "signInHost" | "client" | "scope";

/** The parts of a sign-in a binding is made from: AuthSettings has them, and so does a stored token (as `scope`). */
export interface BindingSource {
  pathixUrl: string;
  authority: string;
  clientId: string;
  apiScope: string;
}

export function bindingFor(source: BindingSource): SignInBinding {
  const { pathixUrl, authority, clientId, apiScope } = source;
  return { pathixUrl, authority, tenantId: entraTenantOf(authority) ?? "", clientId, apiScope };
}

export function isBinding(value: unknown): value is SignInBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const extra = Object.keys(binding).filter((key) => !BINDING_KEYS.includes(key));
  if (extra.some((key) => key !== "loginHint")) return false;
  if ("loginHint" in binding && !isLoginHint(binding.loginHint)) return false;
  return BINDING_KEYS.every((key) => typeof binding[key] === "string" && binding[key] !== "");
}

/** The binding with the signed-in account's hint, or without one when the token named none. */
export function withLoginHint(binding: SignInBinding, loginHint: string | null): SignInBinding {
  const { loginHint: _previous, ...confirmed } = binding;
  return loginHint ? { ...confirmed, loginHint } : confirmed;
}

/**
 * The account hint to send on a silent sign-in for these settings: the
 * stored binding's, and only when that binding is for exactly these
 * settings, so a hint never goes to another tenant or registration.
 */
export function loginHintOf(stored: unknown, source: BindingSource): string | null {
  if (!isBinding(stored) || !sameBinding(stored, bindingFor(source))) return null;
  return stored.loginHint ?? null;
}

/** The same address, authority, tenant, client and scope. Anything that is not a binding matches nothing. */
export function sameBinding(a: unknown, b: unknown): boolean {
  if (!isBinding(a) || !isBinding(b)) return false;
  return (
    a.pathixUrl === b.pathixUrl &&
    a.authority === b.authority &&
    a.tenantId === b.tenantId &&
    a.clientId === b.clientId &&
    a.apiScope === b.apiScope
  );
}

/**
 * What changed for the same address, or null when the confirmed binding is
 * for another address (or there is none): then nothing was confirmed here.
 */
export function bindingChanges(confirmed: unknown, current: SignInBinding): BindingChange[] | null {
  if (!isBinding(confirmed) || confirmed.pathixUrl !== current.pathixUrl) return null;
  const changes: BindingChange[] = [];
  if (confirmed.tenantId !== current.tenantId) changes.push("tenant");
  if (entraHostOf(confirmed.authority) !== entraHostOf(current.authority)) changes.push("signInHost");
  if (confirmed.clientId !== current.clientId) changes.push("client");
  if (confirmed.apiScope !== current.apiScope) changes.push("scope");
  return changes;
}

/** The API a scope is for: api://<api> without its /Pathix.Read. */
export function apiIdentifier(apiScope: string): string {
  const slash = apiScope.lastIndexOf("/");
  return slash > 0 ? apiScope.slice(0, slash) : apiScope;
}
