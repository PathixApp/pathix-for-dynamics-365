// What a Lite card shows, as plain data, tested without a DOM.
//
// Lite answers from Dataverse's own metadata, read live as the signed-in user
// (DESIGN.md, "Lite and connected"). It counts in platform terms ("tracked
// dependencies") and never says "writers", which is a claim only Pathix can
// make. A read that failed or was refused says so; it never becomes zero
// (DESIGN.md, "Absence is not evidence").

import type { DependentComponent } from "../dataverse/queries";

export const LIVE_FROM_DATAVERSE = "Live from Dataverse";
export const PATHIX_SITE = "https://pathix.app";

/**
 * One footer line per card: what the card cannot see, and what Pathix does
 * about it. The word "Pathix" in the text is the link to pathix.app. It
 * names what Pathix does, never a Pathix number or result.
 */
export interface TipLine {
  text: string;
  /** The word in `text` that links to `href`. */
  linkText: "Pathix";
  href: string;
}

/** The Lite chip's tooltip. */
export const LITE_CHIP_TITLE = "Reads Dataverse metadata as you. Connect Pathix to see what actually writes each column.";

/** One kind of dependent component, e.g. "22 views", with names behind a toggle. */
export interface DependencyGroup {
  /** Chip abbreviation, e.g. PLG, FRM. */
  kind: string;
  /** Chip tooltip, e.g. "Plugin step". */
  kindLabel: string;
  /** The Pathix component type the chip borrows its colors from, or "" for the neutral chip. */
  colorType: string;
  count: number;
  /** "22 views", "1 plugin step". */
  label: string;
  names: string[];
  /** Components whose name could not be read; counted, never dropped. */
  unnamedCount: number;
}

export interface LiteCardModel {
  table: string;
  column: string;
  status: string;
  headline: string;
  groups: DependencyGroup[];
  /** Behind the "?". */
  info: string[];
  /** null when tips are off, by the user or by policy. */
  tip: TipLine | null;
}

/** What RetrieveDependentComponents answered. */
export type DependentsAnswer =
  | { kind: "ok"; rows: DependentComponent[]; complete: boolean }
  | { kind: "forbidden" }
  | { kind: "failed"; timedOut?: true };

export interface ResolvedName {
  name: string;
  /** A process's category (business rule, cloud flow...); only for workflows. */
  category?: number | null;
}

export interface LiteCardContext {
  table: string;
  column: string;
  showTips: boolean;
}

