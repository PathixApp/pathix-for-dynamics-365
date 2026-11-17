// Fitness tests for X-ray v2 (M7): the line written into the form, the one
// findings icon, and the "Findings" rename. The line's behavior in a real
// browser (placement, the observer, off) is in smoke/xray-line.smoke.ts; these
// hold the rules that can be read from the source.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unmarkedLine } from "../src/card/xray";
import { labelOf, stacksVertically } from "../src/content/xray-lines";

const source = (file: string) => stripComments(readFileSync(file, "utf8"));
const raw = (file: string) => readFileSync(file, "utf8");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

describe("the X-ray line is in the form but not of it", () => {
  const lines = source("src/content/xray-lines.ts");

  it("is our own element with a closed shadow root", () => {
    expect(lines).toContain('attachShadow({ mode: "closed" })');
    expect(lines).not.toMatch(/mode:\s*"open"/);
    expect(lines).toContain('const TAG = "pathix-xray-line"');
  });

  it("sets text with textContent and builds the icon with createElementNS", () => {
    expect(lines).toMatch(/\.textContent = /);
    expect(lines).toContain("findingsIcon(");
    expect(source("src/content/findings-icon.ts")).toContain("createElementNS");
  });

  it("never sets an attribute, class, style or data on anything: D365's nodes are never modified", () => {
    for (const pattern of [/setAttribute\s*\(/, /classList/, /\.style\b/, /\bdataset\b/, /removeAttribute/, /toggleAttribute/]) {
      expect(lines).not.toMatch(pattern);
    }
  });

  it("changes the page's tree only by inserting its own host", () => {
    const inserts = [...lines.matchAll(/\.(after|before|prepend|insertBefore|replaceWith|appendChild|insertAdjacentElement)\(([^)]*)\)/g)];
    expect(inserts.length).toBeGreaterThan(0);
    for (const match of inserts) expect(`${match[1]}(${match[2]})`).toBe("after(line.host)");
  });

  it("only removes its own hosts", () => {
    const removals = [...lines.matchAll(/(\S+)\.remove\(\)/g)].map((match) => match[1]);
    expect(removals.length).toBeGreaterThan(0);
    for (const target of removals) expect(target).toMatch(/host$/);
  });

  it("watches the form with a MutationObserver and stops it when cleared", () => {
    expect(lines).toContain("new MutationObserver");
    expect(lines).toContain("this.observer?.disconnect()");
  });

  it("drops its own mutation records, so a removal of just its host by the form is not mistaken for ours", () => {
    expect(lines).toContain("this.observer?.takeRecords()");
    expect(lines).not.toMatch(/localName === TAG\)\)/);
  });

  it("is a button, so it is reachable by keyboard", () => {
    expect(lines).toContain('document.createElement("button")');
    expect(lines).toContain('"click"');
  });

  it("makes no network call and reads no value-reading API", () => {
    expect(lines).not.toMatch(/\bfetch\b|XMLHttpRequest|chrome\s*\./);
    expect(lines).not.toMatch(/\.value\b|getValue|innerText|\.getAttribute\s*\(/);
  });

  it("reads no text out of D365's nodes anywhere in the content script", () => {
    // Reads are `.textContent` not followed by an assignment; writes set our own nodes.
    // Every file under src/content is scanned, and none reads innerText or innerHTML.
    // The one read there was, Level Up's chip, went with the line's own row (2026-10-09).
    const reads = sourceFiles("src/content").flatMap((file) =>
      [...source(file).matchAll(/\.textContent(?!\s*=[^=])/g)].map(() => file),
    );
    expect(reads).toEqual([]);
    for (const file of sourceFiles("src/content")) expect(source(file)).not.toMatch(/innerText|innerHTML|outerHTML|nodeValue/);
    // Nothing in the content script's X-ray code posts what it read.
    expect(lines).not.toMatch(/postMessage|sendMessage|\.send\(/);
  });

  it("gives the line its own row: never a 100% flex basis that squeezes a side label", () => {
    expect(lines).not.toMatch(/flex:\s*0 0 100%/);
    expect(lines).toContain("align-self: stretch");
  });
});

