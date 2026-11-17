// The service worker's sign-in (src/background/sign-in.ts): reading a Pathix's
// sign-in settings, getting a token, remembering a grant the extension
// refused, what a failure means for a card, and whether the stored token signs
// the user in to this Pathix. PathixSignIn runs against fake chrome deps and
// the real redeemCode, so the grant check is the one the worker uses.

import { describe, expect, it, vi } from "vitest";
import { redeemCode, type AccessToken, type AuthSettings } from "../src/auth/authorize";
import { bindingFor, type SignInBinding } from "../src/auth/binding";
import { OTHER_ACCOUNT_TEXT } from "../src/auth/session";
import { ConnectionCache } from "../src/background/connection";
import {
  PathixSignIn,
  SIGN_IN_TTL_MS,
  SignInSettingsCache,
  SIGNED_OUT_TEXT,
  SignInUnavailableError,
  statusForError,
  storedSignIn,
  tokenFrom,
  type SignInDeps,
  type StoredRefusal,
} from "../src/background/sign-in";
import { stateForConnection } from "../src/card/states";
import { apiGet, type AuthConfigResult } from "../src/pathix/api";
import type { ConnectionStatus } from "../src/runtime/messages";

const PATHIX = "https://pathix.contoso.com";
const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";
const EXTENSION_CLIENT = "40000000-0000-4000-8000-000000000004";
const READ = "api://20000000-0000-4000-8000-000000000002/Pathix.Read";
const TENANT = "10000000-0000-4000-8000-000000000001";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const MINUTE = 60 * 1000;

function signInSettings(pathixUrl = PATHIX): AuthSettings {
  return { pathixUrl, authority: AUTHORITY, clientId: EXTENSION_CLIENT, apiScope: READ, redirectUri: REDIRECT };
}

/** An unsigned JWT with these claims. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const READ_ONLY_GRANT = jwt({ scp: "Pathix.Read", upn: "user@contoso.com" });
const BROAD_GRANT = jwt({ scp: "Pathix.Access Pathix.Read", upn: "user@contoso.com" });

function token(overrides: Partial<AccessToken> = {}): AccessToken {
  return {
    token: READ_ONLY_GRANT,
    expiresAt: 2_000,
    pathixUrl: PATHIX,
    authority: AUTHORITY,
    clientId: EXTENSION_CLIENT,
    scope: READ,
    ...overrides,
  };
}

function configFor(clientId = EXTENSION_CLIENT): AuthConfigResult {
  return { ok: true, config: { tenantId: TENANT, authority: AUTHORITY, clientId, apiScope: READ } };
}

const USABLE = configFor();

/** A promise to hold an operation at, and the function that lets it go. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * Fake chrome deps: /config answers `config` (after `configGate`, when set),
 * Entra answers every authorize request with a code (after `launchGate`) and
 * redeems it for `grant`, session storage holds `held` and `refusal`, and
 * local storage holds the confirmed `binding` (by default, for these settings).
 * The state is shared, so a second PathixSignIn over it is a worker restart.
 */
function world(start: { config?: AuthConfigResult; grant?: string; onUnavailable?: () => void; binding?: SignInBinding | null } = {}) {
  const state = {
    now: 0,
    held: null as AccessToken | null,
    refusal: null as StoredRefusal | null,
    config: start.config ?? USABLE,
    grant: start.grant ?? READ_ONLY_GRANT,
    configGate: null as Promise<void> | null,
    launchGate: null as Promise<void> | null,
    binding: (start.binding === undefined ? bindingFor(signInSettings()) : start.binding) as unknown,
  };
  const tokenEndpoint = async () => Response.json({ access_token: state.grant, expires_in: 3600 });
  const deps = {
    readConfig: vi.fn(async (_pathixUrl: string) => {
      if (state.configGate) await state.configGate;
      return state.config;
    }),
    redirectUri: () => REDIRECT,
    launch: vi.fn(async (url: string, _interactive: boolean) => {
      if (state.launchGate) await state.launchGate;
      return `${REDIRECT}?code=code-1&state=${new URL(url).searchParams.get("state")}`;
    }),
    redeem: vi.fn((settings: AuthSettings, code: string, verifier: string) =>
      redeemCode(settings, code, verifier, tokenEndpoint as unknown as typeof fetch, () => state.now),
    ),
    loadToken: async () => state.held,
    saveToken: vi.fn(async (saved: AccessToken) => {
      state.held = saved;
    }),
    removeToken: vi.fn(async () => {
      state.held = null;
    }),
    loadRefusal: async () => state.refusal,
    saveRefusal: vi.fn(async (refusal: StoredRefusal) => {
      state.refusal = refusal;
    }),
    removeRefusal: vi.fn(async () => {
      state.refusal = null;
    }),
    loadBinding: async () => state.binding,
    saveBinding: vi.fn(async (binding: SignInBinding) => {
      state.binding = binding;
    }),
    removeBinding: vi.fn(async () => {
      state.binding = null;
    }),
    onUnavailable: vi.fn(start.onUnavailable ?? (() => undefined)),
    now: () => state.now,
  } satisfies SignInDeps;
  return { state, deps, signIn: new PathixSignIn(deps) };
}

