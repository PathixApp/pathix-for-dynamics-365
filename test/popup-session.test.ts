// The toolbar popup's behavior (src/popup/session.ts), driven with fake
// browser calls: which questions it asks, how long it waits and whose silence
// it reports, which mode it shows, and which switch state it keeps.

import { describe, expect, it, vi } from "vitest";
import { CHECKING_PATHIX, PATHIX_TIMED_OUT, SETTINGS_UNREADABLE, type PopupView } from "../src/popup/model";
import { NO_CARD_FOR_FIELD, NO_FIELD_SELECTED } from "../src/popup/model";
import { CONNECTION_TIMEOUT_MS, FORM_STATE_TIMEOUT_MS, PAGE_DID_NOT_ANSWER, PopupSession, type PopupDeps } from "../src/popup/session";
import type { CardMode } from "../src/runtime/card-settings";
import type { ConnectionStatus, ContentCommand } from "../src/runtime/messages";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const SCANNED: ConnectionStatus = {
  kind: "connected",
  environmentId: "env-1",
  environmentName: "Contoso Dev",
  latestCompletedScanAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

/**
 * A fake browser. Each content command gets an answer the test controls, and
 * each wait is a timer the test fires.
 */
function harness(options: { mode?: CardMode; tabId?: number | undefined } = {}) {
  const store = { mode: options.mode ?? ("connected" as CardMode), pathixUrl: "https://pathix.contoso.com" as string | null };
  const answers = new Map<string, Deferred<unknown>>();
  const sent: ContentCommand[] = [];
  const timers = new Map<number, Deferred<void>>();
  const views: PopupView[] = [];
  const statuses: string[] = [];
  const close = vi.fn();
  const answer = (kind: string) => {
    if (!answers.has(kind)) answers.set(kind, deferred());
    return answers.get(kind)!;
  };
  const deps: PopupDeps = {
    activeTab: async () => ("tabId" in options && options.tabId === undefined ? undefined : { id: options.tabId ?? 7 }),
    send: async (_tabId, message) => {
      sent.push(message);
      // Each setXray gets a fresh answer; the other kinds are answered once.
      if (message.kind === "setXray") return message.on;
      return answer(message.kind).promise;
    },
    settings: async () => ({ ...store }),
    bindings: async () => ({ "toggle-xray": "Ctrl+Shift+8" }),
    wait: (ms) => {
      const timer = deferred<void>();
      timers.set(ms, timer);
      return timer.promise;
    },
    now: () => NOW,
    render: (view) => void views.push(view),
    commandStatus: (text) => void statuses.push(text),
    close,
  };
  return { deps, store, answer, sent, timers, views, statuses, close, last: () => views.at(-1)! };
}

describe("the popup's two questions", () => {
  it("draws the form's actions at once, then fills in the connection when Pathix answers", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    const started = new PopupSession(h.deps).start();
    await settle();
    expect(h.last().connection.detail).toBe(CHECKING_PATHIX);
    expect(h.last().form.enabled).toBe(true);
    for (const action of h.last().form.actions) expect(action.enabled).toBe(true);

    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    await started;
    expect(h.last().connection).toMatchObject({ heading: "Connected to Contoso Dev", tone: "ok" });
  });

  it("says Pathix did not answer in time when the connection outlasts its one timer, with the actions still usable", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    const started = new PopupSession(h.deps).start();
    await settle();
    // The tab answered formState, so it is alive: silence now is Pathix's.
    expect(h.timers.has(CONNECTION_TIMEOUT_MS)).toBe(true);
    h.timers.get(CONNECTION_TIMEOUT_MS)!.resolve();
    await started;
    expect(h.last().connection.detail).toBe(PATHIX_TIMED_OUT);
    expect(h.last().form.enabled).toBe(true);
    for (const action of h.last().form.actions) expect(action.enabled).toBe(true);
  });

  it("says the extension did not answer when the connection send fails, not that Pathix timed out", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").reject(new Error("The message port closed before a response was received."));
    await new PopupSession(h.deps).start();
    expect(h.last().connection.detail).toBe("The extension did not answer for this form. Reload the page and try again.");
  });

  it("says the extension did not answer when the connection answer fails the check", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: { kind: "connected" } });
    await new PopupSession(h.deps).start();
    expect(h.last().connection.detail).toMatch(/did not answer for this form/);
  });

  it("treats a tab that does not answer formState in time as having no content script, and asks nothing more", async () => {
    const h = harness();
    const started = new PopupSession(h.deps).start();
    await settle();
    h.timers.get(FORM_STATE_TIMEOUT_MS)!.resolve();
    await started;
    expect(h.last().form.enabled).toBe(false);
    expect(h.sent.map((message) => message.kind)).toEqual(["formState"]);
  });

  it("asks nothing when there is no active tab", async () => {
    const h = harness({ tabId: undefined });
    await new PopupSession(h.deps).start();
    expect(h.sent).toEqual([]);
    expect(h.last().form.enabled).toBe(false);
  });
});

