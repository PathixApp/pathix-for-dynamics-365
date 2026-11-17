import { describe, expect, it, vi } from "vitest";
import { mapWithLimit, ResponseCache } from "../src/background/cache";
import type { Get } from "../src/background/connection";
import { FINDINGS_BATCH, loadXray } from "../src/background/xray";
import { loadFieldCard } from "../src/background/field-card";
import { buildFieldCard } from "../src/card/model";
import { AI_MARK, aiDescription, aiSuffix, buildXrayEntry, formatCount, lineParts, lineText, partText, XRAY_LEGEND } from "../src/card/xray";
import type { ApiResult, FieldDependents, FieldWriter, OpenFindingCounts } from "../src/pathix/api";
import { isXrayRequest } from "../src/runtime/messages";

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

describe("buildXrayEntry", () => {
  type DependentRow = FieldDependents["results"][number];
  const dependents = (...types: string[]): FieldDependents => ({
    results: types.map((componentType, index) => ({ componentId: `r${index}`, componentType, confidence: "Parsed" })),
  });

  const form = (componentId: string, overrides: Partial<FieldWriter> = {}) =>
    writer({ componentId, componentType: "Form", isHumanDriven: true, confidence: "Declared", ...overrides });
  const formRow = (componentId: string, overrides: Partial<DependentRow> = {}): DependentRow => ({
    componentId,
    componentType: "Form",
    confidence: "Declared",
    ...overrides,
  });
  const reader = (componentId: string, overrides: Partial<DependentRow> = {}): DependentRow => ({
    componentId,
    componentType: "PluginStep",
    confidence: "Parsed",
    ...overrides,
  });
  const none = { aiWriters: 0, aiReaders: 0 };

  it("splits forms out by componentType: W counts the rest, F counts the distinct forms", () => {
    const entry = buildXrayEntry(
      "creditlimit",
      [writer({ componentId: "a" }), writer({ componentId: "b", isSystem: true }), form("f1"), form("f2")],
      { results: [reader("r"), formRow("f1"), formRow("f2")] },
      0,
    );
    expect(entry).toEqual({ column: "creditlimit", writers: 2, readers: 1, forms: 2, findings: 0, ...none });
  });

  it("counts a Microsoft-shipped form as a form too", () => {
    const entry = buildXrayEntry("x", [form("f", { isSystem: true })], dependents(), 0);
    expect(entry).toMatchObject({ writers: 0, forms: 1 });
  });

  it("counts Microsoft components in W and R, as the card's headline does", () => {
    const entry = buildXrayEntry(
      "x",
      [writer({ componentId: "a" }), writer({ componentId: "m", isSystem: true })],
      { results: [reader("r"), reader("ms", { componentType: "SavedQuery" })] },
      0,
    );
    expect(entry).toMatchObject({ writers: 2, readers: 2 });
  });

  it("marks an AI-derived writer in text, not only in style, and leaves it out of W", () => {
    const entry = buildXrayEntry("x", [writer({ componentId: "a" }), writer({ componentId: "ai", confidence: "AiDerived" })], dependents(), 0);
    expect(entry).toMatchObject({ writers: 1, aiWriters: 1 });
    expect(lineParts(entry)[0]).toEqual({ text: "W: 1", ai: 1 });
    expect(lineText(entry)).toBe("W: 1 +1✦  R: 0  F: 0  Finding 0");
  });

  it("marks an AI-derived reader in text, not only in style, and leaves it out of R", () => {
    const entry = buildXrayEntry(
      "x",
      [],
      { results: [reader("r"), reader("ai1", { confidence: "AiDerived" }), reader("ai2", { confidence: "AiDerived" })] },
      0,
    );
    expect(entry).toMatchObject({ readers: 1, aiReaders: 2 });
    expect(lineText(entry)).toBe("W: 0  R: 1 +2✦  F: 0  Finding 0");
  });

  it("leaves the marker off when nothing is AI-derived, and an AI-derived form stays a form", () => {
    const entry = buildXrayEntry("x", [writer({}), form("f", { confidence: "AiDerived" })], { results: [formRow("f")] }, 0);
    expect(entry).toMatchObject({ writers: 1, aiWriters: 0, forms: 1 });
    expect(lineText(entry)).not.toContain("✦");
  });

  it("never pairs a marker with an unknown count", () => {
    expect(lineText({ column: "x", writers: null, aiWriters: null, readers: null, aiReaders: null, forms: null, findings: null })).toBe(
      "W: ?  R: ?  F: ?  Finding ?",
    );
  });

  it("does not take a human-driven component that is not a form for a form", () => {
    const entry = buildXrayEntry(
      "x",
      [writer({ componentId: "pcf", componentType: "PcfControl", isHumanDriven: true }), writer({ componentId: "pb", componentType: "PortalBasicForm", isHumanDriven: true })],
      dependents(),
      0,
    );
    expect(entry).toMatchObject({ writers: 2, forms: 0 });
  });

  it("counts a Quick Create form once, even if it appears as two rows with one componentId", () => {
    const entry = buildXrayEntry("x", [form("qc", { actionTypes: ["Create"] }), form("qc", { actionTypes: ["Update"] })], dependents(), 0);
    expect(entry.forms).toBe(1);
  });

  it("counts a form that only shows the column read-only: it is in the dependents, not the writers", () => {
    const entry = buildXrayEntry("x", [form("edit")], { results: [formRow("edit"), formRow("ro1"), formRow("ro2")] }, 0);
    expect(entry).toMatchObject({ writers: 0, readers: 0, forms: 3 });
  });

  it("is unknown for F when either answer is missing: one alone would undercount", () => {
    expect(buildXrayEntry("x", [form("f")], null, 0).forms).toBeNull();
    expect(buildXrayEntry("x", null, { results: [formRow("f")] }, 0).forms).toBeNull();
  });

  describe("agrees with the hover card's headline for the same column", () => {
    // One fixture with every kind of row: customer and Microsoft logic, an
    // AI-derived writer and reader, an editable form and a read-only form.
    const writers = [
      writer({ componentId: "a" }),
      writer({ componentId: "b", confidence: "Declared" }),
      writer({ componentId: "ai", confidence: "AiDerived" }),
      writer({ componentId: "m", isSystem: true }),
      form("edit"),
    ];
    const readers: FieldDependents = {
      results: [
        reader("r1"),
        reader("ms", { componentType: "SavedQuery" }),
        reader("rai", { confidence: "AiDerived" }),
        formRow("edit", { referenceKind: "Display" }),
        formRow("readonly"),
        // Another table's form, whose sub-grid filters on this column: a read, not a placement.
        formRow("subgrid", { referenceKind: "Filter" }),
      ],
    };
    const headline = (deps: FieldDependents) => {
      const card = buildFieldCard(
        {
          pathixUrl: "https://p",
          environmentId: "e",
          environmentName: "dev",
          scanCompletedAt: null,
          table: "account",
          column: "x",
          formatDate: () => "",
          formatDay: () => "",
        },
        { writers, dependents: deps, permissions: null, security: null, findings: null, history: null, registrations: new Map() },
      );
      const stat = (label: string) => card.stats.find((candidate) => candidate.label === label)?.value ?? null;
      return { writers: stat("writers")!, readers: stat("readers")! };
    };
    const formRows = (rows: Array<{ componentType: string }>) => rows.filter((row) => row.componentType === "Form").length;
    const formPlacements = (rows: DependentRow[]) =>
      rows.filter((row) => row.componentType === "Form" && (row.referenceKind === undefined || row.referenceKind === "Display")).length;

    it("card writers = W + W's marker + the form rows among the writers, Microsoft included", () => {
      const entry = buildXrayEntry("x", writers, readers, null);
      expect(entry).toMatchObject({ writers: 3, aiWriters: 1 });
      expect(headline(readers).writers).toBe(5);
      expect(entry.writers! + entry.aiWriters! + formRows(writers)).toBe(headline(readers).writers);
    });

    it("card readers = R + R's marker + the form placements among the dependents, Microsoft included", () => {
      const entry = buildXrayEntry("x", writers, readers, null);
      expect(entry).toMatchObject({ readers: 3, aiReaders: 1 });
      expect(headline(readers).readers).toBe(6);
      expect(entry.readers! + entry.aiReaders! + formPlacements(readers.results)).toBe(headline(readers).readers);
    });

    it("W + marker + F is the card's writer count only when every form is editable", () => {
      // With a read-only form, F counts one form the writers do not list.
      const withReadOnly = buildXrayEntry("x", writers, readers, null);
      expect(withReadOnly.forms).toBe(2);
      expect(withReadOnly.writers! + withReadOnly.aiWriters! + withReadOnly.forms!).toBe(headline(readers).writers + 1);
      // Every form editable: the two agree.
      const editableOnly: FieldDependents = { results: readers.results.filter((row) => row.componentId !== "readonly") };
      const entry = buildXrayEntry("x", writers, editableOnly, null);
      expect(entry.writers! + entry.aiWriters! + entry.forms!).toBe(headline(editableOnly).writers);
    });
  });

  it("leaves forms out of R", () => {
    const entry = buildXrayEntry("x", [], dependents("PluginStep", "Form", "SavedQuery", "Form"), 0);
    expect(entry.readers).toBe(2);
  });

  it("counts a form's sub-grid filter on the column toward R, not F", () => {
    // The Account form's Contacts sub-grid filters on contact.parentcustomerid: the form reads the column, it does not carry it.
    const entry = buildXrayEntry(
      "parentcustomerid",
      [form("contact-main")],
      { results: [formRow("contact-main", { referenceKind: "Display" }), formRow("account-main", { referenceKind: "Filter" })] },
      0,
    );
    expect(entry).toMatchObject({ writers: 0, readers: 1, forms: 1 });
  });

  it("counts a form row as a placement when its kind is Display or absent, and as a read for any other kind", () => {
    const rows = (referenceKind?: string) => ({ results: [formRow("f", referenceKind === undefined ? {} : { referenceKind })] });
    expect(buildXrayEntry("x", [], rows(), 0)).toMatchObject({ readers: 0, forms: 1 });
    expect(buildXrayEntry("x", [], rows("Display"), 0)).toMatchObject({ readers: 0, forms: 1 });
    expect(buildXrayEntry("x", [], rows("Filter"), 0)).toMatchObject({ readers: 1, forms: 0 });
    expect(buildXrayEntry("x", [], rows("FormBehavior"), 0)).toMatchObject({ readers: 1, forms: 0 });
  });

  it("puts an AI-derived sub-grid filter read in R's marker", () => {
    const entry = buildXrayEntry("x", [], { results: [formRow("f", { referenceKind: "Filter", confidence: "AiDerived" })] }, 0);
    expect(entry).toMatchObject({ readers: 0, aiReaders: 1, forms: 0 });
  });

  it("is unknown, never zero, for a count Pathix did not answer", () => {
    expect(buildXrayEntry("x", null, null, null)).toEqual({
      column: "x",
      writers: null,
      aiWriters: null,
      readers: null,
      aiReaders: null,
      forms: null,
      findings: null,
    });
    // Writers answered, dependents did not: R and F are unknown.
    expect(buildXrayEntry("x", [], null, 3)).toEqual({ column: "x", writers: 0, aiWriters: 0, readers: null, aiReaders: null, forms: null, findings: 3 });
  });
});

