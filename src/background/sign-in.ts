// The service worker's sign-in, kept apart from its chrome calls so it is
// tested (test/sign-in.test.ts): reading a Pathix's sign-in settings, getting
// a token, remembering a grant the extension refused, what a failure means for
// a card, and whether the stored token signs the user in to this Pathix.
//
// A silent sign-in happens only for the binding the user confirmed by
// selecting Sign in on the options page (src/auth/binding.ts). Sign out removes
// the token and the binding, so nothing signs in again until the user does.

import { accountName, loginHintClaim, namesAccount } from "../auth/claims";
import type { AccessToken, AuthSettings, GrantRefusal } from "../auth/authorize";
import { bindingChanges, bindingFor, isBinding, loginHintOf, sameBinding, withLoginHint, type BindingChange, type SignInBinding } from "../auth/binding";
import { isTokenFor, TokenSession, type TokenDeps, type TokenOptions, type TokenResult } from "../auth/session";
import { authSettingsFrom, type AuthConfigResult, type SignInUnavailable, type TokenSource } from "../pathix/api";
import type { ConnectionStatus } from "../runtime/messages";
import { CONNECTION_TTL_MS } from "./connection";

/**
 * How long what the worker learned about a Pathix's sign-in is kept: its
 * settings, a "no sign-in" answer from /config, and a refused grant (counted
 * from when it was refused). As long as a connection status.
 */
export const SIGN_IN_TTL_MS = CONNECTION_TTL_MS;

/** This Pathix offers the extension no sign-in, so nothing more is asked of Entra. */
export class SignInUnavailableError extends Error {
  constructor(readonly reason: SignInUnavailable) {
    super(`this Pathix offers the extension no sign-in (${reason})`);
  }
}

/**
 * A Pathix that offers the extension no sign-in is not set up for it: the card
 * sends the user to the options page, which says why. Anything else is a
 * failure to reach Pathix.
 */
