// Which Entra authority the extension will sign in through. Pathix's /config
// names it (azureAd.authority), and Pathix composes it as
// `${AzureAd:Instance}/${tenantId}` with the instance trimmed of its slash
// (in the Pathix server's /config endpoint). A look-alike Pathix could name
// any URL, so the extension only accepts an Entra cloud's own sign-in host with
// the tenant's GUID as the whole path: no user name, port, query or fragment.

/** The sign-in hosts of the Entra clouds: public, US Government, and China (both names 21Vianet serves). */
export const ENTRA_HOSTS: readonly string[] = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
  "login.chinacloudapi.cn",
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `authority` is exactly `https://<an Entra host>/<tenantId>`, with
 * `tenantId` a GUID. Compared as text, so anything a URL would quietly
 * normalize (a port, a user name, a trailing slash, a capital in the host) is
 * refused rather than read.
 */
export function isEntraAuthority(authority: string, tenantId: string): boolean {
  if (!GUID.test(tenantId)) return false;
  return ENTRA_HOSTS.some((host) => authority === `https://${host}/${tenantId}`);
}

/** The tenant GUID of an authority isEntraAuthority accepts, or null for any other. */
export function entraTenantOf(authority: string): string | null {
  for (const host of ENTRA_HOSTS) {
    const prefix = `https://${host}/`;
    if (!authority.startsWith(prefix)) continue;
    const tenantId = authority.slice(prefix.length);
    return isEntraAuthority(authority, tenantId) ? tenantId : null;
  }
  return null;
}

/** The host of an authority isEntraAuthority accepts, or null for any other. */
export function entraHostOf(authority: string): string | null {
  const tenantId = entraTenantOf(authority);
  return tenantId === null ? null : authority.slice("https://".length, -(tenantId.length + 1));
}
