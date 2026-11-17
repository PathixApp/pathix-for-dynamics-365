// Finding which form field the pointer or focus is on.
//
// The unified interface marks each field's container with
// data-id="<control>-FieldSectionItemContainer" and the controls inside it
// with data-id="<control>.fieldControl-...". These are the same hooks
// Microsoft's EasyRepro test framework uses. The DOM only says WHICH control;
// the form snapshot from Xrm says which column it is bound to, so a control
// the snapshot does not list is ignored.
//
// A field inside a quick view carries the quick view's control name, a dot
// and the inner control's name: data-id="contactquickform.emailaddress1-
// FieldSectionItemContainer" (captured live). Its whole dotted
// name is the control name, so it can only match the snapshot's quick view
// entries, never a form control that shares the inner name.

import { isControlName, isQuickViewControlName } from "../bridge/messages";

const CONTAINER_SUFFIX = "-FieldSectionItemContainer";
const CONTAINER_SELECTOR = `[data-id$="${CONTAINER_SUFFIX}"]`;

// Hovering these means the user is working the field, not asking about it.
const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[contenteditable="true"]',
].join(", ");

export interface FieldTarget {
  container: Element;
  controlName: string;
}

export function controlNameFromDataId(dataId: string | null): string | null {
  if (!dataId?.endsWith(CONTAINER_SUFFIX)) return null;
  const name = dataId.slice(0, -CONTAINER_SUFFIX.length);
  return isControlName(name) || isQuickViewControlName(name) ? name : null;
}

export function findFieldTarget(node: Element | null): FieldTarget | null {
  const container = node?.closest(CONTAINER_SELECTOR) ?? null;
  if (!container) return null;
  const controlName = controlNameFromDataId(container.getAttribute("data-id"));
  return controlName ? { container, controlName } : null;
}

export function isEditableTarget(node: Element | null): boolean {
  return !!node?.closest(EDITABLE_SELECTOR);
}
