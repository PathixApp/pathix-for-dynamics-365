// The form event map, as plain data, tested without a DOM (M10).
//
// It lists every handler the open form's definition registers: the event
// (OnLoad, OnSave, OnChange per column, a tab's events, a control's events),
// the library, the function and whether the handler is enabled. Handlers the
// platform loads itself (InternalHandlers) are tagged, not hidden. The list
// comes from the form definition only. A handler that script adds at run
// time is not in the definition, and the map says so.
//
// Lite reads the definition from Dataverse. A form whose definition could not
// be read is unknown, never "no handlers". "No handlers" is said only when
// the read succeeded and was complete (DESIGN.md, "Absence is not evidence").
// Lite counts in platform terms and never says "writers".
//
// Connected mode fills the same panel from Pathix's latest Completed scan:
// GET /environments/{id}/forms/{formId}/handlers, keyed by the form id the
// page already reports. It adds no read of the page. The same rule holds, with
// Pathix's own ways of not knowing:
//
// - coverage "notModeled" is unknown, with its reason in words, never "no
//   handlers" (its handlers are null, not an empty list);
// - Pathix's typed 404 is "this form is not in Pathix's latest scan"; any other 404 is "unknown";
// - a failed request is unknown;
// - ordered false means the scan did not record the handlers' order, so the
//   rows are never numbered or described as a run order;
// - a handler whose enabled flag the form did not state is "enabled not
//   stated", never assumed on.

import type { FormDefinition } from "../dataverse/queries";
import type { FormHandler as PathixHandler, FormHandlers } from "../pathix/api";
import { LIVE_FROM_DATAVERSE, PATHIX_SITE, type TipLine } from "./lite";
import { parseFormXml, type FormHandler, type HandlerScope } from "./locked";
import type { Single } from "./locked";

export const EVENT_MAP_TITLE = "Form event map";

export const EVENT_MAP_TIP: TipLine = {
  text: "A form definition can't show what a handler does. Pathix reads script code to show which columns it writes.",
  linkText: "Pathix",
  href: PATHIX_SITE,
};

export interface EventMapRow {
  functionName: string;
  library: string;
  /** false: disabled. null (connected only): the form did not state it, so the handler is not known to be on. */
  enabled: boolean | null;
  /** Declared under InternalHandlers: the platform's own form logic. */
  internal: boolean;
  /** Connected only, when the scan recorded the order and the event lists two or more: 1-based, within the event's list. */
  position?: number;
}

/** The handlers of one event on one target, in the order the form lists them. */
export interface EventMapGroup {
  /** "OnLoad", "OnChange: creditlimit", "Tab SUMMARY_TAB: TabStateChange". */
  title: string;
  rows: EventMapRow[];
}

export interface EventMapModel {
  /** Lite reads the definition from Dataverse; connected shows Pathix's latest Completed scan. */
  mode: "lite" | "connected";
  /** "known" when the definition was read in full; "unknown" otherwise. */
  kind: "known" | "unknown";
  table: string;
  formName: string | null;
  /**
   * Set when the form id was read from the page's field labels, because the
   * page did not report one: which form the map describes is then the labels'
   * word, and the subtitle says so (src/content/label-form-id.ts).
   */
  formSource?: string | null;
  /** "Live from Dataverse" in Lite; "As of <scan date>" when connected. */
  status: string;
  headline: string;
  /** Connected: set when the scan did not record the handlers' order. The rows are then not a sequence. */
  orderNote: string | null;
  groups: EventMapGroup[];
  /** Behind the "?". */
  info: string[];
  /** null when tips are off, by the user or by policy, and always in connected mode. */
  tip: TipLine | null;
}

export interface EventMapContext {
  table: string;
  formId: string | null;
  showTips: boolean;
}

/**
 * What the form definition read answered: the rows, or why there are none.
 * The query fails as a whole when a page of rows is left over, so rows that
 * come back are every row. Null: the page did not say which form is open.
 */
export type FormRead = Single<FormDefinition[]> | null;

const EVENT_LABELS: Record<string, string> = {
  onload: "OnLoad",
  onsave: "OnSave",
  onchange: "OnChange",
  tabstatechange: "TabStateChange",
  onreadystatecomplete: "OnReadyStateComplete",
  presearch: "PreSearch",
  setadditionalparams: "SetAdditionalParams",
};

// --- Lite ------------------------------------------------------------------------------

const LITE_INFO: string[] = [
  "Read live from Dataverse with your own access, from the open form's definition.",
  "It lists the handlers the definition registers: the event, the library and the function.",
  "A handler that a script adds at run time, for example with addOnChange, is not in the definition and is not listed.",
  "Handlers tagged internal are loaded by the platform. They are shown, not hidden.",
  "Lite cannot read what a function does.",
];

