// Hand-written stand-ins for the Pathix answers the admin center overlay reads
// (M14), in the shape of the contract slice (contract/pathix-api.slice.json).
// No real Pathix answer for these routes is captured yet: the live check
// compares the overlay with the real role pages. The ids are made up.

import type { AdminContext } from "../src/card/admin";
import type { ApiResult, OpenFindingCounts, PrincipalRow, PrincipalsByAppId, RoleSummary } from "../src/pathix/api";
import type { Get } from "../src/background/connection";

export const ORG = "5c4a0000-0000-4000-8000-000000000003";
export const ENV = "e1000000-0000-4000-8000-000000000001";
export const PATHIX = "https://pathix.contoso.test";
export const SCAN_AT = "2026-10-06T16:12:00Z";

export const context: AdminContext = {
  pathixUrl: PATHIX,
  environmentId: ENV,
  scanCompletedAt: SCAN_AT,
  formatDate: (iso) => `on ${iso.slice(0, 10)}`,
};

/** Dataverse role ids (what the admin center's address carries) and Pathix's own ids for the same roles. */
export const SALES = { id: "a1000000-0000-4000-8000-000000000001", sourceId: "d1000000-0000-4000-8000-000000000001" };
export const SALES_EAST_COPY = { id: "a1000000-0000-4000-8000-000000000002", sourceId: "d1000000-0000-4000-8000-000000000002" };
export const SALES_WEST_COPY = { id: "a1000000-0000-4000-8000-000000000005", sourceId: "d1000000-0000-4000-8000-000000000005" };
export const INTEGRATION = { id: "a1000000-0000-4000-8000-000000000003", sourceId: "d1000000-0000-4000-8000-000000000003" };
export const EMPTY = { id: "a1000000-0000-4000-8000-000000000004", sourceId: "d1000000-0000-4000-8000-000000000004" };
/** A role in the role list that the open counts leave out, as Pathix leaves out a role not in its latest scan. */
export const OMITTED = { id: "a1000000-0000-4000-8000-000000000006", sourceId: "d1000000-0000-4000-8000-000000000006" };

interface Holders {
  humans?: number;
  integrations?: number;
  teams?: number;
  platformManaged?: number;
}

/** A /roles row: the four counts by kind, and assignmentCount as their sum, as Pathix serves it. */
export function roleRow(ids: { id: string; sourceId: string }, name: string, holders: Holders = {}, parentRootRoleId: string | null = null): RoleSummary {
  const { humans = 0, integrations = 0, teams = 0, platformManaged = 0 } = holders;
  return {
    ...ids,
    name,
    parentRootRoleId,
    assignmentCount: humans + integrations + teams + platformManaged,
    humanAssignmentCount: humans,
    integrationAssignmentCount: integrations,
    teamAssignmentCount: teams,
    platformManagedAssignmentCount: platformManaged,
  };
}

/**
 * The role list of an environment with three business units. Sales Manager is a root role with two copies, each
 * naming the root's Dataverse id. The West copy is held by a platform-managed user (a Power Pages site user or an
 * agent), who is neither a human nor an integration.
 */
export const ROLES: RoleSummary[] = [
  roleRow(SALES, "Sales Manager", { humans: 3, integrations: 1, teams: 2 }),
  roleRow(SALES_EAST_COPY, "Sales Manager", { humans: 2 }, SALES.sourceId),
  roleRow(SALES_WEST_COPY, "Sales Manager", { humans: 1, platformManaged: 1 }, SALES.sourceId),
  roleRow(INTEGRATION, "Integration Writer", { integrations: 1 }),
  roleRow(EMPTY, "Unused Role"),
  roleRow(OMITTED, "Report Viewer", { humans: 4 }),
];

/** The same roles from a scan taken before Pathix read the parent root role: no row names one. */
export const LEGACY_ROLES: RoleSummary[] = ROLES.map((role) => ({ ...role, parentRootRoleId: null }));

