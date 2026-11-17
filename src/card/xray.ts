// What X-ray mode writes under each field's label: `W: 7 +1✦  R: 8  F: 5  <flag> 0`.
//
// - W: deterministic writes to the column, forms left out.
// - R: deterministic reads of the column, forms' own placements left out.
// - +N✦ after W or R: the AI-derived ones, counted apart and marked in text
//   (DESIGN.md, "Confidence vocabulary"). Left off when there are none.
// - F: forms that carry the column, editable or read-only.
// - The flag: open findings on the column.
//
// The letters count what the hover card's headline counts, by the same rule:
// every row Pathix returns, Microsoft components (isSystem) included. The card
// headline counts writers as the field-writers rows and readers as the
// field-dependents rows, with no Microsoft or AI filter, so X-ray takes no
// such filter either. It only splits each headline three ways:
//
//   card writers = W + W's ✦ + the form rows among the writers
//   card readers = R + R's ✦ + the form placements among the dependents
//
// A form is identified the same way on both sides: a row whose componentType
// is Form. isHumanDriven is not used for this, because Pathix sets it for PCF
// controls and Power Pages forms too. Among the dependents, a form row is a
// placement only when its referenceKind is Display, or absent (an older Pathix
// names no kind). Any other kind is a read the form makes without carrying the
// column, such as a related-records sub-grid filtering on the lookup (a
// Filter read), so it counts toward R, not F. The connected
// checklist (locked-connected.ts) keys on the same rule.
//
// F is the distinct forms across both answers. Pathix lists a form as a writer
// only where the form can edit the column, and as a dependent for every
// placement, read-only included, so F needs both. W + ✦ + F is therefore the
// card's writer count only when every form that carries the column is
// editable: F also counts forms that show it read-only.
//
// A count that could not be loaded is null and shows as "?", never as 0
// (DESIGN.md, "Absence is not evidence"). Connected mode only: Lite never
// counts writers or shows a Pathix number.

import type { FieldDependents, FieldWriter } from "../pathix/api";

/** A count, or null when Pathix did not answer for it. */
export type XrayCount = number | null;

export interface XrayEntry {
  column: string;
  /** Deterministic writes to the column, forms left out. */
  writers: XrayCount;
  /** AI-derived (unverified) writes to the column, forms left out. */
  aiWriters: XrayCount;
  /** Deterministic reads of the column, forms that carry it left out. */
  readers: XrayCount;
  /** AI-derived (unverified) reads of the column, forms that carry it left out. */
  aiReaders: XrayCount;
  /** Forms that carry the column, editable or read-only. */
  forms: XrayCount;
  /** Open findings on the column. */
  findings: XrayCount;
  /** Pathix's latest scan does not hold the column: every count is "?". */
  notInScan?: boolean;
  /** The readers answer carries Pathix's coverage warning: R and its AI-derived count are minimums, written "≥". */
  readersMinimum?: boolean;
}

export interface XrayModel {
  scopeLine: string;
  entries: XrayEntry[];
}

/** What a count shows when it could not be loaded. */
export const UNKNOWN_COUNT = "?";

/** The marker for a count that is a minimum, in the text itself. */
export const MINIMUM_MARK = "≥";

/** The marker for AI-derived counts, in the text itself, never only in style. */
export const AI_MARK = "✦";

/** What the marker means, in DESIGN.md's confidence vocabulary (the card's label too). */
export const AI_LABEL = "AI-derived (unverified)";

/** The legend's lines under the scope line: what the letters, the marker and the flag mean. */
/**
 * The X-ray panel's line for visible fields the line could not be written
 * under. Never silent: a missing line is not "nothing". Hidden fields and
 * fields on tabs that are not drawn are not counted, so it says "visible".
 */
export function unmarkedLine(count: number): string {
  return count === 1
    ? "1 visible field could not be marked, so its counts are not shown."
    : `${count} visible fields could not be marked, so their counts are not shown.`;
}

export const XRAY_LEGEND: string[] = [
  "W: writes to the column, forms left out. Microsoft components are counted, as on the card.",
  "R: reads of the column, forms that carry it left out. A form's sub-grid that filters on the column counts here.",
  `+N${AI_MARK}: N more writes or reads that are ${AI_LABEL}, counted apart from the number before them.`,
  "F: forms that carry the column, including forms that show it read-only.",
  "Flag: open findings on the column.",
  `${UNKNOWN_COUNT}: Pathix did not answer for this count, or the column is not in Pathix's latest scan.`,
  `${MINIMUM_MARK}N: at least N. Pathix says its scan could not see every read of this column.`,
  "Writes Pathix cannot see, such as external integrations, are not counted.",
];

