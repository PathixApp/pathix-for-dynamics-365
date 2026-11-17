// The options page (M15): the Pathix address is all the user enters, and a
// Pathix that offers the extension no sign-in is explained in plain words,
// with no Sign in button. The page script itself needs a DOM, so its copy and
// its choice of buttons live in src/options/connection-view.ts and are tested
// here; the page's markup is read as text.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOT_KEPT_TEXT } from "../src/background/sign-in";
import type { SignInBinding } from "../src/auth/binding";
import { accountView, changedText, savedErrorLine, savedLine, signInUnavailableText, unreachableText } from "../src/options/connection-view";
import { REDIRECT_TEXT } from "../src/pathix/api";
import { originToRelease } from "../src/pathix/settings";
import type { SignInUnavailable } from "../src/pathix/api";
import type { AccountStatus } from "../src/runtime/messages";

const html = readFileSync("static/options.html", "utf8");
const script = readFileSync("src/options/options.ts", "utf8");

function status(overrides: Partial<AccountStatus>): AccountStatus {
  return {
    configured: true,
    signedIn: false,
    account: null,
    error: null,
    signInUnavailable: null,
    pathixUnreachable: null,
    offered: null,
    changed: [],
    signOutOffered: false,
    ...overrides,
  };
}

const COPY: Array<[SignInUnavailable, string]> = [
  [
    "olderPathix",
    "This Pathix is an older version that does not offer sign-in for the extension. Ask your Pathix administrator to update Pathix.",
  ],
  ["notRegistered", "This Pathix has no browser extension registration. Ask your Pathix administrator to set one up."],
  ["invalidRegistration", "The extension registration on this Pathix looks wrong. Ask your Pathix administrator to check it."],
  ["signInOff", "This Pathix does not have Entra sign-in configured. Ask your Pathix administrator to set it up."],
  [
    "grantsMoreThanRead",
    "The extension registration on this Pathix grants more than read access. Ask your Pathix administrator to remove the other permissions and their consent.",
  ],
];

describe("the options page asks for the Pathix address only", () => {
  it("has no client ID field", () => {
    expect(html).not.toMatch(/client-id|client ID/i);
    expect(script).not.toMatch(/client-id|clientIdInput|parseClientId/);
  });

  it("has one input in the settings form, the address", () => {
    const form = html.slice(html.indexOf('<form id="settings"'), html.indexOf("</form>"));
    expect([...form.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1])).toEqual(["pathix-url"]);
  });

  it("saves the address only, and removes a client ID an earlier build stored", () => {
    expect(script).toContain("chrome.storage.local.set({ pathixUrl: url.value })");
    expect(script).toContain("chrome.storage.local.remove(LEGACY_CLIENT_ID_KEY)");
    expect(script).toContain('chrome.storage.local.remove(["pathixUrl", LEGACY_CLIENT_ID_KEY])');
  });
});

describe("when this Pathix offers the extension no sign-in", () => {
  it.each(COPY)("%s: says why and what to ask for", (reason, text) => {
    expect(signInUnavailableText(reason)).toBe(text);
  });

  it.each(COPY)("%s: the account section shows it, with no Sign in button", (reason, text) => {
    expect(accountView(status({ signInUnavailable: reason }))).toEqual({
      line: { text, tone: "error" },
      signIn: false,
      signOut: false,
      trust: null,
    });
  });

  it.each(COPY)("%s: follows the copy rules", (_reason, text) => {
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/upgrade|®/i);
    expect(text).toMatch(/administrator/);
    for (const sentence of text.split(/(?<=\.) /)) expect(sentence.split(" ").length).toBeLessThanOrEqual(16);
  });

  it("after Save and connect, says the address is saved but the extension cannot sign in", () => {
    expect(savedLine({ ok: false, unavailable: "notRegistered" })).toEqual({
      text: "Saved, but the extension cannot sign in to this Pathix.",
      tone: "error",
    });
  });
});

