import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  ENTRA_TIMEOUT_TEXT,
  grantRefusal,
  GrantRefusedError,
  parseRedirect,
  redeemCode,
  TokenError,
  type AccessToken,
  type AuthSettings,
} from "../src/auth/authorize";
import { bindingFor, isBinding, loginHintOf, sameBinding, withLoginHint } from "../src/auth/binding";
import { accountName, grantedScopes, loginHintClaim, tokenClaims } from "../src/auth/claims";
import { codeChallenge, createCodeVerifier } from "../src/auth/pkce";
import { getAccessToken, isTokenFor, OTHER_ACCOUNT_TEXT, TokenSession, type TokenDeps } from "../src/auth/session";
import { authSettingsFrom, fetchAuthConfig } from "../src/pathix/api";

const settings: AuthSettings = {
  pathixUrl: "https://pathix.contoso.com",
  authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001/",
  clientId: "abcdef12-3456-4789-8abc-def012345678",
  apiScope: "api://20000000-0000-4000-8000-000000000002/Pathix.Read",
  redirectUri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
};

type Binding = Pick<AccessToken, "pathixUrl" | "authority" | "clientId" | "scope">;

/** A token as the worker stores it: minted for `settings` unless told otherwise. */
function stored(token: string, expiresAt: number, mintedFor: Partial<Binding> = {}): AccessToken {
  return {
    token,
    expiresAt,
    pathixUrl: settings.pathixUrl,
    authority: settings.authority,
    clientId: settings.clientId,
    scope: settings.apiScope,
    ...mintedFor,
  };
}

