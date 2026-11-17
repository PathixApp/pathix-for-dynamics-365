// Lite's "Why can't I edit this field?" checklist: reads the column's
// definition, its column security and the user's own profiles, the open
// form's definition, the table's business rules, and the user's own privileges
// on the table. Runs in the content script; every read goes through the
// Dataverse client and its allowlist.

import {
  buildLockedCard,
  type LockedCardModel,
  type LockedContext,
  type LockedFacts,
  type Single,
  type TeamPrivileges,
  type TeamProfiles,
} from "../card/locked";
import { isGuid } from "../bridge/messages";
import type { Answer } from "../card/registered";
import type { DataverseGet } from "../dataverse/client";
import {
  type EntityPrivileges,
  isPrivilegeName,
  type MyTeam,
  retrieveAttributeEditability,
  retrieveEntityPrivileges,
  retrieveFieldPermissions,
  retrieveFieldSecurityProfiles,
  retrieveFormDefinition,
  retrieveMyFieldSecurityProfiles,
  retrieveMyPrivileges,
  retrieveMyTeams,
  retrieveProcessesForTable,
  retrieveRolesHoldingPrivilege,
  retrieveTeamProfiles,
  retrieveTeamRoles,
  retrieveWhoAmI,
} from "../dataverse/queries";
import { collection, single } from "./read";
import { loadProcessDependents } from "./registered";
import { hiddenOf, limitTo, loadReadVisibility, PRIVILEGE_SET_INCLUDES_TEAM_ROLES, teamRolesHidden, type ReadVisibility } from "./visibility";
import { TEAM_GLOBAL_UNCHECKED, type HiddenPart } from "../card/locked";

export async function loadLockedCard(get: DataverseGet, context: LockedContext): Promise<LockedCardModel> {
  const [attribute, whoAmI, tablePrivileges, form, readProcesses] = await Promise.all([
    single(() => retrieveAttributeEditability(get, context.table, context.column)),
    single(() => retrieveWhoAmI(get)),
    single(() => retrieveEntityPrivileges(get, context.table)),
    context.formId ? single(() => retrieveFormDefinition(get, context.formId!)) : Promise.resolve(null),
    collection(() => retrieveProcessesForTable(get, context.table)),
  ]);
  // Processes are owned by users, teams and roles by business units: below
  // Organization depth each list holds only what the user can see. The depth
  // is read alongside the reads below and awaited only where it is used.
  const visibility = loadReadVisibility(get, whoAmI);
  const userId = whoAmI.kind === "ok" ? whoAmI.value.UserId.toLowerCase() : null;
  const secured = attribute.kind === "ok" && attribute.value.IsSecured === true;
  const activeRules = readProcesses.kind === "ok" && readProcesses.value.some((row) => row.category === 2 && row.statecode === 1);
  const writePrivilege = writePrivilegeOf(tablePrivileges);
  const writePrivilegeId = writePrivilegeIdOf(tablePrivileges);
  const asksAboutWrite = writePrivilege.kind === "ok" && writePrivilege.value !== null;

  // The user's teams are read once, and start now so the reads below that
  // need them do not wait for the others.
  const teams = asksAboutWrite || secured ? loadMyTeams(get, whoAmI, userId) : null;

  const [privileges, teamPrivileges, columnSecurity, dependents] = await Promise.all([
    writePrivilege.kind !== "ok" || writePrivilege.value === null
      ? Promise.resolve(null)
      : whoAmI.kind !== "ok"
        ? Promise.resolve(whoAmI)
        : single(() => retrieveMyPrivileges(get, userId!, [writePrivilege.value!])),
    asksAboutWrite && teams
      ? loadTeamPrivileges(get, teams, writePrivilegeId, visibility, { recordFilterable: writeRecordFilterableOf(tablePrivileges) })
      : Promise.resolve(null),
    secured && teams ? loadColumnSecurity(get, context.table, userId, teams, visibility) : Promise.resolve(null),
    activeRules ? loadProcessDependents(get, context.table, [context.column]) : Promise.resolve(null),
  ]);
  const processes = limitTo(readProcesses, (await visibility).workflows);

  const facts: LockedFacts = {
    attribute,
    columnSecurity,
    form: form === null ? null : form.kind === "ok" ? { kind: "ok", value: form.value[0] ?? null } : form,
    processes,
    ruleDependents: dependents?.get(context.column) ?? null,
    writePrivilege,
    privileges,
    teamPrivileges,
  };
  return buildLockedCard(context, facts);
}

