// Empty and error states (M4): one wording for every card and the X-ray
// legend, and never a count in place of an answer.

import { describe, expect, it } from "vitest";
import { DATAVERSE_ERROR, NO_ANSWER, stateForConnection, stateLine, type CardState } from "../src/card/states";
import { createDataverseClient, type DataverseGet } from "../src/dataverse/client";
import { loadDependenciesCard } from "../src/lite/dependencies";
import { loadLockedCard } from "../src/lite/locked";
import { loadRegisteredCard } from "../src/lite/registered";
import type { ConnectionStatus } from "../src/runtime/messages";
import { fakeDataverse, ORIGIN } from "./fake-dataverse";

const FORM_ID = "5c4a0000-0000-4000-8000-000000000021";

const STATUSES: Array<[string, ConnectionStatus]> = [
  ["not set up", { kind: "notConfigured" }],
  ["signed out", { kind: "signedOut", reason: "no token" }],
  ["refused", { kind: "unauthorized", status: 403 }],
  ["not scanned", { kind: "notScanned" }],
  ["no Completed scan", { kind: "connected", environmentId: "e", environmentName: "Contoso Sales", latestCompletedScanAt: null }],
  [
    "latest Completed scan unknown",
    { kind: "connected", environmentId: "e", environmentName: "Contoso Sales", latestCompletedScanAt: null, latestCompletedScanUnknown: true },
  ],
  ["unreachable", { kind: "error", message: "Failed to fetch" }],
];

describe("stateForConnection", () => {
  it.each(STATUSES)("gives %s its own state", (_label, status) => {
    expect(stateForConnection(status)).not.toBeNull();
  });

  it("gives every status a different state", () => {
    const kinds = STATUSES.map(([, status]) => stateForConnection(status)?.kind);
    expect(new Set(kinds).size).toBe(STATUSES.length);
  });

  it("shows the card once there is a Completed scan", () => {
    expect(stateForConnection({ kind: "connected", environmentId: "e", environmentName: "Contoso", latestCompletedScanAt: "2026-10-03T02:30:00Z" })).toBeNull();
  });

  it("says there is no Completed scan yet, naming the environment, and shows no count", () => {
    const state = stateForConnection(STATUSES[4]![1])!;
    expect(state).toMatchObject({ kind: "noCompletedScan", title: "No Completed scan yet" });
    expect(state.text).toContain("Contoso Sales");
    expect(state.text).not.toMatch(/\d/);
  });

  it("says the latest Completed scan is unknown, never that there is none, when Pathix's list is full", () => {
    const state = stateForConnection(STATUSES[5]![1])!;
    expect(state).toMatchObject({ kind: "completedScanUnknown", title: "Latest Completed scan unknown" });
    expect(state.text).toContain("Contoso Sales");
    expect(state.text).not.toMatch(/no Completed scan|not finished|\d/i);
  });

  it("says no environment matches, never that Pathix does not scan the environment", () => {
    const state = stateForConnection({ kind: "notScanned" })!;
    expect(state).toMatchObject({ kind: "notScanned", title: "No matching Pathix environment", text: "Pathix has no environment that matches this organization." });
    expect(`${state.title} ${state.text}`).not.toMatch(/does not scan|not in your Pathix/);
  });

  it("offers the options page only where the fix is there", () => {
    const withAction = STATUSES.filter(([, status]) => stateForConnection(status)?.action === "openOptions").map(([label]) => label);
    expect(withAction).toEqual(["not set up", "signed out"]);
  });

  it("keeps the detail of an unreachable Pathix short", () => {
    const state = stateForConnection({ kind: "error", message: `${"x".repeat(400)}\n\n` })!;
    expect(state.text.length).toBeLessThan(260);
    expect(state.text).toMatch(/x\.\.\.$/);
    expect(stateForConnection({ kind: "error", message: "  " })!.text).toBe("Check your connection and try again.");
    expect(stateForConnection({ kind: "error", message: "Failed to fetch" })!.text).toBe("Check your connection and try again. Details: Failed to fetch.");
  });
});

describe("state copy", () => {
  const all: CardState[] = [...STATUSES.map(([, status]) => stateForConnection(status)!), DATAVERSE_ERROR, NO_ANSWER];

  it.each(all.map((state) => [state.kind, state] as const))("%s uses no em dash, never says writers, and never shows zero", (_kind, state) => {
    const text = `${state.title} ${state.text}`;
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/writer/i);
    expect(text).not.toMatch(/\b0\b|nothing found/i);
  });

  it("reads as one line in the X-ray legend", () => {
    expect(stateLine(NO_ANSWER)).toBe("The extension did not answer. Reload the page and try again.");
  });
});

describe("every Lite card, when Dataverse refuses or fails everything", () => {
  const cards = {
    dependencies: async (get: DataverseGet) => {
      const card = await loadDependenciesCard(get, { table: "account", column: "creditlimit", showTips: true });
      return [card.headline];
    },
    registered: async (get: DataverseGet) => {
      const card = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: ["name"], showTips: true });
      return [card.headline, ...card.unknowns, card.edits!.headline, ...card.edits!.unknowns];
    },
    locked: async (get: DataverseGet) => {
      const card = await loadLockedCard(get, { table: "account", column: "creditlimit", control: "creditlimit", formId: FORM_ID, showTips: true });
      expect(card.lines.every((line) => line.state === "unknown")).toBe(true);
      return [card.headline, ...card.lines.map((line) => line.text)];
    },
  };

  it.each(Object.keys(cards).flatMap((name) => [[name, 403], [name, 500]] as const))("%s says so on HTTP %i, and never shows zero", async (name, status) => {
    const server = fakeDataverse();
    server.failWhen("", status);
    const lines = await cards[name as keyof typeof cards](createDataverseClient(ORIGIN, server.fetch));
    const text = lines.join(" ");
    if (status === 403 && name !== "locked") expect(text).toMatch(/don't have access/);
    expect(text).toMatch(status === 403 ? /don't have access|Could not read|could not read/ : /Could not read|could not read/);
    expect(text).not.toMatch(/\b0\b|nothing found|Nothing is registered/);
  });
});
