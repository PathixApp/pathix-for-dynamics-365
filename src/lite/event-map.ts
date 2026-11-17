// Lite's form event map: reads the open form's definition and builds the map.
// It reuses the one form definition query the "Why can't I edit this field?"
// checklist already makes, so it adds no request of its own. Runs in the
// content script; the read goes through the Dataverse client and its allowlist.

import { buildEventMap, type EventMapContext, type EventMapModel } from "../card/event-map";
import type { DataverseGet } from "../dataverse/client";
import { retrieveFormDefinition } from "../dataverse/queries";
import { single } from "./read";

export async function loadEventMap(get: DataverseGet, context: EventMapContext): Promise<EventMapModel> {
  const formId = context.formId;
  return buildEventMap(context, formId ? await single(() => retrieveFormDefinition(get, formId)) : null);
}
