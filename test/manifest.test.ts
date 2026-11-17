import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, checkReleaseManifest, isManifestVersion, LICENSE_FILES, versionFromTag } from "../scripts/manifest.mjs";
import { POLICY_HIDE_TIPS_KEY } from "../src/runtime/card-settings";
import { matchesPattern, PATHIX_ADDRESSES } from "./match-pattern";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pathix-manifest-"));
}

/** A PNG's width and height, read from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the committed manifest", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

  // M15: the store copy. The stores show the name and description; Chrome caps
  // the description at 132 characters. It must be true in Lite and connected
  // alike, and say the product is not Microsoft's.
  it("carries the store name and a description true in both modes", () => {
    expect(manifest.name).toBe("Pathix for Dynamics 365");
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.description).toContain("registered to fire");
    expect(manifest.description).toContain("with Pathix");
    expect(manifest.description).toContain("Not affiliated with Microsoft.");
    for (const text of [manifest.name, manifest.description]) {
      expect(text).not.toMatch(/prototype|not for distribution|®|—/i);
    }
  });

  it("carries no key", () => {
    expect(manifest).not.toHaveProperty("key");
  });

  // New permissions or host patterns need the maintainer's approval (CLAUDE.md).
  // M14, 2026-10-07: the admin center host as an optional host permission, and
  // "scripting" to register its page script at runtime. test/admin-overlay.test.ts
  // pins what that registration may match.
  it("asks for no permissions or host patterns beyond the approved ones", () => {
    expect(manifest.permissions).toEqual(["identity", "storage", "scripting"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "https://admin.powerplatform.microsoft.com/*"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts.map((script: { matches: string[] }) => script.matches)).toEqual([
      ["https://*.dynamics.com/*"],
      ["https://*.dynamics.com/*"],
    ]);
  });

  // The Pathix address is the Pathix web app's own origin, so no script may run
  // there (SECURITY.md). The static content scripts match Microsoft's Dynamics
  // hosts only, a domain no customer's Pathix can be served from, and nothing
  // widens them.
  it("declares content scripts for the Dynamics hosts only, which never match a Pathix address", () => {
    const scripts = manifest.content_scripts as Array<Record<string, unknown>>;
    for (const script of scripts) {
      expect(script.matches).toEqual(["https://*.dynamics.com/*"]);
      expect(Object.keys(script).sort()).toEqual(script.world === "MAIN" ? ["js", "matches", "run_at", "world"] : ["js", "matches", "run_at"]);
    }
    const patterns = scripts.flatMap((script) => script.matches as string[]);
    for (const pattern of patterns) {
      expect(pattern).not.toMatch(/<all_urls>|^\*:\/\/|^https?:\/\/\*\//);
      for (const url of PATHIX_ADDRESSES) expect(matchesPattern(pattern, url), `${pattern} vs ${url}`).toBe(false);
    }
  });

  // The toolbar popup (2026-10-09): every form feature is one click from the
  // toolbar icon. A popup is an extension page and adds no permission; the
  // permission test above holds that nothing was added with it.
  it("opens the toolbar popup from the toolbar icon, with a title that names no shortcut", () => {
    expect(manifest.action).toEqual({
      default_title: "Pathix: X-ray, event map, what changed and save preview for Dynamics 365 forms",
      default_popup: "popup.html",
      default_icon: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png" },
    });
    expect(manifest.action.default_title).not.toMatch(/Alt\+|Shift\+/);
    expect(readFileSync(join("static", manifest.action.default_popup), "utf8")).toContain('<script src="popup.js"></script>');
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "action",
        "background",
        "commands",
        "content_scripts",
        "description",
        "icons",
        "manifest_version",
        "minimum_chrome_version",
        "name",
        "optional_host_permissions",
        "options_ui",
        "permissions",
        "storage",
        "version",
      ].sort(),
    );
  });

  // Keyboard shortcuts (2026-10-09): manifest commands, so the browser owns the
  // keys and the user can rebind or clear them at edge://extensions/shortcuts.
  // `commands` is a manifest key, not a permission; the permission test above
  // holds that nothing was added with it. A command's key works in every tab,
  // so only the popup's own command suggests one. Every other shortcut is the
  // user's choice. On a Mac, Alt is Option, which types characters: the popup's
  // key there uses Control instead.
  it("declares six commands, with a suggested key for the popup only", () => {
    expect(manifest.commands).toEqual({
      _execute_action: { suggested_key: { default: "Alt+Shift+Q", mac: "MacCtrl+Shift+Q" }, description: "Open the Pathix window" },
      "toggle-xray": { description: "Turn X-ray on or off" },
      "open-event-map": { description: "Open the form event map" },
      "open-what-changed": { description: "Open what changed on this table" },
      "open-save-preview": { description: "Open the save preview" },
      "open-field-card": { description: "Open the card for the field that has focus" },
    });
    for (const command of Object.values(manifest.commands as Record<string, { description: string }>)) {
      expect(command.description).not.toContain("—");
    }
  });

  it("gives the popup's Mac key the same letter, with Control rather than Option", () => {
    const { default: windows, mac } = manifest.commands._execute_action.suggested_key as { default: string; mac: string };
    expect(mac).toMatch(/^MacCtrl\+Shift\+[A-Z]$/);
    expect(mac).not.toMatch(/Alt|Option/);
    expect(mac.at(-1)).toBe(windows.at(-1));
  });

  it("keeps the popup's key on one line of the manifest, so changing the letter is a one-line edit", () => {
    const lines = readFileSync("manifest.json", "utf8").split("\n").filter((line) => /Shift\+[A-Z]"/.test(line));
    expect(lines).toEqual(['      "suggested_key": { "default": "Alt+Shift+Q", "mac": "MacCtrl+Shift+Q" },']);
  });

  it("declares the managed policy schema, with the key the extension reads", () => {
    expect(manifest.storage).toEqual({ managed_schema: "managed_schema.json" });
    const schema = JSON.parse(readFileSync(join("static", manifest.storage.managed_schema), "utf8"));
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual([POLICY_HIDE_TIPS_KEY]);
    expect(schema.properties[POLICY_HIDE_TIPS_KEY].type).toBe("boolean");
  });
});

describe("buildManifest", () => {
  it("builds without a key when there is no local key file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x" }));
    expect(await buildManifest(join(dir, "manifest.json"), join(dir, "missing.json"))).toEqual({ name: "x" });
  });

  it("adds the key from the local key file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ key: "MIIBIjAN" }));
    expect(await buildManifest(join(dir, "manifest.json"), join(dir, "key.json"))).toEqual({ name: "x", key: "MIIBIjAN" });
  });

  it("refuses a manifest that carries a key itself", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x", key: "MIIBIjAN" }));
    await expect(buildManifest(join(dir, "manifest.json"), join(dir, "missing.json"))).rejects.toThrow(/must not carry a key/);
  });

  it("refuses a local key file without a key", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ value: "MIIBIjAN" }));
    await expect(buildManifest(join(dir, "manifest.json"), join(dir, "key.json"))).rejects.toThrow(/must be/);
  });

  it("builds the committed manifest without a key when there is no local key file", async () => {
    const built = await buildManifest("manifest.json", join(tempDir(), "missing.json"));
    expect(built).not.toHaveProperty("key");
    expect(built).toEqual(JSON.parse(readFileSync("manifest.json", "utf8")));
  });
});

// M5: the release workflow builds with `node build.mjs --release <tag>`.
describe("a release build", () => {
  it("takes the version from the tag, carries no key, and changes nothing else", async () => {
    const committed = JSON.parse(readFileSync("manifest.json", "utf8"));
    const built = await buildManifest("manifest.json", join(tempDir(), "missing.json"), { version: "1.2.3" });
    expect(built).not.toHaveProperty("key");
    expect(built).toEqual({ ...committed, version: "1.2.3" });
  });

  it("refuses to run while a local key file exists, rather than leave the key out quietly", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x", version: "0.0.1" }));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ key: "MIIBIjAN" }));
    await expect(buildManifest(join(dir, "manifest.json"), join(dir, "key.json"), { version: "1.2.3" })).rejects.toThrow(
      /never carries a key/,
    );
  });

  it("refuses a version the browser would not accept", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x", version: "0.0.1" }));
    await expect(buildManifest(join(dir, "manifest.json"), join(dir, "missing.json"), { version: "1.2.3-beta" })).rejects.toThrow(
      /not a valid extension version/,
    );
  });
});

describe("isManifestVersion", () => {
  it.each(["0", "1", "0.0.1", "1.2.3", "1.2.3.4", "65535.65535.65535.65535", "10.0.200"])("accepts %s", (version) => {
    expect(isManifestVersion(version)).toBe(true);
  });

  it.each(["", "1.2.3.4.5", "01", "1.02.3", "65536", "1.2.3-beta", "1.2.3+build", "1..2", ".1", "1.", " 1.2", "1.2 ", "-1", "+1", "1e3", "0x1", "v1.2.3"])(
    "rejects %j",
    (version) => {
      expect(isManifestVersion(version)).toBe(false);
    },
  );

  it("rejects anything that is not a string", () => {
    expect(isManifestVersion(1)).toBe(false);
    expect(isManifestVersion(undefined)).toBe(false);
  });
});

describe("versionFromTag", () => {
  it("strips the leading v", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("v0.1")).toBe("0.1");
  });

  it("refuses a tag without the leading v", () => {
    expect(() => versionFromTag("1.2.3")).toThrow(/must start with "v"/);
    expect(() => versionFromTag("V1.2.3")).toThrow(/must start with "v"/);
  });

  it("refuses pre-release suffixes, which browsers do not accept, with a clear reason", () => {
    expect(() => versionFromTag("v1.2.3-beta")).toThrow(/suffixes such as -beta/);
    expect(() => versionFromTag("v1.2.3-rc.1")).toThrow(/does not name a valid extension version/);
  });

  it("refuses versions outside Chrome's rules", () => {
    for (const tag of ["v", "vv1.2.3", "v1.2.3.4.5", "v1.02", "v70000"]) expect(() => versionFromTag(tag), tag).toThrow();
  });
});

describe("checkReleaseManifest", () => {
  const SHIPPABLE = { name: "Pathix for Dynamics 365", description: "Explains forms.", version: "1.2.3", icons: { "128": "icons/128.png" } };
  const FILES = ["manifest.json", "content.js", "icons/128.png", "LICENSE", "NOTICE"];

  it("accepts a manifest with the tag's version, no key, store copy and a 128 px icon", () => {
    expect(() => checkReleaseManifest(SHIPPABLE, "1.2.3", FILES)).not.toThrow();
  });

  it("refuses a manifest that carries a key", () => {
    expect(() => checkReleaseManifest({ ...SHIPPABLE, key: "MIIBIjAN" }, "1.2.3", FILES)).toThrow(/carries a key/);
  });

  it("refuses a manifest whose version is not the tag's", () => {
    expect(() => checkReleaseManifest({ ...SHIPPABLE, version: "0.0.1" }, "1.2.3", FILES)).toThrow(/tag names "1.2.3"/);
  });

  it.each([
    ["name", { ...SHIPPABLE, name: "Pathix for Dynamics 365 (prototype)" }],
    ["name", { ...SHIPPABLE, name: "Pathix PROTOTYPE" }],
    ["description", { ...SHIPPABLE, description: "Shows Pathix data. Prototype; not for distribution." }],
    ["description", { ...SHIPPABLE, description: "Not For Distribution." }],
  ])("refuses a manifest whose %s says it is not for the stores", (field, manifest) => {
    expect(() => checkReleaseManifest(manifest, "1.2.3", FILES)).toThrow(new RegExp(`manifest's ${field} says it is a prototype or not for distribution`));
  });

  it("refuses a manifest whose 128 px icon is not in the package", () => {
    expect(() => checkReleaseManifest(SHIPPABLE, "1.2.3", ["manifest.json", "icons/48.png"])).toThrow(
      /icons\["128"\] is "icons\/128\.png", but the package has no such file/,
    );
    expect(() => checkReleaseManifest({ ...SHIPPABLE, icons: { "128": "/icons/128.png" } }, "1.2.3", FILES)).not.toThrow();
    expect(() => checkReleaseManifest({ ...SHIPPABLE, icons: { "128": "./icons/128.png" } }, "1.2.3", FILES)).not.toThrow();
  });

  it("is given the zip's own file list by the release check", () => {
    const script = readFileSync("scripts/check-release.mjs", "utf8");
    expect(script).toContain('execFileSync("unzip", ["-Z1", zip]');
    expect(script).toContain("checkReleaseManifest(JSON.parse(text), version, files)");
  });

  it.each(["LICENSE", "NOTICE"])("refuses a package with no %s at its root", (file) => {
    const without = FILES.filter((path) => path !== file);
    expect(() => checkReleaseManifest(SHIPPABLE, "1.2.3", without)).toThrow(new RegExp(`The package has no ${file} at its root`));
    expect(() => checkReleaseManifest(SHIPPABLE, "1.2.3", [...without, `docs/${file}`])).toThrow(new RegExp(`no ${file} at its root`));
  });

  it("is given LICENSE and NOTICE by the build, at the root of dist/", () => {
    expect(LICENSE_FILES).toEqual(["LICENSE", "NOTICE"]);
    expect(readFileSync("build.mjs", "utf8")).toContain("for (const file of LICENSE_FILES) await cp(file, `${outdir}/${file}`);");
  });

  it("refuses a manifest with no 128 px icon, saying the stores need one", () => {
    for (const icons of [undefined, null, {}, { "48": "icons/48.png" }, { "128": "" }]) {
      expect(() => checkReleaseManifest({ ...SHIPPABLE, icons }, "1.2.3", FILES)).toThrow(/no icons\["128"\]\. The Chrome Web Store and Edge Add-ons need a 128 px icon/);
    }
  });

  // The committed manifest passes the release check against the files the
  // build packages (static/ is copied to the root of dist/, and so are
  // LICENSE and NOTICE).
  it("passes the release check with the committed manifest and its icons", () => {
    const committed = JSON.parse(readFileSync("manifest.json", "utf8"));
    const packaged = ["manifest.json", ...LICENSE_FILES, ...readdirSync(join("static", "icons")).map((file) => `icons/${file}`)];
    expect(() => checkReleaseManifest({ ...committed, version: "1.2.3" }, "1.2.3", packaged)).not.toThrow();
  });

  // Every icon the manifest names is a PNG of the size its key declares.
  it("names icons that are PNGs of their declared size", () => {
    const committed = JSON.parse(readFileSync("manifest.json", "utf8"));
    const named = { ...committed.icons, ...committed.action.default_icon } as Record<string, string>;
    expect(Object.keys(named).sort()).toEqual(["128", "16", "32", "48"]);
    for (const [size, path] of Object.entries(named)) {
      expect(pngSize(readFileSync(join("static", path)))).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  it("refuses something that is not a manifest", () => {
    for (const value of [null, "{}", [], 1]) expect(() => checkReleaseManifest(value, "1.2.3", FILES)).toThrow(/not a JSON object/);
  });
});
