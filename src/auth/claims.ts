// Reading an access token's claims, in one place. The extension never
// verifies a token: Pathix does. It reads three things from the payload: the
// user's name, for display on the options page; the account's sign-in hint,
// kept with the confirmed binding so a silent renewal asks Entra for the same
// account (see loginHintOf in ./binding.ts); and the granted scopes, so it
// keeps no token that grants more than Pathix.Read (see grantRefusal in
// ./authorize.ts).

/** The token's payload, or null when it is not a readable JWT. */
export function tokenClaims(jwt: string): Record<string, unknown> | null {
  const segment = jwt.split(".")[1];
  if (!segment) return null;
  try {
    const payload: unknown = JSON.parse(base64UrlToText(segment));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A JWT segment is base64url of UTF-8, so a name such as "josé" survives (atob alone reads it as Latin-1). */
function base64UrlToText(segment: string): string {
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The UPN, for display only. */
export function accountName(jwt: string): string | null {
  const claims = tokenClaims(jwt);
  const name = claims?.upn ?? claims?.preferred_username ?? claims?.unique_name;
  return typeof name === "string" ? name : null;
}

/** The longest sign-in hint kept. An Entra sign-in name is far shorter; anything longer is not one. */
const MAX_LOGIN_HINT = 256;

/**
 * The signed-in account, as Entra takes it back in `login_hint`: the token's
 * own `login_hint` claim when the registration emits it, else
 * `preferred_username`, else `upn`. Null when none is a short, printable
 * string. Never sent anywhere but Entra's authorize endpoint.
 */
export function loginHintClaim(jwt: string): string | null {
  const claims = tokenClaims(jwt);
  for (const name of ["login_hint", "preferred_username", "upn"]) {
    const value = claims?.[name];
    if (typeof value === "string" && isLoginHint(value)) return value;
  }
  return null;
}

/**
 * Whether the token is for the account `hint` names: true when its
 * login_hint, preferred_username or upn claim is that value (ignoring case),
 * false when it names another account, null when it names none.
 */
export function namesAccount(jwt: string, hint: string): boolean | null {
  const claims = tokenClaims(jwt);
  const names = ["login_hint", "preferred_username", "upn"].map((name) => claims?.[name]).filter((value): value is string => typeof value === "string" && value !== "");
  if (names.length === 0) return null;
  return names.some((name) => name.toLowerCase() === hint.toLowerCase());
}

/** A value fit to send as login_hint: non-empty, short, with no spaces or control characters. */
export function isLoginHint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LOGIN_HINT && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** The delegated scopes the token grants, from its `scp` claim. Empty when it names none or cannot be read. */
export function grantedScopes(jwt: string): string[] {
  const scp = tokenClaims(jwt)?.scp;
  return typeof scp === "string" ? scp.split(/\s+/).filter((scope) => scope !== "") : [];
}