describe("the line's text", () => {
  const entry = { column: "x", writers: 7, aiWriters: 0, readers: 8, aiReaders: 0, forms: 5, findings: 0 };

  it("reads W, R, F, then the findings count", () => {
    expect(lineParts(entry)).toEqual([
      { text: "W: 7", ai: 0 },
      { text: "R: 8", ai: 0 },
      { text: "F: 5", ai: 0 },
    ]);
    expect(lineText(entry)).toBe("W: 7  R: 8  F: 5  Finding 0");
  });

  it("writes the AI-derived count after W or R as +N✦, with words for a screen reader", () => {
    expect(lineText({ ...entry, writers: 6, aiWriters: 1 })).toBe("W: 6 +1✦  R: 8  F: 5  Finding 0");
    expect(partText({ text: "R: 2", ai: 3 })).toBe("R: 2 +3✦");
    expect(aiSuffix(0)).toBe("");
    expect(aiDescription(1)).toBe("1 more AI-derived (unverified)");
    expect(AI_MARK).toBe("✦");
  });

  it("writes ? for each count that could not be loaded, and a real 0 as 0", () => {
    expect(lineText({ column: "x", writers: null, aiWriters: null, readers: 0, aiReaders: 0, forms: null, findings: null })).toBe(
      "W: ?  R: 0  F: ?  Finding ?",
    );
    expect(formatCount(null)).toBe("?");
    expect(formatCount(0)).toBe("0");
  });

  it("has no em dash, says what Pathix cannot see, and explains the marker", () => {
    expect(XRAY_LEGEND.join(" ")).not.toContain("—");
    expect(XRAY_LEGEND.join(" ")).toContain("Writes Pathix cannot see");
    expect(XRAY_LEGEND.join(" ")).toContain("+N✦: N more writes or reads that are AI-derived (unverified)");
  });
});

