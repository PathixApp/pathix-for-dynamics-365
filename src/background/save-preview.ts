// Loads what Pathix says is registered to fire when one record is saved (M12,
// connected). One request per preview: GET /tables/{table}/save-pipeline,
// through the same response cache as the cards, scoped to the environment's
// latest Completed scan.
//
// A save preview depends on the set of columns the save sends, so the column
// names are part of the cache key: they are sorted, lower case and distinct,
// and the same set always asks for the same path. On Create the platform
// ignores columns, so none are sent and every create shares one key.
//
// Names only go out: the table, Create or Update, the form's definition id and
// column logical names. Never a value, never the record id.

import { buildSavePreview, MAX_COLUMN_CHARS, type SavePreviewAnswer, type SavePreviewContext } from "../card/save-preview";
import type { SavePipeline } from "../pathix/api";
import type { SavePreviewResponse } from "../runtime/messages";
import type { Get } from "./connection";
import { signInProblem } from "./field-card";

export interface SavePreviewLoad extends Omit<SavePreviewContext, "columnsSent" | "columnsWithheld" | "formRequested"> {
  environmentId: string;
  /** Column names for an Update, in any order. Ignored on Create. */
  columns: string[];
  formId: string | null;
}

/** The request path. Update with no columns, or with too many to send, asks for everything registered. */
export function savePipelinePath(load: Pick<SavePreviewLoad, "environmentId" | "table" | "message" | "columns" | "formId">): {
  path: string;
  columnsSent: string[];
  columnsWithheld: number;
} {
  const wanted = load.message === "Update" ? [...new Set(load.columns.map((column) => column.toLowerCase()))].sort() : [];
  const tooMany = wanted.join(",").length > MAX_COLUMN_CHARS;
  const columnsSent = tooMany ? [] : wanted;

  const query = new URLSearchParams({ environmentId: load.environmentId, message: load.message });
  if (columnsSent.length > 0) query.set("columns", columnsSent.join(","));
  if (load.formId) query.set("formId", load.formId);
  return {
    path: `/tables/${encodeURIComponent(load.table)}/save-pipeline?${query.toString()}`,
    columnsSent,
    columnsWithheld: tooMany ? wanted.length : 0,
  };
}

export async function loadSavePreview(load: SavePreviewLoad, get: Get): Promise<SavePreviewResponse> {
  const { path, columnsSent, columnsWithheld } = savePipelinePath(load);
  const result = await get<SavePipeline>(path);

  const blocked = signInProblem([result]);
  if (blocked) return blocked;

  const context: SavePreviewContext = {
    environmentName: load.environmentName,
    scanCompletedAt: load.scanCompletedAt,
    table: load.table,
    message: load.message,
    columnsSent,
    columnsWithheld,
    formRequested: load.formId !== null,
    formatDate: load.formatDate,
  };
  // A failed read is an unknown pipeline, never an empty one.
  // The 404 body is kept: Pathix's typed 404 (the scan does not hold the table)
  // carries one, and a route miss (an older Pathix) does not.
  const answer: SavePreviewAnswer = result.ok
    ? { kind: "ok", data: result.data }
    : result.kind === "failed"
      ? { kind: "failed", ...(result.status === undefined ? {} : { status: result.status }), ...(result.detail === undefined ? {} : { detail: result.detail }) }
      : { kind: "failed" };
  return { kind: "savePreview", model: buildSavePreview(context, answer) };
}
