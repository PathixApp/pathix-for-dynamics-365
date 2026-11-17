// "Copy as brief" (M8): the plain-text summary of a card. Names and counts,
// never values; an unknown is written "unknown", never 0; the Lite brief
// follows the Lite copy rules. The clipboard write is the user's click and
// needs no permission.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { connectedBrief, liteBrief } from "../src/card/brief";
import { buildDependenciesCard } from "../src/card/lite";
import { buildFieldCard, type FieldCardContext, type FieldCardInputs } from "../src/card/model";
import { createDataverseClient } from "../src/dataverse/client";
import { loadDependenciesCard } from "../src/lite/dependencies";
import { loadLockedCard } from "../src/lite/locked";
import { loadRegisteredCard } from "../src/lite/registered";
import { copyText } from "../src/content/copy-brief";
import type { FieldWriter } from "../src/pathix/api";
import { fakeDataverse, ORIGIN } from "./fake-dataverse";

const context: FieldCardContext = {
  pathixUrl: "https://pathix.contoso.com",
  environmentId: "env-1",
  environmentName: "Contoso",
  scanCompletedAt: "2026-10-03T02:30:00Z",
  table: "account",
  column: "creditlimit",
  formatDate: () => "Oct 2, 2026, 10:30 PM",
  formatDay: () => "Aug 12",
};

function writer(overrides: Partial<FieldWriter>): FieldWriter {
  return {
    componentId: "c1",
    componentName: "Credit check",
    componentType: "PluginStep",
    isSystem: false,
    isConditional: false,
    isHumanDriven: false,
    confidence: "Parsed",
    actionTypes: ["Update"],
    ...overrides,
  };
}

const writers = [
  writer({ componentId: "p1", componentName: "Credit check", isConditional: true }),
  writer({ componentId: "f1", componentName: "Account", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "f2", componentName: "Quick Create", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "m1", componentName: "Platform sync", isSystem: true, confidence: "AiDerived" }),
];

/** A findings sweep that finished with every detector. */
const COMPLETE = { findings: { status: "Completed", failedDetectorFindingTypes: [] } };

function inputs(overrides: Partial<FieldCardInputs> = {}): FieldCardInputs {
  return {
    writers,
    dependents: { results: [{ componentId: "r1", componentType: "PluginStep", confidence: "Parsed" }] },
    permissions: { isSecured: false, grants: [] },
    security: { scopeBreakdown: { totalPrincipals: 3 }, tableResolved: true, withheldPrincipalCount: 0 },
    findings: { fields: [{ subjectKey: "account.creditlimit", openCount: 2, maxOpenSeverity: "High" }], readiness: COMPLETE },
    history: { historySince: "2026-08-12T09:00:00Z", totalCount: 3, entries: [1, 2, 3].map((n) => ({ scanId: `s${n}`, detectedAt: "2026-09-01T00:00:00Z" })) },
    registrations: new Map([
      ["p1", { message: "Update", stage: "PostOperation", executionMode: "Asynchronous", primaryEntity: "account", images: [{ imageType: "Pre", name: "PreImage", entityAlias: null, columns: ["creditlimit"] }] }],
      ["m1", { message: "Update", stage: "PostOperation", executionMode: "Asynchronous", primaryEntity: "account", images: [] }],
    ]),
    ...overrides,
  };
}

