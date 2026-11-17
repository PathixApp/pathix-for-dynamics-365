// The toolbar badge (M8): the scan's age on the icon, the environment name in
// the tooltip. Set on the tab of a connected D365 form, cleared everywhere
// else. Lite shows nothing. An age that cannot be read is "?", never "0d".

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BadgeRefresh, type BadgeRefreshDeps } from "../src/content/badge-refresh";
import { badgeFor, TabBadges, type BadgeDeps } from "../src/runtime/badge";
import { formatDay, scanAgeBadge, scanAgeWords } from "../src/runtime/dates";
import { CHANNEL, SNAPSHOT_VERSION, type FormSnapshot, type NoFormMessage } from "../src/bridge/messages";
import type { ConnectionStatus } from "../src/runtime/messages";
import { refreshBadgeListener } from "../src/runtime/toolbar";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const connected = (latestCompletedScanAt: string | null, environmentName = "Contoso Dev"): ConnectionStatus => ({
  kind: "connected",
  environmentId: "env-1",
  environmentName,
  latestCompletedScanAt,
});

describe("the scan age on the badge", () => {
  it.each([
    [10 * 60 * 1000, "<1h"],
    [5 * HOUR + 1000, "5h"],
    [23 * HOUR + 59 * 60 * 1000, "23h"],
    [24 * HOUR, "1d"],
    [3 * DAY + 2 * HOUR, "3d"],
    [999 * DAY, "999d"],
    [1500 * DAY, "999+"],
    [-5 * HOUR, "<1h"],
  ])("reads %s ms as %s", (age, expected) => {
    expect(scanAgeBadge(ago(age), NOW)).toBe(expected);
  });

  it("is at most four characters for any age", () => {
    for (const age of [0, HOUR, 9 * DAY, 99 * DAY, 100 * DAY, 999 * DAY, 5000 * DAY]) {
      expect(scanAgeBadge(ago(age), NOW).length).toBeLessThanOrEqual(4);
    }
  });

  it("shows ? for an age it cannot read, never 0d", () => {
    expect(scanAgeBadge(null, NOW)).toBe("?");
    expect(scanAgeBadge("not a date", NOW)).toBe("?");
    expect(scanAgeWords(null, NOW)).toBe("unknown");
    expect(scanAgeWords("not a date", NOW)).toBe("unknown");
  });

  it("says the age in words for the tooltip", () => {
    expect(scanAgeWords(ago(10 * 60 * 1000), NOW)).toBe("less than an hour ago");
    expect(scanAgeWords(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(scanAgeWords(ago(3 * DAY), NOW)).toBe("3 days ago");
  });
});

describe("the badge for a tab's connection", () => {
  it("puts the age on the icon and the environment and age in the tooltip", () => {
    expect(badgeFor(connected(ago(3 * DAY + HOUR)), NOW)).toEqual({
      text: "3d",
      title: "Pathix: Contoso Dev\nLatest Completed scan 3 days ago\nClick for X-ray, the event map and more.",
    });
  });

  it("shows ? with the reason when there is no Completed scan yet", () => {
    expect(badgeFor(connected(null), NOW)).toEqual({
      text: "?",
      title: "Pathix: Contoso Dev\nNo Completed scan yet\nClick for X-ray, the event map and more.",
    });
  });

  it("shows ? and says the latest Completed scan is unknown when Pathix's scan list is full with none", () => {
    expect(badgeFor({ ...connected(null), latestCompletedScanUnknown: true } as ConnectionStatus, NOW)).toEqual({
      text: "?",
      title: "Pathix: Contoso Dev\nLatest Completed scan unknown\nClick for X-ray, the event map and more.",
    });
  });

  it("shows ? when the scan time cannot be read", () => {
    expect(badgeFor(connected("garbage"), NOW)?.text).toBe("?");
  });

  it.each<[string, ConnectionStatus]>([
    ["not set up (Lite)", { kind: "notConfigured" }],
    ["signed out", { kind: "signedOut", reason: "no token" }],
    ["refused", { kind: "unauthorized", status: 403 }],
    ["not scanned", { kind: "notScanned" }],
    ["an error", { kind: "error", message: "down" }],
  ])("has no badge when %s", (_label, status) => {
    expect(badgeFor(status, NOW)).toBeNull();
  });

  it("puts no em dash in the tooltip", () => {
    expect(badgeFor(connected(ago(DAY)), NOW)?.title).not.toContain("—");
  });
});

describe("TabBadges", () => {
  function setup() {
    const deps: BadgeDeps & { setText: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } = {
      setText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
      defaultTitle: "Pathix: toggle X-ray",
    };
    return { deps, badges: new TabBadges(deps) };
  }

  it("sets the badge on the tab the snapshot came from", async () => {
    const { deps, badges } = setup();
    await badges.apply(7, connected(ago(2 * DAY)), NOW);
    expect(deps.setText).toHaveBeenCalledWith(7, "2d");
    expect(deps.setTitle).toHaveBeenCalledWith(7, expect.stringContaining("Contoso Dev"));
  });

  it("clears the badge and restores the default tooltip when the tab is no longer connected", async () => {
    const { deps, badges } = setup();
    await badges.apply(7, connected(ago(2 * DAY)), NOW);
    await badges.apply(7, { kind: "signedOut", reason: "no token" }, NOW);
    expect(deps.setText).toHaveBeenLastCalledWith(7, "");
    expect(deps.setTitle).toHaveBeenLastCalledWith(7, "Pathix: toggle X-ray");
  });

  it("writes nothing for a message with no tab, and rewrites a tab on every snapshot so a badge Chrome cleared comes back", async () => {
    const { deps, badges } = setup();
    await badges.apply(undefined, connected(ago(DAY)), NOW);
    expect(deps.setText).not.toHaveBeenCalled();
    await badges.apply(7, connected(ago(DAY)), NOW);
    await badges.apply(7, connected(ago(DAY)), NOW);
    expect(deps.setText).toHaveBeenCalledTimes(2);
    expect(deps.setText).toHaveBeenLastCalledWith(7, "1d");
  });

  it("rewrites the text when the same status is applied later and the age has moved", async () => {
    const { deps, badges } = setup();
    const status = connected(ago(2 * HOUR));
    await badges.apply(7, status, NOW);
    expect(deps.setText).toHaveBeenLastCalledWith(7, "2h");
    await badges.apply(7, status, NOW + 3 * DAY);
    expect(deps.setText).toHaveBeenLastCalledWith(7, "3d");
    expect(deps.setTitle).toHaveBeenLastCalledWith(7, expect.stringContaining("3 days ago"));
  });

  it("clears every tab, and sets the badge again after a new page loads", async () => {
    const { deps, badges } = setup();
    await badges.apply(1, connected(ago(DAY)), NOW);
    await badges.apply(2, connected(ago(DAY)), NOW);
    await badges.clearAll([1, 2, 3]);
    expect(deps.setText.mock.calls.filter(([, text]) => text === "").map(([tab]) => tab).sort()).toEqual([1, 2, 3]);
    await badges.apply(1, connected(ago(DAY)), NOW);
    expect(deps.setText).toHaveBeenLastCalledWith(1, "1d");
  });

  it("does not fail when the tab is gone", async () => {
    const { deps, badges } = setup();
    deps.setText.mockRejectedValueOnce(new Error("No tab with id: 7."));
    await expect(badges.apply(7, connected(ago(DAY)), NOW)).resolves.toBeUndefined();
    await badges.apply(7, connected(ago(DAY)), NOW);
    expect(deps.setText).toHaveBeenCalledTimes(2);
  });
});

describe("the badge wiring", () => {
  const worker = readFileSync("src/background/service-worker.ts", "utf8");

  it("is set from a form snapshot's connection status, on that snapshot's tab", () => {
    expect(worker).toContain("void badges.apply(sender.tab?.id, status);");
  });

  it("is refreshed by the content script, so a form left open keeps a true age", () => {
    const content = readFileSync("src/content/content.ts", "utf8");
    expect(content).toContain("const refreshBadge = () => badgeRefresh.refresh();");
    expect(content).toContain('addEventListener("visibilitychange", refreshBadge)');
    expect(content).toContain("setInterval(refreshBadge, BADGE_REFRESH_MS)");
    expect(content).toContain('addEventListener("navigatesuccess", refreshBadge)');
    expect(content).toContain("refreshBadgeListener(chrome.runtime.id, () => badgeRefresh.refresh())");
    expect(content).not.toMatch(/location\s*\.\s*href/);
    expect(content).toContain("badgeRefresh.onPageMessage(message)");
  });

  it("is cleared on sign-out, on a new Pathix address and when a tab loads a new page", () => {
    expect(worker).toMatch(/signOut"\) \{[^}]*disconnect\(\);/s);
    expect(worker).toMatch(/"pathixUrl" in changes[^]*?disconnect\(\);/);
    expect(worker).toMatch(/changeInfo\.status === "loading"\) \{\s*void badges\.reset\(tabId\);/);
  });

  it("is restored by a tab update that carries no address, and only on a tab with a content script", () => {
    expect(worker).toContain('changeInfo.status === "complete"');
    expect(worker).toContain('const refresh: RefreshBadgeCommand = { kind: "refreshBadge" };');
    expect(worker).toContain("chrome.tabs.sendMessage(tabId, refresh).catch(");
  });

  it("uses chrome.action only, which needs no permission, and never the page", () => {
    expect(worker).toContain("chrome.action.setBadgeText");
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { permissions: string[] };
    expect(manifest.permissions).toEqual(["identity", "storage", "scripting"]);
  });
});

describe("formatDay", () => {
  it("writes the month and day, and the year only when it is not this year", () => {
    expect(formatDay("2026-08-12T12:00:00Z", NOW, "en-US")).toBe("Aug 12");
    expect(formatDay("2025-08-12T12:00:00Z", NOW, "en-US")).toBe("Aug 12, 2025");
  });

  it("gives null for a timestamp it cannot read", () => {
    expect(formatDay("nope", NOW, "en-US")).toBeNull();
  });
});

describe("the badge refresh on a tab left open", () => {
  const snapshot: FormSnapshot = {
    channel: CHANNEL,
    kind: "formSnapshot",
    version: SNAPSHOT_VERSION,
    organizationId: "11111111-1111-1111-1111-111111111111",
    host: "contoso.crm.dynamics.com",
    table: "account",
    formId: null,
    columns: [],
    dirtyColumns: [],
    lockedControls: [],
    saveKind: null,
    alwaysSubmitColumns: [],
    quickViewColumns: [],
  };
  const noForm: NoFormMessage = { channel: CHANNEL, kind: "noForm", version: SNAPSHOT_VERSION, reason: "noFormContext" };

  function setup() {
    const state = { visible: true };
    const relay = vi.fn();
    const deps: BadgeRefreshDeps = {
      relay,
      isVisible: () => state.visible,
    };
    return { refresh: new BadgeRefresh(deps), relay, state };
  }

  it("sends nothing before a form has been seen", () => {
    const { refresh, relay } = setup();
    refresh.refresh();
    expect(relay).not.toHaveBeenCalled();
  });

  it("re-sends the last form snapshot only while the tab is in front", () => {
    const { refresh, relay, state } = setup();
    refresh.onPageMessage(snapshot);
    state.visible = false;
    refresh.refresh();
    expect(relay).not.toHaveBeenCalled();
    state.visible = true;
    refresh.refresh();
    expect(relay).toHaveBeenCalledWith(snapshot);
  });

  it("keeps the badge, and its advancing age, after a move to a page with no form", () => {
    const { refresh, relay } = setup();
    refresh.onPageMessage(snapshot);
    refresh.onPageMessage(noForm);
    refresh.refresh();
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledWith(snapshot);
  });

  it("has no way to read the page address", () => {
    const source = readFileSync("src/content/badge-refresh.ts", "utf8");
    expect(source).not.toMatch(/currentAddress|checkAddress|location/);
  });
});

describe("the refreshBadge command", () => {
  it("is accepted only from this extension, and re-sends the badge", () => {
    const refresh = vi.fn();
    const respond = vi.fn();
    const listener = refreshBadgeListener("ext-id", refresh);
    listener({ kind: "refreshBadge" }, { id: "other" }, respond);
    listener({ kind: "toggleXray" }, { id: "ext-id" }, respond);
    expect(refresh).not.toHaveBeenCalled();
    listener({ kind: "refreshBadge" }, { id: "ext-id" }, respond);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true);
  });
});
