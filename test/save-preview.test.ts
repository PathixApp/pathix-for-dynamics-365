// The save preview (M12, connected): what Pathix says is registered to fire when
// one record is saved, single hop.
//
// EVERY PATHIX ANSWER IN THIS FILE IS HAND-WRITTEN. No real save-pipeline answer
// has been captured yet (the endpoint was not yet
// released when this was written). The answers are in the shape of the contract
// (contract/pathix-api.slice.json, GET /tables/{logicalName}/save-pipeline), and
// the first test checks that they are: every required property of the response
// schema is there. They prove the logic, not what a real org returns.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadSavePreview, savePipelinePath } from "../src/background/save-preview";
import type { Get } from "../src/background/connection";
import type { FormSnapshot } from "../src/bridge/messages";
import {
  buildSavePreview,
  disclosureText,
  unresolvedTableStepsText,
  ALWAYS_PRESENT_LANES,
  MAX_COLUMN_CHARS,
  microsoftEntriesLine,
  saveColumns,
  SAVE_PREVIEW_LITE_LINE,
  SAVE_PREVIEW_TIP,
  type PreviewList,
  type SavePreviewContext,
  type SavePreviewModel,
} from "../src/card/save-preview";
import { PATHIX_SITE } from "../src/card/lite";
import type { SavePipeline, SavePipelineEntry, SavePipelineLane } from "../src/pathix/api";
import { isSavePreviewRequest } from "../src/runtime/messages";

const ids = (n: number) => `5c4a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FORM = ids(21);
const ENV = ids(1);

// --- hand-written answers, in the contract's shape -----------------------------------

function entry(overrides: Partial<SavePipelineEntry> & { name?: string } = {}): SavePipelineEntry {
  const { name, ...rest } = overrides;
  return {
    componentId: ids(100),
    componentName: name ?? "Credit check",
    componentType: "PluginStep",
    isSystem: false,
    trigger: {
      message: "Update",
      stage: "PostOperation",
      executionMode: "Synchronous",
      table: "account",
      filteringColumns: ["creditlimit"],
      firesOnEveryUpdate: false,
      hasRowFilter: null,
    },
    matchedColumns: ["creditlimit"],
    executionOrder: 1,
    orderUnknown: false,
    tiedOrder: false,
    allTables: false,
    conditional: false,
    rowFilterUnknown: false,
    ...rest,
  };
}

/** One lane as the wire sends it: name, stage number (null for Asynchronous), kind, ordered unless asynchronous. */
function lane(name: string, stage: number | null, kind: string, entries: SavePipelineEntry[] = []): SavePipelineLane {
  return { lane: name, stage, kind, ordered: kind !== "asynchronous", entries };
}

/** The five lanes Pathix always sends, by stage, plus any `extra` ones (an internal or deprecated stage), in stage order with Asynchronous last. */
function lanes(overrides: Record<string, SavePipelineEntry[]> = {}, extra: SavePipelineLane[] = []): SavePipelineLane[] {
  const fixed = ALWAYS_PRESENT_LANES.map((fixedLane) => lane(fixedLane.lane, fixedLane.stage, fixedLane.kind, overrides[fixedLane.lane] ?? []));
  return [...fixed, ...extra].sort((a, b) => (a.stage ?? Infinity) - (b.stage ?? Infinity));
}

const LANE_NAMES = ALWAYS_PRESENT_LANES.map((fixedLane) => fixedLane.lane);

function pipeline(overrides: Partial<SavePipeline> = {}): SavePipeline {
  return {
    table: "account",
    message: "Update",
    columns: ["creditlimit"],
    browseMode: false,
    scope: { environmentId: ENV, scanId: ids(2), scannedAt: "2026-10-03T02:30:00Z" },
    lanes: lanes(),
    unplaced: [],
    serverBusinessRules: [],
    excludedDisabled: 0,
    unresolvedTableSteps: 0,
    clientLayer: null,
    disclosures: ["registeredNotWrites", "cascadesNotFollowed", "platformFeaturesNotListed"],
    ...overrides,
  };
}

/** A form whose scan shows no OnSave handler: the client layer is known and empty. */
const NO_HANDLERS: SavePipeline["clientLayer"] = { formId: FORM, coverage: "modeled", notModeledReason: null, ordered: false, handlers: [] };

const context: SavePreviewContext = {
  environmentName: "Contoso",
  scanCompletedAt: "2026-10-03T02:30:00Z",
  table: "account",
  message: "Update",
  columnsSent: ["creditlimit"],
  columnsWithheld: 0,
  formRequested: true,
  formatDate: () => "Oct 2",
};

const modelOf = (answer: SavePipeline, overrides: Partial<SavePreviewContext> = {}): SavePreviewModel =>
  buildSavePreview({ ...context, ...overrides }, { kind: "ok", data: answer });

const listOf = (model: SavePreviewModel, id: string): PreviewList => {
  const found = model.sections.find((section): section is PreviewList => section.kind === "list" && section.id === id);
  if (!found) throw new Error(`No list ${id}.`);
  return found;
};

/** Every string the model would put on screen about the pipeline itself: not the "?" lines or the disclosures, which are there to deny a claim. */
function textOf(model: SavePreviewModel): string[] {
  const strings: string[] = [model.headline, model.status, model.inputs.text];
  for (const section of model.sections) {
    if (section.kind === "save") strings.push(section.text);
    else {
      strings.push(section.title, ...section.notes, section.unknownLine ?? "", section.emptyLine ?? "");
      for (const item of [...section.items, ...section.microsoft]) strings.push(item.name, item.order ?? "", ...item.lines, ...item.tags);
    }
  }
  return strings.filter(Boolean);
}

// --- the stand-ins really are in the contract's shape ----------------------------------

type Schema = { $ref?: string; type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; oneOf?: Schema[] };
const slice = JSON.parse(readFileSync("contract/pathix-api.slice.json", "utf8")) as { components: { schemas: Record<string, Schema> } };

/** A minimal check against the slice: required properties are present, types agree. Returns what is wrong. */
function conformance(schema: Schema, value: unknown, at = "$"): string[] {
  if (schema.$ref) return conformance(slice.components.schemas[schema.$ref.replace("#/components/schemas/", "")]!, value, at);
  if (schema.oneOf) {
    const attempts = schema.oneOf.map((option) => conformance(option, value, at));
    return attempts.some((problems) => problems.length === 0) ? [] : attempts.flat();
  }
  const types = ([] as string[]).concat(schema.type ?? []);
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  if (types.length > 0 && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${at}: ${kind}, expected ${types.join("|")}`];
  if (kind === "array") return (value as unknown[]).flatMap((item, index) => (schema.items ? conformance(schema.items, item, `${at}[${index}]`) : []));
  if (kind !== "object") return [];
  const record = value as Record<string, unknown>;
  const missing = (schema.required ?? []).filter((key) => !(key in record)).map((key) => `${at}.${key}: missing`);
  const inner = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => (key in record ? conformance(child, record[key], `${at}.${key}`) : []));
  return [...missing, ...inner];
}

const responseSchema: Schema = { $ref: "#/components/schemas/SavePipelineResponse" };

describe("the hand-written Pathix answers", () => {
  it("carry every property the contract requires, with the types it declares", () => {
    const full = pipeline({
      lanes: lanes({ PostOperation: [entry()], Asynchronous: [entry({ executionOrder: null, orderUnknown: false })] }),
      unplaced: [entry()],
      serverBusinessRules: [{ componentId: ids(5), componentName: "Lock closed accounts", isSystem: false }],
      clientLayer: { formId: FORM, coverage: "modeled", notModeledReason: null, ordered: false, handlers: [{ library: "new_/account.js", function: "onSave", isEnabled: true, isPlatformLoaded: false, scriptComponentId: ids(7) }] },
    });
    expect(conformance(responseSchema, full)).toEqual([]);
    expect(conformance(responseSchema, pipeline({ clientLayer: { formId: FORM, coverage: "notModeled", notModeledReason: "formNotFound", ordered: false, handlers: null } }))).toEqual([]);
  });

  it("is told when an answer is not in the contract's shape", () => {
    const { lanes: _dropped, ...broken } = pipeline();
    expect(conformance(responseSchema, broken)).toEqual(["$.lanes: missing"]);
    expect(conformance(responseSchema, { ...pipeline(), excludedDisabled: "2" })).toEqual(["$.excludedDisabled: string, expected integer"]);
  });

  it("carry each lane's stage and kind, which the contract requires, with a null stage only for Asynchronous", () => {
    const { kind: _kind, ...noKind } = lane("PreOperation", 20, "pipeline");
    expect(conformance(responseSchema, { ...pipeline(), lanes: [noKind] })).toEqual(["$.lanes[0].kind: missing"]);
    expect(conformance(responseSchema, { ...pipeline(), lanes: [{ ...lane("PreOperation", 20, "pipeline"), stage: "20" }] })).toEqual(["$.lanes[0].stage: string, expected null|integer"]);
    const extraKinds = [lane("PostOperationDeprecated", 50, "deprecated"), lane("FinalPostOperation", 55, "platformInternal"), lane("Stage99", 99, "unrecognized")];
    expect(conformance(responseSchema, pipeline({ lanes: lanes({}, extraKinds) }))).toEqual([]);
    expect(conformance(responseSchema, { ...pipeline(), lanes: [{ ...lane("Stage99", 99, "unrecognized"), kind: 7 }] })).toEqual(["$.lanes[0].kind: integer, expected string"]);
  });
});

