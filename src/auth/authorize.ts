// The Entra authorization-code + PKCE request: building the authorize URL,
// reading the redirect it comes back on, and redeeming the code.
//
// No refresh token is requested (no `offline_access`): when the access token
// expires, the service worker re-runs this flow silently against the user's
// Entra session instead of holding a long-lived credential.
//
// A redeemed token is kept only when it grants Pathix.Read and nothing else.
// Entra can put every consented scope for the resource in the token, so a
// registration that was once consented for Pathix.Access could hand back a
// broader token than the extension asked for.

import { entraTenantOf } from "./authority";
import { grantedScopes } from "./claims";

/** The one scope a token the extension keeps may grant. */
export const READ_SCOPE_NAME = "Pathix.Read";

/**
 * Why a redeemed token is discarded: it grants more than Pathix.Read, or it
 * names no scope at all, which only a misconfigured registration produces.
 */
export type GrantRefusal = "grantsMoreThanRead" | "invalidRegistration";

export interface AuthSettings {
  /** The Pathix the token is for, e.g. https://pathix.contoso.com. A token is never sent to another. */
  pathixUrl: string;
  /** e.g. https://login.microsoftonline.com/<tenant-id>, from Pathix /config `azureAd`. */
  authority: string;
  /** The Pathix Browser Extension app registration, from Pathix /config `extension`. */
  clientId: string;
  /** The read-only api://<api-client-id>/Pathix.Read, from Pathix /config `extension`. Never Pathix.Access. */
  apiScope: string;
  /** chrome.identity.getRedirectURL(): https://<extension-id>.chromiumapp.org/ */
  redirectUri: string;
}

export interface AuthorizeRequest {
  state: string;
  codeChallenge: string;
  /** Silent requests must never show UI; Entra answers with an error instead. */
  silent: boolean;
  /**
   * The confirmed account, sent as login_hint on a silent request only. With
   * several Entra accounts in the browser, prompt=none and no hint answers
   * interaction_required, so every renewal would sign the user out.
   */
  loginHint?: string | null;
}

export function buildAuthorizeUrl(settings: AuthSettings, request: AuthorizeRequest): string {
  const url = new URL(`${entraAuthority(settings)}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", settings.apiScope);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.silent) {
    url.searchParams.set("prompt", "none");
    if (request.loginHint) url.searchParams.set("login_hint", request.loginHint);
  }
  return url.toString();
}

export type RedirectResult =
  | { ok: true; code: string }
  | { ok: false; error: string; description: string | null };

/** Reads the URL Entra redirected to. A state mismatch is treated as an error. */
export function parseRedirect(redirectUrl: string, expectedState: string): RedirectResult {
  const params = new URL(redirectUrl).searchParams;
  const error = params.get("error");
  if (error) return { ok: false, error, description: params.get("error_description") };
  if (params.get("state") !== expectedState) {
    return { ok: false, error: "state_mismatch", description: "The sign-in response did not match the request." };
  }
  const code = params.get("code");
  if (!code) return { ok: false, error: "missing_code", description: null };
  return { ok: true, code };
}

/**
 * A token, and what it was requested for: the Pathix it is sent to, the
 * authority, the client ID and the scope. A cached token is reused only when
 * all four are the same (isTokenFor in ./session.ts).
 */
export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  pathixUrl: string;
  authority: string;
  clientId: string;
  scope: string;
}

/** Why a token cannot be kept, or null when it grants Pathix.Read and nothing else. */
export function grantRefusal(jwt: string): GrantRefusal | null {
  const scopes = grantedScopes(jwt);
  if (scopes.some((scope) => scope !== READ_SCOPE_NAME)) return "grantsMoreThanRead";
  return scopes.includes(READ_SCOPE_NAME) ? null : "invalidRegistration";
}

/** How long Entra's token endpoint may take to redeem a code, its answer and its body together. */
export const ENTRA_TIMEOUT_MS = 15_000;

/** Why a sign-in failed when Entra's token endpoint did not answer within ENTRA_TIMEOUT_MS. */
export const ENTRA_TIMEOUT_TEXT = "Microsoft Entra did not answer in time.";

/**
 * Redeems the code for a token. A token endpoint that does not answer within
 * ENTRA_TIMEOUT_MS throws a TokenError ("timeout"), which leaves the user
 * signed out with that reason, the same as any failed redemption. The timeout
 * deadline is injected so tests need no real clock.
 */
export async function redeemCode(
  settings: AuthSettings,
  code: string,
  codeVerifier: string,
  fetchFn: typeof fetch,
  now: () => number,
  timeout: () => AbortSignal = () => AbortSignal.timeout(ENTRA_TIMEOUT_MS),
): Promise<AccessToken> {
  const body = new URLSearchParams({
    client_id: settings.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    code_verifier: codeVerifier,
    scope: settings.apiScope,
  });
  const deadline = timeout();
  let payload: Record<string, unknown>;
  let response: Response;
  try {
    response = await fetchFn(`${entraAuthority(settings)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: deadline,
    });
    payload = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (deadline.aborted) throw new TokenError("timeout", ENTRA_TIMEOUT_TEXT);
    throw error;
  }
  if (!response.ok || typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    throw new TokenError(error, typeof payload.error_description === "string" ? payload.error_description : null);
  }
  // Checked before anything keeps the token: a refused one is dropped here.
  const refusal = grantRefusal(payload.access_token);
  if (refusal) throw new GrantRefusedError(refusal);
  return {
    token: payload.access_token,
    expiresAt: now() + payload.expires_in * 1000,
    pathixUrl: settings.pathixUrl,
    authority: settings.authority,
    clientId: settings.clientId,
    scope: settings.apiScope,
  };
}

export class TokenError extends Error {
  constructor(
    readonly code: string,
    readonly description: string | null,
  ) {
    super(description ?? code);
  }
}

/** Entra granted a token the extension does not keep. Signing in again would not change the grant. */
export class GrantRefusedError extends Error {
  constructor(readonly reason: GrantRefusal) {
    super(`the token Entra granted is refused (${reason})`);
  }
}

/**
 * The settings' authority, checked again where the sign-in uses it: an Entra
 * cloud's sign-in host and a tenant GUID (src/auth/authority.ts). /config is
 * checked when it is read; this keeps a code, a verifier or a user from ever
 * reaching another host, whatever path the settings took.
 */
function entraAuthority(settings: AuthSettings): string {
  const authority = trimSlash(settings.authority);
  if (entraTenantOf(authority) === null) throw new Error("The sign-in authority is not a Microsoft Entra sign-in address.");
  return authority;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
