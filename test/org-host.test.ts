// The extension acts only on Dynamics 365 org hosts (a maintainer decision).
// The manifest's content scripts match every https://*.dynamics.com page,
// which includes Business Central, Finance and Operations and Commerce
// storefronts. On those both scripts must do nothing at all: no global, no
// listener, no message, no timer. These tests hold the host predicate, and
// run the real page and content bundles on a host the gate refuses, recording
// every call they make.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { CHANNEL } from "../src/bridge/messages";
import { isDynamicsOrgHost } from "../src/bridge/org-host";

describe("a Dynamics 365 org host", () => {
  it.each([
    "contoso.crm.dynamics.com",
    "contoso.crm4.dynamics.com",
    // GCC is a dynamics.com region.
    "contoso.crm9.dynamics.com",
    "contoso.crm11.dynamics.com",
    "contoso.crm22.dynamics.com",
    "contoso.crm99.dynamics.com",
    "Contoso-Dev2.CRM.Dynamics.COM",
    "org1a2b3c4d.crm.dynamics.com",
  ])("admits %s", (host) => {
    expect(isDynamicsOrgHost(host)).toBe(true);
  });

  it.each([
    // An extra label: the Web API host and the like are not the app.
    "contoso.api.crm.dynamics.com",
    "a.b.crm.dynamics.com",
    // Other Microsoft products on dynamics.com.
    "businesscentral.dynamics.com",
    "contoso.operations.dynamics.com",
    "contoso.sandbox.operations.dynamics.com",
    "contoso.commerce.dynamics.com",
    "home.dynamics.com",
    "crm.dynamics.com",
    "dynamics.com",
    // Sovereign clouds: not supported yet.
    "contoso.crm.microsoftdynamics.us",
    "contoso.crm9.dynamics.com.cn",
    "contoso.crm.appsplatform.us",
    "contoso.crm.dynamics.cn",
    // Lookalikes.
    "contoso.crm.dynamics.com.evil.com",
    "contoso.crmx.dynamics.com",
    "contoso.crm.dynamics.co",
    "contoso.crm.dynamics.com:8443",
    "contoso.crm.dynamics.com.",
    "conto so.crm.dynamics.com",
    "",
  ])("refuses %s", (host) => {
    expect(isDynamicsOrgHost(host)).toBe(false);
  });
});

/** The bundle build.mjs makes for an entry, as text. */
async function bundle(entry: string): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", target: "chrome113", logLevel: "silent" });
  return result.outputFiles[0]!.text;
}

/**
 * Runs a bundle with a page on `host`. Every global it reaches, other than the
 * location's host and the built-ins, is a stub that records each call made on
 * it, and each read of `chrome`.
 */
function runOn(code: string, host: string): { calls: string[]; global: Record<string, unknown>; error: unknown } {
  const calls: string[] = [];
  const stub = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_target, property) => (typeof property === "symbol" ? undefined : stub(`${path}.${property}`)),
      apply: (_target, _this, _args) => {
        calls.push(path);
        return stub(`${path}()`);
      },
      construct: () => {
        calls.push(`new ${path}`);
        return stub(`new ${path}`) as object;
      },
    });
  const location = { host, origin: `https://${host}` };
  const global: Record<string, unknown> = {};
  const window = new Proxy(global, {
    get: (target, property) => {
      if (property === "location") return location;
      if (property in target) return target[property as string];
      // Not set on a fresh page: the page script's flag, and Xrm.
      if (property === CHANNEL || property === "Xrm") return undefined;
      return typeof property === "symbol" ? undefined : stub(`window.${property}`);
    },
  });
  const chrome = new Proxy(
    {},
    {
      get: (_target, property) => {
        calls.push(`chrome.${String(property)}`);
        return stub(`chrome.${String(property)}`);
      },
    },
  );
  const context = { URL, window, document: stub("document"), chrome, console: stub("console"), CSS: stub("CSS"), setInterval: stub("setInterval"), setTimeout: stub("setTimeout") };
  let error: unknown = null;
  try {
    runInNewContext(code, context);
  } catch (thrown) {
    // The stubs are not a real page. A refused host must not get this far; on an org host, the calls made before it count.
    error = thrown;
  }
  return { calls, global, error };
}

describe("the gate", () => {
  it("imports nothing, so the page script stays small and calls nothing", () => {
    expect(readFileSync("src/bridge/org-host.ts", "utf8")).not.toMatch(/^\s*import\b/m);
  });

  it("is checked before anything runs in each entry point", () => {
    expect(readFileSync("src/page/main-world.ts", "utf8")).toContain("if (isDynamicsOrgHost(window.location.host) && !");
    expect(readFileSync("src/content/content.ts", "utf8")).toMatch(/\nif \(isDynamicsOrgHost\(window\.location\.host\)\) start\(\);\n$/);
  });
});

describe("on a dynamics.com page that is not a Dynamics 365 org", () => {
  const hosts = ["businesscentral.dynamics.com", "contoso.operations.dynamics.com", "contoso.commerce.dynamics.com", "contoso.crm.microsoftdynamics.us"];

  it.each(hosts)("the page script sets no flag, adds no listener, posts nothing and starts no timer on %s", async (host) => {
    const { calls, global, error } = runOn(await bundle("src/page/main-world.ts"), host);
    expect(error).toBeNull();
    expect(calls).toEqual([]);
    expect(global[CHANNEL]).toBeUndefined();
  });

  it.each(hosts)("the content script makes no call at all on %s", async (host) => {
    const { calls, error } = runOn(await bundle("src/content/content.ts"), host);
    expect(error).toBeNull();
    expect(calls).toEqual([]);
  });

  // The control: the same harness sees the scripts start on an org host.
  it("both scripts start on an org host", async () => {
    const page = runOn(await bundle("src/page/main-world.ts"), "contoso.crm.dynamics.com");
    expect(page.global[CHANNEL]).toBe(true);
    expect(page.calls).toEqual(expect.arrayContaining(["window.addEventListener", "window.postMessage", "window.setInterval"]));
    const content = runOn(await bundle("src/content/content.ts"), "contoso.crm.dynamics.com");
    expect(content.calls.length, String(content.error)).toBeGreaterThan(0);
  });
});
