// Loads what Pathix's scans found changed on one table (M11, connected). The
// read is GET /changes for the environment, filtered to the table, over the
// default window (the last 30 days). It goes through the same response cache
// as the cards, scoped to the environment's latest Completed scan.
//
// It asks Pathix to leave out the rows from a Pathix update
// (includePathixChanges=false), so the count and the rows are
// the org's own changes. An older Pathix ignores the parameter and has no such
// rows to leave out.

import { buildLedgerChanges, type LedgerContext } from "../card/what-changed";
import type { EnvironmentChanges } from "../pathix/api";
import type { TableChangesResponse } from "../runtime/messages";
import type { Get } from "./connection";
import { signInProblem } from "./field-card";

export async function loadTableChanges(context: LedgerContext, get: Get): Promise<TableChangesResponse> {
  const query = new URLSearchParams({ environmentId: context.environmentId, table: context.table, includePathixChanges: "false" });
  const changes = await get<EnvironmentChanges>(`/changes?${query.toString()}`);

  const blocked = signInProblem([changes]);
  if (blocked) return blocked;
  // A failed read is an unknown ledger, never an empty one.
  return { kind: "changes", model: buildLedgerChanges(context, changes.ok ? changes.data : null) };
}