// --- the lanes ---------------------------------------------------------------------------

describe("one timeline, in the order Pathix sends the lanes, with the save at the main operation", () => {
  const model = modelOf(
    pipeline({
      lanes: lanes({
        PreValidation: [entry({ name: "Validate owner", trigger: { ...entry().trigger, stage: "PreValidation" } })],
        PreOperation: [entry({ name: "Default region", executionOrder: 1 })],
        PostOperation: [entry({ name: "Notify sales", executionOrder: 5 })],
        Asynchronous: [entry({ name: "Sync to ERP", componentType: "ModernFlow", executionOrder: null })],
      }),
    }),
  );

  it("lists the form's handlers first, then pre-validation, pre-operation, the save and its lane, post-operation, then asynchronous", () => {
    expect(model.sections.map((section) => (section.kind === "save" ? "SAVE" : section.id))).toEqual([
      "client",
      "PreValidation",
      "PreOperation",
      "SAVE",
      "MainOperation",
      "PostOperation",
      "Asynchronous",
      "rules",
      "unplaced",
    ]);
  });

  it("draws the save marker once, right above the main operation lane", () => {
    expect(model.sections.filter((section) => section.kind === "save")).toEqual([{ kind: "save", text: "The record is saved" }]);
    expect(listOf(model, "MainOperation").title).toBe("Main operation");
  });

  it("puts what is registered at the main operation under the marker, in order", () => {
    const withMain = modelOf(
      pipeline({
        lanes: lanes({
          MainOperation: [
            entry({ name: "Second", executionOrder: 2, trigger: { ...entry().trigger, stage: "MainOperation" } }),
            entry({ name: "Third", executionOrder: null, orderUnknown: true, trigger: { ...entry().trigger, stage: "MainOperation" } }),
          ],
        }),
      }),
    );
    const ids = withMain.sections.map((section) => (section.kind === "save" ? "SAVE" : section.id));
    expect(ids.indexOf("MainOperation")).toBe(ids.indexOf("SAVE") + 1);
    const main = listOf(withMain, "MainOperation");
    expect(main.items.map((item) => `${item.name}:${item.order}`)).toEqual(["Second:Order 2", "Third:Order unknown"]);
    expect(main.laneTag).toBeNull();
    expect(withMain.headline).toContain("2 registered to fire on the server");
  });

  it("puts each entry in its lane, with its chip", () => {
    expect(listOf(model, "PreValidation").items.map((item) => item.name)).toEqual(["Validate owner"]);
    expect(listOf(model, "PreOperation").items[0]?.chip).toMatchObject({ kind: "PLG" });
    expect(listOf(model, "PostOperation").items.map((item) => item.name)).toEqual(["Notify sales"]);
    expect(listOf(model, "Asynchronous").items[0]?.chip?.colorType).toBe("ModernFlow");
  });

  it("says 'registered to fire' and never 'writes' or 'will run' about an entry", () => {
    const strings = textOf(model).join("\n");
    expect(strings).toContain("registered to fire");
    expect(strings).not.toMatch(/\bwrites?\b|will run|will fire/i);
  });

  it("says a lane with nothing registered is empty in this scan, and keeps the lane", () => {
    const empty = modelOf(pipeline());
    for (const id of LANE_NAMES) {
      const emptyLane = listOf(empty, id);
      expect(emptyLane.count).toBe(0);
      expect(emptyLane.emptyLine).toBe("None registered in this scan.");
    }
  });

  it("keeps the order Pathix gave, entry by entry", () => {
    const ordered = modelOf(pipeline({ lanes: lanes({ PostOperation: [entry({ name: "B", executionOrder: 1 }), entry({ name: "A", executionOrder: 2 })] }) }));
    expect(listOf(ordered, "PostOperation").items.map((item) => `${item.name}:${item.order}`)).toEqual(["B:Order 1", "A:Order 2"]);
  });
});

describe("order markers", () => {
  it("marks an unknown order and says where those entries sit", () => {
    const model = modelOf(
      pipeline({ lanes: lanes({ PreOperation: [entry({ name: "Ranked", executionOrder: 3 }), entry({ name: "Real-time workflow", componentType: "ClassicWorkflow", executionOrder: null, orderUnknown: true })] }) }),
    );
    const lane = listOf(model, "PreOperation");
    expect(lane.items.map((item) => item.order)).toEqual(["Order 3", "Order unknown"]);
    expect(lane.notes.join(" ")).toContain("order unknown");
    expect(lane.notes.join(" ")).toContain("listed after the ordered ones");
  });

  it("never invents an order: a missing order is unknown even if the flag is off", () => {
    const model = modelOf(pipeline({ lanes: lanes({ PreOperation: [entry({ executionOrder: null, orderUnknown: false })] }) }));
    expect(listOf(model, "PreOperation").items[0]?.order).toBe("Order unknown");
  });

  it("marks a tied order and says the platform does not guarantee which runs first", () => {
    const model = modelOf(pipeline({ lanes: lanes({ PostOperation: [entry({ name: "A", executionOrder: 1, tiedOrder: true }), entry({ name: "B", executionOrder: 1, tiedOrder: true })] }) }));
    const lane = listOf(model, "PostOperation");
    expect(lane.items.map((item) => item.tags)).toEqual([["tied order"], ["tied order"]]);
    expect(lane.notes.join(" ")).toContain("does not say which runs first");
  });

  it("draws no ordered lane as a sequence of unknowns when nothing is flagged", () => {
    expect(listOf(modelOf(pipeline({ lanes: lanes({ PostOperation: [entry()] }) })), "PostOperation").notes).toEqual([]);
  });
});

describe("the asynchronous lane", () => {
  const model = modelOf(
    pipeline({
      lanes: lanes({
        Asynchronous: [
          entry({ name: "Sync to ERP", componentType: "ModernFlow", executionOrder: 7, orderUnknown: false }),
          entry({ name: "Index", executionOrder: 7, tiedOrder: false }),
        ],
      }),
      disclosures: ["registeredNotWrites", "asyncUnordered", "cascadesNotFollowed", "platformFeaturesNotListed"],
    }),
  );

  it("is marked unordered, with a note, and shows no order for its entries", () => {
    const lane = listOf(model, "Asynchronous");
    expect(lane.unordered).toBe(true);
    expect(lane.notes).toEqual(["No order. These are not a sequence."]);
    expect(lane.items.map((item) => item.order)).toEqual([null, null]);
  });

  it("is the only lane marked unordered when Pathix says so", () => {
    expect(model.sections.filter((section): section is PreviewList => section.kind === "list" && section.unordered).map((section) => section.id)).toEqual(["Asynchronous"]);
  });

  it("follows the wire: a lane Pathix does not mark ordered is not drawn as a sequence", () => {
    const wire = pipeline({ lanes: lanes().map((each) => (each.lane === "PostOperation" ? { ...each, ordered: false, entries: [entry()] } : each)) });
    expect(listOf(modelOf(wire), "PostOperation").unordered).toBe(true);
    expect(listOf(modelOf(wire), "PostOperation").items[0]?.order).toBeNull();
  });

  it("carries the asyncUnordered disclosure as text", () => {
    expect(model.disclosures).toContain(disclosureText("asyncUnordered"));
  });

  it("says the stage an asynchronous entry is registered at, since the lane has none", () => {
    const stage = (name: string, at: string | null) => entry({ name, trigger: { ...entry().trigger, stage: at, executionMode: "Asynchronous" } });
    const rows = listOf(modelOf(pipeline({ lanes: lanes({ Asynchronous: [stage("Post step", "PostOperation"), stage("Early step", "PreValidation"), stage("No stage", null)] }) })), "Asynchronous").items;
    expect(rows.map((item) => item.lines)).toEqual([
      ["Matched: creditlimit", "Registered at post operation"],
      ["Matched: creditlimit", "Registered at pre validation"],
      ["Matched: creditlimit"],
    ]);
  });

  it("draws an asynchronous step at an internal stage in the Asynchronous lane, with no lane of its own for that stage (a test environment's stage 45 WorkflowExpansion)", () => {
    const step = entry({ name: "WorkflowExpansion", trigger: { ...entry().trigger, stage: "InternalPostOperationAfterExternalPlugins", executionMode: "Asynchronous" } });
    const model = modelOf(pipeline({ lanes: lanes({ Asynchronous: [step] }) }));
    expect(listOf(model, "Asynchronous").items.map((item) => item.lines)).toEqual([["Matched: creditlimit", "Registered at internal post operation after external plugins"]]);
    expect(model.sections.map((section) => (section.kind === "save" ? "SAVE" : section.id))).not.toContain("InternalPostOperationAfterExternalPlugins");
  });

  it("keeps a synchronous lane's entries free of a stage line, as the lane is the stage", () => {
    expect(listOf(modelOf(pipeline({ lanes: lanes({ PostOperation: [entry()] }) })), "PostOperation").items[0]?.lines).toEqual(["Matched: creditlimit"]);
  });
});

