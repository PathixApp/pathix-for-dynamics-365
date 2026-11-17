// "What changed" (M11): Lite from the modified date of the table's components,
// connected from Pathix's change ledger, and the live freshness check.
//
// Lite is built from the fixtures in contract/dataverse/. The forms fixtures
// (forms-modified-account, modified-forms-account-name) are real captures with
// publishedon: a form has no modifiedon. The modifiedon values in the
// plugin-steps-account and workflows-account fixtures are hand-written
// stand-ins (the queries gained modifiedon after capture; see queries.json),
// so these tests assert the logic against known dates and never claim what a
// real org returns. The ledger answers are
// hand-written in the shape of the contract (contract/pathix-api.slice.json,
// GET /changes), because no real answer has been captured yet.

import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import {
  applyCardFreshness,
  buildFieldCard,
  liveRefsOf,
  type FieldCardContext,
  type CardRow,
  type FieldCardModel,
  type FormsRow,
} from "../src/card/model";
import { CHANGED_BADGE_TITLE, CHANGED_BADGE_TITLE_FORM, CHANGED_BADGE_TITLE_FORMS, changedBadgeTitle, freshnessOf, freshnessLine, keyOf, liveKey, liveRefFor, liveSourceFor, summarize } from "../src/card/freshness";
import { PATHIX_SITE } from "../src/card/lite";
import {
  applyChangesFreshness,
  buildLedgerChanges,
  coverageLines,
  coverageOf,
  findingGateLine,
  NO_BASELINE,
  buildLiteChanges,
  changeLabel,
  FORM_REPUBLISHED,
  liveRefsOfChanges,
  LEDGER_UNKNOWN,
  MAX_CHANGE_ROWS,
  MAX_LEDGER_ROWS,
  WHAT_CHANGED_TIP,
  type ChangeRow,
  type LedgerContext,
  type WhatChangedModel,
} from "../src/card/what-changed";
import { formsRow, writerRow } from "../src/content/card-view";
import { rowItem } from "../src/content/what-changed-view";
import { createDataverseClient } from "../src/dataverse/client";
import { loadLiteChanges, loadLiveModified } from "../src/lite/changes";
import { loadRegisteredCard } from "../src/lite/registered";
import type { ChangeEntry, ChangeWindowCoverage, EnvironmentChanges, FieldWriter } from "../src/pathix/api";
import { isTableChangesRequest } from "../src/runtime/messages";
import { fakeDataverse, fixture, ORIGIN } from "./fake-dataverse";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ids = (n: number) => `5c4a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup() {
  const server = fakeDataverse();
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

async function liteOf(options: { showTips?: boolean; server?: ReturnType<typeof setup> } = {}): Promise<WhatChangedModel> {
  const { get } = options.server ?? setup();
  return loadLiteChanges(get, { table: "account", showTips: options.showTips ?? true, now: NOW, locale: "en-US" });
}

const rowsOf = (model: WhatChangedModel) => model.groups.flatMap((group) => group.rows);

/**
 * Runs `build` with every toLocaleDateString formatting in UTC, the zone the
 * expected dates are written in. Only the zone is pinned; the product code
 * still asks for the user's local date.
 */
function inUtc<T>(build: () => T): T {
  const original = Date.prototype.toLocaleDateString;
  const spy = vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locales, options) {
    return original.call(this, locales, { ...options, timeZone: "UTC" });
  });
  try {
    return build();
  } finally {
    spy.mockRestore();
  }
}

describe("Lite: what changed on the table, from modified dates", () => {
  it("reads the table's steps, processes and forms, and lists the newest first", async () => {
    const model = await liteOf();
    expect(model.mode).toBe("lite");
    expect(model.kind).toBe("known");
    expect(model.status).toBe("Live from Dataverse");
    expect(model.groups.map((group) => group.title)).toEqual(["Modified or published in the last 30 days", "Modified or published earlier"]);

    // Every row in the first group is inside the window, newest first.
    const times = (rows: WhatChangedModel["groups"][number]["rows"]) => rows.map((row) => row.detail);
    expect(times(model.groups[0]!.rows)[0]).toMatch(/^(Modified|Published) Oct \d+, \d+ days? ago$/);
    expect(model.headline).toMatch(/^\d+ components were modified or published in the last 30 days\.$/);
    expect(rowsOf(model).length).toBeLessThanOrEqual(MAX_CHANGE_ROWS);
    expect(model.unknowns).toEqual([]);
  });

  it("makes six requests, and the step, process and read-privilege reads are the ones the registered card makes", async () => {
    const { server, get } = setup();
    await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const before = server.requests.length;
    await liteOf({ server: { server, get } });
    // The registered card had already read the steps and processes: only the forms are new.
    const added = server.requests.slice(before).map((url) => decodeURIComponent(url));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("systemforms?$select=formid,name,type,publishedon&$filter=objecttypecode eq 'account'");

    // The table's steps, the steps registered for every table, processes, forms,
    // and WhoAmI with the user's read privileges, which say whether the
    // processes list is whole (src/lite/visibility.ts).
    const alone = setup();
    await liteOf({ server: alone });
    expect(alone.server.requests).toHaveLength(6);
  });

  it("lists plugin steps registered on Update for every table, marked all tables, from the registered card's read", async () => {
    const allTables =
      "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon&$expand=sdkmessageid($select=name)&$filter=_sdkmessagefilterid_value";
    const server = setup();
    server.server.answerWhen(allTables, {
      value: [
        { sdkmessageprocessingstepid: ids(90), name: "Global audit", stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 0, solutionid: null, sdkmessageid: { name: "Update" }, modifiedon: "2026-10-05T00:00:00Z" },
        { sdkmessageprocessingstepid: ids(91), name: "Global off", stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 1, solutionid: null, sdkmessageid: { name: "Update" }, modifiedon: "2026-10-04T00:00:00Z" },
      ],
    });
    const model = await liteOf({ server });
    expect(rowsOf(model).find((row) => row.text === "Global audit")).toMatchObject({ kind: "PLG", tags: ["all tables"] });
    expect(rowsOf(model).find((row) => row.text === "Global off")).toMatchObject({ tags: ["all tables", "disabled"] });
    // A step on the table itself carries no such tag.
    expect(rowsOf(model).filter((row) => row.kind === "PLG" && !row.text.startsWith("Global")).every((row) => !row.tags.includes("all tables"))).toBe(true);
    expect(model.info[0]).toMatch(/registered on Update for every table/);

    // The captured fixture's test-environment step is read too, with its real date.
    const all = buildLiteChanges(
      { table: "account", showTips: true, now: Date.parse("2026-05-10T00:00:00Z"), locale: "en-US" },
      {
        steps: { kind: "ok", complete: true, value: [] },
        allTablesSteps: { kind: "ok", complete: true, value: fixture<{ value: never[] }>("plugin-steps-update-all-tables").value },
        processes: { kind: "ok", complete: true, value: [] },
        forms: { kind: "ok", complete: true, value: [] },
      },
    );
    expect(rowsOf(all).find((row) => row.text === "sim_NoOp_25_Update_global")).toMatchObject({ tags: ["all tables"] });
  });

  it("says so, and never counts them as none, when the steps registered for every table cannot be read", async () => {
    const server = setup();
    server.server.failWhen("sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon&$expand=sdkmessageid($select=name)&$filter=_sdkmessagefilterid_value", 500);
    const model = await liteOf({ server });
    expect(model.unknowns).toEqual(["Could not read steps registered on Update for every table."]);
    expect(rowsOf(model).some((row) => row.tags.includes("all tables"))).toBe(false);
    expect(model.headline).toMatch(/^(At least|Of what Lite could read)/);
  });

  it("counts a definition and its activation as one process, dated by the later of the two", () => {
    // The product shows the user's local date. The expected dates below are
    // UTC dates, so format in UTC here: the test then reads the same in every
    // time zone (it was red east and west of UTC alike).
    const model = inUtc(() => buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      {
        steps: { kind: "ok", value: [], complete: true }, allTablesSteps: { kind: "ok", complete: true, value: [] },
        forms: { kind: "ok", value: [], complete: true },
        processes: {
          kind: "ok",
          complete: true,
          value: [
            { workflowid: ids(1), name: "Set fields", category: 0, mode: 0, type: 1, statecode: 1, triggeronupdateattributelist: null, updatestage: null, _parentworkflowid_value: null, modifiedon: "2026-09-01T00:00:00Z" },
            { workflowid: ids(2), name: "Set fields", category: 0, mode: 0, type: 2, statecode: 1, triggeronupdateattributelist: null, updatestage: null, _parentworkflowid_value: ids(1), modifiedon: "2026-10-04T00:00:00Z" },
            { workflowid: ids(3), name: "Old rule", category: 2, mode: null, type: 1, statecode: 0, triggeronupdateattributelist: null, updatestage: null, _parentworkflowid_value: null, modifiedon: "2025-01-01T00:00:00Z" },
          ],
        },
      },
    ));
    expect(rowsOf(model).map((row) => `${row.kind} ${row.text} ${row.tags.join("+")} ${row.detail}`)).toEqual([
      "WF Set fields  Modified Oct 4, 2 days ago",
      "BR Old rule draft Modified Jan 1, 2025, 643 days ago",
    ]);
    expect(model.headline).toBe("1 component was modified or published in the last 30 days.");
  });

  it("tags a disabled step and a quick create form", () => {
    const model = buildLiteChanges(
      { table: "account", showTips: false, now: NOW, locale: "en-US" },
      {
        steps: { kind: "ok", complete: true, value: [{ sdkmessageprocessingstepid: ids(1), name: "Audit", stage: 40, mode: 1, rank: 1, filteringattributes: null, statecode: 1, solutionid: null, sdkmessageid: null, modifiedon: "2026-10-05T00:00:00Z" }] }, allTablesSteps: { kind: "ok", complete: true, value: [] },
        processes: { kind: "ok", complete: true, value: [] },
        forms: { kind: "ok", complete: true, value: [{ formid: ids(2), name: "Account Quick Create", type: 7, publishedon: "2026-10-04T00:00:00Z" }] },
      },
    );
    expect(rowsOf(model).map((row) => [row.kind, row.text, row.tags])).toEqual([
      ["PLG", "Audit", ["disabled"]],
      ["FRM", "Account Quick Create", ["quick create"]],
    ]);
  });
});

describe("Lite: absence is not evidence", () => {
  it("is unknown when no source could be read", async () => {
    const server = setup();
    for (const prefix of ["sdkmessageprocessingsteps", "workflows", "systemforms"]) server.server.failWhen(prefix, 500);
    const model = await liteOf({ server });
    expect(model.kind).toBe("unknown");
    expect(model.headline).toBe("Lite could not read when this table's components were modified or published.");
    expect(model.headline).not.toMatch(/\bno\b|\b0\b|nothing/i);
    expect(model.groups).toEqual([]);
  });

  it("names a source it was refused, and says it read only part", async () => {
    const server = setup();
    server.server.failWhen("sdkmessageprocessingsteps", 403);
    const model = await liteOf({ server });
    expect(model.kind).toBe("known");
    // Both step reads hit the steps table: the table's own and the one for every table.
    expect(model.unknowns).toEqual(["You don't have access to plugin step registrations.", "You don't have access to steps registered on Update for every table."]);
    expect(rowsOf(model).some((row) => row.kind === "PLG")).toBe(false);
    expect(rowsOf(model).some((row) => row.kind === "WF" || row.kind === "FRM")).toBe(true);
  });

  it("says a partial read is only part, and counts as at least", async () => {
    const server = setup();
    server.server.answerWhen("systemforms", { value: [{ formid: ids(1), name: "Account", type: 2, publishedon: "2026-10-05T00:00:00Z" }], "@odata.nextLink": `${ORIGIN}/api/data/v9.2/systemforms?$skiptoken=x` });
    const model = await liteOf({ server });
    expect(model.unknowns).toContain("Lite could not read every page of forms Dataverse returned, so some may be missing.");
    expect(model.headline).toMatch(/^At least \d+ components were modified or published in the last 30 days\.$/);
  });

  it("never says nothing was modified when a source is missing", async () => {
    const model = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "failed" }, allTablesSteps: { kind: "failed" }, forms: { kind: "ok", complete: true, value: [] }, processes: { kind: "forbidden" } },
    );
    expect(model.headline).toBe("Of what Lite could read, nothing was modified or published in the last 30 days.");
    expect(model.unknowns).toHaveLength(3);
  });

  it("says no component was modified only after reading everything", () => {
    const old = { sdkmessageprocessingstepid: ids(1), name: "Old", stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 0, solutionid: null, sdkmessageid: null, modifiedon: "2025-01-01T00:00:00Z" };
    const model = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "ok", complete: true, value: [old] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: { kind: "ok", complete: true, value: [] }, forms: { kind: "ok", complete: true, value: [] } },
    );
    expect(model.headline).toBe("No plugin steps, classic workflows, business rules or forms on this table were modified or published in the last 30 days.");
    expect(model.groups.map((group) => group.title)).toEqual(["Modified or published earlier"]);
  });

  it("counts a component with no readable date, and never dates it", () => {
    const step = (modifiedon: string | null | undefined) => ({ sdkmessageprocessingstepid: ids(1), name: "S", stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 0, solutionid: null, sdkmessageid: null, modifiedon });
    const model = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "ok", complete: true, value: [step(null), step(undefined), step("not a date"), step("2026-10-05T00:00:00Z")] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: { kind: "ok", complete: true, value: [] }, forms: { kind: "ok", complete: true, value: [] } },
    );
    expect(rowsOf(model)).toHaveLength(1);
    expect(model.unknowns).toEqual(["3 components have no modified or published date Lite could read."]);
  });

  it("never says none found or none modified while a component has no readable date", () => {
    const step = (modifiedon: string | null) => ({ sdkmessageprocessingstepid: ids(1), name: "S", stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 0, solutionid: null, sdkmessageid: null, modifiedon });
    const empty = { kind: "ok" as const, complete: true, value: [] };
    const ctx = { table: "account", showTips: true, now: NOW, locale: "en-US" };
    const allUndated = buildLiteChanges(ctx, { steps: { kind: "ok", complete: true, value: [step(null), step(null)] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: empty, forms: empty });
    expect(allUndated.headline).toBe("Of what Lite could read, nothing was modified or published in the last 30 days.");
    expect(allUndated.headline).not.toMatch(/found no/);
    const oldAndUndated = buildLiteChanges(ctx, { steps: { kind: "ok", complete: true, value: [step("2025-01-01T00:00:00Z"), step(null)] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: empty, forms: empty });
    expect(oldAndUndated.headline).toBe("Of what Lite could read, nothing was modified or published in the last 30 days.");
    const recentAndUndated = buildLiteChanges(ctx, { steps: { kind: "ok", complete: true, value: [step("2026-10-05T00:00:00Z"), step(null)] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: empty, forms: empty });
    expect(recentAndUndated.headline).toBe("At least 1 component was modified or published in the last 30 days.");
  });

  it("says when there is nothing on the table at all, only after a complete read", () => {
    const empty = { kind: "ok" as const, complete: true, value: [] };
    expect(buildLiteChanges({ table: "x", showTips: true, now: NOW }, { steps: empty, allTablesSteps: empty, processes: empty, forms: empty }).headline).toBe(
      "Lite found no plugin steps, classic workflows, business rules or forms on this table.",
    );
  });

  it("caps the list and says how many it left out", () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({ sdkmessageprocessingstepid: ids(i + 1), name: `Step ${i}`, stage: 40, mode: 0, rank: 1, filteringattributes: null, statecode: 0, solutionid: null, sdkmessageid: null, modifiedon: `2026-10-0${1 + (i % 5)}T${String(i % 24).padStart(2, "0")}:00:00Z` }));
    const model = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "ok", complete: true, value: steps }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: { kind: "ok", complete: true, value: [] }, forms: { kind: "ok", complete: true, value: [] } },
    );
    expect(rowsOf(model)).toHaveLength(MAX_CHANGE_ROWS);
    expect(model.note).toBe(`Showing the ${MAX_CHANGE_ROWS} most recent of 40.`);
    expect(model.headline).toBe("40 components were modified or published in the last 30 days.");
  });
});

describe("Lite: copy and footer", () => {
  it("carries the one footer line, and none when tips are off", async () => {
    expect((await liteOf()).tip).toEqual(WHAT_CHANGED_TIP);
    expect(WHAT_CHANGED_TIP.href).toBe(PATHIX_SITE);
    expect((await liteOf({ showTips: false })).tip).toBeNull();
  });

  it("never says writers, shows no Pathix number and uses no em dash", async () => {
    const model = await liteOf();
    // Component names are the customer's (a captured step is named "...CreditLimitWriter..."): only the copy counts.
    const text = JSON.stringify({ ...model, groups: model.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, text: "" })) })) });
    expect(text).not.toMatch(/writers?\b/i);
    expect(text).not.toMatch(/Pathix found|Pathix recorded/);
    expect(text).not.toContain("—");
    expect(model.freshness).toBeNull();
    expect(model.openUrl).toBeNull();
  });

  it("says what the list cannot see", async () => {
    expect((await liteOf()).info.join(" ")).toMatch(/does not say what changed or who changed it/);
  });
});

// --- connected -----------------------------------------------------------------------

const ledgerContext: LedgerContext = {
  pathixUrl: "https://pathix.contoso.com",
  environmentId: "11111111-2222-4333-8444-555555555555",
  environmentName: "Contoso",
  scanCompletedAt: "2026-10-03T02:30:00Z",
  scanStartedAt: "2026-10-03T02:00:00Z",
  table: "account",
  formatDate: () => "Oct 2, 2026, 10:30 PM",
  formatDay: (iso) => (iso.startsWith("2026-10-03") ? "Oct 3" : iso.startsWith("2026-09-26") ? "Sep 26" : iso.startsWith("2026-09-06") ? "Sep 6" : null),
};

function entry(overrides: Partial<ChangeEntry>): ChangeEntry {
  return {
    changeKind: "WriteAdded",
    subjectKind: "Component",
    subjectId: ids(10),
    subjectName: "Contoso.Plugins.CreditCheck",
    targetColumn: "creditlimit",
    detectedAt: "2026-10-03T02:30:00Z",
    scanId: ids(900),
    scanSequenceNumber: 12,
    subjectComponentType: "PluginStep",
    subjectIsSystem: false,
    ...overrides,
  };
}

function ledger(entries: ChangeEntry[], overrides: Partial<EnvironmentChanges> = {}): EnvironmentChanges {
  return { from: "2026-09-06T02:30:00Z", to: "2026-10-06T02:30:00Z", totalCount: entries.length, entries, ...overrides };
}

describe("connected: the ledger for the table", () => {
  it("lists changes by scan, newest first, with the column and the kind in words", () => {
    const model = buildLedgerChanges(
      ledgerContext,
      ledger([
        entry({ detectedAt: "2026-09-26T02:30:00Z", scanId: ids(800), scanSequenceNumber: 11, changeKind: "ReadRemoved", subjectName: "Old report", subjectComponentType: "SavedQuery", targetColumn: "name", subjectId: ids(11) }),
        entry({}),
        entry({ changeKind: "WriteAdded", subjectName: "Account Form", subjectComponentType: "Form", targetColumn: "telephone1", subjectId: ids(12), subjectIsSystem: true }),
      ]),
    );
    expect(model.mode).toBe("connected");
    expect(model.kind).toBe("known");
    expect(model.status).toBe("As of Oct 2, 2026, 10:30 PM");
    expect(model.headline).toBe("Pathix recorded 3 changes tied to this table since Sep 6.");
    expect(model.groups.map((group) => group.title)).toEqual(["Scan 12, Oct 3", "Scan 11, Sep 26"]);
    expect(model.groups[0]!.rows.map((row) => `${row.kind} ${row.text} | ${row.detail} | ${row.tags.join("+")}`)).toEqual([
      "PLG Contoso.Plugins.CreditCheck | Now writes: creditlimit | ",
      "FRM Account Form | Now writes: telephone1 | microsoft",
    ]);
    expect(model.groups[1]!.rows[0]!.detail).toBe("No longer reads: name");
    expect(model.tip).toBeNull();
    expect(model.openUrl).toBe("https://pathix.contoso.com/changes?table=account");
  });

  it("is a failed read, never an empty ledger, when Pathix did not answer", () => {
    const model = buildLedgerChanges(ledgerContext, null);
    expect(model.kind).toBe("unknown");
    expect(model.headline).toBe(LEDGER_UNKNOWN);
    expect(model.headline).not.toMatch(/\bno\b|\b0\b|nothing/i);
  });

  it("is unknown for an answer that is not the shape the contract promises", () => {
    expect(buildLedgerChanges(ledgerContext, { ...ledger([]), entries: undefined } as unknown as EnvironmentChanges).kind).toBe("unknown");
    expect(buildLedgerChanges(ledgerContext, { ...ledger([]), totalCount: "3" } as unknown as EnvironmentChanges).kind).toBe("unknown");
    // A total with no rows to list is a count with nothing behind it.
    expect(buildLedgerChanges(ledgerContext, ledger([], { totalCount: 4 })).kind).toBe("unknown");
  });

  it("says no changes are tied to the table only after a successful read, and says what that leaves out", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([]));
    expect(model.kind).toBe("known");
    expect(model.headline).toBe("Pathix recorded no changes tied to this table since Sep 6. Component changes recorded before Pathix was updated are not tied to a table (see the full ledger).");
    expect(model.info).toContain(
      "A row appears here when the ledger ties it to this table: a write or read of one of its columns, a column added or removed, or column security. A component that was added, renamed or changed in source is tied to its table from the first scan after Pathix was updated, and a republished form from the second. Earlier scans are not backfilled. Open the full ledger in Pathix for rows that carry no table.",
    );
  });

  // Item 16: a null baseline means the latest scan had nothing to compare with.
  it("says there is no earlier scan to compare when the baseline is null, never no changes", () => {
    const model = buildLedgerChanges(ledgerContext, { ...ledger([]), baselineScanNumber: null });
    expect(model.kind).toBe("known");
    expect(model.headline).toBe(NO_BASELINE);
    expect(model.headline).not.toMatch(/no changes/i);
    expect(buildLedgerChanges(ledgerContext, { ...ledger([]), baselineScanNumber: 4 }).headline).toMatch(/^Pathix recorded no changes/);
  });

  it("adds a line when the latest diff did not compare findings in full", () => {
    expect(buildLedgerChanges(ledgerContext, { ...ledger([]), findingDeltaGate: "NotCompared" }).unknowns).toEqual([
      "Finding changes were not compared in Pathix's latest scan, so they are not listed.",
    ]);
    expect(buildLedgerChanges(ledgerContext, { ...ledger([entry({})]), findingDeltaGate: "ComparedWithExclusions" }).unknowns).toEqual([
      "Some finding types were not compared in Pathix's latest scan, so changes to those findings are not listed.",
    ]);
    for (const gate of ["Compared", null, undefined]) {
      expect(findingGateLine(gate)).toBeNull();
      expect(buildLedgerChanges(ledgerContext, { ...ledger([]), findingDeltaGate: gate }).unknowns).toEqual([]);
    }
    expect(findingGateLine("SomethingNew")).toBe("Finding changes were not compared in Pathix's latest scan, so they are not listed.");
  });

  describe("the window's coverage", () => {
    const covered = (overrides: Partial<ChangeWindowCoverage> = {}): ChangeWindowCoverage => ({
      scanCount: 7,
      diffNotComparedCount: 0,
      diffNotRecordedCount: 0,
      findingsNotComparedCount: 0,
      findingsWithExclusionsCount: 0,
      findingGateNotRecordedCount: 0,
      ...overrides,
    });

    it("says no changes, with no gap line, only when every scan in the window compared", () => {
      const model = buildLedgerChanges(ledgerContext, { ...ledger([]), windowCoverage: covered() });
      expect(model.headline).toMatch(/^Pathix recorded no changes tied to this table since Sep 6\./);
      expect(model.unknowns).toEqual([]);
    });

    it("never says no changes when some scans did not compare changes, and names how many", () => {
      const model = buildLedgerChanges(ledgerContext, { ...ledger([]), windowCoverage: covered({ diffNotComparedCount: 2, diffNotRecordedCount: 1 }) });
      expect(model.kind).toBe("known");
      expect(model.headline).toBe(
        "Of the scans whose changes Pathix compared since Sep 6, none recorded a change tied to this table. Component changes recorded before Pathix was updated are not tied to a table (see the full ledger).",
      );
      expect(model.headline).not.toMatch(/^Pathix recorded no changes/);
      expect(model.unknowns).toEqual([
        "Changes were not compared on 2 of 7 scans since Sep 6, so changes from those scans are not listed.",
        "Pathix has no record of whether changes were compared on 1 of 7 scans since Sep 6.",
      ]);
    });

    it("says no scan completed in the window, never no changes", () => {
      const model = buildLedgerChanges(ledgerContext, { ...ledger([]), windowCoverage: covered({ scanCount: 0 }) });
      expect(model.headline).toBe("No Pathix scan completed since Sep 6, so no changes were compared.");
      expect(model.headline).not.toMatch(/no changes tied/);
    });

    it("names the finding gaps on every scan, and keeps the count when there are rows", () => {
      const model = buildLedgerChanges(ledgerContext, {
        ...ledger([entry({})]),
        windowCoverage: covered({ diffNotComparedCount: 1, findingsNotComparedCount: 1, findingGateNotRecordedCount: 3, findingsWithExclusionsCount: 2 }),
      });
      expect(model.headline).toBe("Pathix recorded 1 change tied to this table since Sep 6.");
      expect(model.unknowns).toEqual([
        "Changes were not compared on 1 of 7 scans since Sep 6, so changes from that scan are not listed.",
        "Findings were not compared on 1 scan since Sep 6, so finding changes from that scan are not listed.",
        "Pathix has no record of whether findings were compared on 3 scans since Sep 6.",
        "Some finding types were left out of the comparison on 2 scans since Sep 6, so changes to those findings are not listed.",
      ]);
    });

    it("speaks for the latest scan too, so the latest scan's gate line is not repeated", () => {
      const model = buildLedgerChanges(ledgerContext, { ...ledger([]), findingDeltaGate: "NotCompared", windowCoverage: covered({ findingsNotComparedCount: 1 }) });
      expect(model.unknowns).toEqual(["Findings were not compared on 1 scan since Sep 6, so finding changes from that scan are not listed."]);
    });

    it("falls back to the latest scan's gate when the coverage is absent or not the shape the contract promises", () => {
      const gateOnly = "Finding changes were not compared in Pathix's latest scan, so they are not listed.";
      for (const windowCoverage of [null, undefined, { scanCount: "7" }, { ...covered(), diffNotComparedCount: -1 }, { ...covered(), findingsNotComparedCount: 1.5 }]) {
        const changes = { ...ledger([]), findingDeltaGate: "NotCompared", windowCoverage } as unknown as EnvironmentChanges;
        expect(coverageOf(changes)).toBeNull();
        expect(buildLedgerChanges(ledgerContext, changes).unknowns).toEqual([gateOnly]);
      }
    });

    it("says the window's scans were compared as far as it knows, in the panel's span", () => {
      const noFrom = { ...ledger([]), from: "", windowCoverage: covered({ diffNotRecordedCount: 1 }) };
      expect(coverageLines(covered({ diffNotRecordedCount: 1 }), " in the last 30 days")).toEqual(["Pathix has no record of whether changes were compared on 1 of 7 scans in the last 30 days."]);
      expect(buildLedgerChanges(ledgerContext, noFrom).headline).toMatch(/^Of the scans whose changes Pathix compared in the last 30 days,/);
    });
  });

  it("caps the rows and links the rest to Pathix, counting from the true total", () => {
    const many = Array.from({ length: MAX_LEDGER_ROWS + 5 }, (_, i) => entry({ subjectId: ids(100 + i), subjectName: `C${i}` }));
    const model = buildLedgerChanges(ledgerContext, ledger(many, { totalCount: 90 }));
    expect(model.groups.flatMap((group) => group.rows)).toHaveLength(MAX_LEDGER_ROWS);
    expect(model.headline).toBe("Pathix recorded 90 changes tied to this table since Sep 6.");
    expect(model.more).toEqual({ text: `+${90 - MAX_LEDGER_ROWS} more in Pathix`, href: "https://pathix.contoso.com/changes?table=account" });
  });

  it("says Pathix-update rows are left out, and where Pathix lists them", () => {
    expect(buildLedgerChanges(ledgerContext, ledger([entry({})])).info).toContain(
      "Changes from a Pathix update are not listed or counted. Pathix started reading those components, or reads them differently, so they may not be changes in your environment. A real edit in the same scan keeps its own row. Pathix lists them apart, after the other changes.",
    );
  });

  it("shows a kind it does not know, in words, and never drops a row", () => {
    expect(changeLabel("PortalPageAccessRuleChanged")).toBe("Portal page access rule changed");
    expect(changeLabel("WriteAdded")).toBe("Now writes");
    const model = buildLedgerChanges(ledgerContext, ledger([entry({ changeKind: "SomethingNew", subjectComponentType: null, subjectKind: "Field" })]));
    expect(model.groups[0]!.rows[0]).toMatchObject({ kind: "", detail: "Something new: creditlimit", live: null });
  });

  it("keeps a row whose scan has no date, under a title that says so", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([entry({ detectedAt: "2026-08-01T00:00:00Z", scanSequenceNumber: null, scanId: null })]));
    expect(model.groups[0]!.title).toBe("Scan, date unknown");
  });

  it("never says Pathix found something Lite would show, and uses no em dash", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([entry({})]));
    expect(JSON.stringify(model)).not.toContain("—");
  });
});

describe("connected: the live check", () => {
  // The scan ran from 02:00 to 02:30.
  const SCAN = { startedAt: "2026-10-03T02:00:00Z", completedAt: "2026-10-03T02:30:00Z" };
  const stepRef = liveRefFor("PluginStep", ids(10))!;
  const formRef = liveRefFor("Form", ids(12))!;

  it("builds a ref only for a type the extension can read, with a real Dataverse id", () => {
    expect(liveRefFor("PluginStep", ids(10))).toEqual({ componentType: "PluginStep", id: ids(10) });
    expect(liveRefFor("PluginStep", ids(10).toUpperCase())).toEqual({ componentType: "PluginStep", id: ids(10) });
    for (const type of ["FormScript", "CanvasApp", "PcfControl", "HtmlWebResource", "Surprise", "toString", "__proto__"]) {
      expect(liveRefFor(type, ids(10)), type).toBeNull();
    }
    expect(liveRefFor("PluginStep", null)).toBeNull();
    expect(liveRefFor("PluginStep", "not a guid")).toBeNull();
    expect(liveRefFor("PluginStep", "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(liveRefFor(null, ids(10))).toBeNull();
  });

  it("keys by the table that holds the component, so a business rule and a workflow share one read", () => {
    expect(liveKey(liveRefFor("ClassicWorkflow", ids(1))!)).toBe(liveKey(liveRefFor("BusinessRule", ids(1))!));
    expect(liveKey(stepRef)).toBe(keyOf("sdkmessageprocessingsteps", ids(10)));
  });

  it("changed only when the live modified date is after the scan completed, unchanged only when it is on or before the scan started", () => {
    const at = (iso: string | null) => new Map([[liveKey(stepRef), iso]]);
    expect(freshnessOf(stepRef, at("2026-10-04T00:00:00Z"), SCAN)).toBe("changed");
    expect(freshnessOf(stepRef, at("2026-10-03T02:30:01Z"), SCAN)).toBe("changed");
    expect(freshnessOf(stepRef, at("2026-10-03T02:00:00Z"), SCAN)).toBe("unchanged");
    expect(freshnessOf(stepRef, at("2026-09-01T00:00:00Z"), SCAN)).toBe("unchanged");
  });

  it("does not know whether the scan saw a change made while it ran", () => {
    const at = (iso: string | null) => new Map([[liveKey(stepRef), iso]]);
    expect(freshnessOf(stepRef, at("2026-10-03T02:00:01Z"), SCAN)).toBe("duringScan");
    expect(freshnessOf(stepRef, at("2026-10-03T02:15:00Z"), SCAN)).toBe("duringScan");
    expect(freshnessOf(stepRef, at("2026-10-03T02:30:00Z"), SCAN)).toBe("duringScan");
    expect(freshnessLine(summarize(["duringScan"]))).toBe("1 component changed around the time of the scan, so the scan may not show it.");
    expect(freshnessLine(summarize(["unchanged", "duringScan", "duringScan"]))).toBe(
      "1 component is unchanged since the last scan. 2 components changed around the time of the scan, so the scan may not show them.",
    );
    expect(freshnessLine(summarize(["changed", "duringScan", "unknown"]))).toBe(
      "1 component has changed since the last scan. 1 component changed around the time of the scan, so the scan may not show it. 1 could not be checked.",
    );
  });

  it("never says unchanged when the scan's start time is missing or unreadable", () => {
    const at = (iso: string | null) => new Map([[liveKey(stepRef), iso]]);
    expect(freshnessOf(stepRef, at("2026-09-01T00:00:00Z"), { startedAt: null, completedAt: SCAN.completedAt })).toBe("unknown");
    expect(freshnessOf(stepRef, at("2026-09-01T00:00:00Z"), { startedAt: "garbage", completedAt: SCAN.completedAt })).toBe("unknown");
    // A change after completion is a change, whatever the start time.
    expect(freshnessOf(stepRef, at("2026-10-04T00:00:00Z"), { startedAt: null, completedAt: SCAN.completedAt })).toBe("changed");
  });

  it("is unknown, never unchanged, when it cannot say", () => {
    const at = (iso: string | null) => new Map([[liveKey(stepRef), iso]]);
    expect(freshnessOf(stepRef, at(null), SCAN)).toBe("unknown");
    expect(freshnessOf(stepRef, at("garbage"), SCAN)).toBe("unknown");
    expect(freshnessOf(stepRef, new Map(), SCAN)).toBe("unknown");
    expect(freshnessOf(stepRef, null, SCAN)).toBe("unknown");
    expect(freshnessOf(null, at("2026-10-04T00:00:00Z"), SCAN)).toBe("unknown");
    expect(freshnessOf(stepRef, at("2026-10-04T00:00:00Z"), { startedAt: SCAN.startedAt, completedAt: null })).toBe("unknown");
    expect(freshnessOf(stepRef, at("2026-10-04T00:00:00Z"), { startedAt: SCAN.startedAt, completedAt: "garbage" })).toBe("unknown");
  });

  it("says none changed only when every component was read", () => {
    expect(freshnessLine(summarize([]))).toBeNull();
    expect(freshnessLine(summarize(["unchanged", "unchanged"]))).toBe("Checked 2 components: none changed since the last scan.");
    expect(freshnessLine(summarize(["unchanged"]))).toBe("Checked 1 component: it has not changed since the last scan.");
    expect(freshnessLine(summarize(["changed", "unchanged"]))).toBe("1 component has changed since the last scan.");
    expect(freshnessLine(summarize(["changed", "changed", "unknown"]))).toBe("2 components have changed since the last scan. 1 could not be checked.");
    expect(freshnessLine(summarize(["unchanged", "unknown"]))).toBe("1 component is unchanged since the last scan. 1 could not be checked.");
    expect(freshnessLine(summarize(["unknown", "unknown"]))).toBe("2 could not be checked.");
  });

  const model = () =>
    buildLedgerChanges(
      ledgerContext,
      ledger([
        entry({ subjectId: ids(10) }),
        entry({ subjectId: ids(10), targetColumn: "name" }),
        entry({ subjectId: ids(12), subjectName: "Account", subjectComponentType: "Form" }),
        entry({ subjectId: ids(13), subjectName: "Gone", subjectComponentType: "PluginStep", changeKind: "ComponentRemoved", targetColumn: null }),
        entry({ subjectId: ids(14), subjectName: "Script", subjectComponentType: "FormScript" }),
        entry({ subjectKind: "Field", subjectId: ids(15), subjectName: "creditlimit", subjectComponentType: null, changeKind: "ColumnAdded" }),
      ]),
    );

  it("asks about each component once, and not about what is gone, not Component rows, or a type it cannot read", () => {
    expect(liveRefsOfChanges(model())).toEqual([stepRef, formRef]);
  });

  it("badges the components whose live date is newer, and leaves the rest alone", () => {
    const live = new Map([
      [liveKey(stepRef), "2026-10-05T08:00:00Z"],
      [liveKey(formRef), "2026-09-01T00:00:00Z"],
    ]);
    const done = applyChangesFreshness(model(), live);
    const rows = done.groups.flatMap((group) => group.rows);
    expect(rows.map((row) => [row.text, row.changedSinceScan])).toEqual([
      ["Contoso.Plugins.CreditCheck", true],
      ["Contoso.Plugins.CreditCheck", true],
      ["Account", false],
      ["Gone", false],
      ["Script", false],
      ["creditlimit", false],
    ]);
    // The removed step and the column are not components to check. The script is, and has no live read: unknown.
    expect(done.freshness).toBe("1 component has changed since the last scan. 1 could not be checked.");
  });

  it("is unknown for every component when the live read could not run", () => {
    const done = applyChangesFreshness(model(), null);
    expect(done.groups.flatMap((group) => group.rows).some((row) => row.changedSinceScan)).toBe(false);
    expect(done.freshness).toBe("3 could not be checked.");
    expect(done.freshness).not.toMatch(/none changed|unchanged/i);
  });

  it("is unknown for a component the read did not return", () => {
    const done = applyChangesFreshness(model(), new Map([[liveKey(stepRef), "2026-09-01T00:00:00Z"]]));
    expect(done.freshness).toBe("1 component is unchanged since the last scan. 2 could not be checked.");
  });

  it("leaves a Lite panel as it was", () => {
    const lite = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "failed" }, allTablesSteps: { kind: "failed" }, forms: { kind: "failed" }, processes: { kind: "failed" } },
    );
    expect(applyChangesFreshness(lite, new Map())).toBe(lite);
  });
});

describe("loadLiveModified: the live read", () => {
  const stepRef = liveRefFor("PluginStep", ids(10))!;
  const workflowRef = liveRefFor("ClassicWorkflow", ids(20))!;
  const ruleRef = liveRefFor("BusinessRule", ids(21))!;
  const formRef = liveRefFor("Form", ids(30))!;

  it("asks each table once, for the ids it holds, with only the id and its change date (publishedon for a form)", async () => {
    const { server, get } = setup();
    server.answerWhen("sdkmessageprocessingsteps", { value: [{ sdkmessageprocessingstepid: ids(10), modifiedon: "2026-10-05T00:00:00Z" }] });
    server.answerWhen("workflows", { value: [{ workflowid: ids(20), modifiedon: "2026-10-01T00:00:00Z" }, { workflowid: ids(21), modifiedon: null }] });
    server.answerWhen("systemforms", { value: [{ formid: ids(30), publishedon: "2026-10-06T00:00:00Z" }] });
    const live = await loadLiveModified(get, [stepRef, workflowRef, ruleRef, formRef, stepRef]);

    const asked = server.requests.map((url) => decodeURIComponent(url.slice(`${ORIGIN}/api/data/v9.2/`.length)));
    expect(asked.sort()).toEqual(
      [
        `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,modifiedon&$filter=Microsoft.Dynamics.CRM.In(PropertyName='sdkmessageprocessingstepid',PropertyValues=['${ids(10)}'])`,
        `workflows?$select=workflowid,modifiedon&$filter=Microsoft.Dynamics.CRM.In(PropertyName='workflowid',PropertyValues=['${ids(20)}','${ids(21)}'])`,
        `systemforms?$select=formid,publishedon&$filter=Microsoft.Dynamics.CRM.In(PropertyName='formid',PropertyValues=['${ids(30)}'])`,
      ].sort(),
    );
    expect(live.get(liveKey(stepRef))).toBe("2026-10-05T00:00:00Z");
    expect(live.get(liveKey(ruleRef))).toBeNull();
    expect(live.get(liveKey(workflowRef))).toBe("2026-10-01T00:00:00Z");
    expect(live.get(liveKey(formRef))).toBe("2026-10-06T00:00:00Z");
  });

  it("leaves out a table whose read failed, was refused or came back in part", async () => {
    const { server, get } = setup();
    server.failWhen("sdkmessageprocessingsteps", 403);
    server.failWhen("workflows", 500);
    server.answerWhen("systemforms", { value: [{ formid: ids(30), publishedon: "2026-10-06T00:00:00Z" }], "@odata.nextLink": `${ORIGIN}/api/data/v9.2/systemforms?$skiptoken=x` });
    const live = await loadLiveModified(get, [stepRef, workflowRef, formRef]);
    expect(live.size).toBe(0);
    expect(freshnessOf(stepRef, live, { startedAt: "2026-10-02T23:00:00Z", completedAt: "2026-10-03T00:00:00Z" })).toBe("unknown");
    expect(freshnessOf(formRef, live, { startedAt: "2026-10-02T23:00:00Z", completedAt: "2026-10-03T00:00:00Z" })).toBe("unknown");
  });

  it("reads in chunks, so a long list is several short requests", async () => {
    const { server, get } = setup();
    const refs = Array.from({ length: 120 }, (_, i) => liveRefFor("PluginStep", ids(1000 + i))!);
    await loadLiveModified(get, refs);
    expect(server.requests).toHaveLength(3);
  });

  it("makes no request for a type it cannot read", async () => {
    const { server, get } = setup();
    expect((await loadLiveModified(get, [])).size).toBe(0);
    expect(server.requests).toEqual([]);
  });
});

// --- the card's writers ----------------------------------------------------------------

describe("the connected card: live freshness on its writers", () => {
  const context: FieldCardContext = {
    pathixUrl: "https://pathix.contoso.com",
    environmentId: "env-1",
    environmentName: "Contoso",
    scanCompletedAt: "2026-10-03T02:30:00Z",
    scanStartedAt: "2026-10-03T02:00:00Z",
    table: "account",
    column: "name",
    formatDate: () => "Oct 2, 2026, 10:30 PM",
    formatDay: () => "Aug 12",
  };
  const writer = (overrides: Partial<FieldWriter>): FieldWriter => ({
    componentId: "c1",
    componentName: "Credit check",
    componentType: "PluginStep",
    isSystem: false,
    isConditional: false,
    isHumanDriven: false,
    confidence: "Parsed",
    actionTypes: ["Update"],
    sourceId: ids(10),
    ...overrides,
  });
  const card = (writers: FieldWriter[]): FieldCardModel =>
    buildFieldCard(context, {
      writers,
      dependents: { results: [] },
      permissions: { isSecured: false, grants: [] },
      security: { scopeBreakdown: { totalPrincipals: 1 }, tableResolved: true, withheldPrincipalCount: 0 },
      findings: null,
      history: null,
      registrations: new Map(),
    });

  const writers = [
    writer({}),
    writer({ componentId: "c2", componentName: "Set fields", componentType: "ClassicWorkflow", sourceId: ids(20) }),
    writer({ componentId: "c3", componentName: "Script", componentType: "FormScript", sourceId: ids(40) }),
    writer({ componentId: "f1", componentName: "Account", componentType: "Form", isHumanDriven: true, sourceId: ids(30) }),
    writer({ componentId: "f2", componentName: "Information", componentType: "Form", isHumanDriven: true, sourceId: ids(31) }),
    writer({ componentId: "f3", componentName: "Old form", componentType: "Form", isHumanDriven: true, sourceId: null }),
  ];

  it("carries a ref for each row and form, and the scan time to compare with", () => {
    const model = card(writers);
    expect(model.scanCompletedAt).toBe("2026-10-03T02:30:00Z");
    expect(liveRefsOf(model).map((ref) => `${ref.componentType} ${ref.id}`)).toEqual([
      `PluginStep ${ids(10)}`,
      `ClassicWorkflow ${ids(20)}`,
      `Form ${ids(30)}`,
      `Form ${ids(31)}`,
    ]);
  });

  it("badges a changed row, counts changed forms, and says what it could not check", () => {
    const model = card(writers);
    const live = new Map([
      [keyOf("sdkmessageprocessingsteps", ids(10)), "2026-10-04T00:00:00Z"],
      [keyOf("workflows", ids(20)), "2026-09-01T00:00:00Z"],
      [keyOf("systemforms", ids(30)), "2026-10-05T00:00:00Z"],
      [keyOf("systemforms", ids(31)), "2026-10-05T00:00:00Z"],
    ]);
    const done = applyCardFreshness(model, live);
    expect(done.rows.map((row) => (row.type === "forms" ? `forms ${row.changedSinceScan}` : `${row.name} ${row.changedSinceScan}`))).toEqual([
      "Credit check true",
      "Set fields false",
      "Script false",
      "forms 2",
    ]);
    // The script has no live read, and one form has no id: both are unknown, so the line says so.
    expect(done.freshness).toBe("3 components have changed since the last scan. 2 could not be checked.");
  });

  it("says a writer modified while the scan ran could have been missed, and never calls it unchanged", () => {
    const model = card([writer({})]);
    expect(model.scanStartedAt).toBe("2026-10-03T02:00:00Z");
    const done = applyCardFreshness(model, new Map([[keyOf("sdkmessageprocessingsteps", ids(10)), "2026-10-03T02:10:00Z"]]));
    expect(done.freshness).toBe("1 component changed around the time of the scan, so the scan may not show it.");
    expect(done.rows[0]).toMatchObject({ changedSinceScan: false });
  });

  it("is all unknown when the read could not run, and never says unchanged", () => {
    const model = card(writers);
    const done = applyCardFreshness(model, null);
    expect(done.freshness).toBe("6 could not be checked.");
    expect(done.rows.some((row) => (row.type === "forms" ? row.changedSinceScan : row.changedSinceScan))).toBe(false);
  });

  it("says nothing when there is nothing to check", () => {
    const model = card([writer({ componentType: "FormScript", sourceId: ids(40) })]);
    // No read is made, so the card is not drawn again and says nothing about the live check.
    expect(liveRefsOf(model)).toEqual([]);
  });

  it("works on an older Pathix whose writers carry no sourceId", () => {
    const model = card([writer({ sourceId: undefined })]);
    expect(liveRefsOf(model)).toEqual([]);
  });

  it("says published, and that a republish with no change counts, in the card note", () => {
    const info = card([]).info.join(" ");
    expect(info).toMatch(/A form has no modified date: the badge on a form means it was published after this scan/);
    expect(info).toMatch(/an edit that is not published does not show, and publishing again with no change does/);
  });

  describe("the badge each view draws carries the tooltip for its component type", () => {
    // A bare-bones DOM: enough of document for the view functions to build nodes.
    class FakeNode {
      className = "";
      title = "";
      hidden = false;
      type = "";
      textContent = "";
      style: Record<string, string> = {};
      children: FakeNode[] = [];
      constructor(readonly tag: string) {}
      append(...nodes: FakeNode[]) {
        this.children.push(...nodes);
      }
      setAttribute() {}
      addEventListener() {}
      find(predicate: (node: FakeNode) => boolean): FakeNode[] {
        return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.find(predicate))];
      }
    }
    beforeAll(() => {
      vi.stubGlobal("document", {
        createElement: (tag: string) => new FakeNode(tag),
        createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
        createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
      });
    });
    afterAll(() => {
      vi.unstubAllGlobals();
    });
    const badgeTitles = (root: unknown): string[] =>
      (root as FakeNode).find((node) => node.className === "tag fresh").map((node) => node.title);

    const changeRow = (overrides: Partial<ChangeRow>): ChangeRow => ({
      kind: "PLG",
      kindLabel: "Plugin step",
      colorType: "PluginStep",
      text: "Credit check",
      detail: "Modified Oct 3",
      tags: [],
      live: null,
      changedSinceScan: true,
      ...overrides,
    });

    it("on a ledger row, from the row's own type", () => {
      expect(badgeTitles(rowItem(changeRow({ kind: "FRM", kindLabel: "Form", colorType: "Form", text: "Account", detail: "Published Oct 3" })))).toEqual([CHANGED_BADGE_TITLE_FORM]);
      expect(badgeTitles(rowItem(changeRow({})))).toEqual([CHANGED_BADGE_TITLE]);
      expect(badgeTitles(rowItem(changeRow({ changedSinceScan: false })))).toEqual([]);
    });

    it("on a card writer row, from the row's own type", () => {
      const model = card([
        writer({ componentType: "PluginStep" }),
        writer({ componentId: "f1", componentName: "Account", componentType: "Form", isHumanDriven: true, sourceId: ids(30) }),
      ]);
      const rows = model.rows.filter((row): row is CardRow => row.type !== "forms");
      expect(rows.map((row) => row.kind)).toEqual(expect.arrayContaining(["PLG"]));
      const plugin = rows.find((row) => row.kind === "PLG")!;
      expect(badgeTitles(writerRow({ ...plugin, changedSinceScan: true }))).toEqual([CHANGED_BADGE_TITLE]);
      expect(badgeTitles(writerRow({ ...plugin, kind: "FRM", componentType: "Form", changedSinceScan: true }))).toEqual([CHANGED_BADGE_TITLE_FORM]);
    });

    it("on the forms row, which counts forms, the plural wording", () => {
      const forms = card([
        writer({ componentId: "f1", componentName: "Account", componentType: "Form", isHumanDriven: true, sourceId: ids(30) }),
        writer({ componentId: "f2", componentName: "Information", componentType: "Form", isHumanDriven: true, sourceId: ids(31) }),
      ]).rows.find((row): row is FormsRow => row.type === "forms")!;
      expect(badgeTitles(formsRow({ ...forms, changedSinceScan: 2 }))).toEqual([CHANGED_BADGE_TITLE_FORMS]);
      expect(badgeTitles(formsRow({ ...forms, changedSinceScan: 1 }))).toEqual([CHANGED_BADGE_TITLE_FORM]);
      expect(badgeTitles(formsRow({ ...forms, changedSinceScan: 0 }))).toEqual([]);
    });
  });

});

// --- messages and the panel --------------------------------------------------------------

describe("the table changes request", () => {
  const good = { kind: "tableChanges", organizationId: ids(3), host: "contoso.crm.dynamics.com", table: "account" };

  it("is accepted with a table, an organization and a host", () => {
    expect(isTableChangesRequest(good)).toBe(true);
  });

  it("refuses anything else: another key, a bad name, a bad host", () => {
    expect(isTableChangesRequest({ ...good, column: "name" })).toBe(false);
    expect(isTableChangesRequest({ ...good, table: "account; drop" })).toBe(false);
    expect(isTableChangesRequest({ ...good, host: "https://contoso.crm.dynamics.com/x" })).toBe(false);
    expect(isTableChangesRequest({ ...good, organizationId: "x" })).toBe(false);
    expect(isTableChangesRequest({ ...good, kind: "fieldCard" })).toBe(false);
    expect(isTableChangesRequest(null)).toBe(false);
  });
});

describe("the panel and its controller", () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const view = strip(readFileSync("src/content/what-changed-view.ts", "utf8"));
  const controller = strip(readFileSync("src/content/what-changed-controller.ts", "utf8"));

  it("is our own element in a closed shadow root and sets text only through textContent", () => {
    expect(view).toContain('attachShadow({ mode: "closed" })');
    expect(view).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(view).toMatch(/\.textContent = /);
  });

  it("makes no network call, reads no page text and never touches the bridge or storage", () => {
    for (const text of [view, controller]) {
      expect(text).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|chrome\.|localStorage|sessionStorage|document\.cookie/);
      expect(text).not.toMatch(/\.textContent(?!\s*=[^=])/);
    }
  });

  it("reads only the table, the organization and the host from the snapshot", () => {
    const reads = [...controller.matchAll(/snapshot\.(\w+)/g)].map((match) => match[1]);
    expect(new Set(reads)).toEqual(new Set(["organizationId", "host", "table", "formId"]));
  });

  it("every file under src/content that touches the panel sits in the list of known files", () => {
    const files = readdirSync("src/content").filter((file) => file.startsWith("what-changed"));
    expect(files.sort()).toEqual(["what-changed-controller.ts", "what-changed-view.ts"]);
  });

  it("keeps live answers in memory only: no storage anywhere in the live read or the freshness model", () => {
    for (const file of ["src/lite/changes.ts", "src/card/freshness.ts", "src/card/what-changed.ts"]) {
      expect(strip(readFileSync(file, "utf8")), file).not.toMatch(/chrome\.storage|localStorage|sessionStorage|indexedDB/);
    }
  });
});

describe("the controller's ordering", async () => {
  const { WhatChangedController } = await import("../src/content/what-changed-controller");
  const snapshot = { organizationId: ids(3), host: "contoso.crm.dynamics.com", table: "account", formId: ids(21) } as unknown as FormSnapshot;

  const ledgerModel = buildLedgerChanges(ledgerContext, ledger([entry({})]));
  const liteModel = buildLiteChanges(
    { table: "account", showTips: true, now: NOW, locale: "en-US" },
    { steps: { kind: "failed" }, allTablesSteps: { kind: "failed" }, forms: { kind: "failed" }, processes: { kind: "failed" } },
  );

  function harness(mode: "lite" | "connected" = "connected") {
    const calls: string[] = [];
    const liveReads: string[] = [];
    const defer = <T,>() => {
      let resolve: (value: T) => void = () => undefined;
      let reject: (reason?: unknown) => void = () => undefined;
      const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    const ledgerCall = defer<Awaited<ReturnType<import("../src/content/what-changed-controller").WhatChangedSources["connectedChanges"]>>>();
    const liveCall = defer<Awaited<ReturnType<import("../src/content/what-changed-controller").WhatChangedSources["liveModified"]>>>();
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      showMessage: (message: string) => calls.push(`message: ${message}`),
      showChanges: (model: WhatChangedModel) => calls.push(`changes: ${model.mode}${model.freshness ? ` | ${model.freshness}` : ""}`),
      hide: () => calls.push("hide"),
    };
    const sources = {
      settings: async () => ({ mode, showTips: true }),
      liteChanges: async () => liteModel,
      connectedChanges: () => ledgerCall.promise,
      liveModified: () => {
        liveReads.push("live read");
        return liveCall.promise;
      },
      hideTips: async () => undefined,
    };
    const instance = new WhatChangedController(view as never, sources);
    return { controller: instance, calls, ledgerCall, liveCall, liveReads };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  // Pairing: the freshness read runs only once Pathix has answered with ledger rows.
  it.each([
    ["signed out", { kind: "signedOut", reason: "no token" }],
    ["not scanned", { kind: "notScanned" }],
    ["an error", { kind: "error", message: "boom" }],
  ] as const)("makes no Dataverse read when Pathix answers %s", async (_label, status) => {
    const { controller: c, calls, ledgerCall, liveReads } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    ledgerCall.resolve({ kind: "status", status } as never);
    await settle();
    await settle();
    expect(liveReads).toEqual([]);
    expect(calls.filter((call) => call.startsWith("changes"))).toEqual([]);
  });

  it("shows the ledger at once, then draws it again with the live check", async () => {
    const { controller: c, calls, ledgerCall, liveCall } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    ledgerCall.resolve({ kind: "changes", model: ledgerModel });
    await settle();
    expect(calls.at(-1)).toBe("changes: connected");
    liveCall.resolve(new Map([[liveKey(liveRefFor("PluginStep", ids(10))!), "2026-10-05T00:00:00Z"]]));
    await settle();
    expect(calls.at(-1)).toBe("changes: connected | 1 component has changed since the last scan.");
  });

  it("keeps the ledger and says every component is unknown when the live read fails", async () => {
    const { controller: c, calls, ledgerCall, liveCall } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    ledgerCall.resolve({ kind: "changes", model: ledgerModel });
    await settle();
    liveCall.reject(new Error("blocked"));
    await settle();
    expect(calls.at(-1)).toBe("changes: connected | 1 could not be checked.");
  });

  it("does not draw an answer that arrives after the panel was closed", async () => {
    const { controller: c, calls, ledgerCall } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    c.close();
    ledgerCall.resolve({ kind: "changes", model: ledgerModel });
    await settle();
    expect(calls.filter((call) => call.startsWith("changes"))).toEqual([]);
    expect(calls.at(-1)).toBe("hide");
  });

  it("shows a sign-in problem as a message, never as an empty list", async () => {
    const { controller: c, calls, ledgerCall } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    ledgerCall.resolve({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    await settle();
    expect(calls.at(-1)).toBe("message: Signed out of Pathix. Sign in from the extension's options to see what Pathix found.");
  });

  it("makes no live read when the ledger has no component to check", async () => {
    const { controller: c, calls, ledgerCall } = harness();
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    ledgerCall.resolve({ kind: "changes", model: buildLedgerChanges(ledgerContext, ledger([entry({ subjectComponentType: "FormScript" })])) });
    await settle();
    expect(calls.filter((call) => call.startsWith("changes"))).toEqual(["changes: connected"]);
  });

  it("reads Dataverse in Lite and asks Pathix for nothing", async () => {
    const { controller: c, calls } = harness("lite");
    c.setSnapshot(snapshot);
    c.open();
    await settle();
    expect(calls.at(-1)).toBe("changes: lite");
  });

  it("asks for a form first", async () => {
    const { controller: c, calls } = harness();
    c.open();
    await settle();
    expect(calls).toEqual(["message: Open a record form to see what changed on its table."]);
  });
});

// --- the service worker's read -----------------------------------------------------------

describe("loadTableChanges: the Pathix read", async () => {
  const { loadTableChanges } = await import("../src/background/changes");
  const answer = (result: unknown) => {
    const paths: string[] = [];
    const get = (async (path: string) => {
      paths.push(path);
      return result;
    }) as never;
    return { get, paths };
  };

  it("asks for the environment and the table, and leaves out Pathix-update rows, so the window is Pathix's default", async () => {
    const { get, paths } = answer({ ok: true, data: ledger([entry({})]) });
    const response = await loadTableChanges(ledgerContext, get);
    expect(paths).toEqual([`/changes?environmentId=${ledgerContext.environmentId}&table=account&includePathixChanges=false`]);
    expect(response.kind).toBe("changes");
  });

  it("encodes the table name", async () => {
    const { get, paths } = answer({ ok: true, data: ledger([]) });
    await loadTableChanges({ ...ledgerContext, table: "a b&c" }, get);
    expect(paths[0]).toContain("table=a+b%26c");
  });

  it("turns a failed read into an unknown panel, never an empty one", async () => {
    const { get } = answer({ ok: false, kind: "failed", message: "Pathix answered 500." });
    const response = await loadTableChanges(ledgerContext, get);
    expect(response).toMatchObject({ kind: "changes", model: { kind: "unknown", headline: LEDGER_UNKNOWN } });
  });

  it("replaces the panel with a sign-in problem, as the card does", async () => {
    expect(await loadTableChanges(ledgerContext, answer({ ok: false, kind: "signedOut" }).get)).toEqual({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    expect(await loadTableChanges(ledgerContext, answer({ ok: false, kind: "unauthorized", status: 403 }).get)).toEqual({ kind: "status", status: { kind: "unauthorized", status: 403 } });
  });

  it("goes through the response cache the cards share, scoped to the scan", async () => {
    const { ResponseCache } = await import("../src/background/cache");
    let calls = 0;
    const get = (async () => {
      calls++;
      return { ok: true, data: ledger([entry({})]) };
    }) as never;
    const cache = new ResponseCache(60_000);
    await loadTableChanges(ledgerContext, cache.wrap(get, "env|scan-1"));
    await loadTableChanges(ledgerContext, cache.wrap(get, "env|scan-1"));
    expect(calls).toBe(1);
    await loadTableChanges(ledgerContext, cache.wrap(get, "env|scan-2"));
    expect(calls).toBe(2);
  });
});

// --- the hover card ------------------------------------------------------------------------

describe("the hover card's live check", async () => {
  const { HoverController } = await import("../src/content/hover-controller");
  const snapshot = {
    organizationId: ids(3),
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: ids(21),
    columns: [{ control: "name", column: "name" }],
    dirtyColumns: [],
    lockedControls: [],
  } as unknown as FormSnapshot;
  const container = { getBoundingClientRect: () => ({}), querySelector: () => null } as unknown as Element;
  const settle = () => new Promise((done) => setTimeout(done, 0));
  // The controller's timers live on window; the tests run without a DOM.
  beforeAll(() => void vi.stubGlobal("window", { setTimeout, clearTimeout }));
  afterAll(() => void vi.unstubAllGlobals());

  const writers: FieldWriter[] = [
    { componentId: "c1", componentName: "Credit check", componentType: "PluginStep", isSystem: false, isConditional: false, isHumanDriven: false, confidence: "Parsed", actionTypes: ["Update"], sourceId: ids(10) },
  ];
  const card = buildFieldCard(
    {
      pathixUrl: "https://pathix.contoso.com",
      environmentId: "env-1",
      environmentName: "Contoso",
      scanCompletedAt: "2026-10-03T02:30:00Z",
      table: "account",
      column: "name",
      formatDate: () => "Oct 2",
      formatDay: () => "Aug 12",
    },
    {
      writers,
      dependents: { results: [] },
      permissions: { isSecured: false, grants: [] },
      security: { scopeBreakdown: { totalPrincipals: 1 }, tableResolved: true, withheldPrincipalCount: 0 },
      findings: null,
      history: null,
      registrations: new Map(),
    },
  );

  function harness(live: () => Promise<Map<string, string | null>>) {
    const shown: Array<string | null | undefined> = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      setOnOpenOptions: () => undefined,
      takeFocus: () => undefined,
      hasFocus: false,
      showMessage: () => undefined,
      showState: () => undefined,
      showCard: (_anchor: unknown, model: FieldCardModel) => shown.push(model.freshness),
      contains: () => false,
      hide: () => undefined,
      isOpen: false,
    };
    const sources = {
      settings: async () => ({ mode: "connected" as const, showTips: true }),
      connectedCard: async () => ({ kind: "card" as const, card }),
      liteCards: async () => {
        throw new Error("not used");
      },
      userSecurity: async () => {
        throw new Error("not used");
      },
      liveModified: live,
      hideTips: async () => undefined,
      openOptions: async () => undefined,
    };
    const controller = new HoverController(view as never, sources as never);
    controller.setSnapshot(snapshot);
    controller.openFor("name", container);
    return { shown };
  }

  it("draws the card first, then again with the badge when the live read comes back", async () => {
    const { shown } = harness(async () => new Map([[keyOf("sdkmessageprocessingsteps", ids(10)), "2026-10-05T00:00:00Z"]]));
    await settle();
    await settle();
    expect(shown).toEqual([undefined, "1 component has changed since the last scan."]);
  });

  it("says the component could not be checked when the live read fails, and keeps the card", async () => {
    const { shown } = harness(async () => {
      throw new Error("refused");
    });
    await settle();
    await settle();
    expect(shown).toEqual([undefined, "1 could not be checked."]);
  });

  it("does not read at all when no writer can be read live", async () => {
    let reads = 0;
    const noRefs = { ...card, rows: card.rows.map((row) => (row.type === "writer" ? { ...row, live: null } : row)) };
    const shown: unknown[] = [];
    const view = { setOnClose: () => undefined, setOnHideTips: () => undefined, setOnOpenOptions: () => undefined, takeFocus: () => undefined, hasFocus: false, showMessage: () => undefined, showState: () => undefined, showCard: (_a: unknown, model: unknown) => shown.push(model), contains: () => false, hide: () => undefined, isOpen: false };
    const controller = new HoverController(view as never, {
      settings: async () => ({ mode: "connected", showTips: true }),
      connectedCard: async () => ({ kind: "card", card: noRefs }),
      liteCards: async () => undefined,
      userSecurity: async () => {
        throw new Error("not used");
      },
      liveModified: async () => {
        reads++;
        return new Map();
      },
      hideTips: async () => undefined,
      openOptions: async () => undefined,
    } as never);
    controller.setSnapshot(snapshot);
    controller.openFor("name", container);
    await settle();
    await settle();
    expect(reads).toBe(0);
    expect(shown).toHaveLength(1);
  });
});

// --- forms: dated by when they were published --------------------------------------------

describe("forms: the systemform table has no modifiedon, so a form's date is publishedon", () => {
  const SCAN = { startedAt: "2026-10-03T02:00:00Z", completedAt: "2026-10-03T02:30:00Z" };
  const formRef = liveRefFor("Form", ids(30))!;

  it("reads publishedon for a form and modifiedon for everything else", () => {
    expect(liveSourceFor("Form")?.changeColumn).toBe("publishedon");
    for (const type of ["PluginStep", "ClassicWorkflow", "BusinessRule", "Dialog", "Action", "ModernFlow", "SavedQuery", "Chart"]) {
      expect(liveSourceFor(type)?.changeColumn, type).toBe("modifiedon");
    }
  });

  it("asks Dataverse for no modifiedon on the form table, in Lite or in the live read", async () => {
    const lite = setup();
    await liteOf({ server: lite });
    const live = setup();
    await loadLiveModified(live.get, [formRef, liveRefFor("PluginStep", ids(10))!]);
    const formReads = [...lite.server.requests, ...live.server.requests].map((url) => decodeURIComponent(url)).filter((url) => url.includes("/systemforms?"));
    expect(formReads).toHaveLength(2);
    for (const url of formReads) {
      expect(url).toContain("publishedon");
      expect(url).not.toContain("modifiedon");
    }
  });

  it("is a fake that answers 400 to modifiedon on the form table, as Dataverse does, and the client never asks", async () => {
    const { server, get } = setup();
    // modifiedon is not a pinned column of systemforms, so the client refuses before sending.
    await expect(get("systemforms?$select=formid,name,type,modifiedon&$filter=objecttypecode eq 'account' and formactivationstate eq 1")).rejects.toThrow(
      "systemforms may not select modifiedon",
    );
    expect(server.requests).toHaveLength(0);
    const response = await server.fetch(`${ORIGIN}/api/data/v9.2/systemforms?$select=formid,modifiedon`, { method: "GET", headers: {} } as never);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("Could not find a property named 'modifiedon'");
    const other = await server.fetch(`${ORIGIN}/api/data/v9.2/workflows?$select=workflowid,modifiedon&$filter=primaryentity eq 'account'`, { method: "GET", headers: {} } as never);
    expect(other.status).not.toBe(400);
  });

  it("says a form was published, never modified or saved, with the date from the real capture", async () => {
    const model = await liteOf();
    const forms = rowsOf(model).filter((row) => row.kind === "FRM");
    expect(forms.length).toBeGreaterThan(0);
    for (const row of forms) {
      expect(row.detail).toMatch(/^Published /);
      expect(row.detail).not.toMatch(/modified|saved/i);
    }
    for (const row of rowsOf(model).filter((row) => row.kind !== "FRM")) expect(row.detail).toMatch(/^Modified /);
  });

  it("dates a form by its publishedon, and counts a form with none as undated", () => {
    const form = (name: string, publishedon: string | null) => ({ formid: ids(name.length), name, type: 2, publishedon });
    const model = inUtc(() =>
      buildLiteChanges(
        { table: "account", showTips: true, now: NOW, locale: "en-US" },
        {
          steps: { kind: "ok", complete: true, value: [] }, allTablesSteps: { kind: "ok", complete: true, value: [] },
          processes: { kind: "ok", complete: true, value: [] },
          forms: { kind: "ok", complete: true, value: [form("Account", "2026-10-04T01:12:57Z"), form("Never published", null)] },
        },
      ),
    );
    expect(rowsOf(model).map((row) => `${row.kind} ${row.text} ${row.detail}`)).toEqual(["FRM Account Published Oct 4, 2 days ago"]);
    expect(model.unknowns).toEqual(["1 component has no modified or published date Lite could read."]);
    expect(model.headline).toBe("At least 1 component was modified or published in the last 30 days.");
  });

  it("tells the user a form's date is its publish date: an unpublished edit does not show, a republish does", async () => {
    const info = (await liteOf()).info.join(" ");
    expect(info).toMatch(/published date of its forms/);
    expect(info).toMatch(/a form's date is when it was last published/);
    expect(info).toMatch(/An edit that is not published does not show here, and publishing again with no change does/);
    const ledger = buildLedgerChanges(ledgerContext, { from: "2026-09-06T00:00:00Z", to: "2026-10-06T00:00:00Z", totalCount: 0, entries: [] });
    expect(ledger.info.join(" ")).toMatch(/A form has no modified date: its badge means the form was published after the scan, so an edit that is not published does not show, and publishing again with no change does/);
  });

  it("badges a form whose publishedon is newer than the scan, and not one published before it", async () => {
    const { server, get } = setup();
    const other = liveRefFor("Form", ids(31))!;
    server.answerWhen("systemforms", {
      value: [
        { formid: ids(30), publishedon: "2026-10-04T01:12:57Z" },
        { formid: ids(31), publishedon: "2026-09-16T23:02:02Z" },
      ],
    });
    const live = await loadLiveModified(get, [formRef, other]);
    expect(freshnessOf(formRef, live, SCAN)).toBe("changed");
    expect(freshnessOf(other, live, SCAN)).toBe("unchanged");
  });
});

describe("forms: a failed form read is unknown, never no changes", () => {
  const SCAN = { startedAt: "2026-10-03T02:00:00Z", completedAt: "2026-10-03T02:30:00Z" };
  const formRef = liveRefFor("Form", ids(30))!;
  const stepRef = liveRefFor("PluginStep", ids(10))!;

  it("Lite says it could not read forms, and keeps what it did read, when Dataverse answers 400", async () => {
    // The answer the form table gave when the extension selected modifiedon.
    const server = setup();
    server.server.failWhen("systemforms", 400);
    const model = await liteOf({ server });
    expect(model.kind).toBe("known");
    expect(model.unknowns).toEqual(["Could not read forms."]);
    expect(rowsOf(model).some((row) => row.kind === "FRM")).toBe(false);
    expect(rowsOf(model).some((row) => row.kind === "PLG")).toBe(true);
    expect(model.headline).toMatch(/^At least \d+ components were modified or published in the last 30 days\.$/);
  });

  it("Lite never says nothing changed when the form read failed and nothing else was recent", () => {
    const model = buildLiteChanges(
      { table: "account", showTips: true, now: NOW, locale: "en-US" },
      { steps: { kind: "ok", complete: true, value: [] }, allTablesSteps: { kind: "ok", complete: true, value: [] }, processes: { kind: "ok", complete: true, value: [] }, forms: { kind: "failed" } },
    );
    expect(model.kind).toBe("known");
    expect(model.unknowns).toEqual(["Could not read forms."]);
    expect(model.headline).toBe("Of what Lite could read, nothing was modified or published in the last 30 days.");
    expect(model.headline).not.toMatch(/found no|^No /);
  });

  it("Lite is unknown, not empty, when every read failed", () => {
    const failed = { kind: "failed" as const };
    const model = buildLiteChanges({ table: "account", showTips: true, now: NOW, locale: "en-US" }, { steps: failed, allTablesSteps: failed, processes: failed, forms: failed });
    expect(model.kind).toBe("unknown");
    expect(model.groups).toEqual([]);
    expect(model.headline).not.toMatch(/\bno\b|nothing/i);
  });

  it("the live read leaves a form out when its read failed, so it is unknown and never unchanged", async () => {
    const { server, get } = setup();
    server.failWhen("systemforms", 400);
    server.answerWhen("sdkmessageprocessingsteps", { value: [{ sdkmessageprocessingstepid: ids(10), modifiedon: "2026-09-01T00:00:00Z" }] });
    const live = await loadLiveModified(get, [formRef, stepRef]);
    expect(live.has(liveKey(formRef))).toBe(false);
    expect(freshnessOf(formRef, live, SCAN)).toBe("unknown");
    expect(freshnessOf(stepRef, live, SCAN)).toBe("unchanged");
  });

  it("the connected panel counts a form it could not read as could not be checked", async () => {
    const { server, get } = setup();
    server.failWhen("systemforms", 400);
    const panel = buildLedgerChanges(ledgerContext, {
      from: "2026-09-06T00:00:00Z",
      to: "2026-10-06T00:00:00Z",
      totalCount: 1,
      entries: [entry({ subjectId: ids(30), subjectName: "Account", subjectComponentType: "Form" })],
    });
    const live = await loadLiveModified(get, liveRefsOfChanges(panel));
    const done = applyChangesFreshness(panel, live);
    expect(done.freshness).toBe("1 could not be checked.");
    expect(done.freshness).not.toMatch(/none changed|unchanged|has not changed/i);
    expect(rowsOf(done).some((row) => row.changedSinceScan)).toBe(false);
  });
});

describe("forms: the changed-since-scan tooltip and notes say published, not modified", () => {
  it("gives a form its own tooltip and everything else the modified-date one", () => {
    expect(changedBadgeTitle(true)).toBe(CHANGED_BADGE_TITLE_FORM);
    expect(changedBadgeTitle(false)).toBe(CHANGED_BADGE_TITLE);
    expect(CHANGED_BADGE_TITLE_FORM).toMatch(/published after Pathix's last scan/);
    expect(CHANGED_BADGE_TITLE_FORM).not.toMatch(/modified|saved/);
    expect(CHANGED_BADGE_TITLE).toMatch(/modified date/);
  });

  it("gives the forms row, which counts forms, the plural tooltip", () => {
    expect(changedBadgeTitle(true, 1)).toBe(CHANGED_BADGE_TITLE_FORM);
    expect(changedBadgeTitle(true, 2)).toBe(CHANGED_BADGE_TITLE_FORMS);
    expect(CHANGED_BADGE_TITLE_FORMS).toMatch(/these forms were published after Pathix's last scan/);
    expect(CHANGED_BADGE_TITLE_FORMS).toMatch(/publishing again with no change does/);
    expect(CHANGED_BADGE_TITLE_FORMS).not.toMatch(/modified|saved|this form/);
    expect(changedBadgeTitle(false, 3)).toBe(CHANGED_BADGE_TITLE);
  });

  it("says published in the ledger notes", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([]));
    expect(model.info.join(" ")).toMatch(/A form has no modified date: its badge means the form was published after the scan/);
  });

  it("no longer says Pathix records no row for a form edit", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([]));
    expect([model.headline, ...model.info].join(" ")).not.toMatch(/no row for a form edit|form edit produces no row/i);
    // The headline's pointer to the full ledger is about rows Pathix recorded, never about forms.
    expect(model.headline).not.toMatch(/form/i);
  });
});

describe("forms: a republished form in the ledger", () => {
  const sourceChanged = (overrides: Partial<ChangeEntry>) => entry({ changeKind: "SourceChanged", targetColumn: null, ...overrides });

  it("labels a form's source change Republished, in Lite's published words", () => {
    const model = buildLedgerChanges(
      ledgerContext,
      ledger([
        sourceChanged({ subjectName: "Account", subjectComponentType: "Form", subjectId: ids(30) }),
        sourceChanged({ subjectName: "Credit check", subjectComponentType: "ClassicWorkflow", subjectId: ids(31) }),
      ]),
    );
    expect(model.headline).toBe("Pathix recorded 2 changes tied to this table since Sep 6.");
    expect(rowsOf(model).map((row) => `${row.kind} ${row.text} | ${row.detail}`)).toEqual(["FRM Account | Republished", "WF Credit check | Source changed"]);
    expect(FORM_REPUBLISHED).toBe("Republished");
    expect(rowsOf(model)[0]!.detail).not.toMatch(/edit|modified|saved/i);
  });

  it("does not guess a form when the row carries no component type", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([sourceChanged({ subjectName: "Account", subjectComponentType: null })]));
    expect(rowsOf(model)[0]!.detail).toBe("Source changed");
  });

  it("keeps a form's other rows in their own words", () => {
    const model = buildLedgerChanges(
      ledgerContext,
      ledger([
        entry({ changeKind: "ComponentAdded", subjectName: "New form", subjectComponentType: "Form", targetColumn: null, subjectId: ids(32) }),
        entry({ changeKind: "WriteAdded", subjectName: "Account", subjectComponentType: "Form", targetColumn: "telephone1", subjectId: ids(30) }),
      ]),
    );
    expect(rowsOf(model).map((row) => row.detail)).toEqual(["Added", "Now writes: telephone1"]);
  });

  it("checks a republished form live, by the form's own read", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([sourceChanged({ subjectName: "Account", subjectComponentType: "Form", subjectId: ids(30) })]));
    expect(liveRefsOfChanges(model)).toEqual([liveRefFor("Form", ids(30))]);
  });

  it("says in the notes what a Republished row means and what it cannot see", () => {
    const model = buildLedgerChanges(ledgerContext, ledger([]));
    expect(model.info).toContain(
      "A form row that reads \"Republished\" means the form was published again between two scans. An edit that is not published does not show, and publishing again with no change does.",
    );
    expect(model.info.join(" ")).toMatch(/a republished form from the second\. Earlier scans are not backfilled/);
  });
});
