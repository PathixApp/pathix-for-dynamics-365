// Fitness test for the metadata-only rule (DESIGN.md, "Names, never values")
// on the code that runs inside the D365 page. The bridge validator catches a
// value that is shaped wrong; this catches the code that would read one in
// the first place.
//
// If a future surface genuinely needs one of these calls, that is a design
// discussion first, not an allowlist edit.

import { readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const PAGE_SIDE_DIRS = ["src/page", "src/bridge"];

/** The scripts that run in a page the extension does not own, by bundle, as build.mjs names their entry points. */
const PAGE_BUNDLES = {
  page: "src/page/main-world.ts",
  content: "src/content/content.ts",
  admin: "src/admin/admin.ts",
} as const;

/** Every source file a bundle is built from, as esbuild resolves the imports: a read in a shared module counts. */
async function bundleSources(entry: string): Promise<string[]> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: "iife", target: "chrome113", logLevel: "silent" });
  return Object.keys(result.metafile.inputs).map((file) => normalize(file));
}

const bundles = Object.fromEntries(
  await Promise.all(Object.entries(PAGE_BUNDLES).map(async ([name, entry]) => [name, await bundleSources(entry)] as const)),
) as Record<keyof typeof PAGE_BUNDLES, string[]>;

const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;

const FORBIDDEN: Array<[string, RegExp]> = [
  ["reading a field value", /\.getValue\s*\(/],
  ["reading a formatted value", /getFormattedValue/],
  ["reading the record's name", /getPrimaryAttributeValue/],
  // M2 reads which columns are dirty (getIsDirty); never what the edit was.
  ["reading a field's value before the edit", /getInitialValue/],
  ["reading the form's data as XML", /getDataXml/],
  ["reading a choice's selected option", /getSelectedOption/],
  ["reading the form's changed data", /getChanges|getDirtyAttributes/],
  ["reading the record id", /entity\s*\.\s*getId\s*\(/],
  ["reading an entity reference", /getEntityReference/],
  ["reading a lookup's text", /\.getText\s*\(/],
  ["reading the full URL", /location\s*\.\s*(href|search|hash|pathname)/],
  ["calling the record Web API", /WebApi|retrieveRecord|retrieveMultipleRecords/],
  ["opening a network channel", NETWORK],
];

describe("page-side code stays metadata-only", () => {
  const files = [...new Set([...sourceFiles(PAGE_SIDE_DIRS), ...bundles.page])];

  it("finds the page-side sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("never contains %s", (_label, pattern) => {
    expect(offendersOf(files, pattern)).toEqual([]);
  });
});

// The page script may call only these Xrm getters. Each reads a NAME or a
// setting, never a value: the table, a control or column name, whether a column
// is dirty, how a column is submitted ("always", "dirty" or "never", read for
// the save preview), whether a control is read-only, the form's type and the
// form definition's id. For a quick view, getControl lists its
// inner controls, read like the form's own for their name and bound column,
// and getParent finds the entity an inner attribute belongs to, read only for
// its logical name (the quick view's table). Adding a getter here is a design
// discussion first (DESIGN.md, "Names, never values"), and is why this list is
// closed.
const ALLOWED_PAGE_GETTERS = [
  "getAttribute",
  "getControl",
  "getCurrentItem",
  "getDisabled",
  "getEntityName",
  "getFormType",
  "getGlobalContext",
  "getId",
  "getIsDirty",
  "getName",
  "getParent",
  "getSubmitMode",
];

describe("the page script reads through a closed set of Xrm getters", () => {
  const files = sourceFiles(PAGE_SIDE_DIRS);

  it("names no getter outside the list", () => {
    const used = new Set(files.flatMap((file) => [...stripComments(readFileSync(file, "utf8")).matchAll(/\bget[A-Z][A-Za-z]*/g)].map((match) => match[0])));
    expect([...used].filter((name) => !ALLOWED_PAGE_GETTERS.includes(name))).toEqual([]);
  });

  // A collection's get() names no getter, so the list above cannot see it.
  // Four collections are read, each a list of names or ids: the form's
  // controls, the record's attributes (for their names and settings), the
  // forms the user can open (for the one form's id when the selector names
  // none), and the form's quick views (for their names and inner controls).
  it("reads only the controls, attributes, form items and quick view collections", () => {
    const source = files.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
    const collections = [...source.matchAll(/(\w+)\s*\??\.\s*get\s*\(/g)].map((match) => match[1]);
    expect([...new Set(collections)].sort()).toEqual(["attributes", "controls", "items", "quickForms"]);
  });

  it("uses every getter on the list, so a removed read does not leave its permission behind", () => {
    const source = files.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
    expect(ALLOWED_PAGE_GETTERS.filter((name) => !new RegExp(String.raw`\b${name}\b`).test(source))).toEqual([]);
  });
});

// The page script reads one thing from the document: whether the tab is
// hidden, so its poll can pause. That is a state of the tab, never what the
// page shows. It listens for the change, and reads nothing else there.
describe("the page script's reads of the document", () => {
  const files = [...new Set([...sourceFiles(PAGE_SIDE_DIRS), ...bundles.page])];

  it("are whether the tab is hidden, and the listener for its change", () => {
    const reads = files.flatMap((file) => [...stripComments(readFileSync(file, "utf8")).matchAll(/\bdocument\s*\.\s*(\w+)/g)].map((match) => match[1]));
    expect([...new Set(reads)].sort()).toEqual(["addEventListener", "hidden"]);
  });

  it("listens for visibilitychange and nothing else on the document", () => {
    const listened = files.flatMap((file) => [...stripComments(readFileSync(file, "utf8")).matchAll(/\bdocument\s*\.\s*addEventListener\(\s*"(\w+)"/g)].map((match) => match[1]));
    expect(listened).toEqual(["visibilitychange"]);
  });
});

// The content script runs inside the D365 page too, so the record id in a form
// address is as off limits there as in the page script. Only the origin may be
// read (the Dataverse client and the bridge check use it), and the host (the
// snapshot is relayed with the tab's own host, never the one the page posted).
// The page script reads the host only. The admin center script reads the path
// (never the query or hash; test/admin-page.test.ts holds the rest).
//
// Every file each bundle is built from is scanned, as esbuild resolves the
// imports, so a read in a shared module counts against every bundle that
// imports it. Each way of reaching the address is banned, and every use of
// the word "location" must be one of the allowed property reads.
const ALLOWED_LOCATION_READS: Record<keyof typeof PAGE_BUNDLES, string[]> = {
  content: ["host", "origin"],
  page: ["host"],
  admin: ["pathname"],
};

const ADDRESS_READS: Array<[string, RegExp]> = [
  ["reading the location other than through an allowed property", /\blocation\b(?!\s*\.\s*[A-Za-z_]\w*\b(?!\s*\())/],
  ["reading the full URL", /location\s*\.\s*(href|search|hash|toString|valueOf)\b/],
  ["converting the location to text", /String\s*\(\s*(window\s*\.\s*|document\s*\.\s*|globalThis\s*\.\s*|self\s*\.\s*)?location\s*\)|\$\{\s*(window\s*\.\s*|document\s*\.\s*)?location\s*\}|location\s*\+|\+\s*location\b/],
  ["reading a location property by name", /location\s*\[|[\w$)\]]\s*\[\s*["'`](location|URL|documentURI|baseURI|referrer|href)["'`]\s*\]/],
  ["reading the document URL", /\.\s*(URL|documentURI|baseURI)\b/],
  ["reading the referrer", /\breferrer\b/],
  ["reading navigation timing entries", /getEntriesByType|getEntriesByName|getEntries\s*\(|performance\s*\.\s*navigation\b/],
  ["reading the history state", /\bhistory\s*\.\s*state\b|(window|globalThis|self)\s*\.\s*history\b/],
  ["reading the navigation entry's URL", /navigation\s*\.\s*currentEntry|\.currentEntry\b/],
];

describe.each(Object.keys(PAGE_BUNDLES) as Array<keyof typeof PAGE_BUNDLES>)("the %s bundle never reads the page address", (bundle) => {
  const files = bundles[bundle];

  it("finds the bundle's sources through its imports", () => {
    expect(files).toContain(normalize(PAGE_BUNDLES[bundle]));
    if (bundle === "content") {
      // Shared modules the content script imports are scanned too, not just src/content.
      expect(files).toContain(join("src", "dataverse", "client.ts"));
      expect(files).toContain(join("src", "bridge", "messages.ts"));
    }
  });

  it("reads only its allowed properties of the location", () => {
    const reads = files.flatMap((file) =>
      [...stripComments(readFileSync(file, "utf8")).matchAll(/\blocation\s*\.\s*(\w+)/g)].map((match) => match[1]),
    );
    expect([...new Set(reads)].sort()).toEqual(ALLOWED_LOCATION_READS[bundle]);
  });

  it.each(ADDRESS_READS.map(([label, pattern]) => [label, pattern, bundle] as const))("never contains %s", (_label, pattern) => {
    expect(offendersOf(files, pattern)).toEqual([]);
  });
});

describe("the address patterns catch each way of reading the address", () => {
  const matches = (code: string) => ADDRESS_READS.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);

  it.each([
    "String(location)",
    "String(window.location)",
    "`${location}`",
    "`${window.location}`",
    "location.toString()",
    "window.location.toString()",
    'location["href"]',
    "location.href",
    "window.location",
    "const where = location;",
    "send(location)",
    "document.location",
    "'' + location",
    'window["location"]',
    'document["URL"]',
    "document.URL",
    "document.documentURI",
    "document.baseURI",
    "document.referrer",
    'performance.getEntriesByType("navigation")',
    "performance.getEntries()",
    "history.state",
    "window.history.state",
    "navigation.currentEntry.url",
  ])("catches %s", (code) => {
    expect(matches(code)).not.toEqual([]);
  });

  it.each(["window.location.origin", "window.location.host", "location.host", "window.location.pathname", "new URL(path, base)", "model.history.text", 'attributeFilter: ["href"]'])(
    "lets %s through, which the allowed-property test then checks",
    (code) => {
      expect(matches(code)).toEqual([]);
    },
  );
});

describe("the host is read in one place per bundle", () => {
  it("relays a snapshot with the tab's own host, read in content.ts only", () => {
    const content = stripComments(readFileSync(join("src", "content", "content.ts"), "utf8"));
    expect(content).toContain("withPageHost(event.data, window.location.host)");
    expect(offendersOf(bundles.content, /location\s*\.\s*host\b/)).toEqual([join("src", "content", "content.ts")]);
  });

  it("reads the admin center's path in admin.ts only", () => {
    expect(offendersOf(bundles.admin, /location\s*\.\s*pathname\b/)).toEqual([join("src", "admin", "admin.ts")]);
  });
});

// The page script and the bridge never read what a DOM node or a control
// holds: its value or its text. The page script reads Xrm names through the
// closed getter list above; nothing here reads the DOM's content.
describe("page-side code never reads a DOM value or text", () => {
  const files = [...new Set([...sourceFiles(PAGE_SIDE_DIRS), ...bundles.page])];

  it.each([
    ["an input's value", /\.\s*value\b/],
    ["a node's text", /\.\s*(textContent|innerText|outerText|nodeValue|wholeText)\b/],
    ["markup", /\.\s*(innerHTML|outerHTML)\b/],
    ["a selected option", /\.\s*(selectedOptions|selectedIndex)\b/],
    ["a control's value", /getValue\s*\(/],
    ["a control's text", /getText\s*\(/],
  ])("never reads %s", (_label, pattern) => {
    expect(offendersOf(files, pattern)).toEqual([]);
  });
});

// The content script runs on every D365 page alongside the page's own code.
// Only the service worker talks to Pathix or Entra, and only the service
// worker and options page see a token.
describe("the content script never talks to Pathix itself", () => {
  const files = sourceFiles(["src/content"]);

  it("finds the content-script sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    ["opening a network channel", NETWORK],
    ["touching extension storage, where the token lives", /chrome\s*\.\s*storage/],
    ["starting a sign-in", /chrome\s*\.\s*identity/],
  ])("never contains %s", (_label, pattern) => {
    expect(offendersOf(files, pattern)).toEqual([]);
  });
});

// Lite reads Dataverse from the content script (CLAUDE.md: "Lite's Dataverse
// calls come from the content script, same origin"). That read goes through
// one client, which holds the allowlist (test/dataverse-client.test.ts). No
// other code outside the service worker and the options page may touch the
// network, or even name fetch.
describe("only the Dataverse client opens a network channel outside the service worker", () => {
  const SERVICE_SIDE = ["src/background", "src/options", "src/pathix", "src/auth"];
  const files = sourceFiles(["src"]).filter((file) => !SERVICE_SIDE.some((dir) => file.startsWith(join(dir, ""))));

  it("finds the sources", () => {
    expect(files).toContain(join("src", "dataverse", "client.ts"));
    expect(files).toContain(join("src", "content", "content.ts"));
  });

  it("finds the network only in src/dataverse/client.ts", () => {
    expect(offendersOf(files, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)).toEqual([join("src", "dataverse", "client.ts")]);
  });

  it("keeps the client on the page's own origin under /api/data/v9.2/", () => {
    const client = stripComments(readFileSync(join("src", "dataverse", "client.ts"), "utf8"));
    expect(client).toContain('const API_ROOT = "/api/data/v9.2/";');
    expect(client).toMatch(/refusalFor\(path\)/);
  });
});

// The card shows customer-authored names (components, profiles). Markup from
// a string would let one of those names inject into the D365 page.
describe("the card never builds markup from strings", () => {
  const files = sourceFiles(["src/content", "src/card"]);

  it.each([
    ["innerHTML or outerHTML", /\b(inner|outer)HTML\b/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write/],
    ["createContextualFragment", /createContextualFragment/],
  ])("never uses %s", (_label, pattern) => {
    expect(offendersOf(files, pattern)).toEqual([]);
  });
});

function sourceFiles(dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => join(dir, file)),
  );
}

function offendersOf(files: string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(stripComments(readFileSync(file, "utf8"))));
}

// Comments explain the rule and name the forbidden calls; only code counts.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