export const DEPENDENCIES_TIP: TipLine = {
  text: "Dataverse can't see inside plugin code. Pathix reads it to find what writes this column.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

export function buildDependenciesCard(
  context: LiteCardContext,
  dependents: DependentsAnswer,
  names: ReadonlyMap<string, ResolvedName>,
): LiteCardModel {
  const rows = dependents.kind === "ok" ? distinctDependents(dependents.rows) : [];
  return {
    table: context.table,
    column: context.column,
    status: LIVE_FROM_DATAVERSE,
    headline: dependenciesHeadline(dependents),
    groups: groupDependents(rows, names),
    info: [
      "Read live from Dataverse with your own access, for this column only.",
      "Dataverse records a dependency when a component's definition names the column, such as a form, a view, or a plugin step's filtering attributes or image.",
      "It does not read plugin code, scripts or flow internals, so logic that sets this column in code may not be listed.",
      "External integrations that write through the API leave no trace in metadata and are not counted.",
    ],
    tip: context.showTips ? DEPENDENCIES_TIP : null,
  };
}

export function dependenciesHeadline(dependents: DependentsAnswer): string {
  switch (dependents.kind) {
    case "forbidden":
      return "You don't have access to Dataverse's dependency tracking for this column.";
    case "failed":
      return dependents.timedOut
        ? "Could not read Dataverse's dependency tracking for this column. Dataverse did not answer in time."
        : "Could not read Dataverse's dependency tracking for this column.";
    case "ok": {
      const count = distinctDependents(dependents.rows).length;
      if (count === 0 && dependents.complete) return "Dataverse tracks no components that depend on this column.";
      const prefix = dependents.complete ? "" : "at least ";
      return count === 1
        ? `Dataverse tracks ${prefix}1 component that depends on this column.`
        : `Dataverse tracks ${prefix}${count} components that depend on this column.`;
    }
  }
}

/** Said on the connected card when Pathix has no measured count for the column. */
export const PLATFORM_COUNT_UNKNOWN = "Dataverse's dependency record count is not in this scan.";

/** Said when the read that carries the count failed. That is not a claim about the scan. */
export const PLATFORM_COUNT_UNREAD = "Could not read Dataverse's dependency record count from Pathix.";

/**
 * The connected card's one-line contrast between the platform's tracking and
 * Pathix's parsed writers. The platform's count is Pathix's, measured when it
 * scanned, so the card makes no live call for it. A count that is not known is
 * said so, never shown as zero; with neither known there is no line. A count
 * that is missing because the read failed says that, not "not in this scan".
 * Pathix counts the column's rows in Dataverse's dependency table, so the line
 * says "dependency records". Lite's "tracks N components" is a
 * different number, from the Show dependencies function, and the two can differ.
 */
export function contrastLine(dependencies: number | null, writers: number | null, countRead = true): string | null {
  const unknown = countRead ? PLATFORM_COUNT_UNKNOWN : PLATFORM_COUNT_UNREAD;
  const tracked = dependencies === null ? unknown : `Dataverse has ${plural(dependencies, "dependency record", "dependency records")}.`;
  if (writers === null) return dependencies === null ? null : tracked;
  return `${tracked} Pathix found ${plural(writers, "writer", "writers")}.`;
}

/** One entry per component: Dataverse can list a component once per dependency it holds. */
export function distinctDependents(rows: DependentComponent[]): DependentComponent[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.dependentcomponenttype}|${row.dependentcomponentobjectid.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- groups ----------------------------------------------------------------------

interface TypeInfo {
  kind: string;
  singular: string;
  plural: string;
  colorType: string;
}

/**
 * Dataverse's solution component types (the componenttype choice), worded the
 * way the maker portal words them. Chips reuse the Pathix UI's abbreviations
 * where Pathix has the same kind.
 */
const COMPONENT_TYPES: Record<number, TypeInfo> = {
  1: { kind: "TBL", singular: "table", plural: "tables", colorType: "" },
  2: { kind: "COL", singular: "column", plural: "columns", colorType: "" },
  3: { kind: "REL", singular: "relationship", plural: "relationships", colorType: "" },
  9: { kind: "OPT", singular: "choice", plural: "choices", colorType: "" },
  10: { kind: "REL", singular: "relationship", plural: "relationships", colorType: "" },
  14: { kind: "KEY", singular: "key", plural: "keys", colorType: "" },
  20: { kind: "ROLE", singular: "security role", plural: "security roles", colorType: "" },
  26: { kind: "SQ", singular: "view", plural: "views", colorType: "" },
  29: { kind: "WF", singular: "process", plural: "processes", colorType: "" },
  31: { kind: "RPT", singular: "report", plural: "reports", colorType: "" },
  36: { kind: "TPL", singular: "email template", plural: "email templates", colorType: "" },
  44: { kind: "DUP", singular: "duplicate detection rule", plural: "duplicate detection rules", colorType: "" },
  59: { kind: "CHT", singular: "chart", plural: "charts", colorType: "" },
  60: { kind: "FRM", singular: "form", plural: "forms", colorType: "Form" },
  61: { kind: "WR", singular: "web resource", plural: "web resources", colorType: "" },
  65: { kind: "HR", singular: "hierarchy rule", plural: "hierarchy rules", colorType: "" },
  66: { kind: "PCF", singular: "custom control", plural: "custom controls", colorType: "" },
  70: { kind: "FSP", singular: "column security profile", plural: "column security profiles", colorType: "" },
  80: { kind: "APP", singular: "model-driven app", plural: "model-driven apps", colorType: "" },
  92: { kind: "PLG", singular: "plugin step", plural: "plugin steps", colorType: "PluginStep" },
  93: { kind: "IMG", singular: "plugin step image", plural: "plugin step images", colorType: "PluginStep" },
  300: { kind: "CA", singular: "canvas app", plural: "canvas apps", colorType: "CanvasApp" },
};

/** Workflow categories, so a business rule or a cloud flow is not just "a process". */
const PROCESS_CATEGORIES: Record<number, TypeInfo> = {
  0: { kind: "WF", singular: "classic workflow", plural: "classic workflows", colorType: "ClassicWorkflow" },
  1: { kind: "DLG", singular: "dialog", plural: "dialogs", colorType: "Dialog" },
  2: { kind: "BR", singular: "business rule", plural: "business rules", colorType: "BusinessRule" },
  3: { kind: "ACT", singular: "action", plural: "actions", colorType: "" },
  4: { kind: "BPF", singular: "business process flow", plural: "business process flows", colorType: "" },
  5: { kind: "FLW", singular: "cloud flow", plural: "cloud flows", colorType: "ModernFlow" },
  6: { kind: "DFL", singular: "desktop flow", plural: "desktop flows", colorType: "" },
};

// Logic first, the kinds people hover a field for; then the user interface.
const TYPE_ORDER = [92, 93, 29, 60, 26, 59, 2, 10, 3];
const WORKFLOW = 29;

function typeInfo(type: number, category: number | null | undefined): TypeInfo {
  if (type === WORKFLOW && category !== null && category !== undefined && PROCESS_CATEGORIES[category]) {
    return PROCESS_CATEGORIES[category];
  }
  return (
    COMPONENT_TYPES[type] ?? {
      kind: "?",
      singular: `other component (type ${type})`,
      plural: `other components (type ${type})`,
      colorType: "",
    }
  );
}

function groupOrder(type: number, category: number | null | undefined): number {
  const index = TYPE_ORDER.indexOf(type);
  const typeRank = index === -1 ? TYPE_ORDER.length * 10 + type : index * 10;
  return type === WORKFLOW ? typeRank + (category ?? 9) / 10 : typeRank;
}

export function groupDependents(rows: DependentComponent[], names: ReadonlyMap<string, ResolvedName>): DependencyGroup[] {
  const groups = new Map<string, { order: number; info: TypeInfo; names: string[]; unnamed: number }>();
  for (const row of distinctDependents(rows)) {
    const resolved = names.get(row.dependentcomponentobjectid.toLowerCase());
    const category = resolved?.category;
    const info = typeInfo(row.dependentcomponenttype, category);
    const key = `${row.dependentcomponenttype}|${info.kind}|${info.singular}`;
    let group = groups.get(key);
    if (!group) {
      group = { order: groupOrder(row.dependentcomponenttype, category), info, names: [], unnamed: 0 };
      groups.set(key, group);
    }
    if (resolved?.name) group.names.push(resolved.name);
    else group.unnamed++;
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.info.singular.localeCompare(b.info.singular))
    .map(({ info, names: groupNames, unnamed }) => {
      const count = groupNames.length + unnamed;
      return {
        kind: info.kind,
        kindLabel: capitalize(info.singular),
        colorType: info.colorType,
        count,
        label: `${count} ${count === 1 ? info.singular : info.plural}`,
        names: groupNames.sort((a, b) => a.localeCompare(b)),
        unnamedCount: unnamed,
      };
    });
}

/** The line under a group's names when some could not be read. */
export function unnamedLine(count: number): string {
  return count === 1 ? "1 name could not be read." : `${count} names could not be read.`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