export function buildEventMap(context: EventMapContext, read: FormRead): EventMapModel {
  const unknown = (headline: string, formName: string | null = null): EventMapModel => ({
    mode: "lite",
    kind: "unknown",
    table: context.table,
    formName,
    status: LIVE_FROM_DATAVERSE,
    headline,
    orderNote: null,
    groups: [],
    info: LITE_INFO,
    tip: context.showTips ? EVENT_MAP_TIP : null,
  });

  if (read === null) return unknown("The page did not say which form is open, so Lite could not read its handlers.");
  if (read.kind === "forbidden") return unknown("You don't have access to form definitions.");
  if (read.kind !== "ok") return unknown("Could not read this form's definition.");
  const form = read.value[0];
  if (read.value.length !== 1 || !form) return unknown("Could not read this form's definition in full.");
  if (!form.formxml) return unknown("This form's definition came back with no content to read.", form.name ?? null);

  const parsed = parseFormXml(form.formxml);
  if (!parsed.complete) return unknown("Could not read this form's definition in full.", form.name ?? null);

  return {
    mode: "lite",
    kind: "known",
    table: context.table,
    formName: form.name ?? null,
    status: LIVE_FROM_DATAVERSE,
    headline: headlineFor(parsed.allHandlers),
    orderNote: null,
    groups: groupHandlers(parsed.allHandlers.map(placeLite)),
    info: LITE_INFO,
    tip: context.showTips ? EVENT_MAP_TIP : null,
  };
}