/** An unsigned JWT with these claims. The extension reads claims; it never verifies a token. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

const READ_TOKEN = jwt({ scp: "Pathix.Read", upn: "user@contoso.com" });

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B example", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates url-safe verifiers of a legal length that do not repeat", () => {
    const a = createCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createCodeVerifier()).not.toBe(a);
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks for an auth code with PKCE for the Pathix API scope only", () => {
    const url = new URL(buildAuthorizeUrl(settings, { state: "s1", codeChallenge: "c1", silent: false }));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: settings.clientId,
      response_type: "code",
      redirect_uri: settings.redirectUri,
      response_mode: "query",
      scope: settings.apiScope,
      state: "s1",
      code_challenge: "c1",
      code_challenge_method: "S256",
    });
  });

  it("never asks for a refresh token", () => {
    const url = buildAuthorizeUrl(settings, { state: "s", codeChallenge: "c", silent: false });
    expect(url).not.toContain("offline_access");
  });

  it("forbids UI on a silent request", () => {
    const url = new URL(buildAuthorizeUrl(settings, { state: "s", codeChallenge: "c", silent: true }));
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  // Review R7: with several Entra accounts in the browser, prompt=none needs to name one.
  it("names the confirmed account on a silent request, and only there", () => {
    const silent = new URL(buildAuthorizeUrl(settings, { state: "s", codeChallenge: "c", silent: true, loginHint: "user@contoso.com" }));
    expect(silent.searchParams.get("login_hint")).toBe("user@contoso.com");
    expect(silent.searchParams.get("prompt")).toBe("none");
    const interactive = new URL(buildAuthorizeUrl(settings, { state: "s", codeChallenge: "c", silent: false, loginHint: "user@contoso.com" }));
    expect(interactive.searchParams.has("login_hint")).toBe(false);
  });

  it.each([
    "https://login.evil.example/10000000-0000-4000-8000-000000000001",
    "http://login.microsoftonline.com/10000000-0000-4000-8000-000000000001",
    "https://login.microsoftonline.com/common",
    "https://login.microsoftonline.com:8443/10000000-0000-4000-8000-000000000001",
  ])("never sends the user or a code to an authority that is not Entra's: %s", async (authority) => {
    expect(() => buildAuthorizeUrl({ ...settings, authority }, { state: "s", codeChallenge: "c", silent: false })).toThrow(
      "not a Microsoft Entra sign-in address",
    );
    const fetchFn = vi.fn(async () => Response.json({ access_token: READ_TOKEN, expires_in: 3600 }));
    await expect(redeemCode({ ...settings, authority }, "c", "v", fetchFn as unknown as typeof fetch, () => 0)).rejects.toThrow(
      "not a Microsoft Entra sign-in address",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("parseRedirect", () => {
  const base = settings.redirectUri;

  it("returns the code when the state matches", () => {
    expect(parseRedirect(`${base}?code=abc&state=s1`, "s1")).toEqual({ ok: true, code: "abc" });
  });

  it("refuses a response whose state does not match", () => {
    expect(parseRedirect(`${base}?code=abc&state=other`, "s1")).toMatchObject({ ok: false, error: "state_mismatch" });
  });

  it("surfaces Entra's error, such as a silent request that needs sign-in", () => {
    const result = parseRedirect(`${base}?error=login_required&error_description=AADSTS50058&state=s1`, "s1");
    expect(result).toEqual({ ok: false, error: "login_required", description: "AADSTS50058" });
  });

  it("treats a response without a code as an error", () => {
    expect(parseRedirect(`${base}?state=s1`, "s1")).toMatchObject({ ok: false, error: "missing_code" });
  });
});

describe("redeemCode", () => {
  // Review L1: a token endpoint that never answers left a sign-in hanging.
  describe("when Entra does not answer in time", () => {
    const expired = () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const hangs = (init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });

    it("gives the token endpoint 15 seconds by default, and sends the signal", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ access_token: READ_TOKEN, expires_in: 3600 }));
      await redeemCode(settings, "c", "v", fetchFn as unknown as typeof fetch, () => 0);
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(fetchFn.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
      timeout.mockRestore();
    });

    it("throws a token error that says so when the answer never comes", async () => {
      const fetchFn = vi.fn((_url: string, init?: RequestInit) => hangs(init));
      const failure = redeemCode(settings, "c", "v", fetchFn as unknown as typeof fetch, () => 0, expired);
      await expect(failure).rejects.toBeInstanceOf(TokenError);
      await expect(failure).rejects.toMatchObject({ code: "timeout", message: ENTRA_TIMEOUT_TEXT });
      expect(ENTRA_TIMEOUT_TEXT).toBe("Microsoft Entra did not answer in time.");
    });

    it("throws the same when the body never finishes", async () => {
      const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, status: 200, json: () => hangs(init) }) as unknown as Response);
      await expect(redeemCode(settings, "c", "v", fetchFn as unknown as typeof fetch, () => 0, expired)).rejects.toMatchObject({ code: "timeout" });
    });

    it("leaves the user signed out with that reason, and stores nothing", async () => {
      const save = vi.fn(async () => true);
      const result = await getAccessToken(
        settings,
        {
          launch: async (url) => `${settings.redirectUri}?code=c&state=${new URL(url).searchParams.get("state")}`,
          redeem: (s, code, verifier) => redeemCode(s, code, verifier, ((_url: string, init?: RequestInit) => hangs(init)) as unknown as typeof fetch, () => 0, expired),
          load: async () => null,
          save,
          clear: async () => undefined,
          now: () => 0,
        },
        { interactive: false },
      );
      expect(result).toEqual({ kind: "signedOut", reason: ENTRA_TIMEOUT_TEXT });
      expect(save).not.toHaveBeenCalled();
    });
  });

  it("posts the code and verifier to the token endpoint, dates the token and stamps what it was minted for", async () => {
    const fetchFn = vi.fn(async () => Response.json({ access_token: READ_TOKEN, expires_in: 3600 }));
    const token = await redeemCode(settings, "code1", "verifier1", fetchFn as unknown as typeof fetch, () => 1_000);

    expect(token).toEqual({
      token: READ_TOKEN,
      expiresAt: 1_000 + 3_600_000,
      pathixUrl: settings.pathixUrl,
      authority: settings.authority,
      clientId: settings.clientId,
      scope: settings.apiScope,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001/oauth2/v2.0/token");
    const body = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(body).toEqual({
      client_id: settings.clientId,
      grant_type: "authorization_code",
      code: "code1",
      redirect_uri: settings.redirectUri,
      code_verifier: "verifier1",
      scope: settings.apiScope,
    });
  });

  it("throws Entra's error code when redemption fails", async () => {
    const fetchFn = async () =>
      Response.json({ error: "invalid_grant", error_description: "AADSTS9002327" }, { status: 400 });
    await expect(redeemCode(settings, "c", "v", fetchFn as unknown as typeof fetch, () => 0)).rejects.toEqual(
      new TokenError("invalid_grant", "AADSTS9002327"),
    );
  });
});

// Entra can put every scope consented for the resource in the token, not only
// the one asked for. The extension keeps a token only when it grants
// Pathix.Read and nothing else.
describe("the scopes Entra granted", () => {
  const redeemed = (accessToken: string) =>
    redeemCode(settings, "c", "v", (async () => Response.json({ access_token: accessToken, expires_in: 3600 })) as unknown as typeof fetch, () => 0);

  it("keeps a token that grants Pathix.Read alone", async () => {
    expect(grantRefusal(READ_TOKEN)).toBeNull();
    await expect(redeemed(READ_TOKEN)).resolves.toMatchObject({ token: READ_TOKEN });
  });

  it.each([
    ["Pathix.Access and Pathix.Read", "Pathix.Access Pathix.Read"],
    ["Pathix.Read and Pathix.Access", "Pathix.Read  Pathix.Access"],
    ["Pathix.Access alone", "Pathix.Access"],
    ["Pathix.Read and another scope", "Pathix.Read Pathix.Write"],
  ])("refuses a token that grants %s: more than read access", async (_label, scp) => {
    const token = jwt({ scp });
    expect(grantRefusal(token)).toBe("grantsMoreThanRead");
    await expect(redeemed(token)).rejects.toEqual(new GrantRefusedError("grantsMoreThanRead"));
  });

  it.each([
    ["an empty scp", jwt({ scp: "" })],
    ["a blank scp", jwt({ scp: "   " })],
    ["no scp", jwt({ upn: "user@contoso.com" })],
    ["an scp that is not a string", jwt({ scp: ["Pathix.Read"] })],
    ["a token that is not a JWT", "opaque-token"],
  ])("refuses a token with %s: the registration looks wrong", async (_label, token) => {
    expect(grantRefusal(token)).toBe("invalidRegistration");
    await expect(redeemed(token)).rejects.toEqual(new GrantRefusedError("invalidRegistration"));
  });
});

describe("token claims", () => {
  it("reads the user's name for display, from upn, then preferred_username, then unique_name", () => {
    expect(accountName(READ_TOKEN)).toBe("user@contoso.com");
    expect(accountName(jwt({ preferred_username: "p@contoso.com", unique_name: "u@contoso.com" }))).toBe("p@contoso.com");
    expect(accountName(jwt({ unique_name: "u@contoso.com" }))).toBe("u@contoso.com");
    expect(accountName(jwt({}))).toBeNull();
  });

  it("reads a name with characters beyond ASCII as written, since the payload is UTF-8", () => {
    expect(accountName(jwt({ upn: "josé.müller@contoso.com" }))).toBe("josé.müller@contoso.com");
    expect(accountName(jwt({ preferred_username: "王@contoso.com" }))).toBe("王@contoso.com");
  });

  it("reads the granted scopes from scp", () => {
    expect(grantedScopes(jwt({ scp: " Pathix.Read  Pathix.Access " }))).toEqual(["Pathix.Read", "Pathix.Access"]);
    expect(grantedScopes(jwt({}))).toEqual([]);
  });

  it("refuses a token whose scp is corrupted (not valid UTF-8)", () => {
    const broken = Buffer.concat([Buffer.from('{"scp":"Pathix.Read\\u0020'), Buffer.from([0xff]), Buffer.from('"}')]).toString("base64url");
    const token = `a.${broken}.c`;
    expect(grantedScopes(token)).not.toEqual(["Pathix.Read"]);
    expect(grantRefusal(token)).not.toBeNull();
  });

  it("reads nothing from a token that is not a JWT", () => {
    expect(tokenClaims("opaque")).toBeNull();
    expect(tokenClaims("a.!!!.c")).toBeNull();
    expect(tokenClaims(`a.${Buffer.from("[1]").toString("base64url")}.c`)).toBeNull();
    expect(accountName("opaque")).toBeNull();
  });
});

// Review R7: the account a silent renewal names.
describe("the sign-in hint", () => {
  it("is the token's login_hint claim, else preferred_username, else upn", () => {
    expect(loginHintClaim(jwt({ login_hint: "O.CiQx", preferred_username: "p@contoso.com", upn: "u@contoso.com" }))).toBe("O.CiQx");
    expect(loginHintClaim(jwt({ preferred_username: "p@contoso.com", upn: "u@contoso.com" }))).toBe("p@contoso.com");
    expect(loginHintClaim(jwt({ upn: "u@contoso.com" }))).toBe("u@contoso.com");
  });

  it("is null when no claim is a short, printable name", () => {
    expect(loginHintClaim(jwt({}))).toBeNull();
    expect(loginHintClaim(jwt({ unique_name: "u@contoso.com" }))).toBeNull();
    expect(loginHintClaim(jwt({ upn: "" }))).toBeNull();
    expect(loginHintClaim(jwt({ upn: "a b@contoso.com" }))).toBeNull();
    expect(loginHintClaim(jwt({ upn: "u@contoso.com\n" }))).toBeNull();
    expect(loginHintClaim(jwt({ upn: "a".repeat(300) + "@contoso.com" }))).toBeNull();
    expect(loginHintClaim(jwt({ upn: 42 }))).toBeNull();
    expect(loginHintClaim("opaque")).toBeNull();
  });

  const source = { pathixUrl: settings.pathixUrl, authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001", clientId: settings.clientId, apiScope: settings.apiScope };

  it("rides on the binding without changing what the user confirmed", () => {
    const confirmed = bindingFor(source);
    const hinted = withLoginHint(confirmed, "user@contoso.com");
    expect(hinted).toEqual({ ...confirmed, loginHint: "user@contoso.com" });
    expect(isBinding(hinted)).toBe(true);
    expect(sameBinding(hinted, confirmed)).toBe(true);
    expect(withLoginHint(hinted, null)).toEqual(confirmed);
  });

  it("makes a binding with any other extra key, or a bad hint, not a binding", () => {
    const confirmed = bindingFor(source);
    expect(isBinding({ ...confirmed, extra: "x" })).toBe(false);
    expect(isBinding({ ...confirmed, loginHint: "" })).toBe(false);
    expect(isBinding({ ...confirmed, loginHint: 7 })).toBe(false);
    expect(isBinding({ ...confirmed, loginHint: "a b" })).toBe(false);
  });

  it("is given only for the settings the binding is for", () => {
    const stored = withLoginHint(bindingFor(source), "user@contoso.com");
    expect(loginHintOf(stored, source)).toBe("user@contoso.com");
    expect(loginHintOf(stored, { ...source, clientId: "99999999-0000-4000-8000-000000000009" })).toBeNull();
    expect(loginHintOf(stored, { ...source, authority: "https://login.microsoftonline.com/99999999-0000-4000-8000-000000000009" })).toBeNull();
    expect(loginHintOf(stored, { ...source, pathixUrl: "https://pathix.fabrikam.com" })).toBeNull();
    expect(loginHintOf(bindingFor(source), source)).toBeNull();
    expect(loginHintOf(null, source)).toBeNull();
  });
});

describe("getAccessToken", () => {
  function deps(overrides: Partial<TokenDeps> = {}): TokenDeps & { saved: unknown[]; launches: Array<[string, boolean]> } {
    const saved: unknown[] = [];
    const launches: Array<[string, boolean]> = [];
    return {
      saved,
      launches,
      async launch(url, interactive) {
        launches.push([url, interactive]);
        const state = new URL(url).searchParams.get("state");
        return `${settings.redirectUri}?code=fresh&state=${state}`;
      },
      redeem: async () => stored("fresh-token", 10_000_000),
      load: async () => null,
      save: async (token) => {
        saved.push(token);
        return true;
      },
      clear: async () => undefined,
      now: () => 1_000_000,
      ...overrides,
    };
  }

  it("returns a cached token that is not about to expire, without launching anything", async () => {
    const d = deps({ load: async () => stored("cached", 1_000_000 + 10 * 60_000) });
    expect(await getAccessToken(settings, d, { interactive: false })).toEqual({
      kind: "token",
      token: stored("cached", 1_000_000 + 10 * 60_000),
    });
    expect(d.launches).toEqual([]);
  });

  it("renews silently when the cached token is close to expiry", async () => {
    const d = deps({ load: async () => stored("old", 1_000_000 + 30_000) });
    const result = await getAccessToken(settings, d, { interactive: false });
    expect(result).toMatchObject({ kind: "token", token: { token: "fresh-token" } });
    expect(d.launches).toHaveLength(1);
    expect(d.launches[0]![1]).toBe(false);
    expect(new URL(d.launches[0]![0]).searchParams.get("prompt")).toBe("none");
    expect(d.saved).toEqual([stored("fresh-token", 10_000_000)]);
  });

  it.each([
    ["another client ID", stored("other-client", 99_999_999, { clientId: "99999999-0000-4000-8000-000000000009" })],
    ["the web app's Pathix.Access scope", stored("access", 99_999_999, { scope: "api://20000000-0000-4000-8000-000000000002/Pathix.Access" })],
    ["another Pathix address", stored("other-pathix", 99_999_999, { pathixUrl: "https://pathix.fabrikam.com" })],
    ["another authority", stored("other-tenant", 99_999_999, { authority: "https://login.microsoftonline.com/other-tenant" })],
    ["nothing, stored by an earlier build", { token: "legacy", expiresAt: 99_999_999 } as unknown as AccessToken],
    ["the right client and scope but no address or authority", { token: "unbound", expiresAt: 99_999_999, clientId: settings.clientId, scope: settings.apiScope } as unknown as AccessToken],
  ])("never reuses a cached token minted for %s: it signs in again and keeps the new one", async (_label, cached) => {
    const d = deps({ load: async () => cached });
    const result = await getAccessToken(settings, d, { interactive: false });
    expect(result).toEqual({ kind: "token", token: stored("fresh-token", 10_000_000) });
    expect(d.launches).toHaveLength(1);
    expect(d.saved).toEqual([stored("fresh-token", 10_000_000)]);
  });

  it("skips the cache when asked to renew after a 401", async () => {
    const d = deps({ load: async () => stored("cached", 99_999_999) });
    await getAccessToken(settings, d, { interactive: false, ignoreCache: true });
    expect(d.launches).toHaveLength(1);
  });

  it("stays signed out without opening a window when silent sign-in needs the user", async () => {
    const d = deps({
      launch: async (url, interactive) => {
        d.launches.push([url, interactive]);
        return `${settings.redirectUri}?error=login_required&state=${new URL(url).searchParams.get("state")}`;
      },
    });
    expect(await getAccessToken(settings, d, { interactive: false })).toEqual({
      kind: "signedOut",
      reason: "login_required",
    });
    expect(d.launches.map(([, interactive]) => interactive)).toEqual([false]);
  });

  // Review R7.
  it("names the confirmed account on a background renewal", async () => {
    const d = deps({ load: async () => stored("old", 1_000_000 + 30_000), loginHint: async () => "user@contoso.com" });
    await getAccessToken(settings, d, { interactive: false });
    const url = new URL(d.launches[0]![0]);
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.get("login_hint")).toBe("user@contoso.com");
  });

  // Review L7: the hint comes only from a binding for these exact settings.
  it("names no account when the binding is for settings that have since changed", async () => {
    const source = { pathixUrl: settings.pathixUrl, authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001", clientId: settings.clientId, apiScope: settings.apiScope };
    const binding = withLoginHint(bindingFor({ ...source, clientId: "99999999-0000-4000-8000-000000000009" }), "user@contoso.com");
    const changed = { ...settings, authority: source.authority };
    const d = deps({ load: async () => stored("old", 1_000_000 + 30_000), loginHint: async (current) => loginHintOf(binding, current) });
    await getAccessToken(changed, d, { interactive: false });
    expect(new URL(d.launches[0]![0]).searchParams.has("login_hint")).toBe(false);
  });

  it("names no account when the user asked to sign in, so with several accounts they still pick one", async () => {
    let calls = 0;
    const loginHint = vi.fn(async () => "user@contoso.com");
    const d = deps({
      loginHint,
      launch: async (url, interactive) => {
        d.launches.push([url, interactive]);
        calls += 1;
        const state = new URL(url).searchParams.get("state");
        return calls === 1 ? `${settings.redirectUri}?error=interaction_required&state=${state}` : `${settings.redirectUri}?code=fresh&state=${state}`;
      },
    });
    await getAccessToken(settings, d, { interactive: true });
    expect(d.launches.map(([url]) => new URL(url).searchParams.has("login_hint"))).toEqual([false, false]);
    expect(loginHint).not.toHaveBeenCalled();
  });

  it("falls back to an interactive window only when the user asked to sign in", async () => {
    let calls = 0;
    const d = deps({
      launch: async (url, interactive) => {
        d.launches.push([url, interactive]);
        const state = new URL(url).searchParams.get("state");
        calls += 1;
        return calls === 1
          ? `${settings.redirectUri}?error=interaction_required&state=${state}`
          : `${settings.redirectUri}?code=fresh&state=${state}`;
      },
    });
    const result = await getAccessToken(settings, d, { interactive: true });
    expect(result).toMatchObject({ kind: "token" });
    expect(d.launches.map(([, interactive]) => interactive)).toEqual([false, true]);
    expect(new URL(d.launches[1]![0]).searchParams.get("prompt")).toBeNull();
  });

  it("clears the stored token and reports the reason when the sign-in window throws", async () => {
    const clear = vi.fn(async () => undefined);
    const d = deps({
      clear,
      launch: async () => {
        throw new Error("The user did not approve access.");
      },
    });
    expect(await getAccessToken(settings, d, { interactive: false })).toEqual({
      kind: "signedOut",
      reason: "The user did not approve access.",
    });
    expect(clear).toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps nothing from a grant it refuses, and opens no window for it (interactive: %s)",
    async (interactive) => {
      const clear = vi.fn(async () => undefined);
      const d = deps({
        clear,
        redeem: async () => {
          throw new GrantRefusedError("grantsMoreThanRead");
        },
      });
      expect(await getAccessToken(settings, d, { interactive })).toEqual({ kind: "refused", reason: "grantsMoreThanRead" });
      expect(d.saved).toEqual([]);
      expect(clear).toHaveBeenCalled();
      expect(d.launches.map(([, shown]) => shown)).toEqual([false]);
    },
  );

  it("keeps a token another sign-in saved while this one was failing", async () => {
    let held: AccessToken | null = null;
    const clear = vi.fn(async () => {
      held = null;
    });
    const d = deps({
      load: async () => held,
      clear,
      launch: async (url) => {
        // A sibling sign-in finishes first and saves its token.
        held = stored("sibling", 99_999_999);
        return `${settings.redirectUri}?error=login_required&state=${new URL(url).searchParams.get("state")}`;
      },
    });
    expect(await getAccessToken(settings, d, { interactive: false, ignoreCache: true })).toMatchObject({ kind: "signedOut" });
    expect(clear).not.toHaveBeenCalled();
    expect(held).toEqual(stored("sibling", 99_999_999));
  });

  // The cache check and the failing sign-in compare against the same read: a
  // token another sign-in saves right after the cache check is not taken for
  // the one this sign-in was replacing.
  it("keeps a token another sign-in saved between the cache check and this sign-in", async () => {
    let held: AccessToken | null = null;
    let loads = 0;
    const clear = vi.fn(async () => {
      held = null;
    });
    const d = deps({
      load: async () => {
        loads += 1;
        const answer = held;
        // Right after the first read, a sibling sign-in saves its token.
        if (loads === 1) held = stored("sibling", 99_999_999);
        return answer;
      },
      clear,
      launch: async (url) => `${settings.redirectUri}?error=login_required&state=${new URL(url).searchParams.get("state")}`,
    });
    expect(await getAccessToken(settings, d, { interactive: true })).toMatchObject({ kind: "signedOut" });
    expect(clear).not.toHaveBeenCalled();
    expect(held).toEqual(stored("sibling", 99_999_999));
  });

  it("answers not kept, and opens no window, when the token may not be kept", async () => {
    const d = deps({ save: async () => false });
    expect(await getAccessToken(settings, d, { interactive: true })).toEqual({ kind: "notKept" });
    expect(d.launches.map(([, shown]) => shown)).toEqual([false]);
  });

  it("still clears the token it could not replace", async () => {
    let held: AccessToken | null = stored("rejected", 99_999_999);
    const d = deps({
      load: async () => held,
      clear: async () => {
        held = null;
      },
      launch: async (url) => `${settings.redirectUri}?error=login_required&state=${new URL(url).searchParams.get("state")}`,
    });
    await getAccessToken(settings, d, { interactive: false, ignoreCache: true });
    expect(held).toBeNull();
  });
});

describe("a save that finds another account", () => {
  it("ends signed out with its own reason and clears the stored token", async () => {
    const clear = vi.fn(async () => undefined);
    const result = await getAccessToken(
      settings,
      {
        launch: async (url) => `${settings.redirectUri}?code=c&state=${new URL(url).searchParams.get("state")}`,
        redeem: async () => stored("other", 99_999_999),
        load: async () => null,
        save: async () => "otherAccount" as const,
        clear,
        now: () => 0,
      },
      { interactive: false },
    );
    expect(result).toEqual({ kind: "signedOut", reason: OTHER_ACCOUNT_TEXT });
    expect(clear).toHaveBeenCalled();
  });
});

describe("TokenSession", () => {
  /** Launches wait until released, so calls can overlap. */
  function gated() {
    const launches: Array<[string, boolean]> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps: TokenDeps = {
      async launch(url, interactive) {
        launches.push([url, interactive]);
        await gate;
        return `${settings.redirectUri}?code=fresh&state=${new URL(url).searchParams.get("state")}`;
      },
      redeem: async () => stored("fresh-token", 10_000_000),
      load: async () => null,
      save: async () => true,
      clear: async () => undefined,
      now: () => 1_000_000,
    };
    return { session: new TokenSession(deps), launches, release };
  }

  it("shares one sign-in among callers who ask while it runs", async () => {
    const { session, launches, release } = gated();
    const answers = Promise.all(Array.from({ length: 5 }, () => session.get(settings, { interactive: false })));
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    release();
    const results = await answers;
    expect(launches).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results[0]).toEqual({ kind: "token", token: stored("fresh-token", 10_000_000) });
  });

  it("starts a new sign-in once the shared one has finished", async () => {
    const { session, launches, release } = gated();
    release();
    await session.get(settings, { interactive: false });
    await session.get(settings, { interactive: false });
    expect(launches).toHaveLength(2);
  });

  it("does not hand a user who asked to sign in the answer of a silent sign-in", async () => {
    const { session, launches, release } = gated();
    const silent = session.get(settings, { interactive: false });
    const asked = session.get(settings, { interactive: true });
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    release();
    await Promise.all([silent, asked]);
  });

  it("does not share across Pathix addresses", async () => {
    const { session, launches, release } = gated();
    const one = session.get(settings, { interactive: false });
    const other = session.get({ ...settings, pathixUrl: "https://pathix.fabrikam.com" }, { interactive: false });
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    release();
    await Promise.all([one, other]);
  });
});

