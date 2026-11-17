// Loads a form's script handlers from Pathix and builds the event map (M10,
// connected). The read is GET /environments/{id}/forms/{formId}/handlers,
// keyed by the systemform id the page already reports, on the environment's
// latest Completed scan. It goes through the same response cache as the cards,
// scoped to that scan.

import { buildConnectedEventMap, type ConnectedEventMapContext, type FormHandlersRead } from "../card/event-map";
import { isRouteMiss, isTypedNotFound, type FormHandlers } from "../pathix/api";
import type { EventMapResponse } from "../runtime/messages";
import type { Get } from "./connection";
import { signInProblem } from "./field-card";

export interface EventMapLoadContext extends ConnectedEventMapContext {
  environmentId: string;
}

export async function loadFormEventMap(context: EventMapLoadContext, get: Get): Promise<EventMapResponse> {
  const path = `/environments/${encodeURIComponent(context.environmentId)}/forms/${encodeURIComponent(context.formId)}/handlers`;
  const answer = await get<FormHandlers>(path);

  const blocked = signInProblem([answer]);
  if (blocked) return blocked;

  // This route's only 404 is Pathix's typed NotFound<string> ("no such form in
  // the latest scan"), which carries a non-empty JSON string body. A route miss
  // (a Pathix with no such route) answers with an empty body and says nothing
  // about the scan. The message wording is never compared. No failure is ever
  // an empty map.
  let read: FormHandlersRead;
  if (answer.ok) read = { kind: "ok", data: answer.data };
  else if (isTypedNotFound(answer)) read = { kind: "notInScan" };
  else if (isRouteMiss(answer)) read = { kind: "noEndpoint" };
  else read = { kind: "failed" };
  return { kind: "eventMap", model: buildConnectedEventMap(context, read) };
}
