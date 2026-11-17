// The Power Platform admin center overlay's permission flow (M14): what the
// manifest and the runtime registration may match, how the toggle asks for the
// host, and how the worker keeps the registration in step with the setting and
// the permission. The maintainer approved exactly one host pattern as an optional
// permission, plus the scripting permission to register the script at runtime
// (2026-10-07); these tests hold the line there.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesPattern, PATHIX_ADDRESSES } from "./match-pattern";
import {
  ADMIN_SCRIPT_REGISTRATION,
  browserOverlayDeps,
  completeEnableIntent,
  ReconcileQueue,
  reconcileAdminOverlay,
  type IntentDeps,
  type OverlayDeps,
  type RegisteredScript,
} from "../src/background/admin-overlay";
import { DENIED_MESSAGE, turnOverlayOff, turnOverlayOn, type ToggleDeps } from "../src/options/admin-toggle";
import {
  ADMIN_HOST,
  ADMIN_HOST_PATTERN,
  ADMIN_INTENT_TTL_MS,
  ADMIN_OVERLAY_KEY,
  ADMIN_SCRIPT_FILE,
  ADMIN_SCRIPT_ID,
  isAdminAppUsersRequest,
  isAdminOverlayOffCommand,
  isAdminOverlayStatusRequest,
  isAdminRoleListRequest,
  isAdminRoleRequest,
  isAppUserChipModel,
  isFromAdminPage,
  isRoleBadgeModel,
  isRoleBannerModel,
  type AdminOverlayStatus,
} from "../src/runtime/admin-overlay";

const ORG = "5c4a0000-0000-4000-8000-000000000003";
const ID = "d1000000-0000-4000-8000-000000000001";

/** Sign-in and identity hosts the overlay must never match, whatever else changes. */
const SIGN_IN_URLS = [
  "https://login.microsoftonline.com/common/oauth2/authorize",
  "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
  "https://login.live.com/oauth20_authorize.srf",
  "https://login.windows.net/common/oauth2/token",
  "https://login.microsoft.com/",
  "https://sts.windows.net/",
  "https://account.microsoft.com/",
  "https://account.live.com/",
  "https://aadcdn.msauth.net/",
  "https://contoso.b2clogin.com/",
  "https://adfs.contoso.com/adfs/ls/",
  "https://accounts.google.com/",
  "https://webshell.suite.office.com/iframe/TokenFactoryIframe",
  "https://make.powerapps.com/",
  "https://contoso.crm.dynamics.com/main.aspx",
];

describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

  it("carries the one approved host as an optional permission, and the scripting permission", () => {
    expect(manifest.permissions).toEqual(["identity", "storage", "scripting"]);
    expect(manifest.optional_host_permissions).toContain(ADMIN_HOST_PATTERN);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "https://admin.powerplatform.microsoft.com/*"]);
  });

  it("holds no host permission up front and registers no admin script statically", () => {
    expect(manifest.host_permissions).toBeUndefined();
    const matches: string[] = manifest.content_scripts.flatMap((script: { matches: string[] }) => script.matches);
    expect(matches).toEqual(["https://*.dynamics.com/*", "https://*.dynamics.com/*"]);
    expect(manifest.content_scripts.flatMap((script: { js: string[] }) => script.js)).not.toContain(ADMIN_SCRIPT_FILE);
  });

  it("never lets a static content script match the admin host or a sign-in host", () => {
    const matches: string[] = manifest.content_scripts.flatMap((script: { matches: string[] }) => script.matches);
    for (const url of [`https://${ADMIN_HOST}/`, ...SIGN_IN_URLS.slice(0, -1)]) {
      for (const pattern of matches) expect(matchesPattern(pattern, url), `${pattern} vs ${url}`).toBe(false);
    }
  });
});