/** A row as a Pathix older than the split by kind serves it: no parent, no counts by kind. */
export function olderRow(role: RoleSummary): RoleSummary {
  return { id: role.id, sourceId: role.sourceId, name: role.name, assignmentCount: role.assignmentCount };
}

export const roleOf = (ids: { id: string }): RoleSummary => ROLES.find((role) => role.id === ids.id)!;

export const COMPLETED: OpenFindingCounts["readiness"] = { findings: { status: "Completed", failedDetectorFindingTypes: [] } };

/** Open findings per role, by Pathix id. OMITTED is not here: Pathix leaves it out of the answer. */
export const OPEN_COUNTS: Record<string, { openCount: number; maxOpenSeverity: string | null }> = {
  [SALES.id]: { openCount: 2, maxOpenSeverity: "High" },
  [SALES_EAST_COPY.id]: { openCount: 1, maxOpenSeverity: "Critical" },
  [SALES_WEST_COPY.id]: { openCount: 0, maxOpenSeverity: null },
  [INTEGRATION.id]: { openCount: 1, maxOpenSeverity: "Low" },
  [EMPTY.id]: { openCount: 0, maxOpenSeverity: null },
};

/** A fake /findings/open-counts: answers for the roleIds asked that `counts` holds, in any case, and leaves out the rest. */
export function openCounts(
  counts: Record<string, { openCount: number | string; maxOpenSeverity: string | null }> = OPEN_COUNTS,
  readiness: OpenFindingCounts["readiness"] = COMPLETED,
): (path: string) => ApiResult<OpenFindingCounts> {
  return (path) => {
    const asked = new URL(path, "https://x").searchParams.getAll("roleId").map((id) => id.toLowerCase());
    const known = Object.entries(counts).filter(([roleId]) => asked.includes(roleId.toLowerCase()));
    return {
      ok: true,
      data: { fields: [], roles: known.map(([roleId, row]) => ({ roleId, ...row })), readiness },
    };
  };
}

export function appUser(n: number, over: Partial<PrincipalRow> = {}): PrincipalRow {
  const hex = n.toString(16).padStart(12, "0");
  return {
    id: `b2000000-0000-4000-8000-${hex}`,
    principalType: "ApplicationUser",
    appId: `c3000000-0000-4000-8000-${hex}`,
    isEnabled: true,
    roleCount: n % 4,
    ...over,
  };
}

export const appIdOf = (n: number) => appUser(n).appId!;

export const SCOPE: NonNullable<PrincipalsByAppId["scope"]> = { environmentId: ENV, scanId: "5ca00000-0000-4000-8000-000000000001", scannedAt: SCAN_AT };

/**
 * A fake /principals/by-app-id over these principals. It matches the asked ids in any case, as Pathix does, and
 * echoes them in `requestedAppIds`. A null scope is an environment with no Completed scan: nothing is looked up.
 */
export function byAppId(users: PrincipalRow[], scope: PrincipalsByAppId["scope"] = SCOPE): (path: string) => ApiResult<PrincipalsByAppId> {
  return (path) => {
    const asked = [...new Set(new URL(path, "https://x").searchParams.getAll("appId").map((id) => id.toLowerCase()))];
    const principals = scope ? users.filter((user) => user.appId !== null && asked.includes(user.appId.toLowerCase())) : [];
    return { ok: true, data: { requestedAppIds: asked, scope, principals } };
  };
}

/** A fake Pathix: answers by path, and logs every path asked for. */
export function fakePathix(answers: Record<string, unknown | ((path: string) => ApiResult<unknown>)>): {
  get: Get;
  paths: string[];
} {
  const paths: string[] = [];
  const get: Get = async <T>(path: string) => {
    paths.push(path);
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    if (key === undefined) return { ok: false, kind: "failed", message: `no answer for ${path}` };
    const answer = answers[key];
    if (typeof answer === "function") return (answer as (path: string) => ApiResult<T>)(path);
    return { ok: true, data: answer as T };
  };
  return { get, paths };
}
