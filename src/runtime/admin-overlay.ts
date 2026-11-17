// The Power Platform admin center overlay (M14): what is shared between the
// admin page script, the service worker and the options page. The host it
// runs on, the one script it registers, the setting that turns it on, and the
// messages the page script sends. Ids only, like the bridge (DESIGN.md,
// "Names, never values").

import { isGuid } from "../bridge/messages";

/** The one host the overlay ever runs on. Never a sign-in host (see test/admin-overlay.test.ts). */
export const ADMIN_HOST = "admin.powerplatform.microsoft.com";
export const ADMIN_HOST_PATTERN = `https://${ADMIN_HOST}/*`;

/** The id of the one content script the worker registers at runtime, and the file it runs. */
export const ADMIN_SCRIPT_ID = "pathix-admin-overlay";
export const ADMIN_SCRIPT_FILE = "admin.js";

/** chrome.storage.local: the user asked for the overlay. It only counts while the host permission is held. */
export const ADMIN_OVERLAY_KEY = "adminOverlay";

/**
 * chrome.storage.local: when the user clicked to turn the overlay on, as a
 * timestamp. Written just before the permission prompt, because the prompt can
 * close the toolbar popup before the popup stores the setting. The worker's
 * permission listener then finishes the job (completeEnableIntent). It counts
 * for ADMIN_INTENT_TTL_MS only (a minute: long enough to answer the prompt), so
 * a stale click never turns the overlay on later. Turning the overlay off
 * clears it. What remains: a deny that closed the popup reaches no one, so for
 * that minute a grant of the admin host by another route (the browser's site
 * access settings) would turn the overlay on.
 */
export const ADMIN_OVERLAY_INTENT_KEY = "adminOverlayIntent";
export const ADMIN_INTENT_TTL_MS = 60 * 1000;

/** Roles on a list page, and App IDs on a grid page, per request. A page shows far fewer. */
export const MAX_ADMIN_IDS = 500;

/** Content script to service worker: the banner for one role on its editor page. */
export interface AdminRoleRequest {
  kind: "adminRole";
  organizationId: string;
  roleId: string;
}

/** Content script to service worker: badges for the roles a list page links to. */
export interface AdminRoleListRequest {
  kind: "adminRoleList";
  organizationId: string;
  roleIds: string[];
}

/** Content script to service worker: chips for the Application IDs a grid shows. */
export interface AdminAppUsersRequest {
  kind: "adminAppUsers";
  organizationId: string;
  appIds: string[];
}

/** Options page to service worker: reconcile the registration with the setting and the permission, and report. */
export interface AdminOverlayStatusRequest {
  kind: "adminOverlayStatus";
}

/** Service worker to a page script: turned off, remove everything. Carries nothing. */
export interface AdminOverlayOffCommand {
  kind: "adminOverlayOff";
}

/** What the options page shows about the overlay. */
export interface AdminOverlayStatus {
  /** The setting is on and the host permission is held. */
  enabled: boolean;
  /** The worker has the page script registered for the host. */
  registered: boolean;
  error: string | null;
}

/** The banner on a role's editor page. Every string is composed from Pathix's answer and shown as text. */
export interface RoleBannerModel {
  /** "Assigned to 3 humans and 1 integration", "Assigned to at least 3 humans", or "Assignments: unknown". */
  assigned: string;
  /** Teams hold the role too, and their members are not counted. null: no team holds it, or unknown. */
  teams: string | null;
  /** What the numbers cover: the role's business unit copies included, a copy alone, or same-name rows not counted. null: just this role. */
  copies: string | null;
  /** "2 open findings name this role (highest: High)", "No open findings name this role (...)", or "Open findings: unknown". */
  findings: string;
  /** The number beside the findings icon: null when unknown. */
  findingsCount: number | null;
  /** The number is a minimum ("3+"): some of the role's business unit copies are not in it. */
  findingsFloor: boolean;
  /** "From Pathix's latest scan, Oct 6, 2026, 4:12 PM". */
  scan: string;
  href: string;
}