describe("where the line goes", () => {
  afterEach(() => void vi.unstubAllGlobals());

  interface FakeNode {
    tag: string;
    id?: string;
    dataId?: string;
    /** The data-ids of the elements around it, innermost first, for closest(). */
    inside?: string[];
  }

  /** One attribute selector, or a tag name, the shapes labelOf uses. */
  function matchesOne(node: FakeNode, selector: string): boolean {
    const attr = /^\[(id|data-id)([$^]?)="(.+)"\]$/.exec(selector.trim());
    if (!attr) return node.tag === selector.trim();
    const value = attr[1] === "id" ? node.id : node.dataId;
    if (value === undefined) return false;
    if (attr[2] === "$") return value.endsWith(attr[3]!);
    if (attr[2] === "^") return value.startsWith(attr[3]!);
    return value === attr[3];
  }

  const matchesList = (node: FakeNode, list: string) => list.split(",").some((selector) => matchesOne(node, selector));

  /** A field container whose queries understand the selector shapes labelOf uses. */
  function container(nodes: FakeNode[]) {
    const elements = nodes.map((node) => ({
      node,
      closest: (list: string) => ((node.inside ?? []).some((dataId) => matchesList({ tag: "div", dataId }, list)) ? {} : null),
    }));
    return {
      querySelector: (list: string) => elements.find((element) => matchesList(element.node, list))?.node ?? null,
      querySelectorAll: (list: string) => elements.filter((element) => matchesList(element.node, list)),
      elements,
    };
  }

  const stubEscape = () => vi.stubGlobal("CSS", { escape: (text: string) => text });

  it("finds a real D365 label by the end of its id, which carries the form id and no data-id", () => {
    stubEscape();
    const label = { tag: "label", id: "id-8448b78f-8f42-454e-8e2a-f8196b0419af-1-name-field-label" };
    const found = labelOf(container([{ tag: "span", id: "name-required-icon", dataId: "name-required-icon" }, label]) as unknown as Element, "name");
    expect(found).toBe(label);
  });

  it("does not take parentaccountname's label for name: the match starts at a hyphen", () => {
    stubEscape();
    const other = { tag: "div", id: "id-8448b78f-8f42-454e-8e2a-f8196b0419af-4-parentaccountname-field-label" };
    const own = { tag: "div", id: "id-8448b78f-8f42-454e-8e2a-f8196b0419af-1-name-field-label" };
    expect(labelOf(container([other, own]) as unknown as Element, "name")).toBe(own);
    expect(labelOf(container([other]) as unknown as Element, "name")).toBeNull();
  });

  it("prefers the exact data-id and id forms, then the id suffix", () => {
    stubEscape();
    const byDataId = { tag: "label", dataId: "name-field-label" };
    const bySuffix = { tag: "label", id: "id-x-1-name-field-label" };
    expect(labelOf(container([bySuffix, byDataId]) as unknown as Element, "name")).toBe(byDataId);
    const exactId = { tag: "label", id: "name-field-label" };
    expect(labelOf(container([bySuffix, exactId]) as unknown as Element, "name")).toBe(exactId);
  });

  it("falls back to a <label> outside the control, never one a two-option or multiselect control draws", () => {
    stubEscape();
    const inCheckbox = { tag: "label", inside: ["donotemail.fieldControl-checkbox-container"] };
    const inPcf = { tag: "label", inside: ["x", "donotemail.fieldControl-pcf-container-id"] };
    const fieldLabel = { tag: "label" };
    const found = container([inCheckbox, inPcf, fieldLabel]);
    expect(labelOf(found as unknown as Element, "donotemail")).toBe(found.elements[2]);
    expect(labelOf(container([inCheckbox, inPcf]) as unknown as Element, "donotemail")).toBeNull();
  });

  function styled(display: string, flexDirection = "row", flexWrap = "nowrap"): Element {
    return { display, flexDirection, flexWrap } as unknown as Element;
  }

  it.each<[string, Element, boolean]>([
    ["a block", styled("block"), true],
    ["a flow-root", styled("flow-root"), true],
    ["a list item", styled("list-item"), true],
    ["a flex column", styled("flex", "column"), true],
    ["a reversed flex column", styled("flex", "column-reverse"), true],
    ["an inline-flex column", styled("inline-flex", "column"), true],
    ["a wrapping flex row", styled("flex", "row", "wrap"), true],
    ["a no-wrap flex row", styled("flex", "row", "nowrap"), false],
    ["a no-wrap inline-flex row", styled("inline-flex", "row", "nowrap"), false],
    ["a grid", styled("grid"), false],
    ["an inline-grid", styled("inline-grid"), false],
    ["an inline box", styled("inline"), false],
    ["an inline-block", styled("inline-block"), false],
    ["a table", styled("table"), false],
    ["a table row", styled("table-row"), false],
    ["a table cell", styled("table-cell"), false],
    ["display: contents", styled("contents"), false],
  ])("reads %s as stacking its children: %s", (_label, element, expected) => {
    vi.stubGlobal("getComputedStyle", (target: unknown) => target);
    expect(stacksVertically(element)).toBe(expected);
  });

  it("watches layout changes that keep the same nodes, and drops its own records", () => {
    const lines = source("src/content/xray-lines.ts");
    expect(lines).toContain('attributeFilter: ["class", "style"]');
    expect(lines).toContain("new ResizeObserver");
    expect(lines).toContain('window.addEventListener("resize", this.onWindowResize)');
    expect(lines).toContain('window.removeEventListener("resize", this.onWindowResize)');
    expect(lines).toContain("this.resizes?.disconnect()");
    // Above the fields, a class change is ignored: no relayout of every line for the body's focus classes.
    expect(lines).not.toMatch(/target\.querySelector\(CONTAINER_SELECTOR\)/);
    // A dropped line lets go of its container whether or not it had a place.
    expect(lines).toMatch(/if \(line\.container\) this\.unwatch\(line\.container\);\s*this\.lines\.delete\(control\);/);
  });
});