// The Write privilege as the table's definition names it: prvWriteAccount for
// account, but prvWriteActivity for email and the other activity tables.
export function writePrivilegeOf(answer: Single<EntityPrivileges>): Single<string | null> {
  if (answer.kind !== "ok") return answer;
  const write = (answer.value.Privileges ?? []).find((privilege) => privilege.PrivilegeType === "Write");
  return { kind: "ok", value: write && isPrivilegeName(write.Name) ? write.Name : null };
}

// Whether a role may narrow that Write privilege with a record filter: true,
// false, or null when the definition does not say. A team role's depth mask
// carries no filter, so only false lets a team's Organization depth mean every
// record.
export function writeRecordFilterableOf(answer: Single<EntityPrivileges>): boolean | null {
  if (answer.kind !== "ok") return null;
  const write = (answer.value.Privileges ?? []).find((privilege) => privilege.PrivilegeType === "Write");
  return typeof write?.CanBeRecordFilter === "boolean" ? write.CanBeRecordFilter : null;
}

// The id of that Write privilege, which the roles' side of Dataverse is asked
// by. Null when the definition does not carry one.
export function writePrivilegeIdOf(answer: Single<EntityPrivileges>): string | null {
  if (answer.kind !== "ok") return null;
  const write = (answer.value.Privileges ?? []).find((privilege) => privilege.PrivilegeType === "Write");
  return write?.PrivilegeId && isGuid(write.PrivilegeId) ? write.PrivilegeId : null;
}

// --- team-held access (M6) -----------------------------------------------------------
//
// Nobody has verified whether RetrieveUserSetOfPrivilegesByNames counts the
// privileges that come through a team's roles (PRIVILEGE_SET_INCLUDES_TEAM_ROLES
// in ./visibility.ts names the question and the live check that settles it).
// So the card does not rely on it either way: it reads the user's teams, their roles and the roles'
// depths on the one privilege, and unions the result with the user's own
// answer. If the function already counts team roles, the union changes
// nothing. If it does not, the team's grant shows up here.
//
// Every step is checked for the shape it expects, and a row that is not that
// shape fails the whole read. A team path that cannot be read renders as
// unknown on the card, never as "no grant".

export async function loadMyTeams(get: DataverseGet, whoAmI: Single<unknown>, userId: string | null): Promise<Single<MyTeam[]>> {
  if (whoAmI.kind !== "ok" || userId === null) return whoAmI.kind === "ok" ? { kind: "failed" } : whoAmI;
  const answer = asSingle(await collection(() => retrieveMyTeams(get, userId)));
  if (answer.kind !== "ok") return answer;
  return answer.value.every((team) => typeof team?.teamid === "string" && isGuid(team.teamid)) ? answer : { kind: "failed" };
}

/**
 * The depths the user's teams' roles hold one privilege at. When the user may
 * not see every team they are in, or every role those teams hold
 * (`visibility`, teamRolesHidden), the answer says so in `hidden`: a grant
 * found stands, but "no grant" is not a verdict.
 */
export async function loadTeamPrivileges(
  get: DataverseGet,
  teams: Promise<Single<MyTeam[]>>,
  privilegeId: string | null,
  visibility: Promise<ReadVisibility>,
  options: {
    /** writeRecordFilterableOf: null (not said) is treated as true. */
    recordFilterable?: boolean | null;
    includesTeamRoles?: boolean | "unknown";
  } = {},
): Promise<Single<TeamPrivileges>> {
  const includesTeamRoles = options.includesTeamRoles ?? PRIVILEGE_SET_INCLUDES_TEAM_ROLES;
  const [answer, reach, mine] = await Promise.all([readTeamPrivileges(get, teams, privilegeId, options.recordFilterable ?? null), visibility, teams]);
  if (answer.kind !== "ok" || mine.kind !== "ok") return answer;
  // When the user's own answer already counts their teams' roles, a team or
  // role Lite cannot see cannot hide a grant from it.
  if (includesTeamRoles === true) return answer;
  const teamsHidden = hiddenOf(reach.teams);
  const rolesHidden = teamRolesHidden(reach, mine.value, includesTeamRoles);
  const hidden = hiddenOf(teamsHidden ?? "all", rolesHidden ?? "all");
  if (!hidden) return answer;
  const hiddenPart: HiddenPart = teamsHidden && rolesHidden ? "teamsAndRoles" : teamsHidden ? "teams" : "roles";
  return { kind: "ok", value: { ...answer.value, hidden, hiddenPart } };
}

