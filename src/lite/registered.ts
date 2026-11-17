// Lite's "Registered to fire when this changes" card: reads the open table's
// plugin step registrations, the publishers of their owning solutions,
// classic workflows and business rules. Runs in the content script; every
// read goes through the Dataverse client and its allowlist.

import { mapWithLimit } from "../background/cache";
import {
  buildRegisteredCard,
  editedColumns,
  isMicrosoftPublisher,
  MAX_EDITED_COLUMNS,
  type ProcessDependents,
  type PublisherInfo,
  type RegisteredCardModel,
  type RegisteredContext,
  type TableRegistrations,
} from "../card/registered";
import type { DataverseGet } from "../dataverse/client";
import {
  retrievePluginStepsForAllTables,
  retrievePluginStepsForTable,
  retrieveProcessesForTable,
  retrievePublishers,
  retrieveSolutionPublishers,
} from "../dataverse/queries";
import { loadDependents } from "./dependencies";
import { collection, settle } from "./read";
import { limitTo, loadReadVisibility } from "./visibility";

const PROCESS_COMPONENT_TYPE = 29;
/** The unique name of the solution that holds a component's unmanaged top layer. */
const ACTIVE_SOLUTION = "active";
const ACTIVE_LAYER: PublisherInfo = { name: "Active layer", microsoft: false, activeLayer: true };
const DEPENDENTS_CONCURRENCY = 4;

export async function loadRegisteredCard(get: DataverseGet, context: RegisteredContext): Promise<RegisteredCardModel> {
  const registrations = await loadTableRegistrations(get, context.table);
  // The same edited columns the card checks, so every one it asks about was read.
  const columns = [context.column, ...editedColumns(context.dirtyColumns).slice(0, MAX_EDITED_COLUMNS)];
  const dependents = needsBusinessRules(registrations) ? await loadProcessDependents(get, context.table, columns) : new Map();
  return buildRegisteredCard(context, registrations, dependents);
}

export async function loadTableRegistrations(get: DataverseGet, table: string): Promise<TableRegistrations> {
  // Steps are owned by the organization, so every user who can read them sees
  // them all. Processes are owned by users: below Organization depth the list
  // holds only the ones the user can see (src/lite/visibility.ts).
  const [steps, allTables, readProcesses, visibility] = await Promise.all([
    collection(() => retrievePluginStepsForTable(get, table)),
    collection(() => retrievePluginStepsForAllTables(get)),
    collection(() => retrieveProcessesForTable(get, table)),
    loadReadVisibility(get),
  ]);
  const processes = limitTo(readProcesses, visibility.workflows);
  const read = [steps, allTables].flatMap((answer) => (answer.kind === "ok" ? answer.value : []));
  const anyRead = steps.kind === "ok" || allTables.kind === "ok";
  const publishers = anyRead ? await loadPublishers(get, read.map((step) => step.solutionid)) : null;
  return { steps, allTables, publishers, processes };
}

/**
 * Publisher by solution id. Any read failing means null: the card then sets
 * nothing apart rather than guess (DESIGN.md, "Authorship comes from the
 * publisher").
 *
 * A step's solutionid is its top layer. A step created or customized in this
 * environment sits in the Active solution, whose publisher is the default
 * publisher whoever wrote the step: a customized Microsoft step lands there
 * too. Finding the step's base layer takes a read per step (component
 * layers), so Lite does not name a publisher for the Active layer and never
 * folds it.
 */
export async function loadPublishers(get: DataverseGet, solutionIds: Array<string | null>): Promise<Map<string, PublisherInfo> | null> {
  const ids = [...new Set(solutionIds.filter((id): id is string => !!id).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const solutions = await settle(() => retrieveSolutionPublishers(get, ids));
  if (!solutions?.ok) return null;
  const publisherIds = [...new Set(solutions.data.map((row) => row._publisherid_value?.toLowerCase()).filter((id): id is string => !!id))];
  const publishers = publisherIds.length > 0 ? await settle(() => retrievePublishers(get, publisherIds)) : { ok: true as const, data: [] };
  if (!publishers?.ok) return null;

  const byId = new Map(
    publishers.data.map((row) => [
      row.publisherid.toLowerCase(),
      {
        name: row.friendlyname?.trim() || row.uniquename?.trim() || "Unnamed publisher",
        microsoft: isMicrosoftPublisher(row.uniquename),
      },
    ]),
  );
  const result = new Map<string, PublisherInfo>();
  for (const solution of solutions.data) {
    if (solution.uniquename?.trim().toLowerCase() === ACTIVE_SOLUTION) {
      result.set(solution.solutionid.toLowerCase(), ACTIVE_LAYER);
      continue;
    }
    const publisher = solution._publisherid_value ? byId.get(solution._publisherid_value.toLowerCase()) : undefined;
    if (publisher) result.set(solution.solutionid.toLowerCase(), publisher);
  }
  return result;
}

/** Business rules need dependency tracking only when the table has an active one. */
function needsBusinessRules(registrations: TableRegistrations): boolean {
  return registrations.processes.kind === "ok" && registrations.processes.value.some((row) => row.category === 2 && row.statecode === 1);
}

/** Process ids Dataverse tracks as depending on each column; null for a column it could not read. */
export async function loadProcessDependents(get: DataverseGet, table: string, columns: string[]): Promise<ProcessDependents> {
  const result = new Map<string, ReadonlySet<string> | null>();
  await mapWithLimit([...new Set(columns)], DEPENDENTS_CONCURRENCY, async (column) => {
    const answer = await loadDependents(get, table, column);
    result.set(
      column,
      answer.kind === "ok" && answer.complete
        ? new Set(
            answer.rows
              .filter((row) => row.dependentcomponenttype === PROCESS_COMPONENT_TYPE)
              .map((row) => row.dependentcomponentobjectid.toLowerCase()),
          )
        : null,
    );
  });
  return result;
}
