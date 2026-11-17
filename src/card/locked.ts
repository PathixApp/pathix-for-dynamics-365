// Lite's "Why can't I edit this field?" checklist, as plain data, tested
// without a DOM.
//
// Each line is one place a field can be locked from. A line is:
// - ruledOut (✓) when Lite read the answer and it does not lock the field;
// - cause (✗) when Lite read the answer and it locks the field;
// - unknown (?) when Lite can see something but cannot read its logic, or
//   could not read the answer at all.
// An unknown line is marked, never dropped (DESIGN.md, "Absence is not
// evidence"). Scripts and business rules are named, never claimed: Lite
// cannot read what they do.
//
// Everything here is the signed-in user's own access. Pathix maps everyone's.

import {
  recordFilterOf,
  type AttributeEditability,
  type FieldPermission,
  type FieldSecurityProfile,
  type FormDefinition,
  type ProcessRegistration,
  type UserPrivileges,
} from "../dataverse/queries";
import { LIVE_FROM_DATAVERSE, PATHIX_SITE, type TipLine } from "./lite";
import type { Answer, Hidden } from "./registered";

export const LOCKED_TITLE = "Why can't I edit this field?";

export const LOCKED_TIP: TipLine = {
  text: "This checks your own access only. Pathix maps who can edit this column across your organization.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

/**
 * The System Administrator column security profile. Its id is the same in
 * every environment, and it can read and update every secured column.
 */
export const SYSTEM_ADMINISTRATOR_PROFILE = "572329c1-a042-4e22-be47-367c6374ea45";

/** fieldpermission.canupdate: 4 is Allowed, 0 is Not Allowed. */
const ALLOWED = 4;

/** "checking": a live read is still running; the line says so and is never a verdict. */
export type CheckState = "ruledOut" | "cause" | "unknown" | "checking";

export interface CheckLine {
  state: CheckState;
  /** What the line checks, e.g. "Column security". */
  topic: string;
  text: string;
  /** Things the line names: profiles, business rules, script handlers. */
  names: string[];
  /** The line reads the signed-in user's own state from Dataverse right now (connected cards label it "live"). */
  live?: boolean;
}

export interface LockedCardModel {
  table: string;
  column: string;
  status: string;
  title: string;
  headline: string;
  lines: CheckLine[];
  info: string[];
  tip: TipLine | null;
}

/** One answer from Dataverse; a refused or failed read is kept apart. `timedOut`: Dataverse did not answer in time. */
export type Single<T> = { kind: "ok"; value: T } | { kind: "forbidden" } | { kind: "failed"; timedOut?: true };

export interface LockedContext {
  table: string;
  column: string;
  /** The form control's name, e.g. "header_creditlimit". */
  control: string;
  formId: string | null;
  showTips: boolean;
}

/** What the user's teams give for the table's Write privilege: the depths their roles hold it at. */
export interface TeamPrivileges {
  /** How many teams the user is a member of, of those they can see. */
  teamCount: number;
  depths: string[];
  /**
   * Teams and roles are owned by business units. Below Organization depth on
   * reading them, Dataverse lists only the ones the user can see, so a team or
   * a team's role may be missing: a grant found stands, "no grant" does not.
   */
  hidden?: Hidden;
  /** Which part may be missing, so the line names it: the teams, their roles, or both. */
  hiddenPart?: HiddenPart;
}

/** What may be missing from what the user's teams hold. */
export type HiddenPart = "teams" | "roles" | "teamsAndRoles";

/**
 * A team role's Organization depth on a privilege a record filter can narrow
 * (or one whose definition does not say). The team's depth mask carries no
 * filter, so this is never "every record".
 */
export const TEAM_GLOBAL_UNCHECKED = "GlobalUnchecked";

/** The column security profiles the user holds through their teams. */
export interface TeamProfiles {
  teamCount: number;
  /** Lower-case profile ids. */
  profileIds: string[];
  /** As for TeamPrivileges: a team the user cannot see may hold a profile. */
  hidden?: Hidden;
}

/**
 * Said when the user's teams or their roles may be listed only in part.
 * `reader` is "Lite", or "This card" when connected.
 */
export function teamsHiddenNote(hidden: Hidden, reader = "Lite", what: HiddenPart = "teamsAndRoles"): string {
  const subject = reader === "Lite" ? reader : reader.toLowerCase();
  if (what === "teams") {
    return hidden === "some"
      ? `You can see only some teams in your organization, so ${subject} may have missed one you are in.`
      : `${reader} could not check whether you can see all the teams you are in.`;
  }
  if (what === "roles") {
    return hidden === "some"
      ? `You can see only some security roles in your organization, so ${subject} may have missed one your teams hold.`
      : `${reader} could not check whether you can see all the roles your teams hold.`;
  }
  return hidden === "some"
    ? `You can see only some teams and roles in your organization, so ${subject} may have missed one of yours.`
    : `${reader} could not check whether you can see all your teams and their roles.`;
}

/** What Lite read for the checklist. */
export interface LockedFacts {
  attribute: Single<AttributeEditability>;
  /** Only read when the column is secured; null when it was not needed. */
  columnSecurity: {
    permissions: Single<FieldPermission[]>;
    profiles: Single<FieldSecurityProfile[]>;
    mine: Single<FieldSecurityProfile[]>;
    /** Profiles held through the user's teams. */
    team: Single<TeamProfiles>;
  } | null;
  /** null when the page gave no form id. */
  form: Single<FormDefinition | null> | null;
  processes: Answer<ProcessRegistration[]>;
  /** Process ids Dataverse tracks as using the column; null when not read or unreadable. */
  ruleDependents: ReadonlySet<string> | null;
  /** The Write privilege the table's definition names; null when it names none. */
  writePrivilege: Single<string | null>;
  /** The user's own depth on that privilege; null when there was none to ask about. */
  privileges: Single<UserPrivileges> | null;
  /**
   * The same privilege as the user's teams' roles give it, read apart from
   * `privileges`: nobody has verified that Dataverse's answer for the user
   * counts team roles, so both are read and the card unions them. null when
   * there was no privilege to ask about.
   */
  teamPrivileges: Single<TeamPrivileges> | null;
}

export function buildLockedCard(context: LockedContext, facts: LockedFacts): LockedCardModel {
  const parsed = facts.form?.kind === "ok" && facts.form.value?.formxml ? parseFormXml(facts.form.value.formxml) : null;
  const lines = [
    platformLine(facts.attribute),
    columnSecurityLine(context.column, facts),
    formLine(context, facts.form, parsed),
    businessRuleLine(facts.processes, facts.ruleDependents),
    privilegeLine(context.table, facts.writePrivilege, facts.privileges, facts.teamPrivileges),
    scriptLine(context.column, facts.form, parsed),
    RECORD_LINE,
  ];
  return {
    table: context.table,
    column: context.column,
    status: LIVE_FROM_DATAVERSE,
    title: LOCKED_TITLE,
    headline: lockedHeadline(lines),
    lines,
    info: [
      "Read live from Dataverse with your own access, for this column, this form and you.",
      "✓ means Lite read the answer and it does not lock the field. ✗ means it does. ? means Lite can see something there but cannot read its logic, or could not read it at all.",
      "Business rules and form scripts are named, never claimed: Lite cannot read what they do.",
      "Roles and column security profiles count whether you hold them yourself or through a team. Lite reads your teams' roles and profiles apart from your own.",
      "If Lite cannot read your teams, the line says so and stays ?, because a team might grant what your own roles do not.",
      "Dataverse lists business rules, teams and roles only as far as your security roles let you read them. If that is not the whole organization, a line that needs the whole list stays ?.",
      "A business process flow can also lock a field in its active stage. Lite does not check that yet.",
    ],
    tip: context.showTips ? LOCKED_TIP : null,
  };
}

function lockedHeadline(lines: CheckLine[]): string {
  const causes = lines.filter((line) => line.state === "cause").length;
  const unknown = lines.filter((line) => line.state === "unknown").length;
  const found =
    causes === 0
      ? "Lite ruled out everything it can read."
      : causes === 1
        ? "Lite found 1 likely cause."
        : `Lite found ${causes} likely causes.`;
  if (unknown === 0) return found;
  return `${found} ${unknown === 1 ? "1 thing it cannot check is" : `${unknown} things it cannot check are`} marked ?.`;
}

export function line(state: CheckState, topic: string, text: string, names: string[] = []): CheckLine {
  return { state, topic, text, names };
}

/** Why a read gave no answer, in one or two short sentences. */
export function noAccess(answer: { kind: "forbidden" | "failed"; timedOut?: true }, thing: string): string {
  if (answer.kind === "forbidden") return `You don't have access to ${thing}.`;
  return answer.timedOut ? `Could not read ${thing}. ${DATAVERSE_TIMED_OUT}` : `Could not read ${thing}.`;
}

/** Said after "Could not read ..." when a Dataverse read was aborted for taking too long. */
export const DATAVERSE_TIMED_OUT = "Dataverse did not answer in time.";

// --- the platform -------------------------------------------------------------------

function platformLine(attribute: Single<AttributeEditability>): CheckLine {
  const topic = "The platform";
  if (attribute.kind !== "ok") return line("unknown", topic, noAccess(attribute, "this column's definition"));
  const valid = attribute.value.IsValidForUpdate;
  if (valid === false) {
    return line("cause", topic, "Dataverse does not allow updates to this column. The platform sets it, as for calculated, rollup and system columns.");
  }
  return valid === true
    ? line("ruledOut", topic, "Dataverse allows updates to this column.")
    : line("unknown", topic, "This column's definition does not say whether Dataverse allows updates to it.");
}

// --- column security -------------------------------------------------------------------

function columnSecurityLine(column: string, facts: LockedFacts): CheckLine {
  const topic = "Column security";
  const { attribute, columnSecurity } = facts;
  if (attribute.kind !== "ok") return line("unknown", topic, noAccess(attribute, "this column's definition"));
  if (attribute.value.IsSecured === false) return line("ruledOut", topic, "The column is not secured.");
  if (attribute.value.IsSecured !== true) return line("unknown", topic, "This column's definition does not say whether the column is secured.");
  if (!columnSecurity) return line("unknown", topic, "The column is secured, and Lite did not read its profiles.");

  const { permissions, profiles, mine, team } = columnSecurity;
  // A grant from one source stands even when the other could not be read, as
  // in privilegeLine. A failed read of the user's own profiles leaves the
  // answer unknown only when no team grant settles it first.
  const myProfiles = mine.kind === "ok" ? mine.value : [];
  const myIds = new Set(myProfiles.map((profile) => profile.fieldsecurityprofileid.toLowerCase()));
  const teamIds = new Set(team.kind === "ok" ? team.value.profileIds : []);
  if (myIds.has(SYSTEM_ADMINISTRATOR_PROFILE)) {
    return line("ruledOut", topic, "The column is secured. You hold the System Administrator profile, which can update every secured column.");
  }
  if (teamIds.has(SYSTEM_ADMINISTRATOR_PROFILE)) {
    return line("ruledOut", topic, "The column is secured. You hold the System Administrator profile through a team, which can update every secured column.");
  }
  if (permissions.kind !== "ok") return line("unknown", topic, `The column is secured. ${noAccess(permissions, "column security permissions")}`);

  const granting = permissions.value
    .filter((permission) => permission.attributelogicalname?.toLowerCase() === column && permission.canupdate === ALLOWED)
    .map((permission) => permission._fieldsecurityprofileid_value?.toLowerCase())
    .filter((id): id is string => !!id);
  const names = new Map(profiles.kind === "ok" ? profiles.value.map((profile) => [profile.fieldsecurityprofileid.toLowerCase(), profile.name ?? ""]) : []);
  for (const profile of myProfiles) names.set(profile.fieldsecurityprofileid.toLowerCase(), profile.name ?? "");
  const named = (ids: string[]) => ids.map((id) => names.get(id)?.trim() || "Unnamed profile").sort((a, b) => a.localeCompare(b));

  const mineGranting = granting.filter((id) => myIds.has(id));
  if (mineGranting.length > 0) {
    return line("ruledOut", topic, `The column is secured, and your profile grants update.`, named(mineGranting));
  }
  const teamGranting = granting.filter((id) => teamIds.has(id));
  if (teamGranting.length > 0) {
    return line("ruledOut", topic, "The column is secured, and a profile you hold through a team grants update.", named(teamGranting));
  }
  if (mine.kind !== "ok") return line("unknown", topic, `The column is secured. ${noAccess(mine, "your column security profiles")}`);
  const teamsHidden = team.kind === "ok" ? team.value.hidden : undefined;
  if (granting.length === 0) {
    // A team Lite could not read might hold the System Administrator profile,
    // which grants every secured column, so no grant is not yet a cause.
    if (teamsHidden) {
      return line(
        "unknown",
        topic,
        `The column is secured, and none of your own profiles grant update. A team you are in might hold System Administrator. ${teamsHiddenNote(teamsHidden, "Lite", "teams")}`,
      );
    }
    if (team.kind !== "ok") {
      return line(
        "unknown",
        topic,
        `The column is secured, and none of your own profiles grant update. A team you are in might hold System Administrator. ${noAccess(team, "your teams' column security profiles")}`,
      );
    }
    return line("cause", topic, "The column is secured, and no column security profile grants update on it.");
  }
  // Profiles grant update, and Lite read both the user's own and their teams'.
  // Only a team it could not read leaves room for one of them to apply.
  if (team.kind === "ok") {
    if (!teamsHidden) {
      return line("cause", topic, "The column is secured. Profiles grant update, but you hold none of them, yourself or through a team. Profiles that grant update:", named(granting));
    }
    return line(
      "unknown",
      topic,
      `The column is secured, and none of your own profiles grant update. A team you are in might. ${teamsHiddenNote(teamsHidden, "Lite", "teams")} Profiles that grant update:`,
      named(granting),
    );
  }
  return line(
    "unknown",
    topic,
    `The column is secured, and none of your own profiles grant update. A team you are in might. ${noAccess(team, "your teams' column security profiles")} Profiles that grant update:`,
    named(granting),
  );
}

// --- the form definition ------------------------------------------------------------------

function formLine(context: LockedContext, form: LockedFacts["form"], parsed: ParsedForm | null): CheckLine {
  const topic = "The form";
  if (!form) return line("unknown", topic, "The page did not say which form is open.");
  if (form.kind !== "ok") return line("unknown", topic, noAccess(form, "form definitions"));
  if (!form.value || !parsed) return line("unknown", topic, "Could not read this form's definition.");
  const formName = form.value.name?.trim() || "this form";
  const control = findControl(parsed.controls, context.control);
  if (!control) return line("unknown", topic, `Lite could not find this control in the definition of ${formName}.`);
  // The same test Pathix applies (DESIGN.md, "Lite and connected"): a control
  // that displays another form is locked whatever its disabled flag says.
  if (control.embed) return line("cause", topic, `The definition of ${formName} ${EMBED_CAUSE[control.embed]}`);
  if (control.disabled) return line("cause", topic, `The definition of ${formName} sets this control read-only.`);
  // A read that stopped early may have dropped what marks a control as embedded.
  if (!parsed.complete) return line("unknown", topic, `Could not read the definition of ${formName} in full, so Lite could not tell whether it locks this control.`);
  return line("ruledOut", topic, `The definition of ${formName} does not set this control read-only.`);
}

/** Why a quick view or a form component control cannot be edited, in the form's own terms. */
export const EMBED_CAUSE: Record<NonNullable<FormControl["embed"]>, string> = {
  quickView: "shows this control as a quick view. A quick view displays another record's form and cannot be edited here.",
  formComponent: "shows this control as a form component. A form component displays another form and cannot be edited here.",
};

/**
 * The control the page calls `name`. A form can hold one column twice; the
 * page then names the second "name1", the third "name2", and so on.
 */
export function findControl(controls: FormControl[], name: string): FormControl | null {
  return findByPageName(controls, (control) => control.id, name);
}

/**
 * The same lookup for any list of form controls kept in formxml order: exact id
 * first, else the page's numbered name read as the nth copy of the stripped id.
 * Pathix keeps one entry per control occurrence with the formxml id repeated,
 * so the number is an occurrence index there too.
 */
export function findByPageName<T>(items: readonly T[], idOf: (item: T) => string | null, name: string): T | null {
  const exact = items.filter((item) => idOf(item) === name);
  if (exact.length > 0) return exact[0]!;
  // The page's number is the trailing digits, but an id can end in digits too
  // ("emailaddress1" repeated is named "emailaddress11"). Try the shortest
  // number first, so the longest id wins, and take the first split whose id
  // is in the list.
  for (let split = name.length - 1; split > 0; split--) {
    const suffix = name.slice(split);
    if (!/^\d+$/.test(suffix)) break;
    const same = items.filter((item) => idOf(item) === name.slice(0, split));
    if (same.length > 0) return same[Number(suffix)] ?? null;
  }
  return null;
}

// --- business rules -------------------------------------------------------------------

function businessRuleLine(processes: Answer<ProcessRegistration[]>, dependents: ReadonlySet<string> | null): CheckLine {
  const topic = "Business rules";
  if (processes.kind !== "ok") return line("unknown", topic, noAccess(processes, "business rules"));
  const rules = processes.value.filter((row) => row.category === 2 && row.statecode === 1);
  if (rules.length === 0) {
    return processes.complete
      ? line("ruledOut", topic, "No business rule is active on this table.")
      : line("unknown", topic, partialRules(processes.hidden, "Of the business rules Lite can see, none is active on this table."));
  }
  if (!dependents) return line("unknown", topic, "Could not read which of the table's active business rules use this column.");
  const using = rules.filter(
    (rule) => dependents.has(rule.workflowid.toLowerCase()) || (!!rule._parentworkflowid_value && dependents.has(rule._parentworkflowid_value.toLowerCase())),
  );
  if (using.length === 0) {
    return processes.complete
      ? line("ruledOut", topic, "No active business rule uses this column.")
      : line("unknown", topic, partialRules(processes.hidden, "Of the active business rules Lite can see, none uses this column."));
  }
  const names = [...new Set(using.map((rule) => rule.name?.trim() || "Unnamed business rule"))].sort((a, b) => a.localeCompare(b));
  return line(
    "unknown",
    topic,
    `${names.length === 1 ? "1 active business rule uses" : `${names.length} active business rules use`} this column. Lite cannot read whether it locks it.`,
    names,
  );
}

/** Why Lite could not check every business rule, and what it found among the ones it could (`seen`). */
function partialRules(hidden: Hidden | undefined, seen: string): string {
  if (hidden === "some") return `You can see only some business rules, so Lite could not check them all. ${seen}`;
  if (hidden === "unknown") return `Lite could not check whether you can see all business rules. ${seen}`;
  return "Lite could not read every page of processes Dataverse returned, so it could not check them all.";
}

// --- the user's own privilege -------------------------------------------------------------

const DEPTHS: Record<string, string> = {
  Basic: "records you own or that are shared with you",
  Local: "records in your business unit",
  Deep: "records in your business unit and the ones below it",
};

/** Organization depth narrowed by a record filter: not every record. */
const FILTERED = "Filtered";

// A team role's depth is read against the team, not the user.
const TEAM_DEPTHS: Record<string, string> = {
  Basic: "records the team owns or that are shared with it, and possibly records you own",
  Local: "records in the team's business unit",
  Deep: "records in the team's business unit and the ones below it",
};

const DEPTH_ORDER = ["Global", "Deep", "Local", "Basic"];

export function privilegeLine(
  table: string,
  writePrivilege: Single<string | null>,
  privileges: Single<UserPrivileges> | null,
  team: Single<TeamPrivileges> | null,
  /** Who is reading, in the sentences that say what was not read: "Lite", or "This card" when connected. */
  reader = "Lite",
): CheckLine {
  const topic = "Your access to the table";
  if (writePrivilege.kind !== "ok") return line("unknown", topic, noAccess(writePrivilege, "this table's privileges"));
  const name = writePrivilege.value?.toLowerCase();
  if (!name || !privileges) return line("unknown", topic, `This table's definition does not name a Write privilege, so ${reader} could not check yours.`);

  // Depths from each source Lite could read. A grant from one source stands
  // even when the other could not be read; "no grant" needs both.
  const own = privileges.kind === "ok" ? depthsOf(privileges.value, name) : null;
  const viaTeam = team?.kind === "ok" ? new Set(team.value.depths) : null;
  const held = new Set([...(own ?? []), ...(viaTeam ?? [])]);
  if (held.size > 0) return grantLine(topic, table, held, own ?? new Set(), viaTeam ?? new Set(), reader);

  if (privileges.kind !== "ok") return line("unknown", topic, noAccess(privileges, "your privileges"));
  if (team?.kind !== "ok") {
    const unread = team ? noAccess(team, "the roles of your teams") : `${reader} did not read the roles of your teams.`;
    return line("unknown", topic, `Your own security roles do not grant Write on ${table}. ${unread} A role a team holds might grant it.`);
  }
  // A team or role the user cannot see may grant it, so "no grant" is not a cause.
  if (team.value.hidden) {
    return line("unknown", topic, `Your own security roles do not grant Write on ${table}. ${teamsHiddenNote(team.value.hidden, reader, team.value.hiddenPart)} A role a team holds might grant it.`);
  }
  return line(
    "cause",
    topic,
    team.value.teamCount === 0
      ? `Your security roles do not grant Write on ${table}.`
      : `Neither your security roles nor the roles of your teams grant Write on ${table}.`,
  );
}

function grantLine(topic: string, table: string, held: Set<string>, own: Set<string>, viaTeam: Set<string>, reader: string): CheckLine {
  const fromTeamOnly = (depth: string) => viaTeam.has(depth) && !own.has(depth);
  if (held.has("Global")) {
    return line(
      "ruledOut",
      topic,
      fromTeamOnly("Global")
        ? `A role you hold through a team grants Write on every ${table} record.`
        : `Your security roles grant Write on every ${table} record.`,
    );
  }
  const widest = DEPTH_ORDER.find((depth) => held.has(depth));
  if (!widest && viaTeam.has(TEAM_GLOBAL_UNCHECKED)) {
    return line(
      "unknown",
      topic,
      `A role you hold through a team grants Write on every ${table} record, unless a record filter narrows it. ${reader} cannot read a team role's record filter.`,
    );
  }
  if (!widest && held.has(FILTERED)) {
    return line("unknown", topic, `Your security roles grant Write on the ${table} records a record filter selects. ${reader} does not read whether this record is one of them.`);
  }
  if (!widest) return line("unknown", topic, `Your security roles grant Write at a depth ${reader} does not know. ${reader} does not read who owns this record.`);
  const text = fromTeamOnly(widest)
    ? `A role you hold through a team grants Write on ${TEAM_DEPTHS[widest]}.`
    : `Your security roles grant Write on ${DEPTHS[widest]}.`;
  return line("unknown", topic, `${text} ${reader} does not read who owns this record.`);
}

/**
 * The depths the user's own answer holds the privilege at; "Unknown" for a
 * depth Lite has no name for. Organization depth counts as every record only
 * with no record filter: narrowed by one it is FILTERED, and with no
 * RecordFilterId in the answer it is "Unknown" (recordFilterOf).
 */
function depthsOf(privileges: UserPrivileges, name: string): Set<string> {
  const writes = privileges.RolePrivileges.filter((privilege) => privilege.PrivilegeName?.toLowerCase() === name);
  return new Set(writes.map(depthOfRow));
}

function depthOfRow(privilege: UserPrivileges["RolePrivileges"][number]): string {
  if (!DEPTH_ORDER.includes(privilege.Depth)) return "Unknown";
  if (privilege.Depth !== "Global") return privilege.Depth;
  const filter = recordFilterOf(privilege);
  return filter === "none" ? "Global" : filter === "filtered" ? FILTERED : "Unknown";
}

// --- form scripts ------------------------------------------------------------------------

function scriptLine(column: string, form: LockedFacts["form"], parsed: ParsedForm | null): CheckLine {
  const topic = "Form scripts";
  if (!form) return line("unknown", topic, "The page did not say which form is open, so Lite could not read its scripts.");
  if (form.kind !== "ok") return line("unknown", topic, noAccess(form, "form definitions"));
  if (!parsed) return line("unknown", topic, "Could not read this form's scripts.");
  // A parse that stopped early may have dropped the form-level events, which come last.
  if (!parsed.complete) return line("unknown", topic, "Could not read this form's definition in full, so Lite could not tell what scripts it runs.");
  // No handler in the form definition does not rule scripts out: command bar
  // enable rules, PCF controls and app-level scripts can lock a field too, and
  // none of them is in formxml. So this stays ?, never ✓.
  if (parsed.handlers.length === 0) return line("unknown", topic, NO_FORM_HANDLERS);

  // Any enabled handler, on any event, could lock the field: OnSave, a tab
  // opening, a control's own event. Only the ones closest to this column are
  // named; the rest are counted, never dropped.
  const isNamed = (handler: FormHandler) => handler.event === "onload" || (handler.event === "onchange" && handler.attribute === column);
  const named = parsed.handlers.filter(isNamed);
  const names = [
    ...named.filter((handler) => handler.event === "onload").map((handler) => `OnLoad: ${handlerName(handler)}`),
    ...named.filter((handler) => handler.event === "onchange").map((handler) => `On change: ${handlerName(handler)}`),
  ];
  const rest = parsed.handlers.filter((handler) => !isNamed(handler));
  const events = [...new Set(rest.map(eventLabel))];
  const others =
    rest.length === 0 ? "" : ` ${rest.length === 1 ? "1 more handler runs" : `${rest.length} more handlers run`} on other events: ${events.join(", ")}.`;

  if (names.length === 0) return line("unknown", topic, `No form script runs on load or when this column changes.${others} Lite cannot read whether they lock it.`);
  return line("unknown", topic, `These form scripts might lock it.${others} Lite cannot read what they do.`, names);
}

/** The scripts line when the form definition registers no enabled handler. */
export const NO_FORM_HANDLERS = "This form has no enabled event handlers. Lite does not read command bar scripts, control scripts or app-level scripts, which can also lock a field.";

const EVENT_LABELS: Record<string, string> = {
  onload: "OnLoad",
  onsave: "OnSave",
  onchange: "another column's OnChange",
  tabstatechange: "TabStateChange",
  onreadystatecomplete: "OnReadyStateComplete",
  presearch: "PreSearch",
};

function eventLabel(handler: FormHandler): string {
  return EVENT_LABELS[handler.event] ?? (handler.event || "an unnamed event");
}

function handlerName(handler: FormHandler): string {
  const where = handler.library ? ` in ${handler.library}` : "";
  return `${handler.functionName || "unnamed function"}${where}${handler.internal ? " (internal handler)" : ""}`;
}

// --- the record --------------------------------------------------------------------------

const RECORD_LINE: CheckLine = line(
  "unknown",
  "The record",
  "An inactive record, or one shared with you read-only, is locked as a whole. Lite does not read the record.",
);

// --- formxml -----------------------------------------------------------------------------

export interface FormControl {
  id: string;
  column: string | null;
  disabled: boolean;
  /**
   * What the control displays instead of editing the column: a quick view or a
   * form component host. Either is locked, whatever `disabled` says, the same
   * test Pathix applies when it reads the form (DESIGN.md, "Lite and connected").
   */
  embed: "quickView" | "formComponent" | null;
}

/** Where in the form definition an event is declared. */
export type HandlerScope = "form" | "tab" | "control" | "other";

export interface FormHandler {
  event: string;
  /** For onchange: the column it is registered on. */
  attribute: string | null;
  functionName: string;
  library: string;
  /** Declared under InternalHandlers: the platform's own form logic. */
  internal: boolean;
  /** The handler's own enabled flag. The checklist's `handlers` list holds only enabled ones. */
  enabled: boolean;
  /** Where the event is declared: on the form, on a tab, or on a control's cell. */
  scope: HandlerScope;
  /** For a tab: the tab's name. */
  tab: string | null;
  /** For a control: the control's id, and the column it is bound to when it is bound. */
  control: string | null;
  controlColumn: string | null;
}

export interface ParsedForm {
  controls: FormControl[];
  /** The enabled script handlers of each event, which is what the "Why locked?" checklist reads. */
  handlers: FormHandler[];
  /** Every handler the definition declares, enabled or not, in definition order. The event map reads this. */
  allHandlers: FormHandler[];
  /**
   * The definition was read to its end: one form element, every tag closed.
   * A map built from an incomplete read must say it could not read the form,
   * never "no handlers" (DESIGN.md, "Absence is not evidence").
   */
  complete: boolean;
}

interface OpenTag {
  name: string;
  attributes: Record<string, string>;
}

interface CellInfo {
  control: string | null;
  column: string | null;
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Reads the parts of a form definition the checklist and the event map need:
 * each control's id, column and disabled flag, and the script handlers of each
 * event with where the event is declared. Regular expressions over the tags,
 * not a DOM parser, so it runs the same in tests. The formxml is form
 * metadata: names of events, libraries and functions, never record data.
 */
export function parseFormXml(formxml: string): ParsedForm {
  const reads: ControlRead[] = [];
  let control: ControlRead | null = null;

  const allHandlers: FormHandler[] = [];
  const cellOf = new Map<FormHandler, CellInfo>();
  const stack: OpenTag[] = [];
  const cells: CellInfo[] = [];
  let forms = 0;
  let closedForms = 0;
  let balanced = true;
  let event: OpenTag | null = null;
  let block: "InternalHandlers" | "Handlers" | null = null;
  let eventParent = "";

  // Comments and CDATA text are not tags.
  const text = formxml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  for (const match of text.matchAll(TAG)) {
    const closing = match[1] === "/";
    const name = match[2]!;
    const selfClosing = match[4] === "/";
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) {
        balanced = false;
        break;
      }
      if (name === "form") closedForms++;
      if (name === "control" && control) {
        reads.push(control);
        control = null;
      }
      if (name === "cell") cells.pop();
      if (name === "event") event = null;
      if (name === "InternalHandlers" || name === "Handlers") block = null;
      continue;
    }

    const attributes = attributesOf(match[3] ?? "");
    if (name === "form") forms++;
    if (name === "events") eventParent = stack[stack.length - 1]?.name ?? "";
    if (name === "cell") cells.push({ control: null, column: null });
    if (name === "control") {
      const read = controlRead(attributes);
      if (selfClosing) reads.push(read);
      else control = read;
      const cell = cells[cells.length - 1];
      if (cell && cell.control === null) {
        cell.control = attributes.id ?? null;
        cell.column = attributes.datafieldname ?? null;
      }
    }
    // A quick view control carries the QuickForm element family in its parameters.
    if (control && QUICK_FORM_TAGS.has(name)) control.quickView = true;
    if (name === "event") event = { name, attributes };
    if (name === "InternalHandlers" || name === "Handlers") block = event ? name : null;
    if (name === "Handler" && event && block) {
      const scope: HandlerScope = eventParent === "form" ? "form" : eventParent === "tab" ? "tab" : eventParent === "cell" ? "control" : "other";
      const tab = [...stack].reverse().find((open) => open.name === "tab");
      const handler: FormHandler = {
        event: (event.attributes.name ?? "").toLowerCase(),
        attribute: event.attributes.attribute?.toLowerCase() ?? null,
        functionName: attributes.functionName ?? "",
        library: attributes.libraryName ?? "",
        internal: block === "InternalHandlers",
        enabled: attributes.enabled !== "false",
        scope,
        tab: scope === "tab" ? (tab?.attributes.name ?? null) : null,
        control: null,
        controlColumn: null,
      };
      if (scope === "control") cellOf.set(handler, cells[cells.length - 1] ?? { control: null, column: null });
      allHandlers.push(handler);
    }
    if (!selfClosing) stack.push({ name, attributes });
    else if (name === "cell") cells.pop();
    else if (name === "form") closedForms++;
  }
  // A cell's control can come after its events, so it is filled in at the end.
  for (const [handler, cell] of cellOf) {
    handler.control = cell.control;
    handler.controlColumn = cell.column;
  }
  // A control the read stopped inside of is still a control, and it is not known to be plain.
  if (control) reads.push(control);
  const complete = balanced && stack.length === 0 && forms === 1 && closedForms === 1;
  const controls = withEmbeds(reads, formComponentHostIds(text));
  return { controls, handlers: allHandlers.filter((handler) => handler.enabled), allHandlers, complete };
}