describe("entries whose position Pathix does not know", () => {
  const noStage = entry({ name: "Stage unknown", trigger: { ...entry().trigger, stage: null, executionMode: null }, executionOrder: null, orderUnknown: true });
  const noMode = entry({ name: "Mode unknown", trigger: { ...entry().trigger, stage: "PostOperation", executionMode: null }, executionOrder: 2, tiedOrder: true });

  it("lists them apart, with their stage and mode, and keeps their markers", () => {
    const model = modelOf(pipeline({ unplaced: [noMode, noStage] }));
    const unplaced = listOf(model, "unplaced");
    expect(unplaced.count).toBe(2);
    expect(unplaced.items[0]?.lines[0]).toBe("Stage: Post operation · No mode");
    expect(unplaced.items[0]?.tags).toEqual(["tied order"]);
    expect(unplaced.items[1]?.lines[0]).toBe("Stage: No stage · No mode");
    expect(unplaced.items[1]?.order).toBe("Order unknown");
    expect(model.headline).toContain("2 registered to fire");
  });

  it("is headed 'Position unknown' and says it is for a missing stage or mode, not for internal stages", () => {
    const unplaced = listOf(modelOf(pipeline({ unplaced: [noStage] })), "unplaced");
    expect(unplaced.title).toBe("Position unknown");
    expect(unplaced.notes.join(" ")).toContain("no stage, or no execution mode");
    expect(unplaced.notes.join(" ")).not.toMatch(/internal/i);
  });

  it("is empty, and says so, when every entry has a place", () => {
    const unplaced = listOf(modelOf(pipeline()), "unplaced");
    expect(unplaced.count).toBe(0);
    expect(unplaced.emptyLine).toBe("None in this scan.");
  });
});

describe("the lane kinds", () => {
  const internal = lane("InternalPreOperationBeforeExternalPlugins", 15, "platformInternal", [
    entry({ name: "Platform pre step", trigger: { ...entry().trigger, stage: "InternalPreOperationBeforeExternalPlugins" } }),
  ]);
  const deprecated = lane("PostOperationDeprecated", 50, "deprecated", [
    entry({ name: "Old customer step", trigger: { ...entry().trigger, stage: "PostOperationDeprecated" } }),
  ]);
  const unrecognized = lane("Stage99", 99, "unrecognized", [entry({ name: "Odd step" })]);
  const model = modelOf(pipeline({ lanes: lanes({}, [internal, deprecated, unrecognized]) }));

  it("draws every lane in one timeline, in the order Pathix sent, with Asynchronous last", () => {
    expect(model.sections.map((section) => (section.kind === "save" ? "SAVE" : section.id))).toEqual([
      "client",
      "PreValidation",
      "InternalPreOperationBeforeExternalPlugins",
      "PreOperation",
      "SAVE",
      "MainOperation",
      "PostOperation",
      "PostOperationDeprecated",
      "Stage99",
      "Asynchronous",
      "rules",
      "unplaced",
    ]);
  });

  it("follows the array order it is given, not its own idea of stage order", () => {
    const reversed = pipeline({
      lanes: [lane("PreOperation", 20, "pipeline"), lane("PreValidation", 10, "pipeline"), lane("MainOperation", 30, "mainOperation"), lane("PostOperation", 40, "pipeline"), lane("Asynchronous", null, "asynchronous")],
    });
    const ids = modelOf(reversed).sections.map((section) => (section.kind === "save" ? "SAVE" : section.id));
    expect(ids.slice(1, 5)).toEqual(["PreOperation", "PreValidation", "SAVE", "MainOperation"]);
  });

  it("tags a platform internal lane as Microsoft's internal stage, with its number, and names it in words", () => {
    const lane15 = listOf(model, "InternalPreOperationBeforeExternalPlugins");
    expect(lane15.laneTag).toBe("Microsoft internal stage 15");
    expect(lane15.title).toBe("Internal pre-operation, before external plugins");
    expect(lane15.items.map((item) => item.name)).toEqual(["Platform pre step"]);
  });

  it("tags the deprecated stage as such, and says an older environment can hold a customer step there", () => {
    const lane50 = listOf(model, "PostOperationDeprecated");
    expect(lane50.laneTag).toBe("deprecated post-operation stage 50");
    expect(lane50.title).toBe("Post-operation (deprecated)");
    expect(lane50.notes.join(" ")).toContain("customer's steps");
    expect(lane50.items.map((item) => item.name)).toEqual(["Old customer step"]);
  });

  it("tags a stage it does not recognize with its number, and shows its entries", () => {
    const lane99 = listOf(model, "Stage99");
    expect(lane99.laneTag).toBe("unrecognized stage 99");
    expect(lane99.title).toBe("Stage 99");
    expect(lane99.items.map((item) => item.name)).toEqual(["Odd step"]);
  });

  it("shows a kind this version has never heard of as an unrecognized stage, never drops it", () => {
    const future = modelOf(pipeline({ lanes: lanes({}, [lane("Stage123", 123, "somethingNew", [entry({ name: "Future step" })])]) }));
    expect(listOf(future, "Stage123").laneTag).toBe("unrecognized stage 123");
    expect(listOf(future, "Stage123").items.map((item) => item.name)).toEqual(["Future step"]);
  });

  it("leaves the four lanes a customer knows, and Asynchronous, untagged", () => {
    for (const id of LANE_NAMES) expect(listOf(model, id).laneTag).toBeNull();
  });

  it("counts the entries of every lane in the headline", () => {
    expect(model.headline).toContain("3 registered to fire on the server");
  });

  it("keeps order markers per lane: a tie in one lane is not a tie in another", () => {
    const tied = lane("InternalPostOperationAfterExternalPlugins", 45, "platformInternal", [
      entry({ name: "A", executionOrder: 1, tiedOrder: true }),
      entry({ name: "B", executionOrder: 1, tiedOrder: true }),
    ]);
    const other = modelOf(pipeline({ lanes: lanes({ PostOperation: [entry({ name: "C", executionOrder: 1 })] }, [tied]) }));
    expect(listOf(other, "InternalPostOperationAfterExternalPlugins").items.map((item) => item.tags)).toEqual([["tied order"], ["tied order"]]);
    expect(listOf(other, "InternalPostOperationAfterExternalPlugins").notes.join(" ")).toContain("does not say which runs first");
    expect(listOf(other, "PostOperation").items.map((item) => item.tags)).toEqual([[]]);
  });
});

describe("Microsoft entries fold by publisher, and a lane of only those collapses to one line", () => {
  const platform = (name: string, order: number) => entry({ name, isSystem: true, executionOrder: order, tiedOrder: order === 1 });

  it("collapses a lane whose entries all come from Microsoft publishers, with its count, and never drops it", () => {
    const internal = lane("FinalPostOperation", 55, "platformInternal", [platform("Platform A", 1), platform("Platform B", 1), platform("Platform C", 2)]);
    const folded = listOf(modelOf(pipeline({ lanes: lanes({}, [internal]) })), "FinalPostOperation");
    expect(folded.collapsed).toBe(true);
    expect(folded.count).toBe(3);
    expect(folded.items).toEqual([]);
    expect(folded.microsoft.map((item) => `${item.name}|${item.order}|${item.tags}`)).toEqual(["Platform A|Order 1|tied order", "Platform B|Order 1|tied order", "Platform C|Order 2|"]);
    expect(folded.laneTag).toBe("Microsoft internal stage 55");
  });

  it("does not collapse a lane that holds a customer entry, and folds only the Microsoft ones", () => {
    const mixed = lane("PostOperationDeprecated", 50, "deprecated", [entry({ name: "Customer", executionOrder: 1 }), platform("Platform", 2)]);
    const folded = listOf(modelOf(pipeline({ lanes: lanes({}, [mixed]) })), "PostOperationDeprecated");
    expect(folded.collapsed).toBe(false);
    expect(folded.items.map((item) => item.name)).toEqual(["Customer"]);
    expect(folded.microsoft.map((item) => item.name)).toEqual(["Platform"]);
    expect(folded.count).toBe(2);
  });

  it("does not collapse an empty lane: nothing registered is said, not hidden", () => {
    const empty = listOf(modelOf(pipeline()), "PreValidation");
    expect(empty.collapsed).toBe(false);
    expect(empty.emptyLine).toBe("None registered in this scan.");
  });

  it("collapses an all-Microsoft pre-operation lane too, as the fold is the same everywhere", () => {
    const model = modelOf(pipeline({ lanes: lanes({ PreOperation: [platform("Platform", 3)] }) }));
    expect(listOf(model, "PreOperation").collapsed).toBe(true);
  });
});

