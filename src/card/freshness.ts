// "Changed since Pathix's last scan", as plain data, tested without a DOM (M11).
//
// Pathix knows a component as of its latest completed scan. Connected mode
// may read that component's live change date from Dataverse (`modifiedon`, or
// `publishedon` for a form) and compare it with the scan's completion time. This is the extension's data boundary's
// freshness case: a live read, paired with a
// Pathix fact, labelled "live". What it learns is never sent to Pathix and is
// kept in memory only.
//
// Three answers, never two. A component is "changed" only when its live
// change date is newer than the scan. It is "unchanged" only when the read
// succeeded and its date is not newer. Everything else is "unknown": a type
// Lite cannot read, a read that failed or was refused, a component the answer
// did not include, a date that is missing or unreadable. Unknown is never
// shown as unchanged (DESIGN.md, "Absence is not evidence").
//
// A modified date says that something was saved, imported or turned on or
// off. It does not say what changed. A form has no modifiedon in Dataverse
// (the systemform table has no such column): its date is `publishedon`, when
// it was last published. An edit that is not published does not move it, and
// publishing again with no change does.

export const LIVE_LABEL = "live";

/** A component Pathix knows, named the way Dataverse names it. Ids and component types only. */
export interface LiveRef {
  /** Pathix's ComponentType name, e.g. PluginStep. */
  componentType: string;
  /** The component's Dataverse id. */
  id: string;
}

/**
 * "duringScan" is unknown with a reason: the component changed between the
 * scan's start and its completion, so whether the scan saw the change cannot
 * be told. The start is when the scan was queued (/scans serves StartedAt,
 * not the time it began running), so the window can open early; that only
 * widens what is unknown.
 */
export type Freshness = "changed" | "unchanged" | "duringScan" | "unknown";

/** When the scan Pathix answers from was queued and completed. Either time may be missing or unreadable. */
export interface ScanWindow {
  startedAt: string | null;
  completedAt: string | null;
}

/** Which Dataverse table holds a component, and the column that carries its id. */
export interface LiveSource {
  entitySet: "sdkmessageprocessingsteps" | "workflows" | "systemforms" | "savedqueries" | "savedqueryvisualizations";
  idColumn: string;
  /** The column that carries the component's change date. Forms have no modifiedon; theirs is publishedon. */
  changeColumn: "modifiedon" | "publishedon";
}

const STEPS: LiveSource = { entitySet: "sdkmessageprocessingsteps", idColumn: "sdkmessageprocessingstepid", changeColumn: "modifiedon" };
const PROCESSES: LiveSource = { entitySet: "workflows", idColumn: "workflowid", changeColumn: "modifiedon" };

/**
 * The component types whose change date the extension can read, by Pathix's
 * ComponentType name. Each lives in a metadata table the Lite client already
 * reads. Anything else (scripts, plugin assemblies, canvas apps, PCF controls)
 * has no live read here and is unknown.
 */
