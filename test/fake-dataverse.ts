// A fake Dataverse Web API that answers from contract/dataverse/, for Lite
// tests. Routing lives in src/demo/fixture-dataverse.ts, shared with the
// demo page and the smoke test; this adds the request log and the overrides.
//
// Files marked "_standIn" are hand-written until the maintainer captures them
// (contract/dataverse/queries.json lists the query for each).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../src/dataverse/client";
import { createFixtureRouter, type CapturedQuery, type Fixtures } from "../src/demo/fixture-dataverse";

export const ORIGIN = "https://contoso.crm.dynamics.com";
const API = `${ORIGIN}/api/data/v9.2/`;
const DIR = "contract/dataverse";

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as T;
}

/** Every fixture in contract/dataverse/, by name. */
export function allFixtures(): Fixtures {
  return Object.fromEntries(
    readdirSync(DIR)
      .filter((file) => file.endsWith(".json") && file !== "queries.json")
      .map((file) => [file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(DIR, file), "utf8")) as unknown]),
  );
}

export function capturedQueries(): CapturedQuery[] {
  return JSON.parse(readFileSync(join(DIR, "queries.json"), "utf8")) as CapturedQuery[];
}

const route = createFixtureRouter(allFixtures(), capturedQueries());

export interface FakeDataverse {
  fetch: FetchLike;
  /** Every URL requested, in order. */
  requests: string[];
  /** Answer the next request whose path starts with `prefix` with this status instead. */
  failWhen(prefix: string, status: number): void;
  /** Answer requests whose path starts with `prefix` with this body instead. */
  answerWhen(prefix: string, body: unknown): void;
}

export function fakeDataverse(): FakeDataverse {
  const requests: string[] = [];
  const failures: Array<[string, number]> = [];
  const overrides: Array<[string, unknown]> = [];

  const respond = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch: FetchLike = async (input, init) => {
    requests.push(input);
    if (init.method !== "GET") return respond(405);
    if (!input.startsWith(API)) return respond(400);
    const path = decodeURIComponent(input.slice(API.length));

    const failure = failures.find(([prefix]) => path.startsWith(prefix));
    if (failure) return respond(failure[1], { error: { message: "fake" } });
    const override = overrides.find(([prefix]) => path.startsWith(prefix));
    if (override) return respond(200, override[1]);

    const routed = route(path);
    return respond(routed.status, routed.body);
  };

  return {
    fetch,
    requests,
    failWhen: (prefix, status) => failures.push([prefix, status]),
    answerWhen: (prefix, body) => overrides.push([prefix, body]),
  };
}