describe("statusForError", () => {
  it("reads a Pathix that offers the extension no sign-in as not set up, which sends the user to the options page", () => {
    for (const reason of ["signInOff", "olderPathix", "notRegistered", "invalidRegistration", "grantsMoreThanRead"] as const) {
      const status = statusForError(new SignInUnavailableError(reason));
      expect(status).toEqual({ kind: "notConfigured" });
      expect(stateForConnection(status)).toMatchObject({ kind: "notConfigured", action: "openOptions" });
    }
  });

  it("reads anything else, such as a network failure, as a failure to reach Pathix", () => {
    expect(statusForError(new TypeError("Failed to fetch"))).toEqual({ kind: "error", message: "Failed to fetch" });
    expect(statusForError(new Error("Pathix /config answered 502."))).toEqual({ kind: "error", message: "Pathix /config answered 502." });
    expect(statusForError("offline")).toEqual({ kind: "error", message: "offline" });
  });
});

describe("tokenFrom", () => {
  it("gives the token, or null when there is none", () => {
    expect(tokenFrom({ kind: "token", token: token() })).toBe(READ_ONLY_GRANT);
    expect(tokenFrom({ kind: "signedOut", reason: "login_required" })).toBeNull();
    expect(tokenFrom({ kind: "notKept" })).toBeNull();
  });

  it("throws sign-in unavailable for a refused grant, so a card says not set up rather than signed out", () => {
    const error = (() => {
      try {
        tokenFrom({ kind: "refused", reason: "grantsMoreThanRead" });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toEqual(new SignInUnavailableError("grantsMoreThanRead"));
  });
});

describe("SignInSettingsCache", () => {
  it("keeps a Pathix's sign-in settings for SIGN_IN_TTL_MS, as long as a connection status", () => {
    let now = 0;
    const cache = new SignInSettingsCache(() => now);
    cache.setSettings(signInSettings(), { keepRefusal: false });
    now = SIGN_IN_TTL_MS - 1;
    expect(cache.get(PATHIX)).toEqual({ settings: signInSettings() });
    now = SIGN_IN_TTL_MS;
    expect(cache.get(PATHIX)).toBeNull();
    expect(SIGN_IN_TTL_MS).toBe(5 * MINUTE);
  });

  it("answers only for the address it was read from", () => {
    const cache = new SignInSettingsCache(() => 0);
    cache.setSettings(signInSettings(), { keepRefusal: false });
    expect(cache.get("https://pathix.fabrikam.com")).toBeNull();
    cache.setUnavailable(PATHIX, "notRegistered");
    expect(cache.get(PATHIX)).toEqual({ unavailable: "notRegistered" });
    expect(cache.get("https://pathix.fabrikam.com")).toBeNull();
  });

  it("remembers a refusal for the settings it was made for, once", () => {
    const cache = new SignInSettingsCache(() => 0);
    cache.setSettings(signInSettings(), { keepRefusal: false });
    expect(cache.refuse(signInSettings(), "grantsMoreThanRead")).toEqual({ reason: "grantsMoreThanRead", at: 0 });
    expect(cache.refuse(signInSettings(), "grantsMoreThanRead")).toBeNull();
    expect(cache.refusalFor(signInSettings())).toBe("grantsMoreThanRead");
    expect(cache.refusalFor({ ...signInSettings(), clientId: "99999999-0000-4000-8000-000000000009" })).toBeNull();
  });

  it("carries a refusal in force over a read the options page did not ask for, and only then", () => {
    let now = 0;
    const cache = new SignInSettingsCache(() => now);
    cache.setSettings(signInSettings(), { keepRefusal: false });
    cache.refuse(signInSettings(), "grantsMoreThanRead");

    cache.setSettings(signInSettings(), { keepRefusal: true });
    expect(cache.refusalFor(signInSettings())).toBe("grantsMoreThanRead");

    const rotated = { ...signInSettings(), clientId: "50000000-0000-4000-8000-000000000005" };
    cache.setSettings(rotated, { keepRefusal: true });
    expect(cache.refusalFor(rotated)).toBeNull();

    cache.setSettings(signInSettings(), { keepRefusal: false });
    cache.refuse(signInSettings(), "grantsMoreThanRead");
    cache.setSettings(signInSettings(), { keepRefusal: false });
    expect(cache.refusalFor(signInSettings())).toBeNull();

    cache.refuse(signInSettings(), "grantsMoreThanRead");
    now = SIGN_IN_TTL_MS;
    cache.setSettings(signInSettings(), { keepRefusal: true });
    expect(cache.refusalFor(signInSettings())).toBeNull();
  });

  it("says whether a no-sign-in answer is news", () => {
    const cache = new SignInSettingsCache(() => 0);
    expect(cache.setUnavailable(PATHIX, "notRegistered")).toBe(true);
    expect(cache.setUnavailable(PATHIX, "notRegistered")).toBe(false);
    expect(cache.setUnavailable(PATHIX, "signInOff")).toBe(true);
  });
});

describe("PathixSignIn: sign-in settings", () => {
  it("reads /config once, then answers from what it knows", async () => {
    const { deps, signIn } = world();
    expect(await signIn.settingsFor(PATHIX)).toEqual(signInSettings());
    expect(await signIn.settingsFor(PATHIX)).toEqual(signInSettings());
    expect(deps.readConfig).toHaveBeenCalledTimes(1);
  });

  it("reads /config again on a fresh read, and once SIGN_IN_TTL_MS has passed", async () => {
    const { state, deps, signIn } = world();
    await signIn.settingsFor(PATHIX);
    await signIn.settingsFor(PATHIX, { fresh: true });
    expect(deps.readConfig).toHaveBeenCalledTimes(2);
    state.now += SIGN_IN_TTL_MS;
    await signIn.settingsFor(PATHIX);
    expect(deps.readConfig).toHaveBeenCalledTimes(3);
  });

  it("shares one /config read among requests that miss the cache at the same time", async () => {
    const { state, deps, signIn } = world();
    const read = gate();
    state.configGate = read.promise;
    const answers = Promise.all([signIn.settingsFor(PATHIX), signIn.settingsFor(PATHIX), signIn.settingsFor(PATHIX)]);
    read.open();
    expect(await answers).toEqual([signInSettings(), signInSettings(), signInSettings()]);
    expect(deps.readConfig).toHaveBeenCalledTimes(1);
  });

  it("removes the stored token, asks nothing of Entra, and throws when /config offers no sign-in", async () => {
    const { state, deps, signIn } = world({ config: { ok: false, unavailable: "notRegistered" } });
    state.held = token();
    await expect(signIn.settingsFor(PATHIX)).rejects.toEqual(new SignInUnavailableError("notRegistered"));
    expect(deps.removeToken).toHaveBeenCalled();
    expect(state.held).toBeNull();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("remembers a no-sign-in answer until SIGN_IN_TTL_MS has passed or the options page reads again", async () => {
    const { state, deps, signIn } = world({ config: { ok: false, unavailable: "notRegistered" } });
    await expect(signIn.settingsFor(PATHIX)).rejects.toBeInstanceOf(SignInUnavailableError);
    await expect(signIn.settingsFor(PATHIX)).rejects.toEqual(new SignInUnavailableError("notRegistered"));
    expect(deps.readConfig).toHaveBeenCalledTimes(1);

    state.config = USABLE;
    expect(await signIn.settingsFor(PATHIX, { fresh: true })).toEqual(signInSettings());
    expect(deps.readConfig).toHaveBeenCalledTimes(2);
  });

  it("tells cards and the badge when a read after SIGN_IN_TTL_MS finds sign-in unavailable, once", async () => {
    const { state, deps, signIn } = world();
    await signIn.settingsFor(PATHIX);
    expect(deps.onUnavailable).not.toHaveBeenCalled();

    state.now += SIGN_IN_TTL_MS;
    state.config = { ok: false, unavailable: "notRegistered" };
    await expect(signIn.settingsFor(PATHIX)).rejects.toBeInstanceOf(SignInUnavailableError);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);

    state.now += SIGN_IN_TTL_MS;
    await expect(signIn.settingsFor(PATHIX)).rejects.toBeInstanceOf(SignInUnavailableError);
    expect(deps.readConfig).toHaveBeenCalledTimes(3);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("forgets what it knew when /config cannot be read, and passes the failure on", async () => {
    const { state, deps, signIn } = world();
    await signIn.settingsFor(PATHIX);
    state.now += SIGN_IN_TTL_MS;
    deps.readConfig.mockRejectedValueOnce(new Error("Pathix /config answered 502."));
    await expect(signIn.settingsFor(PATHIX)).rejects.toThrow("Pathix /config answered 502.");
    expect(await signIn.settingsFor(PATHIX)).toEqual(signInSettings());
    expect(deps.readConfig).toHaveBeenCalledTimes(3);
  });

  it("reads /config again after the address is forgotten", async () => {
    const { deps, signIn } = world();
    await signIn.settingsFor(PATHIX);
    await signIn.forget();
    await signIn.settingsFor(PATHIX);
    expect(deps.readConfig).toHaveBeenCalledTimes(2);
  });
});

describe("PathixSignIn: keeping a token", () => {
  it("keeps a read-only grant for this Pathix, then uses it with no second sign-in", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    expect(await signIn.token(settings, { interactive: false })).toMatchObject({ kind: "token", token: { token: READ_ONLY_GRANT } });
    expect(state.held).toMatchObject({ pathixUrl: PATHIX, authority: AUTHORITY, clientId: EXTENSION_CLIENT, scope: READ });
    expect(await signIn.token(settings, { interactive: false })).toMatchObject({ kind: "token" });
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  // The interleaving a reviewer reproduced: the user selects Sign in while the
  // options page's own read of /config is still out. The settings stay known
  // until that read answers, so the token is kept.
  it("keeps the token of a sign-in that finishes while /config is being read again", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    const read = gate();
    state.configGate = read.promise;
    const reread = signIn.settingsFor(PATHIX, { fresh: true });

    expect(await signIn.token(settings, { interactive: true })).toMatchObject({ kind: "token" });
    expect(deps.saveToken).toHaveBeenCalledTimes(1);
    read.open();
    expect(await reread).toEqual(signInSettings());
    expect(state.held).toMatchObject({ token: READ_ONLY_GRANT, pathixUrl: PATHIX });
  });

  it("keeps no token from a sign-in that was running when the options page found sign-in unavailable, and says so", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const background = signIn.token(settings, { interactive: false });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));

    state.config = { ok: false, unavailable: "notRegistered" };
    await expect(signIn.settingsFor(PATHIX, { fresh: true })).rejects.toBeInstanceOf(SignInUnavailableError);
    entra.open();
    expect(await background).toEqual({ kind: "notKept" });
    expect(deps.saveToken).not.toHaveBeenCalled();
    expect(state.held).toBeNull();
  });

  it("keeps no token from a sign-in that was running when the options page read new settings, and says so", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const background = signIn.token(settings, { interactive: true });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));

    state.config = configFor("50000000-0000-4000-8000-000000000005");
    await signIn.settingsFor(PATHIX, { fresh: true });
    entra.open();
    expect(await background).toEqual({ kind: "notKept" });
    expect(deps.saveToken).not.toHaveBeenCalled();
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
});

describe("PathixSignIn: a refused grant", () => {
  it("is remembered and kept in session storage: the worker asks Entra nothing more, and cards and the badge are told once", async () => {
    const { state, deps, signIn } = world({ grant: BROAD_GRANT });
    state.now = 7 * MINUTE;
    const settings = await signIn.settingsFor(PATHIX);

    expect(await signIn.token(settings, { interactive: false })).toEqual({ kind: "refused", reason: "grantsMoreThanRead" });
    expect(await signIn.token(settings, { interactive: true })).toEqual({ kind: "refused", reason: "grantsMoreThanRead" });
    await expect(signIn.settingsFor(PATHIX)).rejects.toEqual(new SignInUnavailableError("grantsMoreThanRead"));

    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.readConfig).toHaveBeenCalledTimes(1);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(deps.saveToken).not.toHaveBeenCalled();
    expect(state.held).toBeNull();
    expect(state.refusal).toEqual({
      pathixUrl: PATHIX,
      authority: AUTHORITY,
      clientId: EXTENSION_CLIENT,
      apiScope: READ,
      reason: "grantsMoreThanRead",
      at: 7 * MINUTE,
    });
  });

  it("on the background card path, fails the read before it reaches Pathix, and the card says not set up", async () => {
    const { signIn } = world({ grant: BROAD_GRANT });
    const pathix = vi.fn(async () => Response.json([]));
    const read = apiGet(PATHIX, "/environments", signIn.tokenSource(await signIn.settingsFor(PATHIX)), pathix as unknown as typeof fetch);
    const error = await read.catch((caught: unknown) => caught);
    expect(error).toEqual(new SignInUnavailableError("grantsMoreThanRead"));
    expect(statusForError(error)).toEqual({ kind: "notConfigured" });
    expect(pathix).not.toHaveBeenCalled();
  });

  it("on the background card path, five reads at once start one sign-in", async () => {
    const { deps, signIn } = world({ grant: BROAD_GRANT });
    const source = signIn.tokenSource(await signIn.settingsFor(PATHIX));
    const pathix = vi.fn(async () => Response.json([]));
    const reads = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => apiGet(PATHIX, `/read-${i}`, source, pathix as unknown as typeof fetch)),
    );
    expect(reads.every((read) => read.status === "rejected")).toBe(true);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(pathix).not.toHaveBeenCalled();
  });

  // The interleaving a reviewer reproduced: two requests miss the cache at
  // once. Before, each read /config, and the second read wiped the refusal the
  // first had just made, so Entra was asked twice.
  it("is not wiped by a second request that missed the cache at the same time", async () => {
    const { state, deps, signIn } = world({ grant: BROAD_GRANT });
    const read = gate();
    state.configGate = read.promise;
    const first = signIn.settingsFor(PATHIX);
    const second = signIn.settingsFor(PATHIX);
    read.open();

    const firstSettings = await first;
    expect(await signIn.token(firstSettings, { interactive: false })).toMatchObject({ kind: "refused" });
    expect(await signIn.token(await second, { interactive: false })).toMatchObject({ kind: "refused" });
    expect(deps.readConfig).toHaveBeenCalledTimes(1);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("outlives a worker restart, without reading /config or asking Entra", async () => {
    const first = world({ grant: BROAD_GRANT });
    await first.signIn.token(await first.signIn.settingsFor(PATHIX), { interactive: false });

    first.state.now += 2 * MINUTE;
    const restarted = new PathixSignIn(first.deps);
    await expect(restarted.settingsFor(PATHIX)).rejects.toEqual(new SignInUnavailableError("grantsMoreThanRead"));
    expect(first.deps.readConfig).toHaveBeenCalledTimes(1);
    expect(first.deps.launch).toHaveBeenCalledTimes(1);
  });

  it("holds for SIGN_IN_TTL_MS from when it was refused, across the settings' own expiry and a restart", async () => {
    const { state, deps, signIn } = world({ grant: BROAD_GRANT });
    const settings = await signIn.settingsFor(PATHIX);
    state.now = 4 * MINUTE;
    await signIn.token(settings, { interactive: false });

    state.now = 6 * MINUTE;
    await expect(signIn.settingsFor(PATHIX)).rejects.toEqual(new SignInUnavailableError("grantsMoreThanRead"));
    expect(deps.readConfig).toHaveBeenCalledTimes(1);

    state.now = 4 * MINUTE + SIGN_IN_TTL_MS;
    state.grant = READ_ONLY_GRANT;
    const restarted = new PathixSignIn(deps);
    const fresh = await restarted.settingsFor(PATHIX);
    expect(state.refusal).toBeNull();
    expect(await restarted.token(fresh, { interactive: false })).toMatchObject({ kind: "token" });
    expect(deps.readConfig).toHaveBeenCalledTimes(2);
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });

  it("is forgotten on the options page's fresh read, which asks Entra once more", async () => {
    const { state, deps, signIn } = world({ grant: BROAD_GRANT });
    await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false });
    const fresh = await signIn.settingsFor(PATHIX, { fresh: true });
    expect(state.refusal).toBeNull();
    expect(await signIn.token(fresh, { interactive: true })).toEqual({ kind: "refused", reason: "grantsMoreThanRead" });
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });

  it("is forgotten with the address, in memory and in session storage", async () => {
    const { state, deps, signIn } = world({ grant: BROAD_GRANT });
    await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false });
    await signIn.forget();
    expect(state.refusal).toBeNull();
    expect(await signIn.settingsFor(PATHIX)).toEqual(signInSettings());
    expect(deps.readConfig).toHaveBeenCalledTimes(2);
  });

  it("kept for another address is not applied to this one", async () => {
    const { state, deps, signIn } = world();
    state.refusal = { ...signInSettings("https://pathix.fabrikam.com"), reason: "grantsMoreThanRead", at: 0 };
    expect(await signIn.settingsFor(PATHIX)).toEqual(signInSettings());
    expect(deps.readConfig).toHaveBeenCalledTimes(1);
  });
});