describe("when this Pathix offers sign-in", () => {
  it("after Save and connect, names the tenant", () => {
    const config = { tenantId: "tenant-1", authority: "https://login.microsoftonline.com/tenant-1", clientId: "c", apiScope: "s" };
    expect(savedLine({ ok: true, config })).toEqual({ text: "Found Pathix. It signs in through tenant tenant-1.", tone: "ok" });
  });

  it("offers Sign in when signed out", () => {
    expect(accountView(status({}))).toEqual({ line: { text: "Not signed in.", tone: "neutral" }, signIn: true, signOut: false, trust: null });
  });

  it("offers Sign out when signed in", () => {
    expect(accountView(status({ signedIn: true, account: "user@contoso.com" }))).toEqual({
      line: { text: "Signed in as user@contoso.com.", tone: "ok" },
      signIn: false,
      signOut: true,
      trust: null,
    });
  });

  it("offers Sign in again after a sign-in that did not complete", () => {
    expect(accountView(status({ error: "access_denied" }))).toEqual({
      line: { text: "Sign-in did not complete: access_denied", tone: "error" },
      signIn: true,
      signOut: false,
      trust: null,
    });
  });

  it("says so when a sign-in's token was not kept because the settings changed meanwhile", () => {
    expect(accountView(status({ error: NOT_KEPT_TEXT }))).toEqual({
      line: {
        text: "Sign-in did not complete: Pathix's sign-in settings changed while you were signing in. Sign in again.",
        tone: "error",
      },
      signIn: true,
      signOut: false,
      trust: null,
    });
    expect(NOT_KEPT_TEXT).not.toMatch(/—|upgrade/);
  });
});

// A 502 or a dropped connection says nothing about sign-in: the page says
// Pathix did not answer, never that a sign-in failed, and reports the stored
// token as it is.
describe("when Pathix's /config could not be read", () => {
  const detail = "Pathix /config answered 502.";

  it("keeps a signed-in user signed in, and says Pathix did not answer", () => {
    expect(accountView(status({ signedIn: true, account: "user@contoso.com", pathixUnreachable: detail }))).toEqual({
      line: { text: "Signed in as user@contoso.com. Could not reach Pathix just now. Details: Pathix /config answered 502.", tone: "error" },
      signIn: false,
      signOut: true,
      trust: null,
    });
  });

  it("says so when no token is stored, and keeps Sign in as a retry", () => {
    expect(accountView(status({ pathixUnreachable: "Failed to fetch" }))).toEqual({
      line: { text: "Not signed in. Could not reach Pathix just now. Details: Failed to fetch.", tone: "error" },
      signIn: true,
      signOut: false,
      trust: null,
    });
  });

  it("never says a sign-in failed or did not complete", () => {
    for (const signedIn of [true, false]) {
      const view = accountView(status({ signedIn, account: signedIn ? "user@contoso.com" : null, pathixUnreachable: detail }));
      expect(view.line.text).not.toMatch(/did not complete|failed/i);
    }
  });

  // Review round 2: a redirect is an answer, said on its own, never as "could not reach Pathix".
  it("says a redirect on its own, on the account line and after Save and connect", () => {
    expect(unreachableText(REDIRECT_TEXT)).toBe(REDIRECT_TEXT);
    expect(accountView(status({ pathixUnreachable: REDIRECT_TEXT })).line.text).toBe(`Not signed in. ${REDIRECT_TEXT}`);
    expect(accountView(status({ pathixUnreachable: REDIRECT_TEXT })).line.text).not.toContain("Could not reach Pathix");
    expect(savedErrorLine(REDIRECT_TEXT)).toEqual({
      text: "Saved. Pathix answered with a redirect, for example to a sign-in gateway. The extension needs an address that answers /api/config directly.",
      tone: "error",
    });
    expect(savedErrorLine("Pathix /config answered 502.").text).toBe("Saved, but Pathix did not answer as expected: Pathix /config answered 502.");
  });

  it("words an empty detail without a Details part", () => {
    expect(unreachableText("  ")).toBe("Could not reach Pathix just now.");
  });
});

describe("with no address saved", () => {
  it("asks for the address and offers no Sign in", () => {
    expect(accountView(status({ configured: false }))).toEqual({
      line: { text: "Save your Pathix address first.", tone: "neutral" },
      signIn: false,
      signOut: false,
      trust: null,
    });
  });
});

