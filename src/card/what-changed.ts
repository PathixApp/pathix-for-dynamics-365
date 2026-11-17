// "What changed on this table lately", as plain data, tested without a DOM (M11).
//
// Two answers fill one panel, and each says which it is:
//
// - Lite reads the change date of the table's own components from Dataverse:
//   `modifiedon` for plugin steps, classic workflows and business rules, and
//   `publishedon` for forms (the form table has no modifiedon). It says what
//   was modified or published, and when. It cannot say what changed. A form
//   row says "Published", never "Modified": an edit that is not published does
//   not show, and publishing again with no change does. Lite counts in
//   platform terms and never says "writers".
// - Connected shows Pathix's change ledger for the table: what a scan found
//   changed between two scans. Where a changed component can be read live, a
//   badge says it changed again since the scan (src/card/freshness.ts). A
//   form's source change reads "Republished": Pathix dates a form by its
//   publishedon, the same date Lite reads.
//
// A source that failed, was refused or was only partly read says so; it never
// becomes "nothing changed" (DESIGN.md, "Absence is not evidence").

import type { ChangeEntry, ChangeWindowCoverage, EnvironmentChanges } from "../pathix/api";
import type { FormModified, PluginStepRegistration, ProcessRegistration } from "../dataverse/queries";
import { formatDay, scanAgeWords } from "../runtime/dates";
import { freshnessOf, freshnessLine, liveRefFor, liveKey, summarize, type LiveModified, type LiveRef } from "./freshness";
import { LIVE_FROM_DATAVERSE, PATHIX_SITE, type TipLine } from "./lite";
import { noAccess } from "./locked";
import { componentKind } from "./model";
import { missingNote, rootOf, type Answer } from "./registered";

export const WHAT_CHANGED_TITLE = "What changed";

/** The window "lately" means, and the most rows shown. */
export const LITE_WINDOW_DAYS = 30;
export const MAX_CHANGE_ROWS = 25;
/** Of those, the most that may be older than the window. */
const MAX_EARLIER_ROWS = 5;
/** Ledger rows shown for connected mode, before "+N more in Pathix". */
export const MAX_LEDGER_ROWS = 40;

