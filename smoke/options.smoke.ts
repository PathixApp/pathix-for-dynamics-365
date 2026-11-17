// Smoke test for the options page and sign-in settings (M15), in the real
// build. The Pathix address is all the page asks for: the extension's client
// ID and its read-only scope come from Pathix's /config. A fake Pathix answers
// /config in each shape, and the test checks what the page says, that it
// offers no Sign in when Pathix offers the extension no sign-in, that nothing
// then goes to Entra, that a usable answer signs nothing in until the user
// selects Sign in (D1, the confirmed sign-in binding) and the page shows what
// that click trusts, that Sign in sends the extension's own client ID and the
// Pathix.Read scope to Entra, that a token granting more than Pathix.Read is
// thrown away, that a changed tenant waits for a new click, that Sign out
// sticks, and that a /config that does not answer reads as "could not reach
// Pathix", never as a failed sign-in.
//
// The fake Pathix host is granted in a test-only copy of the manifest, because
// the browser's permission prompt cannot be answered headless. The committed
// manifest holds every Pathix host as an optional permission only
// (test/manifest.test.ts). The sign-in window opens outside the reach of
// Playwright's routing, so the test wraps chrome.identity.launchWebAuthFlow in
// the worker: it records the authorize URL and answers as Entra would, with
// login_required or with a code. The worker's own fetch to Entra's token
// endpoint is routed like any other request.

import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

const DIST = resolve("dist");
const PATHIX = "https://pathix.contoso.test";
const ENTRA = "https://login.microsoftonline.com";
const TENANT = "10000000-0000-4000-8000-000000000001";
const WEB_APP_CLIENT = "30000000-0000-4000-8000-000000000003";
const EXTENSION_CLIENT = "40000000-0000-4000-8000-000000000004";
const ACCESS = "api://20000000-0000-4000-8000-000000000002/Pathix.Access";
const READ = "api://20000000-0000-4000-8000-000000000002/Pathix.Read";

/** /config as Pathix sends it; `extension` undefined leaves the key out, as an older Pathix does. */
function config(extension: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    msalEnabled: true,
    azureAd: { clientId: WEB_APP_CLIENT, tenantId: TENANT, authority: `${ENTRA}/${TENANT}`, apiScope: ACCESS },
    license: {},
    branding: null,
  };
  if (extension !== undefined) body.extension = extension;
  return body;
}

/** /config from a Pathix with sign-in off, which also sends extension null. */
const SIGN_IN_OFF = {
  msalEnabled: false,
  azureAd: { clientId: "", tenantId: "", authority: "", apiScope: "" },
  license: {},
  branding: null,
  extension: null,
};

const USABLE = config({ clientId: EXTENSION_CLIENT, apiScope: READ });

/** The same Pathix, now naming another tenant. */
const OTHER_TENANT = "90000000-0000-4000-8000-000000000009";
const MOVED = {
  ...USABLE,
  azureAd: { clientId: WEB_APP_CLIENT, tenantId: OTHER_TENANT, authority: `${ENTRA}/${OTHER_TENANT}`, apiScope: ACCESS },
};

/** An unsigned JWT with these claims. The extension reads claims; Pathix verifies tokens. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

let extension: BrowserContext;
let extensionId: string;
/** What the fake Pathix answers on /config: a body, or an HTTP status with no body. */
let configAnswer: Record<string, unknown> | number = config(null);
/** The access token the fake Entra hands back for a code. */
let grantedToken = jwt({ scp: "Pathix.Read", upn: "user@contoso.com" });

test.describe.configure({ mode: "serial" });

async function worker(): Promise<Worker> {
  return extension.serviceWorkers()[0] ?? (await extension.waitForEvent("serviceworker"));
}

/**
 * Records every sign-in the worker starts from now on. Entra answers each
 * with login_required, or with a code when `withCode` is set.
 */
async function recordSignIns(withCode = false): Promise<void> {
  await (await worker()).evaluate((withCode) => {
    const scope = globalThis as unknown as { pathixSignIns: string[] };
    scope.pathixSignIns = [];
    chrome.identity.launchWebAuthFlow = (async (details: chrome.identity.WebAuthFlowDetails) => {
      scope.pathixSignIns.push(details.url);
      const url = new URL(details.url);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      if (withCode) redirect.searchParams.set("code", "code-1");
      else redirect.searchParams.set("error", "login_required");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      return redirect.toString();
    }) as typeof chrome.identity.launchWebAuthFlow;
  }, withCode);
}

async function signIns(): Promise<string[]> {
  return (await worker()).evaluate(() => (globalThis as unknown as { pathixSignIns: string[] }).pathixSignIns);
}

async function storedToken(): Promise<Record<string, unknown> | undefined> {
  return (await worker()).evaluate(async () => (await chrome.storage.session.get("accessToken")).accessToken as Record<string, unknown> | undefined);
}

