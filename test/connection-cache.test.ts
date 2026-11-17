// The service worker's connection cache (src/background/connection.ts): one
// resolution per org and host, kept for connectionTtl, and a resolution that
// overlapped clear() is never kept, so a "connected" learned just before a
// refused grant or a sign-out does not outlive it.

import { describe, expect, it, vi } from "vitest";
import { CONNECTION_TTL_MS, ConnectionCache } from "../src/background/connection";
import type { ConnectionStatus } from "../src/runtime/messages";

const ORG = "c0de0000-0000-4000-8000-000000000001";
const HOST = "contoso.crm.dynamics.com";
const CONNECTED: ConnectionStatus = { kind: "connected", environmentId: "env-1", environmentName: "Contoso", latestCompletedScanAt: "2026-10-01T00:00:00Z" };
const NOT_CONFIGURED: ConnectionStatus = { kind: "notConfigured" };

/** A resolver whose answers wait until released, one per call. */
function resolver(...answers: ConnectionStatus[]) {
  const releases: Array<() => void> = [];
  const resolve = vi.fn(async (_organizationId: string, _host: string) => {
    const answer = answers[resolve.mock.calls.length - 1] ?? answers[answers.length - 1]!;
    await new Promise<void>((release) => releases.push(release));
    return answer;
  });
  /** Lets the next waiting resolution answer. */
  const release = async () => {
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    releases.shift()!();
  };
  return { resolve, release };
}

describe("ConnectionCache", () => {
  it("shares one resolution among callers, then keeps the answer for its TTL", async () => {
    let now = 0;
    const { resolve, release } = resolver(CONNECTED);
    const cache = new ConnectionCache(resolve, () => now);
    const both = Promise.all([cache.get(ORG, HOST), cache.get(ORG, HOST)]);
    await release();
    expect(await both).toEqual([CONNECTED, CONNECTED]);
    expect(await cache.get(ORG, HOST)).toEqual(CONNECTED);
    expect(resolve).toHaveBeenCalledTimes(1);

    now = CONNECTION_TTL_MS;
    const again = cache.get(ORG, HOST);
    await release();
    await again;
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not keep a connected status from a resolution that was running when it was cleared, and asks again", async () => {
    const { resolve, release } = resolver(CONNECTED, NOT_CONFIGURED);
    const cache = new ConnectionCache(resolve, () => 0);
    const answer = cache.get(ORG, HOST);
    cache.clear();
    await release();
    await release();
    expect(await answer).toEqual(NOT_CONFIGURED);
    expect(resolve).toHaveBeenCalledTimes(2);

    // The second answer was learned after the clear, so it is kept.
    expect(await cache.get(ORG, HOST)).toEqual(NOT_CONFIGURED);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("answers but keeps nothing when it is cleared during the second resolution too", async () => {
    const { resolve, release } = resolver(CONNECTED, CONNECTED, NOT_CONFIGURED);
    const cache = new ConnectionCache(resolve, () => 0);
    const answer = cache.get(ORG, HOST);
    cache.clear();
    await release();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    cache.clear();
    await release();
    await answer;

    const next = cache.get(ORG, HOST);
    await release();
    expect(await next).toEqual(NOT_CONFIGURED);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("forgets every kept status on clear", async () => {
    const { resolve, release } = resolver(CONNECTED, NOT_CONFIGURED);
    const cache = new ConnectionCache(resolve, () => 0);
    const first = cache.get(ORG, HOST);
    await release();
    await first;
    cache.clear();
    const second = cache.get(ORG, HOST);
    await release();
    expect(await second).toEqual(NOT_CONFIGURED);
  });
});