// Cards and the badge agree: the hook the worker passes clears the cached
// connection statuses, and a resolution that overlapped it is asked again.
describe("PathixSignIn with the worker's connection cache", () => {
  const ORG = "c0de0000-0000-4000-8000-000000000001";
  const HOST = "contoso.crm.dynamics.com";
  const CONNECTED: ConnectionStatus = { kind: "connected", environmentId: "env-1", environmentName: "Contoso", latestCompletedScanAt: "2026-10-01T00:00:00Z" };

  it("a read after SIGN_IN_TTL_MS that finds sign-in unavailable replaces a cached connected status", async () => {
    let connections: ConnectionCache | null = null;
    const { state, signIn } = world({ onUnavailable: () => connections?.clear() });
    connections = new ConnectionCache(async () => {
      try {
        await signIn.settingsFor(PATHIX);
        return CONNECTED;
      } catch (error) {
        return statusForError(error);
      }
    }, () => 0);
    expect(await connections.get(ORG, HOST)).toEqual(CONNECTED);

    // A card load reads the settings again after they ran out, and /config now offers no sign-in.
    state.now += SIGN_IN_TTL_MS;
    state.config = { ok: false, unavailable: "notRegistered" };
    await expect(signIn.settingsFor(PATHIX)).rejects.toBeInstanceOf(SignInUnavailableError);

    expect(await connections.get(ORG, HOST)).toEqual({ kind: "notConfigured" });
  });
});

