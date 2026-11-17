// Keyboard shortcuts are manifest commands (the manifest's `commands` key),
// never keydown handlers on the page. The browser owns the keys: it lists
// them at edge://extensions/shortcuts (chrome://extensions/shortcuts in
// Chrome), lets the user rebind or clear any of them, and never sends a page
// key that a command did not claim. So a shortcut cannot collide with the
// browser's own (Edge uses Alt+Shift+S for Visual Search) and never swallows
// an AltGr or Option character typed into a field.
//
// `_execute_action` opens the toolbar popup and is handled by the browser.
// Every other command reaches the service worker's onCommand, which sends the
// tab the same content command the popup sends (DESIGN.md, "Entry points").

import type { ContentCommand } from "./messages";

/** The commands the manifest declares, other than `_execute_action`. */
export type CommandName = "toggle-xray" | "open-event-map" | "open-what-changed" | "open-save-preview" | "open-field-card";

export const COMMAND_MESSAGES: Readonly<Record<CommandName, ContentCommand>> = {
  "toggle-xray": { kind: "toggleXray" },
  "open-event-map": { kind: "openEventMap" },
  "open-what-changed": { kind: "openWhatChanged" },
  "open-save-preview": { kind: "openSavePreview" },
  "open-field-card": { kind: "openFieldCard" },
};

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === "string" && Object.hasOwn(COMMAND_MESSAGES, value);
}

export interface CommandDeps {
  send(tabId: number, command: ContentCommand): Promise<unknown>;
  /** The active tab, when the browser did not say which tab the command was for. */
  activeTabId(): Promise<number | undefined>;
}

/**
 * Service worker side: one keyboard command. Sends the matching content
 * command to the tab. A tab with no content script (not D365) does not
 * answer, and nothing else happens: a shortcut never opens a page.
 */
export async function runCommand(command: string, tabId: number | undefined, deps: CommandDeps): Promise<void> {
  if (!isCommandName(command)) return;
  const target = tabId ?? (await deps.activeTabId().catch(() => undefined));
  if (target === undefined) return;
  await deps.send(target, COMMAND_MESSAGES[command]).catch(() => {
    // No content script on this tab: not a D365 page.
  });
}

/** The browser's page for rebinding extension shortcuts. Edge and Chrome name it differently. */
export function shortcutSettingsUrl(brands: ReadonlyArray<{ brand: string }> | undefined, userAgent: string): string {
  const edge = brands ? brands.some(({ brand }) => brand === "Microsoft Edge") : /\bEdg\//.test(userAgent);
  return edge ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
}

/** What the browser reports for one command: its current key, or null when it has none. */
export function bindingsFrom(commands: ReadonlyArray<{ name?: string; shortcut?: string }>): Partial<Record<CommandName, string | null>> {
  const bindings: Partial<Record<CommandName, string | null>> = {};
  for (const { name, shortcut } of commands) {
    if (isCommandName(name)) bindings[name] = shortcut ? shortcut : null;
  }
  return bindings;
}
