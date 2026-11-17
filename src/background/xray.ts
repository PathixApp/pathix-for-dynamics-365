// Loads X-ray mode for a whole form: for each column, one field-writers and
// one field-dependents read, plus open-findings counts in batches. All of them
// share one limit, at most four reads in flight, and go through the cache the
// hover card uses, so a column hovered after X-ray (or the other way round)
// costs no second read of the same answer.
//
// Not GET /fields/confidence-mix, although it is a batch: that endpoint counts
// EDGES (reads and writes, Microsoft components and form placements included),
// so its numbers would not match the hover card's. A batch writer-summary
// endpoint is the promotion-time fix.

import { columnNotInScan, openCountFor, scopeLineFor } from "../card/model";
import { buildXrayEntry, notInScanEntry } from "../card/xray";
import { isTypedNotFound, type ApiResult, type FieldDependents, type FieldWriter, type OpenFindingCounts } from "../pathix/api";
import type { XrayResponse } from "../runtime/messages";
import { mapWithLimit } from "./cache";
import type { Get } from "./connection";

/** Measured against a real Pathix: 40 columns in about 0.55 s, no errors. */
const CONCURRENCY = 4;

/** fieldKey values per open-counts call; the keys ride in the query string. */
export const FINDINGS_BATCH = 50;

export interface XrayContext {
  environmentId: string;
  environmentName: string;
  scanCompletedAt: string | null;
  table: string;
  columns: string[];
  /** The environment's scans leave the table out, so no column on it is in the latest scan. */
  tableExcluded?: boolean;
}

export async function loadXray(context: XrayContext, get: Get, formatDate: (iso: string) => string): Promise<XrayResponse> {
  const env = encodeURIComponent(context.environmentId);
  const table = encodeURIComponent(context.table);
  const columns = [...new Set(context.columns)];
  const fieldQuery = (column: string) => `table=${table}&column=${encodeURIComponent(column)}&environmentId=${env}`;

  const batches = chunk(columns, FINDINGS_BATCH);
  const reads: Array<() => Promise<ApiResult<unknown>>> = [
    ...columns.map((column) => () => get<FieldWriter[]>(`/findings/field-writers?${fieldQuery(column)}`)),
    ...columns.map((column) => () => get<FieldDependents>(`/findings/field-dependents?${fieldQuery(column)}`)),
    ...batches.map((batch) => () => get<OpenFindingCounts>(openCountsPath(context, batch))),
  ];
  const results = (await mapWithLimit(reads, CONCURRENCY, (read) => read())) as ApiResult<unknown>[];

  for (const result of results) {
    if (!result.ok && result.kind === "signedOut") return { kind: "status", status: { kind: "signedOut", reason: "no token" } };
    if (!result.ok && result.kind === "unauthorized") {
      return { kind: "status", status: { kind: "unauthorized", status: result.status } };
    }
  }

  const writers = results.slice(0, columns.length) as Array<ApiResult<FieldWriter[]>>;
  const dependents = results.slice(columns.length, columns.length * 2) as Array<ApiResult<FieldDependents>>;
  const counts = results.slice(columns.length * 2) as Array<ApiResult<OpenFindingCounts>>;

  return {
    kind: "xray",
    model: {
      scopeLine: scopeLineFor(context.environmentName, context.scanCompletedAt, formatDate),
      entries: columns.map((column, index) => {
        const batch = dataOf(counts[Math.floor(index / FINDINGS_BATCH)]!);
        // Pathix refuses a column its scan does not hold with the typed 404. An older Pathix answers
        // [] instead, so the open counts and the excluded tables stay as the fallback: never read that as zero.
        const presence = {
          fieldReadsNotFound: isTypedNotFound(writers[index]!) || isTypedNotFound(dependents[index]!),
          permissionsNotFound: false,
          tableExcluded: context.tableExcluded ?? false,
        };
        if (columnNotInScan(presence, batch, context.table, column)) {
          return notInScanEntry(column);
        }
        return buildXrayEntry(column, dataOf(writers[index]!), dataOf(dependents[index]!), openCountFor(batch, context.table, column));
      }),
    },
  };
}

function dataOf<T>(result: ApiResult<T>): T | null {
  return result.ok ? result.data : null;
}

function openCountsPath(context: XrayContext, columns: string[]): string {
  const keys = columns.map((column) => `fieldKey=${encodeURIComponent(`${context.table}.${column}`)}`).join("&");
  return `/findings/open-counts?environmentId=${encodeURIComponent(context.environmentId)}&${keys}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