describe("storedSignIn", () => {
  const CONFIRMED = bindingFor(signInSettings());

  it("is signed in with an unexpired token minted for this Pathix under the confirmed binding, and names the account", () => {
    expect(storedSignIn(token(), CONFIRMED, PATHIX, 1_000)).toEqual({ signedIn: true, account: "user@contoso.com" });
  });

  it.each([
    ["no token", undefined, CONFIRMED, PATHIX],
    ["a token minted for another Pathix address", token({ pathixUrl: "https://pathix.fabrikam.com" }), CONFIRMED, PATHIX],
    ["a token with no address, stored by an earlier build", { token: "legacy", expiresAt: 2_000 }, CONFIRMED, PATHIX],
    ["an expired token", token({ expiresAt: 1_000 }), CONFIRMED, PATHIX],
    ["no saved address", token(), CONFIRMED, null],
    ["something that is not a token", "a string", CONFIRMED, PATHIX],
    ["no confirmed binding (signed out, or a token an earlier build kept)", token(), undefined, PATHIX],
    ["a binding for other settings", token(), { ...CONFIRMED, clientId: "50000000-0000-4000-8000-000000000005" }, PATHIX],
  ])("is not signed in with %s", (_label, stored, binding, pathixUrl) => {
    expect(storedSignIn(stored, binding, pathixUrl, 1_000)).toEqual({ signedIn: false, account: null });
  });
});

