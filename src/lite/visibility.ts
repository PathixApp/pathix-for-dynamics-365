// Whether the signed-in user can see every row of the tables Lite lists that
// are owned by users or business units (DESIGN.md, "Absence is not evidence").
//
// Classic workflows and business rules (workflow) are owned by users; teams
// and roles by business units. Dataverse answers a read of them with HTTP 200
// and only the rows the user's Read privilege reaches. Below Organization
// (Global) depth, that is part of the list, and a list read in part must never
// read as the whole: "no business rule is active" or "no team grants Write"
// would be claims about rows Lite was not shown. Plugin step registrations,
// forms, solutions, publishers and column security profiles are owned by the
// organization, so they are not affected.
//
// The depth comes from RetrieveUserSetOfPrivilegesByNames, the same function
// Why locked? already calls for the table's Write privilege.

import type { Answer, Hidden } from "../card/registered";
import type { Single } from "../card/locked";
import type { DataverseGet } from "../dataverse/client";
import { recordFilterOf, retrieveMyReadPrivileges, retrieveWhoAmI, type MyTeam, type UserPrivileges, type WhoAmI } from "../dataverse/queries";
import { single } from "./read";

/**
 * Whether RetrieveUserSetOfPrivilegesByNames counts the privileges a user holds
 * through their teams' roles. Nobody has verified it, so it is "unknown".
 *
 * The live check that settles it: in a test environment, a user whose own roles have no
 * prvWriteAccount, in an owner team whose role grants it at Organization
 * level. Call the function for prvWriteAccount as that user. A row back means
 * true; no row means false. Then set this once:
 * - true: the user's own answer already holds what their teams' roles give,
 *   so a team or team role Lite cannot see cannot hide a grant from it.
 *   loadTeamPrivileges then drops the team hedge on Why locked?'s Write line.
 * - false: a Read depth the function returns comes from the user's own roles,
 *   which are the copies in the user's own business unit, so Local and Deep
 *   reach every role of a team in that unit (teamRolesHidden).
 * - "unknown": a Local or Deep row may come from a team role in another
 *   business unit, so it says nothing about which units Lite can read: every
 *   team's roles are unknown below Global.
 * The comment on team-held access in src/lite/locked.ts relies on this too.
 */
export const PRIVILEGE_SET_INCLUDES_TEAM_ROLES: boolean | "unknown" = "unknown";

/** "all": the user reads every row. Otherwise why some may be hidden. */
export type Visibility = "all" | Hidden;

/** A depth RetrieveUserSetOfPrivilegesByNames names, as its Depth string. */
export type Depth = "Basic" | "Local" | "Deep" | "Global";

export interface ReadVisibility {
  /** prvReadWorkflow: classic workflows and business rules. */
  workflows: Visibility;
  /** prvReadTeam: the teams the user is a member of. */
  teams: Visibility;
  /** prvReadRole: the roles those teams hold, and their privileges. */
  roles: Visibility;
  /** The widest depth at which the user reads roles with no record filter; null when none is known. */
  roleDepth: Depth | null;
  /** The user's own business unit, from WhoAmI; null when it was not given. */
  businessUnitId: string | null;
}

export const READ_PRIVILEGES = {
  workflows: "prvReadWorkflow",
  teams: "prvReadTeam",
  roles: "prvReadRole",
} as const;

const UNKNOWN: ReadVisibility = { workflows: "unknown", teams: "unknown", roles: "unknown", roleDepth: null, businessUnitId: null };

const DEPTHS: readonly Depth[] = ["Basic", "Local", "Deep", "Global"];

/**
 * The user's read reach on the three tables. A failed read of the user or of
 * the privileges is unknown for all three, never "all".
 */
export async function loadReadVisibility(get: DataverseGet, whoAmI?: Single<WhoAmI>): Promise<ReadVisibility> {
  const me = whoAmI ?? (await single(() => retrieveWhoAmI(get)));
  if (me.kind !== "ok" || typeof me.value?.UserId !== "string") return UNKNOWN;
  const privileges = await single(() => retrieveMyReadPrivileges(get, me.value.UserId.toLowerCase()));
  const businessUnit = me.value.BusinessUnitId;
  return {
    workflows: visibilityOf(privileges, READ_PRIVILEGES.workflows),
    teams: visibilityOf(privileges, READ_PRIVILEGES.teams),
    roles: visibilityOf(privileges, READ_PRIVILEGES.roles),
    roleDepth: widestUnfilteredDepth(privileges, READ_PRIVILEGES.roles),
    businessUnitId: typeof businessUnit === "string" && businessUnit !== "" ? businessUnit.toLowerCase() : null,
  };
}

