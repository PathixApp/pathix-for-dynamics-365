// "What is registered to fire when this record is saved", as plain data, tested
// without a DOM (M12, connected only).
//
// It shows Pathix's answer for one hop of one save: the form's
// OnSave handlers first, since they run before the request leaves the browser,
// then the server pipeline as ONE timeline: a group per lane, in the order
// Pathix sends them (the platform's stage order, Asynchronous last), with the
// save itself drawn at the MainOperation lane. Microsoft's internal stages and
// the deprecated stage are lanes like any other, tagged, never set aside.
// Entity business rules have their own list, the asynchronous lane is marked
// as unordered, and `unplaced` holds only entries whose stage or mode is
// missing. Every code Pathix sends in `disclosures` is rendered as text, and a
// code this version does not know is shown as written.
//
// The words are "registered to fire", never "writes" or "will run": a plugin
// can return early and a workflow's own conditions can skip its steps. Nothing
// here is a sequence unless Pathix says it is one. An order that is missing,
// tied, or never kept is marked, and an answer that did not arrive is unknown,
// never "nothing fires" (DESIGN.md, "Absence is not evidence").
//
// Entries Pathix marks as Microsoft-shipped (`isSystem`) are folded behind one
// toggle per list, like the connected card. The copy does not say how Pathix
// decides it: by publisher identity, with three narrow exceptions that are not
// the publisher, one of them the Microsoft-provisioned catalog (DESIGN.md,
// "Authorship comes from the publisher"). The
// extension itself never reads managed state.

import { PATHIX_SITE, type TipLine } from "./lite";
import type { SavePipeline, SavePipelineClientLayer, SavePipelineEntry, SavePipelineLane } from "../pathix/api";
import { componentKind } from "./model";
import { firesWhen } from "./triggers";

export const SAVE_PREVIEW_TITLE = "Save preview";

/** What the panel says in Lite, which has no save preview: the pipeline order is not in Dataverse metadata. */
export const SAVE_PREVIEW_LITE_LINE = "The save preview needs Pathix. Connect to your Pathix in the extension's options to see what is registered to fire when this record is saved.";