async function storedBinding(): Promise<Record<string, unknown> | undefined> {
  return (await worker()).evaluate(async () => (await chrome.storage.local.get("signInBinding")).signInBinding as Record<string, unknown> | undefined);
}

test.beforeAll(async () => {
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("No build in dist/. Run npm run build first.");
  const copy = mkdtempSync(join(tmpdir(), "pathix-options-smoke-"));
  cpSync(DIST, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8")) as Record<string, unknown>;
  manifest.host_permissions = [`${PATHIX}/*`];
  writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));

  extension = await chromium.launchPersistentContext("", {
    ...(process.env.PATHIX_SMOKE_CHROMIUM ? { executablePath: process.env.PATHIX_SMOKE_CHROMIUM } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
  });
  await extension.route(`${PATHIX}/api/config`, (route) =>
    typeof configAnswer === "number" ? route.fulfill({ status: configAnswer, body: "" }) : route.fulfill({ status: 200, json: configAnswer }),
  );
  await extension.route(`${ENTRA}/${TENANT}/oauth2/v2.0/token`, (route) =>
    route.fulfill({ status: 200, json: { token_type: "Bearer", access_token: grantedToken, expires_in: 3600 } }),
  );
  extensionId = new URL((await worker()).url()).host;
  // Saved as an earlier build saved it, with the client ID the user once typed.
  await (await worker()).evaluate(
    ([pathixUrl, clientId]) => chrome.storage.local.set({ pathixUrl, clientId }),
    [PATHIX, "50000000-0000-4000-8000-000000000005"],
  );
});

test.afterAll(async () => {
  await extension?.close();
});

async function openOptions(answer: Record<string, unknown> | number, options: { withCode?: boolean } = {}): Promise<Page> {
  configAnswer = answer;
  await recordSignIns(options.withCode);
  const page = await extension.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("#account-status")).not.toHaveText("Checking…", { timeout: 15_000 });
  return page;
}

test("asks for the Pathix address only", async () => {
  const page = await openOptions(config(null));
  await expect(page.locator("#pathix-url")).toHaveValue(PATHIX);
  await expect(page.locator("#client-id")).toHaveCount(0);
  await expect(page.locator("#settings input")).toHaveCount(1);
  await page.close();
});

for (const [label, answer, text] of [
  [
    "an older Pathix, with no extension key",
    config(undefined),
    "This Pathix is an older version that does not offer sign-in for the extension. Ask your Pathix administrator to update Pathix.",
  ],
  ["a Pathix with no extension registration", config(null), "This Pathix has no browser extension registration. Ask your Pathix administrator to set one up."],
  [
    "a registration that fails validation",
    config({ clientId: EXTENSION_CLIENT, apiScope: ACCESS }),
    "The extension registration on this Pathix looks wrong. Ask your Pathix administrator to check it.",
  ],
  [
    "a registration that reuses the web app's client ID",
    config({ clientId: WEB_APP_CLIENT, apiScope: READ }),
    "The extension registration on this Pathix looks wrong. Ask your Pathix administrator to check it.",
  ],
  ["a Pathix with sign-in off", SIGN_IN_OFF, "This Pathix does not have Entra sign-in configured. Ask your Pathix administrator to set it up."],
] as const) {
  test(`${label}: says so, offers no Sign in, and asks nothing of Entra`, async () => {
    const page = await openOptions(answer);
    await expect(page.locator("#account-status")).toHaveText(text);
    await expect(page.locator("#sign-in")).toBeHidden();
    await expect(page.locator("#sign-out")).toBeHidden();
    expect(await signIns()).toEqual([]);
    await page.close();
  });
}

test("a usable registration: loading the page signs nothing in, and shows what Sign in would trust", async () => {
  const page = await openOptions(USABLE);
  await expect(page.locator("#account-status")).toHaveText("Not signed in.");
  await expect(page.locator("#sign-in")).toBeVisible();
  await expect(page.locator("#sign-in-trust")).toBeVisible();
  await expect(page.locator("#sign-in-trust-list dd")).toHaveText([PATHIX, TENANT, "login.microsoftonline.com", "api://20000000-0000-4000-8000-000000000002"]);
  expect(await signIns()).toEqual([]);
  await page.close();
});

test("Sign in: the sign-in carries the extension's client ID and the Pathix.Read scope", async () => {
  const page = await openOptions(USABLE);
  await page.locator("#sign-in").click();
  await expect(page.locator("#account-status")).toHaveText("Sign-in did not complete: login_required");

  const started = await signIns();
  expect(started).toHaveLength(2);
  const [silent, interactive] = started.map((url) => new URL(url));
  expect(silent!.origin + silent!.pathname).toBe(`${ENTRA}/${TENANT}/oauth2/v2.0/authorize`);
  expect(silent!.searchParams.get("client_id")).toBe(EXTENSION_CLIENT);
  expect(silent!.searchParams.get("scope")).toBe(READ);
  expect(silent!.searchParams.get("prompt")).toBe("none");
  expect(interactive!.searchParams.get("prompt")).toBeNull();
  for (const url of started) {
    expect(url).not.toContain(WEB_APP_CLIENT);
    expect(url).not.toContain("Pathix.Access");
  }
  expect(await storedBinding()).toBeUndefined();
  await page.close();
});