// --- scope and markers on an entry --------------------------------------------------------

describe("what scopes each entry", () => {
  const one = (overrides: Partial<SavePipelineEntry>, answer: Partial<SavePipeline> = {}) =>
    listOf(modelOf(pipeline({ lanes: lanes({ PostOperation: [entry(overrides)] }), ...answer })), "PostOperation").items[0]!;

  it("names the changed columns that matched", () => {
    expect(one({ matchedColumns: ["creditlimit", "name"] }).lines).toEqual(["Matched: creditlimit, name"]);
  });

  it("says 'any update' where the trigger fires on every update", () => {
    const item = one({ matchedColumns: null, trigger: { ...entry().trigger, filteringColumns: [], firesOnEveryUpdate: true } });
    expect(item.lines).toEqual(["Fires on any update"]);
  });

  it("shows the trigger's own filter in browse mode", () => {
    const item = one({ matchedColumns: null, trigger: { ...entry().trigger, filteringColumns: ["a", "b"] } }, { browseMode: true, columns: null });
    expect(item.lines).toEqual(["Fires when a, b change"]);
    const single = one({ matchedColumns: null, trigger: { ...entry().trigger, filteringColumns: ["sic"] } }, { browseMode: true, columns: null });
    expect(single.lines).toEqual(["Fires when sic changes"]);
  });

  it("does not guess when an update trigger states no column scope", () => {
    const item = one({ matchedColumns: null, trigger: { ...entry().trigger, filteringColumns: [], firesOnEveryUpdate: false } });
    expect(item.lines).toEqual(["Column filter not stated"]);
  });

  it("says 'registered for Create' on a create, where columns do not apply", () => {
    const item = one({ matchedColumns: null, trigger: { ...entry().trigger, message: "Create", filteringColumns: [] } }, { message: "Create", columns: null });
    expect(item.lines).toEqual(["Registered for Create"]);
  });

  it("cuts a long column list", () => {
    const columns = Array.from({ length: 9 }, (_, index) => `c${index}`);
    expect(one({ matchedColumns: columns }).lines).toEqual(["Matched: c0, c1, c2, c3, c4, c5 +3 more"]);
  });
});

describe("markers on an entry", () => {
  const tagsOf = (overrides: Partial<SavePipelineEntry>) =>
    listOf(modelOf(pipeline({ lanes: lanes({ Asynchronous: [entry(overrides)] }) })), "Asynchronous").items[0]!.tags;

  it("marks an all-tables registration", () => {
    expect(tagsOf({ allTables: true })).toEqual(["all tables"]);
  });

  it("marks a flow a row filter can skip", () => {
    expect(tagsOf({ componentType: "ModernFlow", conditional: true })).toEqual(["row filter set"]);
  });

  it("marks a flow whose row filter is not known, never as 'no filter'", () => {
    const tags = tagsOf({ componentType: "ModernFlow", rowFilterUnknown: true });
    expect(tags).toEqual(["row filter unknown"]);
    expect(tags.join(" ")).not.toMatch(/no row filter/i);
  });

  it("carries several markers at once", () => {
    expect(tagsOf({ allTables: true, conditional: true, rowFilterUnknown: true })).toEqual(["all tables", "row filter set", "row filter unknown"]);
  });
});

// --- Microsoft-shipped entries ---------------------------------------------------------------

