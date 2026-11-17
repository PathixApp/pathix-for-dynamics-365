// Smoke test for X-ray v2 (M7): the line written into the form, driven in real
// Chromium. The real X-ray is connected-only and needs a Pathix to answer, which
// this smoke does not have, so it bundles the same module the content script
// uses (src/content/xray-lines.ts) and runs it against a fake model-driven form
// with sample counts. It checks what only a browser can: where the line lands
// on a side-labelled and a top-labelled field, and that the label keeps its
// width; that it is in a closed shadow root; that D365's nodes are left as they
// were; that it comes back once after a re-render; that the keyboard reaches it
// and it opens the card; and that off removes every host.
//
// The extension-level toggle in Lite is in lite.smoke.ts.

import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

let browser: Browser;
let bundle: string;

test.beforeAll(async () => {
  const executablePath = process.env.PATHIX_SMOKE_CHROMIUM;
  if (executablePath && !existsSync(executablePath)) throw new Error(`No browser at ${executablePath}.`);
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chromium" });
  const result = await build({
    entryPoints: ["src/content/xray-lines.ts"],
    bundle: true,
    format: "iife",
    globalName: "PathixLines",
    target: "chrome113",
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

test.afterAll(async () => {
  await browser?.close();
});

const FORM_ID = "8448b78f-8f42-454e-8e2a-f8196b0419af";

/**
 * A side-labelled field in the shape captured from a real Account main form
 * (a development environment, 2026-10-09), from the container down:
 *   container        flex row, no wrap, 521px
 *   column           flex column                       <- the line goes in here
 *   field row        flex row, no wrap: [label column, control column]
 *   label row        flex row, no wrap, 180px: label (+ required icon)
 *   label            display block, an id ending "-<control>-field-label", no data-id
 */
function sideField(control: string, n: number, label: string, required: boolean): string {
  const icon = required ? `<span id="${control}-required-icon" data-id="${control}-required-icon">*</span>` : "";
  return `
    <div id="c-${control}" data-id="${control}-FieldSectionItemContainer" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:521px">
      <div id="column-${control}" class="pa-h pa-bl flexbox" style="display:flex;flex-direction:column;flex-wrap:nowrap;width:519px">
        <div id="row-${control}" class="pa-be flexbox" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:519px">
          <div id="labelrow-${control}" class="pa-fs pa-ce" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:180px;flex:none">
            <label id="id-${FORM_ID}-${n}-${control}-field-label" style="display:block">${label}</label>${icon}
          </div>
          <div id="control-${control}" style="flex:1"><div data-id="${control}.fieldControl-text-box-text">${label} (sample value)</div></div>
        </div>
      </div>
    </div>`;
}

/** A top-labelled field: the label row sits directly in the column, above the control. */
function topField(control: string, n: number, label: string): string {
  return `
    <div id="c-${control}" data-id="${control}-FieldSectionItemContainer" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:521px">
      <div id="column-${control}" style="display:flex;flex-direction:column;flex-wrap:nowrap;width:519px">
        <div id="labelrow-${control}" style="display:flex;flex-direction:row;flex-wrap:nowrap">
          <label id="id-${FORM_ID}-${n}-${control}-field-label" style="display:block">${label}</label>
        </div>
        <div id="control-${control}">${label} (sample value)</div>
      </div>
    </div>`;
}

/**
 * A field whose label position comes from a class or a media query, as D365
 * switches between side and top labels when the window narrows. The field row
 * has no direction of its own: `.side` makes it a no-wrap row ([label, control]),
 * anything else a column (label above control).
 */
function flipField(control: string, n: number, label: string, containerClass: string): string {
  return `
    <div id="c-${control}" data-id="${control}-FieldSectionItemContainer" class="${containerClass}" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:521px">
      <div id="column-${control}" style="display:flex;flex-direction:column;flex-wrap:nowrap;width:519px">
        <div id="row-${control}" class="fieldrow" style="display:flex;flex-wrap:nowrap;width:519px">
          <div id="labelrow-${control}" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:180px;flex:none">
            <label id="id-${FORM_ID}-${n}-${control}-field-label" style="display:block">${label}</label>
          </div>
          <div id="control-${control}" style="flex:1">${label} (sample value)</div>
        </div>
      </div>
    </div>`;
}

/** A field whose every ancestor up to the container is a no-wrap row: no place a line could go without squeezing it. */
const STUCK_FIELD = `
  <div id="c-stuck" data-id="stuck-FieldSectionItemContainer" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:521px">
    <div id="labelrow-stuck" style="display:flex;flex-direction:row;flex-wrap:nowrap;width:180px">
      <label id="id-${FORM_ID}-7-stuck-field-label" style="display:block">Stuck</label>
    </div>
  </div>`;

/** The same field, hidden by the form (a hidden field, or a collapsed section). */
const HIDDEN_STUCK_FIELD = STUCK_FIELD.replace(/stuck/g, "hiddenstuck").replace('style="display:flex;', 'style="display:none;');

const LAYOUT_CSS = `
  .fieldrow { flex-direction: column; }
  .side .fieldrow, .side-labels .fieldrow { flex-direction: row; }
  @media (min-width: 1000px) { .responsive .fieldrow { flex-direction: row; } }`;

const FORM = `
  <style>${LAYOUT_CSS}</style>
  <main id="form">
    ${sideField("name", 1, "Account Name", true)}
    ${topField("creditlimit", 3, "Credit Limit")}
    ${flipField("accountnumber", 4, "Account Number", "")}
    ${flipField("fax", 5, "Fax", "responsive")}
    ${STUCK_FIELD}
    ${HIDDEN_STUCK_FIELD}
    <div id="tab"></div>
  </main>`;

const TAB_FIELD = sideField("telephone1", 2, "Phone", false);

const ENTRIES = {
  name: { column: "name", writers: 7, aiWriters: 1, readers: 8, aiReaders: 0, forms: 5, findings: 0 },
  creditlimit: { column: "creditlimit", writers: null, aiWriters: null, readers: 2, aiReaders: 0, forms: null, findings: null },
  telephone1: { column: "telephone1", writers: 1, aiWriters: 0, readers: 0, aiReaders: 0, forms: 1, findings: 3 },
  accountnumber: { column: "accountnumber", writers: 2, aiWriters: 0, readers: 1, aiReaders: 0, forms: 1, findings: 0 },
  fax: { column: "fax", writers: 0, aiWriters: 0, readers: 0, aiReaders: 0, forms: 1, findings: 0 },
  stuck: { column: "stuck", writers: 1, aiWriters: 0, readers: 0, aiReaders: 0, forms: 1, findings: 0 },
  hiddenstuck: { column: "hiddenstuck", writers: 1, aiWriters: 0, readers: 0, aiReaders: 0, forms: 1, findings: 0 },
};

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${FORM}</body></html>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate((entries) => {
    const w = window as unknown as Record<string, unknown>;
    w.opened = [];
    w.lines = new (w.PathixLines as { XrayLines: new (open: (control: string, container: Element) => void) => unknown }).XrayLines(
      (control: string, container: Element) => (w.opened as string[]).push(`${control}:${container.getAttribute("data-id")}`),
    );
    w.unmarkedReports = [];
    (w.lines as { setOnUnmarked(handler: (count: number) => void): void }).setOnUnmarked((count) => (w.unmarkedReports as number[]).push(count));
    w.entries = entries;
  }, ENTRIES);
  return page;
}

interface Lines {
  show(targets: Array<{ control: string; entry: unknown }>, formId: string | null): void;
  clear(): void;
  reconcile(): number;
}

async function showLines(page: Page, controls: Array<keyof typeof ENTRIES>): Promise<void> {
  await page.evaluate(({ names, formId }) => {
    const w = window as unknown as { lines: Lines; entries: Record<string, unknown> };
    w.lines.show(
      names.map((name) => ({ control: name, entry: w.entries[name] })),
      formId,
    );
  }, { names: controls, formId: FORM_ID });
}

/** Every text node on the page, closed shadow roots included, read through the DevTools protocol. */
async function screenText(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  const texts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 3 && node.parentName !== "STYLE" && node.parentName !== "SCRIPT") texts.push(node.nodeValue ?? "");
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk({ ...child, parentName: node.nodeName });
  };
  walk(root);
  return texts.join("\n");
}

interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentName?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/** Where a field's lines are: each one's parent and the node right before it, by id. */
const placement = (page: Page, control: string) =>
  page.evaluate((id) => {
    const hosts = Array.from(document.querySelectorAll(`#c-${id} pathix-xray-line`));
    return hosts.map((host) => ({ parent: host.parentElement?.id ?? "", after: host.previousElementSibling?.id ?? "" }));
  }, control);

/** The label's rendered box. */
const labelBox = (page: Page, control: string) =>
  page.evaluate((id) => {
    const rect = document.querySelector(`#labelrow-${id} label`)!.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }, control);

test("puts the line on its own row under a side-labelled field, after the [label, control] row", async () => {
  const page = await openPage();
  await showLines(page, ["name"]);
  // A child of the flex column, directly after the field's row: never inside the 180px label row.
  expect(await placement(page, "name")).toEqual([{ parent: "column-name", after: "row-name" }]);
  expect(await page.locator("#labelrow-name pathix-xray-line").count()).toBe(0);
  // The line starts where the label starts.
  const [line, label] = await page.evaluate(() => [
    document.querySelector("#c-name pathix-xray-line")!.getBoundingClientRect().left,
    document.querySelector("#labelrow-name label")!.getBoundingClientRect().left,
  ]);
  expect(Math.round(line!)).toBe(Math.round(label!));

  const text = await screenText(page);
  expect(text).toContain("W: 7");
  // The AI-derived writer is marked in text beside W, not only in style.
  expect(text).toContain("+1✦");
  expect(text.match(/✦/g)).toHaveLength(1);
  expect(text).toContain("R: 8");
  expect(text).toContain("F: 5");
  await page.close();
});

test("leaves the side label at its own width, on one line, with X-ray on", async () => {
  const page = await openPage();
  const off = await labelBox(page, "name");
  expect(off.width).toBeGreaterThan(40);
  await showLines(page, ["name"]);
  expect(await labelBox(page, "name")).toEqual(off);
  await page.evaluate(() => (window as unknown as { lines: Lines }).lines.clear());
  expect(await labelBox(page, "name")).toEqual(off);
  await page.close();
});

test("puts the line right under the label row of a top-labelled field", async () => {
  const page = await openPage();
  const off = await labelBox(page, "creditlimit");
  await showLines(page, ["creditlimit"]);
  expect(await placement(page, "creditlimit")).toEqual([{ parent: "column-creditlimit", after: "labelrow-creditlimit" }]);
  expect(await labelBox(page, "creditlimit")).toEqual(off);
  // A count that could not be loaded is ?, never 0.
  const text = await screenText(page);
  expect(text).toContain("W: ?");
  expect(text).toContain("F: ?");
  await page.close();
});

test("a chip another extension adds to the label row moves nothing and squeezes nothing", async () => {
  const page = await openPage();
  await showLines(page, ["name"]);
  const before = await labelBox(page, "name");
  // Level Up runs its logical-names action now, appending its chip to the label's row.
  await page.evaluate(() => {
    const chip = document.createElement("span");
    chip.id = "chip-name";
    chip.textContent = "name";
    document.getElementById("labelrow-name")!.append(chip);
  });
  await page.waitForTimeout(100);
  expect(await placement(page, "name")).toEqual([{ parent: "column-name", after: "row-name" }]);
  expect(await labelBox(page, "name")).toEqual(before);
  await page.close();
});

test("writes nothing on a pass that finds the line already in place", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  const writes = await page.evaluate(() => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    (window as unknown as { lines: Lines }).lines.reconcile();
    seen.push(...observer.takeRecords());
    observer.disconnect();
    return seen.length;
  });
  expect(writes).toBe(0);
  await page.close();
});

