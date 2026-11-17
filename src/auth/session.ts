// Getting an access token: the cached one if it is still good, else a silent
// sign-in against the user's Entra session, else (only when the user asked,
// from the options page) an interactive sign-in.
//
// Chrome specifics are injected so the decision logic is testable.

import {
  buildAuthorizeUrl,
  GrantRefusedError,
  parseRedirect,
  type AccessToken,
  type AuthSettings,
  type GrantRefusal,
} from "./authorize";
import { codeChallenge, createCodeVerifier, randomUrlSafe } from "./pkce";

/** Why a silent renewal ended signed out: Entra answered for another account in the browser. */
export const OTHER_ACCOUNT_TEXT = "Microsoft Entra answered for a different account. Sign in again on the options page.";

/** Renew this long before expiry, so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

export interface TokenDeps {
  /** Opens the authorize URL; resolves with the URL Entra redirected to. */
  launch(url: string, interactive: boolean): Promise<string>;
  redeem(settings: AuthSettings, code: string, codeVerifier: string): Promise<AccessToken>;
  load(): Promise<AccessToken | null>;
  /**
   * Stores the token. False when it may not be kept: the settings it was
   * requested for changed meanwhile, or the user signed out. "otherAccount"
   * when Entra answered a silent request for an account other than the one
   * the user confirmed: the sign-in ends signed out (OTHER_ACCOUNT_TEXT).
   * `options` are the ones the sign-in was asked with.
   */
  save(token: AccessToken, options: TokenOptions): Promise<boolean | "otherAccount">;
  clear(): Promise<void>;
  now(): number;
  /** The confirmed account for these settings, for a background silent sign-in; null when none is kept. */
  loginHint?(settings: AuthSettings): Promise<string | null>;
}

export type TokenOptions = {
  interactive: boolean;
  ignoreCache?: boolean;
  /**
   * The caller's sign-out count when it asked. A sign-in is shared only with
   * callers of the same count, and save() can refuse a token from a sign-in
   * that a sign-out overtook.
   */
  generation?: number;
};

export type TokenResult =
  | { kind: "token"; token: AccessToken }
  | { kind: "signedOut"; reason: string }
  /** Entra granted a token the extension does not keep; nothing was stored. */
  | { kind: "refused"; reason: GrantRefusal }
  /**
   * Entra granted a token, but it was not kept: the sign-in settings changed
   * while it was requested, or (`signedOut`) the user signed out meanwhile.
   */
  | { kind: "notKept"; signedOut?: boolean };

/**
 * Whether a stored token was requested for this Pathix, authority, client and
 * scope. A token minted for another Pathix address, another client ID, or the
 * web app's Pathix.Access scope is never reused. A token stored by an earlier
 * build carries none of these, so it is not reused either.
 */
export function isTokenFor(token: AccessToken, settings: AuthSettings): boolean {
  return (
    token.pathixUrl === settings.pathixUrl &&
    token.authority === settings.authority &&
    token.clientId === settings.clientId &&
    token.scope === settings.apiScope
  );
}

export async function getAccessToken(settings: AuthSettings, deps: TokenDeps, options: TokenOptions): Promise<TokenResult> {
  // Read once: both sign-in legs compare against this, so a token another
  // sign-in saves after this point is never taken for the one they replace.
  const before = await deps.load();
  if (!options.ignoreCache) {
    const usable = before && isTokenFor(before, settings) && before.expiresAt - EXPIRY_SKEW_MS > deps.now();
    if (usable) return { kind: "token", token: before };
  }

  // Only a silent sign-in that needs the user goes on to a window. A refused
  // grant or settings that changed would not be fixed by one.
  const silent = await signIn(settings, deps, { silent: true, before, options });
  if (silent.kind !== "signedOut" || !options.interactive) return silent;
  return signIn(settings, deps, { silent: false, before, options });
}

/**
 * getAccessToken with one sign-in in flight per Pathix, authority, client,
 * scope and mode. Callers that ask while one is running share its answer, so
 * five reads that all need a token start one sign-in, not five.
 */
export class TokenSession {
  private readonly inFlight = new Map<string, Promise<TokenResult>>();

  constructor(private readonly deps: TokenDeps) {}

  get(settings: AuthSettings, options: TokenOptions): Promise<TokenResult> {
    const key = [
      settings.pathixUrl,
      settings.authority,
      settings.clientId,
      settings.apiScope,
      options.interactive,
      !!options.ignoreCache,
      options.generation ?? 0,
    ].join("|");
    const running = this.inFlight.get(key);
    if (running) return running;
    const flight = getAccessToken(settings, this.deps, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, flight);
    return flight;
  }
}

async function signIn(
  settings: AuthSettings,
  deps: TokenDeps,
  { silent, before, options }: { silent: boolean; before: AccessToken | null; options: TokenOptions },
): Promise<TokenResult> {
  const verifier = createCodeVerifier();
  const state = randomUrlSafe(32);

  try {
    // Only a background renewal names the account. The options page's Sign in
    // (interactive) sends none, so with several accounts the user still picks.
    const loginHint = silent && !options.interactive ? ((await deps.loginHint?.(settings)) ?? null) : null;
    const url = buildAuthorizeUrl(settings, { state, codeChallenge: await codeChallenge(verifier), silent, loginHint });
    const redirect = parseRedirect(await deps.launch(url, !silent), state);
    if (!redirect.ok) {
      await clearUnlessReplaced(deps, before);
      return { kind: "signedOut", reason: redirect.error };
    }
    const token = await deps.redeem(settings, redirect.code, verifier);
    const saved = await deps.save(token, options);
    if (saved === "otherAccount") {
      // Signed out, not "not kept": the settings did not change, the account did.
      await deps.clear();
      return { kind: "signedOut", reason: OTHER_ACCOUNT_TEXT };
    }
    if (!saved) return { kind: "notKept" };
    return { kind: "token", token };
  } catch (error) {
    // A silent flow that needs UI, a closed sign-in window, or a failed
    // redemption all leave the user signed out; the reason is for the log.
    await clearUnlessReplaced(deps, before);
    if (error instanceof GrantRefusedError) return { kind: "refused", reason: error.reason };
    return { kind: "signedOut", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A failed sign-in clears the stored token it could not replace, unless
 * another sign-in saved a new one meanwhile: that one is kept.
 */
async function clearUnlessReplaced(deps: TokenDeps, before: AccessToken | null): Promise<void> {
  const current = await deps.load();
  if (current && current.token !== before?.token) return;
  await deps.clear();
}