// Review R7: silent renewal for a browser signed in to several Entra accounts.
describe("PathixSignIn: the account a silent renewal names", () => {
  const hintOf = (url: string) => new URL(url).searchParams.get("login_hint");

  it("keeps the signed-in account from Sign in, and names it on every background renewal", async () => {
    const { state, deps, signIn } = world({ binding: null, grant: jwt({ scp: "Pathix.Read", preferred_username: "dana@contoso.com", upn: "dana@contoso.com" }) });
    const settings = await signIn.settingsFor(PATHIX);
    await signIn.confirm(settings);
    expect(state.binding).toMatchObject({ loginHint: "dana@contoso.com" });
    expect(deps.launch.mock.calls.map(([url]) => hintOf(url))).toEqual([null]);

    await signIn.token(settings, { interactive: false, ignoreCache: true });
    const renewal = deps.launch.mock.calls.at(-1)!;
    expect(renewal[1]).toBe(false);
    expect(new URL(renewal[0]).searchParams.get("prompt")).toBe("none");
    expect(hintOf(renewal[0])).toBe("dana@contoso.com");
  });

  it("prefers the token's own login_hint claim", async () => {
    const { state, signIn } = world({ binding: null, grant: jwt({ scp: "Pathix.Read", login_hint: "O.opaque-hint", upn: "dana@contoso.com" }) });
    await signIn.confirm(await signIn.settingsFor(PATHIX));
    expect(state.binding).toMatchObject({ loginHint: "O.opaque-hint" });
  });

  it("names none for a binding an earlier build wrote, and still renews", async () => {
    const { deps, signIn } = world();
    expect(await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false })).toMatchObject({ kind: "token" });
    expect(hintOf(deps.launch.mock.calls[0]![0])).toBeNull();
  });

  it("is gone after sign out, with the binding, and nothing renews", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    await signIn.confirm(settings);
    await signIn.signOut();
    expect(state.binding).toBeNull();
    deps.launch.mockClear();
    expect(await signIn.token(settings, { interactive: false })).toMatchObject({ kind: "signedOut" });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("is gone with a new address", async () => {
    const { state, signIn } = world({ binding: null });
    await signIn.confirm(await signIn.settingsFor(PATHIX));
    await signIn.forget();
    expect(state.binding).toBeNull();
  });

  it("is replaced when the user signs in again as someone else", async () => {
    const { state, signIn } = world({ binding: null, grant: jwt({ scp: "Pathix.Read", upn: "dana@contoso.com" }) });
    const settings = await signIn.settingsFor(PATHIX);
    await signIn.confirm(settings);
    state.grant = jwt({ scp: "Pathix.Read", upn: "lee@contoso.com" });
    await signIn.confirm(settings);
    expect(state.binding).toMatchObject({ loginHint: "lee@contoso.com" });
  });
});