/** The compact badge on a role-list row. */
export interface RoleBadgeModel {
  /** "3 assigned", or "3+ assigned" and "? assigned" when the copies are not known. Direct assignments of every kind, from Pathix's role list. */
  assigned: string;
  findingsCount: number | null;
  /** The number is a minimum ("3+"): some of the role's business unit copies are not in it. */
  findingsFloor: boolean;
  /** The whole sentence, for the tooltip and the accessible name. */
  title: string;
  href: string;
}

/** The chip on an application-user row. */
export interface AppUserChipModel {
  /** "Pathix: 3 roles", "Pathix: 3 roles, disabled", or "Not in Pathix's latest scan". */
  text: string;
  title: string;
  /** null for "Not in Pathix's latest scan": nothing to open. */
  href: string | null;
}

export type AdminRoleResponse = { kind: "role"; banner: RoleBannerModel } | { kind: "none" };
export type AdminRoleListResponse = { kind: "roles"; badges: Record<string, RoleBadgeModel> } | { kind: "none" };
export type AdminAppUsersResponse = { kind: "appUsers"; chips: Record<string, AppUserChipModel> } | { kind: "none" };

export function isAdminRoleRequest(value: unknown): value is AdminRoleRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.kind === "adminRole" &&
    isGuid(value.organizationId) &&
    isGuid(value.roleId)
  );
}

export function isAdminRoleListRequest(value: unknown): value is AdminRoleListRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.kind === "adminRoleList" &&
    isGuid(value.organizationId) &&
    isGuidList(value.roleIds)
  );
}

export function isAdminAppUsersRequest(value: unknown): value is AdminAppUsersRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.kind === "adminAppUsers" &&
    isGuid(value.organizationId) &&
    isGuidList(value.appIds)
  );
}

export function isAdminOverlayStatusRequest(value: unknown): value is AdminOverlayStatusRequest {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "adminOverlayStatus";
}

/**
 * Service worker to every tab (D365 forms and the admin center): the user
 * signed out, or the Pathix address changed, so nothing learned from Pathix
 * may stay on the page. Each surface asks again or takes its answers down. It
 * carries nothing else.
 */
export interface PathixResetCommand {
  kind: "pathixReset";
}

export function isPathixResetCommand(value: unknown): value is PathixResetCommand {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "pathixReset";
}

export function isAdminOverlayOffCommand(value: unknown): value is AdminOverlayOffCommand {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "adminOverlayOff";
}

// The page script treats the worker's answers as data and checks their shape
// before drawing them, so a malformed answer draws nothing.

export function isRoleBannerModel(value: unknown): value is RoleBannerModel {
  return (
    isRecord(value) &&
    isString(value.assigned) &&
    isStringOrNull(value.teams) &&
    isStringOrNull(value.copies) &&
    isString(value.findings) &&
    isCountOrNull(value.findingsCount) &&
    typeof value.findingsFloor === "boolean" &&
    isString(value.scan) &&
    isHttpUrl(value.href)
  );
}

export function isRoleBadgeModel(value: unknown): value is RoleBadgeModel {
  return (
    isRecord(value) &&
    isString(value.assigned) &&
    isCountOrNull(value.findingsCount) &&
    typeof value.findingsFloor === "boolean" &&
    isString(value.title) &&
    isHttpUrl(value.href)
  );
}

export function isAppUserChipModel(value: unknown): value is AppUserChipModel {
  return isRecord(value) && isString(value.text) && isString(value.title) && (value.href === null || isHttpUrl(value.href));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000;
}

function isStringOrNull(value: unknown): boolean {
  return value === null || isString(value);
}

function isCountOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isHttpUrl(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isGuidList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ADMIN_IDS && value.every(isGuid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a sender the page script's requests may come from: this extension, in a tab on the admin host. */
export function isFromAdminPage(sender: { id?: string; url?: string; tab?: unknown }, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.tab) return false;
  try {
    const url = new URL(sender.url ?? "");
    return url.protocol === "https:" && url.hostname === ADMIN_HOST;
  } catch {
    return false;
  }
}
