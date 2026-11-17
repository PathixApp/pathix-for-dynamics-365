// Turns Pathix's answers about one column into what the hover card shows.
//
// The card mirrors the Pathix UI's graph popover and Touchpoints table in
// miniature: the same counts (writers, readers, conditional, counted the way
// the UI counts them), the same kind abbreviations and confidence vocabulary
// (DESIGN.md, "Confidence vocabulary"), and one row per writer. Everything
// explanatory sits behind the card's "?" so the face stays scannable.
//
// Every wording decision lives here as plain data, tested without a DOM.

import type {
  ComponentRegistration,
  FieldDependents,
  FieldHistory,
  FieldPermissions,
  FieldWriter,
  OpenFindingCounts,
  SecurityWritersSummary,
} from "../pathix/api";
import { freshnessOf, freshnessLine, liveRefFor, summarize, type Freshness, type LiveModified, type LiveRef, type ScanWindow } from "./freshness";
import { lockedFactsFrom, type LockedPathixFacts } from "./locked-connected";
import { imagesFor, listedTriggerLines, triggerLines, triggerLabel, type RowImages, type TriggerLine } from "./triggers";
import { tierRank } from "./writers";

export { triggerLabel };

/** Writer rows listed before "+N more"; customer forms collapse into one extra row. */
export const MAX_ROWS = 6;

export type ConfidenceKind = "deterministic" | "aiDerived" | "other";

export interface CardRow {
  type: "writer";
  componentId: string;
  /** The Pathix UI's kind abbreviation, e.g. PLG, WF, FRM. */
  kind: string;
  kindLabel: string;
  /** The raw component type, for the chip's colors. */
  componentType: string;
  name: string;
  confidence: ConfidenceKind;
  confidenceLabel: string;
  /** When it runs, e.g. "On Update · Post-op · Async"; the first trigger's label, null when it has none. */
  trigger: string | null;
  /** Every trigger Pathix gave, up to MAX_TRIGGER_LINES, with what scopes it. Empty when it has none. */
  triggers: TriggerLine[];
  /** Triggers beyond the ones listed. */
  moreTriggers: number;
  /** A plugin step's images; null for anything else. "unknown" when Pathix gave no answer. */
  images: RowImages | null;
  human: boolean;
  microsoft: boolean;
  /** What a live read of the component's modifiedon asks for; null when its type has no live read. */
  live: LiveRef | null;
  /** Set by applyCardFreshness: the component's live modifiedon is newer than the scan. */
  changedSinceScan?: boolean;
}

/**
 * The customer forms that expose the column, as one row. Forms are a human
 * write path ("a user can type here"); listed one by one they push the logic
 * people hover for into "+N more". Their names expand on demand.
 */
export interface FormsRow {
  type: "forms";
  count: number;
  names: string[];
  /** One per form, in the order of `names`; null for a form with no Dataverse id to read. */
  live: Array<LiveRef | null>;
  /** Set by applyCardFreshness: how many of the forms changed since the scan. */
  changedSinceScan?: number;
}

export type CardListItem = CardRow | FormsRow;

export interface CardStat {
  label: string;
  /** null when the read failed: shown as a dash, never as zero. */
  value: number | null;
  qualifier?: boolean;
  /** Pathix says its scan could not see everything this counts (coverageWarning): the count is a minimum, "at least". */
  minimum?: boolean;
}

/** The card's "Findings" line. */
export interface CardFindings {
  openCount: number;
  /** Critical, High, Medium, Low or Info; null when there are none open. */
  severity: string | null;
  /** The column's findings tab in Pathix (still named "signals" in its address). */
  href: string;
}

/**
 * The card's column history line, from the scan-diff ledger. "changes" links
 * to the column's page in Pathix, where its history panel sits. "unknown" is a
 * failed read: it is never the same as no history, which hides the line.
 */
export type CardHistory = { kind: "changes"; text: string; href: string } | { kind: "unknown"; text: string };