export const SAVE_PREVIEW_TIP: TipLine = {
  text: "Lite can't tell what a save runs, or in what order. Pathix lists what is registered to fire on save, in pipeline order.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

/**
 * The lanes Pathix always sends, empty or not, by stage number. A missing one is unknown, never empty.
 * The save itself is the MainOperation lane (stage 30).
 */
export const ALWAYS_PRESENT_LANES: ReadonlyArray<{ lane: string; stage: number | null; kind: string }> = [
  { lane: "PreValidation", stage: 10, kind: "pipeline" },
  { lane: "PreOperation", stage: 20, kind: "pipeline" },
  { lane: "MainOperation", stage: 30, kind: "mainOperation" },
  { lane: "PostOperation", stage: 40, kind: "pipeline" },
  { lane: "Asynchronous", stage: null, kind: "asynchronous" },
];

/** The platform's stage names (the sdkmessageprocessingstep option set) as headings. A name not here is spelled out from its words. */
const LANE_TITLES: Record<string, string> = {
  InitialPreOperation: "Initial pre-operation",
  PreValidation: "Pre-validation",
  InternalPreOperationBeforeExternalPlugins: "Internal pre-operation, before external plugins",
  PreOperation: "Pre-operation",
  InternalPreOperationAfterExternalPlugins: "Internal pre-operation, after external plugins",
  MainOperation: "Main operation",
  InternalPostOperationBeforeExternalPlugins: "Internal post-operation, before external plugins",
  PostOperation: "Post-operation",
  InternalPostOperationAfterExternalPlugins: "Internal post-operation, after external plugins",
  PostOperationDeprecated: "Post-operation (deprecated)",
  FinalPostOperation: "Final post-operation",
  PreCommit: "Pre-commit",
  PostCommit: "Post-commit",
  Asynchronous: "Asynchronous",
};

/** Column names listed in one line before "+N more". */
const MAX_LISTED_COLUMNS = 6;
/** The most characters of column names one request carries; more is a request Pathix's server could refuse. */
export const MAX_COLUMN_CHARS = 3000;

export interface PreviewChip {
  kind: string;
  label: string;
  colorType: string;
}

/** One row: a registered component, a form handler, or an entity business rule. */
export interface PreviewItem {
  chip: PreviewChip | null;
  name: string;
  /** "Order 10" or "Order unknown"; null where an order means nothing (the asynchronous lane, a handler, a rule). */
  order: string | null;
  /** What scopes it, and where it sits. */
  lines: string[];
  /** Markers, as text: "tied order", "row filter set", "all tables". */
  tags: string[];
}

export interface PreviewList {
  kind: "list";
  id: string;
  title: string;
  /** Rows in the list, folded ones included; null when the list is unknown. */
  count: number | null;
  /** True where the list is not a sequence: say so, and never draw it as one. */
  unordered: boolean;
  notes: string[];
  /** Why the list is unknown. Shown with the "?" mark, never dropped. */
  unknownLine: string | null;
  items: PreviewItem[];
  /** Microsoft-published rows, folded behind one toggle. */
  microsoft: PreviewItem[];
  /** What kind of lane this is, when it is not one a customer knows: Microsoft's internal stage, the deprecated stage, a stage this version does not know. Null otherwise. */
  laneTag: string | null;
  /** Every row is folded: the list collapses to one line with its count and opens in place. It is never dropped. */
  collapsed: boolean;
  /** Shown when the list is known and has no rows. */
  emptyLine: string | null;
}

/** The save itself. It carries no entries. */
export interface PreviewSave {
  kind: "save";
  text: string;
}

export type PreviewSection = PreviewList | PreviewSave;

export interface SavePreviewModel {
  /** "known" when Pathix answered in full; "unknown" otherwise. */
  kind: "known" | "unknown";
  table: string;
  message: "Create" | "Update";
  /** "As of <scan date>". */
  status: string;
  headline: string;
  /** The names the save was matched against, from the open form (live). */
  inputs: PreviewInputs;
  sections: PreviewSection[];
  /** Every disclosure code as a sentence. Empty only when the answer is unknown. */
  disclosures: string[];
  /** Behind the "?". */
  info: string[];
}

/**
 * What the save was matched against. `text` is the whole line as plain text.
 * When it names columns, `columns` splits it so the panel can set each
 * logical name in code style: `lead`, the names (and "+N more"), then `trail`.
 */
export interface PreviewInputs {
  text: string;
  live: boolean;
  columns?: { lead: string; names: string[]; more: number; trail: string };
}

export interface SavePreviewContext {
  environmentName: string;
  scanCompletedAt: string | null;
  table: string;
  message: "Create" | "Update";
  /** The column names sent with the request, sorted and distinct. Empty on Create. */
  columnsSent: string[];
  /** How many column names were too many to send, so the request asked for everything registered instead. 0 otherwise. */
  columnsWithheld: number;
  /** A form id went with the request. */
  formRequested: boolean;
  formatDate: (iso: string) => string;
}

/** What the request answered. `status` is the HTTP status when Pathix answered at all. */
/**
 * Pathix's answer. A failure carries the HTTP status and, on a 404, the body:
 * Pathix's typed 404 has a non-empty string body ("the scan does not hold the
 * table"); a 404 with none is a route miss, which says nothing about the table.
 */
export type SavePreviewAnswer = { kind: "ok"; data: unknown } | { kind: "failed"; status?: number; detail?: string };

const DISCLOSURE_TEXT: Record<string, string> = {
  registeredNotWrites:
    "Registered to fire is not the same as writes. A plugin can return early, and a workflow's own conditions can skip its steps.",
  asyncUnordered: "Asynchronous work has no guaranteed order. It is listed apart and is not a sequence.",
  cascadesNotFollowed:
    "Single hop only. A step here can change other rows and fire their pipelines in turn. Those are not followed.",
  platformFeaturesNotListed: "Platform features are not modeled: autonumber, duplicate detection and rollups.",
  flowScopeNotModeled:
    "A cloud flow's owner or business unit scope can skip it. Pathix does not model that scope, so a flow listed here may not fire for this user.",
  clientOrderNotKept:
    "Pathix does not keep the order of a form's handlers within an event, so the form's handlers are not shown as a sequence.",
  unresolvedTableStepsNotListed:
    "Some plugin steps are bound to a table the platform does not name, often one no longer in the environment. Pathix cannot say they fire for this table, so they are not listed.",
};

const UNRESOLVED_TABLE_STEPS = "unresolvedTableStepsNotListed";

/** One disclosure code as text. A code this version does not know is shown as written, never dropped. */
export function disclosureText(code: string): string {
  return DISCLOSURE_TEXT[code] ?? `Pathix also reported "${code}", which this version of the extension does not describe.`;
}

/**
 * The unresolved-table steps as a sentence with their count. They are counted, never listed:
 * the platform does not name their table, so Pathix cannot say they fire for this one.
 */
export function unresolvedTableStepsText(count: number, message: string): string {
  const one = count === 1;
  return (
    `${count} plugin ${one ? "step" : "steps"} registered for ${message} ${one ? "is" : "are"} bound to a table the platform does not name, often one no longer in the environment. ` +
    `Pathix cannot say ${one ? "it fires" : "they fire"} for this table, so ${one ? "it is" : "they are"} not listed.`
  );
}

/**
 * Every code as a sentence, in Pathix's order and none twice. The unresolved-table code carries its count
 * when Pathix sends one, and a non-zero count is said even if the code is missing.
 */
function disclosuresOf(pipeline: SavePipeline): string[] {
  const unresolved = unresolvedCount(pipeline);
  const codes = [...new Set(pipeline.disclosures)];
  if (unresolved > 0 && !codes.includes(UNRESOLVED_TABLE_STEPS)) codes.push(UNRESOLVED_TABLE_STEPS);
  return codes.map((code) => (code === UNRESOLVED_TABLE_STEPS && unresolved > 0 ? unresolvedTableStepsText(unresolved, pipeline.message) : disclosureText(code)));
}

/** 0 when Pathix sent no count: an older Pathix listed these steps in the lanes as "all tables". */
function unresolvedCount(pipeline: SavePipeline): number {
  return pipeline.unresolvedTableSteps ?? 0;
}

const INFO: string[] = [
  "Pathix's answer, from its latest Completed scan. It is not read live from Dataverse.",
  "It shows what is registered to fire on one save, one hop. What those steps change on other rows, and what that fires in turn, is not followed.",
  "Registered to fire is not the same as runs or writes. A step can return early, and a workflow can skip its steps on its own conditions.",
  "Entries Pathix marks as Microsoft-shipped are folded.",
  "The columns come from the open form as names only: the edited ones, and those the form always submits. No value and no record id leave the page.",
];

// --- the model -----------------------------------------------------------------

export function buildSavePreview(context: SavePreviewContext, answer: SavePreviewAnswer): SavePreviewModel {
  const status = context.scanCompletedAt ? `As of ${context.formatDate(context.scanCompletedAt)}` : "No Completed scan yet";
  const base = {
    table: context.table,
    message: context.message,
    status,
    inputs: inputsLine(context, null),
    sections: [] as PreviewSection[],
    disclosures: [] as string[],
    info: INFO,
  };
  const unknown = (headline: string): SavePreviewModel => ({ ...base, kind: "unknown", headline });

  if (answer.kind === "failed") return unknown(failureLine(context, answer.status, answer.detail));
  if (!isSavePipeline(answer.data)) return unknown("Pathix's answer was not in the shape this extension expects, so what is registered to fire is unknown.");

  const pipeline = answer.data;
  const scanned = pipeline.scope?.scannedAt ?? context.scanCompletedAt;
  const sections = sectionsOf(pipeline, context);
  return {
    kind: "known",
    table: context.table,
    message: context.message,
    status: scanned ? `As of ${context.formatDate(scanned)}` : status,
    headline: headlineFor(pipeline, sections),
    inputs: inputsLine(context, pipeline),
    sections,
    disclosures: disclosuresOf(pipeline),
    info: INFO,
  };
}

function failureLine(context: SavePreviewContext, status: number | undefined, detail: string | undefined): string {
  if (status === 404 && (detail ?? "").trim() !== "") {
    return `Pathix's latest Completed scan does not hold the table ${context.table}, so what is registered to fire when it is saved is unknown. This is not "nothing fires".`;
  }
  if (status === 404) {
    return "Pathix does not offer the save preview. It may be older than this extension, so what is registered to fire is unknown.";
  }
  if (status === 400) return "Pathix did not accept this request, so what is registered to fire is unknown. Update the extension or Pathix and try again.";
  return "Could not get the save preview from Pathix, so what is registered to fire is unknown. This is not \"nothing fires\".";
}

const MATCHED_LEAD = "Update. Matched on the columns this save sends:";
const MATCHED_TRAIL = "These are the columns you edited and those the form always submits.";

function inputsLine(context: SavePreviewContext, pipeline: SavePipeline | null): PreviewInputs {
  if (context.message === "Create") {
    return { text: "Create. The platform ignores columns on a create, so none are used.", live: false };
  }
  const browse = pipeline ? pipeline.browseMode : context.columnsSent.length === 0;
  if (browse && context.columnsWithheld > 0) {
    return {
      text: `Update with ${context.columnsWithheld} columns, too many to send. Everything registered for Update is listed, with each filter.`,
      live: true,
    };
  }
  if (browse) {
    return { text: "Update with no edits yet. Everything registered for Update is listed, with each filter.", live: true };
  }
  const columns = pipeline?.columns ?? context.columnsSent;
  const names = columns.slice(0, MAX_LISTED_COLUMNS);
  const more = columns.length - names.length;
  return {
    text: `${MATCHED_LEAD} ${listColumns(columns)}. ${MATCHED_TRAIL}`,
    live: true,
    columns: { lead: MATCHED_LEAD, names, more, trail: MATCHED_TRAIL },
  };
}

// "Nothing" is said only when every part is known and empty. A part that is unknown is named,
// never counted as zero (DESIGN.md, "Absence is not evidence").
function headlineFor(pipeline: SavePipeline, sections: PreviewSection[]): string {
  const lists = sections.filter((section): section is PreviewList => section.kind === "list");
  const unknown = lists.filter((section) => section.unknownLine !== null).map(unknownPartName);
  const clientHandlers = lists.find((section) => section.id === "client")?.items ?? [];
  const disabledHandlers = clientHandlers.filter((item) => item.tags.includes("disabled")).length;
  const handlers = clientHandlers.length - disabledHandlers;
  const entries = pipeline.lanes.reduce((total, lane) => total + lane.entries.length, 0) + pipeline.unplaced.length;
  const rules = pipeline.serverBusinessRules.length;
  // A disabled form handler is "disabled" like a disabled server step, never counted as found.
  const disabled = pipeline.excludedDisabled + disabledHandlers;

  const found: string[] = [];
  if (handlers > 0) found.push(`${handlers} form OnSave ${handlers === 1 ? "handler" : "handlers"}`);
  if (entries > 0) found.push(`${entries} registered to fire on the server`);
  if (rules > 0) found.push(`${rules} entity business ${rules === 1 ? "rule" : "rules"} on the server`);
  const nothing = found.length === 0;
  // Steps on a table the platform does not name might fire here: "nothing" is said only of what Pathix can tie to this table.
  const nothingLine =
    unknown.length > 0
      ? "Nothing is registered in the parts Pathix answered"
      : unresolvedCount(pipeline) > 0
        ? "Nothing Pathix can tie to this table is registered to fire on this save"
        : "Nothing is registered to fire on this save";
  const parts = nothing ? [nothingLine] : found;
  if (disabled > 0) parts.push(`${disabled} disabled`);
  const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return unknown.length === 0 ? `${text}.` : `${text}. Unknown: ${unknown.join("; ")}.`;
}

function unknownPartName(section: PreviewList): string {
  return section.id === "client" ? "the form's OnSave handlers" : `the ${section.title.toLowerCase()} lane`;
}

function sectionsOf(pipeline: SavePipeline, context: SavePreviewContext): PreviewSection[] {
  const sections: PreviewSection[] = [clientSection(pipeline.clientLayer, context)];
  for (const lane of lanesInOrder(pipeline.lanes)) {
    // The save itself is the main operation lane: the marker, then whatever is registered there under it.
    if (lane.kind === "mainOperation") sections.push({ kind: "save", text: "The record is saved" });
    sections.push(laneSection(lane, pipeline));
  }
  sections.push(rulesSection(pipeline));
  sections.push(unplacedSection(pipeline));
  return sections;
}

// --- server lanes ------------------------------------------------------------------

/** A lane as drawn: the wire's lane, or a stand-in for one Pathix always sends and this answer left out. */
type DrawnLane = SavePipelineLane | { missing: true; lane: string; stage: number | null; kind: string };

/**
 * The wire's lanes in the order Pathix sent them (the platform's stage order, Asynchronous last). A lane
 * Pathix always sends but this answer left out is put in place by its stage number and shown as unknown.
 */
function lanesInOrder(lanes: SavePipelineLane[]): DrawnLane[] {
  const drawn: DrawnLane[] = [...lanes];
  for (const fixed of ALWAYS_PRESENT_LANES) {
    if (lanes.some((lane) => lane.lane === fixed.lane)) continue;
    const next = drawn.findIndex((lane) => fixed.stage !== null && (lane.stage === null || lane.stage > fixed.stage));
    drawn.splice(next === -1 ? drawn.length : next, 0, { missing: true, ...fixed });
  }
  return drawn;
}

function laneTitle(lane: DrawnLane): string {
  if (lane.kind === "unrecognized" && lane.stage !== null) return `Stage ${lane.stage}`;
  return LANE_TITLES[lane.lane] ?? words(lane.lane);
}

/** What kind of stage a lane is, when it is not one a customer knows. A kind this version does not know is shown as an unrecognized stage. */
function laneTag(lane: DrawnLane): string | null {
  const number = lane.stage === null ? "" : ` ${lane.stage}`;
  switch (lane.kind) {
    case "pipeline":
    case "mainOperation":
    case "asynchronous":
      return null;
    case "platformInternal":
      return `Microsoft internal stage${number}`;
    case "deprecated":
      return `deprecated post-operation stage${number}`;
    default:
      return `unrecognized stage${number}`;
  }
}

function laneSection(lane: DrawnLane, pipeline: SavePipeline): PreviewList {
  const title = laneTitle(lane);
  if ("missing" in lane) {
    return list(lane.lane, title, { unknownLine: "Pathix's answer did not include this lane, so what it holds is unknown." });
  }
  const rows = lane.entries.map((entry) => entryItem(entry, pipeline, lane.ordered, lane.kind === "asynchronous"));
  const section = list(lane.lane, title, {
    unordered: !lane.ordered,
    laneTag: laneTag(lane),
    notes: laneNotes(lane),
    emptyLine: "None registered in this scan.",
  });
  return split(section, lane.entries, rows);
}

function laneNotes(lane: SavePipelineLane): string[] {
  if (!lane.ordered) return ["No order. These are not a sequence."];
  const notes: string[] = [];
  if (lane.kind === "deprecated") {
    notes.push("Microsoft deprecated this stage. An older environment can still hold a customer's steps here.");
  }
  if (lane.entries.some((entry) => entry.tiedOrder)) {
    notes.push("Entries marked tied order share an order. The platform does not say which runs first.");
  }
  if (lane.entries.some((entry) => entry.orderUnknown)) {
    notes.push("Entries marked order unknown are listed after the ordered ones. Their place among them is not known.");
  }
  return notes;
}

function unplacedSection(pipeline: SavePipeline): PreviewList {
  const rows = pipeline.unplaced.map((entry) => ({ ...entryItem(entry, pipeline, true), lines: [stageLine(entry), scopeLine(entry, pipeline)] }));
  const section = list("unplaced", "Position unknown", {
    notes: [
      "Pathix has no stage, or no execution mode, for these, so where they run in the save is unknown. Listed here, not dropped and not guessed into a lane.",
    ],
    emptyLine: "None in this scan.",
  });
  return split(section, pipeline.unplaced, rows);
}

function rulesSection(pipeline: SavePipeline): PreviewList {
  const rows = pipeline.serverBusinessRules.map((rule) => ({
    chip: chipFor("BusinessRule"),
    name: rule.componentName,
    order: null,
    lines: [],
    tags: [],
  }));
  const section = list("rules", "Business rules on the server", {
    notes: ["Entity-scoped rules. Microsoft does not document where they run among the steps above, so they are listed apart, not in order."],
    emptyLine: "None in this scan.",
  });
  return split(section, pipeline.serverBusinessRules, rows);
}

/** Puts the rows into `items` or `microsoft` by the publisher flag on the source row, and counts them all. */
function split(section: PreviewList, sources: Array<{ isSystem: boolean }>, rows: PreviewItem[]): PreviewList {
  const items: PreviewItem[] = [];
  const microsoft: PreviewItem[] = [];
  rows.forEach((row, index) => (sources[index]!.isSystem ? microsoft : items).push(row));
  return { ...section, count: rows.length, items, microsoft, collapsed: items.length === 0 && microsoft.length > 0 };
}

function list(id: string, title: string, extra: Partial<PreviewList>): PreviewList {
  return { kind: "list", id, title, count: null, unordered: false, notes: [], unknownLine: null, items: [], microsoft: [], laneTag: null, collapsed: false, emptyLine: null, ...extra };
}

/** `asynchronous`: the entry sits in the unordered lane, so its own stage is said (it is not the lane's). */
function entryItem(entry: SavePipelineEntry, pipeline: SavePipeline, ordered: boolean, asynchronous = false): PreviewItem {
  const tags: string[] = [];
  // Order tags mean something only in an ordered list.
  if (ordered && entry.tiedOrder) tags.push("tied order");
  if (entry.allTables) tags.push("all tables");
  if (entry.conditional) tags.push("row filter set");
  if (entry.rowFilterUnknown) tags.push("row filter unknown");
  return {
    chip: chipFor(entry.componentType),
    name: entry.componentName,
    order: ordered ? orderOf(entry) : null,
    lines: asynchronous && entry.trigger.stage ? [scopeLine(entry, pipeline), `Registered at ${words(entry.trigger.stage).toLowerCase()}`] : [scopeLine(entry, pipeline)],
    tags,
  };
}

// A missing order is unknown, whatever the flag says; Pathix never invents one.
function orderOf(entry: SavePipelineEntry): string {
  return entry.orderUnknown || entry.executionOrder === null || entry.executionOrder === undefined
    ? "Order unknown"
    : `Order ${entry.executionOrder}`;
}

function chipFor(type: string): PreviewChip {
  const [kind, label] = componentKind(type);
  return { kind, label, colorType: type };
}

/** What scopes the entry on this save: the matched columns, "any update", or its own filter in browse mode. */
function scopeLine(entry: SavePipelineEntry, pipeline: SavePipeline): string {
  if (pipeline.message === "Create") return "Registered for Create";
  const matched = entry.matchedColumns;
  if (matched && matched.length > 0) return `Matched: ${listColumns(matched)}`;
  if (entry.trigger.firesOnEveryUpdate === true) return "Fires on any update";
  const filter = entry.trigger.filteringColumns ?? [];
  if (filter.length > 0) return firesWhen(listColumns(filter), filter.length);
  return "Column filter not stated";
}

function stageLine(entry: SavePipelineEntry): string {
  const stage = entry.trigger.stage ? words(entry.trigger.stage) : "No stage";
  const mode = entry.trigger.executionMode === "Synchronous" ? "Sync" : entry.trigger.executionMode === "Asynchronous" ? "Async" : "No mode";
  return `Stage: ${stage} · ${mode}`;
}

/** "InternalPreOperationAfterExternalPlugins" as "Internal pre operation after external plugins". */
function words(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function listColumns(columns: readonly string[]): string {
  const shown = columns.slice(0, MAX_LISTED_COLUMNS).join(", ");
  return columns.length > MAX_LISTED_COLUMNS ? `${shown} +${columns.length - MAX_LISTED_COLUMNS} more` : shown;
}

// --- the form's OnSave handlers ---------------------------------------------------

const NOT_MODELED: Record<string, string> = {
  formNotFound: "Pathix's scan has no form with this id on this table, so it cannot list this form's OnSave handlers.",
  handlersNotRecorded:
    "This scan recorded no form handlers for any form, which a scan from before handler capture also looks like. Pathix cannot say what this form registers on save.",
  formNotParsed: "Pathix could not read this form's definition, so what it registers on save is unknown.",
};

const CLIENT_TITLE = "Client: OnSave handlers on this form";
const CLIENT_NOTE = "These run in the browser before the request is sent. Handlers that script adds at run time are not in the form definition and are not listed.";

function clientSection(layer: SavePipelineClientLayer | null, context: SavePreviewContext): PreviewList {
  if (!context.formRequested) {
    return list("client", CLIENT_TITLE, { unknownLine: "The page did not say which form is open, so its OnSave handlers are unknown." });
  }
  if (!layer) return list("client", CLIENT_TITLE, { unknownLine: "Pathix did not return the form's OnSave handlers, so they are unknown." });
  if (layer.coverage !== "modeled" || !layer.handlers) {
    const reason = (layer.notModeledReason && NOT_MODELED[layer.notModeledReason]) || "Pathix did not model this form's OnSave handlers, so they are unknown.";
    return list("client", CLIENT_TITLE, { unknownLine: reason });
  }

  // Platform-loaded handlers are tagged, never hidden. They stay in the list.
  const handlers = layer.handlers.map((handler): PreviewItem => ({
    chip: chipFor("FormScript"),
    name: handler.function?.trim() || "Unnamed function",
    order: null,
    lines: [handler.library?.trim() || "Library not stated"],
    tags: [handler.isEnabled === false ? "disabled" : handler.isEnabled === null ? "enabled state unknown" : "", handler.isPlatformLoaded ? "loaded by the platform" : ""].filter(Boolean),
  }));
  return {
    ...list("client", CLIENT_TITLE, {
      unordered: !layer.ordered,
      notes: layer.ordered ? [CLIENT_NOTE] : ["Not a sequence: Pathix does not keep the order of a form's handlers.", CLIENT_NOTE],
      emptyLine: "Pathix's scan shows this form registers no OnSave handler.",
    }),
    count: handlers.length,
    items: handlers,
  };
}

// --- reading the answer -------------------------------------------------------------

/** An answer that is not the shape the contract promises is no answer. */
function isSavePipeline(data: unknown): data is SavePipeline {
  if (typeof data !== "object" || data === null) return false;
  const pipeline = data as Partial<SavePipeline>;
  return (
    Array.isArray(pipeline.lanes) &&
    pipeline.lanes.every(isLane) &&
    Array.isArray(pipeline.unplaced) &&
    pipeline.unplaced.every(isEntry) &&
    Array.isArray(pipeline.serverBusinessRules) &&
    pipeline.serverBusinessRules.every((rule) => typeof rule?.componentName === "string" && typeof rule.isSystem === "boolean") &&
    typeof pipeline.excludedDisabled === "number" &&
    (pipeline.unresolvedTableSteps === undefined || typeof pipeline.unresolvedTableSteps === "number") &&
    Array.isArray(pipeline.disclosures) &&
    pipeline.disclosures.every((code) => typeof code === "string") &&
    typeof pipeline.browseMode === "boolean" &&
    (pipeline.clientLayer === null || pipeline.clientLayer === undefined || typeof pipeline.clientLayer === "object")
  );
}

function isLane(value: unknown): value is SavePipelineLane {
  const lane = value as Partial<SavePipelineLane> | null;
  return (
    typeof lane === "object" &&
    lane !== null &&
    typeof lane.lane === "string" &&
    (lane.stage === null || typeof lane.stage === "number") &&
    typeof lane.kind === "string" &&
    typeof lane.ordered === "boolean" &&
    Array.isArray(lane.entries) &&
    lane.entries.every(isEntry)
  );
}

function isEntry(value: unknown): value is SavePipelineEntry {
  const entry = value as Partial<SavePipelineEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.componentName === "string" &&
    typeof entry.componentType === "string" &&
    typeof entry.isSystem === "boolean" &&
    typeof entry.trigger === "object" &&
    entry.trigger !== null
  );
}

/**
 * The names a save sends, for a request: sorted, lower case, distinct. With nothing edited
 * there is none: D365 sends no update for a form with no edits, so the always-submit columns
 * alone would describe a save that does not happen. The request then asks for browse mode.
 */
export function saveColumns(dirty: readonly string[], alwaysSubmit: readonly string[]): string[] {
  if (dirty.length === 0) return [];
  return [...new Set([...dirty, ...alwaysSubmit])].sort();
}

/** A fold toggle's label: "3 Microsoft-shipped entries", as Pathix marks them. */
export function microsoftEntriesLine(count: number): string {
  return count === 1 ? "1 Microsoft-shipped entry" : `${count} Microsoft-shipped entries`;
}