// D1: before an interactive sign-in the page shows what it trusts, and only
// that click confirms it. A changed tenant, sign-in host, client or scope for
// the same address is named, and waits for a new click.
describe("before Sign in", () => {
  const offered: SignInBinding = {
    pathixUrl: "https://pathix.contoso.com",
    authority: "https://login.microsoftonline.com/10000000-0000-4000-8000-000000000001",
    tenantId: "10000000-0000-4000-8000-000000000001",
    clientId: "40000000-0000-4000-8000-000000000004",
    apiScope: "api://20000000-0000-4000-8000-000000000002/Pathix.Read",
  };

  it("lists the Pathix address, the tenant, the sign-in host and the API", () => {
    expect(accountView(status({ offered })).trust).toEqual([
      { label: "Pathix address", value: "https://pathix.contoso.com" },
      { label: "Tenant ID", value: "10000000-0000-4000-8000-000000000001" },
      { label: "Sign-in host", value: "login.microsoftonline.com" },
      { label: "API", value: "api://20000000-0000-4000-8000-000000000002" },
    ]);
  });

  it("shows nothing to trust once signed in, or when there is no Sign in", () => {
    expect(accountView(status({ offered, signedIn: true, account: "user@contoso.com" })).trust).toBeNull();
    expect(accountView(status({ offered, signInUnavailable: "notRegistered" })).trust).toBeNull();
    expect(accountView(status({ offered, configured: false })).trust).toBeNull();
  });

  it("says what changed since the user signed in, and offers Sign in", () => {
    const view = accountView(status({ offered, changed: ["tenant", "signInHost"] }));
    expect(view.line).toEqual({
      text: "Pathix's sign-in settings changed since you signed in: the tenant and the sign-in host. Check them below, then select Sign in.",
      tone: "error",
    });
    expect(view.signIn).toBe(true);
    expect(view.trust).not.toBeNull();
    expect(changedText(["client"])).toBe(
      "Pathix's sign-in settings changed since you signed in: the extension's app registration. Check them below, then select Sign in.",
    );
    expect(changedText(["tenant", "client", "scope"])).toContain("the tenant, the extension's app registration and the API.");
  });

  // Review round 1: settings that changed hold sign-in, but the old token and
  // binding are still stored, so Sign out stays to remove them.
  it("offers Sign out as well as Sign in while an old sign-in is stored", () => {
    const view = accountView(status({ offered, changed: ["tenant"], signOutOffered: true }));
    expect(view).toMatchObject({ signIn: true, signOut: true });
    expect(accountView(status({ signOutOffered: true, signInUnavailable: "notRegistered" })).signOut).toBe(true);
    expect(accountView(status({ offered })).signOut).toBe(false);
  });

  it("has a place for the list, built from text, never markup", () => {
    expect(html).toContain('id="sign-in-trust"');
    expect(html).toContain('id="sign-in-trust-list"');
    expect(script).toContain("textContent = line.label");
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });

  it("sends back what it showed, so the worker signs in only for that", () => {
    expect(script).toContain('runAccountAction({ kind: "signIn", binding: offered })');
  });
});

describe("a new address", () => {
  it("gives back the old address's permission, and keeps the one still in use", () => {
    expect(originToRelease("https://old.contoso.com", "https://pathix.contoso.com")).toBe("https://old.contoso.com/*");
    expect(originToRelease("https://pathix.contoso.com", "https://pathix.contoso.com")).toBeNull();
    expect(originToRelease(undefined, "https://pathix.contoso.com")).toBeNull();
    expect(originToRelease("", "https://pathix.contoso.com")).toBeNull();
    expect(originToRelease("https://admin.powerplatform.microsoft.com", "https://pathix.contoso.com")).toBeNull();
    expect(originToRelease("https://old.contoso.com", null)).toBe("https://old.contoso.com/*");
  });

  // An earlier build saved any https origin. Giving back "https://*/*" would take the admin overlay's grant too.
  it("gives nothing back for an old address this build refuses", () => {
    for (const previous of ["https://*", "https://*.crm.dynamics.com", "https://contoso.crm.dynamics.com", "https://login.microsoftonline.com", "not a url"]) {
      expect(originToRelease(previous, null)).toBeNull();
      expect(originToRelease(previous, "https://pathix.contoso.com")).toBeNull();
    }
  });

  it("is saved after reading the old one, whose permission is then removed", () => {
    expect(script).toContain("originToRelease(previous, url.value)");
    expect(script).toContain("chrome.permissions.remove({ origins: [release] })");
  });

  it("is removed with the same guard, so removing it never takes the admin overlay's permission", () => {
    const remove = /async function removeAddress\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(script)?.[1] ?? "";
    expect(remove).toContain("originToRelease(stored.pathixUrl, null)");
    expect(remove).toContain("chrome.permissions.remove({ origins: [release] })");
    // Every permission the options page gives back for an address goes through the guard.
    expect(script.match(/chrome\.permissions\.remove\(/g)).toHaveLength(2);
    expect(script).not.toMatch(/permissions\.remove\(\{ origins: \[originPattern/);
  });
});