test("puts the line back when the form removes just the host", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  await page.evaluate(() => document.querySelector("#c-creditlimit pathix-xray-line")!.remove());
  await expect.poll(() => placement(page, "creditlimit")).toEqual([{ parent: "column-creditlimit", after: "labelrow-creditlimit" }]);
  expect(await page.locator("pathix-xray-line").count()).toBe(2);
  await page.close();
});

test("is in a closed shadow root, and D365's nodes are left as they were", async () => {
  const page = await openPage();
  const before = await page.evaluate(() => document.getElementById("form")!.outerHTML);
  await showLines(page, ["name", "creditlimit"]);

  const closed = await page.evaluate(() => Array.from(document.querySelectorAll("pathix-xray-line")).map((host) => host.shadowRoot));
  expect(closed).toEqual([null, null]);

  // Take our hosts out and the form's markup is byte for byte what it was.
  const after = await page.evaluate(() => {
    const clone = document.getElementById("form")!.cloneNode(true) as Element;
    clone.querySelectorAll("pathix-xray-line").forEach((host) => host.remove());
    return clone.outerHTML;
  });
  expect(after).toBe(before);
  await page.close();
});

test("puts the line back once when the form re-renders", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);

  // A re-render that rebuilds a container's children, dropping our line with them.
  await page.evaluate(() => {
    const container = document.getElementById("c-name")!;
    const fresh = container.cloneNode(true) as Element;
    fresh.querySelectorAll("pathix-xray-line").forEach((host) => host.remove());
    container.replaceChildren(...Array.from(fresh.childNodes));
  });
  await expect.poll(() => placement(page, "name")).toEqual([{ parent: "column-name", after: "row-name" }]);

  // A re-render that replaces the whole container with a new node.
  await page.evaluate(() => {
    const old = document.getElementById("c-creditlimit")!;
    const next = old.cloneNode(true) as Element;
    next.querySelectorAll("pathix-xray-line").forEach((host) => host.remove());
    old.replaceWith(next);
  });
  await expect.poll(() => placement(page, "creditlimit")).toEqual([{ parent: "column-creditlimit", after: "labelrow-creditlimit" }]);
  await page.waitForTimeout(100);
  expect(await page.locator("pathix-xray-line").count()).toBe(2);
  await page.close();
});

