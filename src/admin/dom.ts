// Finds the places the overlay draws in the admin center, and reads the only
// two things it takes from the page's nodes: the target of a role link (an id)
// and the text of a grid cell, but only when that whole text is an Application
// ID (an identifier). Names, emails and every other value are never read into
// anything. test/admin-page.test.ts pins both reads to this file.
//
// Nothing here is keyed to the admin center's class names, which change. It
// uses the structure that holds across redesigns: a breadcrumb navigation,
// links that point at the role editor, and grid rows with cells. Where the
// structure is not found, the answer is null and nothing is drawn: never a
// guess at a place.

import { appIdFromCellText, roleIdFromHref } from "./routes";

const BREADCRUMB = [
  'nav[aria-label*="readcrumb" i]',
  '[role="navigation"][aria-label*="readcrumb" i]',
  ".ms-Breadcrumb",
  '[class*="readcrumb" i]',
].join(",");

/** How many wrapper levels above the breadcrumb the banner may go to clear a toolbar row. */
const MAX_CLIMB = 3;

/**
 * The element the role banner goes after: the breadcrumb, or the bar that
 * holds only the breadcrumb. The banner then sits below the breadcrumb and
 * above whatever follows it, which on the role editor is "Details". null when
 * the page has no breadcrumb.
 *
 * `ours` is the banner already drawn, if any. It is not part of the page: the
 * structure is read as if it were not there, so drawing it never changes
 * where it goes and it cannot move back and forth on the page's mutations.
 */
export function bannerAnchor(doc: Document, ours: Element | null = null): Element | null {
  const breadcrumb = outermostBreadcrumb(doc);
  if (!breadcrumb) return null;
  let anchor: Element = breadcrumb;
  for (let level = 0; level < MAX_CLIMB; level++) {
    const parent: Element | null = anchor.parentElement;
    if (!parent || parent === doc.body || !holdsOnlyOrSits(parent, anchor, ours)) break;
    anchor = parent;
  }
  return anchor;
}

function outermostBreadcrumb(doc: Document): Element | null {
  for (const candidate of Array.from(doc.querySelectorAll(BREADCRUMB))) {
    // A match inside another match is a crumb of the same breadcrumb.
    if (!candidate.parentElement?.closest(BREADCRUMB)) return candidate;
  }
  return null;
}

/** The parent is a wrapper around the anchor alone, or a row the anchor shares with other things (a toolbar). Our banner does not count. */
function holdsOnlyOrSits(parent: Element, anchor: Element, ours: Element | null): boolean {
  if (Array.from(parent.children).filter((child) => child !== ours).length === 1) return true;
  const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
  return style?.display.includes("flex") === true && !style.flexDirection.startsWith("column") && nextSiblingOf(anchor, ours) !== null;
}

/** The element after `node`, stepping over our banner. */
function nextSiblingOf(node: Element, ours: Element | null): Element | null {
  let next = node.nextElementSibling;
  while (next !== null && next === ours) next = next.nextElementSibling;
  return next;
}

export interface RoleLink {
  roleId: string;
  link: Element;
}

/**
 * The link to each role's editor in the role list: one per row. A row can
 * link its role twice (an icon and a name); the first one carries the badge.
 */
export function roleLinks(doc: Document, organizationId: string): RoleLink[] {
  const found: RoleLink[] = [];
  const rows = new Set<Element>();
  for (const link of Array.from(doc.querySelectorAll('a[href*="/securityroles/"]'))) {
    const roleId = roleIdFromHref(link.getAttribute("href") ?? "", organizationId);
    if (!roleId) continue;
    const row = link.closest('[role="row"], tr');
    if (row) {
      if (rows.has(row)) continue;
      rows.add(row);
    }
    found.push({ roleId, link });
  }
  return found;
}

export interface AppIdCell {
  appId: string;
  cell: Element;
}

const GRID_CELL = '[role="gridcell"], [role="cell"], td';

/**
 * The cell that shows each application user's Application ID. A row counts
 * when exactly one of its cells shows a GUID and nothing else; a row with none
 * or with two is skipped, because then the cell is not known to be the
 * Application ID.
 */
export function appIdCells(doc: Document): AppIdCell[] {
  const found: AppIdCell[] = [];
  for (const row of Array.from(doc.querySelectorAll('[role="row"], tr'))) {
    const matches: AppIdCell[] = [];
    for (const cell of Array.from(row.querySelectorAll(GRID_CELL))) {
      const appId = appIdIn(cell);
      if (appId) matches.push({ appId, cell });
    }
    if (matches.length === 1) found.push(matches[0]!);
  }
  return found;
}

/**
 * The one place the overlay reads text out of the admin center's nodes. The
 * text is tested as a whole against the shape of a GUID and is dropped unless
 * it is one; nothing else is returned, stored or sent.
 */
function appIdIn(cell: Element): string | null {
  return appIdFromCellText(cell.textContent ?? "");
}
