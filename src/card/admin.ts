// The models behind the admin center overlay (M14): the role editor banner,
// the role-list badge and the application-user chip. Pure functions from
// Pathix's answers to the strings the page script shows as text.
//
// Absence is not evidence (DESIGN.md): an answer that failed or is missing is
// "unknown", never "0 humans". A count of zero is only ever the answer of a
// read that succeeded. Everything here is from the latest Completed scan, so
// every model says so and carries the scan date.

import type { AppUserChipModel, RoleBadgeModel, RoleBannerModel } from "../runtime/admin-overlay";
import type { OpenFindingCounts, PrincipalRow, PrincipalsByAppId, RoleSummary } from "../pathix/api";
import { findingsComplete } from "./model";

export interface AdminContext {
  pathixUrl: string;
  environmentId: string;
  scanCompletedAt: string;
  formatDate: (iso: string) => string;
}

/** Highest first. A severity Pathix adds later sorts last and still shows, under its own name. */
const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Info"];

export const ASSIGNMENTS_UNKNOWN = "Assignments: unknown";
export const FINDINGS_UNKNOWN = "Open findings: unknown";
/** A zero that covers only this role, while same-name rows (business unit copies) may have open findings of their own. */
export const FINDINGS_NONE_HERE = "Open findings: unknown (none name this role itself; its copies are not counted)";
/**
 * Pathix counts open findings the way its findings page lists them: Open or Reviewing in the admin's triage,
 * without system noise and without the finding types the admin suppressed. The line says so.
 */
export const NO_FINDINGS = "No open findings name this role (system noise and suppressed types hidden, as in Pathix)";

/** What Pathix knows about the open findings that name one role. */
export interface RoleFindings {
  count: number;
  /** The most severe, or null when there are none. */
  highest: string | null;
  /** Some of the role's rows (its business unit copies) were not in the answer, so the count leaves them out. */
  partial: boolean;
}

export function scanLine(context: AdminContext): string {
  return `From Pathix's latest scan, ${context.formatDate(context.scanCompletedAt)}`;
}

/** The answer is the list of roles the contract promises: a malformed row would make every sum below wrong. */
export function isRoleList(value: unknown): value is RoleSummary[] {
  return Array.isArray(value) && value.every(isRoleRow);
}

function isRoleRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.sourceId === "string" && typeof row.name === "string" && isCount(row.assignmentCount);
}

/**
 * The role a Dataverse id names: the row whose sourceId it is. A business unit
 * copy of a role has its own sourceId, so an id that is a copy's finds the
 * copy. null when the id is not in the scan, which is unknown, not "unused".
 */
export function findRole(roles: RoleSummary[], sourceId: string): RoleSummary | null {
  const wanted = sourceId.toLowerCase();
  return roles.find((role) => role.sourceId.toLowerCase() === wanted) ?? null;
}

// --- folding business unit copies into their root ------------------------------------

/**
 * How a role's numbers relate to the role the admin center shows. Dataverse keeps one copy of every role per
 * business unit, and Pathix lists every copy as its own row with its own holders. The admin center lists root
 * roles.
 */
export type Fold =
  /** The role and every business unit copy of it, summed: the numbers are the role's whole. `copies` can be 0. */
  | { kind: "whole"; copies: number }
  /** The row is itself a business unit copy: its numbers are exact for that copy, and for it alone. */
  | { kind: "copy" }
  /** The scan does not say which rows are copies, and other rows share the name: this row's numbers are a minimum. */
  | { kind: "partial"; sameName: number };

/** A role as the overlay shows it: the row the admin center's id names, and the rows whose numbers are summed. */
export interface RoleGroup {
  /** The row the id names. "Open in Pathix" opens it. */
  role: RoleSummary;
  /** The role first, then its copies when they are known. */
  rows: RoleSummary[];
  fold: Fold;
}

/**
 * Whether the role list says which rows are business unit copies (the fold rule, DESIGN.md "The admin center
 * overlay"):
 * - a row names a parent root role: the scan carries the column, so every copy names its root and a root with no
 *   copy has none. The fold is exact;
 * - no row names one and no two rows share a name: there is one business unit (with more, every role would have
 *   a same-name copy), so every row is a whole role and the numbers are exact;
 * - no row names one but rows share a name: the scan predates the column, so which rows are copies is not known.
 *   Each row's numbers then cover that row only, and read as a minimum.
 */