test("a token that grants more than Pathix.Read: thrown away, and the page says why", async () => {
  grantedToken = jwt({ scp: "Pathix.Access Pathix.Read", upn: "user@contoso.com" });
  const page = await openOptions(USABLE, { withCode: true });
  expect(await signIns()).toEqual([]);
  await page.locator("#sign-in").click();
  await expect(page.locator("#account-status")).toHaveText(
    "The extension registration on this Pathix grants more than read access. Ask your Pathix administrator to remove the other permissions and their consent.",
  );
  await expect(page.locator("#sign-in")).toBeHidden();
  expect(await signIns()).toHaveLength(1);
  expect(await storedToken()).toBeUndefined();
  expect(await storedBinding()).toBeUndefined();
  await page.close();
});

test("a token that grants Pathix.Read alone: kept for this Pathix, and the sign-in is confirmed", async () => {
  grantedToken = jwt({ scp: "Pathix.Read", upn: "user@contoso.com" });
  const page = await openOptions(USABLE, { withCode: true });
  await page.locator("#sign-in").click();
  await expect(page.locator("#account-status")).toHaveText("Signed in as user@contoso.com.");
  await expect(page.locator("#sign-out")).toBeVisible();
  await expect(page.locator("#sign-in-trust")).toBeHidden();
  expect(await storedToken()).toMatchObject({ pathixUrl: PATHIX, clientId: EXTENSION_CLIENT, scope: READ, authority: `${ENTRA}/${TENANT}` });
  expect(await storedBinding()).toEqual({
    pathixUrl: PATHIX,
    authority: `${ENTRA}/${TENANT}`,
    tenantId: TENANT,
    clientId: EXTENSION_CLIENT,
    apiScope: READ,
    loginHint: "user@contoso.com",
  });
  await page.close();
});

test("a /config that does not answer: still signed in, and says Pathix did not answer, not that sign-in failed", async () => {
  const page = await openOptions(502);
  await expect(page.locator("#account-status")).toHaveText(
    "Signed in as user@contoso.com. Could not reach Pathix just now. Details: Pathix /config answered 502.",
  );
  await expect(page.locator("#sign-out")).toBeVisible();
  expect(await signIns()).toEqual([]);
  await page.close();
});

test("a Pathix that stops offering sign-in: the stored token is removed", async () => {
  expect(await storedToken()).toBeDefined();
  const page = await openOptions(config(null));
  await expect(page.locator("#account-status")).toHaveText(
    "This Pathix has no browser extension registration. Ask your Pathix administrator to set one up.",
  );
  expect(await storedToken()).toBeUndefined();
  await page.close();
});

test("a new tenant for the same address: signs nothing in, and says what changed", async () => {
  const page = await openOptions(MOVED);
  await expect(page.locator("#account-status")).toHaveText(
    "Pathix's sign-in settings changed since you signed in: the tenant. Check them below, then select Sign in.",
  );
  await expect(page.locator("#sign-in")).toBeVisible();
  await expect(page.locator("#sign-in-trust-list dd").nth(1)).toHaveText(OTHER_TENANT);
  // The old confirmed sign-in is still stored, so Sign out stays to remove it.
  await expect(page.locator("#sign-out")).toBeVisible();
  expect(await signIns()).toEqual([]);
  await page.close();
});

test("the settings the user confirmed: loading the page signs in silently", async () => {
  const page = await openOptions(USABLE, { withCode: true });
  await expect(page.locator("#account-status")).toHaveText("Signed in as user@contoso.com.");
  const started = await signIns();
  expect(started).toHaveLength(1);
  expect(new URL(started[0]!).searchParams.get("prompt")).toBe("none");
  await page.close();
});

test("Sign out sticks: the token and the confirmed sign-in go, and nothing signs in again", async () => {
  const page = await openOptions(USABLE, { withCode: true });
  await page.locator("#sign-out").click();
  await expect(page.locator("#account-status")).toHaveText("Not signed in.");
  expect(await storedToken()).toBeUndefined();
  expect(await storedBinding()).toBeUndefined();
  await page.close();

  const again = await openOptions(USABLE, { withCode: true });
  await expect(again.locator("#account-status")).toHaveText("Not signed in.");
  expect(await signIns()).toEqual([]);
  await again.close();
});

test("Save and connect keeps the address and removes the client ID an earlier build stored", async () => {
  const page = await openOptions(config(null));
  await page.locator("#settings button[type=submit]").click();
  await expect(page.locator("#settings-status")).toHaveText("Saved, but the extension cannot sign in to this Pathix.");
  const stored = await (await worker()).evaluate(() => chrome.storage.local.get(["pathixUrl", "clientId"]));
  expect(stored).toEqual({ pathixUrl: PATHIX });
  await page.close();
});
