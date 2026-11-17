// When a connected-card writer runs, as plain data, tested without a DOM.
//
// Pathix serves every trigger of a writer on its field-writers row,
// with the facts that scope it: the filtering columns, "fires on every update"
// and, for a cloud flow, whether a row filter is set. A plugin
// step's images come from its registration.
//
// Names only: column logical names, image names and aliases. A flow's row
// filter is reported as set or not set; its predicate is never read.
//
// An older Pathix omits the newer fields. A missing field is unknown and says
// nothing; it is never read as "no filter" or "no images" (DESIGN.md, "Absence
// is not evidence").

import type { ComponentRegistration, FieldWriter, StepImage, TriggerSummary } from "../pathix/api";

/** Trigger lines listed under a writer before "+N more triggers". */
export const MAX_TRIGGER_LINES = 3;
/** Column names listed in a "fires when" line before "+N more". */
const MAX_LISTED_COLUMNS = 4;

/** One trigger of a writer, for the card. */
export interface TriggerLine {
  /** When it runs, e.g. "On Update · Post-op · Async". */
  label: string;
  /** What scopes it, e.g. "Fires when creditlimit changes" or "Fires when creditlimit, name change"; null when Pathix recorded no scope to state. */
  scope: string | null;
  /** A cloud flow's row filter: "Row filter set", "No row filter" or "Row filter unknown"; null for anything else. */
  rowFilter: string | null;
}

/** One step image, for the card. */
export interface ImageLine {
  text: string;
}

/** What a writer row shows about images: lines, or "unknown" when Pathix gave no answer. */
export type RowImages = { kind: "list"; lines: ImageLine[] } | { kind: "unknown" };

type LabelSource = {
  message: string | null;
  stage: string | null;
  executionMode: string | null;
  table?: string | null;
  primaryEntity?: string | null;
};

const STANDARD_MESSAGES = new Set([
  "Create", "Update", "UpdateMultiple", "UpdateMultipleLegacy", "Delete", "Assign", "SetState", "SetStateDynamicEntity",
  "Associate", "Disassociate", "Merge", "Qualify", "Retrieve", "RetrieveMultiple", "GrantAccess", "ModifyAccess",
  "RevokeAccess", "Route",
]);

/** The bulk spellings of Update read as the message people know; the filter facts are the same. */
const MESSAGE_WORDS: Record<string, string> = { UpdateMultiple: "update", UpdateMultipleLegacy: "update" };

/** Messages whose filtering columns say which column changes make them fire. */
const UPDATE_MESSAGES = new Set(["Update", "UpdateMultiple", "UpdateMultipleLegacy"]);

const STAGES: Record<string, string> = {
  PreValidation: "Pre-validation",
  PreOperation: "Pre-op",
  PostOperation: "Post-op",
};

const MODES: Record<string, string> = { Synchronous: "Sync", Asynchronous: "Async" };

/**
 * When a writer runs, which matters more on this card than its action (almost
 * always Update). Names the trigger's table when it is not the column's table:
 * a workflow on Contact create writing the parent account is the case people
 * miss. A custom message (a Custom API or custom action) reads "Runs as".
 * Null when the source names no message.
 */
export function triggerLabel(source: LabelSource | null, table: string): string | null {
  if (!source?.message) return null;
  const { message } = source;
  const triggerTable = source.table ?? source.primaryEntity;
  let what: string;
  if (!STANDARD_MESSAGES.has(message)) what = `Runs as ${message}`;
  else if (triggerTable && triggerTable.toLowerCase() !== table.toLowerCase()) what = `On ${triggerTable} ${wordFor(message)}`;
  else what = `On ${UPDATE_MESSAGES.has(message) ? "Update" : message}`;

  const parts = [what];
  const stage = source.stage ? STAGES[source.stage] : undefined;
  if (stage) parts.push(stage);
  const mode = source.executionMode ? MODES[source.executionMode] : undefined;
  if (mode) parts.push(mode);
  return parts.join(" · ");
}

function wordFor(message: string): string {
  return MESSAGE_WORDS[message] ?? message.toLowerCase();
}

/**
 * The trigger lines of one writer. Pathix's list on the row wins; a row from an
 * older Pathix that omits it falls back to the registration's one trigger. A
 * component with no trigger (a form, a script) has none to show.
 */
