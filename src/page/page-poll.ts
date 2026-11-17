// The page script's poll, without the page: what it reads, when it posts and
// what it logs, tested with fakes (test/page-poll.test.ts).
//
// The unified interface is a single-page app, so a cheap poll catches every
// move between records, forms and grids. A message goes out only when the
// snapshot changes. The poll pauses while the tab is hidden, since nothing on
// a hidden form needs the extension, and checks once at once when the tab is
// shown again, then resumes.
//
// Mid-navigation the client can throw from half-built form objects, and on
// some pages it keeps throwing. The error stays in this page's console, logged
// once per reason, not once a second; only the fixed reason "readFailed"
// crosses the bridge.

import { noForm } from "./form-snapshot";
import type { PageMessage } from "../bridge/messages";

export const POLL_INTERVAL_MS = 1000;

export interface PollDeps {
  /** The snapshot; throws when the page's form objects cannot be read. */
  read(): PageMessage;
  post(message: PageMessage): void;
  /** Writes a read failure to this page's console. */
  log(error: unknown): void;
  every(handler: () => void, ms: number): number;
  stop(id: number): void;
  /** Whether the tab is hidden: a state of the page, never what it shows. */
  hidden(): boolean;
}

export class PagePoll {
  private lastSent = "";
  private lastFailure: string | null = null;
  private timer: number | null = null;

  constructor(
    private readonly deps: PollDeps,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /** Posts the first snapshot, and polls while the tab is shown. */
  start(): void {
    this.check();
    if (!this.deps.hidden()) this.resume();
  }

  /** The tab was hidden or shown. Shown again: check once now, then poll. */
  visibilityChanged(): void {
    if (this.deps.hidden()) {
      this.pause();
      return;
    }
    if (this.timer !== null) return;
    this.check();
    this.resume();
  }

  /** The content script said hello: it has no snapshot yet, so the current one goes out even if unchanged. */
  hello(): void {
    this.lastSent = "";
    this.check();
  }

  /** Reads the page and posts the snapshot if it changed. */
  check(): void {
    const message = this.snapshot();
    const serialized = JSON.stringify(message);
    if (serialized === this.lastSent) return;
    this.lastSent = serialized;
    this.deps.post(message);
  }

  private snapshot(): PageMessage {
    try {
      const message = this.deps.read();
      this.lastFailure = null;
      return message;
    } catch (error) {
      const reason = reasonOf(error);
      if (reason !== this.lastFailure) {
        this.lastFailure = reason;
        this.deps.log(error);
      }
      return noForm("readFailed");
    }
  }

  private resume(): void {
    this.timer = this.deps.every(() => this.check(), this.intervalMs);
  }

  private pause(): void {
    if (this.timer === null) return;
    this.deps.stop(this.timer);
    this.timer = null;
  }
}

/** What tells one failure from another: its kind and message. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