const SOURCES: Readonly<Record<string, LiveSource>> = {
  PluginStep: STEPS,
  ClassicWorkflow: PROCESSES,
  BusinessRule: PROCESSES,
  Dialog: PROCESSES,
  Action: PROCESSES,
  ModernFlow: PROCESSES,
  Form: { entitySet: "systemforms", idColumn: "formid", changeColumn: "publishedon" },
  SavedQuery: { entitySet: "savedqueries", idColumn: "savedqueryid", changeColumn: "modifiedon" },
  Chart: { entitySet: "savedqueryvisualizations", idColumn: "savedqueryvisualizationid", changeColumn: "modifiedon" },
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function liveSourceFor(componentType: string): LiveSource | null {
  return Object.hasOwn(SOURCES, componentType) ? SOURCES[componentType]! : null;
}

/**
 * A ref for a component, or null when its type has no live read or its id is
 * not a Dataverse id. A null ref is unknown, never unchanged.
 */
export function liveRefFor(componentType: string | null | undefined, id: string | null | undefined): LiveRef | null {
  if (!componentType || !id || !GUID.test(id) || id === "00000000-0000-0000-0000-000000000000") return null;
  return liveSourceFor(componentType) ? { componentType, id: id.toLowerCase() } : null;
}

/** The key a ref is looked up by: the same component id read twice is one read. */
export function liveKey(ref: LiveRef): string {
  const source = liveSourceFor(ref.componentType);
  return keyOf(source?.entitySet ?? ref.componentType, ref.id);
}

/** The same key, from what a Dataverse row names: its table and its id. */
export function keyOf(entitySet: string, id: string): string {
  return `${entitySet}|${id.toLowerCase()}`;
}

/**
 * Live change date (modifiedon, or publishedon for a form) by liveKey. A key that is missing, or null, was not read.
 * The map is the whole answer: a failed read leaves its components out.
 */
export type LiveModified = ReadonlyMap<string, string | null>;

/**
 * Whether one component changed since the scan. Changed: modified after the
 * scan completed. Unchanged: modified on or before the scan started. In
 * between, the scan may or may not have read the change: "duringScan". A
 * time that is missing or unreadable is unknown, never unchanged.
 */
export function freshnessOf(ref: LiveRef | null, live: LiveModified | null, scan: ScanWindow): Freshness {
  if (!ref || !live) return "unknown";
  const modified = live.get(liveKey(ref));
  const modifiedAt = typeof modified === "string" ? Date.parse(modified) : Number.NaN;
  const completedAt = scan.completedAt === null ? Number.NaN : Date.parse(scan.completedAt);
  if (Number.isNaN(modifiedAt) || Number.isNaN(completedAt)) return "unknown";
  if (modifiedAt > completedAt) return "changed";
  const startedAt = scan.startedAt === null ? Number.NaN : Date.parse(scan.startedAt);
  if (Number.isNaN(startedAt)) return "unknown";
  return modifiedAt <= startedAt ? "unchanged" : "duringScan";
}

/** What a list of components, checked live, comes to. */
export interface FreshnessSummary {
  changed: number;
  unchanged: number;
  /** Changed while the scan ran: unknown, said apart. */
  duringScan: number;
  unknown: number;
}

export function summarize(results: readonly Freshness[]): FreshnessSummary {
  const summary: FreshnessSummary = { changed: 0, unchanged: 0, duringScan: 0, unknown: 0 };
  for (const result of results) summary[result]++;
  return summary;
}

/**
 * The one line a card or panel shows about the live check, or null when there
 * is nothing to say (no component to check). "None changed" is said only when
 * every component was read and none was newer than the scan, and it says how
 * many were checked.
 */
export function freshnessLine(summary: FreshnessSummary): string | null {
  const { changed, unchanged, duringScan, unknown } = summary;
  if (changed + unchanged + duringScan + unknown === 0) return null;
  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} ${changed === 1 ? "component has" : "components have"} changed since the last scan`);
  else if (unknown + duringScan === 0) parts.push(unchanged === 1 ? "Checked 1 component: it has not changed since the last scan" : `Checked ${unchanged} components: none changed since the last scan`);
  else if (unchanged > 0) parts.push(`${unchanged} ${unchanged === 1 ? "component is" : "components are"} unchanged since the last scan`);
  if (duringScan > 0) {
    parts.push(`${duringScan} ${duringScan === 1 ? "component" : "components"} changed around the time of the scan, so the scan may not show ${duringScan === 1 ? "it" : "them"}`);
  }
  if (unknown > 0) parts.push(`${unknown} could not be checked`);
  const line = parts.join(". ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/** The badge on a changed component. */
export const CHANGED_BADGE = "changed since scan";
export const CHANGED_BADGE_TITLE =
  "Live from Dataverse: this component's modified date is newer than Pathix's last scan, so what Pathix shows may be out of date.";
/** A form has no modified date; its badge says it was published, never saved or modified. */
export const CHANGED_BADGE_TITLE_FORM =
  "Live from Dataverse: this form was published after Pathix's last scan, so what Pathix shows may be out of date. An edit that is not published does not show, and publishing again with no change does.";

/** The same wording for the forms row, which counts forms: "these forms were published". */
export const CHANGED_BADGE_TITLE_FORMS =
  "Live from Dataverse: these forms were published after Pathix's last scan, so what Pathix shows may be out of date. An edit that is not published does not show, and publishing again with no change does.";

/**
 * The tooltip for the badge: the form wording for a form (plural when it counts
 * several), the modified-date wording for anything else.
 */
export function changedBadgeTitle(isForm: boolean, count = 1): string {
  if (!isForm) return CHANGED_BADGE_TITLE;
  return count === 1 ? CHANGED_BADGE_TITLE_FORM : CHANGED_BADGE_TITLE_FORMS;
}