export const WHAT_CHANGED_TIP: TipLine = {
  text: "A modified or published date can't say what changed. Pathix compares scans to show which writes and reads were added or removed.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

export interface ChangeRow {
  /** Chip abbreviation, e.g. PLG, WF, BR, FRM; "" when the row has no component type. */
  kind: string;
  kindLabel: string;
  /** The Pathix component type the chip borrows its colors from, or "". */
  colorType: string;
  /** The component's name. */
  text: string;
  /** What happened and when, e.g. "Modified Oct 3, 3 days ago", or "Published Oct 3, 3 days ago" for a form. */
  detail: string;
  tags: string[];
  /** Connected only: what a live change-date read asks for; null when nothing can be read. */
  live: LiveRef | null;
  /** Connected only: a component that still exists, so a live check applies. A row with `live` null that is a component is unknown. */
  component?: boolean;
  /** Set by applyChangesFreshness. */
  changedSinceScan?: boolean;
}

export interface ChangeGroup {
  title: string | null;
  rows: ChangeRow[];
}

export interface WhatChangedModel {
  mode: "lite" | "connected";
  /** "known" when the answer can be shown as it is; "unknown" when it could not be read. */
  kind: "known" | "unknown";
  table: string;
  /** "Live from Dataverse" in Lite; "As of <scan date>" when connected. */
  status: string;
  headline: string;
  groups: ChangeGroup[];
  /** One line per source that could not be read in full. Shown, never dropped. */
  unknowns: string[];
  /** A note on the list's size, e.g. "Showing the 25 most recent of 63." */
  note: string | null;
  /** Connected: the one line about the live check, labelled "live". Null when there is nothing to say. */
  freshness: string | null;
  /** Connected: where the rest is, in Pathix. */
  more: { text: string; href: string } | null;
  /** Connected: the full ledger for the table, in Pathix. */
  openUrl: string | null;
  /** Connected: the scan the ledger and the live check compare with. */
  scanCompletedAt: string | null;
  /** Connected: when that scan was queued (/scans StartedAt). A component modified between this and the completion is unknown. */
  scanStartedAt: string | null;
  /** Behind the "?". */
  info: string[];
  /** null when tips are off, by the user or by policy, and always in connected mode. */
  tip: TipLine | null;
}

// --- Lite ------------------------------------------------------------------------------

/** What Lite read for the open table. */
export interface TableModified {
  steps: Answer<PluginStepRegistration[]>;
  /** Steps on Update or UpdateMultiple with no message filter: they fire on this table too. Listed as "all tables". */
  allTablesSteps: Answer<PluginStepRegistration[]>;
  processes: Answer<ProcessRegistration[]>;
  forms: Answer<FormModified[]>;
}

export interface LiteChangesContext {
  table: string;
  showTips: boolean;
  /** Milliseconds since the epoch; passed in so tests are exact. */
  now: number;
  /** For dates; the browser's own when absent. */
  locale?: string;
}

const LITE_INFO: string[] = [
  "Read live from Dataverse with your own access: the modified date of this table's plugin steps, classic workflows and business rules, and the published date of its forms. Plugin steps registered on Update for every table fire on this table too, so they are listed, marked \"all tables\".",
  "A modified date changes when a component is saved, imported with a solution, or turned on or off. It does not say what changed or who changed it.",
  "Dataverse keeps no modified date for a form, so a form's date is when it was last published. An edit that is not published does not show here, and publishing again with no change does.",
  "Cloud flows, views, scripts, plugin code and columns are not listed. A plugin's code can change in its assembly while its steps stay as they are.",
  "Lite cannot see inside a component.",
];

interface Modified {
  kind: string;
  kindLabel: string;
  colorType: string;
  name: string;
  tags: string[];
  /** The row's verb: a form is "Published", everything else "Modified". */
  verb: "Modified" | "Published";
  at: number;
  iso: string;
}

/** A component's change date as the source gave it, before it is parsed. */
type Dated = Omit<Modified, "at" | "iso"> & { changedOn: string | null | undefined };

export function buildLiteChanges(context: LiteChangesContext, read: TableModified): WhatChangedModel {
  const unknowns: string[] = [];
  const found: Modified[] = [];
  let undated = 0;
  let sourcesRead = 0;
  let partial = false;

  const take = (items: Dated[]) => {
    for (const { changedOn, ...item } of items) {
      const at = changedOn ? Date.parse(changedOn) : Number.NaN;
      if (Number.isNaN(at)) undated++;
      else found.push({ ...item, at, iso: changedOn! });
    }
  };
  const source = <T>(answer: Answer<T[]>, name: string, unread: string, use: (rows: T[]) => void, rows = name) => {
    if (answer.kind === "ok") {
      sourcesRead++;
      use(answer.value);
      const missing = missingNote(answer, name, rows);
      if (missing) {
        partial = true;
        unknowns.push(missing);
      }
    } else {
      partial = true;
      unknowns.push(noAccess(answer, unread));
    }
  };

  const stepItems = (steps: PluginStepRegistration[], allTables: boolean): Dated[] =>
    steps.map((step) => ({
      ...chip("PluginStep"),
      name: step.name?.trim() || "Unnamed plugin step",
      tags: [...(allTables ? ["all tables"] : []), ...(step.statecode === 0 ? [] : ["disabled"])],
      verb: "Modified" as const,
      changedOn: step.modifiedon,
    }));
  source(read.steps, "plugin steps", "plugin step registrations", (steps) => take(stepItems(steps, false)));
  source(read.allTablesSteps, "steps registered for every table", "steps registered on Update for every table", (steps) => take(stepItems(steps, true)));
  source(read.processes, "processes", "classic workflows and business rules", (processes) => take(processesOf(processes)), "classic workflows and business rules");
  source(read.forms, "forms", "forms", (forms) =>
    take(
      forms.map((form) => ({
        ...chip("Form"),
        name: form.name?.trim() || "Unnamed form",
        tags: formTags(form.type),
        verb: "Published" as const,
        changedOn: form.publishedon,
      })),
    ),
  );
  if (undated > 0) unknowns.push(`${undated} ${undated === 1 ? "component has" : "components have"} no modified or published date Lite could read.`);

  found.sort((a, b) => b.at - a.at);
  const windowStart = context.now - LITE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = found.filter((item) => item.at >= windowStart);
  const earlier = found.filter((item) => item.at < windowStart);
  const shownRecent = recent.slice(0, MAX_CHANGE_ROWS);
  const shownEarlier = earlier.slice(0, Math.min(MAX_EARLIER_ROWS, MAX_CHANGE_ROWS - shownRecent.length));

  const groups: ChangeGroup[] = [];
  if (shownRecent.length > 0) groups.push({ title: `Modified or published in the last ${LITE_WINDOW_DAYS} days`, rows: shownRecent.map((item) => liteRow(item, context.now, context.locale)) });
  if (shownEarlier.length > 0) groups.push({ title: "Modified or published earlier", rows: shownEarlier.map((item) => liteRow(item, context.now, context.locale)) });

  const shown = shownRecent.length + shownEarlier.length;
  return {
    mode: "lite",
    kind: sourcesRead === 0 ? "unknown" : "known",
    table: context.table,
    status: LIVE_FROM_DATAVERSE,
    headline: liteHeadline({ sourcesRead, partial, undated, recent: recent.length, total: found.length }),
    groups,
    unknowns,
    note: found.length > shown ? `Showing the ${shown} most recent of ${found.length}.` : null,
    freshness: null,
    more: null,
    openUrl: null,
    scanCompletedAt: null,
    scanStartedAt: null,
    info: LITE_INFO,
    tip: context.showTips ? WHAT_CHANGED_TIP : null,
  };
}

function liteHeadline(counts: { sourcesRead: number; partial: boolean; undated: number; recent: number; total: number }): string {
  const { sourcesRead, partial, undated, recent, total } = counts;
  if (sourcesRead === 0) return "Lite could not read when this table's components were modified or published.";
  // A component with no readable date may have been modified recently, so it
  // makes the answer partial, the same as a source Lite could not read.
  const incomplete = partial || undated > 0;
  if (recent === 0) {
    if (incomplete) return `Of what Lite could read, nothing was modified or published in the last ${LITE_WINDOW_DAYS} days.`;
    if (total === 0) return "Lite found no plugin steps, classic workflows, business rules or forms on this table.";
    return `No plugin steps, classic workflows, business rules or forms on this table were modified or published in the last ${LITE_WINDOW_DAYS} days.`;
  }
  const noun = recent === 1 ? "component was" : "components were";
  return `${incomplete ? "At least " : ""}${recent} ${noun} modified or published in the last ${LITE_WINDOW_DAYS} days.`;
}

function liteRow(item: Modified, now: number, locale: string | undefined): ChangeRow {
  const day = formatDay(item.iso, now, locale);
  const words = scanAgeWords(item.iso, now);
  return {
    kind: item.kind,
    kindLabel: item.kindLabel,
    colorType: item.colorType,
    text: item.name,
    detail: `${item.verb} ${day ? `${day}, ` : ""}${words}`,
    tags: item.tags,
    live: null,
  };
}

function chip(type: string): Pick<Modified, "kind" | "kindLabel" | "colorType"> {
  const [kind, kindLabel] = componentKind(type);
  return { kind, kindLabel, colorType: type };
}

/**
 * One item per classic workflow or business rule. A definition and its
 * activation are one process: they share a root, and the later modified date
 * of the two is the process's.
 */
function processesOf(rows: ProcessRegistration[]): Dated[] {
  const byRoot = new Map<string, ProcessRegistration[]>();
  for (const row of rows) {
    const root = rootOf(row);
    byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
  }
  return [...byRoot.values()].map((group) => {
    const named = group.find((row) => row.type === 1) ?? group[0]!;
    const dated = group.filter((row) => row.modifiedon && !Number.isNaN(Date.parse(row.modifiedon)));
    const latest = dated.sort((a, b) => Date.parse(b.modifiedon!) - Date.parse(a.modifiedon!))[0];
    return {
      ...chip(named.category === 2 ? "BusinessRule" : "ClassicWorkflow"),
      name: named.name?.trim() || (named.category === 2 ? "Unnamed business rule" : "Unnamed classic workflow"),
      tags: group.some((row) => row.statecode === 1) ? [] : ["draft"],
      verb: "Modified",
      changedOn: latest?.modifiedon ?? null,
    };
  });
}

const FORM_TYPES: Record<number, string> = { 6: "quick view", 7: "quick create", 11: "card" };

function formTags(type: number | null): string[] {
  const label = type === null ? undefined : FORM_TYPES[type];
  return label ? [label] : [];
}

// --- Connected -------------------------------------------------------------------------

export interface LedgerContext {
  pathixUrl: string;
  environmentId: string;
  environmentName: string;
  scanCompletedAt: string | null;
  /** When that scan started; absent or null when not known. */
  scanStartedAt?: string | null;
  table: string;
  formatDate: (iso: string) => string;
  /** A date without a time, e.g. "Aug 12"; null for a timestamp it cannot read. */
  formatDay: (iso: string) => string | null;
}

const LEDGER_INFO: string[] = [
  "From Pathix's change ledger, as of the latest completed scan. It lists what scans found changed, for the last 30 days.",
  "A row appears here when the ledger ties it to this table: a write or read of one of its columns, a column added or removed, or column security. A component that was added, renamed or changed in source is tied to its table from the first scan after Pathix was updated, and a republished form from the second. Earlier scans are not backfilled. Open the full ledger in Pathix for rows that carry no table.",
  "A form row that reads \"Republished\" means the form was published again between two scans. An edit that is not published does not show, and publishing again with no change does.",
  "Changes from a Pathix update are not listed or counted. Pathix started reading those components, or reads them differently, so they may not be changes in your environment. A real edit in the same scan keeps its own row. Pathix lists them apart, after the other changes.",
  "A badge reading \"changed since scan\" is live from Dataverse: the component's modified date is newer than the scan, so it was saved, imported or turned on or off after Pathix looked. It does not say what changed. A form has no modified date: its badge means the form was published after the scan, so an edit that is not published does not show, and publishing again with no change does.",
  "A component the live check cannot read is unknown. It is never shown as unchanged.",
  "When a scan in the window did not compare changes or findings, or Pathix has no record of whether it did, the panel says on how many scans. Changes from those scans may be missing from the list.",
];

const KIND_LABELS: Record<string, string> = {
  WriteAdded: "Now writes",
  WriteRemoved: "No longer writes",
  ReadAdded: "Now reads",
  ReadRemoved: "No longer reads",
  SourceChanged: "Source changed",
  ComponentAdded: "Added",
  ComponentRemoved: "Removed",
  ComponentRenamed: "Renamed",
  ComponentTypeChanged: "Type changed",
  FindingNew: "New finding",
  FindingResolved: "Finding resolved",
  FindingRegressed: "Finding regressed",
  FindingRecurred: "Finding recurred",
  ColumnAdded: "Column added",
  ColumnRemoved: "Column removed",
  TableAdded: "Table added",
  TableRemoved: "Table removed",
  FlsGrantAdded: "Column security grant added",
  FlsGrantRemoved: "Column security grant removed",
  FlsGrantChanged: "Column security grant changed",
};

/** Changes after which the component no longer exists, so there is nothing to read live. */
const GONE = new Set(["ComponentRemoved", "TableRemoved", "ColumnRemoved"]);

/** A kind name as words. A kind the extension does not know yet still reads. */
export function changeLabel(changeKind: string): string {
  const known = KIND_LABELS[changeKind];
  if (known) return known;
  const words = changeKind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A form's source change, in Lite's words. Pathix's source version for a form
 * is its publishedon, so the row means the form was
 * published again, with or without a change, never that it was edited.
 */
export const FORM_REPUBLISHED = "Republished";

/** A ledger row's kind in words. Only a row the contract types as a form says "Republished". */
function ledgerLabel(changeKind: string, componentType: string): string {
  return changeKind === "SourceChanged" && componentType === "Form" ? FORM_REPUBLISHED : changeLabel(changeKind);
}

export const LEDGER_UNKNOWN = "Could not read Pathix's change ledger for this table.";

/** The ledger's answer when the latest scan had no earlier scan to compare with. */
export const NO_BASELINE = "No earlier scan to compare yet. Pathix records changes from the second scan of an environment.";

/**
 * A line when the latest diff did not compare findings in full, or null.
 * Rows about findings are then missing or partial, never "no finding changed".
 */
export function findingGateLine(gate: string | null | undefined): string | null {
  if (gate === null || gate === undefined || gate === "Compared") return null;
  if (gate === "ComparedWithExclusions") return "Some finding types were not compared in Pathix's latest scan, so changes to those findings are not listed.";
  return "Finding changes were not compared in Pathix's latest scan, so they are not listed.";
}

const COVERAGE_COUNTS = [
  "scanCount",
  "diffNotComparedCount",
  "diffNotRecordedCount",
  "findingsNotComparedCount",
  "findingsWithExclusionsCount",
  "findingGateNotRecordedCount",
] as const;

/** The window's coverage, or null when it is absent or not the shape the contract promises. */
export function coverageOf(changes: EnvironmentChanges): ChangeWindowCoverage | null {
  const coverage = changes.windowCoverage;
  if (typeof coverage !== "object" || coverage === null) return null;
  return COVERAGE_COUNTS.every((key) => Number.isInteger(coverage[key]) && coverage[key] >= 0) ? coverage : null;
}

/** True when some scan in the window may have changes the ledger does not hold. */
function changesMayBeMissing(coverage: ChangeWindowCoverage): boolean {
  return coverage.diffNotComparedCount > 0 || coverage.diffNotRecordedCount > 0;
}

/**
 * One line per kind of gap in the window, so an empty list is never read as
 * "nothing changed" when some scans compared nothing.
 */
export function coverageLines(coverage: ChangeWindowCoverage, span: string): string[] {
  const lines: string[] = [];
  const ofScans = `of ${scans(coverage.scanCount)}${span}`;
  const { diffNotComparedCount, diffNotRecordedCount, findingsNotComparedCount, findingGateNotRecordedCount, findingsWithExclusionsCount } = coverage;
  if (diffNotComparedCount > 0) lines.push(`Changes were not compared on ${diffNotComparedCount} ${ofScans}, so changes from ${those(diffNotComparedCount)} are not listed.`);
  if (diffNotRecordedCount > 0) lines.push(`Pathix has no record of whether changes were compared on ${diffNotRecordedCount} ${ofScans}.`);
  if (findingsNotComparedCount > 0) lines.push(`Findings were not compared on ${scans(findingsNotComparedCount)}${span}, so finding changes from ${those(findingsNotComparedCount)} are not listed.`);
  if (findingGateNotRecordedCount > 0) lines.push(`Pathix has no record of whether findings were compared on ${scans(findingGateNotRecordedCount)}${span}.`);
  if (findingsWithExclusionsCount > 0) lines.push(`Some finding types were left out of the comparison on ${scans(findingsWithExclusionsCount)}${span}, so changes to those findings are not listed.`);
  return lines;
}

function scans(count: number): string {
  return `${count} ${count === 1 ? "scan" : "scans"}`;
}

function those(count: number): string {
  return count === 1 ? "that scan" : "those scans";
}

export function buildLedgerChanges(context: LedgerContext, changes: EnvironmentChanges | null): WhatChangedModel {
  const openUrl = `${context.pathixUrl}/changes?${new URLSearchParams({ table: context.table }).toString()}`;
  const base = {
    mode: "connected" as const,
    table: context.table,
    status: context.scanCompletedAt ? `As of ${context.formatDate(context.scanCompletedAt)}` : "No Completed scan yet",
    groups: [] as ChangeGroup[],
    unknowns: [] as string[],
    note: null,
    freshness: null,
    more: null,
    openUrl,
    scanCompletedAt: context.scanCompletedAt,
    scanStartedAt: context.scanStartedAt ?? null,
    info: LEDGER_INFO,
    tip: null,
  };
  const unknown = (headline: string): WhatChangedModel => ({ ...base, kind: "unknown", headline });

  // An answer that is not the shape the contract promises is no answer.
  if (changes === null || !Array.isArray(changes.entries) || typeof changes.totalCount !== "number") return unknown(LEDGER_UNKNOWN);
  const { entries } = changes;
  const total = Math.max(changes.totalCount, entries.length);
  const since = changes.from ? context.formatDay(changes.from) : null;
  const span = since ? ` since ${since}` : " in the last 30 days";
  // A total with no entries to list is an answer the panel cannot use.
  if (total > 0 && entries.length === 0) return unknown(LEDGER_UNKNOWN);
  // The window's coverage speaks for every scan in it, the latest included.
  // An older Pathix serves only the latest scan's gate.
  const coverage = coverageOf(changes);
  const gate = findingGateLine(changes.findingDeltaGate);
  const known = { ...base, unknowns: coverage ? coverageLines(coverage, span) : gate ? [gate] : [] };
  if (total === 0 && changes.baselineScanNumber === null) {
    // Nothing was compared yet: not "no changes".
    return { ...known, kind: "known", headline: NO_BASELINE };
  }
  if (total === 0) return { ...known, kind: "known", headline: emptyHeadline(coverage, span) };

  const ordered = entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.detectedAt) }))
    .sort((a, b) => (Number.isNaN(b.at) ? -Infinity : b.at) - (Number.isNaN(a.at) ? -Infinity : a.at) || a.index - b.index);
  const shown = ordered.slice(0, MAX_LEDGER_ROWS).map(({ entry }) => entry);

  const groups: ChangeGroup[] = [];
  const byScan = new Map<string, ChangeGroup>();
  for (const entry of shown) {
    const key = entry.scanId ?? entry.detectedAt;
    let group = byScan.get(key);
    if (!group) {
      group = { title: scanTitle(entry, context), rows: [] };
      byScan.set(key, group);
      groups.push(group);
    }
    group.rows.push(ledgerRow(entry));
  }

  const rest = total - shown.length;
  return {
    ...known,
    kind: "known",
    headline: `Pathix recorded ${total} ${total === 1 ? "change" : "changes"} tied to this table${span}.`,
    groups,
    more: rest > 0 ? { text: `+${rest} more in Pathix`, href: openUrl } : null,
  };
}