export function foldIsExact(roles: RoleSummary[]): boolean {
  if (roles.some((role) => isId(role.parentRootRoleId))) return true;
  const names = new Set<string>();
  for (const role of roles) {
    const name = nameKey(role);
    if (names.has(name)) return false;
    names.add(name);
  }
  return true;
}

/** The group for the role a Dataverse id names. null when the id is not in the scan. */
export function roleGroup(roles: RoleSummary[], sourceId: string, exact = foldIsExact(roles)): RoleGroup | null {
  const role = findRole(roles, sourceId);
  if (!role) return null;
  if (!exact) {
    const sameName = roles.filter((other) => other.id !== role.id && nameKey(other) === nameKey(role)).length;
    return { role, rows: [role], fold: sameName > 0 ? { kind: "partial", sameName } : { kind: "whole", copies: 0 } };
  }
  if (isCopy(role)) return { role, rows: [role], fold: { kind: "copy" } };
  const copies = roles.filter((other) => other.id !== role.id && sameId(other.parentRootRoleId, role.sourceId));
  return { role, rows: [role, ...copies], fold: { kind: "whole", copies: copies.length } };
}

/** Dataverse stamps a root with its own id and Pathix folds that to null; a self-reference is still a root. */
function isCopy(role: RoleSummary): boolean {
  return isId(role.parentRootRoleId) && !sameId(role.parentRootRoleId, role.sourceId);
}

