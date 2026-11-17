// What changed on the open table (M11). Lite reads the table's components and
// when each was last modified; connected mode reads the same dates
// live, for the components Pathix already knows, to compare with its scan.
// Runs in the content script; every read goes through the Dataverse client
// and its allowlist.

import { mapWithLimit } from "../background/cache";
import { keyOf, liveSourceFor, type LiveModified, type LiveRef, type LiveSource } from "../card/freshness";
import { buildLiteChanges, type LiteChangesContext, type WhatChangedModel } from "../card/what-changed";
import type { DataverseGet } from "../dataverse/client";
import {
  retrieveFormsForTable,
  retrieveModifiedOn,
  retrievePluginStepsForAllTables,
  retrievePluginStepsForTable,
  retrieveProcessesForTable,
} from "../dataverse/queries";
import { collection, settle } from "./read";
import { limitTo, loadReadVisibility } from "./visibility";

/** Reads in flight at once: three, out of up to five entity sets (steps, workflows, forms, views, charts). */
const LIVE_CONCURRENCY = 3;

export async function loadLiteChanges(get: DataverseGet, context: LiteChangesContext): Promise<WhatChangedModel> {
  // The step and process reads are the ones the registered card already makes,
  // the steps registered for every table included, so within the client's
  // cache window they are one request, not two.
  // Processes are owned by users, so the list may hold only the ones the user can see (src/lite/visibility.ts).
  const [steps, allTablesSteps, processes, forms, visibility] = await Promise.all([
    collection(() => retrievePluginStepsForTable(get, context.table)),
    collection(() => retrievePluginStepsForAllTables(get)),
    collection(() => retrieveProcessesForTable(get, context.table)),
    collection(() => retrieveFormsForTable(get, context.table)),
    loadReadVisibility(get),
  ]);
  return buildLiteChanges(context, { steps, allTablesSteps, processes: limitTo(processes, visibility.workflows), forms });
}

/**
 * The live change date of components Pathix knows (modifiedon, or publishedon for a form), by liveKey. A kind of
 * component whose read failed, was refused or came back in part is left out
 * of the answer, so its components are unknown and never unchanged. A
 * component the read did not return is left out too.
 */
export async function loadLiveModified(get: DataverseGet, refs: LiveRef[]): Promise<LiveModified> {
  const bySource = new Map<string, { source: LiveSource; ids: Set<string> }>();
  for (const ref of refs) {
    const source = liveSourceFor(ref.componentType);
    if (!source) continue;
    const held = bySource.get(source.entitySet) ?? { source, ids: new Set<string>() };
    held.ids.add(ref.id.toLowerCase());
    bySource.set(source.entitySet, held);
  }

  const answer = new Map<string, string | null>();
  await mapWithLimit([...bySource.values()], LIVE_CONCURRENCY, async ({ source, ids }) => {
    const result = await settle(() => retrieveModifiedOn(get, source, [...ids]));
    if (!result?.ok) return;
    for (const row of result.data) {
      const id = row[source.idColumn];
      if (typeof id === "string") answer.set(keyOf(source.entitySet, id), typeof row[source.changeColumn] === "string" ? row[source.changeColumn]! : null);
    }
  });
  return answer;
}