describe("Microsoft-shipped entries", () => {
  const model = modelOf(
    pipeline({
      lanes: lanes({
        PostOperation: [
          entry({ name: "Customer step", executionOrder: 1 }),
          entry({ name: "Platform step", isSystem: true, executionOrder: 2, tiedOrder: true }),
          entry({ name: "Platform step B", isSystem: true, executionOrder: 2, tiedOrder: true }),
        ],
      }),
      serverBusinessRules: [
        { componentId: ids(1), componentName: "Customer rule", isSystem: false },
        { componentId: ids(2), componentName: "Platform rule", isSystem: true },
      ],
    }),
  );

  it("folds them out of the list, keeps them counted, and keeps their order and markers", () => {
    const lane = listOf(model, "PostOperation");
    expect(lane.count).toBe(3);
    expect(lane.items.map((item) => item.name)).toEqual(["Customer step"]);
    expect(lane.microsoft.map((item) => `${item.name}|${item.order}|${item.tags}`)).toEqual(["Platform step|Order 2|tied order", "Platform step B|Order 2|tied order"]);
    expect(microsoftEntriesLine(lane.microsoft.length)).toBe("2 Microsoft-shipped entries");
    expect(microsoftEntriesLine(1)).toBe("1 Microsoft-shipped entry");
  });

  it("folds entity business rules the same way", () => {
    const rules = listOf(model, "rules");
    expect(rules.items.map((item) => item.name)).toEqual(["Customer rule"]);
    expect(rules.microsoft.map((item) => item.name)).toEqual(["Platform rule"]);
  });

  it("decides it from the publisher flag only, never from managed state", () => {
    const source = readFileSync("src/card/save-preview.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/ismanaged/i);
    expect(source).toMatch(/isSystem/);
  });
});

describe("entity business rules", () => {
  it("are their own list, apart from the lanes, and say why", () => {
    const model = modelOf(pipeline({ clientLayer: NO_HANDLERS, serverBusinessRules: [{ componentId: ids(9), componentName: "Lock closed accounts", isSystem: false }] }));
    const rules = listOf(model, "rules");
    expect(rules.items.map((item) => item.name)).toEqual(["Lock closed accounts"]);
    expect(rules.notes.join(" ")).toContain("not in order");
    expect(LANE_NAMES.flatMap((id) => listOf(model, id).items.map((item) => item.name))).not.toContain("Lock closed accounts");
    // A rule registered on the server does fire on a save, so the headline never puts "Nothing" in front of it.
    expect(model.headline).toBe("1 entity business rule on the server.");
  });
});

describe("the headline", () => {
  it("counts what is registered, the business rules, and the disabled ones", () => {
    const model = modelOf(
      pipeline({
        clientLayer: NO_HANDLERS,
        lanes: lanes({ PostOperation: [entry(), entry()], Asynchronous: [entry()] }),
        serverBusinessRules: [{ componentId: ids(9), componentName: "R", isSystem: false }],
        excludedDisabled: 4,
      }),
    );
    expect(model.headline).toBe("3 registered to fire on the server, 1 entity business rule on the server, and 4 disabled.");
  });

  it("says 'and N disabled' when only disabled components remain", () => {
    expect(modelOf(pipeline({ clientLayer: NO_HANDLERS, excludedDisabled: 2 })).headline).toBe("Nothing is registered to fire on this save, and 2 disabled.");
  });

  it("answers a plain empty pipeline in Pathix's scan, and still carries the disclosures", () => {
    const model = modelOf(pipeline({ clientLayer: NO_HANDLERS }));
    expect(model.headline).toBe("Nothing is registered to fire on this save.");
    expect(model.kind).toBe("known");
    expect(model.disclosures.length).toBeGreaterThan(0);
  });

  const handler = (name: string) => ({ library: "new_/account.js", function: name, isEnabled: true, isPlatformLoaded: false, scriptComponentId: ids(7) });

  it("does not count a disabled form handler as found, and adds it to the disabled tail", () => {
    const disabled = { ...handler("off"), isEnabled: false };
    expect(modelOf(pipeline({ clientLayer: { ...NO_HANDLERS!, handlers: [disabled] } })).headline).toBe("Nothing is registered to fire on this save, and 1 disabled.");
    expect(modelOf(pipeline({ clientLayer: { ...NO_HANDLERS!, handlers: [handler("on"), disabled] }, excludedDisabled: 2 })).headline).toBe(
      "1 form OnSave handler, and 3 disabled.",
    );
    // The disabled handler is still listed, tagged, never hidden.
    const model = modelOf(pipeline({ clientLayer: { ...NO_HANDLERS!, handlers: [disabled] } }));
    const client = model.sections.find((section) => section.kind === "list" && section.id === "client");
    expect(client && client.kind === "list" && client.items[0]?.tags).toContain("disabled");
  });

  it("counts a modeled client layer's handlers, and never says Nothing in front of them", () => {
    const model = modelOf(pipeline({ clientLayer: { ...NO_HANDLERS!, handlers: [handler("onSave"), handler("validate")] } }));
    expect(model.headline).toBe("2 form OnSave handlers.");
    expect(modelOf(pipeline({ clientLayer: { ...NO_HANDLERS!, handlers: [handler("onSave")] }, lanes: lanes({ PostOperation: [entry()] }) })).headline).toBe(
      "1 form OnSave handler, and 1 registered to fire on the server.",
    );
  });

  it("names an unknown client layer instead of counting it as zero", () => {
    const unknownLayer = (clientLayer: SavePipeline["clientLayer"], overrides: Partial<SavePreviewContext> = {}) => modelOf(pipeline({ clientLayer }), overrides);
    const notModeled = { formId: FORM, coverage: "notModeled", notModeledReason: "formNotFound", ordered: false, handlers: null };
    for (const model of [unknownLayer(notModeled), unknownLayer(null), unknownLayer(null, { formRequested: false })]) {
      expect(model.kind).toBe("known");
      expect(model.headline).toBe("Nothing is registered in the parts Pathix answered. Unknown: the form's OnSave handlers.");
      expect(model.headline).not.toMatch(/^Nothing is registered to fire/);
    }
    expect(unknownLayer(notModeled).headline).not.toContain("0");
  });

  it("names a lane the answer left out, and keeps the counts it does have", () => {
    const missing = pipeline({ clientLayer: NO_HANDLERS, lanes: lanes({ PostOperation: [entry()] }).filter((lane) => lane.lane !== "PreOperation") });
    expect(modelOf(missing).headline).toBe("1 registered to fire on the server. Unknown: the pre-operation lane.");
    const none = pipeline({ clientLayer: NO_HANDLERS, lanes: lanes().filter((each) => each.lane !== "Asynchronous") });
    expect(modelOf(none).headline).toBe("Nothing is registered in the parts Pathix answered. Unknown: the asynchronous lane.");
  });

  it("says Nothing only when the unplaced list is empty too", () => {
    expect(modelOf(pipeline({ clientLayer: NO_HANDLERS, unplaced: [entry()] })).headline).toBe("1 registered to fire on the server.");
  });
});

// --- disclosures -------------------------------------------------------------------------------

describe("disclosure codes", () => {
  const CODES = [
    "registeredNotWrites",
    "asyncUnordered",
    "cascadesNotFollowed",
    "platformFeaturesNotListed",
    "flowScopeNotModeled",
    "clientOrderNotKept",
    "unresolvedTableStepsNotListed",
  ];

  it.each(CODES)("renders %s as its own sentence", (code) => {
    const model = modelOf(pipeline({ disclosures: [code] }));
    expect(model.disclosures).toEqual([disclosureText(code)]);
    expect(disclosureText(code)).not.toContain(code);
    expect(disclosureText(code).length).toBeGreaterThan(30);
  });

  it("renders every code Pathix sends, in order, and none twice", () => {
    const model = modelOf(pipeline({ disclosures: [...CODES, "asyncUnordered"] }));
    expect(model.disclosures).toEqual(CODES.map(disclosureText));
  });

  it("shows a code it does not know as written, never drops it", () => {
    const model = modelOf(pipeline({ disclosures: ["registeredNotWrites", "somethingNew"] }));
    expect(model.disclosures[1]).toBe('Pathix also reported "somethingNew", which this version of the extension does not describe.');
  });

  describe("steps on a table the platform does not name", () => {
    const unresolved = (count: number | undefined, overrides: Partial<SavePipeline> = {}) => {
      const answer = pipeline({ clientLayer: NO_HANDLERS, disclosures: ["registeredNotWrites", "unresolvedTableStepsNotListed"], ...overrides });
      if (count === undefined) delete answer.unresolvedTableSteps;
      else answer.unresolvedTableSteps = count;
      return modelOf(answer);
    };

    it("says how many there are, and why they are not listed", () => {
      const model = unresolved(1568);
      expect(model.disclosures[1]).toBe(
        "1568 plugin steps registered for Update are bound to a table the platform does not name, often one no longer in the environment. Pathix cannot say they fire for this table, so they are not listed.",
      );
      expect(unresolvedTableStepsText(1, "Create")).toBe(
        "1 plugin step registered for Create is bound to a table the platform does not name, often one no longer in the environment. Pathix cannot say it fires for this table, so it is not listed.",
      );
    });

    it("lists none of them: they are only counted", () => {
      const model = unresolved(1568);
      const listed = model.sections.flatMap((section) => (section.kind === "list" ? [...section.items, ...section.microsoft] : []));
      expect(listed).toEqual([]);
    });

    it("never says Nothing is registered to fire while some are counted", () => {
      expect(unresolved(3).headline).toBe("Nothing Pathix can tie to this table is registered to fire on this save.");
      expect(unresolved(0, { disclosures: ["registeredNotWrites"] }).headline).toBe("Nothing is registered to fire on this save.");
      // What is listed is still counted as found; the count stays in the disclosure.
      expect(unresolved(3, { lanes: lanes({ PostOperation: [entry()] }) }).headline).toBe("1 registered to fire on the server.");
    });

    it("says the count even if the code is missing, and keeps the plain sentence when no count came", () => {
      expect(unresolved(2, { disclosures: ["registeredNotWrites"] }).disclosures[1]).toContain("2 plugin steps registered for Update");
      // A Pathix that sends the code with no count: the sentence without a number, never "0".
      expect(unresolved(undefined).disclosures[1]).toBe(disclosureText("unresolvedTableStepsNotListed"));
      expect(unresolved(undefined).disclosures[1]).not.toMatch(/\d/);
    });

    it("reads an answer from an older Pathix, which sends no count", () => {
      const model = unresolved(undefined, { disclosures: ["registeredNotWrites"] });
      expect(model.kind).toBe("known");
      expect(model.headline).toBe("Nothing is registered to fire on this save.");
    });

    it("takes a count that is not a number as an answer not in the contract's shape", () => {
      const answer = { ...pipeline(), unresolvedTableSteps: "3" };
      expect(buildSavePreview(context, { kind: "ok", data: answer }).kind).toBe("unknown");
    });
  });

  it("states the single-hop, platform-feature and flow-scope limits in words", () => {
    expect(disclosureText("cascadesNotFollowed")).toContain("Single hop");
    expect(disclosureText("platformFeaturesNotListed")).toMatch(/autonumber.*duplicate detection.*rollups/);
    expect(disclosureText("flowScopeNotModeled")).toContain("owner or business unit scope");
    expect(disclosureText("registeredNotWrites")).toContain("Registered to fire is not the same as writes");
  });
});

// --- the client layer ------------------------------------------------------------------------------

describe("the client layer", () => {
  const withLayer = (clientLayer: SavePipeline["clientLayer"], overrides: Partial<SavePreviewContext> = {}) =>
    listOf(modelOf(pipeline({ clientLayer }), overrides), "client");

  it("comes before the server lanes", () => {
    expect(modelOf(pipeline()).sections[0]).toMatchObject({ kind: "list", id: "client" });
  });

  it("lists OnSave handlers with library and function, tags the platform's own, and is not a sequence", () => {
    const client = withLayer({
      formId: FORM,
      coverage: "modeled",
      notModeledReason: null,
      ordered: false,
      handlers: [
        { library: "new_/account.js", function: "Account.onSave", isEnabled: true, isPlatformLoaded: false, scriptComponentId: ids(7) },
        { library: "msdyn_/internal.js", function: "Platform.save", isEnabled: false, isPlatformLoaded: true, scriptComponentId: null },
        { library: null, function: null, isEnabled: null, isPlatformLoaded: false, scriptComponentId: null },
      ],
    });
    expect(client.count).toBe(3);
    expect(client.unordered).toBe(true);
    expect(client.notes[0]).toBe("Not a sequence: Pathix does not keep the order of a form's handlers.");
    expect(client.items.map((item) => `${item.name} | ${item.lines[0]} | ${item.tags.join(",")}`)).toEqual([
      "Account.onSave | new_/account.js | ",
      "Platform.save | msdyn_/internal.js | disabled,loaded by the platform",
      "Unnamed function | Library not stated | enabled state unknown",
    ]);
  });

  it("says a form that registers no OnSave handler registers none in the scan", () => {
    const client = withLayer({ formId: FORM, coverage: "modeled", notModeledReason: null, ordered: false, handlers: [] });
    expect(client.count).toBe(0);
    expect(client.emptyLine).toBe("Pathix's scan shows this form registers no OnSave handler.");
  });

  it("notes that handlers script adds at run time are not listed", () => {
    const client = withLayer({ formId: FORM, coverage: "modeled", notModeledReason: null, ordered: false, handlers: [] });
    expect(client.notes.join(" ")).toContain("add");
  });

  it.each([
    ["formNotFound", "no form with this id"],
    ["handlersNotRecorded", "recorded no form handlers for any form"],
    ["formNotParsed", "could not read this form's definition"],
    [null, "did not model"],
    ["aReasonFromTheFuture", "did not model"],
  ])("reads notModeled (%s) as unknown, never as an empty list", (reason, words) => {
    const client = withLayer({ formId: FORM, coverage: "notModeled", notModeledReason: reason, ordered: false, handlers: null });
    expect(client.count).toBeNull();
    expect(client.items).toEqual([]);
    expect(client.emptyLine).toBeNull();
    expect(client.unknownLine).toContain(words);
  });

  it("reads a modeled layer with no handler list as unknown", () => {
    const client = withLayer({ formId: FORM, coverage: "modeled", notModeledReason: null, ordered: false, handlers: null });
    expect(client.unknownLine).not.toBeNull();
    expect(client.count).toBeNull();
  });

  it("is unknown when the page did not say which form is open", () => {
    const client = withLayer(null, { formRequested: false });
    expect(client.unknownLine).toContain("did not say which form is open");
  });

  it("is unknown when Pathix returns no layer for a form that was asked about", () => {
    expect(withLayer(null).unknownLine).toContain("did not return");
  });

  it("is a sequence only if Pathix says the order is kept", () => {
    const client = withLayer({ formId: FORM, coverage: "modeled", notModeledReason: null, ordered: true, handlers: [] });
    expect(client.unordered).toBe(false);
  });
});

// --- what the save was matched against ----------------------------------------------------------------

describe("the inputs line", () => {
  it("lists the columns an update was matched against, and labels them live", () => {
    const model = modelOf(pipeline({ columns: ["creditlimit", "name"] }), { columnsSent: ["creditlimit", "name"] });
    expect(model.inputs).toEqual({
      text: "Update. Matched on the columns this save sends: creditlimit, name. These are the columns you edited and those the form always submits.",
      live: true,
      columns: {
        lead: "Update. Matched on the columns this save sends:",
        names: ["creditlimit", "name"],
        more: 0,
        trail: "These are the columns you edited and those the form always submits.",
      },
    });
  });

  it("names a single column in a sentence that reads naturally, and caps a long list", () => {
    expect(modelOf(pipeline({ columns: ["sic"] }), { columnsSent: ["sic"] }).inputs.text).toBe(
      "Update. Matched on the columns this save sends: sic. These are the columns you edited and those the form always submits.",
    );
    const many = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    const inputs = modelOf(pipeline({ columns: many }), { columnsSent: many }).inputs;
    expect(inputs.columns).toMatchObject({ names: ["c0", "c1", "c2", "c3", "c4", "c5"], more: 2 });
    expect(inputs.text).toContain("c5 +2 more.");
  });

  it("sets each column in code style, from text nodes only", () => {
    const view = readFileSync("src/content/save-preview-view.ts", "utf8");
    expect(view).toContain('line.append(element("code", "code", name));');
    expect(view).toMatch(/\.code \{[^}]*monospace/);
  });

  it("says an update with no edits lists everything registered, with each filter", () => {
    const model = modelOf(pipeline({ browseMode: true, columns: null }), { columnsSent: [] });
    expect(model.inputs.text).toBe("Update with no edits yet. Everything registered for Update is listed, with each filter.");
  });

  it("says when there were too many columns to send", () => {
    const model = modelOf(pipeline({ browseMode: true, columns: null }), { columnsSent: [], columnsWithheld: 400 });
    expect(model.inputs.text).toContain("400 columns, too many to send");
  });

  it("says a create uses no columns", () => {
    const model = modelOf(pipeline({ message: "Create", columns: null }), { message: "Create", columnsSent: [] });
    expect(model.inputs).toEqual({ text: "Create. The platform ignores columns on a create, so none are used.", live: false });
  });
});

describe("the status line", () => {
  it("uses the scan Pathix answered from, and falls back to the connection's scan date", () => {
    expect(modelOf(pipeline()).status).toBe("As of Oct 2");
    expect(modelOf(pipeline({ scope: { environmentId: ENV, scanId: ids(2), scannedAt: null } }), { scanCompletedAt: null }).status).toBe("No Completed scan yet");
  });
});

// --- a request that failed ----------------------------------------------------------------------------

describe("an answer that did not come", () => {
  const failed = (status?: number, detail?: string) => buildSavePreview(context, { kind: "failed", status, ...(detail === undefined ? {} : { detail }) });

  it("reads Pathix's typed 404 as the scan not holding the table", () => {
    expect(failed(404, "Table account is not in the latest scan.").headline).toContain("does not hold the table account");
  });

  // A route miss (an empty 404 body) is an older Pathix, and says nothing about the table.
  it("reads a 404 with no body as a Pathix that may be older, asserting nothing about the table", () => {
    for (const detail of [undefined, "", "  "]) {
      const model = failed(404, detail);
      expect(model.kind).toBe("unknown");
      expect(model.headline).toBe("Pathix does not offer the save preview. It may be older than this extension, so what is registered to fire is unknown.");
      expect(model.headline).not.toContain("account");
    }
  });

  it.each([
    [404, "may be older than this extension"],
    [400, "did not accept this request"],
    [500, "Could not get the save preview from Pathix"],
    [undefined, "Could not get the save preview from Pathix"],
  ])("is unknown for HTTP %s, never 'nothing fires'", (status, words) => {
    const model = failed(status);
    expect(model.kind).toBe("unknown");
    expect(model.headline).toContain(words);
    expect(model.headline).toContain("unknown");
    expect(model.headline).not.toMatch(/^Nothing is registered/);
    expect(model.sections).toEqual([]);
    expect(model.disclosures).toEqual([]);
  });

  it("still says what the preview was asked about", () => {
    expect(failed().inputs.text).toContain("Matched on the columns this save sends: creditlimit");
  });

  it.each([null, "text", 42, {}, { lanes: "no" }, { ...pipeline(), lanes: [{ lane: "PreValidation" }] }, { ...pipeline(), lanes: [{ lane: "PreValidation", ordered: true, entries: [] }] }, { ...pipeline(), lanes: [{ lane: "PreValidation", stage: "10", kind: "pipeline", ordered: true, entries: [] }] }, { ...pipeline(), unplaced: [{}] }, { ...pipeline(), disclosures: [1] }])(
    "treats an answer that is not the contract's shape as unknown (%#)",
    (data) => {
      const model = buildSavePreview(context, { kind: "ok", data });
      expect(model.kind).toBe("unknown");
      expect(model.headline).toContain("not in the shape");
      expect(model.sections).toEqual([]);
    },
  );
});

describe("a lane that is missing from the answer", () => {
  it("is unknown, not empty", () => {
    const model = modelOf(pipeline({ lanes: lanes().filter((each) => each.lane !== "Asynchronous") }));
    const lane = listOf(model, "Asynchronous");
    expect(lane.count).toBeNull();
    expect(lane.unknownLine).toContain("did not include this lane");
    expect(lane.emptyLine).toBeNull();
  });

  it("is unknown at its own place in the timeline, and the save marker stays where the main operation is", () => {
    const model = modelOf(pipeline({ clientLayer: NO_HANDLERS, lanes: lanes({ PostOperation: [entry()] }).filter((each) => each.lane !== "MainOperation") }));
    expect(model.sections.map((section) => (section.kind === "save" ? "SAVE" : section.id))).toEqual([
      "client",
      "PreValidation",
      "PreOperation",
      "SAVE",
      "MainOperation",
      "PostOperation",
      "Asynchronous",
      "rules",
      "unplaced",
    ]);
    expect(listOf(model, "MainOperation").unknownLine).toContain("did not include this lane");
    expect(model.headline).toBe("1 registered to fire on the server. Unknown: the main operation lane.");
  });

  it("puts a lane that is missing by its stage number, around an internal lane", () => {
    const withInternal = lanes({}, [lane("InternalPostOperationBeforeExternalPlugins", 35, "platformInternal", [entry()])]).filter((each) => each.lane !== "PostOperation" && each.lane !== "Asynchronous");
    const ids = modelOf(pipeline({ lanes: withInternal })).sections.map((section) => (section.kind === "save" ? "SAVE" : section.id));
    expect(ids.slice(-5)).toEqual(["InternalPostOperationBeforeExternalPlugins", "PostOperation", "Asynchronous", "rules", "unplaced"]);
  });
});

describe("copy", () => {
  it("has no em dash and no claim that anything writes or will run, outside the disclosure that denies it", () => {
    const model = modelOf(
      pipeline({
        lanes: lanes({ PreOperation: [entry({ orderUnknown: true, executionOrder: null })], Asynchronous: [entry()] }),
        unplaced: [entry()],
        serverBusinessRules: [{ componentId: ids(9), componentName: "R", isSystem: false }],
        excludedDisabled: 1,
        clientLayer: { formId: FORM, coverage: "notModeled", notModeledReason: "formNotFound", ordered: false, handlers: null },
        disclosures: ["registeredNotWrites", "asyncUnordered", "cascadesNotFollowed", "platformFeaturesNotListed", "flowScopeNotModeled", "clientOrderNotKept"],
      }),
    );
    for (const text of [...textOf(model), ...model.disclosures, ...model.info]) expect(text).not.toContain("—");
    expect(textOf(model).join("\n")).not.toMatch(/\bwrites?\b|will run|will fire/i);
  });

  it("gives Lite a footer line that names the blind spot, then what Pathix does", () => {
    expect(SAVE_PREVIEW_TIP.href).toBe(PATHIX_SITE);
    expect(SAVE_PREVIEW_LITE_LINE).toContain("needs Pathix");
  });
});

// --- the request path, and what a cache key looks like -----------------------------------------------------

describe("the request", () => {
  const base = { environmentId: ENV, table: "account", message: "Update" as const, formId: FORM };

  it("sends the table, message, form and the sorted, distinct, lower-case column names", () => {
    const { path, columnsSent, columnsWithheld } = savePipelinePath({ ...base, columns: ["name", "creditlimit", "Name", "creditlimit"] });
    expect(columnsSent).toEqual(["creditlimit", "name"]);
    expect(columnsWithheld).toBe(0);
    expect(path).toBe(`/tables/account/save-pipeline?environmentId=${ENV}&message=Update&columns=creditlimit%2Cname&formId=${FORM}`);
  });

  it("asks for the same path however the same set is ordered, so it is one cache key", () => {
    const a = savePipelinePath({ ...base, columns: ["b", "a", "c"] }).path;
    const b = savePipelinePath({ ...base, columns: ["c", "b", "a", "a"] }).path;
    expect(a).toBe(b);
    expect(savePipelinePath({ ...base, columns: ["a", "b"] }).path).not.toBe(a);
  });

  it("omits columns on a create, whatever the page has dirty, so every create shares one key", () => {
    const one = savePipelinePath({ ...base, message: "Create", columns: ["name"] });
    const two = savePipelinePath({ ...base, message: "Create", columns: ["creditlimit", "name"] });
    expect(one.path).toBe(two.path);
    expect(one.path).not.toContain("columns=");
    expect(one.path).toContain("message=Create");
  });

  it("omits columns on an update with none, which Pathix reads as browse mode", () => {
    expect(savePipelinePath({ ...base, columns: [] }).path).not.toContain("columns=");
  });

  it("omits the form when the page named none", () => {
    expect(savePipelinePath({ ...base, columns: ["a"], formId: null }).path).not.toContain("formId");
  });

  it("asks for everything registered, and says so, when the column names are too many to send", () => {
    const many = Array.from({ length: 500 }, (_, index) => `new_column_number_${index}`);
    expect(many.join(",").length).toBeGreaterThan(MAX_COLUMN_CHARS);
    const { path, columnsSent, columnsWithheld } = savePipelinePath({ ...base, columns: many });
    expect(columnsSent).toEqual([]);
    expect(columnsWithheld).toBe(500);
    expect(path).not.toContain("columns=");
  });

  it("sends names only: the path holds no value-shaped text", () => {
    const { path } = savePipelinePath({ ...base, columns: ["name"] });
    expect(path).toMatch(/^\/tables\/account\/save-pipeline\?environmentId=[0-9a-f-]+&message=Update&columns=name&formId=[0-9a-f-]+$/);
  });
});

describe("saveColumns", () => {
  it("is the dirty columns plus the always-submitted ones, sorted and distinct", () => {
    expect(saveColumns(["name", "creditlimit"], ["statecode", "name"])).toEqual(["creditlimit", "name", "statecode"]);
    expect(saveColumns([], [])).toEqual([]);
  });

  it("is empty with no edits, even when the form always submits columns, so the request is browse mode", () => {
    expect(saveColumns([], ["statecode", "name"])).toEqual([]);
  });
});

describe("the response cache, with a key per set of edited columns", () => {
  it("keeps at most the number of answers it is told to, dropping the oldest first", async () => {
    const { ResponseCache } = await import("../src/background/cache");
    const inner = vi.fn(async (path: string) => ({ ok: true as const, data: path }));
    const get = new ResponseCache(60_000, Date.now, 2).wrap(inner as unknown as Get, "scan-1");
    await get("/a");
    await get("/b");
    await get("/c");
    expect(inner).toHaveBeenCalledTimes(3);
    await get("/c");
    await get("/b");
    expect(inner).toHaveBeenCalledTimes(3);
    await get("/a");
    expect(inner).toHaveBeenCalledTimes(4);
  });

  it("does not let a long edit session grow the cache without a bound", async () => {
    const { ResponseCache } = await import("../src/background/cache");
    const inner = vi.fn(async (path: string) => ({ ok: true as const, data: path }));
    const get = new ResponseCache(60_000, Date.now, 5).wrap(inner as unknown as Get, "scan-1");
    for (let index = 0; index < 50; index++) await get(`/save/${index}`);
    await get("/save/0");
    expect(inner).toHaveBeenCalledTimes(51);
  });
});

describe("loadSavePreview", () => {
  const load = { ...{ environmentId: ENV, environmentName: "Contoso", scanCompletedAt: "2026-10-03T02:30:00Z", table: "account", message: "Update" as const, columns: ["creditlimit"], formId: FORM }, formatDate: () => "Oct 2" };
  const getReturning = (result: unknown) => {
    const paths: string[] = [];
    const get = (async (path: string) => {
      paths.push(path);
      return result;
    }) as unknown as Get;
    return { get, paths };
  };

  it("makes one request and builds the model from the answer", async () => {
    const { get, paths } = getReturning({ ok: true, data: pipeline({ clientLayer: NO_HANDLERS, lanes: lanes({ PostOperation: [entry()] }) }) });
    const response = await loadSavePreview(load, get);
    expect(paths).toHaveLength(1);
    expect(response.kind === "savePreview" && response.model.headline).toBe("1 registered to fire on the server.");
    expect(response.kind === "savePreview" && response.model.inputs.text).toContain("creditlimit");
  });

  it("is a sign-in problem, not an empty preview, when signed out or refused", async () => {
    expect(await loadSavePreview(load, getReturning({ ok: false, kind: "signedOut" }).get)).toEqual({ kind: "status", status: { kind: "signedOut", reason: "no token" } });
    expect(await loadSavePreview(load, getReturning({ ok: false, kind: "unauthorized", status: 403 }).get)).toEqual({ kind: "status", status: { kind: "unauthorized", status: 403 } });
  });

  it("reads a typed 404 as unknown for this table, a route miss as an older Pathix, and a thrown-away request as unknown", async () => {
    const typed = { ok: false as const, kind: "failed" as const, message: "Pathix answered 404.", status: 404, detail: "Table account is not in the latest scan." };
    const notFound = await loadSavePreview(load, getReturning(typed).get);
    expect(notFound.kind === "savePreview" && notFound.model.kind).toBe("unknown");
    expect(notFound.kind === "savePreview" && notFound.model.headline).toContain("does not hold the table account");
    const miss = await loadSavePreview(load, getReturning({ ok: false, kind: "failed", message: "Pathix answered 404.", status: 404 }).get);
    expect(miss.kind === "savePreview" && miss.model.headline).toContain("may be older than this extension");
    const down = await loadSavePreview(load, getReturning({ ok: false, kind: "failed", message: "network down" }).get);
    expect(down.kind === "savePreview" && down.model.headline).toContain("Could not get the save preview");
  });

  it("passes the columns it withheld to the model", async () => {
    const many = Array.from({ length: 500 }, (_, index) => `new_column_number_${index}`);
    const { get } = getReturning({ ok: true, data: pipeline({ browseMode: true, columns: null }) });
    const response = await loadSavePreview({ ...load, columns: many }, get);
    expect(response.kind === "savePreview" && response.model.inputs.text).toContain("500 columns, too many to send");
  });

  it("goes through the response cache once per distinct set of columns", async () => {
    const { ResponseCache } = await import("../src/background/cache");
    const inner = vi.fn(async () => ({ ok: true as const, data: pipeline() }));
    const get = new ResponseCache(60_000).wrap(inner as unknown as Get, "scan-1");
    await loadSavePreview({ ...load, columns: ["b", "a"] }, get);
    await loadSavePreview({ ...load, columns: ["a", "b"] }, get);
    await loadSavePreview({ ...load, columns: ["a"] }, get);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

// --- the message the content script sends ----------------------------------------------------------------------

describe("isSavePreviewRequest", () => {
  const valid = { kind: "savePreview", organizationId: ids(3), host: "contoso.crm.dynamics.com", table: "account", message: "Update", formId: FORM, columns: ["name", "creditlimit"] };

  it("accepts names and a form id", () => {
    expect(isSavePreviewRequest(valid)).toBe(true);
    expect(isSavePreviewRequest({ ...valid, formId: null })).toBe(true);
    expect(isSavePreviewRequest({ ...valid, message: "Create", columns: [] })).toBe(true);
  });

  it.each([
    ["the record id", { recordId: ids(9) }],
    ["a value", { values: { name: "Contoso" } }],
    ["the page address", { url: "https://contoso.crm.dynamics.com/main.aspx?id=1" }],
  ])("rejects a request that also carries %s", (_label, extra) => {
    expect(isSavePreviewRequest({ ...valid, ...extra })).toBe(false);
  });

  it.each([
    ["a value in place of a name", { columns: ["Contoso Ltd"] }],
    ["a name and value pair", { columns: [{ name: "Contoso" }] }],
    ["an email address", { columns: ["dana@contoso.com"] }],
    ["columns on a create, where none are sent", { message: "Create", columns: ["name"] }],
    ["another message", { message: "Delete" }],
    ["a message in lower case", { message: "update" }],
    ["a form id that is not a GUID", { formId: "Account main form" }],
    ["a table that is not a logical name", { table: "Contoso Ltd" }],
    ["a host with a path", { host: "contoso.crm.dynamics.com/main.aspx" }],
    ["too many columns", { columns: Array.from({ length: 2001 }, () => "name") }],
  ])("rejects %s", (_label, change) => {
    expect(isSavePreviewRequest({ ...valid, ...change })).toBe(false);
  });

  it.each([null, undefined, "savePreview", 42, []])("rejects %s", (value) => {
    expect(isSavePreviewRequest(value)).toBe(false);
  });
});

// --- the controller ---------------------------------------------------------------------------------------------

describe("the controller", async () => {
  const { SavePreviewController } = await import("../src/content/save-preview-controller");
  type Sources = import("../src/content/save-preview-controller").SavePreviewSources;

  const snapshot = (overrides: Partial<FormSnapshot> = {}) =>
    ({
      organizationId: ids(3),
      host: "contoso.crm.dynamics.com",
      table: "account",
      formId: FORM,
      saveKind: "update",
      dirtyColumns: ["name"],
      alwaysSubmitColumns: ["statecode"],
      ...overrides,
    }) as unknown as FormSnapshot;

  const knownModel = (): SavePreviewModel => modelOf(pipeline({ clientLayer: NO_HANDLERS }));

  function harness(options: { mode?: "lite" | "connected"; showTips?: boolean; answer?: ReturnType<Sources["savePreview"]> } = {}) {
    const calls: string[] = [];
    const requests: unknown[] = [];
    const pending: Array<(value: Awaited<ReturnType<Sources["savePreview"]>>) => void> = [];
    const view = {
      setOnClose: () => undefined,
      setOnHideTips: () => undefined,
      showMessage: (message: string) => calls.push(`message: ${message}`),
      showLite: (message: string, tip: unknown) => calls.push(`lite: ${tip ? "tip" : "no tip"}`),
      showPreview: (model: SavePreviewModel) => calls.push(`preview: ${model.headline}`),
      hide: () => calls.push("hide"),
    };
    const sources: Sources = {
      settings: async () => ({ mode: options.mode ?? "connected", showTips: options.showTips ?? true }),
      savePreview: (request) => {
        requests.push(request);
        return options.answer ?? new Promise((resolve) => pending.push(resolve));
      },
      hideTips: async () => undefined,
    };
    return { controller: new SavePreviewController(view as never, sources), calls, requests, pending };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("sends the table, Update, the form and the sorted names of the dirty and always-submitted columns, and nothing else", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot({ dirtyColumns: ["name", "creditlimit"], alwaysSubmitColumns: ["statecode", "name"] }));
    controller.open();
    await settle();
    expect(requests).toEqual([
      { kind: "savePreview", organizationId: ids(3), host: "contoso.crm.dynamics.com", table: "account", message: "Update", formId: FORM, columns: ["creditlimit", "name", "statecode"] },
    ]);
    expect(isSavePreviewRequest(requests[0])).toBe(true);
  });

  it("sends no columns for an update with no edits, though the form always submits some (browse mode)", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot({ dirtyColumns: [], alwaysSubmitColumns: ["statecode"] }));
    controller.open();
    await settle();
    expect(requests).toEqual([expect.objectContaining({ message: "Update", columns: [] })]);
    // The first edit narrows the answer, and the always-submitted column goes with it.
    controller.setSnapshot(snapshot({ dirtyColumns: ["name"], alwaysSubmitColumns: ["statecode"] }));
    await settle();
    expect(requests).toHaveLength(2);
    expect((requests[1] as { columns: string[] }).columns).toEqual(["name", "statecode"]);
  });

  it("sends Create with no columns", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot({ saveKind: "create" }));
    controller.open();
    await settle();
    expect(requests).toEqual([expect.objectContaining({ message: "Create", columns: [] })]);
  });

  it("draws the preview Pathix answered", async () => {
    const { controller, calls, pending } = harness();
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    pending[0]!({ kind: "savePreview", model: knownModel() });
    await settle();
    expect(calls.at(-1)).toBe("preview: Nothing is registered to fire on this save.");
  });

  it("runs again when a column becomes edited, but not when the same set is posted again", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    controller.setSnapshot(snapshot());
    expect(requests).toHaveLength(1);
    controller.setSnapshot(snapshot({ dirtyColumns: ["name", "creditlimit"] }));
    await settle();
    expect(requests).toHaveLength(2);
    expect((requests[1] as { columns: string[] }).columns).toEqual(["creditlimit", "name", "statecode"]);
  });

  it("runs again when the form turns from create to update, and when the form changes", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot({ saveKind: "create" }));
    controller.open();
    await settle();
    controller.setSnapshot(snapshot({ saveKind: "update" }));
    await settle();
    controller.setSnapshot(snapshot({ saveKind: "update", formId: ids(22) }));
    await settle();
    expect(requests).toHaveLength(3);
  });

  it("does not run again for an edit on a create, where the columns do not matter", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot({ saveKind: "create", dirtyColumns: [] }));
    controller.open();
    await settle();
    controller.setSnapshot(snapshot({ saveKind: "create", dirtyColumns: ["name"] }));
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("draws nothing for an answer that arrives after the edits changed", async () => {
    const { controller, calls, pending } = harness();
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    controller.setSnapshot(snapshot({ dirtyColumns: ["name", "creditlimit"] }));
    await settle();
    pending[0]!({ kind: "savePreview", model: modelOf(pipeline({ excludedDisabled: 9 })) });
    await settle();
    expect(calls.filter((call) => call.startsWith("preview"))).toEqual([]);
    pending[1]!({ kind: "savePreview", model: knownModel() });
    await settle();
    expect(calls.filter((call) => call.startsWith("preview"))).toEqual(["preview: Nothing is registered to fire on this save."]);
  });

  it("draws nothing for an answer that arrives after the panel was closed", async () => {
    const { controller, calls, pending } = harness();
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    controller.close();
    pending[0]!({ kind: "savePreview", model: knownModel() });
    await settle();
    expect(calls.filter((call) => call.startsWith("preview"))).toEqual([]);
    expect(calls.at(-1)).toBe("hide");
  });

  it("does not re-run while closed", async () => {
    const { controller, requests } = harness();
    controller.setSnapshot(snapshot());
    controller.setSnapshot(snapshot({ dirtyColumns: ["a"] }));
    await settle();
    expect(requests).toEqual([]);
  });

  it("shows a sign-in problem as a message, never as an empty preview", async () => {
    const { controller, calls } = harness({ answer: Promise.resolve({ kind: "status", status: { kind: "signedOut", reason: "no token" } }) });
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    expect(calls.at(-1)).toBe("message: Signed out of Pathix. Sign in from the extension's options to see what Pathix found.");
  });

  it("says the extension did not answer when the worker does not", async () => {
    const { controller, calls } = harness({ answer: Promise.reject(new Error("no worker")) });
    controller.setSnapshot(snapshot());
    controller.open();
    await settle();
    expect(calls.at(-1)).toBe("message: The extension did not answer. Reload the page and try again.");
    expect(calls.some((call) => call.startsWith("preview"))).toBe(false);
  });

  it("asks Pathix for nothing in Lite, and shows the Lite line with the tip only when settings say so", async () => {
    const withTip = harness({ mode: "lite", showTips: true });
    withTip.controller.setSnapshot(snapshot());
    withTip.controller.open();
    await settle();
    expect(withTip.requests).toEqual([]);
    expect(withTip.calls.at(-1)).toBe("lite: tip");

    const noTip = harness({ mode: "lite", showTips: false });
    noTip.controller.setSnapshot(snapshot());
    noTip.controller.open();
    await settle();
    expect(noTip.calls.at(-1)).toBe("lite: no tip");
  });

  it("asks for a form first", async () => {
    const { controller, calls } = harness();
    controller.open();
    await settle();
    expect(calls).toEqual(["message: Open a record form to preview its save."]);
  });

  it("makes no request for a form that cannot be saved as it is open", async () => {
    const { controller, calls, requests } = harness();
    controller.setSnapshot(snapshot({ saveKind: null }));
    controller.open();
    await settle();
    expect(requests).toEqual([]);
    expect(calls.at(-1)).toContain("no save to preview");
  });
});
