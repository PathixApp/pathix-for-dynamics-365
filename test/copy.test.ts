// Copy rules for Lite's footer lines and chip (CLAUDE.md, "Copy rules"). A
// footer line names what its card cannot see and what Pathix does about it,
// with the word "Pathix" as the link. It never shows a Pathix number or
// result, never counts or lists writers, and is never an "upgrade" button.
// Dismissing it and the policy that turns it off are tested in
// test/lite-card.test.ts.

import { describe, expect, it } from "vitest";
import { EVENT_MAP_TIP } from "../src/card/event-map";
import { DEPENDENCIES_TIP, LITE_CHIP_TITLE, PATHIX_SITE, type TipLine } from "../src/card/lite";
import { LOCKED_TIP } from "../src/card/locked";
import { REGISTERED_TIP } from "../src/card/registered";
import { SAVE_PREVIEW_TIP } from "../src/card/save-preview";
import { WHAT_CHANGED_TIP } from "../src/card/what-changed";
import { tipParts, UNKNOWN_STAT } from "../src/content/card-view";

const TIPS: Array<[string, TipLine]> = [
  ["registered to fire", REGISTERED_TIP],
  ["platform dependencies", DEPENDENCIES_TIP],
  ["why can't I edit", LOCKED_TIP],
  ["form event map", EVENT_MAP_TIP],
  ["what changed", WHAT_CHANGED_TIP],
  ["save preview", SAVE_PREVIEW_TIP],
];

describe("footer lines", () => {
  it.each(TIPS)("%s: links the word Pathix to pathix.app", (_card, tip) => {
    expect(tip.linkText).toBe("Pathix");
    expect(tip.href).toBe(PATHIX_SITE);
    expect(tip.text).toContain(" Pathix ");
    const parts = tipParts(tip);
    expect(parts.filter((part) => part.link)).toEqual([{ text: "Pathix", link: true }]);
    expect(parts.map((part) => part.text).join("")).toBe(tip.text);
  });

  it.each(TIPS)("%s: names a blind spot first, then what Pathix does", (_card, tip) => {
    const [blindSpot, pathix] = tip.text.split(/(?<=\.) /);
    expect(blindSpot).not.toMatch(/Pathix/);
    expect(pathix).toMatch(/^Pathix /);
  });

  it.each(TIPS)("%s: shows no number, no writers, no upgrade, no em dash", (_card, tip) => {
    expect(tip.text).not.toMatch(/\d/);
    expect(tip.text).not.toMatch(/writers?\b/i);
    expect(tip.text).not.toMatch(/upgrade|found/i);
    expect(tip.text).not.toContain("—");
  });
});

describe("the LITE chip", () => {
  it("says what Lite reads and what connecting Pathix adds", () => {
    expect(LITE_CHIP_TITLE).toBe("Reads Dataverse metadata as you. Connect Pathix to see what actually writes each column.");
    expect(LITE_CHIP_TITLE).not.toMatch(/\d|upgrade|—/i);
  });
});

describe("a stat that could not be loaded", () => {
  it("shows ?, never a dash or zero", () => {
    expect(UNKNOWN_STAT).toBe("?");
  });
});