// Review L6: Entra can answer a silent request for another account in the browser.
describe("PathixSignIn: a renewal for another account", () => {
  async function confirmedAs(upn: string) {
    const w = world({ binding: null, grant: jwt({ scp: "Pathix.Read", upn }) });
    const settings = await w.signIn.settingsFor(PATHIX);
    await w.signIn.confirm(settings);
    return { ...w, settings };
  }

  // Review round 2, M2: signed out with its own reason, the token cleared, and no silent retry.
  it("signs the user out with its own reason, clears the token and asks Entra nothing more until Sign in", async () => {
    const onUnavailable = vi.fn();
    const w = world({ binding: null, grant: jwt({ scp: "Pathix.Read", upn: "dana@contoso.com" }), onUnavailable });
    const settings = await w.signIn.settingsFor(PATHIX);
    await w.signIn.confirm(settings);
    w.state.grant = jwt({ scp: "Pathix.Read", upn: "lee@contoso.com" });
    const result = await w.signIn.token(settings, { interactive: false, ignoreCache: true });
    expect(result).toEqual({ kind: "signedOut", reason: OTHER_ACCOUNT_TEXT });
    expect(OTHER_ACCOUNT_TEXT).toBe("Microsoft Entra answered for a different account. Sign in again on the options page.");
    expect(tokenFrom(result)).toBeNull();
    expect(w.state.held).toBeNull();
    expect(w.state.binding).toBeNull();
    expect(onUnavailable).toHaveBeenCalled();

    // A later card asks again: no silent round trip runs.
    w.deps.launch.mockClear();
    expect(await w.signIn.token(settings, { interactive: false })).toMatchObject({ kind: "signedOut" });
    expect(w.deps.launch).not.toHaveBeenCalled();

    // Sign in on the options page starts over, as the account the user picks.
    expect(await w.signIn.confirm(settings)).toMatchObject({ kind: "token" });
    expect(w.state.binding).toMatchObject({ loginHint: "lee@contoso.com" });
  });

  it("is kept for the same account, whatever the case", async () => {
    const { state, signIn, settings } = await confirmedAs("dana@contoso.com");
    state.grant = jwt({ scp: "Pathix.Read", upn: "Dana@Contoso.com" });
    expect(await signIn.token(settings, { interactive: false, ignoreCache: true })).toMatchObject({ kind: "token" });
    expect(state.held?.token).toBe(state.grant);
  });

  it("is kept when the token names no account to compare", async () => {
    const { state, signIn, settings } = await confirmedAs("dana@contoso.com");
    state.grant = jwt({ scp: "Pathix.Read" });
    expect(await signIn.token(settings, { interactive: false, ignoreCache: true })).toMatchObject({ kind: "token" });
  });
});

