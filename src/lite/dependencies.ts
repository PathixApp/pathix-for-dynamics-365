// Lite's platform dependencies card: what Dataverse's own dependency tracking
// says depends on a column, by type and name. Runs in the content script; every
// read goes through the Dataverse client and its allowlist.

import { mapWithLimit } from "../background/cache";
import {
  buildDependenciesCard,
  distinctDependents,
  type DependentsAnswer,
  type LiteCardContext,
  type LiteCardModel,
  type ResolvedName,
} from "../card/lite";
import type { DataverseGet, DataverseResult } from "../dataverse/client";
import {
  retrieveAttributeMetadataId,
  retrieveAttributeName,
  retrieveChartNames,
  retrieveDependentComponents,
  retrieveFormNames,
  retrievePluginStepNames,
  retrieveProcessNames,
  retrieveRelationshipName,
  retrieveStepImageNames,
  retrieveViewNames,
  type DependentComponent,
} from "../dataverse/queries";

/** Columns and relationships are looked up one by one; past this many, they show unnamed. */
export const MAX_SINGLE_LOOKUPS = 20;
const SINGLE_LOOKUP_CONCURRENCY = 4;
const NULL_GUID = "00000000-0000-0000-0000-000000000000";

export async function loadDependenciesCard(get: DataverseGet, context: LiteCardContext): Promise<LiteCardModel> {
  const dependents = await loadDependents(get, context.table, context.column);
  const names = dependents.kind === "ok" ? await loadDependencyNames(get, dependents.rows) : new Map<string, ResolvedName>();
  return buildDependenciesCard(context, dependents, names);
}

export async function loadDependents(get: DataverseGet, table: string, column: string): Promise<DependentsAnswer> {
  try {
    const attribute = await retrieveAttributeMetadataId(get, table, column);
    if (!attribute.ok) return failure(attribute);
    const dependents = await retrieveDependentComponents(get, attribute.data.MetadataId.toLowerCase());
    if (!dependents.ok) return failure(dependents);
    return { kind: "ok", rows: dependents.data.value, complete: !dependents.data["@odata.nextLink"] };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Names by component id. A lookup that fails leaves its components unnamed:
 * the card still counts them and says some names could not be read.
 */
export async function loadDependencyNames(get: DataverseGet, rows: DependentComponent[]): Promise<Map<string, ResolvedName>> {
  const distinct = distinctDependents(rows);
  const idsOf = (type: number) => distinct.filter((row) => row.dependentcomponenttype === type).map((row) => row.dependentcomponentobjectid.toLowerCase());
  const names = new Map<string, ResolvedName>();
  const add = (id: string, name: string | null | undefined, category?: number | null) => {
    if (name) names.set(id.toLowerCase(), category === undefined ? { name } : { name, category });
  };

  const batched = async <T>(type: number, read: (ids: string[]) => Promise<DataverseResult<T[]>>, use: (row: T) => void) => {
    const ids = idsOf(type);
    if (ids.length === 0) return;
    const result = await settle(() => read(ids));
    if (result?.ok) result.data.forEach(use);
  };

  await Promise.all([
    batched(60, (ids) => retrieveFormNames(get, ids), (row) => add(row.formid, row.name)),
    batched(26, (ids) => retrieveViewNames(get, ids), (row) => add(row.savedqueryid, row.name)),
    batched(59, (ids) => retrieveChartNames(get, ids), (row) => add(row.savedqueryvisualizationid, row.name)),
    batched(29, (ids) => retrieveProcessNames(get, ids), (row) => add(row.workflowid, row.name, row.category)),
    batched(92, (ids) => retrievePluginStepNames(get, ids), (row) => add(row.sdkmessageprocessingstepid, row.name)),
    loadStepImageNames(get, idsOf(93), add),
    loadRelationshipNames(get, idsOf(10), add),
    loadAttributeNames(get, distinct.filter((row) => row.dependentcomponenttype === 2), add),
  ]);
  return names;
}

/**
 * A step image's name is often empty in real orgs. Fall back to its entity
 * alias, then to its parent step's name ("Image of <step>").
 */
async function loadStepImageNames(get: DataverseGet, ids: string[], add: (id: string, name: string | null) => void): Promise<void> {
  if (ids.length === 0) return;
  const images = await settle(() => retrieveStepImageNames(get, ids));
  if (!images?.ok) return;
  const needParent = images.data.filter((row) => !row.name?.trim() && !row.entityalias?.trim() && row._sdkmessageprocessingstepid_value);
  const parentIds = needParent.map((row) => row._sdkmessageprocessingstepid_value!.toLowerCase());
  const parents = parentIds.length > 0 ? await settle(() => retrievePluginStepNames(get, parentIds)) : null;
  const stepNames = new Map(parents?.ok ? parents.data.map((row) => [row.sdkmessageprocessingstepid.toLowerCase(), row.name?.trim()]) : []);
  for (const row of images.data) {
    const parent = row._sdkmessageprocessingstepid_value ? stepNames.get(row._sdkmessageprocessingstepid_value.toLowerCase()) : undefined;
    add(row.sdkmessageprocessingstepimageid, row.name?.trim() || row.entityalias?.trim() || (parent ? `Image of ${parent}` : null));
  }
}

async function loadRelationshipNames(get: DataverseGet, ids: string[], add: (id: string, name: string | null) => void): Promise<void> {
  await mapWithLimit(ids.slice(0, MAX_SINGLE_LOOKUPS), SINGLE_LOOKUP_CONCURRENCY, async (id) => {
    const result = await settle(() => retrieveRelationshipName(get, id));
    if (result?.ok) add(id, result.data.SchemaName);
  });
}

// A column that depends on this one (a calculated, rollup or formula column)
// is named table.column; its parent id is its table's MetadataId.
async function loadAttributeNames(get: DataverseGet, rows: DependentComponent[], add: (id: string, name: string | null) => void): Promise<void> {
  const lookups = rows.filter((row) => row.dependentcomponentparentid && row.dependentcomponentparentid !== NULL_GUID);
  await mapWithLimit(lookups.slice(0, MAX_SINGLE_LOOKUPS), SINGLE_LOOKUP_CONCURRENCY, async (row) => {
    const result = await settle(() =>
      retrieveAttributeName(get, row.dependentcomponentparentid.toLowerCase(), row.dependentcomponentobjectid.toLowerCase()),
    );
    if (!result?.ok || !result.data.LogicalName) return;
    const { EntityLogicalName: table, LogicalName: column } = result.data;
    add(row.dependentcomponentobjectid, table ? `${table}.${column}` : column);
  });
}

function failure(result: Extract<DataverseResult<unknown>, { ok: false }>): DependentsAnswer {
  if (result.kind === "forbidden") return { kind: "forbidden" };
  return result.timedOut ? { kind: "failed", timedOut: true } : { kind: "failed" };
}

/** A lookup that throws (a refused path, a malformed id) counts as a failed one. */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
