// Messages between the extension's own contexts (content script, options
// page, service worker). Distinct from src/bridge, which is the page-facing
// channel and holds the metadata-only line.

import { isBinding, type BindingChange, type SignInBinding } from "../auth/binding";
import { isGuid, isHostName, isLogicalName } from "../bridge/messages";
import type { EventMapModel } from "../card/event-map";
import type { FieldCardModel } from "../card/model";
import type { SavePreviewModel } from "../card/save-preview";
import type { WhatChangedModel } from "../card/what-changed";
import type { XrayModel } from "../card/xray";
import type { SignInUnavailable } from "../pathix/api";

/**
 * Content script to service worker: "show me the card for this column".
 * Logical names and the org id only, the same metadata-only line as the
 * bridge; the worker validates it again.
 */
export interface FieldCardRequest {
  kind: "fieldCard";
  organizationId: string;
  host: string;
  table: string;
  column: string;
}

export type FieldCardResponse =
  | { kind: "card"; card: FieldCardModel }
  | { kind: "status"; status: ConnectionStatus };

/** Content script to service worker: the X-ray for every column on the form. */
export interface XrayRequest {
  kind: "xray";
  organizationId: string;
  host: string;
  table: string;
  columns: string[];
}

export type XrayResponse = { kind: "xray"; model: XrayModel } | { kind: "status"; status: ConnectionStatus };

/**
 * Content script to service worker: "what did Pathix's scans find changed on
 * this table" (M11). Logical names and the org id only, like the others.
 */
export interface TableChangesRequest {
  kind: "tableChanges";
  organizationId: string;
  host: string;
  table: string;
}

export type TableChangesResponse = { kind: "changes"; model: WhatChangedModel } | { kind: "status"; status: ConnectionStatus };

/**
 * Content script to service worker: "what script handlers did Pathix's latest
 * scan find on this form" (M10, connected). The table's logical name, the form
 * id and the org id only, like the others.
 */
export interface EventMapRequest {
  kind: "eventMap";
  organizationId: string;
  host: string;
  table: string;
  formId: string;
}

export type EventMapResponse = { kind: "eventMap"; model: EventMapModel } | { kind: "status"; status: ConnectionStatus };

/**
 * Content script to service worker: "what is registered to fire when this form
 * is saved" (M12). The table, Create or Update, the form's definition id and
 * the NAMES of the columns the save would send (the dirty ones, plus those the
 * form submits always). No values, no record id. On Create `columns` is empty:
 * the platform ignores them there, so none are sent.
 */
export interface SavePreviewRequest {
  kind: "savePreview";
  organizationId: string;
  host: string;
  table: string;
  message: "Create" | "Update";
  formId: string | null;
  columns: string[];
}

export type SavePreviewResponse = { kind: "savePreview"; model: SavePreviewModel } | { kind: "status"; status: ConnectionStatus };

/**
 * Toolbar popup, or the service worker on a keyboard command, to the active
 * tab's content script. Each opens one form feature through its controller's
 * public entry point (DESIGN.md, "Entry points"). None carries anything but
 * its kind. `openFieldCard` opens the hover card for the field that has focus,
 * or last had it, and is answered with a FieldCardOpen.
 */
export type OpenFeatureCommand =
  | { kind: "openEventMap" }
  | { kind: "openWhatChanged" }
  | { kind: "openSavePreview" }
  | { kind: "openFieldCard" };

/** Service worker to content script, on the X-ray keyboard command. */
export interface ToggleXrayCommand {
  kind: "toggleXray";
}

/** Toolbar popup to content script: turn X-ray on or off. The answer is whether it is now on. */
export interface SetXrayCommand {
  kind: "setXray";
  on: boolean;
}

/**
 * Toolbar popup to content script: "is a record form open here, and in what
 * state?" Answered at once from the content script's own state, never after a
 * call to Pathix, so a slow Pathix never disables the form's actions.
 */
export interface FormStateQuery {
  kind: "formState";
}

/** Toolbar popup to content script: "what is this form's connection?" This one can wait on Pathix. */
export interface ConnectionStatusQuery {
  kind: "connectionStatus";
}

