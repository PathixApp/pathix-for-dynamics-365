// The content script's side of the popup and the keyboard commands: each
// reaches its controller's public entry point. Keys are manifest commands,
// never page key handlers. Also the connection cache, which keeps "no
// Completed scan yet" only briefly.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONNECTION_TTL_MS, connectionTtl, SHORT_TTL_MS } from "../src/background/connection";
import type { ConnectionStatus, ConnectionStatusAnswer, FieldCardOpen, FormState } from "../src/runtime/messages";
import { contentCommandListener, type ContentCommandHandlers } from "../src/runtime/toolbar";

const STATE: FormState = { kind: "formState", form: true, xray: false };
const CONNECTION: ConnectionStatusAnswer = { kind: "connectionStatus", connection: { kind: "notScanned" } };
const VOID_HANDLERS = ["toggleXray", "openEventMap", "openWhatChanged", "openSavePreview"] as const;

function handlers() {
  return {
    formState: vi.fn(() => STATE),
    connectionStatus: vi.fn(async () => CONNECTION),
    setXray: vi.fn((on: boolean) => on),
    toggleXray: vi.fn(),
    openEventMap: vi.fn(),
    openWhatChanged: vi.fn(),
    openSavePreview: vi.fn(),
    openFieldCard: vi.fn((): FieldCardOpen => "opened"),
  } satisfies ContentCommandHandlers;
}

