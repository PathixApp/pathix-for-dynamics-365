// Loads everything behind a hover card and builds its model. Every read is
// scoped by the API to the environment's latest Completed scan.

import { buildFieldCard, fieldKey, rowsNeedingRegistration, type FieldCardContext } from "../card/model";
import {
  isTypedNotFound,
  type ApiResult,
  type ComponentDetail,
  type ComponentRegistration,
  type FieldDependents,
  type FieldHistory,
  type FieldPermissions,
  type FieldWriter,
  type OpenFindingCounts,
  type SecurityWritersSummary,
} from "../pathix/api";
import type { ConnectionStatus, FieldCardResponse } from "../runtime/messages";
import { mapWithLimit } from "./cache";
import type { Get } from "./connection";

const TRIGGER_CONCURRENCY = 4;

export async function loadFieldCard(
  context: Omit<FieldCardContext, "formatDate" | "formatDay"> & { tableExcluded?: boolean },
  get: Get,
  formatDate: (iso: string) => string,
  formatDay: (iso: string) => string | null,
): Promise<FieldCardResponse> {
  const env = encodeURIComponent(context.environmentId);
  const table = encodeURIComponent(context.table);
  const column = encodeURIComponent(context.column);
  const fieldQuery = `table=${table}&column=${column}&environmentId=${env}`;

  const findingsKey = encodeURIComponent(fieldKey(context.table, context.column));

  const [writers, dependents, permissions, security, findings] = await Promise.all([
    get<FieldWriter[]>(`/findings/field-writers?${fieldQuery}`),
    get<FieldDependents>(`/findings/field-dependents?${fieldQuery}`),
    get<FieldPermissions>(`/findings/field-permissions?${fieldQuery}`),
    get<SecurityWritersSummary>(`/findings/security-writers?table=${table}&environmentId=${env}`),
    get<OpenFindingCounts>(`/findings/open-counts?environmentId=${env}&fieldKey=${findingsKey}`),
  ]);

  // A sign-in problem applies to every section, so it replaces the card.
  const blocked = signInProblem([writers, dependents, permissions, security, findings]);
  if (blocked) return blocked;

  // A failed or refused history read leaves the card whole and the line
  // "unknown", so it is not part of the sign-in check above.
  const { history, registrations } = await loadHistoryAndTriggers(writers.ok ? writers.data : null, get, fieldQuery, env);
  return {
    kind: "card",
    card: buildFieldCard(
      { ...context, formatDate, formatDay },
      {
        writers: dataOf(writers),
        dependents: dataOf(dependents),
        permissions: dataOf(permissions),
        security: dataOf(security),
        findings: dataOf(findings),
        history: dataOf(history),
        registrations,
        scanPresence: {
          fieldReadsNotFound: isTypedNotFound(writers) || isTypedNotFound(dependents),
          permissionsNotFound: isTypedNotFound(permissions),
          tableExcluded: context.tableExcluded ?? false,
        },
      },
    ),
  };
}

/**
 * The column's history and, for the listed plugin steps (their images are
 * served only on the registration) and for rows from an older Pathix that
 * does not put triggers on the writers row, their registration, under the one
 * limit on concurrent reads. A failed registration lookup shows the step's
 * images as unknown and an old row with no trigger; a failed history read shows
 * "unknown".
 */
async function loadHistoryAndTriggers(
  writers: FieldWriter[] | null,
  get: Get,
  fieldQuery: string,
  env: string,
): Promise<{ history: ApiResult<FieldHistory>; registrations: Map<string, ComponentRegistration | null> }> {
  const ids = writers ? rowsNeedingRegistration(writers).map((writer) => writer.componentId) : [];
  const tasks: Array<() => Promise<ApiResult<unknown>>> = [
    () => get<FieldHistory>(`/changes/field?${fieldQuery}`),
    ...ids.map((id) => () => get<ComponentDetail>(`/components/${encodeURIComponent(id)}?environmentId=${env}`)),
  ];
  const [history, ...details] = await mapWithLimit(tasks, TRIGGER_CONCURRENCY, (task) => task());
  return {
    history: history as ApiResult<FieldHistory>,
    registrations: new Map(
      ids.map((id, index) => [id, dataOf(details[index] as ApiResult<ComponentDetail>)?.registration ?? null]),
    ),
  };
}

/** A sign-in problem applies to every section of an answer, so it replaces the answer. */
export function signInProblem(results: Array<ApiResult<unknown>>): { kind: "status"; status: ConnectionStatus } | null {
  for (const result of results) {
    if (!result.ok && result.kind === "signedOut") return { kind: "status", status: { kind: "signedOut", reason: "no token" } };
    if (!result.ok && result.kind === "unauthorized") {
      return { kind: "status", status: { kind: "unauthorized", status: result.status } };
    }
  }
  return null;
}

function dataOf<T>(result: ApiResult<T>): T | null {
  return result.ok ? result.data : null;
}
