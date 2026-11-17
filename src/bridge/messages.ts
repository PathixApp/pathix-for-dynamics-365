// The one message shape that crosses from the D365 page into the extension.
//
// Metadata only (DESIGN.md, "Names, never values"): a snapshot carries
// logical names and definition ids, never field values, never the record id,
// never the record's name. The guarantee comes from the page script reading
// only names (see form-snapshot.ts and the forbidden-API test); this
// validator is the second line. It rejects any key it does not know and any
// string that is not shaped like a logical name or a GUID, so a value cannot
// ride along by accident.

export const CHANNEL = "pathix-extension";
export const SNAPSHOT_VERSION = 1;

const MAX_COLUMNS = 2000;
const MAX_NAME_LENGTH = 128;

// Dataverse logical names: lowercase letters, digits, underscores.
const LOGICAL_NAME = /^[a-z_][a-z0-9_]*$/;
// Control names may also carry uppercase letters; still no spaces or
// punctuation.
const CONTROL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A field inside a quick view: the quick view's control name, a dot, and the
// inner control's name, as the unified interface writes it in the field's
// data-id (e.g. "contactquickform.emailaddress1"). Exactly one dot.
const QUICK_VIEW_CONTROL_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A host name, e.g. contoso.crm.dynamics.com. Never a full URL: the path and
// query of a D365 URL carry the record id.
const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface FormColumn {
  /** The form control's name, e.g. "header_ownerid". */
  control: string;
  /** The logical name of the column the control is bound to. */
  column: string;
}

/**
 * A field inside a quick view: another record's form, shown read-only on this
 * one. Its column belongs to the quick view's table, never the form's.
 */
export interface QuickViewColumn {
  /**
   * The quick view's name and the inner control's, joined by a dot, e.g.
   * "contactquickform.emailaddress1": the name the field's data-id carries.
   * Never the inner name alone, which can equal one of the form's own
   * controls (Account's telephone1 and the contact quick view's telephone1).
   */
  control: string;
  /** The logical name of the quick view's table, e.g. "contact". */
  table: string;
  /** The logical name of the column the inner control is bound to. */
  column: string;
}

export interface FormSnapshot {
  channel: typeof CHANNEL;
  kind: "formSnapshot";
  version: typeof SNAPSHOT_VERSION;
  organizationId: string;
  host: string;
  table: string;
  formId: string | null;
  columns: FormColumn[];
  /** Names of columns with unsaved edits. Names only, never the edits. */
  dirtyColumns: string[];
  /**
   * Names of bound controls the form shows read-only (M3, "why can't I edit
   * this field?"). Control names only; never why, never the value.
   */
  lockedControls: string[];
  /**
   * Whether a save of this form would create or update a record (M12, the save
   * preview). A fixed word read from the form's type; null for a form that
   * cannot be saved as it is open (read only, disabled, bulk edit) and when
   * the page did not say.
   */
  saveKind: SaveKind | null;
  /**
   * Names of columns whose submit mode is "always": the form sends them on a
   * save whether or not they were edited. Names only, never a value (M12).
   */
  alwaysSubmitColumns: string[];
  /**
   * The bound fields inside the form's quick views, each with the quick view's
   * table. Names only, never a value. Kept apart from `columns`, which are the
   * form's own table's columns.
   */
  quickViewColumns: QuickViewColumn[];
}

export const SAVE_KINDS = ["create", "update"] as const;
export type SaveKind = (typeof SAVE_KINDS)[number];

/**
 * Why the page script found no form. A fixed set, so the diagnostic can cross
 * the bridge without carrying any free text from the page.
 */
export const NO_FORM_REASONS = ["noXrm", "noFormContext", "noGlobalContext", "readFailed"] as const;
export type NoFormReason = (typeof NO_FORM_REASONS)[number];

