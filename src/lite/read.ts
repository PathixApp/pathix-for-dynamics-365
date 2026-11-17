// Turns Dataverse client results into the answers cards build from. A read
// that throws (a refused path, a malformed name) counts as a failed one, and
// a refused read stays apart from a failed one (DESIGN.md, "Absence is not
// evidence").

import type { Answer } from "../card/registered";
import type { Single } from "../card/locked";
import type { DataverseResult } from "../dataverse/client";
import type { ODataCollection } from "../dataverse/queries";

/** A collection. The client follows its pages; a page it could not read leaves the answer incomplete. */
export async function collection<T>(read: () => Promise<DataverseResult<ODataCollection<T>>>): Promise<Answer<T[]>> {
  const result = await settle(read);
  if (!result?.ok) return refusedOrFailed(result);
  return { kind: "ok", value: result.data.value, complete: !result.data["@odata.nextLink"] };
}

/** One answer. */
export async function single<T>(read: () => Promise<DataverseResult<T>>): Promise<Single<T>> {
  const result = await settle(read);
  if (!result?.ok) return refusedOrFailed(result);
  return { kind: "ok", value: result.data };
}

export async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function refusedOrFailed(result: Extract<DataverseResult<unknown>, { ok: false }> | null): { kind: "forbidden" } | { kind: "failed"; timedOut?: true } {
  if (result?.kind === "forbidden") return { kind: "forbidden" };
  return result?.timedOut ? { kind: "failed", timedOut: true } : { kind: "failed" };
}