test("ignores changes elsewhere on the page and reconciles for changes in or around a field", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  // The browser's first size report for each field costs one pass that writes nothing; let it settle.
  await page.waitForTimeout(150);
  // Count the reconciles the observer asks for.
  await page.evaluate(() => {
    const w = window as unknown as { lines: { reconcile(): number }; calls: number };
    w.calls = 0;
    const original = w.lines.reconcile.bind(w.lines);
    w.lines.reconcile = () => {
      w.calls++;
      return original();
    };
  });
  const calls = () => page.evaluate(() => (window as unknown as { calls: number }).calls);

  // A busy page outside the form's fields: a spinner and a notification.
  await page.evaluate(() => {
    const spinner = document.createElement("div");
    spinner.id = "spinner";
    document.body.append(spinner);
    spinner.append(document.createElement("span"));
    spinner.remove();
  });
  await page.waitForTimeout(150);
  expect(await calls()).toBe(0);

  // A change inside a field's container does reconcile.
  await page.evaluate(() => document.getElementById("control-name")!.append(document.createElement("div")));
  await expect.poll(calls).toBeGreaterThan(0);
  await page.close();
});

test("drops a line whose field leaves the page, and writes a new one when it comes back", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  await page.evaluate(() => {
    const w = window as unknown as { oldHost: Element | null; container: Element };
    w.oldHost = document.querySelector("#c-creditlimit pathix-xray-line");
    w.container = document.getElementById("c-creditlimit")!;
    w.container.remove();
  });
  // The old line is taken out of the detached field, so nothing of it is kept.
  await expect.poll(() => page.evaluate(() => (window as unknown as { oldHost: Element }).oldHost.isConnected || !!(window as unknown as { oldHost: Element }).oldHost.parentElement)).toBe(false);

  await page.evaluate(() => document.getElementById("form")!.append((window as unknown as { container: Element }).container));
  await expect.poll(() => placement(page, "creditlimit")).toEqual([{ parent: "column-creditlimit", after: "labelrow-creditlimit" }]);
  expect(await page.evaluate(() => document.querySelector("#c-creditlimit pathix-xray-line") !== (window as unknown as { oldHost: Element }).oldHost)).toBe(true);
  expect(await page.locator("pathix-xray-line").count()).toBe(2);
  await page.close();
});