const UNTIED = "Component changes recorded before Pathix was updated are not tied to a table (see the full ledger).";

/** No rows for the table: said only as far as the window's scans were compared. */
function emptyHeadline(coverage: ChangeWindowCoverage | null, span: string): string {
  if (coverage?.scanCount === 0) return `No Pathix scan completed${span}, so no changes were compared.`;
  if (coverage && changesMayBeMissing(coverage)) return `Of the scans whose changes Pathix compared${span}, none recorded a change tied to this table. ${UNTIED}`;
  return `Pathix recorded no changes tied to this table${span}. ${UNTIED}`;
}

function scanTitle(entry: ChangeEntry, context: LedgerContext): string {
  const day = context.formatDay(entry.detectedAt);
  const number = typeof entry.scanSequenceNumber === "number" ? `Scan ${entry.scanSequenceNumber}` : "Scan";
  return day ? `${number}, ${day}` : `${number}, date unknown`;
}

function ledgerRow(entry: ChangeEntry): ChangeRow {
  const type = entry.subjectComponentType ?? "";
  const [kind, kindLabel] = type ? componentKind(type) : ["", ""];
  const label = ledgerLabel(entry.changeKind, type);
  const microsoft = entry.subjectIsSystem === true;
  return {
    kind,
    kindLabel,
    colorType: type,
    text: entry.subjectName,
    detail: entry.targetColumn ? `${label}: ${entry.targetColumn}` : label,
    tags: microsoft ? ["microsoft"] : [],
    live: entry.subjectKind === "Component" && !GONE.has(entry.changeKind) ? liveRefFor(type, entry.subjectId) : null,
    component: entry.subjectKind === "Component" && !GONE.has(entry.changeKind),
  };
}