async function readTeamPrivileges(
  get: DataverseGet,
  teams: Promise<Single<MyTeam[]>>,
  privilegeId: string | null,
  recordFilterable: boolean | null,
): Promise<Single<TeamPrivileges>> {
  const mine = await teams;
  if (mine.kind !== "ok") return mine;
  const teamIds = mine.value.map((team) => team.teamid);
  if (teamIds.length === 0) return { kind: "ok", value: { teamCount: 0, depths: [] } };
  if (privilegeId === null) return { kind: "failed" };

  const roles = await single(() => retrieveTeamRoles(get, teamIds));
  if (roles.kind !== "ok") return roles;
  if (!roles.value.every((row) => typeof row?.roleid === "string" && isGuid(row.roleid))) return { kind: "failed" };
  const roleIds = new Set(roles.value.map((row) => row.roleid.toLowerCase()));
  if (roleIds.size === 0) return { kind: "ok", value: { teamCount: teamIds.length, depths: [] } };

  const holders = await single(() => retrieveRolesHoldingPrivilege(get, privilegeId, [...roleIds]));
  if (holders.kind !== "ok") return holders;
  if (!holders.value.every((row) => typeof row?.roleid === "string" && typeof row.privilegedepthmask === "number")) return { kind: "failed" };
  const depths = holders.value
    .filter((row) => roleIds.has(row.roleid.toLowerCase()))
    .map((row) => depthOfMask(row.privilegedepthmask))
    .map((depth) => (depth === "Global" && recordFilterable !== false ? TEAM_GLOBAL_UNCHECKED : depth));
  return { kind: "ok", value: { teamCount: teamIds.length, depths: [...new Set(depths)] } };
}

// privilegedepthmask is a bit mask: 1 Basic, 2 Local, 4 Deep, 8 Global. The
// widest bit wins; a mask with none of them is a depth Lite has no name for.
function depthOfMask(mask: number): string {
  if (mask & 8) return "Global";
  if (mask & 4) return "Deep";
  if (mask & 2) return "Local";
  if (mask & 1) return "Basic";
  return "Unknown";
}

/**
 * The column security profiles the user's teams hold; `hidden` when the user
 * may not see every team they are in. A team is owned by a business unit, and
 * the user can be in a team of any business unit, so below Global a team the
 * user is in may not be listed. Lite cannot tell whether one is missing.
 */
export async function loadTeamProfiles(get: DataverseGet, teams: Promise<Single<MyTeam[]>>, visibility: Promise<ReadVisibility>): Promise<Single<TeamProfiles>> {
  const [answer, reach] = await Promise.all([readTeamProfiles(get, teams), visibility]);
  const hidden = hiddenOf(reach.teams);
  return answer.kind === "ok" && hidden ? { kind: "ok", value: { ...answer.value, hidden } } : answer;
}

async function readTeamProfiles(get: DataverseGet, teams: Promise<Single<MyTeam[]>>): Promise<Single<TeamProfiles>> {
  const mine = await teams;
  if (mine.kind !== "ok") return mine;
  const teamIds = mine.value.map((team) => team.teamid);
  if (teamIds.length === 0) return { kind: "ok", value: { teamCount: 0, profileIds: [] } };
  const rows = await single(() => retrieveTeamProfiles(get, teamIds));
  if (rows.kind !== "ok") return rows;
  if (!rows.value.every((row) => typeof row?.fieldsecurityprofileid === "string" && isGuid(row.fieldsecurityprofileid))) return { kind: "failed" };
  return { kind: "ok", value: { teamCount: teamIds.length, profileIds: [...new Set(rows.value.map((row) => row.fieldsecurityprofileid.toLowerCase()))] } };
}

async function loadColumnSecurity(
  get: DataverseGet,
  table: string,
  userId: string | null,
  teams: Promise<Single<MyTeam[]>>,
  visibility: Promise<ReadVisibility>,
): Promise<NonNullable<LockedFacts["columnSecurity"]>> {
  const [permissions, profiles, mine, team] = await Promise.all([
    collection(() => retrieveFieldPermissions(get, table)),
    collection(() => retrieveFieldSecurityProfiles(get)),
    userId ? collection(() => retrieveMyFieldSecurityProfiles(get, userId)) : Promise.resolve({ kind: "failed" as const }),
    loadTeamProfiles(get, teams, visibility),
  ]);
  return { permissions: asSingle(permissions), profiles: asSingle(profiles), mine: asSingle(mine), team };
}

// The client follows a list's pages. A list that still has more could not be
// read in full and could hide the profile that grants update, so the
// checklist treats it as unread rather than say "no profile grants it".
export function asSingle<T>(answer: Answer<T[]>): Single<T[]> {
  if (answer.kind !== "ok") return answer;
  return answer.complete ? { kind: "ok", value: answer.value } : { kind: "failed" };
}