test("writes a line for a field on a tab only once the tab renders", async () => {
  const page = await openPage();
  await showLines(page, ["name", "telephone1"]);
  expect(await page.locator("pathix-xray-line").count()).toBe(1);

  await page.evaluate((html) => document.getElementById("tab")!.insertAdjacentHTML("beforeend", html), TAB_FIELD);
  await expect.poll(() => placement(page, "telephone1")).toEqual([{ parent: "column-telephone1", after: "row-telephone1" }]);
  expect((await labelBox(page, "telephone1")).width).toBeGreaterThan(30);
  await page.close();
});

test("is reached by keyboard and opens the card", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["name:name-FieldSectionItemContainer"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    "name:name-FieldSectionItemContainer",
    "creditlimit:creditlimit-FieldSectionItemContainer",
  ]);
  await page.close();
});

test("turning it off removes every host, and the form is no longer watched", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit"]);
  expect(await page.locator("pathix-xray-line").count()).toBe(2);

  await page.evaluate(() => (window as unknown as { lines: Lines }).lines.clear());
  expect(await page.locator("pathix-xray-line").count()).toBe(0);

  // A later re-render does not bring a line back.
  await page.evaluate(() => document.getElementById("form")!.append(document.createElement("div")));
  await page.waitForTimeout(200);
  expect(await page.locator("pathix-xray-line").count()).toBe(0);
  await page.close();
});

