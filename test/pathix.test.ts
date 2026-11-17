import { describe, expect, it, vi } from "vitest";
import { isExcludedTable, resolveConnection, type Get } from "../src/background/connection";
import { ResponseCache } from "../src/background/cache";
import { statusForError } from "../src/background/sign-in";
import {
  apiGet,
  fetchAuthConfig,
  isWebPage,
  PATHIX_NOT_DATA_TEXT,
  PATHIX_WEB_PAGE_TEXT,
  PATHIX_TIMEOUT_MS,
  PATHIX_TIMEOUT_TEXT,
  REDIRECT_TEXT,
  type EnvironmentSummary,
  type ScanSummary,
} from "../src/pathix/api";
import { findEnvironment, latestCompletedScan, matchEnvironment, SCAN_LIST_CAP } from "../src/pathix/environment-match";
import { stateForConnection } from "../src/card/states";
import { forgetLegacyClientId, LEGACY_CLIENT_ID_KEY, parsePathixUrl, settingsFrom } from "../src/pathix/settings";

const PATHIX = "https://pathix.contoso.com";

const contoso: EnvironmentSummary = {
  id: "env-1",
  name: "Contoso",
  url: "https://contoso.crm.dynamics.com",
  dataverseEnvironmentId: "C0DE0000-0000-4000-8000-000000000001",
};
const other: EnvironmentSummary = {
  id: "env-2",
  name: "Fabrikam",
  url: "https://fabrikam.crm.dynamics.com/",
  dataverseEnvironmentId: "00000000-0000-0000-0000-000000000002",
};

function scan(status: string, completedAt: string | null): ScanSummary {
  return { id: `${status}-${completedAt}`, status, startedAt: "2026-09-01T00:00:00Z", completedAt };
}

