// The service worker's options requests, run against an in-memory chrome
// (storage, permissions, identity) and a fake Pathix and Entra. Review round 2:
// the options page's Sign in goes through PathixSignIn.confirm, which never
// takes a cached token, so a click always leaves a binding for the settings
// it showed; and Sign out is offered while a token or a binding is stored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingFor } from "../src/auth/binding";
import { signOutOffered } from "../src/background/sign-in";
import type { AccountStatus } from "../src/runtime/messages";

type Listener = (...args: unknown[]) => unknown;

const PATHIX = "https://pathix.contoso.com";
const TENANT = "10000000-0000-4000-8000-000000000001";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const EXTENSION_CLIENT = "40000000-0000-4000-8000-000000000004";
const READ = "api://20000000-0000-4000-8000-000000000002/Pathix.Read";
const ACCESS = "api://20000000-0000-4000-8000-000000000002/Pathix.Access";
const REDIRECT = "https://extension-id.chromiumapp.org/";
const OPTIONS_PAGE = { id: "extension-id", url: "chrome-extension://extension-id/options.html" };
const OFFERED = bindingFor({ pathixUrl: PATHIX, authority: AUTHORITY, clientId: EXTENSION_CLIENT, apiScope: READ });

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const GRANT = jwt({ scp: "Pathix.Read", upn: "user@contoso.com" });

/** A chrome storage area over a plain object. */
function area(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };
}

const pending = () => vi.fn(() => new Promise<never>(() => undefined));
const event = () => ({ addListener: vi.fn((_listener: Listener) => undefined) });

function mockChrome(local: Record<string, unknown>, session: Record<string, unknown>) {
  return {
    runtime: {
      id: "extension-id",
      getManifest: () => ({ action: { default_title: "Pathix" } }),
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      openOptionsPage: pending(),
      onMessage: event(),
      onInstalled: event(),
    },
    storage: { local: area(local), session: area(session), managed: { get: vi.fn(async () => ({})) }, onChanged: event() },
    permissions: { contains: vi.fn(async () => true), request: pending(), remove: pending(), onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: pending(), registerContentScripts: pending(), unregisterContentScripts: pending() },
    action: { setBadgeBackgroundColor: pending(), setBadgeTextColor: pending(), setBadgeText: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined), onClicked: event() },
    tabs: { query: vi.fn(async () => []), sendMessage: pending(), create: pending(), onUpdated: event(), onRemoved: event() },
    commands: { onCommand: event() },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: vi.fn(async (details: { url: string }) => `${REDIRECT}?code=code-1&state=${new URL(details.url).searchParams.get("state")}`),
    },
  };
}

/** Pathix's /config and Entra's token endpoint. */
async function fakeFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url === `${PATHIX}/api/config`) {
    return Response.json({
      msalEnabled: true,
      azureAd: { clientId: "30000000-0000-4000-8000-000000000003", tenantId: TENANT, authority: AUTHORITY, apiScope: ACCESS },
      extension: { clientId: EXTENSION_CLIENT, apiScope: READ },
    });
  }
  if (url === `${AUTHORITY}/oauth2/v2.0/token`) return Response.json({ access_token: GRANT, expires_in: 3600 });
  return new Response("", { status: 404 });
}

let chromeMock: ReturnType<typeof mockChrome>;

async function loadWorker(local: Record<string, unknown>, session: Record<string, unknown>): Promise<void> {
  vi.resetModules();
  chromeMock = mockChrome(local, session);
  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  await import("../src/background/service-worker");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function send(message: unknown): Promise<AccountStatus> {
  const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]![0];
  return new Promise((resolve) => listener(message, OPTIONS_PAGE, resolve));
}

describe("the options page's Sign in, in the worker", () => {
  const usableToken = { token: GRANT, expiresAt: Date.now() + 60 * 60 * 1000, pathixUrl: PATHIX, authority: AUTHORITY, clientId: EXTENSION_CLIENT, scope: READ };

  beforeEach(async () => {
    // A usable token is stored, but no binding: a sign-in that took the cached token would leave none.
    await loadWorker({ pathixUrl: PATHIX }, { accessToken: usableToken });
  });

  it("goes through confirm: it asks Entra even with a usable cached token, and leaves the binding it showed", async () => {
    const status = await send({ kind: "signIn", binding: OFFERED });
    expect(chromeMock.identity.launchWebAuthFlow).toHaveBeenCalled();
    expect(chromeMock.storage.local.data.signInBinding).toEqual({ ...OFFERED, loginHint: "user@contoso.com" });
    expect(status).toMatchObject({ signedIn: true, account: "user@contoso.com", signOutOffered: true });
  });

  it("loading the page with no binding signs nothing in, though a token is stored, and offers Sign out", async () => {
    const status = await send({ kind: "accountStatus" });
    expect(chromeMock.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(status).toMatchObject({ signedIn: false, signOutOffered: true, offered: OFFERED });
  });

  it("Sign out removes the token and the binding, and no longer offers Sign out", async () => {
    await send({ kind: "signIn", binding: OFFERED });
    const status = await send({ kind: "signOut" });
    expect(chromeMock.storage.session.data.accessToken).toBeUndefined();
    expect(chromeMock.storage.local.data.signInBinding).toBeUndefined();
    expect(status).toMatchObject({ signedIn: false, signOutOffered: false });
  });
});

describe("signOutOffered", () => {
  it.each([
    ["a token only", { token: "t" }, undefined, true],
    ["a binding only", undefined, OFFERED, true],
    ["both", { token: "t" }, OFFERED, true],
    ["neither", undefined, undefined, false],
    ["nulls", null, null, false],
  ])("with %s stored is %s", (_label, stored, binding, offered) => {
    expect(signOutOffered(stored, binding)).toBe(offered);
  });
});