export interface NoFormMessage {
  channel: typeof CHANNEL;
  kind: "noForm";
  version: typeof SNAPSHOT_VERSION;
  reason: NoFormReason;
}

export type PageMessage = FormSnapshot | NoFormMessage;

/**
 * Sent the other way, content script to page, when the content script starts.
 * The page script answers by re-posting its current snapshot, so a content
 * script that starts after the page already posted (a slow injection, or the
 * extension reloaded under an open tab) still gets the form.
 */
export interface HelloMessage {
  channel: typeof CHANNEL;
  kind: "hello";
  version: typeof SNAPSHOT_VERSION;
}

export function helloMessage(): HelloMessage {
  return { channel: CHANNEL, kind: "hello", version: SNAPSHOT_VERSION };
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["channel", "kind", "version"]) &&
    value.channel === CHANNEL &&
    value.kind === "hello" &&
    value.version === SNAPSHOT_VERSION
  );
}

/** Lowercases a GUID and strips the braces Xrm wraps some ids in. */
export function normalizeGuid(raw: string): string {
  return raw.replace(/[{}]/g, "").toLowerCase();
}

export function isPageMessage(value: unknown): value is PageMessage {
  if (!isRecord(value)) return false;
  if (value.channel !== CHANNEL || value.version !== SNAPSHOT_VERSION) return false;
  if (value.kind === "noForm") return isNoFormMessage(value);
  if (value.kind === "formSnapshot") return isFormSnapshot(value);
  return false;
}

function isNoFormMessage(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, ["channel", "kind", "version", "reason"]) &&
    (NO_FORM_REASONS as readonly unknown[]).includes(value.reason)
  );
}

function isFormSnapshot(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      "channel",
      "kind",
      "version",
      "organizationId",
      "host",
      "table",
      "formId",
      "columns",
      "dirtyColumns",
      "lockedControls",
      "saveKind",
      "alwaysSubmitColumns",
      "quickViewColumns",
    ]) &&
    matches(value.organizationId, GUID) &&
    matches(value.host, HOST_NAME) &&
    matches(value.table, LOGICAL_NAME) &&
    (value.formId === null || matches(value.formId, GUID)) &&
    isBoundedArray(value.columns) &&
    value.columns.every(isFormColumn) &&
    isBoundedArray(value.dirtyColumns) &&
    value.dirtyColumns.every(isLogicalName) &&
    isBoundedArray(value.lockedControls) &&
    value.lockedControls.every(isControlName) &&
    (value.saveKind === null || (SAVE_KINDS as readonly unknown[]).includes(value.saveKind)) &&
    isBoundedArray(value.alwaysSubmitColumns) &&
    value.alwaysSubmitColumns.every(isLogicalName) &&
    isBoundedArray(value.quickViewColumns) &&
    value.quickViewColumns.every(isQuickViewColumn)
  );
}

export function isLogicalName(value: unknown): boolean {
  return matches(value, LOGICAL_NAME);
}

export function isControlName(value: unknown): boolean {
  return matches(value, CONTROL_NAME);
}

export function isQuickViewControlName(value: unknown): boolean {
  return matches(value, QUICK_VIEW_CONTROL_NAME);
}

export function isGuid(value: unknown): boolean {
  return matches(value, GUID);
}

export function isHostName(value: unknown): boolean {
  return matches(value, HOST_NAME);
}

export function isFormColumn(value: unknown): value is FormColumn {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["control", "column"]) &&
    matches(value.control, CONTROL_NAME) &&
    matches(value.column, LOGICAL_NAME)
  );
}

export function isQuickViewColumn(value: unknown): value is QuickViewColumn {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["control", "table", "column"]) &&
    matches(value.control, QUICK_VIEW_CONTROL_NAME) &&
    matches(value.table, LOGICAL_NAME) &&
    matches(value.column, LOGICAL_NAME)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && value.length <= MAX_NAME_LENGTH && pattern.test(value);
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_COLUMNS;
}
