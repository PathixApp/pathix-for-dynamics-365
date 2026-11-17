// Lite's "Registered to fire when this changes" card, as plain data, tested
// without a DOM.
//
// It lists what the platform is registered to run when a column changes:
// plugin steps on Update whose filtering attributes name the column, steps
// with no filtering attributes (they fire on every update), on the table or
// on every table (a step with no message filter), activated classic
// workflows whose update trigger names the column, and activated business
// rules that Dataverse tracks as using it. Registered is not the same as
// writes: Lite never says "writers" (DESIGN.md, "Lite and connected").
//
// Microsoft-shipped steps are set apart only by the publisher of the step's
// owning solution, never by managed state (DESIGN.md, "Authorship comes from
// the publisher"). When the publisher cannot be read, nothing is set apart.
//
// A source that failed or was refused says so; it never counts as none
// (DESIGN.md, "Absence is not evidence").

import type { PluginStepRegistration, ProcessRegistration } from "../dataverse/queries";
import { LIVE_FROM_DATAVERSE, PATHIX_SITE, type TipLine } from "./lite";
import { noAccess } from "./locked";

export const REGISTERED_TITLE = "Registered to fire when this changes";

export const REGISTERED_TIP: TipLine = {
  text: "Registered isn't the same as writes. Pathix reads plugin code, scripts and flows to show what actually writes this column.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

/**
 * Publisher unique names that ship Microsoft's own solutions: exactly the
 * Microsoft publisher list in the Pathix server's publisher classifier, in
 * its order, both spellings of microsoftdynamics included. Matching ignores case, and is on
 * the unique name of the publisher of the step's owning solution,
 * the only valid authorship signal. Pinned by test/registered-card.test.ts;
 * when Pathix's list changes, change this one with it.
 */
export const MICROSOFT_PUBLISHERS: readonly string[] = [
  "MicrosoftCorporation",
  "MicrosoftDynamics",
  "MicrosoftDynamics365",
  "MicrosoftCorporationscm",
  "microsoftdynamics",
  "microsoftcrm",
  "dynamics365customerengagement",
  "adxstudio",
  "msdyn",
  "PowerCat",
  "DynamicsMKT",
  "QMSAnchor",
];

const MICROSOFT_PUBLISHER_NAMES = new Set(MICROSOFT_PUBLISHERS.map((name) => name.toLowerCase()));

/**
 * Whether a publisher's unique name is Microsoft's: one of the names above,
 * or any name that starts with "Microsoft" (which covers microsoftfirstparty).
 * An unknown publisher stays with the customer's steps.
 */
export function isMicrosoftPublisher(uniqueName: string | null | undefined): boolean {
  const name = (uniqueName ?? "").trim().toLowerCase();
  return MICROSOFT_PUBLISHER_NAMES.has(name) || name.startsWith("microsoft");
}

/** Messages that change an existing row's columns. */
const UPDATE_MESSAGES = new Set(["Update", "UpdateMultiple"]);

/** How many edited columns the card checks business rules for; past this, it says so. */
export const MAX_EDITED_COLUMNS = 10;

/**
 * Why a list Lite read may hold only the rows the user can see. Classic
 * workflows and business rules are owned by users, and teams and roles by
 * business units. A user whose Read privilege on them is below Organization
 * depth gets HTTP 200 with only their own rows ("some"); "unknown" when Lite
 * could not read that depth. Either way the list is not the whole list.
 */
export type Hidden = "some" | "unknown";

/**
 * A list Lite read. `complete` is false when a page could not be read or rows
 * may be hidden from the user (`hidden` says which), so a count is "at least"
 * and "none" is never a verdict.
 */
export type Answer<T> = { kind: "ok"; value: T; complete: boolean; hidden?: Hidden } | { kind: "forbidden" } | { kind: "failed"; timedOut?: true };

/**
 * Why a list may be missing rows, in one sentence, or null when it is whole.
 * `pages` names it in the paging sentence, `rows` in the visibility one.
 */
export function missingNote(answer: { complete: boolean; hidden?: Hidden }, pages: string, rows: string): string | null {
  if (answer.hidden === "some") return `You can see only some ${rows}. Your security roles do not let you read all of them, so some may be missing.`;
  if (answer.hidden === "unknown") return `Lite could not check whether you can see all ${rows}, so some may be missing.`;
  return answer.complete ? null : `Lite could not read every page of ${pages} Dataverse returned, so some may be missing.`;
}

export interface PublisherInfo {
  /** The publisher's display name. */
  name: string;
  microsoft: boolean;
  /**
   * The step's top layer is the Active solution: created or customized in
   * this environment, whoever wrote it. Its publisher names no author, so the
   * card says "in the Active layer" and never folds it.
   */
  activeLayer?: boolean;
}

/** What Lite read for the open table. */
export interface TableRegistrations {
  steps: Answer<PluginStepRegistration[]>;
  /** Steps on Update or UpdateMultiple with no message filter: they fire for every table. */
  allTables: Answer<PluginStepRegistration[]>;
  /** Publisher by solution id; null when it could not be read, so nothing is set apart. */
  publishers: ReadonlyMap<string, PublisherInfo> | null;
  processes: Answer<ProcessRegistration[]>;
}

/**
 * Process ids Dataverse tracks as depending on each column, for business
 * rules. A column whose dependencies could not be read maps to null.
 */
export type ProcessDependents = ReadonlyMap<string, ReadonlySet<string> | null>;

export interface FiringItem {
  /** Chip abbreviation: PLG, WF, BR. */
  kind: string;
  kindLabel: string;
  /** The Pathix component type the chip borrows its colors from. */
  colorType: string;
  name: string;
  /** "Update, rank 4, Default Publisher for contoso". */
  detail: string;
  /** A plugin step whose solution is the Active layer: its detail says so instead of naming a publisher. */
  activeLayer?: boolean;
}

export interface FiringGroup {
  title: string;
  /** A line under the title, e.g. why the group exists. */
  note: string | null;
  items: FiringItem[];
  /** Steps from Microsoft publishers, folded behind one toggle. */
  microsoft: FiringItem[];
}

export interface FiringSet {
  headline: string;
  groups: FiringGroup[];
  /** One line per source Lite could not read. Shown, never dropped. */
  unknowns: string[];
}

export interface EditsSection extends FiringSet {
  columns: string[];
}

export interface RegisteredCardModel extends FiringSet {
  table: string;
  column: string;
  status: string;
  title: string;
  /** What the user's unsaved edits are registered to fire on save; null with no edits. */
  edits: EditsSection | null;
  info: string[];
  tip: TipLine | null;
}

export interface RegisteredContext {
  table: string;
  column: string;
  /** Names of columns with unsaved edits on the form. Names only, never the edits. */
  dirtyColumns: string[];
  showTips: boolean;
}

export function buildRegisteredCard(
  context: RegisteredContext,
  registrations: TableRegistrations,
  dependents: ProcessDependents,
): RegisteredCardModel {
  const own = firingFor([context.column], registrations, dependents, "this column changes");
  const edited = editedColumns(context.dirtyColumns);
  let edits: EditsSection | null = null;
  if (edited.length > 0) {
    const firing = firingFor(edited.slice(0, MAX_EDITED_COLUMNS), registrations, dependents, editsSubject(edited));
    if (edited.length > MAX_EDITED_COLUMNS) firing.unknowns.push(`Only the first ${MAX_EDITED_COLUMNS} edited columns were checked.`);
    edits = { columns: edited, ...firing };
  }

  return {
    table: context.table,
    column: context.column,
    status: LIVE_FROM_DATAVERSE,
    title: REGISTERED_TITLE,
    ...own,
    edits,
    info: registeredInfo(registrations, [own, ...(edits ? [edits] : [])]),
    tip: context.showTips ? REGISTERED_TIP : null,
  };
}

/** The edited columns, deduplicated and sorted: the order the card checks and shows them in. */
export function editedColumns(dirty: string[]): string[] {
  return [...new Set(dirty)].sort((a, b) => a.localeCompare(b));
}

function editsSubject(columns: string[]): string {
  return columns.length === 1 ? `you save your edit to ${columns[0]}` : `you save your edits to ${columns.length} columns`;
}

function registeredInfo(registrations: TableRegistrations, shown: FiringSet[]): string[] {
  // Only a row the card lists earns the line that explains its label.
  const activeLayer = shown.some((set) => set.groups.some((group) => [...group.items, ...group.microsoft].some((item) => item.activeLayer)));
  return [
    "Read live from Dataverse with your own access, for this table.",
    "Plugin steps are listed when they are registered on Update with this column in their filtering attributes, on this table or on every table (marked \"all tables\"). A step with no filtering attributes fires on every update, so it is listed in its own group.",
    "Classic workflows are listed when they are activated and their update trigger names this column. Business rules are listed when they are activated and Dataverse tracks them as using this column.",
    "Disabled steps, draft workflows, cloud flows, and other messages such as Create and Delete are not listed.",
    registrations.publishers
      ? "Steps from Microsoft publishers are folded away. Lite tells them apart by the publisher of the step's owning solution, never by whether the solution is managed."
      : "Lite could not read the steps' publishers, so steps from Microsoft are not set apart.",
    ...(activeLayer
      ? [
          "A step \"in the Active layer\" was created or changed in this environment. That layer names no author, and a changed Microsoft step lands there too, so Lite does not say whose it is and does not fold it.",
        ]
      : []),
    "Registered means the platform runs it. It does not mean it changes this column. External integrations that write through the API are not counted.",
  ];
}

// --- what fires --------------------------------------------------------------------

interface Firing {
  steps: Array<{ step: PluginStepRegistration; everyUpdate: boolean; allTables: boolean }>;
  workflows: ProcessRegistration[];
  businessRules: ProcessRegistration[];
}

/** What is registered to fire when any of `columns` changes, as card data. */
export function firingFor(
  columns: string[],
  registrations: TableRegistrations,
  dependents: ProcessDependents,
  subject: string,
): FiringSet {
  const wanted = new Set(columns);
  const unknowns: string[] = [];
  const firing: Firing = { steps: [], workflows: [], businessRules: [] };
  const counts: Array<string | null> = [];

  // Plugin steps: the table's own, and those registered for every table.
  // Either read failing makes the count a minimum and says which.
  const stepReads = [
    { answer: registrations.steps, allTables: false, what: "plugin step registrations", pages: "plugin steps" },
    { answer: registrations.allTables, allTables: true, what: "steps registered on Update for every table", pages: "steps registered for every table" },
  ];
  let stepsRead = false;
  let stepsComplete = true;
  for (const { answer, allTables, what, pages } of stepReads) {
    if (answer.kind !== "ok") {
      stepsComplete = false;
      unknowns.push(noAccess(answer, what));
      continue;
    }
    stepsRead = true;
    if (!answer.complete) {
      stepsComplete = false;
      unknowns.push(`Lite could not read every page of ${pages} Dataverse returned, so some may be missing.`);
    }
    for (const step of answer.value) {
      if (step.statecode !== 0 || !UPDATE_MESSAGES.has(step.sdkmessageid?.name ?? "")) continue;
      const filter = filteringAttributes(step.filteringattributes);
      if (filter.length === 0) firing.steps.push({ step, everyUpdate: true, allTables });
      else if (filter.some((name) => wanted.has(name))) firing.steps.push({ step, everyUpdate: false, allTables });
    }
  }
  counts.push(stepsRead ? count(firing.steps.length, "plugin step", "plugin steps", stepsComplete) : null);

  // Classic workflows and business rules.
  const { processes } = registrations;
  if (processes.kind === "ok") {
    firing.workflows = activeWorkflows(processes.value).filter((workflow) =>
      filteringAttributes(workflow.triggeronupdateattributelist).some((name) => wanted.has(name)),
    );
    counts.push(count(firing.workflows.length, "classic workflow", "classic workflows", processes.complete));

    const rules = activeBusinessRules(processes.value);
    if (rules.length > 0) {
      const tracked = columns.map((column) => dependents.get(column) ?? null);
      const ids = new Set(tracked.flatMap((set) => (set ? [...set] : [])));
      firing.businessRules = rules.filter((rule) => ids.has(rule.workflowid.toLowerCase()) || ids.has(rootOf(rule)));
      const unread = tracked.some((set) => set === null);
      if (unread) {
        const which = columns.length === 1 ? "this column" : "these columns";
        // From a list Lite read in part, the number is only the rules it saw.
        const one = rules.length === 1;
        const rulesText = one ? "1 active business rule" : `${rules.length} active business rules`;
        const asked = one ? `Could not read whether the` : `Could not read which of the`;
        const verb = one ? "uses" : "use";
        unknowns.push(
          processes.complete
            ? `${asked} table's ${rulesText} ${verb} ${which}.`
            : `${asked} ${rulesText} Lite can see ${verb} ${which}. There may be more.`,
        );
      }
      // With some columns unread, a rule found is still a rule found: "at least".
      counts.push(
        unread && firing.businessRules.length === 0
          ? null
          : count(firing.businessRules.length, "business rule", "business rules", !unread && processes.complete),
      );
    } else {
      counts.push(count(0, "business rule", "business rules", processes.complete));
    }
    const missing = missingNote(processes, "processes", "classic workflows and business rules");
    if (missing) unknowns.push(missing);
  } else {
    counts.push(null, null);
    unknowns.push(noAccess(processes, "classic workflows and business rules"));
  }

  const groups = groupsOf(firing, registrations.publishers);
  const folded = groups.reduce((total, group) => total + group.microsoft.length, 0);
  const aside = folded === 0 ? "" : folded === 1 ? " 1 of them is from a Microsoft publisher." : ` ${folded} of them are from Microsoft publishers.`;
  return { headline: `${headline(counts, subject)}${aside}`, groups, unknowns };
}

/** "creditlimit, creditonhold" to its names; null or blank is none. */
export function filteringAttributes(list: string | null | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

// An activated classic workflow runs as its activation row (type 2). A
// definition that is activated but has no activation row in the answer
// stands in for it, so nothing activated goes missing.
function activeWorkflows(rows: ProcessRegistration[]): ProcessRegistration[] {
  return activeOf(rows.filter((row) => row.category === 0));
}

function activeBusinessRules(rows: ProcessRegistration[]): ProcessRegistration[] {
  return activeOf(rows.filter((row) => row.category === 2));
}

function activeOf(rows: ProcessRegistration[]): ProcessRegistration[] {
  const activated = rows.filter((row) => row.statecode === 1);
  const byRoot = new Map<string, ProcessRegistration>();
  for (const row of activated) {
    const root = rootOf(row);
    const held = byRoot.get(root);
    if (!held || (row.type === 2 && held.type !== 2)) byRoot.set(root, row);
  }
  return [...byRoot.values()];
}

export function rootOf(row: ProcessRegistration): string {
  return (row.type === 2 && row._parentworkflowid_value ? row._parentworkflowid_value : row.workflowid).toLowerCase();
}

function count(value: number, singular: string, plural: string, complete: boolean): string {
  return `${complete ? "" : "at least "}${value} ${value === 1 ? singular : plural}`;
}

// "4 plugin steps and 1 classic workflow are registered to fire when this
// column changes." A part that is not known is left out of the sentence and
// said in its own line, never counted as zero. "None" names what Lite read:
// it never reads cloud flows, so it never says nothing at all fires.
function headline(counts: Array<string | null>, subject: string): string {
  const known = counts.filter((part): part is string => part !== null);
  const nonzero = known.filter((part) => !/^(at least )?0 /.test(part));
  if (known.length === 0) return `Lite could not read what is registered to fire when ${subject}.`;
  if (nonzero.length === 0) {
    const whole = known.length === counts.length && known.every((part) => !part.startsWith("at least"));
    return whole
      ? `No plugin steps, classic workflows or business rules are registered to fire when ${subject}.`
      : `Of what Lite could read, nothing is registered to fire when ${subject}.`;
  }
  const single = nonzero.length === 1 && /^(at least )?1 /.test(nonzero[0]!);
  return `${sentenceList(nonzero)} ${single ? "is" : "are"} registered to fire when ${subject}.`;
}

function sentenceList(parts: string[]): string {
  const text = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// --- groups ------------------------------------------------------------------------

const STAGES: Record<number, string> = {
  10: "Pre-validation",
  20: "Pre-operation",
  30: "Main operation",
  40: "Post-operation",
  50: "Post-operation (deprecated)",
};

/** The stages a customer can register a step on: pre-validation, pre-operation, post-operation. */
const CUSTOMER_STAGES = new Set([10, 20, 40]);

export function stageLabel(stage: number): string {
  return STAGES[stage] ?? `Platform stage ${stage}`;
}

export function modeLabel(mode: number): string {
  return mode === 1 ? "asynchronous" : "synchronous";
}

const STEP_KIND = { kind: "PLG", kindLabel: "Plugin step", colorType: "PluginStep" };
const WORKFLOW_KIND = { kind: "WF", kindLabel: "Classic workflow", colorType: "ClassicWorkflow" };
const RULE_KIND = { kind: "BR", kindLabel: "Business rule", colorType: "BusinessRule" };

export const EVERY_UPDATE_TITLE = "Fires on every update";
const EVERY_UPDATE_NOTE = "These steps have no filtering attributes, so they fire whenever any column changes.";

function groupsOf(firing: Firing, publishers: ReadonlyMap<string, PublisherInfo> | null): FiringGroup[] {
  const byStage = new Map<string, { order: number; group: FiringGroup }>();
  const everyUpdate: FiringGroup = { title: EVERY_UPDATE_TITLE, note: EVERY_UPDATE_NOTE, items: [], microsoft: [] };

  const sorted = [...firing.steps].sort(
    (a, b) =>
      a.step.stage - b.step.stage ||
      a.step.mode - b.step.mode ||
      (a.step.rank ?? 0) - (b.step.rank ?? 0) ||
      (a.step.name ?? "").localeCompare(b.step.name ?? ""),
  );
  for (const { step, everyUpdate: fires, allTables } of sorted) {
    const publisher = step.solutionid ? (publishers?.get(step.solutionid.toLowerCase()) ?? null) : null;
    const item = stepItem(step, publisher, fires, allTables, publishers !== null);
    let group = everyUpdate;
    if (!fires) {
      const key = `${step.stage}|${step.mode}`;
      let entry = byStage.get(key);
      if (!entry) {
        const title = `${stageLabel(step.stage)}, ${modeLabel(step.mode)}`;
        entry = { order: step.stage * 10 + step.mode, group: { title, note: null, items: [], microsoft: [] } };
        byStage.set(key, entry);
      }
      group = entry.group;
    }
    (publisher?.microsoft ? group.microsoft : group.items).push(item);
  }

  const groups = [...byStage.values()].sort((a, b) => a.order - b.order).map((entry) => entry.group);
  if (firing.workflows.length > 0) {
    groups.push({
      title: "Classic workflows",
      note: null,
      items: firing.workflows.map(workflowItem).sort(byName),
      microsoft: [],
    });
  }
  if (firing.businessRules.length > 0) {
    groups.push({
      title: "Business rules",
      note: "They run on the form when a column they use changes, and on save when their scope is the table.",
      items: firing.businessRules.map(ruleItem).sort(byName),
      microsoft: [],
    });
  }
  if (everyUpdate.items.length + everyUpdate.microsoft.length > 0) groups.push(everyUpdate);
  return groups;
}

function stepItem(step: PluginStepRegistration, publisher: PublisherInfo | null, everyUpdate: boolean, allTables: boolean, publishersRead: boolean): FiringItem {
  const parts = [step.sdkmessageid?.name ?? "Update"];
  if (allTables) parts.push("all tables");
  if (everyUpdate) parts.push(`${stageLabel(step.stage)}, ${modeLabel(step.mode)}`);
  // Execution order only means something on the stages customers register on.
  if (CUSTOMER_STAGES.has(step.stage) && step.rank !== null && step.rank !== undefined) parts.push(`rank ${step.rank}`);
  const activeLayer = publishersRead && publisher?.activeLayer === true;
  if (publishersRead) parts.push(publisher ? (activeLayer ? "in the Active layer" : publisher.name) : "publisher unknown");
  return { ...STEP_KIND, name: step.name?.trim() || "Unnamed step", detail: parts.join(" · "), ...(activeLayer ? { activeLayer } : {}) };
}

function workflowItem(workflow: ProcessRegistration): FiringItem {
  const when =
    workflow.mode === 1
      ? workflow.updatestage === 20
        ? "Real-time, before the change is saved"
        : "Real-time, after the change is saved"
      : "Background, after the change is saved";
  const triggers = filteringAttributes(workflow.triggeronupdateattributelist);
  return { ...WORKFLOW_KIND, name: workflow.name?.trim() || "Unnamed workflow", detail: `${when} · on change of ${triggers.join(", ")}` };
}

function ruleItem(rule: ProcessRegistration): FiringItem {
  return { ...RULE_KIND, name: rule.name?.trim() || "Unnamed business rule", detail: "Business rule" };
}

function byName(a: FiringItem, b: FiringItem): number {
  return a.name.localeCompare(b.name);
}

/** The toggle that folds Microsoft-published steps: "5 steps from Microsoft publishers". */
export function microsoftLine(count: number): string {
  return count === 1 ? "1 step from a Microsoft publisher" : `${count} steps from Microsoft publishers`;
}