/** Every component in the ledger rows a live change-date read can ask about, once each. */
export function liveRefsOfChanges(model: WhatChangedModel): LiveRef[] {
  const refs = new Map<string, LiveRef>();
  for (const group of model.groups) {
    for (const row of group.rows) if (row.live) refs.set(liveKey(row.live), row.live);
  }
  return [...refs.values()];
}

/**
 * The panel with its live freshness filled in (M11, the freshness case).
 * `live` is what the live read answered, or null when it did not run or could
 * not be read at all: every component is then unknown, never unchanged.
 */
export function applyChangesFreshness(model: WhatChangedModel, live: LiveModified | null): WhatChangedModel {
  if (model.mode !== "connected") return model;
  // Counted once per component. A component that still exists but has no live
  // read (a script, say) is unknown; a removed component or a column is not a
  // component to check, so it is left out of the count.
  const seen = new Map<string, ReturnType<typeof freshnessOf>>();
  const groups = model.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => {
      const result = freshnessOf(row.live, live, { startedAt: model.scanStartedAt, completedAt: model.scanCompletedAt });
      if (row.live) seen.set(liveKey(row.live), result);
      else if (row.component) seen.set(`${row.colorType}|${row.text}`, "unknown");
      return { ...row, changedSinceScan: result === "changed" };
    }),
  }));
  return { ...model, groups, freshness: freshnessLine(summarize([...seen.values()])) };
}