describe("the mode the popup shows", () => {
  it.each<[CardMode, CardMode]>([
    ["connected", "lite"],
    ["lite", "connected"],
  ])("is read fresh each time it opens: %s, then %s after the address changed, with no tab reload", async (before, after) => {
    const h = harness({ mode: before });
    const form = { kind: "formState", form: true, xray: false };
    h.answer("formState").resolve(form);
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: before === "lite" ? { kind: "notConfigured" } : SCANNED });
    await new PopupSession(h.deps).start();
    const saveBefore = h.last().form.actions.find((action) => action.command === "openSavePreview")!;
    expect(saveBefore.enabled).toBe(before === "connected");

    // The address is added or removed on the options page; the D365 tab is not reloaded.
    h.store.mode = after;
    await new PopupSession(h.deps).start();
    const saveAfter = h.last().form.actions.find((action) => action.command === "openSavePreview")!;
    expect(saveAfter.enabled).toBe(after === "connected");
    expect(h.last().form.xray.enabled).toBe(after === "connected");
  });
});

describe("settings that cannot be read", () => {
  it("say the mode is unknown and keep the form's actions usable, never stuck on checking", async () => {
    const h = harness();
    h.deps.settings = () => Promise.reject(new Error("storage unavailable"));
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    await expect(new PopupSession(h.deps).start()).resolves.toBeUndefined();
    expect(h.last().connection).toMatchObject({ heading: SETTINGS_UNREADABLE, tone: "error" });
    expect(h.last().form.enabled).toBe(true);
    expect(h.last().form.xray.enabled).toBe(true);
    for (const action of h.last().form.actions) expect(action.enabled).toBe(true);
  });
});

