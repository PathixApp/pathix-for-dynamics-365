// Which form a field container is on.
//
// The page's snapshot is Xrm.Page: one form. The page can show more than one:
// a quick create over a main form, a dialog or side pane opened with
// Xrm.Navigation.navigateTo, or several sessions in a multi-session app, whose
// hidden sessions keep their forms in the page. Their fields carry the same
// control names, so a control name alone does not say which form a container
// is on.
//
// A real D365 body field's label carries its form's id:
// `id-<form id>-<n>-<control>-field-label` (captured from a real Account form,
// 2026-10-09). That is verified for body fields only. Header fields, the
// header flyout, business process stage fields and composite flyouts may carry
// another id. So a label naming another form rules a container out only when
// both hold:
//
// - the form id is the one the page itself reported (Xrm), never one read from
//   the labels, which can be another form's (a hidden session, a form still in
//   the page during a move);
// - some field label on the page names that form, so the page is known to
//   label its fields with it.
//
// Otherwise no container is ruled out: unknown is never "other". A control
// that is drawn only on other forms is still counted as a field that could not
// be marked, so a field the rule drops wrongly is never silent.
//
// Names, never values (DESIGN.md): the DOM is read for containers by data-id
// and for labels by id, and for whether a container is drawn. No text is read
// out of a D365 node.

import { isControlName } from "../bridge/messages";

const CONTAINER_SUFFIX = "-FieldSectionItemContainer";
const LABEL_SUFFIX = "-field-label";
const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IS_GUID = new RegExp(`^${GUID}$`, "i");
/** Header tiles, the header flyout and business process stage fields: their label ids are not verified to name the form. */
const HEADER_PREFIX = "header_";
/** A composite field's flyout parts, such as address1_composite_compositionLinkControl_address1_line1. Not verified either. */
const COMPOSITE_PART = "_compositionLinkControl_";

/**
 * Whether a control's label is known to carry its form's id: a body field.
 * Header, business process and composite flyout controls are not, so their
 * labels never say "another form".
 */
export function labelNamesForm(control: string): boolean {
  return !control.startsWith(HEADER_PREFIX) && !control.includes(COMPOSITE_PART);
}

/** Whether a container is on the snapshot's form, on another one, or not known to be either. */
export type FormRelation = "same" | "other" | "unknown";

/**
 * The form id in a label id shaped `id-<form id>-<n>-<control>-field-label`,
 * lower case, or null for any other id.
 */
export function formIdOfLabelId(id: string, control: string): string | null {
  // Control names are letters, digits and underscores (the bridge checks them), so one is safe in a pattern.
  if (!isControlName(control)) return null;
  const match = new RegExp(`^id-(${GUID})-.*-${control}${LABEL_SUFFIX}$`, "i").exec(id);
  return match ? match[1]!.toLowerCase() : null;
}

/** The form id the field's label carries, or null when there is no such label or its id names no form. */
export function labelFormId(container: Element, control: string): string | null {
  if (!isControlName(control)) return null;
  const label = container.querySelector(`[id$="-${control}${LABEL_SUFFIX}"]`);
  return label ? formIdOfLabelId(label.id, control) : null;
}

/**
 * What the label alone says: the form `formId` names, another form, or
 * unknown. A control whose label is not known to carry the form id (header,
 * business process, composite flyout) is always unknown. Not a ruling: see
 * containerOnForm.
 */
export function formRelation(container: Element, control: string, formId: string | null): FormRelation {
  if (!formId || !labelNamesForm(control)) return "unknown";
  const labelled = labelFormId(container, control);
  if (labelled === null) return "unknown";
  return labelled === formId.toLowerCase() ? "same" : "other";
}

/** Whether some field label on the page names the form `formId`: the page labels its fields with that form's id. */
export function formOnPage(root: ParentNode, formId: string): boolean {
  if (!IS_GUID.test(formId)) return false;
  return root.querySelector(`[id^="id-${formId.toLowerCase()}-" i][id$="${LABEL_SUFFIX}"]`) !== null;
}

/** Whether the container is drawn at all: one with display: none, or no size, is not. */
export function isRendered(container: Element): boolean {
  const box = container.getBoundingClientRect();
  return container.getClientRects().length > 0 && box.width > 0 && box.height > 0;
}

/** Every container for the control in the page, in document order. */
export function containersOf(root: ParentNode, control: string): Element[] {
  if (!isControlName(control)) return [];
  return Array.from(root.querySelectorAll(`[data-id="${control}${CONTAINER_SUFFIX}"]`));
}

export interface FormContainer {
  /** The control's container on the snapshot's form, or null. */
  container: Element | null;
  /** No container was chosen, but the control is drawn on a form ruled to be another: count it as not marked. */
  drawnElsewhere: boolean;
}

const RANK: Record<FormRelation, number> = { same: 0, unknown: 1, other: 2 };

/**
 * The control's container on the snapshot's form. `formId` is the form id the
 * page reported, or null. A container ruled to be on another form (see the
 * top of this file) is never chosen. Of the rest, one whose label names this
 * form comes first, then one whose label names none, then one whose label
 * names another form (kept only when nothing is ruled out); within each, a
 * drawn one before a hidden one: a multi-session app keeps other sessions'
 * forms in the page, and they can be the same form. `formIsOnPage` answers
 * formOnPage for this root and form id; a caller placing many fields passes
 * one that asks the page once.
 */
export function containerOnForm(
  root: ParentNode,
  control: string,
  formId: string | null,
  isDrawn: (container: Element) => boolean,
  formIsOnPage: () => boolean = () => formOnPage(root, formId!),
): FormContainer {
  const all = containersOf(root, control).map((container) => ({ container, relation: formRelation(container, control, formId) }));
  const ruled = all.some((candidate) => candidate.relation === "other") && formIsOnPage();
  const kept = ruled ? all.filter((candidate) => candidate.relation !== "other") : all;
  if (kept.length === 0) {
    return { container: null, drawnElsewhere: all.some((candidate) => isDrawn(candidate.container)) };
  }
  if (kept.length === 1) return { container: kept[0]!.container, drawnElsewhere: false };
  const rank = Math.min(...kept.map((candidate) => RANK[candidate.relation]));
  const best = kept.filter((candidate) => RANK[candidate.relation] === rank);
  return { container: (best.find((candidate) => isDrawn(candidate.container)) ?? best[0]!).container, drawnElsewhere: false };
}

/**
 * The form id the page's drawn field labels carry for these controls, when
 * they all name one form. Null when none does, or when they name more than
 * one. Hidden containers (another session, a form still in the page during a
 * move) and header fields are not read. The answer is advisory: it may go
 * with requests that need a form id, but it never rules a container out.
 */
export function formIdFromLabels(root: ParentNode, controls: readonly string[], isDrawn: (container: Element) => boolean): string | null {
  const found = new Set<string>();
  for (const control of new Set(controls)) {
    if (!labelNamesForm(control)) continue;
    for (const container of containersOf(root, control)) {
      if (!isDrawn(container)) continue;
      const formId = labelFormId(container, control);
      if (formId) found.add(formId);
      if (found.size > 1) return null;
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}
