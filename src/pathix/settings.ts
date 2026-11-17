// What the user configures on the options page: where their Pathix is. The
// extension's client ID and the scope it asks for come from that Pathix's
// /config (fetchAuthConfig in src/pathix/api.ts), so the address is all the
// user types.

import { ENTRA_HOSTS } from "../auth/authority";
import { ADMIN_HOST, ADMIN_HOST_PATTERN } from "../runtime/admin-overlay";

export interface ExtensionSettings {
  /** The origin of the Pathix web app, e.g. https://pathix.contoso.com */
  pathixUrl: string;
}

/**
 * Where an earlier build kept the client ID the user typed, before Pathix
 * served it from /config. Never read. It is removed when the extension is
 * updated, on the next save, and with the address.
 */
export const LEGACY_CLIENT_ID_KEY = "clientId";

/** On an update (chrome.runtime.onInstalled), removes the client ID an earlier build stored. */
export async function forgetLegacyClientId(reason: string, remove: (key: string) => Promise<void>): Promise<void> {
  if (reason === "update") await remove(LEGACY_CLIENT_ID_KEY);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Microsoft's Dynamics 365 domains, in every cloud: commercial, US Government
 * and China. A Pathix address there would put the extension's Dynamics content
 * scripts on the Pathix origin, which SECURITY.md promises never happens, and
 * its permission would reach the user's Dynamics orgs.
 */
const DYNAMICS_DOMAINS: readonly string[] = ["dynamics.com", "microsoftdynamics.us", "appsplatform.us", "dynamics.cn"];

/**
 * Accepts what a user pastes (a page URL, a trailing slash) and keeps the
 * origin. The origin becomes a host permission request, so it must name one
 * site: no wildcard, and none of Microsoft's own hosts the extension already
 * runs on or signs in through.
 */
export function parsePathixUrl(input: string): ParseResult<string> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Enter the full address of your Pathix site, starting with https://." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Pathix must be reached over https." };
  const refused = refusedHost(url.hostname.toLowerCase().replace(/\.$/, ""));
  return refused ? { ok: false, error: refused } : { ok: true, value: url.origin };
}

/** Why a host cannot be a Pathix address, or null when it can. */
function refusedHost(host: string): string | null {
  if (host.includes("*")) return "Enter your Pathix site's own address. It cannot contain *.";
  if (DYNAMICS_DOMAINS.some((domain) => isOrUnder(host, domain))) {
    return "That is a Dynamics 365 address. Enter the address of your Pathix site.";
  }
  if (isOrUnder(host, ADMIN_HOST)) return "That is the Power Platform admin center. Enter the address of your Pathix site.";
  if (ENTRA_HOSTS.some((entra) => isOrUnder(host, entra))) return "That is a Microsoft sign-in address. Enter the address of your Pathix site.";
  return null;
}

function isOrUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The settings in what extension storage holds, or null when no address is
 * saved. Any other key, such as a client ID an earlier build stored, is
 * ignored.
 */
export function settingsFrom(stored: Record<string, unknown>): ExtensionSettings | null {
  return typeof stored.pathixUrl === "string" && stored.pathixUrl !== "" ? { pathixUrl: stored.pathixUrl } : null;
}

/** The host-permission pattern to request for a Pathix origin. */
export function originPattern(pathixUrl: string): string {
  return `${pathixUrl}/*`;
}

/**
 * The host permission to give back when the address changes from `previous`
 * to `next`, or null when there is none to give back: the old Pathix origin,
 * unless it is also the new one, or the admin center's, which the overlay holds.
 * An old address this build would refuse (one an earlier build saved, such as
 * `https://*`) gives nothing back: its pattern could cover the admin center
 * and take the overlay's permission with it.
 */
export function originToRelease(previous: unknown, next: string | null): string | null {
  if (typeof previous !== "string" || previous === "") return null;
  const parsed = parsePathixUrl(previous);
  if (!parsed.ok) return null;
  const old = originPattern(parsed.value);
  if (next !== null && old === originPattern(next)) return null;
  return old === ADMIN_HOST_PATTERN ? null : old;
}