function nameKey(role: RoleSummary): string {
  return role.name.trim().toLowerCase();
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sameId(a: string | null | undefined, b: string): boolean {
  return isId(a) && a.toLowerCase() === b.toLowerCase();
}

// --- who holds the role ----------------------------------------------------------------

/** Direct holders by kind. A team's members are not counted. */
export interface Kinds {
  humans: number;
  integrations: number;
  /** Users and application users the platform manages (Power Pages site users, agents, unlicensed activity parties). Never humans or integrations. */
  platformManaged: number;
  teams: number;
  /** Holders the four counts do not cover: a kind Pathix adds later. Counted, never dropped. */
  other: number;
}

export interface Holders {
  /** Direct holders of every kind, summed over the group's rows. */
  total: number;
  /** null when the answer has no split by kind (an older Pathix) or its split does not add up. */
  kinds: Kinds | null;
}

/** Sums the group's rows. Each business unit copy belongs to one business unit, so the sum counts holders. */
export function holdersOf(rows: RoleSummary[]): Holders {
  let total = 0;
  let kinds: Kinds | null = { humans: 0, integrations: 0, platformManaged: 0, teams: 0, other: 0 };
  for (const row of rows) {
    total += row.assignmentCount;
    const split = kindsOf(row);
    kinds =
      kinds && split
        ? {
            humans: kinds.humans + split.humans,
            integrations: kinds.integrations + split.integrations,
            platformManaged: kinds.platformManaged + split.platformManaged,
            teams: kinds.teams + split.teams,
            other: kinds.other + split.other,
          }
        : null;
  }
  return { total, kinds };
}

function kindsOf(row: RoleSummary): Kinds | null {
  const { humanAssignmentCount, integrationAssignmentCount, platformManagedAssignmentCount, teamAssignmentCount } = row;
  if (!isCount(humanAssignmentCount) || !isCount(integrationAssignmentCount) || !isCount(platformManagedAssignmentCount) || !isCount(teamAssignmentCount)) {
    return null;
  }
  const other = row.assignmentCount - humanAssignmentCount - integrationAssignmentCount - platformManagedAssignmentCount - teamAssignmentCount;
  if (other < 0) return null;
  return {
    humans: humanAssignmentCount,
    integrations: integrationAssignmentCount,
    platformManaged: platformManagedAssignmentCount,
    teams: teamAssignmentCount,
    other,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// --- open findings --------------------------------------------------------------------

/** Open findings per role, by the role's Pathix id, from one or more open-counts answers. */
export interface RoleOpenCounts {
  byRole: Map<string, { count: number; highest: string | null }>;
  /** Every answer's findings sweep finished with every detector, so a zero is a verdict. */
  complete: boolean;
}

/**
 * Reads the `roles` part of open-counts answers. An answer that failed (null), or that has no `roles` list (a
 * Pathix that does not filter by role), says nothing: its roles are simply not in the map. null when no answer says anything.
 */
export function roleOpenCounts(answers: Array<OpenFindingCounts | null>): RoleOpenCounts | null {
  const usable = answers.filter((answer): answer is OpenFindingCounts => answer !== null && Array.isArray(answer.roles));
  if (usable.length === 0) return null;
  const byRole = new Map<string, { count: number; highest: string | null }>();
  for (const answer of usable) {
    for (const row of answer.roles ?? []) {
      const count = Number(row.openCount);
      if (typeof row.roleId !== "string" || !isCount(count)) continue;
      byRole.set(row.roleId.toLowerCase(), { count, highest: count > 0 ? row.maxOpenSeverity ?? null : null });
    }
  }
  return { byRole, complete: usable.every((answer) => findingsComplete(answer.readiness)) };
}

/**
 * One role's open findings, summed over its rows. A row the answer left out is not in the latest scan, or its
 * request failed: the sum then leaves it out (`partial`), and a zero means nothing. A zero over every row is "none"
 * only when the scan's findings sweep finished with every detector (the same rule as the card's flag count).
 */
export function findingsFor(counts: RoleOpenCounts | null, rows: RoleSummary[]): RoleFindings | null {
  if (!counts) return null;
  let count = 0;
  let highest: string | null = null;
  let partial = false;
  for (const row of rows) {
    const found = counts.byRole.get(row.id.toLowerCase());
    if (!found) {
      partial = true;
      continue;
    }
    count += found.count;
    if (severityRank(found.highest) < severityRank(highest)) highest = found.highest;
  }
  if (count === 0 && (partial || !counts.complete)) return null;
  return { count, highest, partial };
}

function severityRank(severity: string | null): number {
  if (severity === null) return Number.MAX_SAFE_INTEGER;
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function roleHref(context: AdminContext, role: RoleSummary): string {
  return `${context.pathixUrl}/roles/${encodeURIComponent(role.id)}?${new URLSearchParams({ env: context.environmentId }).toString()}`;
}

// --- the role editor banner ------------------------------------------------------

/**
 * Whether the banner tells the admin anything about this role: a headline, a findings answer or a team.
 * The copies note alone does not count. It says nothing about this role and the admin center already shows
 * the role, so a banner of two "unknown" lines and that note is not drawn.
 */
export function bannerKnowsAnything(banner: RoleBannerModel): boolean {
  return banner.assigned !== ASSIGNMENTS_UNKNOWN || banner.findingsCount !== null || banner.teams !== null;
}

export function buildRoleBanner(context: AdminContext, group: RoleGroup, findings: RoleFindings | null): RoleBannerModel {
  const holders = holdersOf(group.rows);
  const shown = findingsShown(findings, group.fold);
  return {
    assigned: headline(holders, group.fold),
    teams: holders.kinds && holders.kinds.teams > 0 ? teamsLine(holders.kinds.teams) : null,
    copies: copiesNote(group.fold),
    findings: shown.line,
    findingsCount: shown.count,
    findingsFloor: shown.floor,
    scan: scanLine(context),
    href: roleHref(context, group.role),
  };
}

/**
 * The headline. With the fold known it is exact. When the scan does not say which rows are copies and other
 * rows share the name, the role may be held mostly through its copies: the counts then cover this row only and
 * read as a minimum ("at least"). With nothing counted there is no minimum worth stating, so the headline is
 * unknown and the copies note says why.
 */
function headline(holders: Holders, fold: Fold): string {
  const kinds = holders.kinds;
  if (!kinds) return ASSIGNMENTS_UNKNOWN;
  if (fold.kind !== "partial") return assignedLine(kinds);
  const heldHere = kinds.humans + kinds.integrations + kinds.platformManaged + kinds.other > 0;
  return heldHere ? assignedLine(kinds, "at least ") : ASSIGNMENTS_UNKNOWN;
}

/**
 * "Assigned to 3 humans and 1 integration". Platform-managed users and holders of a kind the extension does not
 * know are their own parts, named only when there are some. With a floor ("at least ") a zero part is left out
 * rather than printed: "at least 1 human" claims nothing about integrations, where "and 0 integrations" is a bare
 * zero inside a minimum.
 */
export function assignedLine(kinds: Kinds, floor = ""): string {
  const parts = [count(kinds.humans, "human"), count(kinds.integrations, "integration")];
  if (kinds.platformManaged > 0) parts.push(count(kinds.platformManaged, "platform-managed user"));
  if (kinds.other > 0) parts.push(count(kinds.other, "other principal"));
  const shown = floor ? parts.filter((part) => !part.startsWith("0 ")) : parts;
  return `Assigned to ${floor}${joinList(shown)}`;
}

function teamsLine(teams: number): string {
  return `${count(teams, "team")} also ${teams === 1 ? "holds" : "hold"} this role. Their members are not counted.`;
}

/** What the numbers cover, when that is not simply "this role". null for a role with no copies. */
function copiesNote(fold: Fold): string | null {
  switch (fold.kind) {
    case "whole":
      return fold.copies > 0 ? `The numbers include ${count(fold.copies, "business unit copy")} of this role.` : null;
    case "copy":
      return "This is a business unit copy of a role. The numbers are for this copy only.";
    case "partial":
      return `Pathix lists ${count(fold.sameName, "other role")} with this name, such as business unit copies. Their holders and findings are not counted here.`;
  }
}

/** "2 open findings name this role (highest: High)". With a floor the count and the severity are minimums. */
export function findingsLine(findings: RoleFindings | null, floor = false): string {
  if (!findings) return FINDINGS_UNKNOWN;
  if (findings.count === 0) return NO_FINDINGS;
  // A finding left out of the count could be more severe, so with a floor the severity is only the highest seen.
  const highest = findings.highest ? ` (highest${floor ? " seen" : ""}: ${findings.highest})` : "";
  const noun = findings.count === 1 ? "names" : "name";
  return `${floor ? "At least " : ""}${count(findings.count, "open finding")} ${noun} this role${highest}`;
}

interface FindingsShown {
  line: string;
  /** The number beside the findings icon: null when unknown. */
  count: number | null;
  /** The number is a minimum: some of the role's rows are not in it. */
  floor: boolean;
}

/**
 * What the open counts say about one role. A count that leaves rows out (a copy the answer omitted, or copies
 * the scan does not identify) is a minimum when above zero. A zero over this row alone, while same-name rows are
 * not counted, is unknown for the role as the admin center shows it.
 */
function findingsShown(findings: RoleFindings | null, fold: Fold): FindingsShown {
  if (!findings) return { line: FINDINGS_UNKNOWN, count: null, floor: false };
  const floor = findings.partial || fold.kind === "partial";
  if (findings.count === 0 && floor) return { line: FINDINGS_NONE_HERE, count: null, floor: false };
  return { line: findingsLine(findings, floor), count: findings.count, floor };
}

// --- the role-list badge -----------------------------------------------------------

/**
 * One badge from the role list and the open counts alone, with no request per row. With the fold known the
 * numbers are the role's whole. When the scan does not say which rows are copies and other rows share the name,
 * the assignment count and a findings count above zero read "N+", and a count of zero reads unknown, never a bare
 * zero.
 */
export function buildRoleBadge(context: AdminContext, group: RoleGroup, findings: RoleFindings | null): RoleBadgeModel {
  const holders = holdersOf(group.rows);
  const shown = findingsShown(findings, group.fold);
  const note = copiesNote(group.fold);
  const title = `Pathix: ${holdersSentence(holders, group.fold)}${note ? ` ${note}` : ""} ${shown.line}. ${scanLine(context)}.`;
  return {
    assigned: assignedBadge(holders.total, group.fold),
    findingsCount: shown.count,
    findingsFloor: shown.floor,
    title,
    href: roleHref(context, group.role),
  };
}

function assignedBadge(total: number, fold: Fold): string {
  if (fold.kind !== "partial") return `${total} assigned`;
  return total > 0 ? `${total}+ assigned` : "? assigned";
}

/** Zero holders on a row whose copies are not counted is unknown for the role, so the tooltip says so in words. */
function holdersSentence(holders: Holders, fold: Fold): string {
  if (fold.kind === "partial" && holders.total === 0) {
    return "Who holds this role: unknown (no principal holds this row directly; its copies are not counted).";
  }
  const holds = `${count(holders.total, "principal")} ${holders.total === 1 ? "holds" : "hold"} this role directly`;
  if (!holders.kinds) return `${holds} (users, integrations and teams).`;
  if (holders.total === 0) return `${holds}.`;
  return `${holds}: ${kindsList(holders.kinds)}.`;
}

/** "3 humans, 1 integration and 2 teams": the kinds there are, in a fixed order. */
function kindsList(kinds: Kinds): string {
  const parts: Array<[number, string]> = [
    [kinds.humans, "human"],
    [kinds.integrations, "integration"],
    [kinds.platformManaged, "platform-managed user"],
    [kinds.teams, "team"],
    [kinds.other, "other principal"],
  ];
  return joinList(parts.filter(([n]) => n > 0).map(([n, noun]) => count(n, noun)));
}

// --- the application-user chip -------------------------------------------------------

export function appUserHref(context: AdminContext, principal: PrincipalRow): string {
  return `${context.pathixUrl}/principals/${encodeURIComponent(principal.id)}?${new URLSearchParams({ env: context.environmentId }).toString()}`;
}

export function buildAppUserChip(context: AdminContext, principal: PrincipalRow): AppUserChipModel {
  const roles = count(principal.roleCount, "role");
  const disabled = principal.isEnabled ? "" : ", disabled";
  return {
    text: `Pathix: ${roles}${disabled}`,
    title: `Pathix: this application user holds ${roles} directly${principal.isEnabled ? "" : " and is disabled"}. ${scanLine(context)}. Select to open it in Pathix.`,
    href: appUserHref(context, principal),
  };
}

/** Only for an Application ID Pathix looked up in a scan and did not find. */
export function buildNotInPathixChip(context: AdminContext): AppUserChipModel {
  return {
    text: "Not in Pathix's latest scan",
    title: `Pathix has no application user with this Application ID. ${scanLine(context)}.`,
    href: null,
  };
}

/**
 * The chips for the Application IDs one lookup asked about, keyed by the id in lower case. Nothing is drawn for an
 * id the answer cannot speak for: no answer, an answer not in the contract's shape, or no scan behind it (a null
 * scope, where nothing was looked up). Two principals with one Application ID is not an answer the chip can give
 * either. An id is "not in Pathix's latest scan" only when a scan answered and the answer says the id was asked.
 */
export function appUserChips(context: AdminContext, appIds: string[], answer: PrincipalsByAppId | null): Record<string, AppUserChipModel> {
  const chips: Record<string, AppUserChipModel> = {};
  if (!answer || !answer.scope || !Array.isArray(answer.principals)) return chips;
  const asked = new Set(Array.isArray(answer.requestedAppIds) ? answer.requestedAppIds.filter(isId).map((id) => id.toLowerCase()) : []);
  for (const appId of appIds) {
    const key = appId.toLowerCase();
    const matches = answer.principals.filter((principal) => isId(principal.appId) && principal.appId.toLowerCase() === key);
    if (matches.length === 1) chips[key] = buildAppUserChip(context, matches[0]!);
    else if (matches.length === 0 && asked.has(key)) chips[key] = buildNotInPathixChip(context);
  }
  return chips;
}

// --- words ---------------------------------------------------------------------------

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : pluralOf(noun)}`;
}

function pluralOf(noun: string): string {
  if (noun === "other principal") return "other principals";
  if (noun === "other role") return "other roles";
  if (noun === "business unit copy") return "business unit copies";
  return `${noun}s`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