export function buildXrayEntry(
  column: string,
  writers: FieldWriter[] | null,
  dependents: FieldDependents | null,
  findings: XrayCount,
): XrayEntry {
  const writes = writers ? split(writers) : null;
  const reads = dependents ? split(dependents.results) : null;
  // F needs both answers: a form that only shows the column read-only is in
  // the dependents, never in the writers. With one missing, F is unknown.
  const forms = writers && dependents ? distinctForms(writers, dependents).size : null;
  const warned = typeof dependents?.coverageWarning === "string" && dependents.coverageWarning.trim() !== "";
  return {
    column,
    writers: writes?.deterministic ?? null,
    aiWriters: writes?.ai ?? null,
    readers: reads?.deterministic ?? null,
    aiReaders: reads?.ai ?? null,
    forms,
    findings,
    ...(warned ? { readersMinimum: true } : {}),
  };
}

/**
 * A column Pathix's latest scan does not hold. Its writers and dependents
 * answers are empty, which is not zero, so every count is unknown.
 */
export function notInScanEntry(column: string): XrayEntry {
  return { column, writers: null, aiWriters: null, readers: null, aiReaders: null, forms: null, findings: null, notInScan: true };
}

interface Row {
  componentId: string;
  componentType: string;
  confidence?: string;
  referenceKind?: string;
}

/** The rows that are not form placements, split by tier: one count per row, as the card counts them. */
function split(rows: Row[]): { deterministic: number; ai: number } {
  const logic = rows.filter((row) => !isFormPlacement(row));
  const ai = logic.filter((row) => isAiDerived(row.confidence)).length;
  return { deterministic: logic.length - ai, ai };
}

function distinctForms(writers: FieldWriter[], dependents: FieldDependents): Set<string> {
  const ids = new Set<string>();
  for (const row of [...writers, ...dependents.results]) {
    if (isFormPlacement(row)) ids.add(row.componentId);
  }
  return ids;
}

export function formatCount(count: XrayCount): string {
  return count === null ? UNKNOWN_COUNT : String(count);
}

/** One letter's part of the line: "W: 6", and how many AI-derived ones go beside it (0 for none). */
export interface LinePart {
  text: string;
  ai: number;
}

/** The three letter counts, in the order they are written. */
export function lineParts(entry: XrayEntry): LinePart[] {
  return [
    { text: `W: ${formatCount(entry.writers)}`, ai: entry.writers === null ? 0 : entry.aiWriters ?? 0 },
    { text: `R: ${entry.readersMinimum && entry.readers !== null ? MINIMUM_MARK : ""}${formatCount(entry.readers)}`, ai: entry.readers === null ? 0 : entry.aiReaders ?? 0 },
    { text: `F: ${formatCount(entry.forms)}`, ai: 0 },
  ];
}

/** The AI-derived count as written after a letter's count: "+1✦", or "" when there are none. */
export function aiSuffix(ai: number): string {
  return ai > 0 ? `+${ai}${AI_MARK}` : "";
}

/** What a screen reader hears for the marker: "1 more AI-derived (unverified)". */
export function aiDescription(ai: number): string {
  return `${ai} more ${AI_LABEL}`;
}

/** A part as written: "W: 6 +1✦". */
export function partText(part: LinePart): string {
  return part.ai > 0 ? `${part.text} ${aiSuffix(part.ai)}` : part.text;
}

/** The whole line as text, for tests and the console: the flag stands as "Finding". */
export function lineText(entry: XrayEntry): string {
  return `${lineParts(entry).map(partText).join("  ")}  Finding ${formatCount(entry.findings)}`;
}

/**
 * A form that carries the column. A writers row names no kind: Pathix lists a
 * form as a writer only where it edits the column. A dependents row is one
 * when its kind is Display, or absent on an older Pathix.
 */
function isFormPlacement(row: Row): boolean {
  if (row.componentType !== "Form") return false;
  return row.referenceKind === undefined || row.referenceKind === "Display";
}

function isAiDerived(confidence: string | undefined): boolean {
  return confidence === "AiDerived";
}
