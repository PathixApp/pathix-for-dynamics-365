// Builds a FormSnapshot from the page's Xrm object.
//
// Metadata only (DESIGN.md, "Names, never values"). Everything here reads
// NAMES: the table's logical name, control names, bound column names, the
// form definition id, the organization id, and for a quick view (another
// record's form shown read-only on this one) its name, its fields' names and
// the logical name of the table they belong to. Four states cross as names or
// fixed words: which columns have unsaved edits, which bound controls the
// form shows read-only, which columns the form submits on every save (their
// submit mode, not their value), and whether a save would create or update
// (the form's type, as the word "create" or "update"). It never reads a
// value, the record id, or the URL beyond its host. The forbidden-API test
// (test/page-source.test.ts) fails the build if a value-reading Xrm call
// appears anywhere under src/page or src/bridge.
//
// The Xrm types below are deliberately the narrow slice this file uses, so a
// test can hand in a fake without the whole client API.

import {
  CHANNEL,
  SNAPSHOT_VERSION,
  isControlName,
  isFormColumn,
  isLogicalName,
  isQuickViewColumn,
  isGuid,
  normalizeGuid,
  type FormColumn,
  type NoFormReason,
  type PageMessage,
  type QuickViewColumn,
  type SaveKind,
} from "../bridge/messages";

export interface XrmAttribute {
  getName(): string;
  getIsDirty(): boolean;
  /** "always", "dirty" or "never": how the form submits the column. A setting, not a value. */
  getSubmitMode?: () => string;
  /**
   * The entity the attribute belongs to, read only for its logical name: for a
   * field inside a quick view, the quick view's table, not the form's.
   */
  getParent?: () => { getEntityName(): string } | null | undefined;
}

export interface XrmControl {
  getName(): string;
  getAttribute?: () => XrmAttribute | null | undefined;
  /** Whether the control is read-only on the form. A state, not a value. */
  getDisabled?: () => boolean;
}

/** One form the user can open. Only its id is read: the form definition's id, never the record's. */
export interface XrmFormItem {
  getId(): string;
}

export interface XrmFormSelector {
  /** The form shown. Microsoft documents that it returns null when only one form is available. */
  getCurrentItem(): XrmFormItem | null;
  /** Every form the user can open (Microsoft: "all the form items accessible to the current user"). */
  items?: { get(): XrmFormItem[] } | null;
}

/**
 * A quick view control: another record's form shown read-only on this one.
 * Microsoft documents getControl() with no argument as its constituent
 * controls, "Object or Object collection", so both shapes are read.
 */
export interface XrmQuickView {
  getName(): string;
  getControl(): XrmControl[] | { get(): XrmControl[] } | null | undefined;
}

export interface XrmLike {
  Page?: {
    data?: {
      entity?: {
        getEntityName(): string;
        attributes: { get(): XrmAttribute[] };
      } | null;
    } | null;
    ui?: {
      controls: { get(): XrmControl[] };
      /** 1 create, 2 update, 3 read only, 4 disabled, 6 bulk edit, 11 quick create. A state, not a value. */
      getFormType?: () => number;
      formSelector?: XrmFormSelector | null;
      quickForms?: { get(): XrmQuickView[] } | null;
    } | null;
  };
  Utility?: {
    getGlobalContext(): { organizationSettings: { organizationId: string } };
  };
}

export function buildPageMessage(xrm: XrmLike | undefined, host: string): PageMessage {
  if (!xrm) return noForm("noXrm");
  const entity = xrm.Page?.data?.entity;
  const ui = xrm.Page?.ui;
  if (!entity || !ui) return noForm("noFormContext");
  const context = xrm.Utility?.getGlobalContext();
  if (!context) return noForm("noGlobalContext");

  return {
    channel: CHANNEL,
    kind: "formSnapshot",
    version: SNAPSHOT_VERSION,
    organizationId: normalizeGuid(context.organizationSettings.organizationId),
    host: host.toLowerCase(),
    table: entity.getEntityName(),
    formId: currentFormId(ui.formSelector),
    columns: boundColumns(ui.controls.get()),
    dirtyColumns: dirtyColumnNames(entity.attributes.get()),
    lockedControls: lockedControlNames(ui.controls.get()),
    saveKind: saveKindOf(ui),
    alwaysSubmitColumns: alwaysSubmitColumnNames(entity.attributes.get()),
    quickViewColumns: quickViewColumnsOf(quickViewsOf(ui)),
  };
}

export function noForm(reason: NoFormReason): PageMessage {
  return { channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason };
}

