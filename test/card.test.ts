import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Get } from "../src/background/connection";
import { loadFieldCard } from "../src/background/field-card";
import {
  buildFieldCard,
  componentKind,
  componentTypeLabel,
  minimumText,
  NOT_IN_SCAN,
  openCountFor,
  writerCountOf,
  confidenceLabel,
  openInPathixUrl,
  orderWriters,
  rowsNeedingRegistration,
  triggerLabel,
  type CardListItem,
  type CardRow,
  type FieldCardContext,
  type FieldCardInputs,
} from "../src/card/model";
import { contrastLine } from "../src/card/lite";
import { controlNameFromDataId, findFieldTarget, isEditableTarget } from "../src/content/field-target";
import type { ComponentRegistration, FieldHistory, FieldPermissions, FieldWriter, SecurityWritersSummary } from "../src/pathix/api";
import { isFieldCardRequest } from "../src/runtime/messages";

const context: FieldCardContext = {
  pathixUrl: "https://pathix.contoso.com",
  environmentId: "env-1",
  environmentName: "Contoso",
  scanCompletedAt: "2026-10-03T02:30:00Z",
  table: "account",
  column: "name",
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

const noHistory: FieldHistory = { historySince: "2026-08-12T09:00:00Z", totalCount: 0, entries: [] };
const unsecured: FieldPermissions = { isSecured: false, grants: [] };
const security: SecurityWritersSummary = { scopeBreakdown: { totalPrincipals: 30 }, tableResolved: true, withheldPrincipalCount: 0 };

function inputs(overrides: Partial<FieldCardInputs> = {}): FieldCardInputs {
  return {
    writers: [],
    dependents: { results: [] },
    permissions: unsecured,
    security,
    findings: null,
    history: noHistory,
    registrations: new Map(),
    ...overrides,
  };
}

// account.name on a test environment, as Pathix returned it on 2026-10-02.
const accountName: FieldWriter[] = [
  writer({ componentId: "f1", componentName: "Information", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "f2", componentName: "Account", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "f3", componentName: "Account Reference Panel", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "f4", componentName: "Account Quick Create", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "f5", componentName: "account card", componentType: "Form", isHumanDriven: true, confidence: "Declared" }),
  writer({ componentId: "ca", componentName: "cr1ff_creditlimittestapp_e5e04", componentType: "CanvasApp" }),
  writer({ componentId: "wf", componentName: "Account - On Create - Set Fields", componentType: "ClassicWorkflow", isConditional: true }),
];

function rowText(row: CardListItem): string {
  if (row.type === "forms") return `${row.count} forms: ${row.names.join(", ")}`;
  return `${row.kind} ${row.name}${row.microsoft ? " (microsoft)" : ""}`;
}
function writerRows(rows: CardListItem[]): CardRow[] {
  return rows.filter((row): row is CardRow => row.type === "writer");
}

describe("buildFieldCard: the face of the card", () => {
  it("counts writers, readers and conditional the way the Pathix UI does", () => {
    const card = buildFieldCard(context, inputs({ writers: accountName, dependents: { results: Array.from({ length: 13 }, (_, i) => ({ componentId: `r${i}`, componentType: "PluginStep", confidence: "Parsed" })) } }));
    expect(card.stats).toEqual([
      { label: "writers", value: 7 },
      { label: "readers", value: 13 },
      { label: "conditional", value: 1, qualifier: true },
    ]);
  });

  it("lists logic first, then the customer forms as one row", () => {
    const card = buildFieldCard(context, inputs({ writers: accountName }));
    expect(card.rows.map(rowText)).toEqual([
      "WF Account - On Create - Set Fields",
      "CA cr1ff_creditlimittestapp_e5e04",
      "5 forms: Account, account card, Account Quick Create, Account Reference Panel, Information",
    ]);
    expect(card.moreCount).toBe(0);
  });

  it("caps the listed writers at six, the forms row aside, and counts the rest", () => {
    const logic = Array.from({ length: 9 }, (_, i) => writer({ componentId: `p${i}`, componentName: `Step ${i}` }));
    const card = buildFieldCard(context, inputs({ writers: [...logic, ...accountName.filter((w) => w.isHumanDriven)] }));
    expect(card.rows.filter((row) => row.type === "writer")).toHaveLength(6);
    expect(card.rows.at(-1)).toMatchObject({ type: "forms", count: 5 });
    expect(card.moreCount).toBe(3);
  });

  it("puts Microsoft components after the forms and tags them", () => {
    const rows = buildFieldCard(
      context,
      inputs({
        writers: [
          writer({ componentId: "m", componentName: "A system step", isSystem: true }),
          writer({ componentId: "z", componentName: "Z customer" }),
          writer({ componentId: "f", componentName: "Main", componentType: "Form", isHumanDriven: true }),
        ],
      }),
    ).rows;
    expect(rows.map(rowText)).toEqual(["PLG Z customer", "1 forms: Main", "PLG A system step (microsoft)"]);
  });

  it("folds a writer Pathix marks Microsoft-shipped whatever its type, such as a provisioned attribute map", () => {
    // Pathix's Microsoft-provisioned catalog marks unmanaged default-publisher
    // attribute maps isSystem. The card follows the flag and never reads the signal.
    const rows = buildFieldCard(
      context,
      inputs({
        writers: [
          writer({ componentId: "map", componentName: "account to contact", componentType: "AttributeMapping", isSystem: true }),
          writer({ componentId: "z", componentName: "Z customer" }),
        ],
      }),
    ).rows;
    expect(rows.map(rowText)).toEqual(["PLG Z customer", "ATT account to contact (microsoft)"]);
  });

  it("uses the Deterministic / AI-derived vocabulary, not Declared or Parsed", () => {
    const rows = writerRows(buildFieldCard(context, inputs({ writers: [writer({ componentId: "a", confidence: "Declared" }), writer({ componentId: "b", confidence: "AiDerived" }), writer({ componentId: "c", confidence: "Unresolved" })] })).rows);
    expect(rows.map((row) => [row.confidence, row.confidenceLabel])).toEqual([
      ["deterministic", "Deterministic"],
      ["aiDerived", "AI-derived (unverified)"],
      ["other", "Unresolved"],
    ]);
    expect(confidenceLabel("Parsed")).toBe("Deterministic");
  });

  it("shows each logic row's trigger", () => {
    const registrations = new Map<string, ComponentRegistration | null>([
      ["wf", { message: "Create", stage: null, executionMode: "Asynchronous", primaryEntity: "account" }],
      ["ca", null],
    ]);
    const rows = writerRows(buildFieldCard(context, inputs({ writers: accountName, registrations })).rows);
    expect(rows.map((row) => row.trigger)).toEqual(["On Create · Async", null]);
  });

  it("dates the card with the scan it comes from", () => {
    expect(buildFieldCard(context, inputs()).asOf).toBe("As of Oct 2, 2026, 10:30 PM");
    expect(buildFieldCard({ ...context, scanCompletedAt: null }, inputs()).asOf).toBeNull();
  });

  it("says nothing about column security unless the column is secured", () => {
    expect(buildFieldCard(context, inputs()).secured).toBe(false);
    expect(buildFieldCard(context, inputs()).info.join(" ")).not.toMatch(/secured/i);
    const secured: FieldPermissions = { isSecured: true, grants: [{ profileId: "5c4a0000-0000-4000-8000-000000000205", profileName: "Credit team", canUpdate: true, userCount: 3, teamCount: 0 }] };
    const card = buildFieldCard(context, inputs({ permissions: secured }));
    expect(card.secured).toBe(true);
    expect(card.info).toContain("Column-secured: Credit team and system administrators can update it. Records can still share the column.");
    const none = buildFieldCard(context, inputs({ permissions: { isSecured: true, grants: [] } }));
    expect(none.info).toContain("Column-secured: no column security profile grants update. Records can still share the column.");
    expect(none.info.join(" ")).not.toMatch(/only system administrators/i);
  });

  it("shows a dash, not zero, for a count it could not load", () => {
    const card = buildFieldCard(context, inputs({ writers: null, dependents: null }));
    expect(card.stats.map((stat) => stat.value)).toEqual([null, null, null]);
    expect(card.emptyLine).toBe("Could not load the writers.");
  });

  it("keeps an empty answer short on the face, with the caveat behind the ?", () => {
    const card = buildFieldCard(context, inputs({ writers: [] }));
    expect(card.emptyLine).toBe("No writers found in this scan.");
    expect(card.info).toContain("Writes Pathix cannot see, such as external integrations, are not included.");
  });

  it("puts the scope and who can edit behind the ?", () => {
    expect(buildFieldCard(context, inputs()).info.slice(0, 2)).toEqual([
      "Contoso, Completed scan of Oct 2, 2026, 10:30 PM",
      "30 principals hold Create or Write on account through their roles.",
    ]);
  });

  it("keeps the three empty answers about roles apart", () => {
    const withheld = { scopeBreakdown: { totalPrincipals: 0 }, tableResolved: true, withheldPrincipalCount: 5 };
    const zero = { scopeBreakdown: { totalPrincipals: 0 }, tableResolved: true, withheldPrincipalCount: 0 };
    const unmeasured = { ...security, tableResolved: false };
    expect(buildFieldCard(context, inputs({ security: withheld })).info[1]).toMatch(/withheld from you/);
    expect(buildFieldCard(context, inputs({ security: zero })).info[1]).toMatch(/shared individually/);
    expect(buildFieldCard(context, inputs({ security: unmeasured })).info[1]).toBe(
      "Writes Pathix cannot see, such as external integrations, are not included.",
    );
  });

  // totalPrincipals counts holders, not roles: a role nobody holds still grants Write.
  it("says no principal holds Create or Write through a role, never that no role grants it", () => {
    const zero = { scopeBreakdown: { totalPrincipals: 0 }, tableResolved: true, withheldPrincipalCount: 0 };
    const line = buildFieldCard(context, inputs({ security: zero })).info[1]!;
    expect(line).toBe("Pathix found no principal that holds Create or Write on account through a role. A record can still be shared individually.");
    expect(line).not.toMatch(/No role grants/);
  });

  it("shows Pathix's coverage notes on the role answer verbatim, after one line of the extension's own", () => {
    // Pathix's text is its own: an em dash in it, or a customer team's name, is kept as written.
    const teamNote = "Rows reached through the team Sales \u2014 West come from a Microsoft Entra group.";
    const noted = {
      ...security,
      coverageNotes: ["Direct and team-mediated grants are never truncated \u2014 only inherited rows are.", teamNote, "  "],
    };
    const info = buildFieldCard(context, inputs({ security: noted })).info;
    expect(info.slice(1, 5)).toEqual([
      "30 principals hold Create or Write on account through their roles.",
      "Pathix notes about this count:",
      "Direct and team-mediated grants are never truncated \u2014 only inherited rows are.",
      teamNote,
    ]);
  });

  it("adds no note lines when Pathix gives none, or an older Pathix leaves the field out", () => {
    expect(buildFieldCard(context, inputs({ security: { ...security, coverageNotes: [] } })).info).not.toContain("Pathix notes about this count:");
    expect(buildFieldCard(context, inputs({ security: { ...security, coverageNotes: ["  "] } })).info).not.toContain("Pathix notes about this count:");
    expect(buildFieldCard(context, inputs({ security })).info).not.toContain("Pathix notes about this count:");
  });

  it("links to the column in Pathix", () => {
    expect(buildFieldCard(context, inputs()).openUrl).toBe(
      "https://pathix.contoso.com/investigate?table=account&column=name&env=env-1",
    );
    expect(openInPathixUrl({ ...context, column: "new_a&b" })).toContain("column=new_a%26b");
  });
});

describe("buildFieldCard: findings", () => {
  const complete = { findings: { status: "Completed", failedDetectorFindingTypes: [] } };
  const counts = (openCount: number | string, maxOpenSeverity: string | null, readiness: unknown = complete) =>
    ({ fields: [{ subjectKey: "account.name", openCount, maxOpenSeverity }], readiness }) as FieldCardInputs["findings"];

  it("shows the highest open severity and the count, linking to the findings tab, whose address still says signals", () => {
    expect(buildFieldCard(context, inputs({ findings: counts(2, "Medium") })).findings).toEqual({
      openCount: 2,
      severity: "Medium",
      href: "https://pathix.contoso.com/investigate?table=account&column=name&env=env-1&tab=signals",
    });
  });

  it("reads a count that arrives as a string", () => {
    expect(buildFieldCard(context, inputs({ findings: counts("1", "High") })).findings?.openCount).toBe(1);
  });

  it("says no open findings only when every finding type was computed", () => {
    expect(buildFieldCard(context, inputs({ findings: counts(0, null) })).findings).toMatchObject({ openCount: 0, severity: null });
    const computing = { findings: { status: "Running", failedDetectorFindingTypes: [] } };
    const failedRule = { findings: { status: "Completed", failedDetectorFindingTypes: ["DuplicateStepRegistration"] } };
    expect(buildFieldCard(context, inputs({ findings: counts(0, null, computing) })).findings).toBeNull();
    expect(buildFieldCard(context, inputs({ findings: counts(0, null, failedRule) })).findings).toBeNull();
  });

  it("still shows a positive count while the sweep is incomplete", () => {
    const computing = { findings: { status: "Running", failedDetectorFindingTypes: [] } };
    expect(buildFieldCard(context, inputs({ findings: counts(3, "High", computing) })).findings?.openCount).toBe(3);
  });

  it("shows nothing when the read failed", () => {
    expect(buildFieldCard(context, inputs({ findings: null })).findings).toBeNull();
  });

  // H1: OpenFindingCountsResponse leaves out a column the latest scan does not
  // hold, and a null readiness means no Completed scan. Neither is a zero.
  it("shows nothing when there is no Completed scan, or for a count that is not a number", () => {
    expect(buildFieldCard(context, inputs({ findings: counts(0, null, null) })).findings).toBeNull();
    expect(buildFieldCard(context, inputs({ findings: counts(2, "High", null) })).findings).toBeNull();
    for (const bad of ["", "two", "1.5", "-1", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildFieldCard(context, inputs({ findings: counts(bad as number, null) })).findings).toBeNull();
    }
  });

  // Review round 1: a missing readiness key is a Pathix older than readiness, not "no Completed scan".
  // Review round 2: without readiness a measured zero cannot be told from a sweep that has not run.
  it("shows a positive count from a Pathix older than readiness, and reads its zero as unknown", () => {
    const older = (openCount: number) => ({ fields: [{ subjectKey: "account.name", openCount, maxOpenSeverity: openCount > 0 ? "High" : null }] }) as unknown as FieldCardInputs["findings"];
    expect(openCountFor(older(2), "account", "name")).toBe(2);
    expect(openCountFor(older(0), "account", "name")).toBeNull();
    expect(buildFieldCard(context, inputs({ findings: older(2) })).findings?.openCount).toBe(2);
    expect(buildFieldCard(context, inputs({ findings: older(0) })).findings).toBeNull();
    expect(openCountFor({ fields: [] } as unknown as FieldCardInputs["findings"], "account", "name")).toBeNull();
    expect(openCountFor({ fields: [{ subjectKey: "account.name", openCount: 2, maxOpenSeverity: "High" }], readiness: null }, "account", "name")).toBeNull();
  });

  it("shows nothing for a column the answer leaves out, even while the sweep runs", () => {
    const running = { findings: { status: "Running", failedDetectorFindingTypes: [] } };
    expect(openCountFor({ fields: [], readiness: running } as FieldCardInputs["findings"], "account", "name")).toBeNull();
    expect(openCountFor({ fields: [], readiness: complete } as FieldCardInputs["findings"], "account", "name")).toBeNull();
  });
});

// Item 13: field-dependents carries Pathix's own sentence about reads its scan
// could not see. The card shows it, and the readers count is a minimum.
describe("buildFieldCard: a coverage warning", () => {
  const warning = "Pathix could not read 2 views on account, so reads through them are not counted.";

  it("shows Pathix's sentence and marks the readers as a minimum", () => {
    const card = buildFieldCard(context, inputs({ dependents: { results: [{ componentId: "r1", componentType: "SavedQuery", confidence: "Declared" }], coverageWarning: warning } }));
    expect(card.coverageWarning).toBe(warning);
    expect(card.stats.find((stat) => stat.label === "readers")).toEqual({ label: "readers", value: 1, minimum: true });
    expect(card.stats.find((stat) => stat.label === "writers")?.minimum).toBeUndefined();
    expect(minimumText(1, true)).toBe("≥1");
  });

  it("shows nothing and marks nothing with no warning, or a blank one", () => {
    for (const coverageWarning of [null, undefined, "  "]) {
      const card = buildFieldCard(context, inputs({ dependents: { results: [], coverageWarning } }));
      expect(card.coverageWarning).toBeNull();
      expect(card.stats.some((stat) => stat.minimum)).toBe(false);
    }
  });
});

// H2: a current Pathix's writers and dependents reads refuse a column the
// latest scan does not hold with the typed 404. An older Pathix answers 200 []
// for them, so the card also reads the column as not in the latest scan from
// the typed permissions 404, the open counts, or the environment's excluded
// tables, and then shows no counts at all.
describe("buildFieldCard: a column not in the latest scan", () => {
  const complete = { findings: { status: "Completed", failedDetectorFindingTypes: [] } };
  const empty = { writers: [], dependents: { results: [] } };

  it.each([
    [
      "the writers or dependents read answered the typed 404",
      { scanPresence: { fieldReadsNotFound: true, permissionsNotFound: false, tableExcluded: false }, writers: null, dependents: null },
    ],
    ["the permissions read answered the typed 404", { scanPresence: { fieldReadsNotFound: false, permissionsNotFound: true, tableExcluded: false }, permissions: null }],
    ["the table is excluded from the scan", { scanPresence: { fieldReadsNotFound: false, permissionsNotFound: false, tableExcluded: true } }],
    ["the open counts leave it out of a Completed sweep", { findings: { fields: [], readiness: complete } as FieldCardInputs["findings"] }],
  ])("says so, with no counts, rows, findings or contrast, when %s", (_label, overrides) => {
    const card = buildFieldCard(context, inputs({ ...empty, ...overrides }));
    expect(card.notInScan).toBe(true);
    expect(card.stats).toEqual([]);
    expect(card.rows).toEqual([]);
    expect(card.findings).toBeNull();
    expect(card.emptyLine).toBe(NOT_IN_SCAN);
    expect(card.platformDependentCount).toBeNull();
    expect(writerCountOf(card)).toBeNull();
    expect(contrastLine(card.platformDependentCount, writerCountOf(card), card.platformCountRead)).toBeNull();
  });

  it("is an ordinary card when nothing says the column is missing", () => {
    const card = buildFieldCard(context, inputs({ ...empty, findings: { fields: [{ subjectKey: "account.name", openCount: 0, maxOpenSeverity: null }], readiness: complete } }));
    expect(card.notInScan).toBe(false);
    expect(card.stats.map((stat) => stat.value)).toEqual([0, 0, 0]);
    expect(card.emptyLine).toBe("No writers found in this scan.");
  });

  // Review round 1: Pathix leaves a column out by the latest Completed scan's
  // columns, whatever the findings sweep is doing.
  it.each(["NotStarted", "Running", "Failed"])("is decided by an omitted column while the sweep is %s", (status) => {
    const readiness = { findings: { status, failedDetectorFindingTypes: [] } };
    expect(buildFieldCard(context, inputs({ ...empty, findings: { fields: [], readiness } as FieldCardInputs["findings"] })).notInScan).toBe(true);
  });

  it("is not decided by an omitted column with no Completed scan, or from a Pathix older than readiness", () => {
    expect(buildFieldCard(context, inputs({ ...empty, findings: { fields: [], readiness: null } as FieldCardInputs["findings"] })).notInScan).toBe(false);
    expect(buildFieldCard(context, inputs({ ...empty, findings: { fields: [] } as unknown as FieldCardInputs["findings"] })).notInScan).toBe(false);
  });
});

describe("triggerLabel", () => {
  const reg = (overrides: Partial<ComponentRegistration>): ComponentRegistration => ({
    message: "Update",
    stage: null,
    executionMode: null,
    primaryEntity: "account",
    ...overrides,
  });

  it.each([
    ["a post-op async plugin step", reg({ stage: "PostOperation", executionMode: "Asynchronous" }), "On Update · Post-op · Async"],
    ["a pre-op sync plugin step", reg({ stage: "PreOperation", executionMode: "Synchronous" }), "On Update · Pre-op · Sync"],
    ["a background classic workflow", reg({ message: "Create", executionMode: "Asynchronous" }), "On Create · Async"],
    ["a flow, which has no mode", reg({ message: "Create" }), "On Create"],
    ["a trigger on another table", reg({ message: "Create", primaryEntity: "contact", executionMode: "Asynchronous" }), "On contact create · Async"],
    ["a Custom API's plugin", reg({ message: "pathix_SetCreditLimit", stage: "MainOperation", executionMode: "Synchronous", primaryEntity: null }), "Runs as pathix_SetCreditLimit · Sync"],
  ])("labels %s", (_label, registration, expected) => {
    expect(triggerLabel(registration, "account")).toBe(expected);
  });

  it("has nothing to say without a registration", () => {
    expect(triggerLabel(null, "account")).toBeNull();
    expect(triggerLabel(reg({ message: null }), "account")).toBeNull();
  });
});

describe("the column history line", () => {
  const entries = (scans: string[]) => scans.map((scanId, i) => ({ scanId, detectedAt: `2026-09-0${i + 1}T00:00:00Z` }));
  const since = "2026-08-12T12:00:00Z";
  const line = (history: FieldHistory | null) => buildFieldCard(context, inputs({ history })).history;

  it("counts the scans that found a change, since Pathix began tracking", () => {
    expect(line({ historySince: since, totalCount: 3, entries: entries(["a", "b", "c"]) })).toEqual({
      kind: "changes",
      text: "Changed 3 times since Aug 12",
      href: "https://pathix.contoso.com/investigate?table=account&column=name&env=env-1",
    });
  });

  it("counts a scan once, however many rows it recorded", () => {
    expect(line({ historySince: since, totalCount: 3, entries: entries(["a", "a", "b"]) })?.text).toBe("Changed 2 times since Aug 12");
    expect(line({ historySince: since, totalCount: 1, entries: entries(["a"]) })?.text).toBe("Changed once since Aug 12");
  });

  it("falls back to a row's detected time when it has no scan id", () => {
    const rows = [{ detectedAt: "2026-09-01T00:00:00Z" }, { scanId: null, detectedAt: "2026-09-02T00:00:00Z" }];
    expect(line({ historySince: since, totalCount: 2, entries: rows })?.text).toBe("Changed 2 times since Aug 12");
  });

  it("says at least when Pathix capped the rows it returned", () => {
    expect(line({ historySince: since, totalCount: 900, entries: entries(["a", "b"]) })?.text).toBe("Changed at least 2 times since Aug 12");
  });

  it("does not count a row from a Pathix update, only the org's own changes", () => {
    const rows = [
      { scanId: "a", detectedAt: "2026-09-01T00:00:00Z" },
      { scanId: "b", detectedAt: "2026-09-02T00:00:00Z", pathixChange: "ParserRevised" },
      { scanId: "c", detectedAt: "2026-09-03T00:00:00Z", pathixChange: "FamilyIntroduced" },
      { scanId: "c", detectedAt: "2026-09-03T00:00:00Z", pathixChange: null },
    ];
    expect(line({ historySince: since, totalCount: 4, entries: rows })?.text).toBe("Changed 2 times since Aug 12");
  });

  it("is hidden when every row came from a Pathix update, and unknown when the rest was capped", () => {
    const rows = [
      { scanId: "a", detectedAt: "2026-09-01T00:00:00Z", pathixChange: "ParserRevised" },
      { scanId: "b", detectedAt: "2026-09-02T00:00:00Z", pathixChange: "ParserRevised" },
    ];
    expect(line({ historySince: since, totalCount: 2, entries: rows })).toBeNull();
    expect(line({ historySince: since, totalCount: 900, entries: rows })).toEqual({ kind: "unknown", text: "Column history: unknown" });
  });

  it("stays a floor when Pathix capped the rows, Pathix-update rows among them", () => {
    const rows = [
      { scanId: "a", detectedAt: "2026-09-01T00:00:00Z" },
      { scanId: "b", detectedAt: "2026-09-02T00:00:00Z", pathixChange: "ParserRevised" },
    ];
    expect(line({ historySince: since, totalCount: 900, entries: rows })?.text).toBe("Changed at least once since Aug 12");
  });

  it("is hidden when Pathix has recorded no changes", () => {
    expect(line({ historySince: since, totalCount: 0, entries: [] })).toBeNull();
    expect(line({ historySince: null, totalCount: 0, entries: [] })).toBeNull();
  });

  it("is unknown, not hidden, when the read failed or the answer is malformed", () => {
    expect(line(null)).toEqual({ kind: "unknown", text: "Column history: unknown" });
    // A total with no entries to count would read "at least 0 times".
    expect(line({ historySince: since, totalCount: 5, entries: [] })).toEqual({ kind: "unknown", text: "Column history: unknown" });
    expect(line({ historySince: since } as unknown as FieldHistory)?.kind).toBe("unknown");
  });

  it("leaves out the date it cannot read, rather than inventing one", () => {
    const card = buildFieldCard({ ...context, formatDay: () => null }, inputs({ history: { historySince: since, totalCount: 1, entries: entries(["a"]) } }));
    expect(card.history?.text).toBe("Changed once");
  });

  it("explains the window behind the ?, only when the line shows", () => {
    const shown = buildFieldCard(context, inputs({ history: { historySince: since, totalCount: 1, entries: entries(["a"]) } })).info.join(" ");
    expect(shown).toContain("Change history starts when Pathix began tracking this environment.");
    expect(shown).toContain("Changes from a Pathix update are not counted");
    expect(buildFieldCard(context, inputs()).info.join(" ")).not.toContain("Change history");
    expect(buildFieldCard(context, inputs({ history: null })).info.join(" ")).not.toContain("Change history");
  });
});

describe("row order and trigger lookups", () => {
  it("only looks up a registration for a listed plugin step, or a row from an older Pathix with no triggers", () => {
    // accountName's rows come from an older Pathix: they carry no triggers field at all.
    expect(rowsNeedingRegistration(accountName).map((w) => w.componentId)).toEqual(["wf", "ca"]);
    const current = [
      writer({ componentId: "step", triggers: [] }),
      writer({ componentId: "wf", componentType: "ClassicWorkflow", triggers: [] }),
      writer({ componentId: "flow", componentType: "ModernFlow", triggers: [] }),
      writer({ componentId: "app", componentType: "CanvasApp", triggers: null }),
    ];
    expect(rowsNeedingRegistration(current).map((w) => w.componentId)).toEqual(["step"]);
  });

  it("orders by group, then confidence, then server-side first, then name", () => {
    const ordered = orderWriters([
      writer({ componentId: "js", componentName: "B script", componentType: "FormScript" }),
      writer({ componentId: "plg", componentName: "Z plugin", componentType: "PluginStep" }),
      writer({ componentId: "ai", componentName: "A guess", confidence: "AiDerived" }),
    ]);
    expect(ordered.map((w) => w.componentId)).toEqual(["plg", "js", "ai"]);
  });

  it("labels component types, including ones it has never seen", () => {
    expect(componentTypeLabel("ModernFlow")).toBe("Cloud flow");
    expect(componentTypeLabel("PortalServerLogic")).toBe("Portal server logic");
  });

  it("gives every component type in the contract a chip, a new one by falling through on purpose", () => {
    const slice = JSON.parse(readFileSync("contract/pathix-api.slice.json", "utf8")) as { components: { schemas: Record<string, { enum?: string[] }> } };
    for (const type of slice.components.schemas.ComponentType!.enum!) {
      const [kind, label] = componentKind(type);
      expect(kind.length).toBeGreaterThan(0);
      expect(label.length).toBeGreaterThan(0);
    }
    // A type added since the last slice falls through to the chip the Pathix UI draws for it.
    expect(componentKind("DuplicateDetectionRule")).toEqual(["DUP", "Duplicate detection rule"]);
  });
});

describe("loadFieldCard", () => {
  const routes = (overrides: Record<string, unknown> = {}) =>
    vi.fn(async <T>(path: string) => {
      const key = path.split("?")[0]!.replace(/^\/components\/.+$/, "/components/{id}");
      const defaults: Record<string, unknown> = {
        "/findings/field-writers": accountName,
        "/findings/field-dependents": { results: [{ componentId: "r1", componentType: "PluginStep" }] },
        "/findings/field-permissions": unsecured,
        "/findings/security-writers": security,
        "/findings/open-counts": { fields: [], readiness: null },
        "/components/{id}": { registration: { message: "Create", stage: null, executionMode: "Asynchronous", primaryEntity: "account" } },
        "/changes/field": noHistory,
      };
      const data = key in overrides ? overrides[key] : defaults[key];
      return data === "fail" ? { ok: false as const, kind: "failed" as const, message: "boom" } : { ok: true as const, data: data as T };
    });

  const loadContext = { ...context, formatDate: undefined, formatDay: undefined } as unknown as Omit<FieldCardContext, "formatDate" | "formatDay">;
  const day = () => "Aug 12";

  it("reads the five field answers, then the history and the triggers of the listed logic rows only", async () => {
    const get = routes();
    await loadFieldCard(loadContext, get as unknown as Get, () => "d", day);
    expect(get.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      "/findings/field-writers?table=account&column=name&environmentId=env-1",
      "/findings/field-dependents?table=account&column=name&environmentId=env-1",
      "/findings/field-permissions?table=account&column=name&environmentId=env-1",
      "/findings/security-writers?table=account&environmentId=env-1",
      "/findings/open-counts?environmentId=env-1&fieldKey=account.name",
      "/changes/field?table=account&column=name&environmentId=env-1",
      "/components/wf?environmentId=env-1",
      "/components/ca?environmentId=env-1",
    ]);
  });

  it("reads a typed 404 on the permissions as not in the scan, and a route miss as a failed read", async () => {
    const typed = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404, detail: "Column account.name is not in the latest scan." };
    const miss = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404 };
    const answering = (permissions: unknown) =>
      vi.fn(async <T>(path: string) => (path.startsWith("/findings/field-permissions") ? permissions : (routes() as unknown as Get)<T>(path)));
    const notScanned = await loadFieldCard(loadContext, answering(typed) as unknown as Get, () => "d", day);
    expect(notScanned.kind === "card" && notScanned.card.notInScan).toBe(true);
    const older = await loadFieldCard(loadContext, answering(miss) as unknown as Get, () => "d", day);
    expect(older.kind === "card" && older.card.notInScan).toBe(false);
    expect(older.kind === "card" && older.card.securedKnown).toBe(false);
  });

  // field-writers and field-dependents refuse a column the scan does not hold themselves.
  it.each(["/findings/field-writers", "/findings/field-dependents"])("reads a typed 404 on %s as not in the scan, and a route miss as a failed read", async (route) => {
    const typed = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404, detail: "Column account.name is not in the latest scan." };
    const miss = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404 };
    const answering = (answer: unknown) => vi.fn(async <T>(path: string) => (path.startsWith(`${route}?`) ? answer : (routes() as unknown as Get)<T>(path)));
    const notScanned = await loadFieldCard(loadContext, answering(typed) as unknown as Get, () => "d", day);
    expect(notScanned.kind === "card" && notScanned.card.notInScan).toBe(true);
    expect(notScanned.kind === "card" && notScanned.card.emptyLine).toBe(NOT_IN_SCAN);
    // A 404 with no body is a Pathix with no such route: a failed read, unknown, never "not in the scan".
    const older = await loadFieldCard(loadContext, answering(miss) as unknown as Get, () => "d", day);
    expect(older.kind === "card" && older.card.notInScan).toBe(false);
    const label = route.endsWith("writers") ? "writers" : "readers";
    expect(older.kind === "card" && older.card.stats.find((stat) => stat.label === label)?.value).toBeNull();
  });

  it("reads a table the environment excludes as not in the scan", async () => {
    const card = await loadFieldCard({ ...loadContext, tableExcluded: true }, routes() as unknown as Get, () => "d", day);
    expect(card.kind === "card" && card.card.notInScan).toBe(true);
  });

  it("shows the history, and keeps the card whole when that read fails", async () => {
    const history = { historySince: "2026-08-12T12:00:00Z", totalCount: 1, entries: [{ scanId: "s1", detectedAt: "2026-09-01T00:00:00Z" }] };
    const ok = await loadFieldCard(loadContext, routes({ "/changes/field": history }) as unknown as Get, () => "d", day);
    expect(ok.kind === "card" && ok.card.history?.text).toBe("Changed once since Aug 12");
    for (const failure of ["fail"]) {
      const failed = await loadFieldCard(loadContext, routes({ "/changes/field": failure }) as unknown as Get, () => "d", day);
      expect(failed.kind === "card" && failed.card.history).toEqual({ kind: "unknown", text: "Column history: unknown" });
    }
  });

  it("shows unknown history, not a sign-in screen, when only that read is refused", async () => {
    const get = vi.fn(async <T>(path: string) =>
      path.startsWith("/changes/field")
        ? { ok: false as const, kind: "unauthorized" as const, status: 403 }
        : ((await (routes() as unknown as Get)<T>(path)) as { ok: true; data: T }),
    );
    const response = await loadFieldCard(loadContext, get as unknown as Get, () => "d", day);
    expect(response.kind === "card" && response.card.history?.kind).toBe("unknown");
  });

  it("keeps history inside the one limit on concurrent reads", async () => {
    let running = 0;
    let peak = 0;
    const answer = routes();
    const many = Array.from({ length: 10 }, (_, i) => writer({ componentId: `p${i}`, componentName: `Step ${i}` }));
    const get: Get = async <T>(path: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return (answer as unknown as Get)<T>(path);
    };
    await loadFieldCard(loadContext, ((p: string) => (p.startsWith("/findings/field-writers") ? Promise.resolve({ ok: true, data: many }) : get(p))) as unknown as Get, () => "d", day);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("shows a row without its trigger when that lookup fails", async () => {
    const response = await loadFieldCard(loadContext, routes({ "/components/{id}": "fail" }) as unknown as Get, () => "d", day);
    expect(response.kind === "card" && writerRows(response.card.rows)[0]!.trigger).toBeNull();
  });

  it("returns the sign-in status instead of a card when any read is signed out", async () => {
    const get: Get = async () => ({ ok: false, kind: "signedOut" });
    expect(await loadFieldCard(loadContext, get, () => "d", day)).toEqual({
      kind: "status",
      status: { kind: "signedOut", reason: "no token" },
    });
  });
});

