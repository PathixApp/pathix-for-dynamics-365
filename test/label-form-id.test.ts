// The form id from the drawn field labels, when the page gave none: read again
// a few times while the snapshot is the open one, never for a snapshot a newer
// one replaced, and stopped when a new snapshot arrives or the extension is gone.

import { describe, expect, it, vi } from "vitest";
import type { FormSnapshot } from "../src/bridge/messages";
import { FORM_ID_RETRY_MS, FORM_ID_TRIES, LabelFormId } from "../src/content/label-form-id";

const FORM = "8448b78f-8f42-454e-8e2a-f8196b0419af";
const snapshot = (formId: string | null = null) => ({ formId, columns: [{ control: "name", column: "name" }] }) as unknown as FormSnapshot;

function harness(answers: Array<string | null>) {
  const timers: Array<{ id: number; handler: () => void; ms: number; cleared: boolean }> = [];
  let open: FormSnapshot | null = null;
  const shared: FormSnapshot[] = [];
  const read = vi.fn(() => (answers.length > 1 ? answers.shift()! : answers[0]!));
  const labels = new LabelFormId({
    read,
    current: () => open,
    share: (found) => {
      open = found;
      shared.push(found);
    },
    setTimeout: (handler, ms) => {
      timers.push({ id: timers.length + 1, handler, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
  });
  const fire = () => {
    const timer = timers.filter((entry) => !entry.cleared).at(-1);
    if (!timer) return false;
    timer.cleared = true;
    timer.handler();
    return true;
  };
  return { labels, read, shared, timers, fire, setOpen: (value: FormSnapshot | null) => void (open = value) };
}

describe("the form id from the labels", () => {
  it("leaves a page-reported form id alone and reads nothing", () => {
    const { labels, read } = harness([FORM]);
    const given = snapshot("11111111-0000-4000-8000-000000000000");
    expect(labels.fill(given)).toBe(given);
    labels.retry(given);
    expect(read).not.toHaveBeenCalled();
  });

  it("fills the id when the drawn labels name one form", () => {
    const { labels } = harness([FORM]);
    expect(labels.fill(snapshot()).formId).toBe(FORM);
  });

  it("reads again until the labels render, then shares the snapshot with the id", () => {
    const { labels, shared, setOpen, fire, timers } = harness([null, null, FORM]);
    const first = labels.fill(snapshot());
    setOpen(first);
    labels.retry(first);
    expect(timers[0]!.ms).toBe(FORM_ID_RETRY_MS);
    fire();
    expect(shared).toEqual([]);
    fire();
    expect(shared).toEqual([{ ...first, formId: FORM }]);
    expect(fire()).toBe(false);
  });

  it("gives up after a few tries", () => {
    const { labels, setOpen, fire, read } = harness([null]);
    const first = snapshot();
    setOpen(first);
    labels.retry(first);
    while (fire()) {
      // every retry
    }
    expect(read).toHaveBeenCalledTimes(FORM_ID_TRIES);
  });

  // L1: after a move, the old snapshot must never be shared with the new form's id.
  it("does nothing for a snapshot that is no longer the open one", () => {
    const { labels, shared, setOpen, fire, read } = harness([FORM]);
    const first = snapshot();
    setOpen(first);
    labels.retry(first);
    setOpen(snapshot());
    fire();
    expect(read).not.toHaveBeenCalled();
    expect(shared).toEqual([]);
  });

  it("stops a waiting retry when cancelled: a new snapshot arrived, or the extension is gone", () => {
    const { labels, setOpen, timers, fire, read } = harness([FORM]);
    const first = snapshot();
    setOpen(first);
    labels.retry(first);
    labels.cancel();
    expect(timers[0]!.cleared).toBe(true);
    expect(fire()).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
