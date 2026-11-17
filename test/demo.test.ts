// The sandboxed demo (M4): an extension page answered from the bundled
// fixtures, never drawn on a customer's form, and never on the network.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataverseClient } from "../src/dataverse/client";
import { DEMO_ORIGIN, serveFromFixtures } from "../src/demo/demo";
import { DEMO_FIXTURES } from "../src/demo/fixtures";
import { loadDependenciesCard } from "../src/lite/dependencies";
import { loadRegisteredCard } from "../src/lite/registered";
import { loadLockedCard } from "../src/lite/locked";
import { allFixtures, fakeDataverse, ORIGIN } from "./fake-dataverse";

describe("the demo's fixtures", () => {
  it("bundle every fixture in contract/dataverse/, unchanged", () => {
    expect(DEMO_FIXTURES).toEqual(allFixtures());
  });

  it("answer the same as the unit tests' fake, through the real client and its allowlist", async () => {
    const context = { table: "account", column: "creditlimit", dirtyColumns: ["name"], showTips: true };
    const demo = await loadRegisteredCard(createDataverseClient(DEMO_ORIGIN, serveFromFixtures), context);
    const fake = await loadRegisteredCard(createDataverseClient(ORIGIN, fakeDataverse().fetch), context);
    expect(demo).toEqual(fake);
    expect(demo.headline).toMatch(/^30 plugin steps/);
  });

  it("show the locked field's checklist", async () => {
    const card = await loadLockedCard(createDataverseClient(DEMO_ORIGIN, serveFromFixtures), {
      table: "account",
      column: "pathix_legalofficer",
      control: "pathix_legalofficer",
      formId: "5c4a0000-0000-4000-8000-000000000021",
      showTips: true,
    });
    expect(card.lines.find((line) => line.topic === "The form")?.state).toBe("cause");
    // The column's definition is in the fixtures, so the demo never says it could not read it.
    expect(card.lines.find((line) => line.topic === "The platform")?.state).toBe("ruledOut");
    expect(card.lines.find((line) => line.topic === "Column security")?.state).toBe("ruledOut");
    expect(JSON.stringify(card)).not.toContain("Could not read");
  });

  it("name what depends on the locked field", async () => {
    const card = await loadDependenciesCard(createDataverseClient(DEMO_ORIGIN, serveFromFixtures), {
      table: "account",
      column: "pathix_legalofficer",
      showTips: true,
    });
    expect(card.headline).toMatch(/^Dataverse tracks 2 /);
    expect(card.groups.flatMap((group) => group.names)).toEqual(expect.arrayContaining(["Account", "pathix_account_LegalOfficer_contact"]));
    expect(card.groups.every((group) => group.unnamedCount === 0)).toBe(true);
  });
});

describe("the demo never draws on a customer's form", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { content_scripts: Array<{ js: string[] }> };

  it("is no content script", () => {
    const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
    expect(scripts).toEqual(["page.js", "content.js"]);
  });

  it("is imported by nothing that runs in a D365 page", () => {
    const pageSide = ["src/content", "src/page", "src/bridge", "src/lite", "src/card", "src/dataverse"].flatMap((dir) =>
      readdirSync(dir, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(dir, file)),
    );
    const offenders = pageSide.filter((file) => /from\s+["'][./]*demo\//.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("has its own extension page, reachable from the options page", () => {
    expect(readFileSync("static/demo.html", "utf8")).toContain('<script src="demo.js"></script>');
    expect(readFileSync("static/options.html", "utf8")).toContain('href="demo.html"');
  });

  it("opens from the toolbar popup's Open demo link, on any page", () => {
    const popup = readFileSync("src/popup/popup.ts", "utf8");
    expect(popup).toContain("chrome.tabs.create({ url: chrome.runtime.getURL(DEMO_PAGE) })");
    expect(popup).toContain('const DEMO_PAGE = "demo.html";');
    expect(readFileSync("static/popup.html", "utf8")).toContain('<button id="open-demo" type="button" class="link">Open demo</button>');
  });

  it("says it is sample data and not affiliated with Microsoft, with no em dashes", () => {
    const page = readFileSync("static/demo.html", "utf8");
    expect(page).toMatch(/Sample data, built into the extension\./);
    // Some bundled fixtures are hand-written stand-ins, so the page claims no environment.
    expect(page).not.toMatch(/test environment/);
    expect(page).toMatch(/not affiliated with Microsoft/);
    expect(page).toContain("Pathix™");
    expect(page).not.toContain("®");
    expect(page).not.toContain("—");
  });
});