describe("PathixSignIn: the confirmed binding", () => {
  it("with no binding, a silent sign-in asks Entra nothing and is signed out", async () => {
    const { deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    expect(await signIn.token(settings, { interactive: false })).toMatchObject({ kind: "signedOut" });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("with no binding, the background card path is signed out and never reaches Pathix", async () => {
    const { deps, signIn } = world({ binding: null });
    const pathix = vi.fn(async () => Response.json([]));
    const read = await apiGet(PATHIX, "/environments", signIn.tokenSource(await signIn.settingsFor(PATHIX)), pathix as unknown as typeof fetch);
    expect(read).toEqual({ ok: false, kind: "signedOut" });
    expect(deps.launch).not.toHaveBeenCalled();
    expect(pathix).not.toHaveBeenCalled();
  });

  it("with no binding, a token an earlier build stored is not used", async () => {
    const { state, deps, signIn } = world({ binding: null });
    state.held = token({ expiresAt: 99 * MINUTE });
    expect(await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false })).toMatchObject({ kind: "signedOut" });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("is written by an interactive sign-in that succeeds, and then silent sign-in runs", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    expect(await signIn.token(settings, { interactive: true })).toMatchObject({ kind: "token" });
    expect(state.binding).toEqual({ pathixUrl: PATHIX, authority: AUTHORITY, tenantId: TENANT, clientId: EXTENSION_CLIENT, apiScope: READ, loginHint: "user@contoso.com" });
    expect(await signIn.token(settings, { interactive: false, ignoreCache: true })).toMatchObject({ kind: "token" });
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });

  it("is not written by an interactive sign-in that fails or is refused", async () => {
    const refused = world({ binding: null, grant: BROAD_GRANT });
    await refused.signIn.token(await refused.signIn.settingsFor(PATHIX), { interactive: true });
    expect(refused.state.binding).toBeNull();

    const failed = world({ binding: null });
    failed.deps.launch.mockRejectedValue(new Error("The sign-in window closed without a response."));
    expect(await failed.signIn.token(await failed.signIn.settingsFor(PATHIX), { interactive: true })).toMatchObject({ kind: "signedOut" });
    expect(failed.state.binding).toBeNull();
  });

  it("for other settings holds silent sign-in: a new tenant, sign-in host, client or scope waits for a click", async () => {
    const OTHER_TENANT = "90000000-0000-4000-8000-000000000009";
    for (const changed of [
      { authority: `https://login.microsoftonline.com/${OTHER_TENANT}`, tenantId: OTHER_TENANT },
      { authority: `https://login.microsoftonline.us/${TENANT}` },
      { clientId: "50000000-0000-4000-8000-000000000005" },
      { apiScope: "api://99999999-0000-4000-8000-000000000009/Pathix.Read" },
    ]) {
      const { deps, signIn } = world({ binding: { ...bindingFor(signInSettings()), ...changed } });
      expect(await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false })).toMatchObject({ kind: "signedOut" });
      expect(deps.launch).not.toHaveBeenCalled();
    }
  });

  it("says what changed for the same address, and nothing for another address", async () => {
    const OTHER_TENANT = "90000000-0000-4000-8000-000000000009";
    const moved = world({
      binding: { ...bindingFor(signInSettings()), authority: `https://login.microsoftonline.us/${OTHER_TENANT}`, tenantId: OTHER_TENANT },
    });
    expect(await moved.signIn.confirmation(signInSettings())).toEqual({
      offered: bindingFor(signInSettings()),
      confirmed: false,
      changes: ["tenant", "signInHost"],
    });
    const other = world({ binding: bindingFor(signInSettings("https://pathix.fabrikam.com")) });
    expect(await other.signIn.confirmation(signInSettings())).toMatchObject({ confirmed: false, changes: [] });
    const same = world();
    expect(await same.signIn.confirmation(signInSettings())).toMatchObject({ confirmed: true, changes: [] });
  });
});