/** The label's width in the side layout with no X-ray line anywhere: what "not squeezed" means. */
async function sideWidthWithoutLines(page: Page, control: string, toSide: () => Promise<unknown>, back: () => Promise<unknown>): Promise<number> {
  await toSide();
  const { width } = await labelBox(page, control);
  await back();
  return width;
}

test("moves the line out of a row a class turned into a no-wrap row: the label keeps its width", async () => {
  const page = await openPage();
  const toggle = (on: boolean) => page.evaluate((side) => document.getElementById("c-accountnumber")!.classList.toggle("side", side), on);
  const sideWidth = await sideWidthWithoutLines(page, "accountnumber", () => toggle(true), () => toggle(false));
  expect(sideWidth).toBeGreaterThan(60);

  await showLines(page, ["accountnumber"]);
  // Top labels: the field row is a column, so the line goes right under the label row, inside it.
  expect(await placement(page, "accountnumber")).toEqual([{ parent: "row-accountnumber", after: "labelrow-accountnumber" }]);

  // The form switches to side labels by a class on the container.
  await toggle(true);
  await expect.poll(() => placement(page, "accountnumber")).toEqual([{ parent: "column-accountnumber", after: "row-accountnumber" }]);
  expect((await labelBox(page, "accountnumber")).width).toBe(sideWidth);

  // And back.
  await toggle(false);
  await expect.poll(() => placement(page, "accountnumber")).toEqual([{ parent: "row-accountnumber", after: "labelrow-accountnumber" }]);
  expect(await page.locator("#c-accountnumber pathix-xray-line").count()).toBe(1);
  await page.close();
});

test("moves the line when a class on the form, above the fields, switches them to side labels", async () => {
  const page = await openPage();
  const toggle = (on: boolean) => page.evaluate((side) => document.getElementById("form")!.classList.toggle("side-labels", side), on);
  const sideWidth = await sideWidthWithoutLines(page, "accountnumber", () => toggle(true), () => toggle(false));
  await showLines(page, ["accountnumber"]);
  await toggle(true);
  await expect.poll(() => placement(page, "accountnumber")).toEqual([{ parent: "column-accountnumber", after: "row-accountnumber" }]);
  expect((await labelBox(page, "accountnumber")).width).toBe(sideWidth);
  await page.close();
});

