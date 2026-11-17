// What the toolbar popup does, without the DOM: asks the active tab, keeps the
// latest known state, and hands every view to `render`. popup.ts supplies the
// browser and draws; test/popup-session.test.ts supplies fakes.
//
// Two questions, and one timer for each:
// - formState comes from the content script's own state, so a live tab answers
//   at once. No answer within FORM_STATE_TIMEOUT_MS, or a send that fails,
//   means no content script.
// - connectionStatus can wait on Pathix (a silent sign-in, then its reads). It
//   is asked only after formState answered, which proves the content script
//   is alive. So silence until CONNECTION_TIMEOUT_MS is Pathix's ("did not
//   answer in time"), while a send that fails or an answer that fails the
//   check is the extension's ("did not answer for this form").
//
// The state shown is always the latest known: a switch the user turned while
// the connection was being checked keeps its new position when the
// connection's answer arrives.

import type { CardMode } from "../runtime/card-settings";
import type { CommandName } from "../runtime/commands";
import {
  isConnectionStatusAnswer,
  isFormState,
  type ContentCommand,
  type FormState,
  type OpenFeatureCommand,
} from "../runtime/messages";
import { NO_CARD_FOR_FIELD, NO_FIELD_SELECTED, popupView, tabKindOf, type ConnectionCheck, type PopupInput, type PopupView } from "./model";

export const FORM_STATE_TIMEOUT_MS = 3_000;
/** The connection can wait on a silent sign-in (up to 10 seconds) and then Pathix's reads. */
export const CONNECTION_TIMEOUT_MS = 20_000;
export const PAGE_DID_NOT_ANSWER = "The page did not answer. Reload it and try again.";

const TIMED_OUT = Symbol("timed out");

export interface PopupDeps {
  /** The active tab of the popup's window: its id, and its address when the browser gives one. */
  activeTab(): Promise<{ id?: number; url?: string } | undefined>;
  send(tabId: number, message: ContentCommand): Promise<unknown>;
  /** The stored mode and Pathix address, read fresh. */
  settings(): Promise<{ mode: CardMode; pathixUrl: string | null }>;
  bindings(): Promise<Partial<Record<CommandName, string | null>>>;
  /** Resolves after `ms`. */
  wait(ms: number): Promise<void>;
  now(): number;
  render(view: PopupView): void;
  /** One line under the form section, for a command the page did not take. */
  commandStatus(text: string): void;
  close(): void;
}

export class PopupSession {
  private tabId: number | undefined;
  private input: PopupInput | null = null;

  constructor(private readonly deps: PopupDeps) {}

  /** Asks the tab, draws at once, then fills in the connection when it comes. */
  async start(): Promise<void> {
    const tab = await this.deps.activeTab().catch(() => undefined);
    this.tabId = tab?.id;
    const [formState, settings, bindings] = await Promise.all([
      this.askFormState(),
      // Storage that cannot be read leaves the mode unknown, never the popup stuck.
      this.deps.settings().catch(() => ({ mode: null, pathixUrl: null })),
      this.deps.bindings().catch(() => ({})),
    ]);
    this.input = {
      formState,
      connection: { kind: "checking" },
      tab: tabKindOf(tab?.url),
      storedMode: settings.mode,
      pathixUrl: settings.pathixUrl,
      now: this.deps.now(),
      bindings,
    };
    this.draw();
    if (formState?.form !== true) return;
    const connection = await this.askConnection();
    this.update({ connection, now: this.deps.now() });
  }

  /**
   * A form button: the tab opens the panel, and the popup closes. The field
   * card needs a field with focus that has a card; when the page answers that
   * there is none, the popup stays open and says which.
   */
  async openFeature(kind: OpenFeatureCommand["kind"]): Promise<void> {
    if (this.tabId === undefined) return;
    let answer: unknown;
    try {
      answer = await this.deps.send(this.tabId, { kind });
    } catch {
      this.deps.commandStatus(PAGE_DID_NOT_ANSWER);
      return;
    }
    if (kind === "openFieldCard" && (answer === "noField" || answer === "noCard")) {
      this.deps.commandStatus(answer === "noField" ? NO_FIELD_SELECTED : NO_CARD_FOR_FIELD);
      return;
    }
    this.deps.close();
  }

  /**
   * The X-ray switch. It moves at once, so a second click before the tab
   * answers asks for the opposite again. The tab's answer (whether X-ray is
   * now on) then sets it; a send that fails puts it back.
   */
  async toggleXray(): Promise<void> {
    const before = this.input?.formState;
    if (this.tabId === undefined || !before) return;
    const wanted = !before.xray;
    this.setXray(wanted);
    try {
      const on: unknown = await this.deps.send(this.tabId, { kind: "setXray", on: wanted });
      if (typeof on === "boolean") this.setXray(on);
    } catch {
      this.setXray(before.xray);
      this.deps.commandStatus(PAGE_DID_NOT_ANSWER);
    }
  }

  private setXray(on: boolean): void {
    const formState = this.input?.formState;
    if (formState) this.update({ formState: { ...formState, xray: on } });
  }

  private update(change: Partial<PopupInput>): void {
    if (!this.input) return;
    // Merged into the latest state, never into the one a slower answer started from.
    this.input = { ...this.input, ...change };
    this.draw();
  }

  private draw(): void {
    if (this.input) this.deps.render(popupView(this.input));
  }

  private async askFormState(): Promise<FormState | null> {
    if (this.tabId === undefined) return null;
    const answer = await this.within(FORM_STATE_TIMEOUT_MS, this.deps.send(this.tabId, { kind: "formState" }));
    return isFormState(answer) ? answer : null;
  }

  private async askConnection(): Promise<ConnectionCheck> {
    if (this.tabId === undefined) return { kind: "answered", status: null };
    const answer = await this.within(CONNECTION_TIMEOUT_MS, this.deps.send(this.tabId, { kind: "connectionStatus" }));
    if (answer === TIMED_OUT) return { kind: "timedOut" };
    return isConnectionStatusAnswer(answer) ? { kind: "answered", status: answer.connection } : { kind: "answered", status: null };
  }

  /** The answer, TIMED_OUT when the one timer fires first, or undefined when the send fails. */
  private within(ms: number, sent: Promise<unknown>): Promise<unknown> {
    return Promise.race([sent.catch(() => undefined), this.deps.wait(ms).then(() => TIMED_OUT)]);
  }
}