describe("the runtime registration", () => {
  it("matches exactly the admin host, over https, and nothing else", () => {
    expect(ADMIN_SCRIPT_REGISTRATION.matches).toEqual([ADMIN_HOST_PATTERN]);
    expect(ADMIN_HOST_PATTERN).toBe("https://admin.powerplatform.microsoft.com/*");
    expect(ADMIN_HOST).toBe("admin.powerplatform.microsoft.com");
    // No wildcard anywhere in the host part.
    expect(new URL(ADMIN_HOST_PATTERN.replace("/*", "/")).hostname).toBe(ADMIN_HOST);
    expect(ADMIN_HOST_PATTERN.slice("https://".length, ADMIN_HOST_PATTERN.indexOf("/", "https://".length))).not.toContain("*");
  });

  it("matches the admin center's pages and no sign-in host, in any other subdomain or lookalike", () => {
    const [pattern] = ADMIN_SCRIPT_REGISTRATION.matches;
    expect(matchesPattern(pattern, `https://${ADMIN_HOST}/manage/environments/${ORG}/securityroles`)).toBe(true);
    for (const url of [
      ...SIGN_IN_URLS,
      "https://powerplatform.microsoft.com/",
      "https://admin.powerplatform.microsoft.com.evil.example/",
      "https://evil.example/admin.powerplatform.microsoft.com/",
      "https://other.admin.powerplatform.microsoft.com/",
      `http://${ADMIN_HOST}/`,
    ]) {
      expect(matchesPattern(pattern, url), url).toBe(false);
    }
  });

  it("is one isolated-world script in the top frame, run once the page is idle", () => {
    expect(ADMIN_SCRIPT_REGISTRATION).toMatchObject({
      id: ADMIN_SCRIPT_ID,
      js: [ADMIN_SCRIPT_FILE],
      runAt: "document_idle",
      world: "ISOLATED",
      allFrames: false,
    });
  });

  it("registers a file the build produces", () => {
    expect(readFileSync("build.mjs", "utf8")).toContain('admin: "src/admin/admin.ts"');
    expect(ADMIN_SCRIPT_FILE).toBe("admin.js");
  });

  it("asks the browser for the admin host and nothing else", () => {
    // The toggle requests exactly this one origin (see the toggle tests below).
    expect([ADMIN_HOST_PATTERN]).toEqual(["https://admin.powerplatform.microsoft.com/*"]);
  });
});

// --- reconciling the registration ------------------------------------------------------

interface Fake extends OverlayDeps {
  registered: RegisteredScript[];
  enabled: boolean;
  granted: boolean;
  log: string[];
}

function fakeDeps(start: { enabled: boolean; granted: boolean; registered?: RegisteredScript[] }): Fake {
  const fake: Fake = {
    registered: start.registered ?? [],
    enabled: start.enabled,
    granted: start.granted,
    log: [],
    getRegistered: async () => fake.registered,
    register: async () => {
      fake.log.push("register");
      if (fake.registered.some((script) => script.id === ADMIN_SCRIPT_ID)) throw new Error("Duplicate script ID");
      fake.registered = [{ id: ADMIN_SCRIPT_ID, matches: [...ADMIN_SCRIPT_REGISTRATION.matches] }];
    },
    unregister: async () => {
      fake.log.push("unregister");
      fake.registered = [];
    },
    hasPermission: async () => fake.granted,
    isEnabled: async () => fake.enabled,
    setEnabled: async (enabled) => {
      fake.log.push(`setEnabled(${enabled})`);
      fake.enabled = enabled;
    },
    notifyOff: async () => void fake.log.push("notifyOff"),
  };
  return fake;
}

const registeredScript: RegisteredScript = { id: ADMIN_SCRIPT_ID, matches: [ADMIN_HOST_PATTERN] };

