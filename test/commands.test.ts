// Keyboard shortcuts are manifest commands (src/runtime/commands.ts). The
// service worker's onCommand sends the tab the same content command the popup
// sends; the browser owns the keys.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bindingsFrom, COMMAND_MESSAGES, isCommandName, runCommand, type CommandDeps } from "../src/runtime/commands";
import { isContentCommand } from "../src/runtime/messages";

function deps(send: CommandDeps["send"] = async () => true, active: number | undefined = 9) {
  return { send: vi.fn(send), activeTabId: vi.fn(async () => active) };
}

describe("a keyboard command in the service worker", () => {
  it.each([
    ["toggle-xray", { kind: "toggleXray" }],
    ["open-event-map", { kind: "openEventMap" }],
    ["open-what-changed", { kind: "openWhatChanged" }],
    ["open-save-preview", { kind: "openSavePreview" }],
    ["open-field-card", { kind: "openFieldCard" }],
  ])("sends %s to the tab it was pressed in as %j", async (command, message) => {
    const d = deps();
    await runCommand(command, 4, d);
    expect(d.send).toHaveBeenCalledWith(4, message);
    expect(d.activeTabId).not.toHaveBeenCalled();
    expect(isContentCommand(message)).toBe(true);
  });

  it("falls back to the active tab when the browser names none", async () => {
    const d = deps();
    await runCommand("open-event-map", undefined, d);
    expect(d.send).toHaveBeenCalledWith(9, { kind: "openEventMap" });
  });

  it("does nothing when there is no tab at all", async () => {
    const d = { send: vi.fn(async () => true), activeTabId: vi.fn(async () => undefined) };
    await runCommand("open-event-map", undefined, d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it.each(["_execute_action", "toggle-everything", "", "toString", "__proto__"])("ignores %j", async (command) => {
    const d = deps();
    await runCommand(command, 4, d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("swallows a tab with no content script, and opens nothing", async () => {
    const d = deps(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    await expect(runCommand("toggle-xray", 4, d)).resolves.toBeUndefined();
  });

  it("is registered synchronously in the worker and routed through runCommand", () => {
    const worker = readFileSync("src/background/service-worker.ts", "utf8");
    expect(worker).toMatch(/chrome\.commands\.onCommand\.addListener\(\(command, tab\) => \{\s*void runCommand\(command, tab\?\.id,/);
  });
});

describe("the commands' names", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

  it("cover every manifest command but the popup's own", () => {
    expect(Object.keys(manifest.commands).filter((name) => name !== "_execute_action").sort()).toEqual(Object.keys(COMMAND_MESSAGES).sort());
  });

  it("are recognized only by their own names", () => {
    expect(isCommandName("open-event-map")).toBe(true);
    expect(isCommandName("_execute_action")).toBe(false);
    expect(isCommandName("hasOwnProperty")).toBe(false);
    expect(isCommandName(undefined)).toBe(false);
  });

  it("read the browser's bindings, an empty key as none, and ignore commands it does not know", () => {
    expect(
      bindingsFrom([
        { name: "_execute_action", shortcut: "Alt+Shift+Q" },
        { name: "toggle-xray", shortcut: "Alt+Shift+X" },
        { name: "open-save-preview", shortcut: "" },
        { name: "open-field-card" },
        { name: "something-else", shortcut: "Ctrl+Q" },
      ]),
    ).toEqual({ "toggle-xray": "Alt+Shift+X", "open-save-preview": null, "open-field-card": null });
  });
});
