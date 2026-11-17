// Fitness tests for the admin center page script (M14), the code in src/admin
// that runs inside admin.powerplatform.microsoft.com. They hold the rules that
// can be read from the source, the same way test/page-source.test.ts holds
// them for the Dynamics page:
//
//   - it reads ids from the address path and Application IDs from grid cells,
//     and nothing else (DESIGN.md, "Names, never values");
//   - it makes no network call: every Pathix answer comes from the service
//     worker;
//   - it never touches the page's tokens, storage or cookies, or the
//     extension's own storage and sign-in;
//   - it is in the page but not of it: closed shadow roots, text set with
//     textContent, and the page's own nodes never modified.
//
// Extend these when you add a page-side read. Never weaken them.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const DIR = "src/admin";
const files = readdirSync(DIR, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join(DIR, file));

const code = (file: string) => stripComments(readFileSync(file, "utf8"));
const all = () => files.map((file) => ({ file, text: code(file) }));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function offenders(pattern: RegExp): string[] {
  return all()
    .filter(({ text }) => pattern.test(text))
    .map(({ file }) => file);
}

describe("the admin page script's sources", () => {
  it("finds them all", () => {
    expect(files.map((file) => file.replace(/\\/g, "/")).sort()).toEqual([
      "src/admin/admin.ts",
      "src/admin/controller.ts",
      "src/admin/dom.ts",
      "src/admin/routes.ts",
      "src/admin/view.ts",
    ]);
  });
});

