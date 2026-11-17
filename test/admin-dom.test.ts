// Where the admin center role banner goes (src/admin/dom.ts), on a small
// stand-in for the page's tree. The Playwright smoke test checks the same
// thing in a real browser; this pins the case a browser run does not reach:
// the banner, once drawn, must not change where it goes.

import { describe, expect, it } from "vitest";
import { bannerAnchor } from "../src/admin/dom";

/** Just enough of an element for bannerAnchor: tree links, the breadcrumb match and the computed layout. */
class FakeElement {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly name: string,
    readonly style: { display: string; flexDirection: string } = { display: "block", flexDirection: "row" },
    readonly breadcrumb = false,
  ) {}

  get childElementCount(): number {
    return this.children.length;
  }

  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  after(node: FakeElement): void {
    node.remove();
    const siblings = this.parentElement!.children;
    node.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }

  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  /** Only ever asked for the breadcrumb selector. */
  closest(): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.breadcrumb) return node;
    return null;
  }
}

class FakeDocument {
  readonly body = new FakeElement(this, "body");
  readonly defaultView = { getComputedStyle: (element: FakeElement) => element.style };

  element(name: string, options: { flexRow?: boolean; breadcrumb?: boolean } = {}): FakeElement {
    return new FakeElement(this, name, { display: options.flexRow ? "flex" : "block", flexDirection: "row" }, options.breadcrumb ?? false);
  }

  /** Only ever asked for the breadcrumb selector: every breadcrumb, in tree order. */
  querySelectorAll(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      if (node.breadcrumb) found.push(node);
      node.children.forEach(walk);
    };
    walk(this.body);
    return found;
  }
}

const anchorOf = (doc: FakeDocument, ours: FakeElement | null) =>
  (bannerAnchor(doc as unknown as Document, ours as unknown as Element | null) as unknown as FakeElement | null)?.name ?? null;

/** Draws the banner after the anchor and asks again a few times, as the controller does on each mutation. */
function settle(doc: FakeDocument): string[] {
  const banner = doc.element("pathix-admin-banner");
  const seen: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const anchor = bannerAnchor(doc as unknown as Document, banner as unknown as Element) as unknown as FakeElement;
    seen.push(anchor.name);
    if (anchor.nextElementSibling !== banner) anchor.after(banner);
  }
  return seen;
}

describe("the role banner's place", () => {
  it("stays after a breadcrumb that ends a toolbar row, and does not jump out of the row once drawn", () => {
    const doc = new FakeDocument();
    const row = doc.element("toolbar-row", { flexRow: true });
    row.append(doc.element("toolbar"), doc.element("breadcrumb", { breadcrumb: true }));
    doc.body.append(doc.element("main").append(row, doc.element("details")));

    expect(anchorOf(doc, null)).toBe("breadcrumb");
    expect(settle(doc)).toEqual(["breadcrumb", "breadcrumb", "breadcrumb", "breadcrumb"]);
  });

  it("would have flipped if the banner counted as something after the breadcrumb", () => {
    const doc = new FakeDocument();
    const row = doc.element("toolbar-row", { flexRow: true });
    const breadcrumb = doc.element("breadcrumb", { breadcrumb: true });
    row.append(doc.element("toolbar"), breadcrumb);
    doc.body.append(doc.element("main").append(row, doc.element("details")));
    const banner = doc.element("pathix-admin-banner");
    breadcrumb.after(banner);
    // Not told it is ours, the banner reads as a sibling: the place moves to the row.
    expect(anchorOf(doc, null)).toBe("toolbar-row");
    // Told, it does not.
    expect(anchorOf(doc, banner)).toBe("breadcrumb");
  });

  it("climbs out of a wrapper that holds only the breadcrumb, even with the banner drawn inside it", () => {
    const doc = new FakeDocument();
    const wrapper = doc.element("wrapper");
    const breadcrumb = doc.element("breadcrumb", { breadcrumb: true });
    wrapper.append(breadcrumb);
    doc.body.append(doc.element("main").append(wrapper, doc.element("details")));
    const banner = doc.element("pathix-admin-banner");
    breadcrumb.after(banner);
    expect(anchorOf(doc, banner)).toBe("wrapper");
    // Not told it is ours, the wrapper reads as holding two things: the place moves into it.
    expect(anchorOf(doc, null)).toBe("breadcrumb");
  });

  it("goes after a toolbar row the breadcrumb starts, and stays there", () => {
    const doc = new FakeDocument();
    const row = doc.element("toolbar-row", { flexRow: true });
    row.append(doc.element("breadcrumb", { breadcrumb: true }), doc.element("toolbar"));
    doc.body.append(doc.element("main").append(row, doc.element("details")));
    expect(settle(doc)).toEqual(["toolbar-row", "toolbar-row", "toolbar-row", "toolbar-row"]);
  });
});