export function statusForError(error: unknown): ConnectionStatus {
  if (error instanceof SignInUnavailableError) return { kind: "notConfigured" };
  return { kind: "error", message: errorMessage(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a sign-in did not complete when Entra granted a token but the settings
 * changed while it was requested. Shown after "Sign-in did not complete: ".
 */
export const NOT_KEPT_TEXT = "Pathix's sign-in settings changed while you were signing in. Sign in again.";

/** Why a sign-in did not complete when the user signed out while it ran. Shown after "Sign-in did not complete: ". */
export const SIGNED_OUT_TEXT = "You signed out before sign-in finished.";

/** Why a silent sign-in did not start: the user has not confirmed these settings with Sign in. For the log. */
export const NOT_CONFIRMED_REASON = "sign-in not confirmed on the options page";

/** What the options page shows before Sign in, and how it compares with what the user confirmed. */
export interface Confirmation {
  /** What Sign in would confirm: what /config says now. */
  offered: SignInBinding;
  /** The user confirmed exactly this, so a silent sign-in may run. */
  confirmed: boolean;
  /** What changed since the user confirmed this address. Empty when nothing did or nothing was confirmed here. */
  changes: BindingChange[];
}

/** The token from a sign-in, null when there is none. A refused grant means this Pathix offers no sign-in. */
export function tokenFrom(result: TokenResult): string | null {
  if (result.kind === "refused") throw new SignInUnavailableError(result.reason);
  return result.kind === "token" ? result.token.token : null;
}

/** A refused grant as kept in session storage, so it outlives a worker restart. */
export interface StoredRefusal {
  pathixUrl: string;
  authority: string;
  clientId: string;
  apiScope: string;
  reason: GrantRefusal;
  /** When it was refused, in epoch milliseconds. Honored for SIGN_IN_TTL_MS from then. */
  at: number;
}

interface Refusal {
  reason: GrantRefusal;
  at: number;
}

type Entry =
  | { kind: "settings"; settings: AuthSettings; at: number; refusal: Refusal | null }
  | { kind: "unavailable"; pathixUrl: string; reason: SignInUnavailable; at: number };

/** What is known about a Pathix's sign-in: its settings, or why it offers none. */
export type KnownSignIn = { settings: AuthSettings } | { unavailable: SignInUnavailable };

/**
 * What the worker learned from a Pathix's /config, kept for SIGN_IN_TTL_MS,
 * with any grant the extension refused for those settings. Past that, the next
 * request reads /config again, so a registration that was removed, rotated or
 * fixed shows without a worker restart.
 */
export class SignInSettingsCache {
  private entry: Entry | null = null;

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = SIGN_IN_TTL_MS,
  ) {}

  /** What is known about this address while it is fresh, or null. */
  get(pathixUrl: string): KnownSignIn | null {
    const entry = this.entry;
    if (!entry || this.now() - entry.at >= this.ttlMs) return null;
    if (entry.kind === "unavailable") return entry.pathixUrl === pathixUrl ? { unavailable: entry.reason } : null;
    return entry.settings.pathixUrl === pathixUrl ? { settings: entry.settings } : null;
  }

  /**
   * Keeps settings just read. With `keepRefusal`, a refusal still in force for
   * the same sign-in carries over: a read the options page did not ask for
   * never wipes one.
   */
  setSettings(settings: AuthSettings, options: { keepRefusal: boolean }): void {
    const previous = this.entry;
    const kept =
      options.keepRefusal && previous?.kind === "settings" && sameSignIn(previous.settings, settings) ? this.inForce(previous.refusal) : null;
    this.entry = { kind: "settings", settings, at: this.now(), refusal: kept };
  }

  /** Keeps a "no sign-in" answer. True when it is news. */
  setUnavailable(pathixUrl: string, reason: SignInUnavailable): boolean {
    const previous = this.entry;
    const known = previous?.kind === "unavailable" && previous.pathixUrl === pathixUrl && previous.reason === reason;
    this.entry = { kind: "unavailable", pathixUrl, reason, at: this.now() };
    return !known;
  }

  /** Remembers a refused grant for these settings. The refusal when it is news, else null. */
  refuse(settings: AuthSettings, reason: GrantRefusal): Refusal | null {
    const entry = this.entry;
    if (entry?.kind !== "settings" || !sameSignIn(entry.settings, settings) || this.inForce(entry.refusal)?.reason === reason) return null;
    entry.refusal = { reason, at: this.now() };
    return entry.refusal;
  }

  /** Puts back a refusal kept in session storage, after a worker restart. */
  restore(stored: StoredRefusal, redirectUri: string): KnownSignIn {
    const { pathixUrl, authority, clientId, apiScope, reason, at } = stored;
    const settings: AuthSettings = { pathixUrl, authority, clientId, apiScope, redirectUri };
    this.entry = { kind: "settings", settings, at, refusal: { reason, at } };
    return { settings };
  }

  /** The refused grant in force for these settings, or null. */
  refusalFor(settings: AuthSettings): GrantRefusal | null {
    const entry = this.entry;
    return entry?.kind === "settings" && sameSignIn(entry.settings, settings) ? (this.inForce(entry.refusal)?.reason ?? null) : null;
  }

  /** Whether a token minted for these settings may be kept: they are still the ones last read, and not refused. */
  isCurrent(token: AccessToken): boolean {
    const entry = this.entry;
    return entry?.kind === "settings" && this.inForce(entry.refusal) === null && isTokenFor(token, entry.settings);
  }

  clear(): void {
    this.entry = null;
  }

  private inForce(refusal: Refusal | null): Refusal | null {
    return refusal && this.now() - refusal.at < this.ttlMs ? refusal : null;
  }
}

function sameSignIn(a: AuthSettings, b: AuthSettings): boolean {
  return a.pathixUrl === b.pathixUrl && a.authority === b.authority && a.clientId === b.clientId && a.apiScope === b.apiScope;
}

/** The chrome side of signing in, injected. */
export interface SignInDeps {
  readConfig(pathixUrl: string): Promise<AuthConfigResult>;
  redirectUri(): string;
  launch(url: string, interactive: boolean): Promise<string>;
  redeem(settings: AuthSettings, code: string, codeVerifier: string): Promise<AccessToken>;
  loadToken(): Promise<AccessToken | null>;
  saveToken(token: AccessToken): Promise<void>;
  removeToken(): Promise<void>;
  loadRefusal(): Promise<StoredRefusal | null>;
  saveRefusal(refusal: StoredRefusal): Promise<void>;
  removeRefusal(): Promise<void>;
  /** The confirmed sign-in binding, as stored. Checked by the caller, so anything may come back. */
  loadBinding(): Promise<unknown>;
  saveBinding(binding: SignInBinding): Promise<void>;
  removeBinding(): Promise<void>;
  /**
   * Sign-in just became unavailable: a grant was refused, or /config stopped
   * offering it. Forget connection statuses and badges, so cards and the badge
   * agree.
   */
  onUnavailable(): void;
  now(): number;
}

/**
 * Signing in to the user's Pathix.
 *
 * A /config that offers no sign-in stops it before Entra is asked, removes the
 * stored token, and is remembered. A refused grant is remembered with the
 * settings and kept in session storage, so it outlives a worker restart. Each
 * holds until the options page reads /config again, the address changes or
 * SIGN_IN_TTL_MS pass (for a refusal, from when it was refused). Until then
 * the worker asks Entra nothing more.
 *
 * Only the options page's Sign in starts a sign-in for settings the user has
 * not confirmed, and only its success writes the binding. Every other sign-in
 * (a card, the badge, the options page loading) is silent and runs only when
 * the settings equal the binding.
 */
export class PathixSignIn {
  private readonly cache: SignInSettingsCache;
  private readonly session: TokenSession;
  private readonly reads = new Map<string, Promise<AuthSettings>>();
  /** Counts sign-outs and address changes. A sign-in one of them overtook keeps no token. */
  private generation = 0;
  /** Counts sign-outs alone, so a sign-in they overtook can say so. */
  private signOuts = 0;

  constructor(private readonly deps: SignInDeps) {
    this.cache = new SignInSettingsCache(() => deps.now());
    this.session = new TokenSession(this.tokenDeps());
  }

  /**
   * The sign-in settings for this Pathix: what is known, unless `fresh`.
   * Throws SignInUnavailableError when /config offers the extension no
   * sign-in, or when a refused grant is in force.
   */
  async settingsFor(pathixUrl: string, options: { fresh: boolean } = { fresh: false }): Promise<AuthSettings> {
    if (!options.fresh) {
      const known = this.cache.get(pathixUrl) ?? (await this.restoredRefusal(pathixUrl));
      if (known) return this.settingsOrThrow(known);
    }
    return this.readOnce(pathixUrl, options.fresh);
  }

  /**
   * A token for these settings. A refused grant is remembered, and answered
   * again without asking Entra. A silent request for settings the user has not
   * confirmed is signed out, and asks Entra nothing.
   */
  async token(settings: AuthSettings, options: TokenOptions): Promise<TokenResult> {
    const remembered = this.cache.refusalFor(settings);
    if (remembered) return { kind: "refused", reason: remembered };
    const generation = this.generation;
    const signOuts = this.signOuts;
    if (!options.interactive && !(await this.isConfirmed(settings))) return { kind: "signedOut", reason: NOT_CONFIRMED_REASON };
    const result = await this.session.get(settings, { ...options, generation });
    if (result.kind === "refused") await this.remember(settings, result.reason);
    if (result.kind === "notKept" && this.signOuts !== signOuts) return { kind: "notKept", signedOut: true };
    return result;
  }

  /**
   * The options page's Sign in: an interactive sign-in that never takes a
   * cached token, so a successful one always writes the binding for these
   * settings, the ones the page showed.
   */
  confirm(settings: AuthSettings): Promise<TokenResult> {
    return this.token(settings, { interactive: true, ignoreCache: true });
  }

  /** What Sign in would confirm for these settings, and whether the user already has. */
  async confirmation(settings: AuthSettings): Promise<Confirmation> {
    const offered = bindingFor(settings);
    const stored = await this.deps.loadBinding();
    const confirmed = sameBinding(stored, offered);
    return { offered, confirmed, changes: confirmed ? [] : (bindingChanges(stored, offered) ?? []) };
  }

  /**
   * Signs the user out: the token and the binding go, and a sign-in already
   * running keeps nothing. Nothing signs in again until the user selects Sign in.
   */
  async signOut(): Promise<void> {
    this.generation += 1;
    this.signOuts += 1;
    await this.deps.removeToken();
    await this.deps.removeBinding();
  }

  /** What apiGet signs in with on the background path. Throws SignInUnavailableError on a refused grant. */
  tokenSource(settings: AuthSettings): TokenSource {
    return async (renew) => tokenFrom(await this.token(settings, { interactive: false, ignoreCache: renew }));
  }

  /** Forgets what is known, the token, the binding and any refusal: a new address, or none. */
  async forget(): Promise<void> {
    this.generation += 1;
    this.cache.clear();
    await this.deps.removeRefusal();
    await this.deps.removeToken();
    await this.deps.removeBinding();
  }

  private async isConfirmed(settings: AuthSettings): Promise<boolean> {
    return sameBinding(await this.deps.loadBinding(), bindingFor(settings));
  }

  private settingsOrThrow(known: KnownSignIn): AuthSettings {
    if ("unavailable" in known) throw new SignInUnavailableError(known.unavailable);
    const refused = this.cache.refusalFor(known.settings);
    if (refused) throw new SignInUnavailableError(refused);
    return known.settings;
  }

  /** One /config read at a time per address and kind; callers that ask meanwhile share it. */
  private readOnce(pathixUrl: string, fresh: boolean): Promise<AuthSettings> {
    const key = `${pathixUrl}|${fresh}`;
    const running = this.reads.get(key);
    if (running) return running;
    const read = this.read(pathixUrl, fresh).finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  /**
   * Reads /config. What was known stays until the answer is in, so a sign-in
   * that finishes during the read keeps its token. A fresh read (the options
   * page) also drops any refusal: the user's request asks Entra once more.
   */
  private async read(pathixUrl: string, fresh: boolean): Promise<AuthSettings> {
    let config: AuthConfigResult;
    try {
      config = await this.deps.readConfig(pathixUrl);
    } catch (error) {
      this.cache.clear();
      throw error;
    }
    if (!config.ok) return this.unavailable(pathixUrl, config.unavailable);

    const settings = authSettingsFrom(config.config, { pathixUrl, redirectUri: this.deps.redirectUri() });
    this.cache.setSettings(settings, { keepRefusal: !fresh });
    if (fresh) await this.deps.removeRefusal();
    return this.settingsOrThrow({ settings });
  }

  private async unavailable(pathixUrl: string, reason: SignInUnavailable): Promise<never> {
    const news = this.cache.setUnavailable(pathixUrl, reason);
    await this.deps.removeToken();
    await this.deps.removeRefusal();
    if (news) this.deps.onUnavailable();
    throw new SignInUnavailableError(reason);
  }

  private async remember(settings: AuthSettings, reason: GrantRefusal): Promise<void> {
    const refusal = this.cache.refuse(settings, reason);
    if (!refusal) return;
    const { pathixUrl, authority, clientId, apiScope } = settings;
    await this.deps.saveRefusal({ pathixUrl, authority, clientId, apiScope, reason, at: refusal.at });
    this.deps.onUnavailable();
  }

  /** A refusal kept in session storage for this address and still in force, put back after a worker restart. */
  private async restoredRefusal(pathixUrl: string): Promise<KnownSignIn | null> {
    const stored = await this.deps.loadRefusal();
    if (!stored || stored.pathixUrl !== pathixUrl) return null;
    if (this.deps.now() - stored.at >= SIGN_IN_TTL_MS) {
      await this.deps.removeRefusal();
      return null;
    }
    return this.cache.restore(stored, this.deps.redirectUri());
  }

  /**
   * Keeps a token Entra granted, or refuses it. A sign-in that a sign-out, a
   * new address, or the options page finding the settings changed or
   * unavailable overtook keeps nothing. The options page's Sign in writes the
   * binding before the token, so a sign-out that lands after it removes both.
   * Any other sign-in keeps its token only for the binding in force.
   */
  private async save(token: AccessToken, options: TokenOptions): Promise<boolean | "otherAccount"> {
    const generation = options.generation;
    const keeps = () => generation === this.generation && this.cache.isCurrent(token);
    if (!keeps()) return false;
    if (options.interactive) await this.deps.saveBinding(withLoginHint(bindingOfToken(token), loginHintClaim(token.token)));
    else {
      const account = await this.confirmedAccount(token);
      if (account === "otherAccount") {
        await this.forgetConfirmation();
        return account;
      }
      if (!account) return false;
    }
    if (!keeps()) return false;
    await this.deps.saveToken(token);
    return true;
  }

  /**
   * A background renewal keeps its token only under the binding in force, and
   * only for the account the user confirmed. Entra can answer a silent request
   * for another account signed in to the browser: that is "otherAccount". A
   * binding with no account, or a token that names none, is not compared.
   */
  private async confirmedAccount(token: AccessToken): Promise<boolean | "otherAccount"> {
    const stored = await this.deps.loadBinding();
    if (!sameBinding(stored, bindingOfToken(token))) return false;
    const hint = isBinding(stored) ? stored.loginHint : undefined;
    return !hint || namesAccount(token.token, hint) !== false ? true : "otherAccount";
  }

  /**
   * After Entra answered for another account: the binding goes (the session
   * clears the token), so no silent sign-in runs again until the user selects
   * Sign in, and cached statuses and badges are forgotten so cards and the
   * badge say signed out together.
   */
  private async forgetConfirmation(): Promise<void> {
    this.generation += 1;
    await this.deps.removeBinding();
    this.deps.onUnavailable();
  }

  private tokenDeps(): TokenDeps {
    return {
      launch: (url, interactive) => this.deps.launch(url, interactive),
      redeem: (settings, code, verifier) => this.deps.redeem(settings, code, verifier),
      load: () => this.deps.loadToken(),
      save: (token, options) => this.save(token, options),
      clear: () => this.deps.removeToken(),
      now: () => this.deps.now(),
      loginHint: async (settings) => loginHintOf(await this.deps.loadBinding(), settings),
    };
  }
}

/**
 * Whether the stored token signs the user in to this Pathix, and as whom. Only
 * an unexpired token minted for this address, under the binding the user
 * confirmed, counts. This needs no answer from Pathix, so it holds when Pathix
 * cannot be reached.
 */
export function storedSignIn(
  stored: unknown,
  binding: unknown,
  pathixUrl: string | null,
  now: number,
): { signedIn: boolean; account: string | null } {
  const signedOut = { signedIn: false, account: null };
  const token = stored as Partial<AccessToken> | undefined;
  if (pathixUrl === null || typeof token?.token !== "string" || token.pathixUrl !== pathixUrl) return signedOut;
  if (typeof token.expiresAt !== "number" || token.expiresAt <= now) return signedOut;
  if (!sameBinding(binding, bindingOfToken(token as AccessToken))) return signedOut;
  return { signedIn: true, account: accountName(token.token) };
}

/**
 * Whether the options page offers Sign out: a token or a confirmed sign-in is
 * stored, so there is something to remove, even when it no longer signs the
 * user in (the settings changed since).
 */
export function signOutOffered(stored: unknown, binding: unknown): boolean {
  return (stored !== undefined && stored !== null) || (binding !== undefined && binding !== null);
}

function bindingOfToken(token: AccessToken): SignInBinding {
  return bindingFor({ pathixUrl: token.pathixUrl, authority: token.authority, clientId: token.clientId, apiScope: token.scope });
}
