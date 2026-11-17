// "Why can't I edit this field?" on the connected card, as plain data, tested
// without a DOM.
//
// Two kinds of fact meet here, and each line says which it is:
// - From Pathix, as of its scan: whether the open form's definition sets the
//   control read-only, and which column security profiles grant
//   update on the column.
// - Live from Dataverse, labelled "live": the signed-in user's own state, their
//   profiles and their own access to the table. That is the one part of this
//   card that is read live (the user's own security state); nothing else here
//   is.
//
// The control is matched by its id. A control Pathix does not list on the form
// is unknown. It never falls back to the form-level answer, which describes
// only the controls Pathix lists.
//
// A line Pathix cannot answer is marked ?, never dropped and never ruled out
// (DESIGN.md, "Absence is not evidence").

import type { FieldDependents, FieldPermissions, FormControlSummary } from "../pathix/api";
import type { FieldSecurityProfile, UserPrivileges } from "../dataverse/queries";
import {
  EMBED_CAUSE,
  findByPageName,
  line,
  noAccess,
  privilegeLine,
  SYSTEM_ADMINISTRATOR_PROFILE,
  teamsHiddenNote,
  type CheckLine,
  type LockedCardModel,
  type Single,
  type TeamPrivileges,
  type TeamProfiles,
} from "./locked";

export const CONNECTED_LOCKED_STATUS = "Form and column security as of the scan; your access live";

/** A form Pathix read the column on, with what it kept of the controls. */
export interface PathixFormRead {
  /** The form's Dataverse id; null when Pathix did not give one. */
  formId: string | null;
  name: string;
  /** null: Pathix has no control list for this form, which is unknown. */
  controls: FormControlSummary[] | null;
}

/** What the connected card carries from Pathix for the checklist. Plain data, so it crosses the worker boundary. */
export interface LockedPathixFacts {
  /** The forms Pathix read this column on; null when the read that lists them failed. */
  forms: PathixFormRead[] | null;
  /** From the column's permissions; null when that read failed. */
  security: {
    secured: boolean;
    updateProfiles: UpdateProfile[];
    /**
     * Principals that records share the column with (per-record field sharing,
     * which no profile governs). 0 is "none found as of the scan", never proof;
     * null when Pathix did not say.
     */
    sharedWith?: number | null;
    /** Pathix said the share counts are incomplete, so sharedWith is a floor and 0 is not measured. */
    sharingIncomplete?: boolean;
  } | null;
}

/** A column security profile Pathix says grants update: its Dataverse id, which is what matches, and its name, which is shown. */
export interface UpdateProfile {
  id: string;
  name: string;
}

/** The signed-in user's own state, read live. Each part keeps its own failure. */
export interface LiveUserFacts {
  writePrivilege: Single<string | null>;
  privileges: Single<UserPrivileges> | null;
  teamPrivileges: Single<TeamPrivileges> | null;
  /** The user's own column security profiles. */
  mine: Single<FieldSecurityProfile[]>;
  /** Profiles held through the user's teams, by id. */
  team: Single<TeamProfiles>;
}

/**
 * What the live read of the user's own state came to: the facts, null when it
 * failed, "checking" while it runs, "timedOut" when it did not answer in time.
 * Neither of the last two is ever a verdict.
 */
export type LiveUserRead = LiveUserFacts | null | "checking" | "timedOut";

/** Said on each live line when the user's own reads did not answer in time. */
export const LIVE_TIMED_OUT = "Could not read your access in time.";

export interface ConnectedLockedContext {
  table: string;
  column: string;
  /** The form control the user is on, e.g. "header_creditlimit". */
  control: string;
  /** The open form; null when the page did not say. */
  formId: string | null;
}

export const CONNECTED_LOCKED_TITLE = "Why can't I edit this field?";

/** What the worker puts on the card: the forms Pathix read the column on, and the column's security. */
export function lockedFactsFrom(dependents: FieldDependents | null, permissions: FieldPermissions | null): LockedPathixFacts {
  return {
    forms: dependents ? formReads(dependents) : null,
    security: permissions
      ? {
          secured: permissions.isSecured,
          updateProfiles: permissions.grants.filter((grant) => grant.canUpdate).map((grant) => ({ id: grant.profileId, name: grant.profileName })),
          sharedWith: shareCountOf(permissions),
          sharingIncomplete: permissions.shareCoverageIncomplete === true,
        }
      : null,
  };
}

