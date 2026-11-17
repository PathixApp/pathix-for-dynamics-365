// The form id when the page does not say it.
//
// Xrm gives no form id when the user can open only one form and the form
// selector does not list it (src/page/form-snapshot.ts). The form's drawn
// field labels carry the id (form-scope.ts), so it is taken from them when they
// all name one form. Labels can render after the first snapshot, so they are
// read again a few times while that snapshot is still the open one, and never
// once a newer snapshot has replaced it. The id found this way is advisory: it
// goes with requests that need a form id, and never rules a field out.

import type { FormSnapshot } from "../bridge/messages";

export const FORM_ID_RETRY_MS = 1000;
export const FORM_ID_TRIES = 10;

export interface LabelFormIdDeps {
  /** The form id the drawn labels carry for these controls, or null. */
  read(controls: string[]): string | null;
  /** The snapshot shared last. A retry for any other one does nothing. */
  current(): FormSnapshot | null;
  /** Shares a snapshot whose form id was found. */
  share(snapshot: FormSnapshot): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export class LabelFormId {
  private timer: number | undefined;

  constructor(private readonly deps: LabelFormIdDeps) {}

  /** The snapshot, with the labels' form id when the page gave none and the labels name one form. */
  fill(snapshot: FormSnapshot): FormSnapshot {
    if (snapshot.formId !== null) return snapshot;
    const formId = this.deps.read(snapshot.columns.map((column) => column.control));
    return formId === null ? snapshot : { ...snapshot, formId };
  }

  /** After `snapshot` was shared with no form id: reads the labels again, a few times, while it is the open one. */
  retry(snapshot: FormSnapshot, attempt = 1): void {
    this.cancel();
    if (snapshot.formId !== null || attempt > FORM_ID_TRIES) return;
    this.timer = this.deps.setTimeout(() => {
      this.timer = undefined;
      if (this.deps.current() !== snapshot) return;
      const found = this.fill(snapshot);
      if (found.formId === null) this.retry(snapshot, attempt + 1);
      else this.deps.share(found);
    }, FORM_ID_RETRY_MS);
  }

  /** Stops a retry that is waiting: a new snapshot arrived, or the extension is gone. */
  cancel(): void {
    this.deps.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
