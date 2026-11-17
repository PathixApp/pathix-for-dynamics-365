// Chrome's match-pattern rules for the https patterns this extension uses,
// shared by the tests that pin what the extension may run on.

export function matchesPattern(pattern: string, url: string): boolean {
  const parts = /^(https|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parts) throw new Error(`Unsupported pattern ${pattern}`);
  const [, scheme, host, path] = parts;
  const target = new URL(url);
  if (scheme === "https" && target.protocol !== "https:") return false;
  const hostOk = host === "*" || (host!.startsWith("*.") ? target.hostname === host!.slice(2) || target.hostname.endsWith(host!.slice(1)) : target.hostname === host);
  if (!hostOk) return false;
  const pathRegex = new RegExp(`^${path!.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return pathRegex.test(target.pathname + target.search);
}

/**
 * Addresses a customer's Pathix could have. The Pathix address is the Pathix
 * web app's own origin, so no script the extension registers or declares may
 * ever match one.
 */
export const PATHIX_ADDRESSES = [
  "https://pathix.contoso.com/",
  "https://pathix.contoso.com/environments",
  "https://contoso-pathix.azurewebsites.net/",
  "https://pathix-web.contoso.westeurope.azurecontainerapps.io/",
  "https://pathix.internal.contoso.com:8443/",
  "https://pathix.contoso.test/",
  "https://10.0.0.4/",
];