describe("the connected brief", () => {
  it("summarizes the card in names and counts, with the scan and the Pathix link", () => {
    const brief = connectedBrief(buildFieldCard(context, inputs()), "Dataverse has 12 dependency records. Pathix found 4 writers.");
    expect(brief).toBe(
      [
        "Pathix brief: account.creditlimit",
        "Scope: Contoso, Completed scan of Oct 2, 2026, 10:30 PM",
        "",
        "Writers: 4. Readers: 1. Conditional writers: 1.",
        "Open findings: 2 (highest severity: high).",
        "Changed 3 times since Aug 12",
        "Dataverse has 12 dependency records. Pathix found 4 writers.",
        "",
        "Writers listed:",
        "- PLG Credit check (Deterministic; On Update · Post-op · Async; Pre-image PreImage · this column only)",
        "- 2 forms (human): Account, Quick Create",
        "- PLG Platform sync (AI-derived (unverified); On Update · Post-op · Async; Microsoft)",
        "",
        "Writes Pathix cannot see, such as external integrations, are not included.",
        "Open in Pathix: https://pathix.contoso.com/investigate?table=account&column=creditlimit&env=env-1",
      ].join("\n"),
    );
  });

  it("writes every answer Pathix did not give as unknown, never 0", () => {
    const brief = connectedBrief(
      buildFieldCard(context, inputs({ writers: null, dependents: null, findings: null, history: null })),
      null,
    );
    expect(brief).toContain("Writers: unknown. Readers: unknown. Conditional writers: unknown.");
    expect(brief).toContain("Open findings: unknown.");
    expect(brief).toContain("Column history: unknown");
    expect(brief).toContain("Could not load the writers.");
    expect(brief).not.toMatch(/: 0\b/);
  });

  it("says a real zero as a zero", () => {
    const brief = connectedBrief(
      buildFieldCard(
        context,
        inputs({ writers: [], dependents: { results: [] }, findings: { fields: [{ subjectKey: "account.creditlimit", openCount: 0, maxOpenSeverity: null }], readiness: COMPLETE } }),
      ),
      null,
    );
    expect(brief).toContain("Writers: 0. Readers: 0. Conditional writers: 0.");
    expect(brief).toContain("Open findings: none.");
    expect(brief).toContain("No writers found in this scan.");
  });

  // H1: Pathix leaves out a column its latest scan does not hold, and a null
  // readiness means there is no Completed scan. Neither is "none".
  it("writes open findings as unknown when the answer leaves the column out, or there is no Completed scan", () => {
    const noCompletedScan = inputs({ findings: { fields: [{ subjectKey: "account.creditlimit", openCount: 0, maxOpenSeverity: null }], readiness: null } });
    expect(connectedBrief(buildFieldCard(context, noCompletedScan), null)).toContain("Open findings: unknown.");
    const running = inputs({
      findings: { fields: [{ subjectKey: "account.creditlimit", openCount: 0, maxOpenSeverity: null }], readiness: { findings: { status: "Running", failedDetectorFindingTypes: [] } } },
    });
    expect(connectedBrief(buildFieldCard(context, running), null)).toContain("Open findings: unknown.");
  });

  // H2: a column the latest scan does not hold answers [] for writers and readers. That is not zero.
  it("says a column is not in the latest scan, with no counts", () => {
    const omitted = inputs({ writers: [], dependents: { results: [] }, findings: { fields: [], readiness: COMPLETE } });
    const brief = connectedBrief(buildFieldCard(context, omitted), null);
    expect(brief).toContain("This column is not in Pathix's latest scan, so Pathix has no writers, readers or findings for it.");
    expect(brief).toContain("Not in Pathix's latest scan.");
    expect(brief).not.toMatch(/Writers: 0|Open findings: none|No writers found/);
  });

  it("writes readers as at least N and carries Pathix's coverage sentence", () => {
    const warned = inputs({ dependents: { results: [{ componentId: "r1", componentType: "PluginStep", confidence: "Parsed" }], coverageWarning: "Some reads were not seen." } });
    const brief = connectedBrief(buildFieldCard(context, warned), null);
    expect(brief).toContain("Readers: at least 1.");
    expect(brief).toContain("Readers are a minimum. Some reads were not seen.");
  });

  it("leaves the history line out when Pathix recorded no changes", () => {
    const none = { historySince: "2026-08-12T09:00:00Z", totalCount: 0, entries: [] };
    expect(connectedBrief(buildFieldCard(context, inputs({ history: none })), null)).not.toMatch(/Changed|history/i);
  });

  it("counts what is not listed and marks a secured column", () => {
    const many = Array.from({ length: 9 }, (_, i) => writer({ componentId: `p${i}`, componentName: `Step ${i}` }));
    const brief = connectedBrief(buildFieldCard(context, inputs({ writers: many, permissions: { isSecured: true, grants: [] } })), null);
    expect(brief).toContain("+3 more in Pathix.");
    expect(brief).toContain("Column security: this column is secured.");
  });

  it("writes column security as unknown when the permissions read failed, not as silence", () => {
    const failed = connectedBrief(buildFieldCard(context, inputs({ permissions: null })), null);
    expect(failed).toContain("Column security: unknown.");
    const known = connectedBrief(buildFieldCard(context, inputs()), null);
    expect(known).not.toContain("Column security");
  });

  it("holds no URL beyond the Pathix link, no em dash and no value-shaped text", () => {
    const brief = connectedBrief(buildFieldCard(context, inputs()), null);
    expect(brief).not.toContain("—");
    expect(brief.match(/https?:\/\/\S+/g)).toEqual(["https://pathix.contoso.com/investigate?table=account&column=creditlimit&env=env-1"]);
  });
});