describe("isTokenFor", () => {
  it("matches only the Pathix, authority, client ID and scope the token was minted for", () => {
    expect(isTokenFor(stored("t", 1), settings)).toBe(true);
    expect(isTokenFor(stored("t", 1), { ...settings, pathixUrl: "https://pathix.fabrikam.com" })).toBe(false);
    expect(isTokenFor(stored("t", 1), { ...settings, authority: "https://login.microsoftonline.com/other-tenant" })).toBe(false);
    expect(isTokenFor(stored("t", 1), { ...settings, clientId: "99999999-0000-4000-8000-000000000009" })).toBe(false);
    expect(isTokenFor(stored("t", 1), { ...settings, apiScope: "api://20000000-0000-4000-8000-000000000002/Pathix.Access" })).toBe(false);
  });
});

// The whole path from what Pathix serves to what goes to Entra: the extension's
// own client ID and the read-only scope, never the web app's client or Pathix.Access.
describe("signing in with what Pathix /config serves", () => {
  const WEB_APP_CLIENT = "30000000-0000-4000-8000-000000000003";
  const EXTENSION_CLIENT = "40000000-0000-4000-8000-000000000004";
  const READ = "api://20000000-0000-4000-8000-000000000002/Pathix.Read";
  const ACCESS = "api://20000000-0000-4000-8000-000000000002/Pathix.Access";

  async function signInSettings(): Promise<AuthSettings> {
    const fetchFn = async () =>
      Response.json({
        msalEnabled: true,
        azureAd: {
          clientId: WEB_APP_CLIENT,
          tenantId: "10000000-0000-4000-8000-000000000001",
          authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001",
          apiScope: ACCESS,
        },
        license: {},
        branding: null,
        extension: { clientId: EXTENSION_CLIENT, apiScope: READ },
      });
    const result = await fetchAuthConfig("https://pathix.contoso.com", fetchFn as unknown as typeof fetch);
    if (!result.ok) throw new Error(`expected a usable config, got ${result.unavailable}`);
    return authSettingsFrom(result.config, { pathixUrl: "https://pathix.contoso.com", redirectUri: settings.redirectUri });
  }

  it("takes the authority from azureAd and the client ID and scope from extension", async () => {
    expect(await signInSettings()).toEqual({
      pathixUrl: "https://pathix.contoso.com",
      authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001",
      clientId: EXTENSION_CLIENT,
      apiScope: READ,
      redirectUri: settings.redirectUri,
    });
  });

  it("puts the extension's client ID and the Pathix.Read scope on the authorize URL", async () => {
    const url = new URL(buildAuthorizeUrl(await signInSettings(), { state: "s", codeChallenge: "c", silent: false }));
    expect(url.searchParams.get("client_id")).toBe(EXTENSION_CLIENT);
    expect(url.searchParams.get("scope")).toBe(READ);
    expect(url.toString()).not.toContain(WEB_APP_CLIENT);
    expect(url.toString()).not.toContain("Pathix.Access");
  });

  it("puts the extension's client ID and the Pathix.Read scope on the token request", async () => {
    const fetchFn = vi.fn(async () => Response.json({ access_token: READ_TOKEN, expires_in: 3600 }));
    const token = await redeemCode(await signInSettings(), "code1", "verifier1", fetchFn as unknown as typeof fetch, () => 0);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(body.client_id).toBe(EXTENSION_CLIENT);
    expect(body.scope).toBe(READ);
    expect(String(init.body)).not.toContain("Pathix.Access");
    expect(token).toMatchObject({ clientId: EXTENSION_CLIENT, scope: READ });
  });
});
