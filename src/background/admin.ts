// Loads what the admin center overlay shows (M14), for the service worker. The
// page script never calls Pathix: it sends ids, and these functions answer
// with models. All of them go through the shared response cache, scoped to the
// environment's latest Completed scan, so one environment costs:
//
//   - the role editor banner: GET /roles, then GET /findings/open-counts for the
//     role and its business unit copies (2 reads; one more per 100 copies);
//   - a role list of any length: GET /roles (shared with the banner), then
//     GET /findings/open-counts for the listed roles and their copies, 100 role
//     ids a read (1 + ceil(ids / 100) reads), and none per row;
//   - application users: GET /principals/by-app-id, one read per 100
//     Application IDs the page shows, so one per visible page of the grid.
//
// Any failure or missing answer degrades to "none": the overlay stays silent
// on the admin page (DESIGN.md, "Absence is not evidence"). Inside a banner,
// a part that failed says "unknown" rather than a number.

import {
  appUserChips,
  bannerKnowsAnything,
  buildRoleBadge,
  buildRoleBanner,
  findingsFor,
  foldIsExact,
  isRoleList,
  roleGroup,
  roleOpenCounts,
  type AdminContext,
  type RoleGroup,
  type RoleOpenCounts,
} from "../card/admin";
import type { OpenFindingCounts, PrincipalsByAppId, RoleSummary } from "../pathix/api";
import type {
  AdminAppUsersResponse,
  AdminRoleListResponse,
  AdminRoleResponse,
  AppUserChipModel,
  RoleBadgeModel,
} from "../runtime/admin-overlay";
import { mapWithLimit } from "./cache";
import type { Get } from "./connection";

const NONE = { kind: "none" } as const;

/**
 * Role ids per open-counts read. Pathix takes 500 subjects a request, but the ids ride in the query string and
 * its server's default 8 KB request line holds fewer than 190 of them, so a read asks for 100, as the lookup by
 * Application ID does.
 */
export const ROLE_COUNTS_BATCH = 100;
/** Application IDs per lookup: Pathix answers 400 above 100. */
export const APP_IDS_BATCH = 100;
/** Reads in flight at once, as X-ray does. */
const CONCURRENCY = 4;

export async function loadRoleBanner(context: AdminContext, roleSourceId: string, get: Get): Promise<AdminRoleResponse> {
  const roles = await rolesOf(context, get);
  if (!roles) return NONE;
  const group = roleGroup(roles, roleSourceId);
  if (!group) return NONE;

  const counts = await openCountsOf(context, idsOf([group]), get);
  // Nothing known about the role beyond its name: say nothing rather than two "unknown" lines.
  // A copies note alone is not knowledge of this role, so it does not earn a banner either.
  const banner = buildRoleBanner(context, group, findingsFor(counts, group.rows));
  return bannerKnowsAnything(banner) ? { kind: "role", banner } : NONE;
}

export async function loadRoleBadges(context: AdminContext, roleSourceIds: string[], get: Get): Promise<AdminRoleListResponse> {
  const roles = await rolesOf(context, get);
  if (!roles) return NONE;
  const exact = foldIsExact(roles);
  const groups = new Map<string, RoleGroup>();
  for (const sourceId of roleSourceIds) {
    const group = roleGroup(roles, sourceId, exact);
    if (group) groups.set(sourceId.toLowerCase(), group);
  }
  if (groups.size === 0) return NONE;

  const counts = await openCountsOf(context, idsOf([...groups.values()]), get);
  const badges: Record<string, RoleBadgeModel> = {};
  for (const [sourceId, group] of groups) badges[sourceId] = buildRoleBadge(context, group, findingsFor(counts, group.rows));
  return { kind: "roles", badges };
}

export async function loadAppUserChips(context: AdminContext, appIds: string[], get: Get): Promise<AdminAppUsersResponse> {
  const batches = chunk(uniqueSorted(appIds), APP_IDS_BATCH);
  const answers = await mapWithLimit(batches, CONCURRENCY, async (batch) => {
    const result = await get<PrincipalsByAppId>(byAppIdPath(context, batch));
    return appUserChips(context, batch, result.ok ? result.data : null);
  });
  const chips: Record<string, AppUserChipModel> = Object.assign({}, ...answers);
  return Object.keys(chips).length > 0 ? { kind: "appUsers", chips } : NONE;
}

// --- reads ---------------------------------------------------------------------------

async function rolesOf(context: AdminContext, get: Get): Promise<RoleSummary[] | null> {
  const result = await get<RoleSummary[]>(`/roles?environmentId=${encodeURIComponent(context.environmentId)}`);
  return result.ok && isRoleList(result.data) ? result.data : null;
}

/**
 * The open findings of the given roles, in batches. A batch that fails leaves its roles out of the answer, so
 * they read unknown (or make a sum a minimum), never zero. null when no batch answered.
 */
async function openCountsOf(context: AdminContext, roleIds: string[], get: Get): Promise<RoleOpenCounts | null> {
  const batches = chunk(uniqueSorted(roleIds), ROLE_COUNTS_BATCH);
  const results = await mapWithLimit(batches, CONCURRENCY, (batch) => get<OpenFindingCounts>(openCountsPath(context, batch)));
  return roleOpenCounts(results.map((result) => (result.ok ? result.data : null)));
}

/** Only roleId is sent, the way the cards send only fieldKey: Pathix reads a missing list as empty. */
function openCountsPath(context: AdminContext, roleIds: string[]): string {
  const ids = roleIds.map((id) => `roleId=${encodeURIComponent(id)}`).join("&");
  return `/findings/open-counts?environmentId=${encodeURIComponent(context.environmentId)}&${ids}`;
}

function byAppIdPath(context: AdminContext, appIds: string[]): string {
  const ids = appIds.map((id) => `appId=${encodeURIComponent(id)}`).join("&");
  return `/principals/by-app-id?environmentId=${encodeURIComponent(context.environmentId)}&${ids}`;
}

/** The Pathix ids of every row the groups sum: each role and its copies. */
function idsOf(groups: RoleGroup[]): string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.id));
}

/** Lower case, once each, sorted: the same set of ids is always the same request, so the cache serves it. */
function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
