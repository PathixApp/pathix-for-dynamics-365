// The signed-in user's own security state, read live for the connected card's
// "Why can't I edit this field?". Their column
// security profiles, their teams' profiles, and their own Write access to the
// table, as the Lite checklist reads them. Nothing about the column, the form
// or anyone else: Pathix answers those. Runs in the content script; every read
// goes through the Dataverse client and its allowlist.

import type { LiveUserFacts } from "../card/locked-connected";
import type { Single } from "../card/locked";
import type { DataverseGet } from "../dataverse/client";
import {
  retrieveEntityPrivileges,
  retrieveMyFieldSecurityProfiles,
  retrieveMyPrivileges,
  retrieveWhoAmI,
} from "../dataverse/queries";
import { asSingle, loadMyTeams, loadTeamPrivileges, loadTeamProfiles, writePrivilegeIdOf, writePrivilegeOf, writeRecordFilterableOf } from "./locked";
import { collection, single } from "./read";
import { loadReadVisibility } from "./visibility";

export async function loadUserSecurity(get: DataverseGet, table: string): Promise<LiveUserFacts> {
  const [whoAmI, tablePrivileges] = await Promise.all([
    single(() => retrieveWhoAmI(get)),
    single(() => retrieveEntityPrivileges(get, table)),
  ]);
  const userId = whoAmI.kind === "ok" ? whoAmI.value.UserId.toLowerCase() : null;
  // Teams and roles are owned by business units: below Organization depth the
  // user may see only some, so "no team grants it" is not a verdict. Read
  // alongside the teams, and awaited only by the reads that use it.
  const visibility = loadReadVisibility(get, whoAmI);
  const writePrivilege = writePrivilegeOf(tablePrivileges);
  const writePrivilegeId = writePrivilegeIdOf(tablePrivileges);
  const asksAboutWrite = writePrivilege.kind === "ok" && writePrivilege.value !== null;

  // The teams are read once, and start now so the reads below that need them do not wait.
  const teams = loadMyTeams(get, whoAmI, userId);

  const [privileges, teamPrivileges, mine, team] = await Promise.all([
    writePrivilege.kind !== "ok" || writePrivilege.value === null
      ? Promise.resolve(null)
      : whoAmI.kind !== "ok"
        ? Promise.resolve(whoAmI)
        : single(() => retrieveMyPrivileges(get, userId!, [writePrivilege.value!])),
    asksAboutWrite
      ? loadTeamPrivileges(get, teams, writePrivilegeId, visibility, { recordFilterable: writeRecordFilterableOf(tablePrivileges) })
      : Promise.resolve(null),
    userId ? collection(() => retrieveMyFieldSecurityProfiles(get, userId)).then(asSingle) : Promise.resolve<Single<never>>(whoAmI.kind === "ok" ? { kind: "failed" } : whoAmI),
    loadTeamProfiles(get, teams, visibility),
  ]);

  // Matching is by profile id against what Pathix says grants update, so no profile names are read.
  return { writePrivilege, privileges, teamPrivileges, mine, team };
}