test("moves the line when the window widens and a media query switches to side labels", async () => {
  const page = await openPage();
  const wide = () => page.setViewportSize({ width: 1200, height: 800 });
  const narrow = () => page.setViewportSize({ width: 900, height: 800 });
  const sideWidth = await sideWidthWithoutLines(page, "fax", wide, narrow);
  await showLines(page, ["fax"]);
  expect(await placement(page, "fax")).toEqual([{ parent: "row-fax", after: "labelrow-fax" }]);
  await wide();
  await expect.poll(() => placement(page, "fax")).toEqual([{ parent: "column-fax", after: "row-fax" }]);
  expect((await labelBox(page, "fax")).width).toBe(sideWidth);
  await page.close();
});

test("does not loop: placing and re-placing the line causes no further layout pass", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit", "accountnumber"]);
  await page.evaluate(() => {
    const w = window as unknown as { lines: { reconcile(): number }; calls: number };
    w.calls = 0;
    const original = w.lines.reconcile.bind(w.lines);
    w.lines.reconcile = () => {
      w.calls++;
      return original();
    };
  });
  await page.evaluate(() => document.getElementById("c-accountnumber")!.classList.add("side"));
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => (window as unknown as { calls: number }).calls);
  expect(settled).toBeGreaterThan(0);
  expect(settled).toBeLessThanOrEqual(3);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { calls: number }).calls)).toBe(settled);
  await page.close();
});

test("counts a field it has no place for, writes nothing into it, and says so", async () => {
  const page = await openPage();
  const before = await labelBox(page, "stuck");
  await showLines(page, ["name", "stuck"]);
  expect(await page.locator("#c-stuck pathix-xray-line").count()).toBe(0);
  expect(await labelBox(page, "stuck")).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { lines: { unmarked: number } }).lines.unmarked)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { unmarkedReports: number[] }).unmarkedReports)).toEqual([1]);
  // Off clears the count.
  await page.evaluate(() => (window as unknown as { lines: Lines }).lines.clear());
  expect(await page.evaluate(() => (window as unknown as { unmarkedReports: number[] }).unmarkedReports)).toEqual([1, 0]);
  await page.close();
});

/** Counts getComputedStyle calls from now on. The bundle calls the global, so wrapping window's is seen. */
async function countStyleReads(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { styleReads: number; getComputedStyle: typeof getComputedStyle };
    w.styleReads = 0;
    const original = w.getComputedStyle.bind(window);
    w.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      w.styleReads++;
      return original(element, pseudo);
    }) as typeof getComputedStyle;
  });
  return () => page.evaluate(() => (window as unknown as { styleReads: number }).styleReads);
}

const nextFrames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test("a class the page toggles on the body, as Fluent UI does on every click and Tab, reads no computed style", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit", "accountnumber"]);
  await nextFrames(page);
  await page.waitForTimeout(100);
  const reads = await countStyleReads(page);
  for (let i = 0; i < 50; i++) {
    await page.evaluate((n) => {
      document.body.classList.toggle("ms-Fabric--isFocusVisible", n % 2 === 0);
      document.body.classList.toggle("ms-Fabric--isFocusHidden", n % 2 === 1);
    }, i);
    await nextFrames(page);
  }
  expect(await reads()).toBeLessThanOrEqual(2);
  expect(await page.locator("pathix-xray-line").count()).toBe(3);
  await page.close();
});

test("a class change inside one field re-places that field alone", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit", "accountnumber"]);
  await nextFrames(page);
  await page.waitForTimeout(100);
  const reads = await countStyleReads(page);
  await page.evaluate(() => document.getElementById("control-name")!.classList.add("is-focused"));
  await nextFrames(page);
  const one = await reads();
  // The name field's climb is three ancestors: label row, field row, column. Other fields read nothing.
  expect(one).toBeGreaterThan(0);
  expect(one).toBeLessThanOrEqual(4);
  await page.close();
});

