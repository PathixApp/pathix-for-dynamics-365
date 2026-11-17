// PKCE (RFC 7636) and the random values an authorization request needs.
// Uses Web Crypto, which the service worker, the options page and Node (for
// tests) all provide.

export function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** A 43-128 character code verifier; 64 random bytes encode to 86. */
export function createCodeVerifier(): string {
  return randomUrlSafe(64);
}

/** The S256 challenge for a verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
