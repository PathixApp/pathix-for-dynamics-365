// What the admin center overlay draws (M14). Three kinds of host element, each
// our own with a CLOSED shadow root, so the admin center's styles and scripts
// cannot reach ours and ours cannot reach theirs. Everything inside is set with
// textContent, properties or createElementNS, never from a string of markup,
// so a name that came from a customer's data cannot inject into the page. The
// admin center's own nodes are never modified: the controller only inserts
// these hosts beside them.

import type { AppUserChipModel, RoleBadgeModel, RoleBannerModel } from "../runtime/admin-overlay";
import { findingsIcon } from "../content/findings-icon";

export const BANNER_TAG = "pathix-admin-banner";
export const BADGE_TAG = "pathix-admin-badge";
export const CHIP_TAG = "pathix-admin-chip";

/** A count that could not be loaded is "?", never 0. */
export const UNKNOWN_COUNT = "?";

const BANNER_STYLE = `
:host { all: initial; display: block; width: 100%; flex: 0 0 100%; box-sizing: border-box; margin: 8px 0; }
.banner {
  box-sizing: border-box; margin: 0; padding: 8px 12px; border-left: 4px solid #0b5cad; border-radius: 2px;
  background: #eef3f8; color: #1b1f24; font: 13px/20px "Segoe UI", system-ui, sans-serif;
}
.banner p { margin: 0; }
.head { font-weight: 600; }
.brand { color: #0b5cad; margin-right: 6px; }
.findings { display: flex; align-items: center; gap: 6px; }
.findings svg { flex: none; }
.note { color: #424b55; }
.foot { margin-top: 2px; color: #424b55; font-size: 12px; }
a { color: #0b5cad; }
a:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
  .banner { background: #1f2933; color: #e6edf3; border-left-color: #4493f8; }
  .brand, a { color: #79b8ff; }
  .note, .foot { color: #b4bcc6; }
}
`;

const SMALL_STYLE = `
:host { all: initial; display: inline-block; margin: 0 0 0 8px; vertical-align: middle; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; padding: 0 6px; border-radius: 3px;
  background: #eef3f8; color: #3b4651; font: 11px/18px "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums;
  text-decoration: none; white-space: nowrap; cursor: pointer;
}
span.pill { cursor: default; }
.pill:hover { background: #deecf9; color: #11161c; }
.pill:focus-visible { outline: 2px solid #0078d4; outline-offset: 1px; }
.brand { font-weight: 600; }
.flag { display: inline-flex; align-items: center; gap: 3px; }
.flag svg { display: block; flex: none; }
@media (prefers-color-scheme: dark) {
  .pill { background: #263340; color: #d3dae1; }
  .pill:hover { background: #324557; color: #ffffff; }
}
`;

/** A host and its closed root. The root is kept: a closed root cannot be read back from the host. */
export interface Drawn {
  host: HTMLElement;
  root: ShadowRoot;
}

function hostWithRoot(doc: Document, tag: string, style: string): Drawn {
  const host = doc.createElement(tag);
  const root = host.attachShadow({ mode: "closed" });
  applyStyle(doc, root, style);
  return { host, root };
}

/**
 * A constructed stylesheet is not an inline style, so a page's style-src policy
 * does not block it. Where one cannot be made, a style element is the fallback.
 */
function applyStyle(doc: Document, root: ShadowRoot, style: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const styles = doc.createElement("style");
    styles.textContent = style;
    root.append(styles);
  }
}

function line(doc: Document, className: string, text: string): HTMLElement {
  const element = doc.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function openLink(doc: Document, text: string, href: string): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.textContent = text;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

/** The count beside the findings icon. The icon keeps its own accessible name. */
function flag(doc: Document, count: number | null, floor: boolean, className: string): HTMLElement {
  const element = doc.createElement("span");
  element.className = className;
  element.append(findingsIcon(false), doc.createTextNode(count === null ? UNKNOWN_COUNT : `${count}${floor ? "+" : ""}`));
  return element;
}

// --- the role editor banner ----------------------------------------------------------

export function drawBanner(doc: Document, model: RoleBannerModel): Drawn {
  const drawn = hostWithRoot(doc, BANNER_TAG, BANNER_STYLE);
  const banner = doc.createElement("section");
  banner.className = "banner";
  banner.ariaLabel = "Pathix: who holds this role";

  const head = line(doc, "head", model.assigned);
  const brand = doc.createElement("span");
  brand.className = "brand";
  brand.textContent = "Pathix";
  head.prepend(brand);

  const findings = doc.createElement("p");
  findings.className = "findings";
  const icon = findingsIcon(true);
  findings.append(icon, doc.createTextNode(model.findings));

  const foot = line(doc, "foot", `${model.scan}. `);
  foot.append(openLink(doc, "Open in Pathix", model.href));

  banner.append(head, findings);
  if (model.teams) banner.append(line(doc, "note", model.teams));
  if (model.copies) banner.append(line(doc, "note", model.copies));
  banner.append(foot);
  drawn.root.append(banner);
  return drawn;
}

// --- the role-list badge ---------------------------------------------------------------

export function drawBadge(doc: Document, model: RoleBadgeModel): Drawn {
  const drawn = hostWithRoot(doc, BADGE_TAG, SMALL_STYLE);
  const pill = doc.createElement("a");
  pill.className = "pill";
  pill.href = model.href;
  pill.target = "_blank";
  pill.rel = "noopener noreferrer";
  pill.title = model.title;
  pill.ariaLabel = model.title;
  const brand = doc.createElement("span");
  brand.className = "brand";
  brand.textContent = "Pathix";
  const assigned = doc.createElement("span");
  assigned.textContent = model.assigned;
  pill.append(brand, assigned, flag(doc, model.findingsCount, model.findingsFloor, "flag"));
  // A click on the badge opens Pathix. It must not also select or open the row.
  pill.addEventListener("click", (event) => event.stopPropagation());
  drawn.root.append(pill);
  return drawn;
}

// --- the application-user chip -------------------------------------------------------------

/** The chip sits before the Application ID, so its gap is on its right. */
const CHIP_STYLE = `${SMALL_STYLE}
:host { margin: 0 8px 0 0; }
`;

export function drawChip(doc: Document, model: AppUserChipModel): Drawn {
  const drawn = hostWithRoot(doc, CHIP_TAG, CHIP_STYLE);
  const pill = doc.createElement(model.href ? "a" : "span");
  pill.className = "pill";
  pill.title = model.title;
  pill.ariaLabel = model.title;
  pill.textContent = model.text;
  if (model.href && pill instanceof HTMLAnchorElement) {
    pill.href = model.href;
    pill.target = "_blank";
    pill.rel = "noopener noreferrer";
    pill.addEventListener("click", (event) => event.stopPropagation());
  }
  drawn.root.append(pill);
  return drawn;
}