export function triggerLines(writer: FieldWriter, registration: ComponentRegistration | null, table: string): TriggerLine[] {
  const triggers = triggersOf(writer, registration);
  const isFlow = writer.componentType === "ModernFlow" || writer.componentType === "AgentFlow";
  const lines: TriggerLine[] = [];
  for (const trigger of triggers) {
    const line = lineFor(trigger, isFlow, table);
    if (line && !lines.some((seen) => sameLine(seen, line))) lines.push(line);
  }
  return lines;
}

/** Lines to draw, and how many more triggers there were. */
export function listedTriggerLines(lines: TriggerLine[]): { shown: TriggerLine[]; more: number } {
  return { shown: lines.slice(0, MAX_TRIGGER_LINES), more: Math.max(0, lines.length - MAX_TRIGGER_LINES) };
}

function triggersOf(writer: FieldWriter, registration: ComponentRegistration | null): TriggerSummary[] {
  if (writer.triggers) return writer.triggers;
  if (writer.triggers === null) return [];
  // An older Pathix: the registration is the only source, and it carries no filter facts.
  if (registration?.triggers) return registration.triggers;
  return registration ? [{ message: registration.message, stage: registration.stage, executionMode: registration.executionMode, table: registration.primaryEntity }] : [];
}

function lineFor(trigger: TriggerSummary, isFlow: boolean, table: string): TriggerLine | null {
  // A null message is a trigger Pathix does not model (a schedule, a button): say that, not "Custom".
  const label = trigger.message === null ? "Other trigger" : triggerLabel(trigger, table);
  if (!label) return null;
  // A row filter belongs to a row-change trigger. A trigger Pathix does not model
  // (message null: a schedule, a button, an HTTP request) has none to report.
  const hasFilterConcept = isFlow && trigger.message !== null;
  return { label, scope: scopeOf(trigger), rowFilter: hasFilterConcept ? rowFilterOf(trigger) : null };
}

function scopeOf(trigger: TriggerSummary): string | null {
  const columns = trigger.filteringColumns ?? [];
  if (trigger.firesOnEveryUpdate === true) return "Fires on every update";
  if (columns.length === 0) return null;
  const shown = columns.slice(0, MAX_LISTED_COLUMNS).join(", ");
  const rest = columns.length > MAX_LISTED_COLUMNS ? ` +${columns.length - MAX_LISTED_COLUMNS} more` : "";
  return trigger.message !== null && UPDATE_MESSAGES.has(trigger.message) ? firesWhen(`${shown}${rest}`, columns.length) : `${columns.length === 1 ? "Filtering column" : "Filtering columns"}: ${shown}${rest}`;
}

/**
 * "Fires when creditlimit changes", "Fires when creditlimit, name change": the
 * verb agrees with how many columns the list names, its "+N more" included.
 */
export function firesWhen(listed: string, count: number): string {
  return `Fires when ${listed} ${count === 1 ? "changes" : "change"}`;
}

function rowFilterOf(trigger: TriggerSummary): string {
  if (trigger.hasRowFilter === true) return "Row filter set";
  if (trigger.hasRowFilter === false) return "No row filter";
  return "Row filter unknown";
}

function sameLine(a: TriggerLine, b: TriggerLine): boolean {
  return a.label === b.label && a.scope === b.scope && a.rowFilter === b.rowFilter;
}

// --- step images ---------------------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = { Pre: "Pre-image", Post: "Post-image", Both: "Pre and post image" };

/**
 * A plugin step's images: type, name, alias and which columns they hold, with
 * `column` the one the card is about. Null for anything that is not a plugin
 * step. A step whose images Pathix did not give is unknown, not imageless; a
 * step captured with none lists none.
 */
export function imagesFor(writer: FieldWriter, registration: ComponentRegistration | null, column: string): RowImages | null {
  if (writer.componentType !== "PluginStep") return null;
  const images = registration?.images;
  if (!images) return { kind: "unknown" };
  return { kind: "list", lines: images.map((image) => ({ text: imageText(image, column) })) };
}

function imageText(image: StepImage, column: string): string {
  const kind = IMAGE_TYPES[image.imageType] ?? "Image";
  const name = image.name?.trim() || null;
  const alias = image.entityAlias?.trim() || null;
  const called = name ?? alias ?? "unnamed";
  const aliased = name && alias && alias !== name ? ` (alias ${alias})` : "";
  return `${kind} ${called}${aliased} · ${columnsOf(image.columns, column)}`;
}

function columnsOf(columns: string[], column: string): string {
  if (columns.length === 0) return "all columns";
  if (columns.includes(column)) return columns.length === 1 ? "this column only" : `this column and ${columns.length - 1} more`;
  return `${columns.length} ${columns.length === 1 ? "column" : "columns"}, not this one`;
}