/** Everything the popup or the worker's keyboard commands send to a content script. */
export type ContentCommand = OpenFeatureCommand | ToggleXrayCommand | SetXrayCommand | FormStateQuery | ConnectionStatusQuery;

/**
 * The content script's answer to a FormStateQuery. `form` is whether a
 * model-driven record form is open. The mode is not part of it: the popup
 * reads it fresh from storage, where it lives.
 */
export interface FormState {
  kind: "formState";
  form: boolean;
  xray: boolean;
}

/** The answer to a ConnectionStatusQuery: the form's status from the worker, or null with no form or no answer. */
export interface ConnectionStatusAnswer {
  kind: "connectionStatus";
  connection: ConnectionStatus | null;
}

/** Service worker to content script, when a tab finishes loading or moving. It carries no address. */
export interface RefreshBadgeCommand {
  kind: "refreshBadge";
}

// The worker's sign-out reset is defined beside the admin overlay's messages,
// since the admin center page script hears it too and bundles that file only.
export { isPathixResetCommand, type PathixResetCommand } from "./admin-overlay";

/**
 * The content script's answer to `openFieldCard`: the card opened, no field
 * had focus, or the field that had it has no column on this form, so no card.
 */
export type FieldCardOpen = "opened" | "noField" | "noCard";

const MAX_XRAY_COLUMNS = 500;
const MAX_SAVE_COLUMNS = 2000;

export function isXrayRequest(value: unknown): value is XrayRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 5 &&
    request.kind === "xray" &&
    isGuid(request.organizationId) &&
    isHostName(request.host) &&
    isLogicalName(request.table) &&
    Array.isArray(request.columns) &&
    request.columns.length <= MAX_XRAY_COLUMNS &&
    request.columns.every(isLogicalName)
  );
}

const OPEN_FEATURE_KINDS: ReadonlySet<unknown> = new Set(["openEventMap", "openWhatChanged", "openSavePreview", "openFieldCard"]);

export function isOpenFeatureCommand(value: unknown): value is OpenFeatureCommand {
  return isRecord(value) && Object.keys(value).length === 1 && OPEN_FEATURE_KINDS.has(value.kind);
}

export function isSetXrayCommand(value: unknown): value is SetXrayCommand {
  return isRecord(value) && Object.keys(value).length === 2 && value.kind === "setXray" && typeof value.on === "boolean";
}

export function isFormStateQuery(value: unknown): value is FormStateQuery {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "formState";
}

export function isToggleXrayCommand(value: unknown): value is ToggleXrayCommand {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "toggleXray";
}

export function isConnectionStatusQuery(value: unknown): value is ConnectionStatusQuery {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "connectionStatus";
}

export function isContentCommand(value: unknown): value is ContentCommand {
  return (
    isOpenFeatureCommand(value) ||
    isToggleXrayCommand(value) ||
    isSetXrayCommand(value) ||
    isFormStateQuery(value) ||
    isConnectionStatusQuery(value)
  );
}

/** Checked in the popup: the answer comes from a script that runs inside the D365 page's renderer. */
export function isFormState(value: unknown): value is FormState {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.kind === "formState" &&
    typeof value.form === "boolean" &&
    typeof value.xray === "boolean"
  );
}

/** Checked in the popup, like the form state. */
export function isConnectionStatusAnswer(value: unknown): value is ConnectionStatusAnswer {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "connectionStatus" &&
    (value.connection === null || isConnectionStatus(value.connection))
  );
}

const MAX_STATUS_TEXT = 2000;

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STATUS_TEXT;
}

const MAX_EXCLUDED_TABLES = 2000;

/**
 * A ConnectionStatus with the fields its kind carries and no others: the
 * required ones, and the optional ones each checked when present.
 */