/**
 * "all" only when one of the user's roles holds the privilege at Global depth
 * with no record filter. An answer that does not name the privilege (it may
 * come through a team's role, which nobody has verified the function counts),
 * names a depth Lite does not know, or holds Global with a record filter field
 * it cannot read, is "unknown". Anything else (a lower depth, or Global
 * narrowed by a record filter) is "some".
 */
export function visibilityOf(answer: Single<UserPrivileges>, privilege: string): Visibility {
  const rows = rowsOf(answer, privilege);
  if (rows === null || rows.length === 0) return "unknown";
  if (rows.some((row) => row.Depth === "Global" && recordFilterOf(row) === "none")) return "all";
  if (rows.some((row) => !DEPTHS.includes(row.Depth as Depth))) return "unknown";
  if (rows.some((row) => row.Depth === "Global" && recordFilterOf(row) === "unknown")) return "unknown";
  return "some";
}

/** The widest depth the privilege is held at with no record filter, or null. */
export function widestUnfilteredDepth(answer: Single<UserPrivileges>, privilege: string): Depth | null {
  const held = new Set((rowsOf(answer, privilege) ?? []).filter((row) => recordFilterOf(row) === "none").map((row) => row.Depth));
  return [...DEPTHS].reverse().find((depth) => held.has(depth)) ?? null;
}

function rowsOf(answer: Single<UserPrivileges>, privilege: string): UserPrivileges["RolePrivileges"] | null {
  if (answer.kind !== "ok" || !Array.isArray(answer.value?.RolePrivileges)) return null;
  const name = privilege.toLowerCase();
  return answer.value.RolePrivileges.filter((row) => typeof row?.PrivilegeName === "string" && row.PrivilegeName.toLowerCase() === name);
}

/** A list the user may see only in part is marked so: never complete, and says why. */
export function limitTo<T>(answer: Answer<T[]>, visibility: Visibility): Answer<T[]> {
  if (answer.kind !== "ok" || visibility === "all") return answer;
  return { ...answer, complete: false, hidden: visibility };
}

/** Several reasons together: "some" wins over "unknown", and all reached is nothing hidden. */
export function hiddenOf(...parts: Visibility[]): Hidden | undefined {
  if (parts.includes("some")) return "some";
  return parts.includes("unknown") ? "unknown" : undefined;
}

/**
 * Whether the roles of the teams the user can see may be listed only in part.
 *
 * A role is owned by a business unit, and a team holds the copies of its roles
 * in the team's own business unit. So a team's roles are all visible when the
 * user reads roles at Global, or at Local or Deep and the team is in the
 * user's own business unit. Otherwise:
 * - Local, team in another business unit: its roles are hidden ("some").
 * - Deep, team in another business unit: it may sit under the user's, which
 *   Lite does not read ("unknown").
 * - Basic: what Basic reaches on a table owned by business units is not
 *   verified, so Lite does not rely on it ("unknown").
 * - The team's or the user's business unit not given, or roles read only
 *   through a record filter: Lite cannot tell ("some").
 * The user's own roles are not read this way at all: their Write depth comes
 * from RetrieveUserSetOfPrivilegesByNames, which no Read depth filters. With
 * no team, nothing is hidden here.
 */
export function teamRolesHidden(
  visibility: ReadVisibility,
  teams: readonly MyTeam[],
  includesTeamRoles: boolean | "unknown" = PRIVILEGE_SET_INCLUDES_TEAM_ROLES,
): Hidden | undefined {
  if (teams.length === 0 || visibility.roles === "all") return undefined;
  if (visibility.roles === "unknown") return "unknown";
  return hiddenOf(...teams.map((team) => teamRoleReach(visibility, team, includesTeamRoles)));
}

function teamRoleReach(visibility: ReadVisibility, team: MyTeam, includesTeamRoles: boolean | "unknown"): Visibility {
  const { roleDepth, businessUnitId } = visibility;
  if (roleDepth === null) return "some";
  if (roleDepth === "Global") return "all";
  if (roleDepth === "Basic") return "unknown";
  // Comparing business units holds only when the depth is anchored at the
  // user's own unit (PRIVILEGE_SET_INCLUDES_TEAM_ROLES false).
  if (includesTeamRoles !== false) return "unknown";
  const teamUnit = typeof team._businessunitid_value === "string" ? team._businessunitid_value.toLowerCase() : null;
  if (teamUnit === null || businessUnitId === null) return "some";
  if (teamUnit === businessUnitId) return "all";
  // Deep from the root business unit reaches every unit, but Lite does not
  // read which unit is the root, so a team elsewhere stays unknown. That
  // over-hedges, which is the safe side.
  return roleDepth === "Deep" ? "unknown" : "some";
}
