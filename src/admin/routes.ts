// The admin center's routes, parsed from the address path. The overlay reads
// ids from the path and nothing else: not the query, not the hash, never a
// name (DESIGN.md, "Names, never values"). The admin center routes on the
// client, so the path changes without a page load.
//
// The organization id in the path is the Dataverse ORGANIZATION id, the one
// Pathix matches environments on (the recon is in the wave 1 proposal).

import { ADMIN_HOST } from "../runtime/admin-overlay";

const GUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const BASE = `^/manage/environments/${GUID}/`;

const ROLE_LIST = new RegExp(`${BASE}securityroles/?$`, "i");
const ROLE_EDITOR = new RegExp(`${BASE}securityroles/${GUID}/roleeditor/?$`, "i");
const APP_USERS = new RegExp(`${BASE}appusers/?$`, "i");
/**
 * A role-list row's link to a role's editor. The admin center writes these as
 * `/environments/<org>/securityroles/<role>/roleeditor`, without the `/manage`
 * its own page paths carry (captured on the real admin center, 2026-10-09), so
 * a link is read with or without it. Page paths still need `/manage`.
 */
const ROLE_EDITOR_LINK = new RegExp(`^(?:/manage)?/environments/${GUID}/securityroles/${GUID}/roleeditor/?$`, "i");

export type AdminRoute =
  | { kind: "roleList"; organizationId: string }
  | { kind: "roleEditor"; organizationId: string; roleId: string }
  | { kind: "appUsers"; organizationId: string };

/** The route a path names, or null for any other page. Ids come back lowercase. */
export function parseAdminRoute(pathname: string): AdminRoute | null {
  const editor = ROLE_EDITOR.exec(pathname);
  if (editor) return { kind: "roleEditor", organizationId: lower(editor[1]), roleId: lower(editor[2]) };
  const list = ROLE_LIST.exec(pathname);
  if (list) return { kind: "roleList", organizationId: lower(list[1]) };
  const users = APP_USERS.exec(pathname);
  if (users) return { kind: "appUsers", organizationId: lower(users[1]) };
  return null;
}

/** One key per page the overlay draws on; a new key means everything drawn is removed. */
export function routeKey(route: AdminRoute | null): string {
  if (!route) return "";
  return route.kind === "roleEditor" ? `${route.kind}|${route.organizationId}|${route.roleId}` : `${route.kind}|${route.organizationId}`;
}

/**
 * The role id a role-list row's link points at: the href must be a role
 * editor link on the admin host, of the same organization, with or without
 * the `/manage` prefix. Only the path is looked at; a link to anywhere else,
 * or to another organization, gives null.
 */
export function roleIdFromHref(href: string, organizationId: string): string | null {
  let url: URL;
  try {
    url = new URL(href, `https://${ADMIN_HOST}`);
  } catch {
    return null;
  }
  if (url.hostname !== ADMIN_HOST) return null;
  const link = ROLE_EDITOR_LINK.exec(url.pathname);
  return link && lower(link[1]) === organizationId ? lower(link[2]) : null;
}

const WHOLE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An Application ID, from the text of a grid cell: the whole text, trimmed,
 * must be one GUID. Anything else (a name, an email, a longer string) is not
 * an Application ID and is dropped here without being kept.
 */
export function appIdFromCellText(text: string): string | null {
  const trimmed = text.trim();
  return WHOLE_GUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

function lower(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}