describe("reconciling the registration with the setting and the permission", () => {
  it("registers when the overlay is on and the host is granted", async () => {
    const fake = fakeDeps({ enabled: true, granted: true });
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: true, registered: true, error: null });
    expect(fake.log).toEqual(["register"]);
  });

  it("does nothing when it is already registered for exactly the admin host", async () => {
    const fake = fakeDeps({ enabled: true, granted: true, registered: [registeredScript] });
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: true, registered: true, error: null });
    expect(fake.log).toEqual([]);
  });

  it("replaces a registration that matches anything else", async () => {
    for (const matches of [["https://*/*"], [ADMIN_HOST_PATTERN, "https://login.microsoftonline.com/*"], undefined]) {
      const fake = fakeDeps({ enabled: true, granted: true, registered: [{ id: ADMIN_SCRIPT_ID, matches }] });
      await reconcileAdminOverlay(fake);
      expect(fake.log).toEqual(["unregister", "register"]);
      expect(fake.registered[0]!.matches).toEqual([ADMIN_HOST_PATTERN]);
    }
  });

  it("registers nothing while the overlay is off, even with the host granted", async () => {
    const fake = fakeDeps({ enabled: false, granted: true });
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: false, registered: false, error: null });
    expect(fake.log).toEqual([]);
  });

  it("registers nothing without the host, and the setting follows the permission off", async () => {
    const fake = fakeDeps({ enabled: true, granted: false });
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: false, registered: false, error: null });
    expect(fake.log).toEqual(["setEnabled(false)"]);
    expect(fake.enabled).toBe(false);
  });

  it("unregisters and tells open admin tabs when the overlay is turned off", async () => {
    const fake = fakeDeps({ enabled: false, granted: true, registered: [registeredScript] });
    await reconcileAdminOverlay(fake);
    expect(fake.log).toEqual(["unregister", "notifyOff"]);
  });

  it("unregisters and tells open admin tabs when the permission is removed", async () => {
    const fake = fakeDeps({ enabled: true, granted: false, registered: [registeredScript] });
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: false, registered: false, error: null });
    expect(fake.log).toEqual(["setEnabled(false)", "unregister", "notifyOff"]);
  });

  it("reconciles on a worker start the same way: registers a missing script, drops a stale one", async () => {
    const restarted = fakeDeps({ enabled: true, granted: true });
    await reconcileAdminOverlay(restarted);
    expect(restarted.registered).toHaveLength(1);
    const revoked = fakeDeps({ enabled: true, granted: false, registered: [registeredScript] });
    await reconcileAdminOverlay(revoked);
    expect(revoked.registered).toHaveLength(0);
  });

  it("reports the error and claims no registration when the browser refuses", async () => {
    const fake = fakeDeps({ enabled: true, granted: true });
    fake.register = async () => {
      throw new Error("Cannot access the host");
    };
    expect(await reconcileAdminOverlay(fake)).toEqual({ enabled: false, registered: false, error: "Cannot access the host" });
  });

  it("runs one reconciliation at a time, so two changes at once never register twice", async () => {
    const fake = fakeDeps({ enabled: true, granted: true });
    const queue = new ReconcileQueue(() => reconcileAdminOverlay(fake));
    const results = await Promise.all([queue.request(), queue.request(), queue.request()]);
    expect(results.every((result) => result.registered && result.error === null)).toBe(true);
    expect(fake.log).toEqual(["register"]);
  });

  it("keeps running after a reconciliation fails", async () => {
    let calls = 0;
    const queue = new ReconcileQueue(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { enabled: true, registered: true, error: null };
    });
    await expect(queue.request()).rejects.toThrow("boom");
    expect(await queue.request()).toMatchObject({ registered: true });
  });
});

describe("the browser behind the reconciliation", () => {
  function fakeChrome(tabs: Array<{ id?: number }>) {
    const calls: string[] = [];
    const chromeApi = {
      scripting: {
        getRegisteredContentScripts: async (filter: unknown) => (calls.push(`get ${JSON.stringify(filter)}`), []),
        registerContentScripts: async (scripts: unknown[]) => void calls.push(`register ${JSON.stringify(scripts)}`),
        unregisterContentScripts: async (filter: unknown) => void calls.push(`unregister ${JSON.stringify(filter)}`),
      },
      permissions: { contains: async (query: unknown) => (calls.push(`contains ${JSON.stringify(query)}`), true) },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: true }),
          set: async (values: unknown) => void calls.push(`set ${JSON.stringify(values)}`),
        },
      },
      tabs: {
        query: async () => tabs,
        sendMessage: async (id: number, message: unknown) => {
          calls.push(`send ${id} ${JSON.stringify(message)}`);
          if (id === 2) throw new Error("Receiving end does not exist");
        },
      },
    };
    return { calls, chromeApi: chromeApi as unknown as Pick<typeof chrome, "scripting" | "permissions" | "storage" | "tabs"> };
  }

  it("registers the pinned script, asks about the admin host only, and reads the setting", async () => {
    const { calls, chromeApi } = fakeChrome([]);
    const deps = browserOverlayDeps(chromeApi, ADMIN_OVERLAY_KEY);
    await deps.register();
    await deps.unregister();
    expect(await deps.hasPermission()).toBe(true);
    expect(await deps.isEnabled()).toBe(true);
    await deps.setEnabled(false);
    expect(calls).toEqual([
      `register ${JSON.stringify([ADMIN_SCRIPT_REGISTRATION])}`,
      `unregister {"ids":["${ADMIN_SCRIPT_ID}"]}`,
      `contains {"origins":["${ADMIN_HOST_PATTERN}"]}`,
      `set {"${ADMIN_OVERLAY_KEY}":false}`,
    ]);
  });

  it("tells every open tab to clean up, ignoring tabs without the script and tabs without an id", async () => {
    const { calls, chromeApi } = fakeChrome([{ id: 1 }, { id: 2 }, {}, { id: 3 }]);
    await browserOverlayDeps(chromeApi, ADMIN_OVERLAY_KEY).notifyOff();
    expect(calls).toEqual(['send 1 {"kind":"adminOverlayOff"}', 'send 2 {"kind":"adminOverlayOff"}', 'send 3 {"kind":"adminOverlayOff"}']);
  });

  it("hands the browser a registration whose matches are exactly the admin host, written out", async () => {
    const { calls, chromeApi } = fakeChrome([]);
    await browserOverlayDeps(chromeApi, ADMIN_OVERLAY_KEY).register();
    const registered = JSON.parse(calls[0]!.slice("register ".length)) as Array<Record<string, unknown>>;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.matches).toEqual(["https://admin.powerplatform.microsoft.com/*"]);
    expect(Object.keys(registered[0]!).sort()).toEqual(["allFrames", "id", "js", "matches", "persistAcrossSessions", "runAt", "world"]);
    for (const url of PATHIX_ADDRESSES) expect(matchesPattern("https://admin.powerplatform.microsoft.com/*", url), url).toBe(false);
  });
});

