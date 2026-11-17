// Connected parity (M9): the connected card reads Pathix for what Lite reads
// live. The dependency count, the trigger lines, a step's images and the
// "Why can't I edit" form line all come from the scan; only the signed-in
// user's own state is read live, and only on a field the form shows read-only.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Get } from "../src/background/connection";
import { loadFieldCard } from "../src/background/field-card";
import type { FormSnapshot } from "../src/bridge/messages";
import { contrastLine, PLATFORM_COUNT_UNKNOWN, PLATFORM_COUNT_UNREAD } from "../src/card/lite";
import type { LiveUserFacts } from "../src/card/locked-connected";
import { buildFieldCard, platformCountOf, type FieldCardContext, type FieldCardInputs, type FieldCardModel } from "../src/card/model";
import type { CardRow } from "../src/card/model";
import type { FieldDependents, FieldWriter, TriggerSummary } from "../src/pathix/api";

const FORM = "5c4a0000-0000-4000-8000-000000000021";

const context: FieldCardContext = {
  pathixUrl: "https://pathix.contoso.com",
  environmentId: "env-1",
  environmentName: "Contoso",
  scanCompletedAt: "2026-10-03T02:30:00Z",
  table: "account",
  column: "creditlimit",
  formatDate: () => "Oct 2",
  formatDay: () => "Aug 12",
};