const NETWORK: Array<[string, RegExp]> = [
    ["fetch", /\bfetch\b/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /WebSocket/],
    ["EventSource", /EventSource/],
    ["sendBeacon", /sendBeacon/],
    ["a worker or service worker", /\bnew\s+(Shared)?Worker\b|serviceWorker/],
    ["an image or script loaded from an address", /new\s+Image\b|\.src\s*=|createElement\(\s*["'](img|script|iframe|link)["']/],
];

describe("the admin page script makes no network call", () => {
  it.each(NETWORK)("never uses %s", (_name, pattern) => {
    expect(offenders(pattern)).toEqual([]);
  });

  it("talks to the service worker through one send, in the entry file", () => {
    const sends = all().flatMap(({ file, text }) => [...text.matchAll(/chrome\s*\.\s*runtime\s*\.\s*sendMessage/g)].map(() => file));
    expect(sends).toEqual([join(DIR, "admin.ts")]);
  });
});

const SECRETS: Array<[string, RegExp]> = [
    ["the page's local or session storage", /\b(localStorage|sessionStorage)\b/],
    ["IndexedDB or the cache storage", /\b(indexedDB|caches)\b|CacheStorage/],
    ["cookies", /document\s*\.\s*cookie|cookieStore|chrome\s*\.\s*cookies/],
    ["the extension's storage, where the Pathix token lives", /chrome\s*\.\s*storage/],
    ["the extension's sign-in", /chrome\s*\.\s*(identity|permissions|scripting|tabs)/],
    ["a bearer token or an Authorization header", /\bAuthorization\b|\bBearer\b|access_token|id_token|refresh_token/i],
    ["the MSAL cache the admin center keeps", /\bmsal\b|login\.microsoftonline|login\.live\.com/i],
    ["the page's own scripts through window", /window\s*\.\s*(wrappedJSObject|eval)|\beval\s*\(|new\s+Function\b/],
];

describe("the admin page script never touches tokens, storage or cookies", () => {
  it.each(SECRETS)("never uses %s", (_name, pattern) => {
    expect(offenders(pattern)).toEqual([]);
  });

  it("uses only the worker messaging API of chrome.runtime", () => {
    const uses = all().flatMap(({ text }) => [...text.matchAll(/chrome\s*\.\s*runtime\s*\.\s*(\w+)/g)].map((match) => match[1]));
    expect([...new Set(uses)].sort()).toEqual(["id", "onMessage", "sendMessage"]);
  });
});

describe("the admin page script reads only the allowed things", () => {
  it("reads the address path in one place, the entry file, and never the rest of the address", () => {
    const pathReads = all().flatMap(({ file, text }) => [...text.matchAll(/location\s*\.\s*(\w+)/g)].map((match) => `${file}:${match[1]}`));
    expect(pathReads).toEqual([`${join(DIR, "admin.ts")}:pathname`]);
    for (const pattern of [
      /location\s*\.\s*(href|search|hash|origin|host|hostname)\b/,
      /document\s*\.\s*(URL|documentURI|baseURI|referrer|location)\b/,
      /navigation\s*\.\s*currentEntry|\.currentEntry\b|\.destination\b/,
      /history\s*\.\s*state/,
    ]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });

  it("reads node text in exactly one place, which keeps the text only if it is a whole GUID", () => {
    const reads = all().flatMap(({ file, text }) =>
      [...text.matchAll(/\.(textContent|innerText|wholeText|nodeValue|data)\b(?!\s*=[^=])/g)]
        .filter((match) => !isOwnNodeAssignment(text, match.index ?? 0))
        .map((match) => `${file}:${match[1]}`),
    );
    expect(reads).toEqual([`${join(DIR, "dom.ts")}:textContent`]);

    const dom = code(join(DIR, "dom.ts"));
    expect(dom).toMatch(/function appIdIn\(cell: Element\): string \| null \{\s*return appIdFromCellText\(cell\.textContent \?\? ""\);\s*\}/);
    expect(code(join(DIR, "routes.ts"))).toContain("WHOLE_GUID.test(trimmed) ? trimmed.toLowerCase() : null");
  });

  it("reads no attribute of the page's nodes but the target of a link", () => {
    const reads = all().flatMap(({ file, text }) => [...text.matchAll(/\.getAttribute\s*\(\s*([^)]*)\)/g)].map((match) => `${file}:${match[1]}`));
    expect(reads).toEqual([`${join(DIR, "dom.ts")}:"href"`]);
    // view.ts only builds our own nodes and admin.ts only wires the entry (its chrome.runtime.id is not a node's); dom.ts and the controller are the files that touch the page's nodes.
    const touchesPage = all().filter(({ file }) => /dom\.ts$|controller\.ts$/.test(file));
    for (const pattern of [
      /\.attributes\b/,
      /\.dataset\b/,
      /\.getAttributeNames/,
      /\.value\b/,
      /\.checked\b/,
      /\.outerHTML|\.innerHTML/,
      /\.title\b/,
      /\.href\b/,
      /\.ariaLabel\b/,
      /\.id\b/,
      /\.className\b/,
    ]) {
      expect(touchesPage.filter(({ text }) => pattern.test(text)).map(({ file }) => file)).toEqual([]);
    }
  });

  it("finds its places by structure, never by a class name the admin center generates", () => {
    // The one class selector is the breadcrumb component's stable public name.
    const dom = code(join(DIR, "dom.ts"));
    const literals = [...dom.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2]!);
    const classSelectors = literals.filter((literal) => /(^|[\s,>\]])\.[A-Za-z]/.test(literal));
    expect(classSelectors).toEqual([".ms-Breadcrumb"]);
    expect(dom).not.toMatch(/css-\d|fui-[A-Z]/);
  });
});

/** `x.textContent = ...` on a node we made is a write, not a read. */
function isOwnNodeAssignment(text: string, index: number): boolean {
  return /^\.\w+\s*=[^=]/.test(text.slice(index, index + 40));
}

describe("the admin page script is in the page but not of it", () => {
  const view = code(join(DIR, "view.ts"));

  it("draws only into closed shadow roots", () => {
    const roots = all().flatMap(({ text }) => [...text.matchAll(/attachShadow\(\s*\{[^}]*\}\s*\)/g)].map((match) => match[0].replace(/\s+/g, " ")));
    expect(roots).toEqual(['attachShadow({ mode: "closed" })']);
    expect(offenders(/mode:\s*["']open["']/)).toEqual([]);
  });

  it("never builds markup from a string", () => {
    for (const pattern of [/\b(inner|outer)HTML\b/, /insertAdjacentHTML/, /document\s*\.\s*write/, /createContextualFragment/, /DOMParser/, /srcdoc/]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });

  it("sets text with textContent and links with properties, never with setAttribute", () => {
    expect(offenders(/\bsetAttribute\s*\(|\bsetAttributeNS\b|\bremoveAttribute\b|\btoggleAttribute\b|\bclassList\b|\.style\b|\.dataset\b|\.attributes\b/)).toEqual([]);
    expect(view).toMatch(/\.textContent = /);
  });

  it("changes the page's tree only by inserting its own hosts, and removes only its own hosts", () => {
    // The controller is the only file that puts anything into the page; dom.ts only reads and view.ts builds our own nodes.
    const calls = (text: string) =>
      [...text.matchAll(/\.(after|before|prepend|append|appendChild|insertBefore|replaceWith|replaceChildren|insertAdjacentElement|remove|removeChild)\(([^)]*)\)/g)].map(
        (match) => `${match[1]}(${match[2]})`,
      );
    expect(calls(code(join(DIR, "controller.ts"))).sort()).toEqual(
      ["after(drawn.host)", "after(drawn.host)", "prepend(drawn.host)", "remove()", "remove()", "remove()", "remove()", "remove()"].sort(),
    );
    expect(calls(code(join(DIR, "dom.ts")))).toEqual([]);
    const removals = all().flatMap(({ text }) => [...text.matchAll(/(\S+?)\.remove\(\)/g)].map((match) => match[1]));
    expect(removals.length).toBeGreaterThan(0);
    for (const target of removals) expect(target).toMatch(/host$/);
  });

  it("stops a click on its own link from reaching the page's row handlers", () => {
    expect(view.match(/stopPropagation\(\)/g)?.length).toBe(2);
  });

  it("opens links in a new tab without handing the tab to the page", () => {
    expect(view.match(/\.target = "_blank"/g)?.length).toBe(3);
    expect(view.match(/\.rel = "noopener noreferrer"/g)?.length).toBe(3);
  });

  it("watches the page with a MutationObserver and disconnects it when stopped", () => {
    const controller = code(join(DIR, "controller.ts"));
    expect(controller).toContain("new MutationObserver");
    expect(controller).toContain("this.observer?.disconnect()");
  });

  it("draws nothing at all for a page that is not one of the three routes", () => {
    const controller = code(join(DIR, "controller.ts"));
    expect(controller).toMatch(/if \(!route\) return;/);
  });
});

describe("the page script is registered, never declared, and shares nothing with the Dynamics scripts", () => {
  it("is not imported by, and does not import, the Dynamics content script or the page bridge", () => {
    const content = readFileSync("src/content/content.ts", "utf8");
    expect(content).not.toMatch(/\.\.\/admin\//);
    for (const { file, text } of all()) {
      expect(text, file).not.toMatch(/from "\.\.\/(content\/(?!findings-icon)|page\/|bridge\/|dataverse\/|lite\/)/);
    }
  });

  it("imports the findings icon and no other content-script module", () => {
    const imports = all().flatMap(({ text }) => [...text.matchAll(/from "\.\.\/content\/([\w-]+)"/g)].map((match) => match[1]));
    expect(imports).toEqual(["findings-icon"]);
  });
});

// The files above are the page script's own. The built admin.js also holds the shared modules it imports,
// and those run in the admin center too: a fetch or a storage read added to one of them would pass every
// check above. So the network, secrets and chrome API rules run over everything the admin bundle contains,
// the read rules (the address, the page's node text and attributes) and the markup-from-string rules run over
// the shared modules too, and the set of modules is pinned, so a new import has to be looked at.
describe("everything bundled into admin.js, shared modules included", () => {
  let modules: Array<{ file: string; text: string }> = [];

  beforeAll(async () => {
    const result = await build({
      entryPoints: ["src/admin/admin.ts"],
      bundle: true,
      format: "iife",
      target: "chrome113",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    modules = Object.keys(result.metafile.inputs)
      .map((file) => file.replace(/\\/g, "/"))
      .sort()
      .map((file) => ({ file, text: stripComments(readFileSync(file, "utf8")) }));
  });

  const offending = (pattern: RegExp) => modules.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

  it("is exactly these modules; a new import must be read and added here on purpose", () => {
    expect(modules.map(({ file }) => file)).toEqual([
      "src/admin/admin.ts",
      "src/admin/controller.ts",
      "src/admin/dom.ts",
      "src/admin/routes.ts",
      "src/admin/view.ts",
      "src/bridge/messages.ts",
      "src/content/findings-icon.ts",
      "src/runtime/admin-overlay.ts",
    ]);
  });

  it.each(NETWORK)("none of them uses %s", (_name, pattern) => {
    expect(offending(pattern)).toEqual([]);
  });

  it.each(SECRETS)("none of them uses %s", (_name, pattern) => {
    expect(offending(pattern)).toEqual([]);
  });

  it("only the entry file talks to the worker, and uses only the three chrome.runtime names it needs", () => {
    const uses = modules.flatMap(({ file, text }) => [...text.matchAll(/chrome\s*\.\s*runtime\s*\.\s*(\w+)/g)].map((match) => `${file}:${match[1]}`));
    expect([...new Set(uses)].sort()).toEqual(["src/admin/admin.ts:id", "src/admin/admin.ts:onMessage", "src/admin/admin.ts:sendMessage"]);
  });

  it("none of them reaches any other chrome API", () => {
    expect(offending(/\bchrome\s*\.\s*(?!runtime\b)\w+/)).toEqual([]);
  });

  // The shared modules are the ones that are not src/admin: they have no business reading the page at all.
  const shared = () => modules.filter(({ file }) => !file.startsWith("src/admin/"));
  const sharedOffending = (pattern: RegExp) => shared().filter(({ text }) => pattern.test(text)).map(({ file }) => file);

  it("the shared modules are the three we expect", () => {
    expect(shared().map(({ file }) => file)).toEqual(["src/bridge/messages.ts", "src/content/findings-icon.ts", "src/runtime/admin-overlay.ts"]);
  });

  it("the shared modules never read the address", () => {
    expect(sharedOffending(/\blocation\b/)).toEqual([]);
    expect(sharedOffending(/document\s*\.\s*(URL|documentURI|baseURI|referrer|location)\b/)).toEqual([]);
    expect(sharedOffending(/navigation\s*\.\s*currentEntry|\.currentEntry\b|\.destination\b/)).toEqual([]);
    expect(sharedOffending(/history\s*\.\s*state/)).toEqual([]);
  });

  it("the shared modules never read the page's nodes: no node text, no attribute, no query", () => {
    const reads = shared().flatMap(({ file, text }) =>
      [...text.matchAll(/\.(textContent|innerText|wholeText|nodeValue|data)\b(?!\s*=[^=])/g)]
        .filter((match) => !isOwnNodeAssignment(text, match.index ?? 0))
        .map((match) => `${file}:${match[1]}`),
    );
    expect(reads).toEqual([]);
    expect(sharedOffending(/\.getAttribute\s*\(|\.getAttributeNames|\.attributes\b|\.dataset\b|\.value\b|\.checked\b/)).toEqual([]);
    // The one document call is createElementNS, for the icon's own nodes.
    expect(sharedOffending(/\bdocument\s*\.\s*(?!createElementNS\b)\w+/)).toEqual([]);
    expect(sharedOffending(/\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+|closest|matches|parentElement|parentNode|children|childNodes)\b/)).toEqual([]);
  });

  it("the shared modules never build markup from a string or write the page's tree", () => {
    for (const pattern of [/\b(inner|outer)HTML\b/, /insertAdjacentHTML/, /document\s*\.\s*write/, /createContextualFragment/, /DOMParser/, /srcdoc/, /attachShadow/]) {
      expect(sharedOffending(pattern)).toEqual([]);
    }
    // The icon builds a tree of its own nodes and hands it back: its one tree call joins the path to the svg it made.
    const treeCall = /(\S+?)\.(after|before|prepend|append|appendChild|insertBefore|replaceWith|replaceChildren|insertAdjacentElement|remove|removeChild)\(([^)]*)\)/g;
    const calls = shared().flatMap(({ file, text }) => [...text.matchAll(treeCall)].map((match) => `${file}:${match[1]}.${match[2]}(${match[3]})`));
    expect(calls).toEqual(["src/content/findings-icon.ts:svg.append(path)"]);
  });

  it("setAttribute appears only in the findings icon, and only on the SVG nodes it makes itself", () => {
    expect(sharedOffending(/\bsetAttribute(NS)?\s*\(|\bremoveAttribute\b|\btoggleAttribute\b/)).toEqual(["src/content/findings-icon.ts"]);
    const icon = modules.find(({ file }) => file === "src/content/findings-icon.ts")!.text;
    const targets = [...icon.matchAll(/(\S+?)\.setAttribute\s*\(/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set(["svg", "path"]));
    expect(icon).toMatch(/const svg = document\.createElementNS\(/);
    expect(icon).toMatch(/const path = document\.createElementNS\(/);
  });
});
