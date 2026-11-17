// "Copy as brief": a plain-text summary of a card, for pasting into a ticket
// or a message. Names and counts only, never values. Plain data, tested
// without a DOM.
//
// A count that is not known is written "unknown", never 0 (DESIGN.md,
// "Absence is not evidence"). The connected brief carries the scan it comes
// from and the Pathix link. The Lite brief follows the Lite rules: platform
// terms, no "writers", no Pathix number, and no scan, because Lite reads
// Dataverse live and there is none.

import type { CardRow, FieldCardModel, FormsRow } from "./model";
import { WRITES_NOT_SEEN } from "./model";
import type { DependencyGroup, LiteCardModel } from "./lite";
import { unnamedLine } from "./lite";
import type { LockedCardModel } from "./locked";
import { CHECK_MARKS } from "./locked";
import type { FiringGroup, FiringItem, FiringSet, RegisteredCardModel } from "./registered";
import { microsoftLine } from "./registered";

const UNKNOWN = "unknown";

/** What a connected card shows, as text. `contrast` is the line comparing Dataverse's tracking with Pathix's count. */
export function connectedBrief(model: FieldCardModel, contrast: string | null, locked: LockedCardModel | null = null): string {
  const lines = [
    `Pathix brief: ${model.table}.${model.column}`,
    `Scope: ${model.scope}`,
    "",
    ...countLines(model),
  ];
  if (model.history) lines.push(model.history.text);
  if (model.freshness) lines.push(`Live from Dataverse: ${model.freshness}`);
  // A failed permissions read is not "not secured": a pasted brief has no card around it.
  if (!model.securedKnown) lines.push(`Column security: ${UNKNOWN}.`);
  else if (model.secured) lines.push("Column security: this column is secured.");
  if (contrast) lines.push(contrast);
  if (locked) lines.push("", ...lockedLines(locked));

  lines.push("", "Writers listed:");
  if (model.emptyLine) lines.push(model.emptyLine);
  for (const row of model.rows) lines.push(row.type === "forms" ? formsText(row) : writerText(row));
  if (model.moreCount > 0) lines.push(`+${model.moreCount} more in Pathix.`);

  lines.push("", WRITES_NOT_SEEN, `Open in Pathix: ${model.openUrl}`);
  return lines.join("\n");
}

/** The counts and findings, or, for a column the latest scan does not hold, that it is not there. */
function countLines(model: FieldCardModel): string[] {
  if (model.notInScan) return ["This column is not in Pathix's latest scan, so Pathix has no writers, readers or findings for it."];
  const readers = model.coverageWarning ? atLeast(statValue(model, "readers")) : count(statValue(model, "readers"));
  const lines = [
    `Writers: ${count(statValue(model, "writers"))}. Readers: ${readers}. Conditional writers: ${count(statValue(model, "conditional"))}.`,
    findingsText(model),
  ];
  if (model.coverageWarning) lines.push(`Readers are a minimum. ${model.coverageWarning}`);
  return lines;
}

function atLeast(value: number | null): string {
  return value === null ? UNKNOWN : `at least ${value}`;
}

function statValue(model: FieldCardModel, label: string): number | null {
  return model.stats.find((stat) => stat.label === label)?.value ?? null;
}

function count(value: number | null): string {
  return value === null ? UNKNOWN : String(value);
}

function findingsText(model: FieldCardModel): string {
  const findings = model.findings;
  if (findings === null) return `Open findings: ${UNKNOWN}.`;
  if (findings.openCount === 0) return "Open findings: none.";
  const severity = findings.severity ? ` (highest severity: ${findings.severity.toLowerCase()})` : "";
  return `Open findings: ${findings.openCount}${severity}.`;
}

function writerText(row: CardRow): string {
  const detail = [row.confidenceLabel, ...triggerParts(row), ...imageParts(row), row.human ? "human" : null, row.microsoft ? "Microsoft" : null]
    .filter((part): part is string => !!part)
    .join("; ");
  return `- ${row.kind} ${row.name} (${detail})${row.changedSinceScan ? " [changed since scan, live]" : ""}`;
}

