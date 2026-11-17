// The one place Lite talks to Dataverse, and the only network call made
// outside the service worker and the options page (test/page-source.test.ts).
//
// It runs in the content script, against the D365 page's own origin, so the
// browser sends the user's own Dataverse session: Lite sees exactly what the
// signed-in user may see, and needs no host permission or token. Every path
// is checked against the allowlist in allowlist.ts before anything is sent.
//
// systemusers is reachable only for the signed-in user: the client keeps the
// UserId that WhoAmI returned and refuses a path that names any other user,
// or any user before WhoAmI has answered.
//
// A collection comes back whole: the client follows @odata.nextLink, but only
// to the same origin, the same resource and a query that still passes the
// allowlist (nextLinkRefusal), so a link from the server cannot lead anywhere
// a request Lite wrote itself could not go.

import { refusalFor, userIdOf } from "./allowlist";

const API_ROOT = "/api/data/v9.2/";
const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * The most answers kept. A long session over many forms and columns makes many
 * paths; the least recently read goes first, and an expired answer is dropped
 * when it is next read.
 */
export const MAX_CACHE_ENTRIES = 300;
/**
 * How long one page may take, its answer and its body together. Past it the
 * request is aborted and the read is failed (timedOut), never empty.
 */
export const DATAVERSE_TIMEOUT_MS = 15_000;
/** Pages followed for one collection. A table with more rows than this stays marked incomplete. */
const MAX_PAGES = 20;

/**
 * A failed, forbidden or missing answer is kept apart from an empty one, so a
 * card can say it does not know rather than show zero (DESIGN.md, "Absence is
 * not evidence").
 */
export type DataverseResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "forbidden" | "notFound" | "failed"; status: number | null; timedOut?: true };

export type DataverseGet = <T>(path: string) => Promise<DataverseResult<T>>;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A fresh abort deadline per request, which aborts after DATAVERSE_TIMEOUT_MS. Injected so tests need no real clock. */
export type Deadline = () => AbortSignal;

const dataverseTimeout: Deadline = () => AbortSignal.timeout(DATAVERSE_TIMEOUT_MS);

export class DataverseRefusedError extends Error {}

type Collection = { value: unknown[]; "@odata.nextLink"?: unknown } & Record<string, unknown>;

function isCollection(data: unknown): data is Collection {
  return typeof data === "object" && data !== null && Array.isArray((data as { value?: unknown }).value);
}

/**
 * The answer is all there is: not a collection that still carries
 * @odata.nextLink. An incomplete collection is never kept, so the next read
 * asks again instead of serving part of a list as the whole for minutes.
 */
function isWhole(data: unknown): boolean {
  return !(isCollection(data) && typeof data["@odata.nextLink"] === "string");
}

/**
 * GETs against `<origin>/api/data/v9.2/`. Successful, whole answers are kept
 * for a few minutes, at most `maxEntries` of them (least recently read out
 * first), and concurrent requests for one path share a call, so
 * opening the same card twice reads Dataverse once. A collection left
 * incomplete (it still carries @odata.nextLink) is returned but not kept. A
 * page that does not answer within DATAVERSE_TIMEOUT_MS is failed with
 * `timedOut`, and, like every failure, not kept: the next read asks again.
 */