describe("PathixSignIn: sign out", () => {
  it("removes the token and the binding, and nothing signs in again until the user does", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    await signIn.token(settings, { interactive: false });
    expect(state.held).not.toBeNull();

    await signIn.signOut();
    expect(state.held).toBeNull();
    expect(state.binding).toBeNull();
    state.now += 10 * MINUTE;
    expect(await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false })).toMatchObject({ kind: "signedOut" });
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it("keeps no token from a silent sign-in that was running when the user signed out", async () => {
    const { state, deps, signIn } = world();
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const background = signIn.token(settings, { interactive: false });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));

    await signIn.signOut();
    entra.open();
    expect(await background).toEqual({ kind: "notKept", signedOut: true });
    expect(state.held).toBeNull();
    expect(state.binding).toBeNull();
  });

  it("keeps no token or binding from an interactive sign-in that was running when the user signed out", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const clicked = signIn.token(settings, { interactive: true });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));

    await signIn.signOut();
    entra.open();
    expect(await clicked).toEqual({ kind: "notKept", signedOut: true });
    expect(state.held).toBeNull();
    expect(state.binding).toBeNull();
  });

  it("does not share a sign-in that started before it with a request after it", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const before = signIn.token(settings, { interactive: true });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));
    await signIn.signOut();
    const after = signIn.token(settings, { interactive: true });
    entra.open();
    expect(await before).toEqual({ kind: "notKept", signedOut: true });
    expect(await after).toMatchObject({ kind: "token" });
  });
});

// Review round 1: Sign in never takes a cached token, so it always leaves a
// binding for the settings the page showed.
describe("PathixSignIn: the options page's Sign in", () => {
  it("writes the binding even when a usable token is already stored", async () => {
    const { state, deps, signIn } = world({ binding: null });
    state.held = token({ expiresAt: 99 * MINUTE });
    const settings = await signIn.settingsFor(PATHIX);
    expect(await signIn.confirm(settings)).toMatchObject({ kind: "token" });
    expect(deps.launch).toHaveBeenCalled();
    expect(state.binding).toEqual({ ...bindingFor(settings), loginHint: "user@contoso.com" });
  });

  it("replaces a binding for other settings with the one it signed in with", async () => {
    const { state, signIn } = world({ binding: { ...bindingFor(signInSettings()), clientId: "50000000-0000-4000-8000-000000000005" } });
    const settings = await signIn.settingsFor(PATHIX);
    await signIn.confirm(settings);
    expect(state.binding).toEqual({ ...bindingFor(settings), loginHint: "user@contoso.com" });
  });

  it("says a sign-in was not kept because of a sign-out, not because settings changed", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const clicked = signIn.confirm(settings);
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));
    await signIn.signOut();
    entra.open();
    expect(await clicked).toEqual({ kind: "notKept", signedOut: true });
    expect(SIGNED_OUT_TEXT).toBe("You signed out before sign-in finished.");
  });

  it("says settings changed when they did, with no sign-out", async () => {
    const { state, deps, signIn } = world({ binding: null });
    const settings = await signIn.settingsFor(PATHIX);
    const entra = gate();
    state.launchGate = entra.promise;
    const clicked = signIn.confirm(settings);
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(1));
    state.config = configFor("50000000-0000-4000-8000-000000000005");
    await signIn.settingsFor(PATHIX, { fresh: true });
    entra.open();
    expect(await clicked).toEqual({ kind: "notKept" });
  });
});

describe("PathixSignIn: a new address", () => {
  it("removes the token, the binding and any refusal", async () => {
    const { state, signIn } = world();
    await signIn.token(await signIn.settingsFor(PATHIX), { interactive: false });
    state.refusal = { pathixUrl: PATHIX, authority: AUTHORITY, clientId: EXTENSION_CLIENT, apiScope: READ, reason: "grantsMoreThanRead", at: 0 };
    await signIn.forget();
    expect(state.held).toBeNull();
    expect(state.binding).toBeNull();
    expect(state.refusal).toBeNull();
  });
});
