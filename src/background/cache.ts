// Small building blocks for the service worker's Pathix reads.

import type { ApiResult } from "../pathix/api";
import type { Get } from "./connection";

const MAX_ENTRIES = 500;

interface Entry {
  result: ApiResult<unknown>;
  at: number;
}

/**
 * Remembers successful GETs, so the hover card and X-ray share one read per
 * column. `scope` is part of the key (the environment's latest Completed scan),
 * so a newer scan never serves an older answer. Failures are not kept, and
 * concurrent requests for the same path share one call.
 *
 * clear() (sign-out, a new address, a new sign-in) bumps a generation. A read
 * that was in flight when it was called still answers its own caller, but its
 * answer is never kept and no later caller shares it.
 */
export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<ApiResult<unknown>>>();
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    /** The most answers kept. A save preview is keyed by the set of edited columns, so a long edit session makes many keys. */
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  wrap(get: Get, scope: string): Get {
    return <T>(path: string) => this.read(`${scope}|${path}`, () => get<T>(path)) as Promise<ApiResult<T>>;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.generation += 1;
  }

  // Drops the oldest answers first (a Map iterates in insertion order), after
  // the one being replaced, so the newest answer is always kept.
  private remember(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  private read(key: string, load: () => Promise<ApiResult<unknown>>): Promise<ApiResult<unknown>> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < this.ttlMs) return Promise.resolve(entry.result);

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const started = this.generation;
    const request: Promise<ApiResult<unknown>> = load()
      .then((result) => {
        if (result.ok && this.generation === started) this.remember(key, { result, at: this.now() });
        return result;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