// The Pathix address is the Pathix web app's own origin. With `scripting` and a
// host permission on that origin, a script run there would act as the signed-in
// user in the web app, beyond anything Pathix's server could check. So the
// scripting permission serves the admin center overlay and nothing else
// (maintainer decision, 2026-10-09; SECURITY.md).
describe("the scripting permission never reaches a Pathix origin", () => {
  const OVERLAY_SOURCE = join("src", "background", "admin-overlay.ts");
  const files = (readdirSync("src", { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).map((file) => join("src", file));
  // Raw source for the scans across src, comments included, so a "//" inside a
  // string can never hide code from them. Comments are stripped only to read
  // the shape of the calls in the overlay's own file, whose header names them.
  const raw = (file: string) => readFileSync(file, "utf8");
  const code = (file: string) => raw(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("finds the sources", () => {
    expect(files).toContain(OVERLAY_SOURCE);
    expect(files.length).toBeGreaterThan(50);
  });

  it("is named in one file, the admin center overlay's registration", () => {
    expect(files.filter((file) => /scripting/.test(raw(file)))).toEqual([OVERLAY_SOURCE]);
  });

  it("calls only registerContentScripts, unregisterContentScripts and getRegisteredContentScripts there", () => {
    const calls = [...code(OVERLAY_SOURCE).matchAll(/\bscripting\s*\.\s*(\w+)/g)].map((match) => match[1]);
    expect(calls.sort()).toEqual(["getRegisteredContentScripts", "registerContentScripts", "unregisterContentScripts"]);
  });

  it("registers only the pinned admin registration, with a match list that is not computed", () => {
    const source = code(OVERLAY_SOURCE);
    const registrations = [...source.matchAll(/\bregisterContentScripts\((.*)\),?$/gm)].map((match) => match[1]);
    expect(registrations).toEqual(["[{ ...ADMIN_SCRIPT_REGISTRATION, matches: [...ADMIN_SCRIPT_REGISTRATION.matches], js: [...ADMIN_SCRIPT_REGISTRATION.js] }]"]);
    expect([...source.matchAll(/\bmatches\s*:\s*([^,\n]*)/g)].map((match) => match[1])).toEqual([
      "[ADMIN_HOST_PATTERN]",
      "[...ADMIN_SCRIPT_REGISTRATION.matches]",
    ]);
    // Read raw: the comment stripper would cut the pattern at its "//".
    const runtime = readFileSync(join("src", "runtime", "admin-overlay.ts"), "utf8");
    expect(runtime).toMatch(/^export const ADMIN_HOST = "admin\.powerplatform\.microsoft\.com";$/m);
    expect(runtime).toMatch(/^export const ADMIN_HOST_PATTERN = `https:\/\/\$\{ADMIN_HOST\}\/\*`;$/m);
  });

  it.each([
    ["executeScript", /executeScript/],
    ["insertCSS", /insertCSS/],
    ["removeCSS", /removeCSS/],
    ["updateContentScripts", /updateContentScripts/],
    ["<all_urls>", /<all_urls>/],
    ["the scripting namespace by a computed name", /\[\s*["'`]scripting["'`]\s*\]/],
    ["the scripting namespace taken apart", /\{[^}]*\bscripting\b[^}]*\}\s*=/],
  ])("never uses %s anywhere in src", (_label, pattern) => {
    expect(files.filter((file) => pattern.test(raw(file)))).toEqual([]);
  });

  it("registers a script that never matches a Pathix address", () => {
    for (const pattern of ADMIN_SCRIPT_REGISTRATION.matches) {
      for (const url of PATHIX_ADDRESSES) expect(matchesPattern(pattern, url), `${pattern} vs ${url}`).toBe(false);
    }
  });
});

// --- the options page toggle ---------------------------------------------------------------

function fakeToggle(over: Partial<ToggleDeps> & { granted?: boolean; report?: AdminOverlayStatus } = {}) {
  const log: string[] = [];
  const { granted, report, ...overrides } = over;
  const deps: ToggleDeps = {
    recordIntent: () => void log.push("recordIntent"),
    clearIntent: async () => void log.push("clearIntent"),
    requestPermission: async (origins) => {
      log.push(`request ${origins.join(",")}`);
      return granted ?? true;
    },
    removePermission: async (origins) => {
      log.push(`remove ${origins.join(",")}`);
      return true;
    },
    setEnabled: async (enabled) => void log.push(`setEnabled(${enabled})`),
    status: async () => {
      log.push("status");
      return report ?? { enabled: true, registered: true, error: null };
    },
    ...overrides,
  };
  return { deps, log };
}

describe("turning the overlay on", () => {
  it("asks for the admin host first, and only the admin host, then stores the setting and asks the worker", async () => {
    const { deps, log } = fakeToggle();
    const result = await turnOverlayOn(deps);
    expect(log).toEqual(["recordIntent", `request ${ADMIN_HOST_PATTERN}`, "setEnabled(true)", "clearIntent", "status"]);
    expect(result).toEqual({ ok: true, status: { enabled: true, registered: true, error: null } });
  });

  it("records the intent synchronously, before the request, so the click's gesture still holds", () => {
    const { deps, log } = fakeToggle();
    void turnOverlayOn(deps);
    // Nothing awaited yet: the intent is written and the request has started in the same tick.
    expect(log).toEqual(["recordIntent", `request ${ADMIN_HOST_PATTERN}`]);
  });

  it("stores nothing, registers nothing and clears the intent when the browser says no", async () => {
    const { deps, log } = fakeToggle({ granted: false });
    const result = await turnOverlayOn(deps);
    expect(log).toEqual(["recordIntent", `request ${ADMIN_HOST_PATTERN}`, "clearIntent"]);
    expect(result).toMatchObject({ ok: false, reason: "denied", message: DENIED_MESSAGE });
  });

  it("does not claim the overlay is on when the worker did not register it", async () => {
    const { deps } = fakeToggle({ report: { enabled: false, registered: false, error: "Cannot access the host" } });
    expect(await turnOverlayOn(deps)).toMatchObject({ ok: false, reason: "failed", message: "Cannot access the host" });
  });

  it("reports a request that throws", async () => {
    const { deps } = fakeToggle({
      requestPermission: async () => {
        throw new Error("This function must be called during a user gesture");
      },
    });
    expect(await turnOverlayOn(deps)).toMatchObject({ ok: false, reason: "failed", message: "This function must be called during a user gesture" });
  });
});

describe("finishing a turn-on the popup could not finish", () => {
  const NOW = 1_000_000_000;

  function store(intent: unknown) {
    const state = { intent, enabled: false };
    const deps: IntentDeps = {
      readIntent: async () => state.intent,
      clearIntent: async () => void (state.intent = undefined),
      setEnabled: async (enabled) => void (state.enabled = enabled),
      now: () => NOW,
    };
    return { state, deps };
  }

  it("turns the setting on when the grant arrives after the popup closed with the prompt", async () => {
    const { state, deps } = store(NOW - 30_000);
    expect(await completeEnableIntent(deps)).toBe(true);
    expect(state).toEqual({ intent: undefined, enabled: true });
  });

  it("does nothing more when the popup finished first: it cleared the intent", async () => {
    // The popup's order: recordIntent, request, setEnabled(true), clearIntent. Then the worker's listener runs.
    const { deps: toggleDeps } = fakeToggle();
    const { state, deps } = store(NOW);
    toggleDeps.clearIntent = deps.clearIntent;
    toggleDeps.setEnabled = deps.setEnabled;
    await turnOverlayOn(toggleDeps);
    expect(state).toEqual({ intent: undefined, enabled: true });
    expect(await completeEnableIntent(deps)).toBe(false);
    expect(state.enabled).toBe(true);
  });

  it("is harmless when the worker finishes first and the popup then does the same", async () => {
    const { state, deps } = store(NOW);
    expect(await completeEnableIntent(deps)).toBe(true);
    await deps.setEnabled(true);
    await deps.clearIntent();
    expect(state).toEqual({ intent: undefined, enabled: true });
  });

  it.each([
    ["no intent", undefined],
    ["an intent that is not a time", "yes"],
    ["a stale intent", NOW - ADMIN_INTENT_TTL_MS - 1],
    ["an intent from the future", NOW + 60_000],
  ])("leaves the setting alone with %s, and clears what was there", async (_label, intent) => {
    const { state, deps } = store(intent);
    expect(await completeEnableIntent(deps)).toBe(false);
    expect(state.enabled).toBe(false);
    if (typeof intent === "number") expect(state.intent).toBeUndefined();
  });

  it("counts for one minute only, long enough to answer the prompt", async () => {
    expect(ADMIN_INTENT_TTL_MS).toBe(60 * 1000);
    expect(await completeEnableIntent(store(NOW - 59_000).deps)).toBe(true);
    expect(await completeEnableIntent(store(NOW - 61_000).deps)).toBe(false);
  });

  it("is cleared when the overlay is turned off, so a reversed turn-on never finishes later", async () => {
    const { state, deps } = store(NOW);
    const { deps: toggleDeps } = fakeToggle({ report: { enabled: false, registered: false, error: null } });
    toggleDeps.clearIntent = deps.clearIntent;
    await turnOverlayOff(toggleDeps);
    expect(state.intent).toBeUndefined();
    expect(await completeEnableIntent(deps)).toBe(false);
  });

  it("states the minute that remains after a deny that closed the popup", () => {
    expect(readFileSync("DESIGN.md", "utf8")).toMatch(/within that minute, a grant of the admin host by another route/i);
  });

  it("is wired to the worker's permission listeners", () => {
    const worker = readFileSync("src/background/service-worker.ts", "utf8");
    expect(worker).toContain('chrome.permissions.onAdded.addListener((permissions) => void onPermissionsChanged("added", permissions, permissionChange));');
    expect(worker).toContain('chrome.permissions.onRemoved.addListener((permissions) => void onPermissionsChanged("removed", permissions, permissionChange));');
    expect(worker).toMatch(/completeIntent: \(\) =>\s*completeEnableIntent\(/);
  });
});

describe("turning the overlay off", () => {
  it("stores the setting first, then removes the permission, then asks the worker", async () => {
    const { deps, log } = fakeToggle({ report: { enabled: false, registered: false, error: null } });
    const result = await turnOverlayOff(deps);
    expect(log).toEqual(["clearIntent", "setEnabled(false)", `remove ${ADMIN_HOST_PATTERN}`, "status"]);
    expect(result).toEqual({ ok: true, status: { enabled: false, registered: false, error: null } });
  });

  it("still turns off when the permission is already gone", async () => {
    const { deps, log } = fakeToggle({
      removePermission: async () => {
        throw new Error("not granted");
      },
      report: { enabled: false, registered: false, error: null },
    });
    expect(await turnOverlayOff(deps)).toMatchObject({ ok: true });
    expect(log).toEqual(["clearIntent", "setEnabled(false)", "status"]);
  });
});

// --- the messages ------------------------------------------------------------------------------

describe("the page script's messages", () => {
  it("accepts ids and nothing else", () => {
    expect(isAdminRoleRequest({ kind: "adminRole", organizationId: ORG, roleId: ID })).toBe(true);
    expect(isAdminRoleListRequest({ kind: "adminRoleList", organizationId: ORG, roleIds: [ID] })).toBe(true);
    expect(isAdminAppUsersRequest({ kind: "adminAppUsers", organizationId: ORG, appIds: [ID] })).toBe(true);
  });

  it("rejects a name, an extra key, a bad id and an empty or oversized list", () => {
    expect(isAdminRoleRequest({ kind: "adminRole", organizationId: ORG, roleId: "Sales Manager" })).toBe(false);
    expect(isAdminRoleRequest({ kind: "adminRole", organizationId: ORG, roleId: ID, name: "Sales Manager" })).toBe(false);
    expect(isAdminRoleListRequest({ kind: "adminRoleList", organizationId: ORG, roleIds: [] })).toBe(false);
    expect(isAdminRoleListRequest({ kind: "adminRoleList", organizationId: ORG, roleIds: [ID, "someone@contoso.com"] })).toBe(false);
    expect(isAdminAppUsersRequest({ kind: "adminAppUsers", organizationId: ORG, appIds: Array.from({ length: 501 }, () => ID) })).toBe(false);
    expect(isAdminAppUsersRequest({ kind: "adminAppUsers", organizationId: "contoso", appIds: [ID] })).toBe(false);
    expect(isAdminRoleRequest(null)).toBe(false);
    expect(isAdminRoleRequest([])).toBe(false);
  });

  it("accepts the two commands that carry nothing", () => {
    expect(isAdminOverlayStatusRequest({ kind: "adminOverlayStatus" })).toBe(true);
    expect(isAdminOverlayStatusRequest({ kind: "adminOverlayStatus", extra: 1 })).toBe(false);
    expect(isAdminOverlayOffCommand({ kind: "adminOverlayOff" })).toBe(true);
    expect(isAdminOverlayOffCommand({ kind: "adminOverlayOff", extra: 1 })).toBe(false);
  });

  it("takes requests only from this extension in a tab on the admin host", () => {
    const self = "abcdefghijklmnopabcdefghijklmnop";
    const tab = { id: 1 };
    expect(isFromAdminPage({ id: self, url: `https://${ADMIN_HOST}/manage/environments/${ORG}/appusers`, tab }, self)).toBe(true);
    expect(isFromAdminPage({ id: "other", url: `https://${ADMIN_HOST}/`, tab }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, url: `https://${ADMIN_HOST}/` }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, url: "https://login.microsoftonline.com/", tab }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, url: `https://${ADMIN_HOST}.evil.example/`, tab }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, url: `http://${ADMIN_HOST}/`, tab }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, url: "not a url", tab }, self)).toBe(false);
    expect(isFromAdminPage({ id: self, tab }, self)).toBe(false);
  });
});