/** A control as the tag scan sees it, before its embeds are decided. */
interface ControlRead {
  id: string;
  column: string | null;
  disabled: boolean;
  uniqueId: string | null;
  quickView: boolean;
}

const QUICK_FORM_TAGS = new Set(["QuickForms", "QuickFormIds", "QuickFormId"]);

function controlRead(attributes: Record<string, string>): ControlRead {
  return {
    id: attributes.id ?? "",
    column: attributes.datafieldname ?? null,
    disabled: attributes.disabled === "true",
    uniqueId: normalizedId(attributes.uniqueid),
    quickView: false,
  };
}

function normalizedId(raw: string | undefined): string | null {
  const id = (raw ?? "").replace(/[{}]/g, "").trim().toLowerCase();
  return id === "" ? null : id;
}

/**
 * The `uniqueid` of every control that hosts a form component: a
 * controlDescription whose custom control carries a QuickForms parameter that
 * names at least one form. Pathix finds them the same way (FormxmlControlShape),
 * by shape and not by class id, since class ids drift. The parameter holds its
 * form ids as escaped text, so it is decoded before it is looked at.
 */
function formComponentHostIds(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const description of text.matchAll(/<controlDescription\b([^>]*)>([\s\S]*?)<\/controlDescription>/g)) {
    const host = normalizedId(attributesOf(description[1] ?? "").forControl);
    if (!host) continue;
    for (const parameter of (description[2] ?? "").matchAll(/<QuickForms\b[^>]*>([\s\S]*?)<\/QuickForms>/g)) {
      if (/<QuickFormId\b/.test(decodeEntities(parameter[1] ?? ""))) hosts.add(host);
    }
  }
  return hosts;
}

// A quick view host is never also a form component host, so the two stay apart.
function withEmbeds(reads: ControlRead[], formComponentHosts: Set<string>): FormControl[] {
  return reads.map((read) => ({
    id: read.id,
    column: read.column,
    disabled: read.disabled,
    embed: read.quickView ? "quickView" : read.uniqueId !== null && formComponentHosts.has(read.uniqueId) ? "formComponent" : null,
  }));
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) attributes[match[1]!] = decodeEntities(match[2]!);
  return attributes;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The mark each state shows. */
export const CHECK_MARKS: Record<CheckState, string> = { ruledOut: "✓", cause: "✗", unknown: "?", checking: "…" };