describe("parsePathixUrl", () => {
  it("keeps only the origin of what the user pastes", () => {
    expect(parsePathixUrl(" https://pathix.contoso.com/environments?x=1 ")).toEqual({
      ok: true,
      value: "https://pathix.contoso.com",
    });
  });

  it("refuses plain http and non-URLs", () => {
    expect(parsePathixUrl("http://pathix.contoso.com").ok).toBe(false);
    expect(parsePathixUrl("pathix.contoso.com").ok).toBe(false);
  });

  // The origin becomes a host permission request: "https://*" would ask for
  // every site, and "https://*.crm.dynamics.com" for every CRM org.
  it("refuses a wildcard anywhere in the host", () => {
    for (const input of ["https://*", "https://*/", "https://*.crm.dynamics.com", "https://pathix.*.contoso.com"]) {
      expect(parsePathixUrl(input)).toEqual({ ok: false, error: "Enter your Pathix site's own address. It cannot contain *." });
    }
  });

  // A Pathix address on a host the extension already runs on, or signs in
  // through, would put a content script on the Pathix origin (SECURITY.md).
  it.each([
    ["https://contoso.crm.dynamics.com", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://dynamics.com/", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://contoso.crm.DYNAMICS.com./main.aspx", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://contoso.crm9.dynamics.com", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://contoso.crm.microsoftdynamics.us", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://contoso.crm.appsplatform.us", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://contoso.crm.dynamics.cn", "That is a Dynamics 365 address. Enter the address of your Pathix site."],
    ["https://admin.powerplatform.microsoft.com/environments", "That is the Power Platform admin center. Enter the address of your Pathix site."],
    ["https://login.microsoftonline.com", "That is a Microsoft sign-in address. Enter the address of your Pathix site."],
    ["https://login.microsoftonline.us", "That is a Microsoft sign-in address. Enter the address of your Pathix site."],
    ["https://login.partner.microsoftonline.cn", "That is a Microsoft sign-in address. Enter the address of your Pathix site."],
    ["https://login.chinacloudapi.cn", "That is a Microsoft sign-in address. Enter the address of your Pathix site."],
  ])("refuses %s, a Microsoft host", (input, error) => {
    expect(parsePathixUrl(input)).toEqual({ ok: false, error });
  });

  it("keeps a host that only resembles one of Microsoft's", () => {
    for (const input of ["https://pathix-dynamics.com", "https://dynamics.com.contoso.com", "https://pathix.contoso.com:8443", "https://contoso-pathix.azurewebsites.net"]) {
      expect(parsePathixUrl(input)).toEqual({ ok: true, value: new URL(input).origin });
    }
  });
});

describe("settingsFrom", () => {
  it("reads the saved address", () => {
    expect(settingsFrom({ pathixUrl: PATHIX })).toEqual({ pathixUrl: PATHIX });
  });

  it("ignores a client ID an earlier build stored, so those settings keep working", () => {
    expect(LEGACY_CLIENT_ID_KEY).toBe("clientId");
    expect(settingsFrom({ pathixUrl: PATHIX, [LEGACY_CLIENT_ID_KEY]: "abcdef12-3456-4789-8abc-def012345678" })).toEqual({
      pathixUrl: PATHIX,
    });
  });

  it("is null with no address, an empty one, or only a client ID", () => {
    expect(settingsFrom({})).toBeNull();
    expect(settingsFrom({ pathixUrl: "" })).toBeNull();
    expect(settingsFrom({ [LEGACY_CLIENT_ID_KEY]: "abcdef12-3456-4789-8abc-def012345678" })).toBeNull();
  });
});

describe("forgetLegacyClientId", () => {
  it("removes the client ID an earlier build stored when the extension is updated", async () => {
    const remove = vi.fn(async (_key: string) => undefined);
    await forgetLegacyClientId("update", remove);
    expect(remove.mock.calls).toEqual([["clientId"]]);
  });

  it.each(["install", "chrome_update", "shared_module_update"])("leaves storage alone on %s", async (reason) => {
    const remove = vi.fn(async (_key: string) => undefined);
    await forgetLegacyClientId(reason, remove);
    expect(remove).not.toHaveBeenCalled();
  });

  // The worker's listener is tested by importing the worker: test/service-worker.test.ts.
});

describe("matchEnvironment", () => {
  it("matches on the organization id, ignoring case, on the environment's own host", () => {
    expect(matchEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", "Contoso.crm.dynamics.com")).toBe(contoso);
  });

  // The org id comes from the page. A page on one environment that names
  // another's org id gets no environment, never the other's answers.
  it("matches no environment when the organization id is another environment's than the page's host", () => {
    expect(matchEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", "fabrikam.crm.dynamics.com")).toBeNull();
    expect(matchEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", "unrelated.crm.dynamics.com")).toBeNull();
  });

  // Review round 1: the rule stands (no answer across hosts), but the reason is said.
  it("says the organization is known under another address, naming Pathix's stored host only", () => {
    expect(findEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", "contoso.api.crm.dynamics.com")).toEqual({
      kind: "otherHost",
      otherHost: "contoso.crm.dynamics.com",
    });
    expect(findEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com")).toEqual({ kind: "match", environment: contoso });
    expect(findEnvironment([other], "c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com")).toEqual({ kind: "none" });
  });

  // Any script on the page can name an organization id, so an environment
  // Pathix has no usable URL for is never matched on it alone (X1). The reason
  // is said: Pathix lists the organization without an address, never "no
  // environment matches".
  it("does not match on the organization id alone when Pathix has no usable URL for the environment, and says why", () => {
    for (const url of ["", "not a url"]) {
      const noUrl = { ...contoso, url };
      expect(matchEnvironment([noUrl], "c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com")).toBeNull();
      expect(findEnvironment([noUrl], "c0de0000-0000-4000-8000-000000000001", "contoso.crm4.dynamics.com")).toEqual({ kind: "noAddress" });
    }
  });

  it("still matches an environment with no URL on the organization id where there is no page host (the admin center)", () => {
    const noUrl = { ...contoso, url: "" };
    expect(matchEnvironment([noUrl], "c0de0000-0000-4000-8000-000000000001", null)).toBe(noUrl);
  });

  it("matches on the organization id alone where there is no page host to check (the admin center)", () => {
    expect(matchEnvironment([other, contoso], "c0de0000-0000-4000-8000-000000000001", null)).toBe(contoso);
    expect(matchEnvironment([other, contoso], "99999999-0000-0000-0000-000000000000", null)).toBeNull();
  });

  it("falls back to the host when no organization id matches", () => {
    expect(matchEnvironment([contoso, other], "99999999-0000-0000-0000-000000000000", "fabrikam.crm.dynamics.com")).toBe(
      other,
    );
  });

  it("returns null for an org Pathix does not know", () => {
    expect(matchEnvironment([contoso], "99999999-0000-0000-0000-000000000000", "contoso.crm4.dynamics.com")).toBeNull();
  });
});

describe("latestCompletedScan", () => {
  it("picks the newest Completed scan and ignores every other status", () => {
    const scans = [
      scan("Running", null),
      scan("Completed", "2026-09-28T10:00:00Z"),
      scan("Partial", "2026-10-01T10:00:00Z"),
      scan("Completed", "2026-09-30T10:00:00Z"),
      scan("Failed", "2026-10-02T10:00:00Z"),
    ];
    expect(latestCompletedScan(scans)?.completedAt).toBe("2026-09-30T10:00:00Z");
  });

  it("returns null when nothing has completed", () => {
    expect(latestCompletedScan([scan("Running", null)])).toBeNull();
  });
});

describe("fetchAuthConfig", () => {
  const TENANT = "10000000-0000-4000-8000-000000000001";
  const EXTENSION_CLIENT = "40000000-0000-4000-8000-000000000004";
  const READ = "api://20000000-0000-4000-8000-000000000002/Pathix.Read";
  const azureAd = {
    clientId: "30000000-0000-4000-8000-000000000003",
    tenantId: TENANT,
    authority: `https://login.microsoftonline.com/${TENANT}`,
    apiScope: "api://20000000-0000-4000-8000-000000000002/Pathix.Access",
  };

  /** A /config answer: today's shape, with `extension` as given, or no `extension` key at all. */
  function config(extension: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body: Record<string, unknown> = { msalEnabled: true, azureAd, license: {}, branding: null, ...overrides };
    if (extension !== undefined) body.extension = extension;
    return body;
  }

  function read(body: unknown) {
    const fetchFn = vi.fn(async () => Response.json(body));
    return { fetchFn, result: fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch) };
  }

  it("reads the authority from azureAd and the extension's client ID and read scope from extension", async () => {
    const { fetchFn, result } = read(config({ clientId: EXTENSION_CLIENT, apiScope: READ }));
    expect(await result).toEqual({
      ok: true,
      config: {
        tenantId: TENANT,
        authority: `https://login.microsoftonline.com/${TENANT}`,
        clientId: EXTENSION_CLIENT,
        apiScope: READ,
      },
    });
    expect(fetchFn).toHaveBeenCalledWith(`${PATHIX}/api/config`, { cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("never takes the web app's client ID or its Pathix.Access scope", async () => {
    const answer = await read(config({ clientId: EXTENSION_CLIENT, apiScope: READ })).result;
    expect(JSON.stringify(answer)).not.toContain(azureAd.clientId);
    expect(JSON.stringify(answer)).not.toContain("Pathix.Access");
  });

  it("says an older Pathix, one with no extension key, offers no extension sign-in", async () => {
    expect(await read(config(undefined)).result).toEqual({ ok: false, unavailable: "olderPathix" });
  });

  it("says a Pathix whose extension is null has no extension registration", async () => {
    expect(await read(config(null)).result).toEqual({ ok: false, unavailable: "notRegistered" });
  });

  it.each([
    ["a client ID that is not a GUID", { clientId: "pathix-extension", apiScope: READ }],
    ["an empty client ID", { clientId: "", apiScope: READ }],
    ["a client ID that is not a string", { clientId: 42, apiScope: READ }],
    ["no client ID", { apiScope: READ }],
    ["the Pathix.Access scope", { clientId: EXTENSION_CLIENT, apiScope: azureAd.apiScope }],
    ["Pathix.Read with Pathix.Access riding along", { clientId: EXTENSION_CLIENT, apiScope: `${azureAd.apiScope} ${READ}` }],
    ["Pathix.Read with offline_access riding along", { clientId: EXTENSION_CLIENT, apiScope: `offline_access ${READ}` }],
    ["a bare /Pathix.Read with no resource", { clientId: EXTENSION_CLIENT, apiScope: "/Pathix.Read" }],
    ["a scope in the wrong case", { clientId: EXTENSION_CLIENT, apiScope: "api://20000000-0000-4000-8000-000000000002/pathix.read" }],
    ["an empty scope", { clientId: EXTENSION_CLIENT, apiScope: "" }],
    ["no scope", { clientId: EXTENSION_CLIENT }],
    ["an extension that is not an object", "registered"],
    ["an extension that is an array", [EXTENSION_CLIENT, READ]],
    ["the Pathix.Read scope of another API", { clientId: EXTENSION_CLIENT, apiScope: "api://99999999-0000-4000-8000-000000000009/Pathix.Read" }],
    ["the web app's own client ID", { clientId: azureAd.clientId, apiScope: READ }],
    ["the web app's own client ID in capitals", { clientId: azureAd.clientId.toUpperCase(), apiScope: READ }],
  ])("treats %s as an unusable registration", async (_label, extension) => {
    expect(await read(config(extension)).result).toEqual({ ok: false, unavailable: "invalidRegistration" });
  });

  // Pathix derives the read scope from the web app's: the same API, Pathix.Read in place of Pathix.Access.
  it.each([
    ["a web app scope that is not Pathix.Access", { ...azureAd, apiScope: "api://20000000-0000-4000-8000-000000000002/user_impersonation" }],
    ["no web app scope", { ...azureAd, apiScope: undefined }],
  ])("cannot check the read scope against %s, so treats the registration as unusable", async (_label, webApp) => {
    expect(await read(config({ clientId: EXTENSION_CLIENT, apiScope: READ }, { azureAd: webApp })).result).toEqual({
      ok: false,
      unavailable: "invalidRegistration",
    });
  });

  // The authority is where the user's Entra sign-in goes. A look-alike Pathix
  // could name any URL, so only an Entra cloud's own host and the tenant's GUID pass.
  it.each([
    ["the public cloud", "login.microsoftonline.com"],
    ["US Government", "login.microsoftonline.us"],
    ["China (partner host)", "login.partner.microsoftonline.cn"],
    ["China (chinacloudapi host)", "login.chinacloudapi.cn"],
  ])("accepts the authority of %s", async (_label, host) => {
    const body = config({ clientId: EXTENSION_CLIENT, apiScope: READ }, { azureAd: { ...azureAd, authority: `https://${host}/${TENANT}` } });
    expect(await read(body).result).toMatchObject({ ok: true, config: { authority: `https://${host}/${TENANT}` } });
  });

  it.each([
    ["plain http", `http://login.microsoftonline.com/${TENANT}`],
    ["a host that is not Entra's", `https://login.microsoftonline.com.evil.example/${TENANT}`],
    ["a look-alike host", `https://login.microsoft0nline.com/${TENANT}`],
    ["a user name before the host", `https://login.microsoftonline.com@evil.example/${TENANT}`],
    ["a port", `https://login.microsoftonline.com:8443/${TENANT}`],
    ["a query", `https://login.microsoftonline.com/${TENANT}?x=1`],
    ["a fragment", `https://login.microsoftonline.com/${TENANT}#x`],
    ["a trailing slash", `https://login.microsoftonline.com/${TENANT}/`],
    ["a longer path", `https://login.microsoftonline.com/${TENANT}/v2.0`],
    ["another tenant", "https://login.microsoftonline.com/90000000-0000-4000-8000-000000000009"],
    ["a tenant name in place of the GUID", "https://login.microsoftonline.com/contoso.onmicrosoft.com"],
    ["common", "https://login.microsoftonline.com/common"],
    ["a capital in the host", `https://Login.microsoftonline.com/${TENANT}`],
  ])("treats an authority with %s as an unusable registration", async (_label, authority) => {
    const body = config({ clientId: EXTENSION_CLIENT, apiScope: READ }, { azureAd: { ...azureAd, authority } });
    expect(await read(body).result).toEqual({ ok: false, unavailable: "invalidRegistration" });
  });

  it("treats a tenant that is not a GUID as an unusable registration, even with a matching path", async () => {
    const body = config(
      { clientId: EXTENSION_CLIENT, apiScope: READ },
      { azureAd: { ...azureAd, tenantId: "contoso.onmicrosoft.com", authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com" } },
    );
    expect(await read(body).result).toEqual({ ok: false, unavailable: "invalidRegistration" });
  });

  it("refuses to follow a redirect, which reads as Pathix not answering", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("Failed to fetch");
      return Response.json(config({ clientId: EXTENSION_CLIENT, apiScope: READ }));
    });
    await expect(fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch)).rejects.toThrow("Failed to fetch");
  });

  // Review round 1: a redirecting address is said as such, and never followed.
  it("says the address redirects, after one anonymous probe that does not follow it", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("Failed to fetch");
      return { type: "opaqueredirect", ok: false, status: 0 } as unknown as Response;
    });
    await expect(fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch)).rejects.toThrow(REDIRECT_TEXT);
    expect(REDIRECT_TEXT).toBe("Pathix answered with a redirect, for example to a sign-in gateway. The extension needs an address that answers /api/config directly.");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenLastCalledWith(`${PATHIX}/api/config`, { cache: "no-store", redirect: "manual", credentials: "omit", signal: expect.any(AbortSignal) });
  });

  it("passes the first failure on when the probe answers with no redirect", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("Failed to fetch");
      return Response.json({}, { status: 200 });
    });
    await expect(fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch)).rejects.toThrow("Failed to fetch");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("passes the first failure on when the probe fails too", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      throw new TypeError(calls === 1 ? "Failed to fetch" : "probe failed");
    });
    await expect(fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch)).rejects.toThrow("Failed to fetch");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["msalEnabled false (Pathix also sends extension null then)", config(null, { msalEnabled: false, azureAd: { clientId: "", tenantId: "", authority: "", apiScope: "" } })],
    ["no tenant", config({ clientId: EXTENSION_CLIENT, apiScope: READ }, { azureAd: { ...azureAd, tenantId: "" } })],
    ["no authority", config({ clientId: EXTENSION_CLIENT, apiScope: READ }, { azureAd: { ...azureAd, authority: "" } })],
  ])("says a Pathix without Entra sign-in offers none: %s", async (_label, body) => {
    expect(await read(body).result).toEqual({ ok: false, unavailable: "signInOff" });
  });

  it("throws when Pathix does not answer", async () => {
    const failed = async () => new Response("", { status: 502 });
    await expect(fetchAuthConfig(PATHIX, failed as unknown as typeof fetch)).rejects.toThrow("Pathix /config answered 502.");
  });

  // A 200 from something in front of Pathix, such as a proxy's {}, is unknown: never "sign-in is off".
  it.each([
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
    ["no msalEnabled", { azureAd }],
    ["an msalEnabled that is not a boolean", { msalEnabled: "true", azureAd }],
    ["no azureAd", { msalEnabled: true }],
    ["a null azureAd", { msalEnabled: false, azureAd: null }],
    ["an azureAd that is an array", { msalEnabled: true, azureAd: [] }],
  ])("throws on an answer that is not Pathix's settings: %s", async (_label, body) => {
    await expect(read(body).result).rejects.toThrow("Pathix /config did not answer with its settings.");
  });
});

