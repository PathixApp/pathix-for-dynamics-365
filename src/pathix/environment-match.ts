// Which Pathix environment is the open D365 org, and what scan answers for it.

import type { EnvironmentSummary, ScanSummary } from "./api";

/**
 * Matches on the organization id first: it is stable across the URL forms an
 * org can be reached by. Falls back to the host for an environment whose org
 * id Pathix has not captured.
 *
 * The organization id comes from the page, and any script on the page can
 * name one. So an org-id match must also be on the page's host: a page that
 * names another environment's org id gets no environment, never another
 * environment's answers. An environment Pathix stores no usable URL for cannot
 * be checked that way, so the org id alone does not match it either. `host` is
 * null where there is no Dynamics host to check (the admin center), and the
 * org id alone decides.
 */
export function matchEnvironment(
  environments: EnvironmentSummary[],
  organizationId: string,
  host: string | null,
): EnvironmentSummary | null {
  const found = findEnvironment(environments, organizationId, host);
  return found.kind === "match" ? found.environment : null;
}

/**
 * matchEnvironment, saying why there is no match when Pathix lists the
 * organization: `otherHost` is the host of the URL Pathix stores for it
 * (Pathix metadata, never the page's), and `noAddress` is an environment
 * Pathix stores no usable URL for, so this page cannot be checked against it.
 * The page gets no answer for either: a page on one host never reads another
 * host's environment, nor one whose host is not known.
 */
export type EnvironmentMatch =
  | { kind: "match"; environment: EnvironmentSummary }
  | { kind: "otherHost"; otherHost: string }
  | { kind: "noAddress" }
  | { kind: "none" };

export function findEnvironment(environments: EnvironmentSummary[], organizationId: string, host: string | null): EnvironmentMatch {
  const pageHost = host?.toLowerCase() ?? null;
  const byOrg = environments.find(
    (environment) => environment.dataverseEnvironmentId.toLowerCase() === organizationId.toLowerCase(),
  );
  if (byOrg) {
    if (pageHost === null) return { kind: "match", environment: byOrg };
    const stored = hostOf(byOrg.url);
    if (stored === null) return { kind: "noAddress" };
    return stored === pageHost ? { kind: "match", environment: byOrg } : { kind: "otherHost", otherHost: stored };
  }
  if (pageHost === null) return { kind: "none" };
  const byHost = environments.find((environment) => hostOf(environment.url) === pageHost);
  return byHost ? { kind: "match", environment: byHost } : { kind: "none" };
}

/**
 * The most scans Pathix's `/scans?environmentId=` lists: the latest 100 by
 * start time (the Pathix server's scan history limit). It has no
 * status filter, so a Completed scan older than the 100 latest is not listed.
 */
export const SCAN_LIST_CAP = 100;

/**
 * Whether a scan list says nothing about the latest Completed scan: it is at
 * the cap and holds none, so one may sit beyond it. Pathix would still answer
 * from it, so this is unknown, never "no Completed scan".
 */
export function completedScanUnknown(scans: ScanSummary[]): boolean {
  return scans.length >= SCAN_LIST_CAP && latestCompletedScan(scans) === null;
}

/**
 * Only a Completed scan answers questions; Running, Failed and Partial scans
 * are invisible to Pathix's read surfaces.
 */
export function latestCompletedScan(scans: ScanSummary[]): ScanSummary | null {
  const completed = scans.filter((scan) => scan.status === "Completed" && scan.completedAt);
  completed.sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""));
  return completed[0] ?? null;
}

/** The host of a URL Pathix stores, or null when it is empty or not a URL. */
function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
