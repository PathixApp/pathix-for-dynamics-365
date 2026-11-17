// The page script's poll (src/page/page-poll.ts): it posts only when the
// snapshot changes, pauses while the tab is hidden and checks once when it is
// shown again, and logs a read that keeps failing once per reason, not once
// a second forever.

import { describe, expect, it, vi } from "vitest";
import type { PageMessage } from "../src/bridge/messages";
import { noForm } from "../src/page/form-snapshot";
import { PagePoll, POLL_INTERVAL_MS, type PollDeps } from "../src/page/page-poll";

function harness(options: { hidden?: boolean } = {}) {
  let hidden = options.hidden ?? false;
  let current: PageMessage | Error = noForm("noXrm");
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const deps: PollDeps = {
    read: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    post: vi.fn(),
    log: vi.fn(),
    every: vi.fn((handler: () => void) => {
      const id = nextTimer++;
      timers.set(id, handler);
      return id;
    }),
    stop: vi.fn((id: number) => void timers.delete(id)),
    hidden: () => hidden,
  };
  const poll = new PagePoll(deps);
  return {
    poll,
    deps,
    timers,
    tick: () => [...timers.values()].forEach((handler) => handler()),
    set: (next: PageMessage | Error) => void (current = next),
    setHidden: (value: boolean) => void (hidden = value),
  };
}

describe("the page poll", () => {
  it("posts the first snapshot, then only when it changes", () => {
    const h = harness();
    h.poll.start();
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    h.tick();
    h.tick();
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    h.set(noForm("noFormContext"));
    h.tick();
    expect(h.deps.post).toHaveBeenCalledTimes(2);
    expect(h.deps.every).toHaveBeenCalledWith(expect.any(Function), POLL_INTERVAL_MS);
  });

  it("posts again on hello even when nothing changed", () => {
    const h = harness();
    h.poll.start();
    h.poll.hello();
    expect(h.deps.post).toHaveBeenCalledTimes(2);
  });
});

describe("a read that keeps failing", () => {
  it("logs once per reason, not once a second, and posts the fixed reason once", () => {
    const h = harness();
    h.set(new TypeError("Cannot read properties of null (reading 'getName')"));
    h.poll.start();
    for (let i = 0; i < 10; i += 1) h.tick();
    expect(h.deps.log).toHaveBeenCalledTimes(1);
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    expect(h.deps.post).toHaveBeenCalledWith(noForm("readFailed"));
  });

  it("logs again when the reason changes, or when it fails again after a good read", () => {
    const h = harness();
    h.set(new TypeError("first"));
    h.poll.start();
    h.set(new TypeError("second"));
    h.tick();
    expect(h.deps.log).toHaveBeenCalledTimes(2);
    h.set(noForm("noXrm"));
    h.tick();
    h.set(new TypeError("second"));
    h.tick();
    expect(h.deps.log).toHaveBeenCalledTimes(3);
  });
});

describe("a hidden tab", () => {
  it("starts no timer while hidden, but still posts the first snapshot", () => {
    const h = harness({ hidden: true });
    h.poll.start();
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    expect(h.deps.every).not.toHaveBeenCalled();
  });

  it("pauses when hidden, and when shown checks once at once, then polls again", () => {
    const h = harness();
    h.poll.start();
    h.setHidden(true);
    h.poll.visibilityChanged();
    expect(h.timers.size).toBe(0);
    expect(h.deps.stop).toHaveBeenCalledTimes(1);

    // The form changed while the tab was hidden: shown again, it goes out at once.
    h.set(noForm("noFormContext"));
    h.setHidden(false);
    h.poll.visibilityChanged();
    expect(h.deps.post).toHaveBeenCalledTimes(2);
    expect(h.timers.size).toBe(1);
  });

  it("never runs two timers, however often the tab is shown", () => {
    const h = harness();
    h.poll.start();
    h.poll.visibilityChanged();
    h.poll.visibilityChanged();
    expect(h.deps.every).toHaveBeenCalledTimes(1);
  });
});