describe("isFieldCardRequest", () => {
  const valid = {
    kind: "fieldCard",
    organizationId: "c0de0000-0000-4000-8000-000000000001",
    host: "contoso.crm.dynamics.com",
    table: "account",
    column: "creditlimit",
  };

  it("accepts logical names and the org id", () => {
    expect(isFieldCardRequest(valid)).toBe(true);
  });

  it.each([
    ["a record id", { ...valid, recordId: "11111111-2222-4333-8444-555555555555" }],
    ["a display name as the column", { ...valid, column: "Credit Limit" }],
    ["a non-GUID org", { ...valid, organizationId: "contoso" }],
  ])("rejects %s", (_label, value) => {
    expect(isFieldCardRequest(value)).toBe(false);
  });
});

describe("field targeting", () => {
  it("reads the control name from a field container's data-id", () => {
    expect(controlNameFromDataId("creditlimit-FieldSectionItemContainer")).toBe("creditlimit");
    expect(controlNameFromDataId("header_ownerid-FieldSectionItemContainer")).toBe("header_ownerid");
  });

  // As captured live: a field inside a quick view names the quick view and its inner control.
  it("reads a quick view field's dotted name whole, never its inner name alone", () => {
    expect(controlNameFromDataId("contactquickform.emailaddress1-FieldSectionItemContainer")).toBe("contactquickform.emailaddress1");
    expect(controlNameFromDataId("contactquickform.telephone1-FieldSectionItemContainer")).not.toBe("telephone1");
    expect(controlNameFromDataId("a.b.c-FieldSectionItemContainer")).toBeNull();
    expect(controlNameFromDataId(".emailaddress1-FieldSectionItemContainer")).toBeNull();
    expect(controlNameFromDataId("contactquickform.-FieldSectionItemContainer")).toBeNull();
  });

  it("ignores other data-ids and malformed names", () => {
    expect(controlNameFromDataId("creditlimit.fieldControl-currency-text-input")).toBeNull();
    expect(controlNameFromDataId("credit limit-FieldSectionItemContainer")).toBeNull();
    expect(controlNameFromDataId(null)).toBeNull();
  });

  function fakeNode(matches: Record<string, { dataId: string } | true>): Element {
    return {
      closest: (selector: string) => {
        const hit = matches[selector];
        if (!hit) return null;
        return hit === true ? ({} as Element) : ({ getAttribute: () => hit.dataId } as unknown as Element);
      },
    } as unknown as Element;
  }

  it("finds the container a node sits in", () => {
    const node = fakeNode({ '[data-id$="-FieldSectionItemContainer"]': { dataId: "name-FieldSectionItemContainer" } });
    expect(findFieldTarget(node)?.controlName).toBe("name");
    expect(findFieldTarget(fakeNode({}))).toBeNull();
  });

  it("treats inputs and buttons as the user working the field", () => {
    expect(isEditableTarget(fakeNode({}))).toBe(false);
    const editable = { closest: (selector: string) => (selector.includes("input") ? ({} as Element) : null) } as unknown as Element;
    expect(isEditableTarget(editable)).toBe(true);
  });
});