function writer(overrides: Partial<FieldWriter> = {}): FieldWriter {
  return {
    componentId: "p1",
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

function trigger(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    message: "Update",
    stage: "PostOperation",
    executionMode: "Asynchronous",
    table: "account",
    filteringColumns: ["creditlimit"],
    firesOnEveryUpdate: false,
    hasRowFilter: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<FieldCardInputs> = {}): FieldCardInputs {
  return {
    writers: [],
    dependents: { results: [] },
    permissions: { isSecured: false, grants: [] },
    security: { scopeBreakdown: { totalPrincipals: 3 }, tableResolved: true, withheldPrincipalCount: 0 },
    findings: null,
    history: null,
    registrations: new Map(),
    ...overrides,
  };
}

const rowsOf = (card: FieldCardModel) => card.rows.filter((row): row is CardRow => row.type === "writer");

describe("Dataverse's dependency record count, from Pathix", () => {
  const dependents = (platformDependentCount?: number | null): FieldDependents => ({ results: [], platformDependentCount });

  it("carries the measured count", () => {
    expect(buildFieldCard(context, inputs({ dependents: dependents(12) })).platformDependentCount).toBe(12);
  });

  it("keeps a measured zero as zero", () => {
    expect(buildFieldCard(context, inputs({ dependents: dependents(0) })).platformDependentCount).toBe(0);
  });

  it.each([
    ["not measured", dependents(null)],
    ["absent, from an older Pathix", dependents(undefined)],
    ["unreadable", null],
  ])("is unknown, never zero, when it is %s", (_name, value) => {
    expect(buildFieldCard(context, inputs({ dependents: value })).platformDependentCount).toBeNull();
  });

  it("says the read failed, not that the scan lacks the count, when the dependents read failed", () => {
    expect(buildFieldCard(context, inputs({ dependents: null })).platformCountRead).toBe(false);
    expect(buildFieldCard(context, inputs({ dependents: dependents(null) })).platformCountRead).toBe(true);
    expect(contrastLine(null, 3, false)).toBe(`${PLATFORM_COUNT_UNREAD} Pathix found 3 writers.`);
    expect(contrastLine(null, 3, true)).toBe(`${PLATFORM_COUNT_UNKNOWN} Pathix found 3 writers.`);
    expect(contrastLine(null, null, false)).toBeNull();
  });

  it("does not trust a count that is not a count", () => {
    expect(platformCountOf({ results: [], platformDependentCount: -1 })).toBeNull();
    expect(platformCountOf({ results: [], platformDependentCount: "12" as unknown as number })).toBeNull();
  });

  it("makes the contrast line say so when there is no count, and never shows zero for it", () => {
    expect(contrastLine(null, 3)).toBe(`${PLATFORM_COUNT_UNKNOWN} Pathix found 3 writers.`);
    expect(contrastLine(null, 3)).not.toMatch(/\b0\b/);
    expect(contrastLine(0, 3)).toBe("Dataverse has 0 dependency records. Pathix found 3 writers.");
  });

  it("says behind the ? that the count is from the scan and can lag", () => {
    const info = buildFieldCard(context, inputs()).info.join(" ");
    expect(info).toContain("measured when Pathix scanned");
    expect(info).toContain("It can lag a change made since");
  });
});

describe("the writer rows' triggers and images", () => {
  it("shows the trigger lines from the writers row, with no registration read", () => {
    const [row] = rowsOf(buildFieldCard(context, inputs({ writers: [writer({ triggers: [trigger()] })] })));
    expect(row!.trigger).toBe("On Update · Post-op · Async");
    expect(row!.triggers).toEqual([{ label: "On Update · Post-op · Async", scope: "Fires when creditlimit changes", rowFilter: null }]);
    expect(row!.moreTriggers).toBe(0);
  });

  it("carries a plugin step's images from its registration", () => {
    const registrations = new Map([
      ["p1", { message: "Update", stage: null, executionMode: null, primaryEntity: "account", images: [{ imageType: "Pre", name: "PreImage", entityAlias: "PreImage", columns: [] }] }],
    ]);
    const [row] = rowsOf(buildFieldCard(context, inputs({ writers: [writer({ triggers: [trigger()] })], registrations })));
    expect(row!.images).toEqual({ kind: "list", lines: [{ text: "Pre-image PreImage · all columns" }] });
  });

  it("shows a step's images as unknown, not absent, when its registration could not be read", () => {
    const [row] = rowsOf(buildFieldCard(context, inputs({ writers: [writer({ triggers: [trigger()] })] })));
    expect(row!.images).toEqual({ kind: "unknown" });
  });

  it("has no trigger and no images for a form, which a person starts", () => {
    const rows = buildFieldCard(context, inputs({ writers: [writer({ componentId: "f", componentType: "Form", isHumanDriven: true, triggers: null })] })).rows;
    expect(rows.every((row) => row.type === "forms")).toBe(true);
  });

  it("explains the lines behind the ?", () => {
    const info = buildFieldCard(context, inputs()).info.join(" ");
    expect(info).toContain('"Fires on every update" means a step or flow update has none');
    expect(info).toContain("the filter itself is never read");
  });
});

describe("loadFieldCard against a current Pathix", () => {
  const loadContext = { ...context, formatDate: undefined, formatDay: undefined } as unknown as Omit<FieldCardContext, "formatDate" | "formatDay">;
  const writers = [
    writer({ componentId: "step", triggers: [trigger()] }),
    writer({ componentId: "wf", componentName: "Set fields", componentType: "ClassicWorkflow", triggers: [trigger({ message: "Create", filteringColumns: [] })] }),
    writer({ componentId: "flow", componentName: "Sync", componentType: "ModernFlow", triggers: [trigger({ stage: null, executionMode: null, hasRowFilter: true })] }),
  ];

  const routes = (extra: Record<string, unknown> = {}) =>
    vi.fn(async <T>(path: string) => {
      const key = path.split("?")[0]!.replace(/^\/components\/.+$/, "/components/{id}");
      const defaults: Record<string, unknown> = {
        "/findings/field-writers": writers,
        "/findings/field-dependents": { results: [], coverageWarning: null, platformDependentCount: 7 },
        "/findings/field-permissions": { isSecured: false, grants: [] },
        "/findings/security-writers": { scopeBreakdown: { totalPrincipals: 1 }, tableResolved: true, withheldPrincipalCount: 0 },
        "/findings/open-counts": { fields: [], readiness: null },
        "/components/{id}": {
          registration: { message: "Update", stage: "PostOperation", executionMode: "Asynchronous", primaryEntity: "account", images: [{ imageType: "Post", name: "After", entityAlias: null, columns: ["creditlimit"] }] },
        },
        "/changes/field": { historySince: null, totalCount: 0, entries: [] },
      };
      const data = key in extra ? extra[key] : defaults[key];
      return data === "fail" ? { ok: false as const, kind: "failed" as const, message: "boom" } : { ok: true as const, data: data as T };
    });

  it("reads a registration only for the plugin step, whose images are served only there", async () => {
    const get = routes();
    await loadFieldCard(loadContext, get as unknown as Get, () => "d", () => "Aug 12");
    const asked = get.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(asked.filter((path) => path.startsWith("/components/"))).toEqual(["/components/step?environmentId=env-1"]);
  });

  it("builds the card from the rows' triggers, the step's images and Pathix's dependency count", async () => {
    const response = await loadFieldCard(loadContext, routes() as unknown as Get, () => "d", () => "Aug 12");
    if (response.kind !== "card") throw new Error("no card");
    const [step, workflow, flow] = rowsOf(response.card);
    expect(step!.triggers[0]).toMatchObject({ scope: "Fires when creditlimit changes" });
    expect(step!.images).toEqual({ kind: "list", lines: [{ text: "Post-image After · this column only" }] });
    expect(workflow!.triggers[0]).toMatchObject({ label: "On Create · Post-op · Async", scope: null });
    expect(flow!.triggers[0]).toMatchObject({ rowFilter: "Row filter set" });
    expect(response.card.platformDependentCount).toBe(7);
  });

  it("shows the step's images as unknown when its registration read fails, and keeps the trigger", async () => {
    const response = await loadFieldCard(loadContext, routes({ "/components/{id}": "fail" }) as unknown as Get, () => "d", () => "Aug 12");
    if (response.kind !== "card") throw new Error("no card");
    const [step] = rowsOf(response.card);
    expect(step!.images).toEqual({ kind: "unknown" });
    expect(step!.trigger).toBe("On Update · Post-op · Async");
  });

  it("serves the dependents' forms and the column's security for the checklist", async () => {
    const forms = {
      results: [
        {
          componentId: "frm",
          componentName: "Account",
          componentType: "Form",
          confidence: "Declared",
          referenceKind: "Display",
          sourceId: FORM,
          formControls: [{ controlId: "creditlimit", locked: true, hidden: false, location: "body", embed: null }],
        },
      ],
      coverageWarning: null,
      platformDependentCount: 7,
    };
    const response = await loadFieldCard(loadContext, routes({ "/findings/field-dependents": forms }) as unknown as Get, () => "d", () => "Aug 12");
    if (response.kind !== "card") throw new Error("no card");
    expect(response.card.locked.forms).toEqual([{ formId: FORM, name: "Account", controls: forms.results[0]!.formControls }]);
    expect(response.card.locked.security).toEqual({ secured: false, updateProfiles: [], sharedWith: null, sharingIncomplete: false });
    // It crosses the worker boundary as JSON.
    expect(JSON.parse(JSON.stringify(response.card.locked))).toEqual(response.card.locked);
  });

  it("makes no read of Dataverse: the worker only calls Pathix", async () => {
    const get = routes();
    await loadFieldCard(loadContext, get as unknown as Get, () => "d", () => "Aug 12");
    expect(get.mock.calls.every((call) => (call as unknown as [string])[0].startsWith("/"))).toBe(true);
  });
});

describe("the hover card, connected", async () => {
  const { HoverController } = await import("../src/content/hover-controller");
  const container = { getBoundingClientRect: () => ({}), querySelector: () => null } as unknown as Element;
  const settle = () => new Promise((done) => setTimeout(done, 0));
  beforeAll(() => void vi.stubGlobal("window", { setTimeout, clearTimeout }));
  afterAll(() => void vi.unstubAllGlobals());

  const card = buildFieldCard(
    context,
    inputs({
      writers: [writer({ triggers: [trigger()] })],
      dependents: {
        results: [
          {
            componentId: "frm",
            componentName: "Account",
            componentType: "Form",
            confidence: "Declared",
            referenceKind: "Display",
            sourceId: FORM,
            formControls: [
              { controlId: "creditlimit", locked: true, hidden: false, location: "body", embed: null },
              // Live formxml repeats the id for a second copy; the page names it "creditlimit1".
              { controlId: "creditlimit", locked: false, hidden: false, location: "body", embed: null },
            ],
          },
        ],
        platformDependentCount: 12,
      },
    }),
  );

  const user: LiveUserFacts = {
    writePrivilege: { kind: "ok", value: "prvWriteAccount" },
    privileges: { kind: "ok", value: { RolePrivileges: [{ PrivilegeName: "prvWriteAccount", Depth: "Global", RecordFilterId: "00000000-0000-0000-0000-000000000000" }] } },
    teamPrivileges: { kind: "ok", value: { teamCount: 0, depths: [] } },
    mine: { kind: "ok", value: [] },
    team: { kind: "ok", value: { teamCount: 0, profileIds: [] } },
  };

  function harness(
    locked: string[],
    userSecurity: () => Promise<LiveUserFacts>,
    control = "creditlimit",
    answer: () => Promise<unknown> = async () => ({ kind: "card" as const, card }),
    userReadTimeoutMs?: number,
  ) {
    const snapshot = {
      organizationId: "5c4a0000-0000-4000-8000-000000000003",
      host: "contoso.crm.dynamics.com",
      table: "account",
      formId: FORM,
      columns: [{ control, column: "creditlimit" }],
      dirtyColumns: [],
      lockedControls: locked,
    } as unknown as FormSnapshot;
    const shown: Array<{ contrast: string | null; locked: unknown }> = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      setOnOpenOptions: () => undefined,
      takeFocus: () => undefined,
      hasFocus: false,
      showMessage: () => undefined,
      showState: () => undefined,
      showCard: (_anchor: unknown, _model: FieldCardModel, contrast: string | null, lockedCard: unknown) => shown.push({ contrast, locked: lockedCard }),
      contains: () => false,
      hide: () => undefined,
      isOpen: false,
    };
    const userSecurityCalls: string[] = [];
    const liveCalls: unknown[] = [];
    const states: unknown[] = [];
    view.showState = ((...args: unknown[]) => void states.push(args[3])) as () => undefined;
    const sources = {
      settings: async () => ({ mode: "connected" as const, showTips: true }),
      connectedCard: answer,
      liteCards: async () => {
        throw new Error("not used");
      },
      userSecurity: async (table: string) => {
        userSecurityCalls.push(table);
        return userSecurity();
      },
      liveModified: async (refs: unknown) => {
        liveCalls.push(refs);
        return new Map();
      },
      hideTips: async () => undefined,
      openOptions: async () => undefined,
    };
    const controller = new HoverController(view as never, sources as never, userReadTimeoutMs);
    controller.setSnapshot(snapshot);
    controller.openFor(control, container);
    return { shown, userSecurityCalls, liveCalls, states };
  }

  // Pairing: a live read runs only once Pathix has answered
  // with the card it pairs with.
  it.each<[string, () => Promise<unknown>]>([
    ["signed out", async () => ({ kind: "status", status: { kind: "signedOut", reason: "no token" } })],
    ["not configured", async () => ({ kind: "status", status: { kind: "notConfigured" } })],
    ["refused", async () => ({ kind: "status", status: { kind: "unauthorized", status: 403 } })],
    ["not scanned", async () => ({ kind: "status", status: { kind: "notScanned" } })],
    ["an error", async () => ({ kind: "status", status: { kind: "error", message: "boom" } })],
    ["no answer", async () => undefined],
    ["a failed message", async () => Promise.reject(new Error("context invalidated"))],
  ])("makes no Dataverse read on a read-only field when Pathix answers %s", async (_label, answer) => {
    const { shown, userSecurityCalls, liveCalls, states } = harness(["creditlimit"], async () => user, "creditlimit", answer);
    await settle();
    await settle();
    expect(userSecurityCalls).toEqual([]);
    expect(liveCalls).toEqual([]);
    expect(shown).toEqual([]);
    expect(states).toHaveLength(1);
  });

  it("starts the user's own reads only after Pathix's card has come back", async () => {
    let release!: (value: unknown) => void;
    const { userSecurityCalls } = harness(["creditlimit"], async () => user, "creditlimit", () => new Promise((resolve) => (release = resolve)));
    await settle();
    expect(userSecurityCalls).toEqual([]);
    release({ kind: "card", card });
    await settle();
    expect(userSecurityCalls).toEqual(["account"]);
  });

  it("takes the contrast line's count from the card, which is Pathix's", async () => {
    const { shown, userSecurityCalls } = harness([], async () => user);
    await settle();
    expect(shown[0]!.contrast).toBe("Dataverse has 12 dependency records. Pathix found 1 writer.");
    expect(shown[0]!.locked).toBeNull();
    expect(userSecurityCalls).toEqual([]);
  });

  it("reads the user's own state, and builds the checklist, only on a field the form shows read-only", async () => {
    const { shown, userSecurityCalls } = harness(["creditlimit"], async () => user);
    await settle();
    expect(userSecurityCalls).toEqual(["account"]);
    const checklist = shown.at(-1)!.locked as { lines: Array<{ topic: string; state: string; live?: boolean }> };
    expect(checklist.lines.find((line) => line.topic === "The form")).toMatchObject({ state: "cause" });
    expect(checklist.lines.find((line) => line.topic === "Your access to the table")).toMatchObject({ state: "ruledOut", live: true });
  });

  it("matches the hovered control by id: the second copy of the column is not locked", async () => {
    const { shown } = harness(["creditlimit1"], async () => user, "creditlimit1");
    await settle();
    const checklist = shown.at(-1)!.locked as { lines: Array<{ topic: string; state: string }> };
    expect(checklist.lines.find((line) => line.topic === "The form")?.state).toBe("ruledOut");
  });

  it("is unknown for a control Pathix does not list, never the form's own answer", async () => {
    const { shown } = harness(["header_process_creditlimit"], async () => user, "header_process_creditlimit");
    await settle();
    const checklist = shown.at(-1)!.locked as { lines: Array<{ topic: string; state: string }> };
    expect(checklist.lines.find((line) => line.topic === "The form")?.state).toBe("unknown");
  });

  it("still draws the card, with the live lines unknown, when the user's own state cannot be read", async () => {
    const { shown } = harness(["creditlimit"], async () => {
      throw new Error("refused");
    });
    await settle();
    expect(shown).toHaveLength(2);
    const checklist = shown.at(-1)!.locked as { lines: Array<{ topic: string; state: string }> };
    expect(checklist.lines.find((line) => line.topic === "Your access to the table")?.state).toBe("unknown");
    expect(checklist.lines.find((line) => line.topic === "The form")?.state).toBe("cause");
  });

  type Checklist = { headline: string; lines: Array<{ topic: string; state: string; text: string; live?: boolean }> };

  it("shows the Pathix card before the user's own reads come back, with the live lines checking", async () => {
    let release!: (facts: LiveUserFacts) => void;
    const { shown } = harness(["creditlimit"], () => new Promise<LiveUserFacts>((resolve) => (release = resolve)));
    await settle();
    expect(shown).toHaveLength(1);
    const first = shown[0]!.locked as Checklist;
    expect(first.lines.find((line) => line.topic === "Your access to the table")).toMatchObject({ state: "checking", live: true, text: "Checking your access to the table…" });
    expect(first.lines.find((line) => line.topic === "The form")?.state).toBe("cause");
    expect(first.headline).toBe("Checking your own access, live from Dataverse…");
    release(user);
    await settle();
    expect((shown.at(-1)!.locked as Checklist).lines.find((line) => line.topic === "Your access to the table")?.state).toBe("ruledOut");
  });

  it("says it could not read the user's access in time when the live reads hang, never a verdict", async () => {
    const { shown } = harness(["creditlimit"], () => new Promise<LiveUserFacts>(() => undefined), "creditlimit", undefined, 5);
    await new Promise((done) => setTimeout(done, 30));
    const last = shown.at(-1)!.locked as Checklist;
    expect(last.lines.find((line) => line.topic === "Your access to the table")).toMatchObject({ state: "unknown", live: true, text: "Could not read your access in time." });
    expect(last.lines.some((line) => line.state === "checking")).toBe(false);
  });

  // The pairing rule, clarified 2026-10-09: "not in scan" is not a fact to pair a live read with.
  it("makes no Dataverse read and shows no checklist for a column not in Pathix's latest scan", async () => {
    const notInScan = { ...card, notInScan: true, rows: [] };
    const { shown, userSecurityCalls, liveCalls } = harness(["creditlimit"], async () => user, "creditlimit", async () => ({ kind: "card", card: notInScan }));
    await settle();
    await settle();
    expect(userSecurityCalls).toEqual([]);
    expect(liveCalls).toEqual([]);
    expect(shown).toEqual([{ contrast: null, locked: null }]);
  });
});