export function headlineFor(handlers: readonly FormHandler[]): string {
  if (handlers.length === 0) return "This form's definition registers no handlers.";
  const disabled = handlers.filter((handler) => !handler.enabled).length;
  const internal = handlers.filter((handler) => handler.internal).length;
  const noun = handlers.length === 1 ? "1 handler is" : `${handlers.length} handlers are`;
  const parts = [disabled > 0 ? `${disabled} disabled` : "", internal > 0 ? `${internal} loaded by the platform` : ""].filter(Boolean);
  return `${noun} registered on this form${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

/** The subtitle's note when the form id came from the field labels, not from the page. */
export const FORM_FROM_LABELS = "Form read from the page's field labels";

// --- Connected -------------------------------------------------------------------------

export interface ConnectedEventMapContext {
  table: string;
  /**
   * The systemform id: the one the page reported, or, when it reported none,
   * one read from the page's field labels (src/content/label-form-id.ts), so
   * it can be another form's. Pathix's answer names the form and its table
   * on the scan: the name goes in the subtitle, and an answer for another
   * table is refused.
   */
  formId: string;
  /** The environment's latest Completed scan, for the status when the answer carries no date. */
  scanCompletedAt: string | null;
  formatDate: (iso: string) => string;
}

/**
 * What Pathix answered for the form's handlers. "notInScan" is its typed 404
 * (a 404 with a message body): the form is not in the environment's latest
 * Completed scan. "noEndpoint" is any 404 without one, which says nothing about the scan (a Pathix older than the
 * handlers list has no such route).
 */
export type FormHandlersRead = { kind: "ok"; data: FormHandlers } | { kind: "notInScan" } | { kind: "noEndpoint" } | { kind: "failed" };

export const FORM_NOT_IN_SCAN = "This form is not in Pathix's latest scan, so Pathix cannot list its handlers.";
export const HANDLERS_UNSUPPORTED =
  "Pathix did not recognize the request for this form's handlers, so it may be older than the form event map. Whether the form is in its scan is unknown.";
export const HANDLERS_FAILED = "Could not read this form's handlers from Pathix.";
export const HANDLERS_UNREADABLE = "Could not read Pathix's answer about this form's handlers.";
export const FORM_OTHER_TABLE = "Pathix answered for a form on another table, so its handlers are not shown. Which handlers this form registers is unknown.";
export const FORM_NOT_PARSED = "Pathix could not read this form's definition in its latest scan, so it cannot list the form's handlers.";
export const HANDLERS_NOT_RECORDED =
  "Pathix's latest scan holds no handler data for any form, so it cannot list this form's. The scan may predate handler capture.";
export const NOT_MODELED_UNKNOWN = "Pathix cannot say what this form registers.";
export const ORDER_NOT_RECORDED =
  "Pathix did not record the order of these handlers in its latest scan. Under each event they are sorted by library and function, not in the order the form lists them. A later scan records the order.";

const CONNECTED_INFO: string[] = [
  "From Pathix's latest completed scan, which read this form's definition. It is as of the scan date, not live: a form saved since can differ.",
  "It lists the handlers the definition registers: the event, the library and the function.",
  "A handler that a script adds at run time, for example with addOnChange, is not in the definition and is not listed.",
  "Handlers tagged internal are loaded by the platform. They are shown, not hidden.",
  "A handler tagged enabled not stated has no enabled flag in the definition. Pathix does not assume it is on.",
  "When Pathix cannot say what a form registers, the map says so. It never reads that as a form with no handlers.",
  "What a script writes is on the column cards, not here.",
];

const ORDERED_INFO = "Handlers are numbered in the order the form's definition lists them.";
const UNSUPPORTED_INFO = "Update Pathix to a version that lists form handlers, then open the map again.";

export function buildConnectedEventMap(context: ConnectedEventMapContext, read: FormHandlersRead): EventMapModel {
  const at = read.kind === "ok" && typeof read.data?.scope?.scannedAt === "string" && read.data.scope.scannedAt ? read.data.scope.scannedAt : context.scanCompletedAt;
  const status = at && !Number.isNaN(Date.parse(at)) ? `As of ${context.formatDate(at)}` : "As of the latest completed scan";
  const unknown = (headline: string, extraInfo: string[] = [], formName: string | null = null): EventMapModel => ({
    mode: "connected",
    kind: "unknown",
    table: context.table,
    formName,
    status,
    headline,
    orderNote: null,
    groups: [],
    info: [...CONNECTED_INFO, ...extraInfo],
    tip: null,
  });

  if (read.kind === "notInScan") return unknown(FORM_NOT_IN_SCAN);
  if (read.kind === "noEndpoint") return unknown(HANDLERS_UNSUPPORTED, [UNSUPPORTED_INFO]);
  if (read.kind === "failed") return unknown(HANDLERS_FAILED);

  // An answer that is not the shape the contract promises is no answer.
  const data = read.data;
  if (!isFormHandlers(data) || data.formId.toLowerCase() !== context.formId.toLowerCase()) return unknown(HANDLERS_UNREADABLE);
  // The form id may have come from the field labels and be another form's.
  // An older Pathix sends no table, and its answer is taken as it was before.
  if (typeof data.table === "string" && data.table.toLowerCase() !== context.table.toLowerCase()) return unknown(FORM_OTHER_TABLE);
  const formName = typeof data.formName === "string" && data.formName.trim() !== "" ? data.formName.trim() : null;
  if (data.coverage === "notModeled") return unknown(notModeledHeadline(data.notModeledReason), [], formName);
  if (data.coverage !== "modeled" || !Array.isArray(data.handlers)) return unknown(HANDLERS_UNREADABLE, [], formName);

  const handlers = data.handlers;
  // Trust the order only when the answer says so and every row carries its position.
  const ordered = data.ordered === true && handlers.every((handler) => Number.isInteger(handler.ordinal));
  const listed = ordered ? [...handlers].sort((a, b) => a.ordinal! - b.ordinal!) : handlers;
  const placed = listed.map(placeConnected);
  const groups = groupHandlers(placed, ordered);
  return {
    mode: "connected",
    kind: "known",
    table: context.table,
    formName,
    status,
    headline: connectedHeadline(placed.map((handler) => handler.row)),
    orderNote: !ordered && handlers.length > 1 ? ORDER_NOT_RECORDED : null,
    groups,
    // Said only where a number is shown: a lone handler under each event carries none.
    info: groups.some((group) => group.rows.some((row) => row.position !== undefined)) ? [...CONNECTED_INFO, ORDERED_INFO] : CONNECTED_INFO,
    tip: null,
  };
}

function notModeledHeadline(reason: string | null): string {
  if (reason === "formNotParsed") return FORM_NOT_PARSED;
  if (reason === "handlersNotRecorded") return HANDLERS_NOT_RECORDED;
  return NOT_MODELED_UNKNOWN;
}

function isFormHandlers(value: unknown): value is FormHandlers {
  if (typeof value !== "object" || value === null) return false;
  const answer = value as Partial<FormHandlers>;
  return (
    typeof answer.formId === "string" &&
    typeof answer.coverage === "string" &&
    isOptionalString(answer.formName) &&
    isOptionalString(answer.table) &&
    (answer.handlers === null || answer.handlers === undefined || (Array.isArray(answer.handlers) && answer.handlers.every((handler) => typeof handler === "object" && handler !== null)))
  );
}

function isOptionalString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

export function connectedHeadline(rows: readonly EventMapRow[]): string {
  if (rows.length === 0) return "Pathix's scan found no script handlers registered on this form.";
  const disabled = rows.filter((row) => row.enabled === false).length;
  const unstated = rows.filter((row) => row.enabled === null).length;
  const internal = rows.filter((row) => row.internal).length;
  const noun = rows.length === 1 ? "1 handler" : `${rows.length} handlers`;
  const parts = [
    disabled > 0 ? `${disabled} disabled` : "",
    unstated > 0 ? `${unstated} with enabled not stated` : "",
    internal > 0 ? `${internal} loaded by the platform` : "",
  ].filter(Boolean);
  return `Pathix's scan found ${noun} registered on this form${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

function scopeOf(scope: string | undefined): HandlerScope {
  switch ((scope ?? "").toLowerCase()) {
    case "form":
      return "form";
    case "tab":
      return "tab";
    case "control":
      return "control";
    default:
      return "other";
  }
}

function placeConnected(handler: PathixHandler): Placed {
  const scope = scopeOf(handler.scope);
  const name = handler.scopeName ?? null;
  const event = handler.event ?? "";
  return {
    event: event.toLowerCase(),
    eventAsWritten: event,
    // A form-level onchange names its column; a control's event names it only when it is not the control's own id.
    attribute: scope === "control" ? null : (handler.column?.toLowerCase() ?? null),
    scope,
    tab: scope === "tab" ? name : null,
    control: scope === "control" ? name : null,
    controlColumn: scope === "control" && handler.column && handler.column !== name ? handler.column : null,
    row: {
      functionName: handler.function ?? "",
      library: handler.library ?? "",
      enabled: handler.isEnabled === true ? true : handler.isEnabled === false ? false : null,
      internal: handler.isPlatformLoaded === true,
    },
  };
}

// --- Grouping, shared -------------------------------------------------------------------

const SCOPE_ORDER = { form: 0, tab: 1, control: 2, other: 3 } as const;
const FORM_EVENT_ORDER = ["onload", "onsave", "onchange"];

/** A handler as the grouping reads it, whichever source it came from. */
interface Placed {
  /** Lower case. */
  event: string;
  /** The event's own spelling, for an event with no label of ours. */
  eventAsWritten: string;
  /** For a form-level onchange: the column. */
  attribute: string | null;
  scope: HandlerScope;
  tab: string | null;
  control: string | null;
  /** Connected: the column a control's event is attached to, when it is not the control's own id. */
  controlColumn: string | null;
  row: EventMapRow;
}

function placeLite(handler: FormHandler): Placed {
  return {
    event: handler.event,
    eventAsWritten: handler.event,
    attribute: handler.attribute,
    scope: handler.scope,
    tab: handler.tab,
    control: handler.control,
    // The same rule as the connected map: a control's bound column is named only when it is not the control's own id.
    controlColumn: handler.scope === "control" && handler.controlColumn && handler.controlColumn !== handler.control ? handler.controlColumn : null,
    row: { functionName: handler.functionName, library: handler.library, enabled: handler.enabled, internal: handler.internal },
  };
}

/** Groups handlers by what their event belongs to; rows keep the order they were given in. */
function groupHandlers(handlers: readonly Placed[], numbered = false): EventMapGroup[] {
  const byKey = new Map<string, { sort: [number, number, string]; title: string; rows: EventMapRow[] }>();
  for (const handler of handlers) {
    const { key, title } = targetOf(handler);
    const order = FORM_EVENT_ORDER.indexOf(handler.event);
    let group = byKey.get(key);
    if (!group) {
      group = { sort: [SCOPE_ORDER[handler.scope], handler.scope === "form" && order !== -1 ? order : FORM_EVENT_ORDER.length, key], title, rows: [] };
      byKey.set(key, group);
    }
    group.rows.push(numbered ? { ...handler.row, position: group.rows.length + 1 } : handler.row);
  }
  return [...byKey.values()]
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]))
    .map(({ title, rows }) => ({ title, rows: rows.length > 1 ? rows : rows.map(unnumbered) }));
}

