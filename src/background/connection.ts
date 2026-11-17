// Resolves a D365 org to its Pathix environment and latest Completed scan.
// Uses only the organization id and host from the form snapshot; nothing else
// from the page reaches Pathix.

import type { ApiResult, EnvironmentSummary, ScanSummary } from "../pathix/api";
import { completedScanUnknown, findEnvironment, latestCompletedScan } from "../pathix/environment-match";
import type { ConnectionStatus } from "../runtime/messages";

export type Get = <T>(path: string) => Promise<ApiResult<T>>;

export const CONNECTION_TTL_MS = 5 * 60 * 1000;
export const SHORT_TTL_MS = 30 * 1000;

/**
 * How long the service worker may keep a status before it asks Pathix again.
 * A connected environment with no Completed scan yet is kept only briefly,
 * so a scan that finishes shows up within half a minute, as do failures.
 */
export function connectionTtl(status: ConnectionStatus): number {
  if (status.kind === "connected") return status.latestCompletedScanAt === null ? SHORT_TTL_MS : CONNECTION_TTL_MS;
  return status.kind === "notScanned" ? CONNECTION_TTL_MS : SHORT_TTL_MS;
}

/**
 * The connection status of each org and host, kept for connectionTtl.
 *
 * Every edit on a form sends a snapshot, so without this a signed-out user
 * would start a silent sign-in per keystroke. One resolution per org and host
 * runs at a time, and a failure is remembered briefly before it is retried.
 *
 * clear() forgets every status. A resolution that was running when it was
 * called may have learned something stale, such as "connected" just before a
 * refused grant or a sign-out, so it is asked once more and only the new
 * answer is kept. If clear() lands during that second run too, the answer is
 * given but not kept.
 */
export class ConnectionCache {
  private readonly statuses = new Map<string, { status: ConnectionStatus; at: number }>();
  private readonly inFlight = new Map<string, Promise<ConnectionStatus>>();
  private generation = 0;

  constructor(
    private readonly resolve: (organizationId: string, host: string) => Promise<ConnectionStatus>,
    private readonly now: () => number,
  ) {}

  get(organizationId: string, host: string): Promise<ConnectionStatus> {
    const key = `${organizationId}|${host}`;
    const cached = this.statuses.get(key);
    if (cached && this.now() - cached.at < connectionTtl(cached.status)) return Promise.resolve(cached.status);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const resolution = this.resolveCurrent(organizationId, host, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, resolution);
    return resolution;
  }

  clear(): void {
    this.statuses.clear();
    this.generation += 1;
  }

  private async resolveCurrent(organizationId: string, host: string, key: string): Promise<ConnectionStatus> {
    for (let attempt = 1; ; attempt += 1) {
      const started = this.generation;
      const status = await this.resolve(organizationId, host);
      if (this.generation === started) {
        this.statuses.set(key, { status, at: this.now() });
        return status;
      }
      if (attempt === 2) return status;
    }
  }
}

/** `host` is the page's, or null where there is none to check (the admin center): see matchEnvironment. */
export async function resolveConnection(organizationId: string, host: string | null, get: Get): Promise<ConnectionStatus> {
  const environments = await get<EnvironmentSummary[]>("/environments");
  if (!environments.ok) return failure(environments);

  const found = findEnvironment(environments.data, organizationId, host);
  if (found.kind === "otherHost") return { kind: "notScanned", otherHost: found.otherHost };
  if (found.kind === "noAddress") return { kind: "notScanned", noAddress: true };
  if (found.kind === "none") return { kind: "notScanned" };
  const environment = found.environment;

  const scans = await get<ScanSummary[]>(`/scans?environmentId=${encodeURIComponent(environment.id)}`);
  if (!scans.ok) return failure(scans);

  const excluded = Array.isArray(environment.excludedEntities)
    ? { excludedTables: environment.excludedEntities.filter((table) => typeof table === "string").map((table) => table.toLowerCase()) }
    : {};
  // At the list's cap with no Completed scan, one may be older than the list.
  const unknown = completedScanUnknown(scans.data) ? { latestCompletedScanUnknown: true as const } : {};
  const latest = latestCompletedScan(scans.data);
  return {
    kind: "connected",
    environmentId: environment.id,
    environmentName: environment.name,
    latestCompletedScanAt: latest?.completedAt ?? null,
    latestCompletedScanStartedAt: typeof latest?.startedAt === "string" ? latest.startedAt : null,
    ...unknown,
    ...excluded,
  };
}

/** Whether the environment's scans leave this table out. Unknown is not excluded. */
export function isExcludedTable(status: { excludedTables?: string[] }, table: string): boolean {
  return status.excludedTables?.includes(table.toLowerCase()) ?? false;
}

function failure(result: Exclude<ApiResult<unknown>, { ok: true }>): ConnectionStatus {
  switch (result.kind) {
    case "signedOut":
      return { kind: "signedOut", reason: "no token" };
    case "unauthorized":
      return { kind: "unauthorized", status: result.status };
    case "failed":
      return { kind: "error", message: result.message };
  }
}