describe("apiGet", () => {
  function tokens(...values: Array<string | null>) {
    const calls: boolean[] = [];
    return {
      calls,
      source: async (renew: boolean) => {
        calls.push(renew);
        return values[calls.length - 1] ?? null;
      },
    };
  }

  function respond(...statuses: number[]) {
    let index = 0;
    return vi.fn(async () => {
      const status = statuses[index++] ?? 500;
      return status === 200 ? Response.json([{ id: "env-1" }]) : new Response(null, { status });
    });
  }

  it("calls <pathix>/api with the bearer token", async () => {
    const fetchFn = respond(200);
    const result = await apiGet(PATHIX, "/environments", tokens("t1").source, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, data: [{ id: "env-1" }] });
    expect(fetchFn).toHaveBeenCalledWith(`${PATHIX}/api/environments`, { headers: { Authorization: "Bearer t1" }, redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("reads a 200 web page as a proxy or sign-in page in the way, never as the parser's error", async () => {
    const page = vi.fn(async () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const result = await apiGet(PATHIX, "/environments", tokens("t1").source, page as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "failed", message: PATHIX_WEB_PAGE_TEXT, status: 200 });
    expect(PATHIX_WEB_PAGE_TEXT).toBe("Pathix answered with a web page, not data. A proxy or sign-in page may be in the way.");
  });

  it("reads a body that is not JSON as not data, without throwing", async () => {
    const garbled = vi.fn(async () => new Response("<html>", { status: 200 }));
    const result = await apiGet(PATHIX, "/environments", tokens("t1").source, garbled as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "failed", message: PATHIX_NOT_DATA_TEXT, status: 200 });
  });

  it("shows a web page as an error state that says so", async () => {
    const page = vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    const get: Get = (path) => apiGet(PATHIX, path, tokens("t1").source, page as unknown as typeof fetch);
    const status = await resolveConnection("5c4a0000-0000-4000-8000-000000000003", null, get);
    expect(status).toEqual({ kind: "error", message: PATHIX_WEB_PAGE_TEXT });
    expect(JSON.stringify(stateForConnection(status))).not.toContain("Unexpected token");
  });

  it("tells a web page apart by its content type only", () => {
    expect(isWebPage(new Response(null, { headers: { "content-type": "text/html; charset=utf-8" } }))).toBe(true);
    expect(isWebPage(new Response(null, { headers: { "content-type": "application/xhtml+xml" } }))).toBe(true);
    expect(isWebPage(new Response(null, { headers: { "content-type": "application/json; charset=utf-8" } }))).toBe(false);
    expect(isWebPage({} as Response)).toBe(false);
  });

  it("renews once after a 401 and retries", async () => {
    const t = tokens("stale", "fresh");
    const result = await apiGet(PATHIX, "/environments", t.source, respond(401, 200) as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(t.calls).toEqual([false, true]);
  });

  it("stops after the second 401 instead of looping", async () => {
    const t = tokens("stale", "fresh");
    const fetchFn = respond(401, 401, 200);
    const result = await apiGet(PATHIX, "/environments", t.source, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "unauthorized", status: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("treats a 403 as unauthorized without renewing", async () => {
    const t = tokens("t1");
    const result = await apiGet(PATHIX, "/environments", t.source, respond(403) as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "unauthorized", status: 403 });
    expect(t.calls).toEqual([false]);
  });

  it("reports signed out without calling Pathix when there is no token", async () => {
    const fetchFn = respond(200);
    const result = await apiGet(PATHIX, "/environments", tokens(null).source, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "signedOut" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("carries the HTTP status of a failed answer, so a 404 can be told from a dropped connection", async () => {
    const notFound = await apiGet(PATHIX, "/environments", tokens("t1").source, respond(404) as unknown as typeof fetch);
    expect(notFound).toEqual({ ok: false, kind: "failed", message: "Pathix answered 404.", status: 404 });
  });

  it("reports a network failure", async () => {
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    const result = await apiGet(PATHIX, "/environments", tokens("t1").source, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, kind: "failed", message: "Failed to fetch" });
  });
});

describe("resolveConnection", () => {
  function fakeGet(routes: Record<string, unknown>): Get {
    return async <T>(path: string) =>
      path in routes ? { ok: true as const, data: routes[path] as T } : { ok: false as const, kind: "failed" as const, message: `no route ${path}` };
  }

  it("names the environment and its latest Completed scan", async () => {
    const get = fakeGet({
      "/environments": [other, contoso],
      "/scans?environmentId=env-1": [scan("Completed", "2026-09-30T10:00:00Z"), scan("Running", null)],
    });
    expect(await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get)).toEqual({
      kind: "connected",
      environmentId: "env-1",
      environmentName: "Contoso",
      latestCompletedScanAt: "2026-09-30T10:00:00Z",
      latestCompletedScanStartedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("carries the tables the environment's scans leave out, in lower case", async () => {
    const get = fakeGet({
      "/environments": [{ ...contoso, excludedEntities: ["sim_OrphanHost", "msdyn_log"] }],
      "/scans?environmentId=env-1": [scan("Completed", "2026-09-30T10:00:00Z")],
    });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get);
    expect(status).toMatchObject({ kind: "connected", excludedTables: ["sim_orphanhost", "msdyn_log"] });
    expect(isExcludedTable(status as { excludedTables?: string[] }, "sim_orphanhost")).toBe(true);
    expect(isExcludedTable(status as { excludedTables?: string[] }, "account")).toBe(false);
    expect(isExcludedTable({}, "sim_orphanhost")).toBe(false);
  });

  // Pathix lists the 100 latest scans of an environment, with no status filter.
  const notCompleted = (count: number) => Array.from({ length: count }, () => scan("Failed", null));

  it("reads the latest Completed scan as unknown, not as none, when all 100 listed scans are not Completed", async () => {
    const get = fakeGet({ "/environments": [contoso], "/scans?environmentId=env-1": notCompleted(100) });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get);
    expect(status).toEqual({
      kind: "connected",
      environmentId: "env-1",
      environmentName: "Contoso",
      latestCompletedScanAt: null,
      latestCompletedScanStartedAt: null,
      latestCompletedScanUnknown: true,
    });
    expect(stateForConnection(status)).toMatchObject({ kind: "completedScanUnknown" });
  });

  it("says there is no Completed scan yet when the list is below the cap and holds none", async () => {
    const get = fakeGet({ "/environments": [contoso], "/scans?environmentId=env-1": notCompleted(99) });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get);
    expect(status).not.toHaveProperty("latestCompletedScanUnknown");
    expect(stateForConnection(status)).toMatchObject({ kind: "noCompletedScan" });
  });

  it("uses a Completed scan found in a full list", async () => {
    const get = fakeGet({
      "/environments": [contoso],
      "/scans?environmentId=env-1": [...notCompleted(99), scan("Completed", "2026-09-30T10:00:00Z")],
    });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get);
    expect(status).toMatchObject({ latestCompletedScanAt: "2026-09-30T10:00:00Z" });
    expect(status).not.toHaveProperty("latestCompletedScanUnknown");
  });

  it("pins the cap to Pathix's ScanHistoryLimit", () => {
    expect(SCAN_LIST_CAP).toBe(100);
  });

  it("names the address Pathix knows the organization by when the page is on another, and answers nothing for it", async () => {
    const get = fakeGet({ "/environments": [contoso] });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm4.dynamics.com", get);
    expect(status).toEqual({ kind: "notScanned", otherHost: "contoso.crm.dynamics.com" });
    expect(stateForConnection(status)).toEqual({
      kind: "notScanned",
      title: "Pathix knows this organization under another address",
      text: "Pathix knows this organization under a different address (contoso.crm.dynamics.com). The environment's address may have changed since it was added to Pathix. Your Pathix administrator can check it.",
      action: null,
    });
    // Pathix does not let an environment's URL be edited (UpdateEnvironmentRequest), so the card never asks for that.
    expect(stateForConnection(status)?.text).not.toMatch(/update the environment|change the URL/i);
  });

  it("answers nothing for an environment Pathix has no address for, and says that, not that none matches", async () => {
    const get = fakeGet({ "/environments": [{ ...contoso, url: "" }] });
    const status = await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get);
    expect(status).toEqual({ kind: "notScanned", noAddress: true });
    expect(stateForConnection(status)).toEqual({
      kind: "notScanned",
      title: "Pathix has no address for this environment",
      text: "Pathix lists this organization without an address, so the extension cannot check that this page is that environment. Your Pathix administrator can check it.",
      action: null,
    });
    expect(stateForConnection(status)?.text).not.toMatch(/no environment that matches/i);
  });

  it("says so when the org is not an environment in this Pathix", async () => {
    const get = fakeGet({ "/environments": [other] });
    expect(await resolveConnection("c0de0000-0000-4000-8000-000000000001", "contoso.crm.dynamics.com", get)).toEqual({
      kind: "notScanned",
    });
  });

  it("carries a refusal through rather than reporting an empty result", async () => {
    const get: Get = async () => ({ ok: false, kind: "unauthorized", status: 403 });
    expect(await resolveConnection("c0de0000-0000-4000-8000-000000000001", "x.crm.dynamics.com", get)).toEqual({
      kind: "unauthorized",
      status: 403,
    });
  });
});

// Review R6: a Pathix that never answers used to leave "Loading from Pathix…" up for minutes.
describe("a Pathix that does not answer in time", () => {
  /** A fetch that never answers on its own: it rejects only when its signal aborts, as the browser's does. */
  const silent = () =>
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
  /** A timeout the test fires: each request gets its own signal, kept in order. */
  function clock() {
    const controllers: AbortController[] = [];
    return {
      timeout: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
      fire: () => controllers.at(-1)!.abort(new DOMException("The operation timed out.", "TimeoutError")),
      started: () => controllers.length,
    };
  }
  const token = async () => "t1";
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 50 && !ready(); i++) await Promise.resolve();
  };

  it("gives each request 15 seconds by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await apiGet(PATHIX, "/environments", token, (async () => Response.json([])) as unknown as typeof fetch);
    expect(PATHIX_TIMEOUT_MS).toBe(15_000);
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it("reads as a failed request that says Pathix did not answer in time, never as an answer", async () => {
    const time = clock();
    const pending = apiGet(PATHIX, "/environments", token, silent() as unknown as typeof fetch, time.timeout);
    await until(() => time.started() === 1);
    time.fire();
    expect(await pending).toEqual({ ok: false, kind: "failed", message: PATHIX_TIMEOUT_TEXT });
    expect(PATHIX_TIMEOUT_TEXT).toBe("Pathix did not answer in time.");
  });

  it("times out a body that never finishes, too", async () => {
    const time = clock();
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
        }) as unknown as Response,
    );
    const pending = apiGet(PATHIX, "/environments", token, fetchFn as unknown as typeof fetch, time.timeout);
    await until(() => fetchFn.mock.calls.length === 1);
    time.fire();
    expect(await pending).toEqual({ ok: false, kind: "failed", message: PATHIX_TIMEOUT_TEXT });
  });

  it("makes /config throw the web page reason when a proxy or sign-in page answers", async () => {
    const page = vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(fetchAuthConfig(PATHIX, page as unknown as typeof fetch)).rejects.toThrow(PATHIX_WEB_PAGE_TEXT);
    const garbled = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(fetchAuthConfig(PATHIX, garbled as unknown as typeof fetch)).rejects.toThrow(PATHIX_NOT_DATA_TEXT);
  });

  // Review L7: /config's body stalling is a timeout too.
  it("makes /config throw the same reason when its body never finishes", async () => {
    const time = clock();
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
        }) as unknown as Response,
    );
    const pending = fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch, time.timeout);
    await until(() => fetchFn.mock.calls.length === 1);
    time.fire();
    await expect(pending).rejects.toThrow(PATHIX_TIMEOUT_TEXT);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shows as the unreachable state, with the reason in words", () => {
    const state = stateForConnection(statusForError(new Error(PATHIX_TIMEOUT_TEXT)));
    expect(state?.kind).toBe("pathixUnreachable");
    expect(state?.text).toBe("Check your connection and try again. Details: Pathix did not answer in time.");
  });

  it("is not kept by the shared response cache: callers waiting on it share it, and the next read asks again", async () => {
    const time = clock();
    let answers = false;
    const fetchFn = vi.fn((url: string, init?: RequestInit) => (answers ? Promise.resolve(Response.json([{ id: "env-1" }])) : silent()(url, init)));
    const get = new ResponseCache(60_000).wrap((path) => apiGet(PATHIX, path, token, fetchFn as unknown as typeof fetch, time.timeout), "scan-1");

    const first = Promise.all([get("/environments"), get("/environments")]);
    await until(() => time.started() === 1);
    time.fire();
    expect(await first).toEqual([
      { ok: false, kind: "failed", message: PATHIX_TIMEOUT_TEXT },
      { ok: false, kind: "failed", message: PATHIX_TIMEOUT_TEXT },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    answers = true;
    expect(await get("/environments")).toEqual({ ok: true, data: [{ id: "env-1" }] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("makes /config throw the same reason, without a second request to probe for a redirect", async () => {
    const time = clock();
    const fetchFn = silent();
    const pending = fetchAuthConfig(PATHIX, fetchFn as unknown as typeof fetch, time.timeout);
    await until(() => time.started() === 1);
    time.fire();
    await expect(pending).rejects.toThrow(PATHIX_TIMEOUT_TEXT);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ cache: "no-store", redirect: "error" });
  });
});