describe("isXrayRequest", () => {
  const valid = {
    kind: "xray",
    organizationId: "c0de0000-0000-4000-8000-0000000000aa",
    host: "contoso.crm.dynamics.com",
    table: "account",
    columns: ["name", "creditlimit"],
  };

  it("accepts logical names and the org id", () => {
    expect(isXrayRequest(valid)).toBe(true);
  });

  it.each([
    ["a column that is not a logical name", { ...valid, columns: ["name", "Credit Limit"] }],
    ["an extra key", { ...valid, recordId: "x" }],
    ["too many columns", { ...valid, columns: Array.from({ length: 501 }, () => "name") }],
  ])("rejects %s", (_label, value) => {
    expect(isXrayRequest(value)).toBe(false);
  });
});

describe("ResponseCache", () => {
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

  it("serves a repeat read from memory", async () => {
    const get = vi.fn(async () => ok([1]));
    const cached = new ResponseCache(60_000).wrap(get as unknown as Get, "scan-1");
    await cached("/a");
    expect(await cached("/a")).toEqual(ok([1]));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("never serves one scan's answer for another", async () => {
    const cache = new ResponseCache(60_000);
    const get = vi.fn(async () => ok([1]));
    await cache.wrap(get as unknown as Get, "scan-1")("/a");
    await cache.wrap(get as unknown as Get, "scan-2")("/a");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not keep failures", async () => {
    const get = vi.fn(async () => ({ ok: false as const, kind: "failed" as const, message: "boom" }));
    const cached = new ResponseCache(60_000).wrap(get as unknown as Get, "s");
    await cached("/a");
    await cached("/a");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("expires entries after the TTL", async () => {
    let now = 0;
    const get = vi.fn(async () => ok(1));
    const cached = new ResponseCache(1_000, () => now).wrap(get as unknown as Get, "s");
    await cached("/a");
    now = 1_001;
    await cached("/a");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("shares one call between concurrent reads of the same path", async () => {
    const get = vi.fn(async () => ok(1));
    const cached = new ResponseCache(60_000).wrap(get as unknown as Get, "s");
    await Promise.all([cached("/a"), cached("/a"), cached("/a")]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("never keeps an answer that was in flight when it was cleared", async () => {
    const cache = new ResponseCache(60_000);
    let release!: (value: ApiResult<number>) => void;
    const get = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ApiResult<number>>((resolve) => (release = resolve)))
      .mockImplementation(async () => ok(2));
    const cached = cache.wrap(get as unknown as Get, "s");

    const before = cached("/a");
    cache.clear();
    release(ok(1));
    expect(await before).toEqual(ok(1));

    expect(await cached("/a")).toEqual(ok(2));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not let a read after clear share a read from before it", async () => {
    const cache = new ResponseCache(60_000);
    let release!: (value: ApiResult<number>) => void;
    const get = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ApiResult<number>>((resolve) => (release = resolve)))
      .mockImplementation(async () => ok(2));
    const cached = cache.wrap(get as unknown as Get, "s");

    const before = cached("/a");
    cache.clear();
    const after = cached("/a");
    release(ok(1));
    expect(await before).toEqual(ok(1));
    expect(await after).toEqual(ok(2));

    // The newer answer is the one kept, and the older one finishing did not drop it.
    expect(await cached("/a")).toEqual(ok(2));
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("mapWithLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("a coverage warning on the readers", () => {
  it("writes R as a minimum, in text, and the legend says what the marker means", () => {
    const entry = buildXrayEntry("name", [], { results: [{ componentId: "r", componentType: "SavedQuery", confidence: "Declared" }], coverageWarning: "Some reads were not seen." }, 0);
    expect(entry.readersMinimum).toBe(true);
    expect(lineText(entry)).toBe("W: 0  R: ≥1  F: 0  Finding 0");
    expect(XRAY_LEGEND.some((line) => line.startsWith("≥N: at least N."))).toBe(true);
  });

  it("writes an unknown R as ? even with a warning", () => {
    const entry = { ...buildXrayEntry("name", [], null, 0), readersMinimum: true };
    expect(lineText(entry)).toBe("W: 0  R: ?  F: ?  Finding 0");
  });
});

describe("loadXray", () => {
  const context = {
    environmentId: "env-1",
    environmentName: "Contoso",
    scanCompletedAt: "2026-10-03T02:11:00Z",
    table: "account",
    columns: ["name", "creditlimit", "name"],
  };
  const complete = { findings: { status: "Completed", failedDetectorFindingTypes: [] } };
  /** Both columns in the scan, with no open findings. */
  const cleanRows: OpenFindingCounts["fields"] = [
    { subjectKey: "account.name", openCount: 0, maxOpenSeverity: null },
    { subjectKey: "account.creditlimit", openCount: 0, maxOpenSeverity: null },
  ];
  const counts = (fields: OpenFindingCounts["fields"], readiness: OpenFindingCounts["readiness"] = complete): OpenFindingCounts => ({
    fields,
    readiness,
  });

  /** Answers each Pathix read from `answers`, keyed by the path before the query; "fail" is a failed read. */
  function routes(answers: Record<string, unknown> = {}) {
    return vi.fn(async <T>(path: string) => {
      const key = path.split("?")[0]!.replace(/^\/components\/.+$/, "/components/{id}");
      const defaults: Record<string, unknown> = {
        "/findings/field-writers": [writer({})],
        "/findings/field-dependents": { results: [{ componentId: "r1", componentType: "PluginStep" }] },
        "/findings/open-counts": counts([], null),
        "/findings/field-permissions": { isSecured: false, grants: [] },
        "/findings/security-writers": { scopeBreakdown: { totalPrincipals: 0 }, tableResolved: false, withheldPrincipalCount: 0 },
        "/components/{id}": { registration: null },
        "/changes/field": { historySince: null, totalCount: 0, entries: [] },
      };
      const data = key in answers ? answers[key] : defaults[key];
      return data === "fail" ? { ok: false as const, kind: "failed" as const, message: "boom" } : { ok: true as const, data: data as T };
    });
  }
  const pathsOf = (get: ReturnType<typeof routes>) => get.mock.calls.map((call) => (call as unknown as [string])[0]);

  it("reads each distinct column's writers and dependents once, and the findings in one batch", async () => {
    const get = routes();
    const response = await loadXray(context, get as unknown as Get, () => "Oct 3");
    expect(pathsOf(get)).toEqual([
      "/findings/field-writers?table=account&column=name&environmentId=env-1",
      "/findings/field-writers?table=account&column=creditlimit&environmentId=env-1",
      "/findings/field-dependents?table=account&column=name&environmentId=env-1",
      "/findings/field-dependents?table=account&column=creditlimit&environmentId=env-1",
      "/findings/open-counts?environmentId=env-1&fieldKey=account.name&fieldKey=account.creditlimit",
    ]);
    expect(response).toMatchObject({
      kind: "xray",
      model: { scopeLine: "Contoso, Completed scan of Oct 3", entries: [{ column: "name" }, { column: "creditlimit" }] },
    });
  });

  it("asks for the same paths as the hover card, so the two share the cache", async () => {
    const get = routes();
    await loadXray({ ...context, columns: ["name"] }, get as unknown as Get, () => "");
    const card = routes();
    await loadFieldCard({ ...context, column: "name", pathixUrl: "https://p" }, card as unknown as Get, () => "", () => "");
    const cardPaths = card.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(cardPaths).toContain(pathsOf(get)[0]);
    expect(cardPaths).toContain(pathsOf(get)[1]);
  });

  it("shares the one limit: never more than four reads in flight, across all three kinds", async () => {
    let running = 0;
    let peak = 0;
    const answer = routes();
    const get: Get = async <T>(path: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return (answer as unknown as Get)<T>(path);
    };
    const columns = Array.from({ length: 30 }, (_, i) => `col${i}`);
    await loadXray({ ...context, columns }, get, () => "");
    expect(peak).toBe(4);
  });

  it("batches the findings reads, fifty columns to a call", async () => {
    const get = routes();
    const columns = Array.from({ length: FINDINGS_BATCH + 1 }, (_, i) => `col${i}`);
    await loadXray({ ...context, columns }, get as unknown as Get, () => "");
    const batches = pathsOf(get).filter((path) => path.startsWith("/findings/open-counts"));
    expect(batches).toHaveLength(2);
    expect(batches[0]!.match(/fieldKey=/g)).toHaveLength(FINDINGS_BATCH);
    expect(batches[1]).toBe("/findings/open-counts?environmentId=env-1&fieldKey=account.col50");
  });

  it("fills each line from its own column's answers", async () => {
    const get: Get = async <T>(path: string) => {
      const column = /column=(\w+)/.exec(path)?.[1];
      let data: unknown;
      if (path.startsWith("/findings/field-writers")) {
        data = column === "name" ? [writer({ componentId: "a" }), writer({ componentId: "f", componentType: "Form", isHumanDriven: true })] : [];
      } else if (path.startsWith("/findings/field-dependents")) {
        data = { results: column === "name" ? [{ componentId: "f", componentType: "Form" }, { componentId: "ro", componentType: "Form" }] : [{ componentId: "r", componentType: "SavedQuery" }] };
      } else {
        data = counts([
          { subjectKey: "account.name", openCount: 0, maxOpenSeverity: null },
          { subjectKey: "account.creditlimit", openCount: "2", maxOpenSeverity: "High" },
        ]);
      }
      return { ok: true, data: data as T };
    };
    const response = await loadXray(context, get, () => "");
    expect(response.kind === "xray" && response.model.entries).toEqual([
      { column: "name", writers: 1, aiWriters: 0, readers: 0, aiReaders: 0, forms: 2, findings: 0 },
      { column: "creditlimit", writers: 0, aiWriters: 0, readers: 1, aiReaders: 0, forms: 0, findings: 2 },
    ]);
  });

  it("marks only the count that failed, as unknown", async () => {
    const get: Get = async <T>(path: string) =>
      path.includes("field-dependents") && path.includes("creditlimit")
        ? { ok: false, kind: "failed", message: "boom" }
        : ({ ok: true, data: (path.includes("open-counts") ? counts(cleanRows) : path.includes("field-dependents") ? { results: [] } : []) as unknown as T } as ApiResult<T>);
    const response = await loadXray(context, get, () => "");
    expect(response.kind === "xray" && response.model.entries.map((entry) => entry.readers)).toEqual([0, null]);
  });

  it("shows findings as unknown when that read failed, never zero", async () => {
    const response = await loadXray(context, routes({ "/findings/open-counts": "fail" }) as unknown as Get, () => "");
    expect(response.kind === "xray" && response.model.entries.map((entry) => entry.findings)).toEqual([null, null]);
  });

  it("shows zero findings only when every finding type was computed", async () => {
    const computing = counts(cleanRows, { findings: { status: "Running", failedDetectorFindingTypes: [] } });
    const response = await loadXray(context, routes({ "/findings/open-counts": computing }) as unknown as Get, () => "");
    expect(response.kind === "xray" && response.model.entries.map((entry) => entry.findings)).toEqual([null, null]);
    const done = await loadXray(context, routes({ "/findings/open-counts": counts(cleanRows) }) as unknown as Get, () => "");
    expect(done.kind === "xray" && done.model.entries.map((entry) => entry.findings)).toEqual([0, 0]);
  });

  // H1/H2: Pathix leaves a column out of open-counts when its latest scan does
  // not hold it, and an older Pathix answers [] for its writers and
  // dependents. That is not zero.
  it("writes ? for every count of a column the open counts leave out of a Completed sweep", async () => {
    const onlyName = counts([{ subjectKey: "account.name", openCount: 0, maxOpenSeverity: null }]);
    const response = await loadXray(context, routes({ "/findings/open-counts": onlyName }) as unknown as Get, () => "");
    const entries = response.kind === "xray" ? response.model.entries : [];
    expect(entries[1]).toEqual({ column: "creditlimit", writers: null, aiWriters: null, readers: null, aiReaders: null, forms: null, findings: null, notInScan: true });
    expect(lineText(entries[1]!)).toBe("W: ?  R: ?  F: ?  Finding ?");
    expect(entries[0]!.notInScan).toBeUndefined();
  });

  // The writers and dependents reads refuse a column the scan does not hold, even when the open counts list it.
  it.each(["/findings/field-writers", "/findings/field-dependents"])("writes ? for every count of a column whose %s read answered the typed 404", async (route) => {
    const typed = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404, detail: "Column account.creditlimit is not in the latest scan." };
    const miss = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404 };
    const answering = (answer: unknown) => {
      const others = routes({ "/findings/open-counts": counts(cleanRows) }) as unknown as Get;
      return vi.fn(async <T>(path: string) => (path.startsWith(`${route}?`) && path.includes("column=creditlimit") ? answer : others<T>(path)));
    };
    const refused = await loadXray(context, answering(typed) as unknown as Get, () => "");
    const entries = refused.kind === "xray" ? refused.model.entries : [];
    expect(entries[1]).toEqual({ column: "creditlimit", writers: null, aiWriters: null, readers: null, aiReaders: null, forms: null, findings: null, notInScan: true });
    expect(entries[0]!.notInScan).toBeUndefined();
    // A 404 with no body is a route miss: that count is unknown, and the column is not called unscanned.
    const older = await loadXray(context, answering(miss) as unknown as Get, () => "");
    const olderEntries = older.kind === "xray" ? older.model.entries : [];
    expect(olderEntries[1]!.notInScan).toBeUndefined();
    expect(olderEntries[1]!.findings).toBe(0);
  });

  it("writes ? for every column of a table the environment's scans leave out", async () => {
    const response = await loadXray({ ...context, tableExcluded: true }, routes({ "/findings/open-counts": counts(cleanRows) }) as unknown as Get, () => "");
    expect(response.kind === "xray" && response.model.entries.map(lineText)).toEqual(["W: ?  R: ?  F: ?  Finding ?", "W: ?  R: ?  F: ?  Finding ?"]);
  });

  // Review round 1: omission follows the latest Completed scan's columns, not the findings sweep.
  it.each(["NotStarted", "Running", "Failed"])("writes ? for a column the open counts leave out while the sweep is %s", async (status) => {
    const readiness = { findings: { status, failedDetectorFindingTypes: [] } };
    const onlyName = counts([{ subjectKey: "account.name", openCount: 0, maxOpenSeverity: null }], readiness);
    const response = await loadXray(context, routes({ "/findings/open-counts": onlyName }) as unknown as Get, () => "");
    const entries = response.kind === "xray" ? response.model.entries : [];
    expect(entries.map(lineText)).toEqual(["W: 1  R: 1  F: 0  Finding ?", "W: ?  R: ?  F: ?  Finding ?"]);
  });

  it("does not take an omitted column as not scanned with no Completed scan, or from a Pathix older than readiness", async () => {
    for (const answer of [counts([], null), { fields: [] }]) {
      const response = await loadXray(context, routes({ "/findings/open-counts": answer }) as unknown as Get, () => "");
      const entries = response.kind === "xray" ? response.model.entries : [];
      expect(entries.map((entry) => [entry.writers, entry.findings, entry.notInScan])).toEqual([
        [1, null, undefined],
        [1, null, undefined],
      ]);
    }
  });

  it("returns the sign-in status instead of a half-drawn X-ray", async () => {
    const get: Get = async () => ({ ok: false, kind: "unauthorized", status: 403 });
    expect(await loadXray(context, get, () => "")).toEqual({ kind: "status", status: { kind: "unauthorized", status: 403 } });
  });
});