test("watches one container per line, and lets go of containers that were replaced or left the page", async () => {
  const page = await openPage();
  await showLines(page, ["name", "creditlimit", "stuck"]);
  const watching = () => page.evaluate(() => (window as unknown as { lines: { watching: number } }).lines.watching);
  expect(await watching()).toBe(3);
  // The form replaces a container three times over: still one watched for it.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const old = document.getElementById("c-creditlimit")!;
      const next = old.cloneNode(true) as Element;
      next.querySelectorAll("pathix-xray-line").forEach((host) => host.remove());
      old.replaceWith(next);
    });
    await expect.poll(() => placement(page, "creditlimit")).toEqual([{ parent: "column-creditlimit", after: "labelrow-creditlimit" }]);
  }
  expect(await watching()).toBe(3);
  // A field with no line (stuck) leaves the page: it is no longer watched either.
  await page.evaluate(() => document.getElementById("c-stuck")!.remove());
  await page.evaluate(() => (window as unknown as { lines: Lines }).lines.reconcile());
  expect(await watching()).toBe(2);
  await page.evaluate(() => (window as unknown as { lines: Lines }).lines.clear());
  expect(await watching()).toBe(0);
  await page.close();
});

test("does not count a hidden field it has no place for: nothing is missing there", async () => {
  const page = await openPage();
  await showLines(page, ["name", "hiddenstuck"]);
  expect(await page.evaluate(() => (window as unknown as { lines: { unmarked: number } }).lines.unmarked)).toBe(0);
  // Shown, it is counted.
  await page.evaluate(() => (document.getElementById("c-hiddenstuck") as HTMLElement).style.setProperty("display", "flex"));
  await expect.poll(() => page.evaluate(() => (window as unknown as { lines: { unmarked: number } }).lines.unmarked)).toBe(1);
  await page.close();
});

test("a field with no place keeps that verdict while it is typed in: no computed style is read again", async () => {
  const page = await openPage();
  await showLines(page, ["stuck"]);
  await nextFrames(page);
  await page.waitForTimeout(100);
  const reads = await countStyleReads(page);
  // Typing re-renders inside the container: a node added and removed.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const box = document.getElementById("c-stuck")!;
      box.append(document.createElement("span"));
      box.lastElementChild!.remove();
    });
    await nextFrames(page);
  }
  expect(await reads()).toBe(0);
  await page.close();
});