describe("the X-ray switch", () => {
  it("moves at once, so a quick second click asks for the opposite, and the tab's last answer wins", async () => {
    const h = harness();
    const replies: Array<Deferred<unknown>> = [];
    h.deps.send = async (_tabId, message) => {
      h.sent.push(message);
      if (message.kind === "formState") return { kind: "formState", form: true, xray: false };
      if (message.kind === "connectionStatus") return { kind: "connectionStatus", connection: SCANNED };
      const reply = deferred<unknown>();
      replies.push(reply);
      return reply.promise;
    };
    const session = new PopupSession(h.deps);
    await session.start();
    const first = session.toggleXray();
    expect(h.last().form.xray.on).toBe(true);
    const second = session.toggleXray();
    expect(h.last().form.xray.on).toBe(false);
    expect(h.sent.filter((message) => message.kind === "setXray")).toEqual([
      { kind: "setXray", on: true },
      { kind: "setXray", on: false },
    ]);
    replies[0]!.resolve(true);
    replies[1]!.resolve(false);
    await Promise.all([first, second]);
    expect(h.last().form.xray.on).toBe(false);
  });

  it("goes back where it was when the tab does not take the command", async () => {
    const h = harness();
    h.deps.send = async (_tabId, message) => {
      if (message.kind === "formState") return { kind: "formState", form: true, xray: false };
      if (message.kind === "connectionStatus") return { kind: "connectionStatus", connection: SCANNED };
      throw new Error("Receiving end does not exist.");
    };
    const session = new PopupSession(h.deps);
    await session.start();
    await session.toggleXray();
    expect(h.last().form.xray.on).toBe(false);
    expect(h.statuses).toEqual([PAGE_DID_NOT_ANSWER]);
  });

  it("keeps the position the user set while Pathix is checked, and the next click turns it back", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    const session = new PopupSession(h.deps);
    const started = session.start();
    await settle();
    expect(h.last().connection.detail).toBe(CHECKING_PATHIX);

    await session.toggleXray();
    expect(h.last().form.xray.on).toBe(true);

    // The connection answers after the toggle: the switch stays on.
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    await started;
    expect(h.last().connection.heading).toBe("Connected to Contoso Dev");
    expect(h.last().form.xray.on).toBe(true);

    await session.toggleXray();
    expect(h.sent.filter((message) => message.kind === "setXray")).toEqual([
      { kind: "setXray", on: true },
      { kind: "setXray", on: false },
    ]);
    expect(h.last().form.xray.on).toBe(false);
  });

  it("shows what the tab says, not what was asked for", async () => {
    const h = harness();
    h.deps.send = async (_tabId, message) => {
      if (message.kind === "formState") return { kind: "formState", form: true, xray: false };
      if (message.kind === "connectionStatus") return { kind: "connectionStatus", connection: SCANNED };
      return false; // the tab refused to turn it on
    };
    const session = new PopupSession(h.deps);
    await session.start();
    await session.toggleXray();
    expect(h.last().form.xray.on).toBe(false);
  });
});

describe("a form button", () => {
  it("sends its command and closes the popup", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    h.answer("openEventMap").resolve(true);
    const session = new PopupSession(h.deps);
    await session.start();
    await session.openFeature("openEventMap");
    expect(h.sent.at(-1)).toEqual({ kind: "openEventMap" });
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("says the page did not answer, and stays open, when the send fails", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    h.answer("openWhatChanged").reject(new Error("Receiving end does not exist."));
    const session = new PopupSession(h.deps);
    await session.start();
    await session.openFeature("openWhatChanged");
    expect(h.statuses).toEqual([PAGE_DID_NOT_ANSWER]);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("opens the card for the selected field and closes the popup", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    h.answer("openFieldCard").resolve("opened");
    const session = new PopupSession(h.deps);
    await session.start();
    await session.openFeature("openFieldCard");
    expect(h.sent.at(-1)).toEqual({ kind: "openFieldCard" });
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual([]);
  });

  it("says no field is selected, and stays open, when the page has no field with focus", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    h.answer("openFieldCard").resolve("noField");
    const session = new PopupSession(h.deps);
    await session.start();
    await session.openFeature("openFieldCard");
    expect(h.statuses).toEqual([NO_FIELD_SELECTED]);
    expect(NO_FIELD_SELECTED).toBe("No field on the form is selected. Click a field or move to it with Tab, then try again.");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("says the selected field has no card, and stays open, when the field has no column on this form", async () => {
    const h = harness();
    h.answer("formState").resolve({ kind: "formState", form: true, xray: false });
    h.answer("connectionStatus").resolve({ kind: "connectionStatus", connection: SCANNED });
    h.answer("openFieldCard").resolve("noCard");
    const session = new PopupSession(h.deps);
    await session.start();
    await session.openFeature("openFieldCard");
    expect(h.statuses).toEqual([NO_CARD_FOR_FIELD]);
    expect(NO_CARD_FOR_FIELD).toBe("The selected field has no card. Pick another field.");
    expect(h.close).not.toHaveBeenCalled();
  });
});