export interface FieldCardModel {
  table: string;
  column: string;
  /**
   * Pathix's latest scan does not hold the column (columnNotInScan): the card
   * says so and shows no counts, rows or findings, never zeros.
   */
  notInScan: boolean;
  secured: boolean;
  /** False when the permissions read failed, so `secured: false` is not an answer. */
  securedKnown: boolean;
  /** "As of <scan date>", or null before the first Completed scan. */
  asOf: string | null;
  /** The scan's completion time, for comparing with a component's live modified date (M11). */
  scanCompletedAt: string | null;
  /** When the scan was queued (/scans StartedAt, not when it began running): a component modified between this and the completion is unknown. Null when not known. */
  scanStartedAt: string | null;
  /** The environment and scan the answers come from (the first line behind the "?"). */
  scope: string;
  stats: CardStat[];
  /** Open findings on the column; null renders nothing (see findingsFor). */
  findings: CardFindings | null;
  /**
   * Pathix's own sentence about reads its scan could not see (field-dependents
   * `coverageWarning`), shown on the card's face; null when it gave none. The
   * readers count is then a minimum. Only the readers answer carries one.
   */
  coverageWarning: string | null;
  /** Null when Pathix has recorded no changes to the column: the line is hidden. */
  history: CardHistory | null;
  /**
   * Dataverse's own dependency count for the column, measured at scan time. null
   * is not measured, which is never zero: an older Pathix, a scan before the
   * measurement, or a failed read.
   */
  platformDependentCount: number | null;
  /** False when the read that carries the count failed, so the card can say "could not read" instead of "not in this scan". */
  platformCountRead: boolean;
  /** What the "Why can't I edit" checklist reads from Pathix. */
  locked: LockedPathixFacts;
  /** Customer logic, then the forms row, then Microsoft components. */
  rows: CardListItem[];
  /** Writers not shown in the rows. */
  moreCount: number;
  /** Shown instead of rows when there are none to show. */
  emptyLine: string | null;
  /** Behind the "?": scope, who can edit, and what is not counted. */
  info: string[];
  openUrl: string;
  /** Set by applyCardFreshness: the one line about the live check, labelled "live"; null when there is nothing to say. */
  freshness?: string | null;
}

export interface FieldCardContext {
  pathixUrl: string;
  environmentId: string;
  environmentName: string;
  scanCompletedAt: string | null;
  /** When that scan started; absent or null when not known. */
  scanStartedAt?: string | null;
  table: string;
  column: string;
  formatDate: (iso: string) => string;
  /** A date without a time, e.g. "Aug 12"; null for a timestamp it cannot read. */
  formatDay: (iso: string) => string | null;
}

export interface FieldCardInputs {
  writers: FieldWriter[] | null;
  dependents: FieldDependents | null;
  permissions: FieldPermissions | null;
  security: SecurityWritersSummary | null;
  findings: OpenFindingCounts | null;
  /** The column's change history; null when the read failed. */
  history: FieldHistory | null;
  /** By componentId, for the rows that have a registration. */
  registrations: Map<string, ComponentRegistration | null>;
  /** What else says the column is not in the latest scan (columnNotInScan). Absent: nothing does. */
  scanPresence?: ScanPresence;
}

/**
 * What, besides the open counts, says Pathix's latest scan does not hold the
 * column. A current Pathix's field-writers and field-dependents refuse such a
 * column with the typed 404 themselves. An older Pathix answers them `200 []`,
 * which would read as zero writers, so the other checks stay as the fallback.
 */
export interface ScanPresence {
  /** field-writers or field-dependents answered Pathix's typed 404. A route miss is not this. */
  fieldReadsNotFound: boolean;
  /** field-permissions answered Pathix's typed 404: the column does not resolve in the scan. A route miss is not this. */
  permissionsNotFound: boolean;
  /** The table is in the environment's excludedEntities: the scan leaves it out. */
  tableExcluded: boolean;
}

