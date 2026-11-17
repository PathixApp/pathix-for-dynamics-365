// The findings icon, defined once. The X-ray line and the hover card both use
// it, so a finding looks the same everywhere. It is lucide's Flag, the icon the
// Pathix UI uses for findings.
//
// It inherits currentColor, and its shape never encodes severity. Built with
// createElementNS, never from a string of markup.

const SVG_NS = "http://www.w3.org/2000/svg";

// lucide flag, lucide-react 1.11.0, ISC license.
const FLAG_PATH =
  "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528";

/** What a screen reader says for the icon when no nearby text already does. */
export const FINDING_LABEL = "Finding";

/**
 * `nearbyText` is true when text beside the icon already says "findings" (the
 * card's "Findings" label). The icon is then hidden from assistive technology.
 * Otherwise its accessible name is "Finding".
 */
export function findingsIcon(nearbyText: boolean, size = 12): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("focusable", "false");
  if (nearbyText) {
    svg.setAttribute("aria-hidden", "true");
  } else {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", FINDING_LABEL);
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", FLAG_PATH);
  svg.append(path);
  return svg;
}