export function createDataverseClient(
  origin: string,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  now: () => number = Date.now,
  timeout: Deadline = dataverseTimeout,
  maxEntries: number = MAX_CACHE_ENTRIES,
): DataverseGet {
  const base = new URL(API_ROOT, origin);
  // A Map iterates in insertion order: re-inserting on every read keeps the least recently read first.
  const cache = new Map<string, { at: number; result: DataverseResult<unknown> }>();
  const pending = new Map<string, Promise<DataverseResult<unknown>>>();
  let signedInUser: string | null = null;

  async function fetchPage(href: string): Promise<DataverseResult<unknown>> {
    const deadline = timeout();
    const timedOut = { ok: false as const, kind: "failed" as const, status: null, timedOut: true as const };
    let response: Response;
    try {
      response = await fetchFn(href, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
        signal: deadline,
      });
    } catch {
      return deadline.aborted ? timedOut : { ok: false, kind: "failed", status: null };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, kind: "forbidden", status: response.status };
    if (response.status === 404) return { ok: false, kind: "notFound", status: 404 };
    if (!response.ok) return { ok: false, kind: "failed", status: response.status };
    try {
      return { ok: true, data: (await response.json()) as unknown };
    } catch {
      return deadline.aborted ? timedOut : { ok: false, kind: "failed", status: response.status };
    }
  }

  /**
   * Sends the request, then follows @odata.nextLink so a collection comes back
   * whole. The link is a full URL from the server, so it is never trusted: it
   * is followed only when it stays on this origin, continues the same
   * resource and still passes the allowlist (see nextLinkRefusal). A link that
   * is refused, fails, repeats or runs past MAX_PAGES is left in the answer as
   * @odata.nextLink, so the caller sees an incomplete list and never mistakes
   * it for the whole one (DESIGN.md, "Absence is not evidence").
   */
  async function send(path: string): Promise<DataverseResult<unknown>> {
    const first = await fetchPage(new URL(path, base).href);
    if (!first.ok || !isCollection(first.data)) return first;

    const rows = [...first.data.value];
    let nextLink = first.data["@odata.nextLink"];
    const followed = new Set<string>();
    while (typeof nextLink === "string" && followed.size < MAX_PAGES - 1 && !followed.has(nextLink) && nextLinkRefusal(path, nextLink) === null) {
      followed.add(nextLink);
      const page = await fetchPage(nextLink);
      if (!page.ok || !isCollection(page.data)) break;
      rows.push(...page.data.value);
      nextLink = page.data["@odata.nextLink"];
    }
    const { "@odata.nextLink": _first, ...rest } = first.data;
    return { ok: true, data: { ...rest, value: rows, ...(typeof nextLink === "string" ? { "@odata.nextLink": nextLink } : {}) } };
  }

  /** The resource a URL under the API root addresses, decoded the way Dataverse reads it; null when it is not under the root. */
  function resourceOf(url: URL): string | null {
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
    try {
      return decodeURIComponent(url.pathname.slice(base.pathname.length));
    } catch {
      return null;
    }
  }

  /**
   * Why a nextLink may not be followed, or null when it may. It must be an
   * absolute URL on the page's own origin with no credentials or fragment. It
   * must continue the resource that was asked for, not lead to another table.
   * Its query must carry exactly one opaque $skiptoken, and the rest of it,
   * decoded, must pass the same allowlist as a request Lite writes itself. It
   * is not compared with the original query: a link that changes an allowlisted
   * option still cannot leave the allowlist.
   */
  function nextLinkRefusal(path: string, nextLink: string): string | null {
    let url: URL;
    try {
      url = new URL(nextLink);
    } catch {
      return "is not an absolute URL";
    }
    if (url.username !== "" || url.password !== "" || url.hash !== "") return "carries credentials or a fragment";
    const resource = resourceOf(url);
    if (resource === null) return `leaves ${API_ROOT}`;
    if (resource !== resourceOf(new URL(path, base))) return "continues a different resource";

    const options = url.search.slice(1).split("&").filter((option) => option !== "");
    const tokens = options.filter((option) => option.startsWith("$skiptoken="));
    if (tokens.length !== 1) return "does not carry exactly one $skiptoken";
    let query: string;
    try {
      query = options.filter((option) => !option.startsWith("$skiptoken=")).map((option) => decodeURIComponent(option)).join("&");
    } catch {
      return "does not decode";
    }
    const followed = query === "" ? resource : `${resource}?${query}`;
    return refusalFor(followed) ?? userRefusal(followed);
  }

  /**
   * Checks the path as written and again as the URL parser resolves it,
   * decoded the way Dataverse will read it.
   */
  function refusalOfResolved(path: string): string | null {
    const asWritten = refusalFor(path);
    if (asWritten) return asWritten;
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.href.startsWith(base.href)) return `resolves outside ${API_ROOT}`;
    let resolved: string;
    try {
      resolved = decodeURIComponent(url.href.slice(base.href.length));
    } catch {
      return "does not decode";
    }
    return refusalFor(resolved) ?? userRefusal(resolved);
  }

  function userRefusal(path: string): string | null {
    const userId = userIdOf(path);
    if (userId === null) return null;
    if (signedInUser === null) return "systemusers needs the signed-in user's id from WhoAmI first";
    return userId === signedInUser ? null : "systemusers may only address the signed-in user";
  }

  /** A fresh answer for `path`, moved to the back as the most recently read; an expired one is dropped. */
  function cached(path: string): DataverseResult<unknown> | null {
    const entry = cache.get(path);
    if (!entry) return null;
    cache.delete(path);
    if (now() - entry.at >= CACHE_TTL_MS) return null;
    cache.set(path, entry);
    return entry.result;
  }

  function keep(path: string, result: DataverseResult<unknown>): void {
    cache.delete(path);
    cache.set(path, { at: now(), result });
    for (const oldest of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(oldest);
    }
  }

  function remember(path: string, result: DataverseResult<unknown>): void {
    if (path !== "WhoAmI" || !result.ok) return;
    const userId = (result.data as { UserId?: unknown } | null)?.UserId;
    if (typeof userId === "string") signedInUser = userId.toLowerCase();
  }

  return <T>(path: string): Promise<DataverseResult<T>> => {
    const refusal = refusalOfResolved(path);
    if (refusal) return Promise.reject(new DataverseRefusedError(`Refused ${path}: ${refusal}.`));

    const hit = cached(path);
    if (hit) return Promise.resolve(hit as DataverseResult<T>);
    const inFlight = pending.get(path);
    if (inFlight) return inFlight as Promise<DataverseResult<T>>;

    const request = send(path)
      .then((result) => {
        if (result.ok && isWhole(result.data)) keep(path, result);
        remember(path, result);
        return result;
      })
      .finally(() => pending.delete(path));
    pending.set(path, request);
    return request as Promise<DataverseResult<T>>;
  };
}