// The form DEFINITION's id, never the record's. The selector's current item
// says it, except when the user can open only one form (common where forms
// are limited by security role): Microsoft documents that getCurrentItem then
// returns null. The selector's items list every form the user can open, so
// when it holds exactly one, that one is the form shown. Anything else is
// unknown, and the content script may still find the id in the form's field
// labels (src/content/form-scope.ts). An id that is not a GUID is dropped
// here, so it cannot make the bridge refuse the whole snapshot.
function currentFormId(selector: XrmFormSelector | null | undefined): string | null {
  if (!selector) return null;
  const current = selector.getCurrentItem();
  if (current) return formIdOf(current);
  const items = onlyFormItems(selector);
  return items.length === 1 ? formIdOf(items[0]!) : null;
}

function onlyFormItems(selector: XrmFormSelector): XrmFormItem[] {
  try {
    const items = selector.items?.get();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function formIdOf(item: XrmFormItem): string | null {
  const id = item.getId();
  if (typeof id !== "string") return null;
  const formId = normalizeGuid(id);
  return isGuid(formId) ? formId : null;
}

// Only controls bound to a column: subgrids, web resources and iframes have
// no attribute and say nothing about a field's writers. A control whose name
// the validator would reject is dropped here, so one odd control cannot make
// the extension discard the whole form.
function boundColumns(controls: XrmControl[]): FormColumn[] {
  return controls.map(boundColumn).filter(isFormColumn);
}

function boundColumn(control: XrmControl): FormColumn | null {
  try {
    const attribute = control.getAttribute?.();
    return attribute ? { control: control.getName(), column: attribute.getName() } : null;
  } catch {
    // Some control kinds expose getAttribute with a different contract.
    return null;
  }
}

function quickViewsOf(ui: { quickForms?: { get(): XrmQuickView[] } | null }): XrmQuickView[] {
  try {
    const views = ui.quickForms?.get();
    return Array.isArray(views) ? views : [];
  } catch {
    return [];
  }
}

// A quick view's fields, each keyed "<quick view>.<inner control>", the name
// the field's data-id carries (e.g. contactquickform.emailaddress1 for the
// Primary Contact quick view on Account). The inner control's own name is the
// bare column name, so it says nothing of the table and can equal one of the
// form's own controls. The table is the logical name of the entity the inner
// attribute belongs to: "contact" there, while the form's is "account"
// (captured live). An inner field whose table cannot be read is
// left out, since a card on the wrong table is worse than none. A quick view
// that has not loaded yet answers no controls.
function quickViewColumnsOf(quickViews: XrmQuickView[]): QuickViewColumn[] {
  return quickViews.flatMap((view) => {
    const name = quickViewName(view);
    if (!name) return [];
    return innerControls(view)
      .map((control) => quickViewColumn(name, control))
      .filter(isQuickViewColumn);
  });
}

function quickViewName(view: XrmQuickView): string | null {
  try {
    const name = view.getName();
    return isControlName(name) ? name : null;
  } catch {
    return null;
  }
}

function innerControls(view: XrmQuickView): XrmControl[] {
  try {
    const controls = view.getControl();
    if (Array.isArray(controls)) return controls;
    const listed = controls?.get();
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

function quickViewColumn(quickView: string, control: XrmControl): QuickViewColumn | null {
  try {
    const attribute = control.getAttribute?.();
    const table = attribute?.getParent?.()?.getEntityName();
    return attribute && table ? { control: `${quickView}.${control.getName()}`, table, column: attribute.getName() } : null;
  } catch {
    return null;
  }
}

// Bound controls the form shows read-only, by control name. Only bound
// controls: a locked subgrid or web resource says nothing about a field.
function lockedControlNames(controls: XrmControl[]): string[] {
  return controls
    .filter((control) => {
      try {
        return boundColumn(control) !== null && control.getDisabled?.() === true;
      } catch {
        return false;
      }
    })
    .map((control) => control.getName())
    .filter(isControlName);
}

function dirtyColumnNames(attributes: XrmAttribute[]): string[] {
  return attributes
    .filter((attribute) => attribute.getIsDirty())
    .map((attribute) => attribute.getName())
    .filter(isLogicalName);
}

// What a save of this form would do. 1 is a new record and 11 a quick create
// form; 2 is an existing record. Read only (3), disabled (4), bulk edit (6) and
// anything else cannot be saved as it is open, so there is no save to preview.
function saveKindOf(ui: { getFormType?: () => number }): SaveKind | null {
  try {
    const type = ui.getFormType?.();
    if (type === 1 || type === 11) return "create";
    return type === 2 ? "update" : null;
  } catch {
    return null;
  }
}

// Columns the form submits on every save, edited or not. Only the setting
// "always" is read; the value is never asked for.
function alwaysSubmitColumnNames(attributes: XrmAttribute[]): string[] {
  return attributes
    .filter((attribute) => {
      try {
        return attribute.getSubmitMode?.() === "always";
      } catch {
        return false;
      }
    })
    .map((attribute) => attribute.getName())
    .filter(isLogicalName);
}