describe("the Lite brief", () => {
  const server = fakeDataverse();
  const get = createDataverseClient(ORIGIN, server.fetch);
  const FORM_ID = "5c4a0000-0000-4000-8000-000000000021";

  async function briefs(column: string): Promise<string[]> {
    const registered = await loadRegisteredCard(get, { table: "account", column, dirtyColumns: ["name", "telephone1"], showTips: true });
    const dependencies = await loadDependenciesCard(get, { table: "account", column, showTips: true });
    const locked = await loadLockedCard(get, { table: "account", column, control: column, formId: FORM_ID, showTips: true });
    return [
      liteBrief({ kind: "registered", model: registered }),
      liteBrief({ kind: "dependencies", model: dependencies }),
      liteBrief({ kind: "locked", model: locked }),
    ];
  }

  it("names the platform's own facts for account.creditlimit", async () => {
    const [registered, dependencies] = await briefs("creditlimit");
    expect(registered).toContain("Pathix Lite brief: account.creditlimit");
    expect(registered).toContain("Source: Live from Dataverse, read with the reader's own access. Names and counts only.");
    expect(registered).toContain("Registered to fire when this changes");
    // The table's own 10, and 20 registered on Update for every table (plugin-steps-update-all-tables.json).
    expect(registered).toContain("30 plugin steps are registered to fire when this column changes.");
    expect(dependencies).toContain("Dataverse tracks 12 components that depend on this column.");
    expect(dependencies).toContain("Tracked dependencies");
  });

  it.each(["name", "creditlimit", "telephone1", "doesnotexist"])("follows the Lite rules for %s: no writers, no Pathix number, no link, no em dash", async (column) => {
    for (const brief of await briefs(column)) {
      expect(brief).not.toMatch(/\bwriters?\b/i);
      expect(brief).not.toMatch(/pathix\.app|https?:\/\//i);
      expect(brief).not.toMatch(/Pathix (found|counted)/i);
      expect(brief).not.toContain("—");
      // The only Pathix word the brief itself writes is its heading; the rest is customer component names.
      expect(brief.split("\n").filter((line) => /Pathix/.test(line) && !line.startsWith("- ") && !line.startsWith("  "))).toEqual([
        `Pathix Lite brief: account.${column}`,
      ]);
    }
  });

  it("writes a source that could not be read as unknown, never as none", () => {
    const failed = buildDependenciesCard({ table: "account", column: "name", showTips: true }, { kind: "failed" }, new Map());
    const brief = liteBrief({ kind: "dependencies", model: failed });
    expect(brief).toContain("Could not read Dataverse's dependency tracking for this column.");
    expect(brief).not.toMatch(/tracks 0|no components/i);
  });

  it("keeps the unknown lines of the registered card", async () => {
    const broken = fakeDataverse();
    broken.failWhen("sdkmessageprocessingsteps", 500);
    const model = await loadRegisteredCard(createDataverseClient(ORIGIN, broken.fetch), {
      table: "account",
      column: "creditlimit",
      dirtyColumns: [],
      showTips: true,
    });
    const brief = liteBrief({ kind: "registered", model });
    expect(brief).toMatch(/^Unknown: /m);
    expect(brief).not.toMatch(/\b0 plugin steps\b/);
  });
});

describe("the clipboard write", () => {
  it("writes the text on a click and says it worked", async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyText("brief", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("brief");
  });

  it("says so when the browser refuses or has no clipboard", async () => {
    expect(await copyText("brief", { writeText: async () => Promise.reject(new Error("denied")) })).toBe(false);
    expect(await copyText("brief", null)).toBe(false);
  });

  it("reads no clipboard from the environment when there is none", async () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    try {
      expect(await copyText("brief")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("needs no manifest permission, and nothing reads the clipboard", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { permissions: string[] };
    expect(manifest.permissions).not.toContain("clipboardWrite");
    expect(manifest.permissions).not.toContain("clipboardRead");
    for (const dir of ["src/content", "src/background", "src/card"]) {
      for (const file of readdirSync(dir)) {
        expect(readFileSync(`${dir}/${file}`, "utf8"), file).not.toMatch(/clipboard\.read|execCommand/);
      }
    }
  });

  it("writes only from the Copy button's click handler", () => {
    const view = readFileSync("src/content/card-view.ts", "utf8");
    expect(view.match(/copyText\(/g)).toHaveLength(1);
    expect(view).toMatch(/addEventListener\("click", \(\) => \{\s*void copyText\(brief\(\)\)/);
  });
});