describe("a field the line cannot be written under", () => {
  it("is counted, and the X-ray panel says how many, never silent", () => {
    expect(unmarkedLine(1)).toBe("1 visible field could not be marked, so its counts are not shown.");
    expect(unmarkedLine(3)).toBe("3 visible fields could not be marked, so their counts are not shown.");
    const controller = source("src/content/xray-controller.ts");
    expect(controller).toContain("lines.setOnUnmarked((count) => view.setNote(count > 0 ? unmarkedLine(count) : null))");
  });

  it("puts the note in the panel and keeps it when the legend is drawn again", async () => {
    const { XrayController } = await import("../src/content/xray-controller");
    let report: (count: number) => void = () => undefined;
    const notes: Array<string | null> = [];
    const view = {
      setOnClose: () => undefined,
      showMessage: () => undefined,
      showLegend: () => undefined,
      hide: () => undefined,
      setNote: (text: string | null) => notes.push(text),
    };
    const fakeLines = { setOnUnmarked: (handler: (count: number) => void) => void (report = handler), show: () => undefined, clear: () => undefined };
    new XrayController(view as never, fakeLines as never, async () => undefined);
    report(2);
    report(0);
    expect(notes).toEqual(["2 visible fields could not be marked, so their counts are not shown.", null]);
    const viewSource = source("src/content/xray-view.ts");
    expect(viewSource).toMatch(/this\.legend = legend;\s*this\.renderNote\(\);/);
  });
});

describe("one findings icon", () => {
  const PATH = "M4 22V4a1 1 0 0 1 .4-.8";

  it("is lucide's Flag, defined in one module and nowhere else", () => {
    const owners = sourceFiles("src").filter((file) => raw(file).includes(PATH));
    expect(owners).toEqual([join("src", "content", "findings-icon.ts")]);
    expect(raw("src/content/findings-icon.ts")).toContain("// lucide flag, lucide-react 1.11.0, ISC license.");
  });

  it("is the one the X-ray line and the card both use", () => {
    for (const file of ["src/content/xray-lines.ts", "src/content/card-view.ts"]) {
      expect(raw(file)).toMatch(/import \{ findingsIcon \} from "\.\/findings-icon"/);
      expect(source(file)).toContain("findingsIcon(");
    }
  });

  it("inherits color, so its shape never encodes severity", () => {
    const icon = source("src/content/findings-icon.ts");
    expect(icon).toContain('"stroke", "currentColor"');
    expect(icon).not.toMatch(/severity|#[0-9a-f]{3,6}/i);
  });

  it("is hidden from assistive technology beside text that says it, and named Finding otherwise", () => {
    const icon = source("src/content/findings-icon.ts");
    expect(icon).toContain('"aria-hidden", "true"');
    expect(icon).toContain('FINDING_LABEL = "Finding"');
    expect(icon).toContain('"aria-label", FINDING_LABEL');
  });

  it("adds no dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: unknown; devDependencies: Record<string, string> };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies).filter((name) => /lucide/.test(name))).toEqual([]);
  });
});

/** The platform's abort API is spelled "signal": the AbortSignal type and fetch's `signal:` option. Neither is the product word. */
function withoutAbortApi(text: string): string {
  return text.replace(/\bAbortSignal\b|\bsignal: /g, "");
}

describe('"Findings", not "Signals"', () => {
  it("leaves the word out of the source except the address's tab, which the Pathix UI has not renamed", () => {
    const hits = sourceFiles("src").flatMap((file) =>
      raw(file)
        .split("\n")
        .map((line, index) => ({ file: file.replace(/\\/g, "/"), line: index + 1, text: line }))
        .filter(({ text }) => /signals?\b/i.test(withoutAbortApi(text)) && !/signal for|only valid signal|authorship signal/i.test(text)),
    );
    expect(hits.map(({ file, text }) => `${file}: ${text.trim()}`)).toEqual([
      expect.stringMatching(/^src\/card\/model\.ts: .*findings tab in Pathix \(still named "signals" in its address\)/),
      expect.stringMatching(/^src\/card\/model\.ts: .*the address keeps tab=signals until it does/),
      expect.stringMatching(/^src\/card\/model\.ts: href: `\$\{openInPathixUrl\(context\)\}&tab=signals`/),
    ]);
  });
});