export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "notConfigured":
      return onlyKeys(value, ["kind"]);
    case "notScanned":
      return (
        onlyKeys(value, ["kind", "otherHost", "noAddress"]) &&
        (value.otherHost === undefined || isHostName(value.otherHost)) &&
        (value.noAddress === undefined || value.noAddress === true) &&
        !(value.otherHost !== undefined && value.noAddress !== undefined)
      );
    case "signedOut":
      return onlyKeys(value, ["kind", "reason"]) && isShortText(value.reason);
    case "unauthorized":
      return onlyKeys(value, ["kind", "status"]) && typeof value.status === "number" && Number.isInteger(value.status);
    case "error":
      return onlyKeys(value, ["kind", "message"]) && isShortText(value.message);
    case "connected":
      return (
        onlyKeys(value, [
          "kind",
          "environmentId",
          "environmentName",
          "latestCompletedScanAt",
          "latestCompletedScanUnknown",
          "latestCompletedScanStartedAt",
          "excludedTables",
        ]) &&
        isShortText(value.environmentId) &&
        isShortText(value.environmentName) &&
        (value.latestCompletedScanAt === null || isShortText(value.latestCompletedScanAt)) &&
        (value.latestCompletedScanUnknown === undefined || value.latestCompletedScanUnknown === true) &&
        (value.latestCompletedScanStartedAt === undefined ||
          value.latestCompletedScanStartedAt === null ||
          isShortText(value.latestCompletedScanStartedAt)) &&
        (value.excludedTables === undefined ||
          (Array.isArray(value.excludedTables) &&
            value.excludedTables.length <= MAX_EXCLUDED_TABLES &&
            value.excludedTables.every(isLogicalName)))
      );
    default:
      return false;
  }
}

/** Every key is one of `allowed`, and the ones not marked optional by their checks are there. */
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const required = allowed.filter((key) => !OPTIONAL_STATUS_KEYS.has(key));
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value);
}

const OPTIONAL_STATUS_KEYS: ReadonlySet<string> = new Set([
  "otherHost",
  "noAddress",
  "latestCompletedScanUnknown",
  "latestCompletedScanStartedAt",
  "excludedTables",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRefreshBadgeCommand(value: unknown): value is RefreshBadgeCommand {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refreshBadge";
}

export function isTableChangesRequest(value: unknown): value is TableChangesRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 4 &&
    request.kind === "tableChanges" &&
    isGuid(request.organizationId) &&
    isHostName(request.host) &&
    isLogicalName(request.table)
  );
}

export function isEventMapRequest(value: unknown): value is EventMapRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 5 &&
    request.kind === "eventMap" &&
    isGuid(request.organizationId) &&
    isHostName(request.host) &&
    isLogicalName(request.table) &&
    isGuid(request.formId)
  );
}

export function isSavePreviewRequest(value: unknown): value is SavePreviewRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 7 &&
    request.kind === "savePreview" &&
    isGuid(request.organizationId) &&
    isHostName(request.host) &&
    isLogicalName(request.table) &&
    (request.message === "Create" || request.message === "Update") &&
    (request.formId === null || isGuid(request.formId)) &&
    Array.isArray(request.columns) &&
    request.columns.length <= MAX_SAVE_COLUMNS &&
    request.columns.every(isLogicalName) &&
    (request.message === "Update" || request.columns.length === 0)
  );
}

export function isFieldCardRequest(value: unknown): value is FieldCardRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 5 &&
    request.kind === "fieldCard" &&
    isGuid(request.organizationId) &&
    isHostName(request.host) &&
    isLogicalName(request.table) &&
    isLogicalName(request.column)
  );
}