/** A lone handler is not a sequence, so it carries no number. */
function unnumbered(row: EventMapRow): EventMapRow {
  const { position: _position, ...rest } = row;
  return rest;
}

export function eventLabel(handler: { event: string; eventAsWritten?: string }): string {
  return EVENT_LABELS[handler.event.toLowerCase()] ?? (handler.eventAsWritten || handler.event || "an unnamed event");
}

function targetOf(handler: Placed): { key: string; title: string } {
  const event = eventLabel(handler);
  const column = handler.attribute ? `${event}: ${handler.attribute}` : event;
  switch (handler.scope) {
    case "form":
      return { key: `form|${handler.event}|${handler.attribute ?? ""}`, title: column };
    case "tab":
      return { key: `tab|${handler.tab ?? ""}|${handler.event}`, title: `Tab ${handler.tab ?? "(unnamed)"}: ${event}` };
    case "control": {
      const control = handler.control ?? "(unnamed)";
      const on = handler.controlColumn ? ` (${handler.controlColumn})` : "";
      return { key: `control|${control}|${handler.event}|${handler.controlColumn ?? ""}`, title: `Control ${control}: ${event}${on}` };
    }
    default:
      return { key: `other|${handler.event}|${handler.attribute ?? ""}`, title: `Elsewhere in the definition: ${column}` };
  }
}