/** How many principals records share the column with, or null when Pathix did not say. */
function shareCountOf(permissions: FieldPermissions): number | null {
  const count = permissions.sharePrincipalCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

// A form's own read of the column is the row whose type is Form and whose kind
// is Display. An older Pathix names no kind and keeps no controls: unknown.
function formReads(dependents: FieldDependents): PathixFormRead[] {
  const reads = new Map<string, PathixFormRead>();
  for (const row of dependents.results) {
    if (row.componentType !== "Form") continue;
    if (row.referenceKind !== undefined && row.referenceKind !== "Display") continue;
    const formId = row.sourceId ? row.sourceId.toLowerCase() : null;
    const read: PathixFormRead = { formId, name: row.componentName?.trim() || "this form", controls: row.formControls ?? null };
    const key = formId ?? row.componentId;
    const held = reads.get(key);
    if (!held || (held.controls === null && read.controls !== null)) reads.set(key, read);
  }
  return [...reads.values()];
}

export function buildConnectedLockedCard(
  context: ConnectedLockedContext,
  pathix: LockedPathixFacts,
  user: LiveUserRead,
): LockedCardModel {
  const lines = [
    formLine(context, pathix.forms),
    columnSecurityLine(pathix.security, user),
    accessLine(context.table, user),
    ...STATIC_LINES,
  ];
  return {
    table: context.table,
    column: context.column,
    status: CONNECTED_LOCKED_STATUS,
    title: CONNECTED_LOCKED_TITLE,
    headline: headlineOf(lines),
    lines,
    info: [
      "The form line is from Pathix's scan of the open form, matched to this control by its id, counting repeated ids in form order. It is what the form declares: a script or a business rule can still lock or unlock a control, and a field security profile or the record's state can still make an editable control read-only.",
      "Column security names the profiles Pathix found that grant update. Whether you hold one is read live from Dataverse, as you, and matched by the profile's id, so a renamed profile still matches.",
      "Your access to the table is read live from Dataverse, as you.",
      "✓ means the card read the answer and it does not lock the field. ✗ means it does. ? means the card cannot tell, or could not read it.",
    ],
    tip: null,
  };
}

function headlineOf(lines: CheckLine[]): string {
  if (lines.some((entry) => entry.state === "checking")) return "Checking your own access, live from Dataverse…";
  const causes = lines.filter((entry) => entry.state === "cause").length;
  const unknown = lines.filter((entry) => entry.state === "unknown").length;
  const found = causes === 0 ? "Everything this card can read is ruled out." : causes === 1 ? "Found 1 likely cause." : `Found ${causes} likely causes.`;
  if (unknown === 0) return found;
  return `${found} ${unknown === 1 ? "1 thing it cannot check is" : `${unknown} things it cannot check are`} marked ?.`;
}

// --- the form ---------------------------------------------------------------------------

function formLine(context: ConnectedLockedContext, forms: PathixFormRead[] | null): CheckLine {
  const topic = "The form";
  if (forms === null) return line("unknown", topic, "Could not read where Pathix found this column on forms.");
  if (!context.formId) return line("unknown", topic, "The page did not say which form is open.");
  const form = forms.find((candidate) => candidate.formId === context.formId!.toLowerCase());
  if (!form) {
    return line("unknown", topic, "Pathix has no read of this column on the open form. The form may be newer than its latest scan.");
  }
  if (form.controls === null) return line("unknown", topic, `Pathix did not keep the controls of ${form.name}.`);

  // By id, the way Lite finds it: Pathix lists one entry per control occurrence
  // with the formxml id repeated, and the page names the second copy "id1". A
  // control Pathix does not list is unknown, never the form's own answer.
  const control = findByPageName(form.controls, (candidate) => candidate.controlId, context.control);
  if (!control) {
    return line(
      "unknown",
      topic,
      `Pathix does not list a control named ${context.control} on ${form.name}. The form may have changed since the scan, or the control may sit somewhere Pathix does not read, such as the process header.`,
    );
  }
  const embed = control.embed === "quickView" || control.embed === "formComponent" ? control.embed : null;
  if (embed) return line("cause", topic, `The scan of ${form.name} ${EMBED_CAUSE[embed]}`);
  if (control.locked) return line("cause", topic, `The scan of ${form.name} shows this control read-only.`);
  return line("ruledOut", topic, `The scan of ${form.name} does not show this control read-only.`);
}

// --- column security --------------------------------------------------------------------

function columnSecurityLine(security: LockedPathixFacts["security"], user: LiveUserRead): CheckLine {
  const topic = "Column security";
  if (!security) return line("unknown", topic, "Could not read this column's security from Pathix.");
  if (!security.secured) return line("ruledOut", topic, "The column is not secured.");
  if (user === "checking") return live(line("checking", topic, "The column is secured. Checking which profiles you hold…"));
  if (user === "timedOut") return live(line("unknown", topic, `The column is secured. ${LIVE_TIMED_OUT}`));
  if (!user) return live(line("unknown", topic, "The column is secured, and the card could not read which profiles you hold."));

  const mine = user.mine.kind === "ok" ? user.mine.value : [];
  const mineIds = new Set(mine.map((profile) => profile.fieldsecurityprofileid.toLowerCase()));
  const teamIds = new Set(user.team.kind === "ok" ? user.team.value.profileIds : []);
  if (mineIds.has(SYSTEM_ADMINISTRATOR_PROFILE)) {
    return live(line("ruledOut", topic, "The column is secured. You hold the System Administrator profile, which can update every secured column."));
  }
  if (teamIds.has(SYSTEM_ADMINISTRATOR_PROFILE)) {
    return live(line("ruledOut", topic, "The column is secured. You hold the System Administrator profile through a team, which can update every secured column."));
  }

  // By profile id, never by name: a profile can be renamed after the scan, and
  // two profiles can share a name.
  const heldIds = new Set([...mineIds, ...teamIds]);
  const granting = security.updateProfiles;
  const matched = granting.filter((profile) => heldIds.has(profile.id.toLowerCase())).map((profile) => profile.name);
  if (matched.length > 0) {
    return live(line("ruledOut", topic, "The column is secured, and a profile you hold grants update.", sorted(matched)));
  }

  // No match among what was read. That is a cause only if all of it was read.
  const unread = firstUnread(user);
  if (unread) {
    return live(
      line(
        "unknown",
        topic,
        `The column is secured, and none of the profiles the card could read grant update. ${unread}${granting.length > 0 ? " Profiles that grant update:" : ""}`,
        sorted(granting.map((profile) => profile.name)),
      ),
    );
  }
  // Per-record field sharing can still give you update on this record, and no
  // profile governs it. A count is as of the scan, names principals rather
  // than you, and is 0 on a scan that predates it, so no count makes this a
  // cause: the line stays ?, and says what Pathix found, not that none exists.
  // When Pathix says the counts are incomplete, the count is a floor and 0 is
  // not measured, and the line says that instead.
  const sharing = sharingNote(security.sharedWith, security.sharingIncomplete === true);
  const state = "unknown";
  if (granting.length === 0) {
    return live(line(state, topic, `The column is secured. No column security profile grants update. ${sharing}`));
  }
  return live(
    line(
      state,
      topic,
      `The column is secured. Profiles grant update, but you hold none of them, yourself or through a team. ${sharing} Profiles that grant update:`,
      sorted(granting.map((profile) => profile.name)),
    ),
  );
}

// Why the share counts are incomplete. Dataverse shows Pathix's scanner role few
// or none of a secured column's record shares, and the read does not fail, so
// Pathix sets shareCoverageIncomplete on every secured column.
// That is a standing limit, not a failed scan, so the note never says the scan
// failed. An earlier Pathix set the flag only for a short read; the
// scanner saw as little then, so this wording is true of that flag too.
const SCANNER_SHARE_VISIBILITY = "Dataverse shows Pathix's scanner few or none of a column's record shares";

/** What Pathix said about per-record sharing of the column. Never a claim that there is none. */
function sharingNote(sharedWith: number | null | undefined, incomplete: boolean): string {
  if (incomplete) {
    if (typeof sharedWith === "number" && sharedWith > 0) {
      return `Records can still share the column. Pathix found it shared with at least ${principals(sharedWith)}. ${SCANNER_SHARE_VISIBILITY}, so there may be more.`;
    }
    return `Records can still share the column. ${SCANNER_SHARE_VISIBILITY}, so Pathix cannot say whether this column is shared.`;
  }
  if (sharedWith === 0) return "Records can still share the column. Pathix did not find sharing for this column. That does not prove there is none.";
  if (typeof sharedWith === "number" && sharedWith > 0) {
    return `Records can still share the column, and Pathix found it shared with ${principals(sharedWith)}.`;
  }
  return "Records can still share the column.";
}

function principals(count: number): string {
  return count === 1 ? "1 principal" : `${count} principals`;
}

function firstUnread(user: LiveUserFacts): string | null {
  if (user.mine.kind !== "ok") return noAccess(user.mine, "your column security profiles");
  if (user.team.kind !== "ok") return `${noAccess(user.team, "your teams' column security profiles")} A team you are in might hold System Administrator.`;
  if (user.team.value.hidden) return `${teamsHiddenNote(user.team.value.hidden, "This card", "teams")} A team you are in might hold System Administrator.`;
  return null;
}

function sorted(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim() || "Unnamed profile"))].sort((a, b) => a.localeCompare(b));
}

// --- your access ------------------------------------------------------------------------

function accessLine(table: string, user: LiveUserRead): CheckLine {
  if (user === "checking") return live(line("checking", "Your access to the table", "Checking your access to the table…"));
  if (user === "timedOut") return live(line("unknown", "Your access to the table", LIVE_TIMED_OUT));
  if (!user) return live(line("unknown", "Your access to the table", "Could not read your access to the table."));
  return live(privilegeLine(table, user.writePrivilege, user.privileges, user.teamPrivileges, "This card"));
}

function live(entry: CheckLine): CheckLine {
  return { ...entry, live: true };
}

// --- what this card does not check --------------------------------------------------------

const STATIC_LINES: CheckLine[] = [
  line(
    "unknown",
    "Business rules and form scripts",
    "Pathix lists the business rules and form scripts that use this column among its writers and readers. It cannot read whether they lock it.",
  ),
  line(
    "unknown",
    "The platform",
    "This card does not check whether Dataverse allows updates to this column. The platform sets some columns itself, such as calculated and rollup columns.",
  ),
  line(
    "unknown",
    "The record",
    "An inactive record, or one shared with you read-only, is locked as a whole. This card does not read the record.",
  ),
];