/** A form of `count` side-labelled fields, the shape of a heavy D365 page, plus one field with no place. */
async function openBigForm(count: number): Promise<{ page: Page; controls: string[] }> {
  const controls = Array.from({ length: count }, (_, i) => `pathix_f${i}`);
  const page = await browser.newPage();
  const fields = controls.map((control, i) => sideField(control, i + 10, `Field ${i}`, false)).join("");
  await page.setContent(`<!doctype html><html><body><main id="form">${fields}${STUCK_FIELD}</main></body></html>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.lines = new (w.PathixLines as { XrayLines: new (open: () => void) => unknown }).XrayLines(() => undefined);
  });
  return { page, controls };
}

/** Logs every box read ("B"), style read ("R") and insert of a line ("W"), in order, from now on. */
async function logReadsAndWrites(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { rw: string[]; getComputedStyle: typeof getComputedStyle };
    w.rw = [];
    const wrap = <T extends object>(owner: T, name: keyof T, mark: string) => {
      const original = owner[name] as unknown as (...args: unknown[]) => unknown;
      (owner as Record<keyof T, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
        w.rw.push(mark);
        return original.apply(this, args);
      };
    };
    wrap(Element.prototype, "getBoundingClientRect", "B");
    wrap(Element.prototype, "getClientRects", "B");
    wrap(window, "getComputedStyle", "R");
    wrap(Element.prototype, "after", "W");
  });
  return () => page.evaluate(() => (window as unknown as { rw: string[] }).rw);
}

/** Counts document-wide queries (one per field on a full pass) from now on. */
async function countDocumentQueries(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { docQueries: number };
    w.docQueries = 0;
    // A field's container is found with querySelectorAll (every form's copy, then the open form's: form-scope.ts).
    const one = Document.prototype.querySelector;
    const all = Document.prototype.querySelectorAll;
    Document.prototype.querySelector = function (this: Document, selector: string) {
      w.docQueries++;
      return one.call(this, selector);
    } as typeof Document.prototype.querySelector;
    Document.prototype.querySelectorAll = function (this: Document, selector: string) {
      w.docQueries++;
      return all.call(this, selector);
    } as typeof Document.prototype.querySelectorAll;
  });
  return () => page.evaluate(() => (window as unknown as { docQueries: number }).docQueries);
}

const showAll = (page: Page, controls: string[]) =>
  page.evaluate(({ names, formId }) => {
    const entry = (column: string) => ({ column, writers: 1, aiWriters: 0, readers: 0, aiReaders: 0, forms: 1, findings: 0 });
    (window as unknown as { lines: Lines }).lines.show(
      [...names, "stuck"].map((control) => ({ control, entry: entry(control) })),
      formId,
    );
  }, { names: controls, formId: FORM_ID });

test("turning X-ray on over 100 fields reads all the layout first, then writes: no read after a write", async () => {
  const { page, controls } = await openBigForm(100);
  const log = await logReadsAndWrites(page);
  await showAll(page, controls);
  const order = await log();
  const writes = order.filter((mark) => mark === "W").length;
  expect(writes).toBe(100);
  // Every read (computed styles, and the one "is it drawn" check for the field with no place) comes before the first write.
  const firstWrite = order.indexOf("W");
  expect(Math.max(order.lastIndexOf("R"), order.lastIndexOf("B"))).toBeLessThan(firstWrite);
  // The only box reads are that one check: placing or watching a line reads no box.
  expect(order.filter((mark) => mark === "B").length).toBeLessThanOrEqual(2);
  await page.close();
});

test("a field that grows while typed in, or shows a message, re-places that field alone", async () => {
  const { page, controls } = await openBigForm(100);
  await showAll(page, controls);
  await nextFrames(page);
  await page.waitForTimeout(200);
  const queries = await countDocumentQueries(page);

  // An auto-growing text area: a style change inside one field, and its container grows.
  await page.evaluate(() => (document.getElementById("control-pathix_f5") as HTMLElement).style.setProperty("height", "80px"));
  await nextFrames(page);
  await page.waitForTimeout(100);
  // A validation message added inside one field.
  await page.evaluate(() => {
    const message = document.createElement("div");
    message.textContent = "Required";
    document.getElementById("control-pathix_f7")!.append(message);
  });
  await nextFrames(page);
  await page.waitForTimeout(100);
  // A full pass would query the document once per field: 101 at least.
  expect(await queries()).toBeLessThanOrEqual(6);
  expect(await placement(page, "pathix_f5")).toEqual([{ parent: "column-pathix_f5", after: "row-pathix_f5" }]);
  expect(await placement(page, "pathix_f7")).toEqual([{ parent: "column-pathix_f7", after: "row-pathix_f7" }]);

  // A window resize still places every line again.
  const before = await queries();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(async () => (await queries()) - before).toBeGreaterThanOrEqual(100);
  await page.close();
});

test("the findings icon is named Finding on the line, and the AI-derived marker is read in words", async () => {
  const page = await openPage();
  await showLines(page, ["name"]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
  await cdp.detach();
  const names = nodes.map((node) => node.name?.value ?? "");
  const line = names.find((name) => name.includes("W: 7")) ?? "";
  expect(line).toContain("Finding");
  expect(line).toContain("0");
  // The marker is read out in words, not as a symbol.
  expect(line).toContain("1 more AI-derived (unverified)");
  expect(line).not.toContain("✦");
  await page.close();
});