export type ConnectionStatus =
  | { kind: "notConfigured" }
  | { kind: "signedOut"; reason: string }
  /** Signed in, but Pathix refused the account (for example, not assigned). */
  | { kind: "unauthorized"; status: number }
  /** This D365 org is not an environment in this Pathix. */
  /**
   * This D365 org is not an environment in this Pathix for this page. With
   * `otherHost`, Pathix knows the organization under that other address (the
   * host of the URL Pathix stores, its metadata), so it answers nothing here.
   * With `noAddress`, Pathix lists the organization id but stores no usable
   * URL for it, so this page cannot be checked against it, and it answers
   * nothing here either.
   */
  | { kind: "notScanned"; otherHost?: string; noAddress?: true }
  | {
      kind: "connected";
      environmentId: string;
      environmentName: string;
      /** ISO timestamp of the latest Completed scan, or null if there is none yet (or, with latestCompletedScanUnknown, none Pathix listed). */
      latestCompletedScanAt: string | null;
      /**
       * True when Pathix's scan list was at its cap and held no Completed scan:
       * one may be older than the list, so a null latestCompletedScanAt is
       * unknown, never "no Completed scan yet". Absent otherwise.
       */
      latestCompletedScanUnknown?: true;
      /** When the latest Completed scan was queued (/scans StartedAt, not the run's start), or null. A component modified after it is unknown to the live check until the scan completed. */
      latestCompletedScanStartedAt?: string | null;
      /** Tables the environment's scans leave out, lower case. Absent when Pathix did not say: nothing is taken as excluded. */
      excludedTables?: string[];
    }
  | { kind: "error"; message: string };

/**
 * Sent by the options page only; the service worker checks the sender. Sign in
 * carries the binding the page showed the user (AccountStatus.offered). The
 * worker signs in only when /config still says exactly that; null asks it to
 * show the settings first and sign in on the next click.
 */
export type OptionsRequest =
  | { kind: "signIn"; binding: SignInBinding | null }
  | { kind: "signOut" }
  | { kind: "accountStatus" };

export interface AccountStatus {
  configured: boolean;
  signedIn: boolean;
  /** The signed-in user's UPN from the token, for display on the options page. */
  account: string | null;
  /** Why a sign-in the user asked for did not complete. */
  error: string | null;
  /**
   * Why this Pathix offers the extension no sign-in, from its /config or from
   * the token Entra granted. Null when it does, or when that is not known.
   * When set, the worker has removed the stored token and keeps no new one
   * for these settings, even from a sign-in that was already running; the
   * options page offers no sign-in.
   */
  signInUnavailable: SignInUnavailable | null;
  /**
   * What went wrong when Pathix's /config could not be read, or null. Whether
   * Pathix offers sign-in is then unknown; `signedIn` comes from the stored
   * token alone.
   */
  pathixUnreachable: string | null;
  /**
   * What selecting Sign in would trust, read from /config just now: the Pathix
   * address, the tenant, the authority and the API. Null when /config did not
   * offer sign-in or did not answer.
   */
  offered: SignInBinding | null;
  /**
   * What changed in Pathix's sign-in settings since the user signed in to this
   * address. Not empty means a silent sign-in is held until the user selects
   * Sign in again.
   */
  changed: BindingChange[];
  /**
   * A token or a confirmed sign-in is stored, so Sign out has something to
   * remove, even when it no longer signs the user in (the settings changed).
   */
  signOutOffered: boolean;
}

export function isOptionsRequest(value: unknown): value is OptionsRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as { kind?: unknown; binding?: unknown };
  if (request.kind === "signIn") return request.binding === null || isBinding(request.binding);
  return request.kind === "signOut" || request.kind === "accountStatus";
}

/** One line for the console, the same wording everywhere it is logged. */
export function describeConnection(status: ConnectionStatus): string {
  switch (status.kind) {
    case "notConfigured":
      return "not set up: open the extension's options to connect to Pathix";
    case "signedOut":
      return "signed out: sign in from the extension's options";
    case "unauthorized":
      return `Pathix refused this account (HTTP ${status.status}); check it is assigned to the Pathix API`;
    case "notScanned":
      if (status.otherHost) return `your Pathix knows this organization under a different address (${status.otherHost})`;
      return status.noAddress
        ? "your Pathix lists this organization without an address, so this page cannot be checked against it"
        : "Pathix has no environment that matches this organization";
    case "connected":
      if (status.latestCompletedScanAt) return `connected: ${status.environmentName}, latest Completed scan ${status.latestCompletedScanAt}`;
      return status.latestCompletedScanUnknown
        ? `connected: ${status.environmentName}, latest Completed scan unknown (none among the latest scans Pathix lists)`
        : `connected: ${status.environmentName}, no Completed scan yet`;
    case "error":
      return `could not reach Pathix: ${status.message}`;
  }
}