/** Said in place of the counts when the column is not in Pathix's latest scan. */
export const NOT_IN_SCAN = "Not in Pathix's latest scan.";

/**
 * Whether Pathix's latest scan does not hold the column: the writers,
 * dependents or permissions read answered the typed 404, the table is excluded
 * from the scan, or the open counts leave the column out while a Completed
 * scan exists (an omitted subject is not in the scan). Any one of them is
 * enough. The writers and dependents refusal is the direct answer; the rest
 * cover an older Pathix that answers those reads with an empty list.
 */
export function columnNotInScan(
  presence: ScanPresence | undefined,
  counts: OpenFindingCounts | null,
  table: string,
  column: string,
): boolean {
  if (presence?.fieldReadsNotFound || presence?.permissionsNotFound || presence?.tableExcluded) return true;
  // Pathix leaves a column out by the latest Completed scan's columns, whatever
  // its findings sweep is doing: readiness only qualifies what a 0 means. So
  // any readiness object (a Completed scan exists) makes an omission decisive.
  // null (no Completed scan) and absent (an older Pathix) decide nothing.
  return counts !== null && isRecord(counts.readiness) && findingsRow(counts, table, column) === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildFieldCard(context: FieldCardContext, inputs: FieldCardInputs): FieldCardModel {
  if (columnNotInScan(inputs.scanPresence, inputs.findings, context.table, context.column)) return notInScanCard(context, inputs);
  const writers = inputs.writers;
  const ordered = writers ? orderWriters(writers) : [];
  const isCustomerForm = (writer: FieldWriter) => writer.isHumanDriven && !writer.isSystem;
  const listed = ordered.filter((writer) => !isCustomerForm(writer)).slice(0, MAX_ROWS);
  const forms = ordered.filter(isCustomerForm);
  const rows = listItems(listed, forms, inputs.registrations, context.table, context.column);
  const coverageWarning = coverageWarningOf(inputs.dependents);

  return {
    table: context.table,
    column: context.column,
    notInScan: false,
    secured: inputs.permissions?.isSecured === true,
    securedKnown: inputs.permissions !== null,
    platformDependentCount: platformCountOf(inputs.dependents),
    platformCountRead: inputs.dependents !== null,
    locked: lockedFactsFrom(inputs.dependents, inputs.permissions),
    asOf: context.scanCompletedAt ? `As of ${context.formatDate(context.scanCompletedAt)}` : null,
    scanCompletedAt: context.scanCompletedAt,
    scanStartedAt: context.scanStartedAt ?? null,
    scope: scopeLineFor(context.environmentName, context.scanCompletedAt, context.formatDate),
    stats: [
      { label: "writers", value: writers?.length ?? null },
      { label: "readers", value: inputs.dependents?.results.length ?? null, ...(coverageWarning ? { minimum: true } : {}) },
      { label: "conditional", value: writers ? writers.filter((writer) => writer.isConditional).length : null, qualifier: true },
    ],
    findings: findingsFor(inputs.findings, context),
    coverageWarning,
    history: historyFor(inputs.history, context),
    rows,
    moreCount: Math.max(0, ordered.length - forms.length - listed.length),
    emptyLine: writers === null ? "Could not load the writers." : writers.length === 0 ? "No writers found in this scan." : null,
    info: infoLines(context, inputs),
    openUrl: openInPathixUrl(context),
  };
}

/**
 * The card for a column Pathix's latest scan does not hold: no counts, rows,
 * findings or contrast, since an empty answer about it is not "none". The
 * column's change history still shows: it is the ledger, not the scan.
 */
function notInScanCard(context: FieldCardContext, inputs: FieldCardInputs): FieldCardModel {
  return {
    table: context.table,
    column: context.column,
    notInScan: true,
    secured: false,
    securedKnown: false,
    platformDependentCount: null,
    platformCountRead: true,
    locked: lockedFactsFrom(null, null),
    asOf: context.scanCompletedAt ? `As of ${context.formatDate(context.scanCompletedAt)}` : null,
    scanCompletedAt: context.scanCompletedAt,
    scanStartedAt: context.scanStartedAt ?? null,
    scope: scopeLineFor(context.environmentName, context.scanCompletedAt, context.formatDate),
    stats: [],
    findings: null,
    coverageWarning: null,
    history: historyFor(inputs.history, context),
    rows: [],
    moreCount: 0,
    emptyLine: NOT_IN_SCAN,
    info: [
      scopeLineFor(context.environmentName, context.scanCompletedAt, context.formatDate),
      "Pathix's latest scan does not hold this column, so it has no writers, readers or findings to show. The table may be left out of the scan, or the column may be newer than it.",
      WRITES_NOT_SEEN,
    ],
    openUrl: openInPathixUrl(context),
  };
}

/**
 * The order rows are listed in: customer logic first (strongest confidence,
 * then server-side before client-side), then forms, then Microsoft components.
 * The loader uses the same order to decide whose registration to fetch.
 */
export function orderWriters(writers: FieldWriter[]): FieldWriter[] {
  const group = (writer: FieldWriter) => (writer.isSystem ? 2 : writer.isHumanDriven ? 1 : 0);
  return [...writers].sort(
    (a, b) =>
      group(a) - group(b) ||
      tierRank(a.confidence) - tierRank(b.confidence) ||
      typeRank(a.componentType) - typeRank(b.componentType) ||
      a.componentName.localeCompare(b.componentName),
  );
}

/**
 * The listed logic rows the card needs a registration for. A plugin step's
 * images are served only there. Any other row needs it only from an older
 * Pathix that does not put its triggers on the writers row, the call
 * the card used to make for every row.
 */
export function rowsNeedingRegistration(writers: FieldWriter[]): FieldWriter[] {
  return orderWriters(writers)
    .filter((writer) => !writer.isHumanDriven)
    .slice(0, MAX_ROWS)
    .filter((writer) => writer.componentType === "PluginStep" || writer.triggers === undefined);
}

/** Pathix's sentence about reads its scan could not see, or null when it gave none. */
export function coverageWarningOf(dependents: FieldDependents | null): string | null {
  const warning = dependents?.coverageWarning;
  return typeof warning === "string" && warning.trim() !== "" ? warning.trim() : null;
}

/** A count as written where it may be a minimum: "≥3" for at least 3. */
export function minimumText(value: number, minimum: boolean | undefined): string {
  return minimum ? `≥${value}` : String(value);
}

/** The column's Dataverse dependency records, or null when Pathix did not measure them. A missing field is not a zero. */
export function platformCountOf(dependents: FieldDependents | null): number | null {
  const count = dependents?.platformDependentCount;
  return typeof count === "number" && count >= 0 ? count : null;
}

/** Every component the card shows that a live modifiedon read can ask about, once each. */
export function liveRefsOf(card: FieldCardModel): LiveRef[] {
  const refs = card.rows.flatMap((row) => (row.type === "forms" ? row.live : [row.live]));
  return refs.filter((ref): ref is LiveRef => ref !== null);
}

/**
 * The card with its live freshness filled in (M11, the freshness case).
 * `live` is what the live read answered, or null when it did not run or could
 * not be read at all: every component is then unknown, never unchanged. Rows
 * are counted as they are listed. Writers behind "+N more" are not read.
 */
export function applyCardFreshness(
  card: FieldCardModel,
  live: LiveModified | null,
  scan: ScanWindow = { startedAt: card.scanStartedAt, completedAt: card.scanCompletedAt },
): FieldCardModel {
  const results: Freshness[] = [];
  const rows = card.rows.map((row): CardListItem => {
    if (row.type === "forms") {
      const forms = row.live.map((ref) => freshnessOf(ref, live, scan));
      results.push(...forms);
      return { ...row, changedSinceScan: forms.filter((form) => form === "changed").length };
    }
    const result = freshnessOf(row.live, live, scan);
    results.push(result);
    return { ...row, changedSinceScan: result === "changed" };
  });
  return { ...card, rows, freshness: freshnessLine(summarize(results)) };
}

/** How many writers Pathix found for the column; null when the read failed. */
export function writerCountOf(model: FieldCardModel): number | null {
  return model.stats.find((stat) => stat.label === "writers")?.value ?? null;
}

/** The key /findings/open-counts and the Pathix UI use for a column. */
export function fieldKey(table: string, column: string): string {
  return `${table}.${column}`;
}

/**
 * Pathix's contract (OpenFindingCountsResponse): a column the answer leaves
 * out is not in the latest scan, and a null readiness means there is no
 * Completed scan. Either is no answer: null, never zero. Then the Pathix UI's
 * rule (lib/readiness.ts, openCountIsShowable): a positive count is real even
 * while the findings sweep is incomplete, but a zero is a verdict only when
 * every finding type was computed. A count that is not a number is no answer
 * either. The card shows nothing for null, and X-ray shows "?". Shared by the
 * card and X-ray so the two cannot disagree.
 */
export function openCountFor(counts: OpenFindingCounts | null, table: string, column: string): number | null {
  // null readiness: no Completed scan. An absent key is an older Pathix: a
  // positive count is still real, but a zero is unknown, since without
  // readiness a measured zero cannot be told from a sweep that has not run.
  if (!counts || counts.readiness === null) return null;
  const row = findingsRow(counts, table, column);
  if (!row) return null;
  const openCount = countOf(row.openCount);
  if (openCount === null) return null;
  if (openCount === 0 && (counts.readiness === undefined || !findingsComplete(counts.readiness))) return null;
  return openCount;
}

/** A count Pathix sent as a number or a numeric string; null for anything else. */
function countOf(value: unknown): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

export function findingsFor(counts: OpenFindingCounts | null, context: FieldCardContext): CardFindings | null {
  const openCount = openCountFor(counts, context.table, context.column);
  if (openCount === null) return null;
  const row = counts ? findingsRow(counts, context.table, context.column) : undefined;
  return {
    openCount,
    severity: openCount > 0 ? row?.maxOpenSeverity ?? null : null,
    // The Pathix UI has not renamed its tab yet: the address keeps tab=signals until it does.
    href: `${openInPathixUrl(context)}&tab=signals`,
  };
}

export const HISTORY_UNKNOWN = "Column history: unknown";

/**
 * "Changed 3 times since Aug 12": how often scans found a change touching the
 * column (writer or reader turnover, column security, findings), counting one
 * per scan, since Aug 12 being when Pathix began tracking the environment.
 *
 * A row from a Pathix update (`pathixChange` set) is not
 * counted: Pathix began reading that kind of component, or reads it
 * differently, since the scan before. A real edit in the same scan keeps its
 * own unmarked row, so it still counts. /changes/field has no parameter that
 * leaves them out, so the card does.
 *
 * Pathix caps the entries it returns, so when the total is larger than the
 * entries the count is a floor, and the line says "at least". A failed read is
 * unknown, never "no history"; only a successful read of zero rows hides the
 * line (DESIGN.md, "Absence is not evidence").
 */
export function historyFor(history: FieldHistory | null, context: FieldCardContext): CardHistory | null {
  // An answer that is not the shape the contract promises is no answer.
  if (history === null || !Array.isArray(history.entries) || typeof history.totalCount !== "number") {
    return { kind: "unknown", text: HISTORY_UNKNOWN };
  }
  const { entries } = history;
  if (Math.max(history.totalCount, entries.length) === 0) return null;
  // A total with no entries to count is an answer the line cannot use: it
  // would read "at least 0 times", a zero in place of a count it does not have.
  if (entries.length === 0) return { kind: "unknown", text: HISTORY_UNKNOWN };

  // The total counts the Pathix-update rows too, so a capped answer stays a floor.
  const complete = entries.length >= history.totalCount;
  const changes = entries.filter((entry) => entry.pathixChange == null);
  // Every row came from a Pathix update. In full, that is no change; capped, the rest is unread.
  if (changes.length === 0) return complete ? null : { kind: "unknown", text: HISTORY_UNKNOWN };

  const scans = new Set(changes.map((entry) => entry.scanId ?? entry.detectedAt)).size;
  const times = scans === 1 ? "once" : `${scans} times`;
  const sinceAt = history.historySince ?? earliest(entries.map((entry) => entry.detectedAt));
  const since = sinceAt ? context.formatDay(sinceAt) : null;
  return {
    kind: "changes",
    text: `Changed ${complete ? "" : "at least "}${times}${since ? ` since ${since}` : ""}`,
    href: openInPathixUrl(context),
  };
}

function earliest(timestamps: string[]): string | null {
  const sorted = timestamps.filter((at) => !Number.isNaN(Date.parse(at))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return sorted[0] ?? null;
}

function findingsRow(counts: OpenFindingCounts, table: string, column: string): OpenFindingCounts["fields"][number] | undefined {
  const key = fieldKey(table, column).toLowerCase();
  return counts.fields.find((field) => field.subjectKey.toLowerCase() === key);
}

/** The scan's findings sweep finished with every detector. Shared with the admin center overlay. */
export function findingsComplete(readiness: OpenFindingCounts["readiness"] | undefined): boolean {
  // No readiness on the payload reads "ready", as in the Pathix UI.
  if (!readiness) return true;
  return readiness.findings.status === "Completed" && readiness.findings.failedDetectorFindingTypes.length === 0;
}

export function openInPathixUrl(context: Pick<FieldCardContext, "pathixUrl" | "environmentId" | "table" | "column">): string {
  const params = new URLSearchParams({ table: context.table, column: context.column, env: context.environmentId });
  return `${context.pathixUrl}/investigate?${params.toString()}`;
}

/** Which environment and scan an answer comes from; the card and X-ray share it. */
export function scopeLineFor(
  environmentName: string,
  scanCompletedAt: string | null,
  formatDate: (iso: string) => string,
): string {
  return scanCompletedAt
    ? `${environmentName}, Completed scan of ${formatDate(scanCompletedAt)}`
    : `${environmentName}, no Completed scan yet`;
}

// --- rows -----------------------------------------------------------------------

function listItems(
  listed: FieldWriter[],
  forms: FieldWriter[],
  registrations: Map<string, ComponentRegistration | null>,
  table: string,
  column: string,
): CardListItem[] {
  const items: CardListItem[] = listed.filter((w) => !w.isSystem).map((w) => cardRow(w, registrations, table, column));
  if (forms.length > 0) {
    const byName = [...forms].sort((a, b) => a.componentName.localeCompare(b.componentName));
    items.push({
      type: "forms",
      count: forms.length,
      names: byName.map((form) => form.componentName),
      live: byName.map((form) => liveRefFor(form.componentType, form.sourceId)),
    });
  }
  for (const writer of listed.filter((w) => w.isSystem)) items.push(cardRow(writer, registrations, table, column));
  return items;
}

function cardRow(writer: FieldWriter, registrations: Map<string, ComponentRegistration | null>, table: string, column: string): CardRow {
  const kind = KINDS[writer.componentType];
  const registration = registrations.get(writer.componentId) ?? null;
  const lines = writer.isHumanDriven ? [] : triggerLines(writer, registration, table);
  const { shown, more } = listedTriggerLines(lines);
  return {
    type: "writer",
    componentId: writer.componentId,
    kind: kind?.[0] ?? writer.componentType.slice(0, 3).toUpperCase(),
    kindLabel: kind?.[1] ?? componentTypeLabel(writer.componentType),
    componentType: writer.componentType,
    name: writer.componentName,
    confidence: confidenceKind(writer.confidence),
    confidenceLabel: confidenceLabel(writer.confidence),
    trigger: shown[0]?.label ?? null,
    triggers: shown,
    moreTriggers: more,
    images: writer.isHumanDriven ? null : imagesFor(writer, registration, column),
    human: writer.isHumanDriven,
    microsoft: writer.isSystem,
    live: liveRefFor(writer.componentType, writer.sourceId),
  };
}

/** The Pathix UI's ConfidenceDot vocabulary: Declared and Parsed are both Deterministic. */
export function confidenceKind(confidence: string): ConfidenceKind {
  if (confidence === "Declared" || confidence === "Parsed") return "deterministic";
  if (confidence === "AiDerived") return "aiDerived";
  return "other";
}

export function confidenceLabel(confidence: string): string {
  switch (confidenceKind(confidence)) {
    case "deterministic":
      return "Deterministic";
    case "aiDerived":
      return "AI-derived (unverified)";
    default:
      return confidence;
  }
}

// --- the "?" panel ----------------------------------------------------------------

/** Behind the ?: what the lines under a writer mean, and what they leave out. */
export const TRIGGERS_EXPLAINED =
  "Under each logic writer, the trigger line says when it runs. \"Fires when\" lists the filtering columns Pathix recorded. \"Fires on every update\" means a step or flow update has none. A cloud flow's row filter is reported as set or not; the filter itself is never read. A plugin step's images list the columns each one holds.";

/** Behind the ?: what the contrast line's count is, how it can differ from Show dependencies, and that it is a scan-time number. */
export const PLATFORM_COUNT_EXPLAINED =
  "\"Dataverse has N dependency records\" counts this column's records in Dataverse's dependency table, measured when Pathix scanned. It is usually the count in Dataverse's Show dependencies view, but it can differ, because that view groups some records differently, such as view columns and relationship parts. It can lag a change made since. It does not read plugin code, scripts or flow internals.";

/** What every connected card says it cannot see; the copied brief says it too. */
export const WRITES_NOT_SEEN = "Writes Pathix cannot see, such as external integrations, are not included.";

function infoLines(context: FieldCardContext, inputs: FieldCardInputs): string[] {
  const lines = [scopeLineFor(context.environmentName, context.scanCompletedAt, context.formatDate)];
  const roles = roleLine(inputs.security, context.table);
  if (roles) lines.push(roles, ...roleCoverageNotes(inputs.security));
  const secured = securedLine(inputs.permissions);
  if (secured) lines.push(secured);
  if (historyFor(inputs.history, context)?.kind === "changes") {
    lines.push(
      "Change history starts when Pathix began tracking this environment. It counts each scan that found a change touching this column. Changes from a Pathix update are not counted: Pathix started reading those components, or reads them differently, so they may not be changes in your environment.",
    );
  }
  lines.push(WRITES_NOT_SEEN);
  lines.push(TRIGGERS_EXPLAINED);
  lines.push(PLATFORM_COUNT_EXPLAINED);
  lines.push(
    "A \"changed since scan\" badge is live from Dataverse: that writer's modified date is newer than this scan, so it was saved, imported or turned on or off since. A form has no modified date: the badge on a form means it was published after this scan, so an edit that is not published does not show, and publishing again with no change does. It does not say what changed. A writer the check cannot read is counted as not checked, never as unchanged.",
  );
  return lines;
}

// Who can edit is the product's second question, but it is a table-level
// number that reads the same on every field, so it lives behind the "?".
// totalPrincipals counts holders, not roles: a role that grants Write but that
// no one holds does not count, so the zero line names principals.
function roleLine(security: SecurityWritersSummary | null, table: string): string | null {
  if (security === null || !security.tableResolved) return null;
  const total = security.scopeBreakdown.totalPrincipals;
  if (total === 0 && security.withheldPrincipalCount > 0) return `Who holds Create or Write on ${table} is withheld from you.`;
  if (total === 0) return `Pathix found no principal that holds Create or Write on ${table} through a role. A record can still be shared individually.`;
  return `${total} ${total === 1 ? "principal holds" : "principals hold"} Create or Write on ${table} through their roles.`;
}

/** Introduces Pathix's own notes on the role count: the sentences after it are Pathix's, word for word. */
export const ROLE_NOTES_INTRO = "Pathix notes about this count:";

/**
 * Pathix's own notes on what the role answer does not cover (group teams,
 * truncation, withheld principals), each on its line after one line of ours.
 * They are shown verbatim: they can name customer teams, and they carry no
 * code to tell one note from another, so none is reworded or dropped. Some
 * refer to the rows of Pathix's own page.
 */
function roleCoverageNotes(security: SecurityWritersSummary | null): string[] {
  if (!Array.isArray(security?.coverageNotes)) return [];
  const notes = security.coverageNotes.filter((note): note is string => typeof note === "string" && note.trim() !== "").map((note) => note.trim());
  return notes.length === 0 ? [] : [ROLE_NOTES_INTRO, ...notes];
}

// Almost no column is secured, so the card says nothing unless one is.
function securedLine(permissions: FieldPermissions | null): string | null {
  if (!permissions?.isSecured) return null;
  const updaters = permissions.grants.filter((grant) => grant.canUpdate).map((grant) => grant.profileName);
  return updaters.length === 0
    ? "Column-secured: no column security profile grants update. Records can still share the column."
    : `Column-secured: ${updaters.join(", ")} and system administrators can update it. Records can still share the column.`;
}

// --- vocabulary shared with the Pathix UI -------------------------------------------

/** The Pathix UI's component kind chips: [abbreviation, label]. */
export const KINDS: Record<string, [string, string]> = {
  PluginStep: ["PLG", "Plugin step"],
  ClassicWorkflow: ["WF", "Classic workflow"],
  Dialog: ["DLG", "Dialog"],
  BusinessRule: ["BR", "Business rule"],
  Action: ["ACT", "Action"],
  ModernFlow: ["FLW", "Cloud flow"],
  AgentFlow: ["AFLW", "Agent flow"],
  BusinessProcessFlow: ["BPF", "Business process flow"],
  FormScript: ["JS", "Form script"],
  PcfControl: ["PCF", "PCF control"],
  CanvasApp: ["CA", "Canvas app"],
  FormulaColumn: ["FC", "Formula column"],
  CalculatedColumn: ["CC", "Calculated column"],
  RollupColumn: ["RU", "Rollup column"],
  SavedQuery: ["SQ", "View"],
  Chart: ["CHT", "Chart"],
  Dashboard: ["DSH", "Dashboard"],
  Form: ["FRM", "Form"],
  RibbonCommand: ["RBN", "Command"],
  CustomApi: ["API", "Custom API"],
  Dataflow: ["DF", "Dataflow"],
  HtmlWebResource: ["HTML", "HTML web resource"],
};

/** The chip for a component type: [abbreviation, label]. A type the extension does not know yet still gets one. */
export function componentKind(type: string): [string, string] {
  return KINDS[type] ?? [type.slice(0, 3).toUpperCase(), componentTypeLabel(type)];
}

/** Falls back to splitting the enum name, so a new component type still reads. */
export function componentTypeLabel(type: string): string {
  if (KINDS[type]) return KINDS[type][1];
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Within a tier, server-side logic first: it runs whoever saves the record,
// and it is the writer people most often do not know about.
const TYPE_ORDER = [
  "PluginStep",
  "CustomApi",
  "ClassicWorkflow",
  "Action",
  "ModernFlow",
  "BusinessRule",
  "CalculatedColumn",
  "RollupColumn",
  "FormulaColumn",
  "Dataflow",
  "FormScript",
  "CanvasApp",
];

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}