describe("the content script's command listener", () => {
  it.each(VOID_HANDLERS)("routes %s to its handler and answers at once", (kind) => {
    const h = handlers();
    const respond = vi.fn();
    const keepOpen = contentCommandListener("ext-id", h)({ kind }, { id: "ext-id" }, respond);
    expect(h[kind]).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true);
    expect(keepOpen).toBeUndefined();
    for (const other of VOID_HANDLERS) if (other !== kind) expect(h[other]).not.toHaveBeenCalled();
  });

  it.each<FieldCardOpen>(["opened", "noField", "noCard"])("opens the field card and answers whether it opened, or why not (%s)", (opened) => {
    const h = handlers();
    h.openFieldCard.mockReturnValueOnce(opened);
    const respond = vi.fn();
    expect(contentCommandListener("ext-id", h)({ kind: "openFieldCard" }, { id: "ext-id" }, respond)).toBeUndefined();
    expect(h.openFieldCard).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(opened);
    for (const other of VOID_HANDLERS) expect(h[other]).not.toHaveBeenCalled();
  });

  it("sets X-ray and answers whether it is now on", () => {
    const h = handlers();
    const respond = vi.fn();
    contentCommandListener("ext-id", h)({ kind: "setXray", on: true }, { id: "ext-id" }, respond);
    expect(h.setXray).toHaveBeenCalledWith(true);
    expect(respond).toHaveBeenCalledWith(true);
  });

  it("answers the form state at once, without waiting on the connection", () => {
    const h = handlers();
    const respond = vi.fn();
    expect(contentCommandListener("ext-id", h)({ kind: "formState" }, { id: "ext-id" }, respond)).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(STATE);
    expect(h.connectionStatus).not.toHaveBeenCalled();
  });

  it("answers the connection asynchronously, keeping the channel open", async () => {
    const h = handlers();
    const respond = vi.fn();
    expect(contentCommandListener("ext-id", h)({ kind: "connectionStatus" }, { id: "ext-id" }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(CONNECTION));
  });

  it("answers undefined when the connection fails, so the popup does not wait forever", async () => {
    const h = handlers();
    h.connectionStatus.mockRejectedValueOnce(new Error("worker gone"));
    const respond = vi.fn();
    contentCommandListener("ext-id", h)({ kind: "connectionStatus" }, { id: "ext-id" }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(undefined));
  });

  it("answers the form state from the content script's own state: no worker call", () => {
    const content = readFileSync("src/content/content.ts", "utf8");
    const body = content.slice(content.indexOf("function formState(): FormState {"));
    // The script's body is inside start(), so its functions end at "\n  }".
    expect(body.slice(0, body.indexOf("\n  }\n"))).not.toMatch(/await|sendMessage|relaySnapshot|askSettings/);
  });

  it.each([
    ["another extension", { kind: "openEventMap" }, { id: "other" }],
    ["a command with extra fields", { kind: "openEventMap", table: "account" }, { id: "ext-id" }],
    ["setXray without a boolean", { kind: "setXray", on: "yes" }, { id: "ext-id" }],
    ["toggleXray with extra fields", { kind: "toggleXray", on: true }, { id: "ext-id" }],
    ["another message", { kind: "refreshBadge" }, { id: "ext-id" }],
  ])("ignores %s", (_label, message, sender) => {
    const h = handlers();
    const respond = vi.fn();
    expect(contentCommandListener("ext-id", h)(message, sender, respond)).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the content script's routing", () => {
  const content = readFileSync("src/content/content.ts", "utf8");

  it("registers one listener for the popup and the keyboard commands, each on its controller's entry point", () => {
    expect(content).toMatch(/chrome\.runtime\.onMessage\.addListener\(\s*contentCommandListener\(chrome\.runtime\.id, \{/);
    expect(content).toContain("toggleXray: () => xray.toggle(),");
    expect(content).toContain("openEventMap: () => eventMap.open(),");
    expect(content).toContain("openWhatChanged: () => whatChanged.open(),");
    expect(content).toContain("openSavePreview: () => savePreview.open(),");
    expect(content).toContain("openFieldCard: () => hover.openFocused(),");
    expect(content).toContain("xray.setOn(on);");
  });

  it.each(["event-map", "what-changed", "save-preview"])("the %s controller opens through open() and closes on Escape", (name) => {
    const source = readFileSync(`src/content/${name}-controller.ts`, "utf8");
    expect(source).toMatch(/open\(\): void \{\s*if \(!this\.on\) this\.turnOn\(\);/);
    expect(source).toMatch(/close\(\): void \{\s*if \(this\.on\) this\.turnOff\(\);/);
    expect(source).toContain('if (event.key === "Escape") this.close();');
  });

  it("the X-ray switch goes through the keyboard command's toggle()", () => {
    const source = readFileSync("src/content/xray-controller.ts", "utf8");
    expect(source).toMatch(/setOn\(on: boolean\): void \{\s*if \(on !== this\.on\) this\.toggle\(\);/);
  });

  // Shortcuts are manifest commands: the browser owns the keys, so a page
  // handler can never collide with a browser key (Edge's Alt+Shift+S) or
  // swallow an AltGr or Option character.
  it("has no page key handler for a shortcut anywhere in the content script", () => {
    const dir = "src/content";
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/altKey|shiftKey|ctrlKey|metaKey|event\.code\b|"Key[A-Z]"/);
    }
  });

  it("no longer listens for the toolbar button's old click", () => {
    expect(readFileSync("src/background/service-worker.ts", "utf8")).not.toContain("chrome.action.onClicked");
  });
});

describe("how long a connection status is kept", () => {
  const connected = (latestCompletedScanAt: string | null): ConnectionStatus => ({
    kind: "connected",
    environmentId: "env-1",
    environmentName: "Dev",
    latestCompletedScanAt,
  });

  it("keeps a connected status with a Completed scan for five minutes", () => {
    expect(connectionTtl(connected("2026-10-05T10:00:00Z"))).toBe(CONNECTION_TTL_MS);
    expect(CONNECTION_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("keeps 'no Completed scan yet' for about thirty seconds, so a finished scan shows up soon", () => {
    expect(connectionTtl(connected(null))).toBe(SHORT_TTL_MS);
    expect(SHORT_TTL_MS).toBe(30 * 1000);
  });

  it("keeps failures briefly", () => {
    expect(connectionTtl({ kind: "error", message: "x" })).toBe(SHORT_TTL_MS);
    expect(connectionTtl({ kind: "signedOut", reason: "no token" })).toBe(SHORT_TTL_MS);
  });
});