describe("the answers the page script draws", () => {
  const banner = { assigned: "a", teams: null, copies: null, findings: "f", findingsCount: null, findingsFloor: false, scan: "s", href: "https://pathix.contoso.test/roles/x" };

  it("accepts the models the worker builds", () => {
    expect(isRoleBannerModel(banner)).toBe(true);
    expect(isRoleBadgeModel({ assigned: "3 assigned", findingsCount: 2, findingsFloor: true, title: "t", href: "https://pathix.contoso.test/roles/x" })).toBe(true);
    expect(isAppUserChipModel({ text: "t", title: "t", href: null })).toBe(true);
  });

  it("rejects a malformed model and a link that is not http or https, so nothing odd is drawn", () => {
    expect(isRoleBannerModel({ ...banner, assigned: 3 })).toBe(false);
    expect(isRoleBannerModel({ ...banner, href: "javascript:alert(1)" })).toBe(false);
    expect(isRoleBannerModel({ ...banner, findingsCount: -1 })).toBe(false);
    expect(isRoleBannerModel({ ...banner, findingsFloor: undefined })).toBe(false);
    expect(isRoleBadgeModel({ assigned: "x", findingsCount: 1, title: "t", href: "https://x.test/" })).toBe(false);
    expect(isRoleBadgeModel({ assigned: "x", findingsCount: 1.5, findingsFloor: false, title: "t", href: "https://x.test/" })).toBe(false);
    expect(isAppUserChipModel({ text: "t", title: "t", href: "data:text/html,x" })).toBe(false);
    expect(isAppUserChipModel(null)).toBe(false);
  });
});
