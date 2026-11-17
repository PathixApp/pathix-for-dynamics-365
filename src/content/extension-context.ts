// Noticing that the extension changed under an open page.
//
// When the extension is updated, reloaded or removed, a content script that is
// already running is left behind: its `chrome.runtime` has no id, and every
// call to the extension throws "Extension context invalidated". The browser
// does not inject the new version into open tabs. So this script can no longer
// reach its service worker, its settings or Pathix, and it does not know which
// mode the user is in or whether Pathix is connected.
//
// ContextWatch notices this (a call that throws it, or a cheap check of the
// runtime id on a timer) and calls `onGone` once. The content script then
// takes down what it owns and says one thing, EXTENSION_UPDATED in
// src/card/states.ts: reload the page.

/** How often the runtime id is checked while the page is open. A property read, no message. */
export const CONTEXT_CHECK_MS = 5000;

/** Whether an error is the browser saying this script's extension context is gone. */
export function isContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /extension context invalidated/i.test(message);
}

export interface ContextWatchDeps {
  /** Whether the extension is still there for this script: `chrome.runtime?.id` is set. */
  alive(): boolean;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export class ContextWatch {
  private gone = false;
  private timer: number | undefined;
  private readonly handlers: Array<() => void> = [];

  constructor(private readonly deps: ContextWatchDeps) {}

  /** True once the extension has changed under the page. It never turns back. */
  get isGone(): boolean {
    return this.gone;
  }

  /** Called once, when the extension is found gone. */
  onGone(handler: () => void): void {
    this.handlers.push(handler);
  }

  /** Checks the runtime id now, and every `intervalMs` until it is gone. */
  start(intervalMs = CONTEXT_CHECK_MS): void {
    if (this.timer !== undefined || this.check()) return;
    this.timer = this.deps.setInterval(() => void this.check(), intervalMs);
  }

  /** Whether the extension is gone, noticing it if it just went. */
  check(): boolean {
    if (!this.gone && !this.deps.alive()) this.markGone();
    return this.gone;
  }

  /**
   * Runs a call to the extension. When the call throws because the context is
   * gone, or the extension is gone already, the watch notices it first, then
   * the call fails as before, so a caller never mistakes it for an answer.
   */
  async call<T>(send: () => Promise<T>): Promise<T> {
    if (this.check()) throw new Error("Extension context invalidated.");
    try {
      return await send();
    } catch (error) {
      if (isContextInvalidated(error) || !this.deps.alive()) this.markGone();
      throw error;
    }
  }

  private markGone(): void {
    if (this.gone) return;
    this.gone = true;
    if (this.timer !== undefined) this.deps.clearInterval(this.timer);
    this.timer = undefined;
    for (const handler of this.handlers) {
      try {
        handler();
      } catch {
        // One teardown step failing must not stop the others.
      }
    }
  }
}