function triggerParts(row: CardRow): string[] {
  const parts = row.triggers.map((trigger) => [trigger.label, trigger.scope, trigger.rowFilter].filter((part) => !!part).join(", "));
  if (row.moreTriggers > 0) parts.push(`+${row.moreTriggers} more`);
  return parts;
}

function imageParts(row: CardRow): string[] {
  if (!row.images) return [];
  return row.images.kind === "unknown" ? ["images unknown"] : row.images.lines.map((image) => image.text);
}

function formsText(row: FormsRow): string {
  const changed = row.changedSinceScan ? ` [${row.changedSinceScan} changed since scan, live]` : "";
  return `- ${row.count} ${row.count === 1 ? "form" : "forms"} (human): ${row.names.join(", ")}${changed}`;
}

// --- Lite ---------------------------------------------------------------------------

/** The Lite card view being copied: the tab the reader is looking at. */
export type LiteBriefSource =
  | { kind: "registered"; model: RegisteredCardModel }
  | { kind: "dependencies"; model: LiteCardModel }
  | { kind: "locked"; model: LockedCardModel };

export function liteBrief(source: LiteBriefSource): string {
  const { model } = source;
  const lines = [
    `Pathix Lite brief: ${model.table}.${model.column}`,
    `Source: ${model.status}, read with the reader's own access. Names and counts only.`,
    "",
  ];
  if (source.kind === "registered") lines.push(...registeredLines(source.model));
  else if (source.kind === "dependencies") lines.push(...dependenciesLines(source.model));
  else lines.push(...lockedLines(source.model));
  return lines.join("\n");
}

function registeredLines(model: RegisteredCardModel): string[] {
  const lines = [model.title, ...firingLines(model)];
  if (model.edits) {
    lines.push("", `Unsaved edits to: ${model.edits.columns.join(", ")}`, ...firingLines(model.edits));
  }
  return lines;
}

function firingLines(set: FiringSet): string[] {
  const lines = [set.headline];
  for (const unknown of set.unknowns) lines.push(`Unknown: ${unknown}`);
  for (const group of set.groups) lines.push(...groupLines(group));
  return lines;
}

function groupLines(group: FiringGroup): string[] {
  const lines = ["", `${group.title} (${group.items.length + group.microsoft.length})`];
  if (group.note) lines.push(group.note);
  for (const item of group.items) lines.push(itemText(item));
  if (group.microsoft.length > 0) {
    lines.push(`- ${microsoftLine(group.microsoft.length)}: ${group.microsoft.map((item) => item.name).join(", ")}`);
  }
  return lines;
}

function itemText(item: FiringItem): string {
  return `- ${item.kind} ${item.name} (${item.detail})`;
}

function dependenciesLines(model: LiteCardModel): string[] {
  const lines = [model.headline];
  if (model.groups.length > 0) lines.push("", "Tracked dependencies");
  for (const group of model.groups) lines.push(dependencyGroupText(group));
  return lines;
}

function dependencyGroupText(group: DependencyGroup): string {
  const names = [...group.names, ...(group.unnamedCount > 0 ? [unnamedLine(group.unnamedCount)] : [])];
  return names.length > 0 ? `- ${group.label}: ${names.join(", ")}` : `- ${group.label}`;
}

const CHECK_WORDS = { ruledOut: "Ruled out", cause: "The cause", unknown: "Cannot check", checking: "Checking" } as const;

function lockedLines(model: LockedCardModel): string[] {
  const lines = [model.title, model.headline, ""];
  for (const check of model.lines) {
    lines.push(`${CHECK_MARKS[check.state]} ${check.topic} (${CHECK_WORDS[check.state]})${check.live ? " [live]" : ""}: ${check.text}`);
    if (check.names.length > 0) lines.push(`  ${check.names.join(", ")}`);
  }
  return lines;
}
