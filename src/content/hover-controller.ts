// When the card opens and closes. WCAG 1.4.13 (content on hover or focus):
//
// - hoverable: moving the pointer from the field onto the card keeps it open;
// - dismissible: Escape or the close button closes it, and it stays closed
//   until the pointer leaves that field;
// - persistent: it stays until the pointer leaves both field and card.
//
// For keyboard users, the toolbar popup's field card button and the
// open-field-card command (a manifest command the service worker relays; no
// page key handler) open the card for the field that has focus, or the field
// that last had it. A card opened that way, or from an X-ray line, takes focus
// (its title) on its first draw, and while focus is inside it the pointer
// neither closes it nor opens another. Escape or the close button closes it
// and gives focus back to where it was: the field, or the X-ray line (as X-ray
// last drew it), or, when D365 replaced that node, the field's first control
// that takes focus, on this form only. A card opened by hover never takes
// focus, and still closes when the pointer leaves it, unless a key moved focus
// into it; one a mouse user clicked into gives focus to no field on close.
//
// Scrolling closes the card only when the field it is anchored to moved or
// left the viewport: D365 scrolls on its own (the timeline loading, a
// notification), and that must not close a card the user is reading.
//
// Which card opens depends on the mode (src/runtime/card-settings.ts): Lite
// reads Dataverse from this content script, for the column and for the names
// of the form's unsaved edits; connected asks the service worker
// for the Pathix card. The contrast line's dependency count is Pathix's, from
// its scan. On a field the form shows read-only, the card also reads the
// signed-in user's own security state from Dataverse, live, for "Why can't I
// edit this field?", once Pathix has answered with the card.

import type { FormSnapshot } from "../bridge/messages";
import { contrastLine } from "../card/lite";
import { quickViewLine } from "../card/quick-view";
import type { LiveModified, LiveRef } from "../card/freshness";
import { buildConnectedLockedCard, type LiveUserFacts, type LiveUserRead } from "../card/locked-connected";
import type { LockedCardModel } from "../card/locked";
import { applyCardFreshness, liveRefsOf, writerCountOf } from "../card/model";
import type { CardSettings } from "../runtime/card-settings";
import type { FieldCardOpen } from "../runtime/messages";
import { DATAVERSE_ERROR, EXTENSION_UPDATED, NO_ANSWER, stateForConnection, type CardState } from "../card/states";
import type { FieldCardRequest, FieldCardResponse } from "../runtime/messages";
import type { FieldCardModel } from "../card/model";
import type { CardView, LiteCards } from "./card-view";
import { findFieldTarget, isEditableTarget, type FieldTarget } from "./field-target";
import { containerOnForm, formOnPage, formRelation, isRendered } from "./form-scope";

const SHOW_DELAY_MS = 600;
const HIDE_DELAY_MS = 300;
/** How long the checklist waits for the user's own live reads before it says it could not read them in time. */
export const USER_READ_TIMEOUT_MS = 10_000;

/** Where a card's answers come from. Each one may reject; the card then says it could not answer. */
export interface CardSources {
  settings(): Promise<CardSettings | undefined>;
  connectedCard(request: FieldCardRequest): Promise<FieldCardResponse | undefined>;
  /** The Lite cards for one field. */
  liteCards(request: LiteCardRequest): Promise<LiteCards>;
  /** The signed-in user's own column security and table access, live from Dataverse. */
  userSecurity(table: string): Promise<LiveUserFacts>;
  /** The live modified date of components Pathix knows, from Dataverse. Components it could not read are left out. */
  liveModified(refs: LiveRef[]): Promise<LiveModified>;
  hideTips(): Promise<void>;
  openOptions(): Promise<void>;
}

/** What a Lite card is about. Names and states only, never values. */
export interface LiteCardRequest {
  table: string;
  column: string;
  control: string;
  formId: string | null;
  /** Names of columns with unsaved edits, never the edits. */
  dirtyColumns: string[];
  /** The form shows this control read-only: the card adds "Why can't I edit this field?". */
  locked: boolean;
  showTips: boolean;
}

/**
 * What a field's card is about: its table and column. A field inside a quick
 * view is another record's column, shown read-only: its table is the quick
 * view's, never the form's.
 */
interface FieldSubject {
  table: string;
  column: string;
  quickView: boolean;
}

export class HoverController {
  private snapshot: FormSnapshot | null = null;
  private pageFormId: string | null = null;
  private active: FieldTarget | null = null;
  /** The field that last had focus, for the open-field-card command. Not a value: a control name and its container. */
  private lastFocused: FieldTarget | null = null;
  /** The node inside that field that had focus, to give focus back to. */
  private lastFocusedNode: FocusTarget | null = null;
  private dismissedControl: string | null = null;
  private showTimer: number | undefined;
  private hideTimer: number | undefined;
  private request = 0;
  /** The extension changed under the page: every card says to reload it (extension-context.ts). */
  private gone = false;
  /** The node that had focus when the card was opened on purpose, to give focus back to on close. */
  private returnFocus: FocusTarget | null = null;
  /** Finds that node again when it was replaced: an X-ray line redrawn for the same field. */
  private refindFocus: (() => FocusTarget | null) | null = null;
  /** How the user last moved: a key, or the pointer. Focus that a key moves into a hover card holds it open. */
  private lastInput: "keyboard" | "pointer" = "pointer";
  /** Where the anchored field was when the card was last drawn. */
  private anchorRect: RectLike | null = null;
  /** A scroll check is waiting for the next frame. */
  private scrollCheck = false;
  /** The open card was opened on purpose, or reached by keyboard: focus inside it holds it open. */
  private purposeful = false;
  /** The mode the open card answers in, once its settings are read. */
  private activeMode: CardSettings["mode"] | null = null;

  constructor(
    private readonly view: CardView,
    private readonly sources: CardSources,
    private readonly userReadTimeoutMs: number = USER_READ_TIMEOUT_MS,
  ) {
    view.setOnClose(() => this.dismiss());
    view.setOnHideTips(() => void sources.hideTips().catch(() => undefined));
    view.setOnOpenOptions(() => void sources.openOptions().catch(() => undefined));
  }

  /**
   * `pageFormId` is the form id the page reported, which alone scopes which
   * fields are this form's (form-scope.ts). It defaults to the snapshot's.
   */
  setSnapshot(snapshot: FormSnapshot | null, pageFormId: string | null = snapshot?.formId ?? null): void {
    this.snapshot = snapshot;
    this.pageFormId = pageFormId;
    // The form is gone: focus goes back only to the node it came from, never to a field found on whatever form comes next.
    if (!snapshot) this.close({ fieldFallback: false });
  }

  /**
   * Only the user's own pointer, focus and keys count. A script on the page can
   * dispatch a mouseover or focusin on a container it built, which would drive
   * Pathix and Dataverse reads with no user there; the browser marks such an
   * event untrusted, and it is ignored.
   */
  attach(): void {
    document.addEventListener("mouseover", (event) => event.isTrusted && this.onPointer(event.target as Element | null), { capture: true, passive: true });
    document.addEventListener("keydown", (event) => event.isTrusted && this.onKey(event), { capture: true });
    document.addEventListener("pointerdown", (event) => event.isTrusted && void (this.lastInput = "pointer"), { capture: true, passive: true });
    document.addEventListener("focusin", (event) => event.isTrusted && this.onFocus(event.target as Element | null), { capture: true, passive: true });
    window.addEventListener("scroll", () => this.onScroll(), { capture: true, passive: true });
  }

  /**
   * The extension was updated, reloaded or removed under the page. From now on
   * a field's card says only to reload the page, and asks nothing, since
   * neither the mode nor the connection is known. A card already open keeps
   * what it shows; a read it is waiting on fails and says the same.
   */
  extensionGone(): void {
    this.gone = true;
  }

  /**
   * The user signed out, or the Pathix address changed. An open card that
   * shows (or is loading) Pathix's answers asks again, as X-ray does, so it
   * says what the connection is now; focus stays where it is. A Lite card
   * holds no Pathix answer and is left alone, and a hover card already
   * closing (the pointer left it) is let close.
   */
  reset(): void {
    const active = this.active;
    if (!this.view.isOpen || !active || this.activeMode === "lite" || this.hideTimer !== undefined) return;
    void this.open(active, "again");
  }

  /**
   * Opens the card for a field now, without the hover delay: an X-ray line
   * was chosen. Closes a card dismissed earlier for the same field. The card
   * takes focus, and gives it back to `from` (the line) when it closes, or,
   * when X-ray redrew its lines meanwhile, to what `refind` finds: the new
   * line for the same field.
   */
  openFor(controlName: string, container: Element, from: FocusTarget | null = null, refind: (() => FocusTarget | null) | null = null): void {
    this.clearShow();
    this.dismissedControl = null;
    this.openOnPurpose(from, refind);
    void this.open({ container, controlName }, "purpose");
  }

  private onPointer(node: Element | null): void {
    if (this.view.contains(node)) return this.cancelHide();
    // Focus is inside a card the user opened or reached by keyboard: the pointer neither closes it nor opens another.
    if (this.purposeful && this.view.hasFocus) return this.clearShow();

    const target = findFieldTarget(node);
    if (!target || this.subjectOf(target) === null) {
      this.clearShow();
      this.dismissedControl = null;
      return this.scheduleHide();
    }

    if (target.controlName !== this.dismissedControl) this.dismissedControl = null;
    if (this.active?.controlName === target.controlName) return this.cancelHide();
    if (isEditableTarget(node) || this.dismissedControl) return this.clearShow();

    this.clearShow();
    this.showTimer = window.setTimeout(() => void this.open(target, "hover"), SHOW_DELAY_MS);
  }

  /**
   * The open-field-card command and the popup's button: opens the card for the
   * field that has focus, or the one that last had it while it is still on
   * the page. Answers "opened", "noField" (no field had focus) or "noCard"
   * (the field has no column on this form, so it has no card).
   */
  openFocused(): FieldCardOpen {
    const active = document.activeElement;
    const focused = findFieldTarget(active);
    const target = focused ?? (this.lastFocused?.container.isConnected ? this.lastFocused : null);
    if (!target) return "noField";
    if (this.subjectOf(target) === null) return "noCard";
    this.clearShow();
    this.dismissedControl = null;
    this.openOnPurpose(focused ? (active as FocusTarget | null) : this.lastFocusedNode);
    void this.open(target, "purpose");
    return "opened";
  }

  /** The card about to open was asked for: it holds while focus is in it, and gives focus back to `from` when it closes. */
  private openOnPurpose(from: FocusTarget | null, refind: (() => FocusTarget | null) | null = null): void {
    // A card already open on purpose keeps the first place focus came from.
    if (!this.view.hasFocus) {
      this.returnFocus = from && !this.view.contains(from as unknown as Node) ? from : null;
      this.refindFocus = refind;
    }
    this.purposeful = true;
  }

  private onFocus(node: Element | null): void {
    if (this.view.contains(node)) {
      // A key moved focus into the card (Tab from the field): it holds like one opened on purpose. A click does not.
      if (this.view.isOpen && this.lastInput === "keyboard") this.purposeful = true;
      return;
    }
    const target = findFieldTarget(node);
    if (target) {
      this.lastFocused = target;
      this.lastFocusedNode = node as FocusTarget | null;
    }
  }

  private onKey(event: KeyboardEvent): void {
    this.lastInput = "keyboard";
    if (event.key === "Escape" && this.view.isOpen) this.dismiss();
  }

  /**
   * Closes the card only when its field moved or left the viewport, checked
   * once a frame however many scroll events arrive.
   */
  private onScroll(): void {
    if (!this.view.isOpen || this.scrollCheck) return;
    this.scrollCheck = true;
    window.requestAnimationFrame(() => {
      this.scrollCheck = false;
      const active = this.active;
      if (!active || !this.view.isOpen) return;
      if (!active.container.isConnected || fieldMoved(this.anchorRect, active.container.getBoundingClientRect())) this.close();
    });
  }

  /**
   * Draws the card for `target`. "purpose": the first draw moves focus into
   * it; the view is told just before that draw, so a request that ends
   * without drawing leaves nothing behind for a later hover card. "hover":
   * nothing of an earlier card opened on purpose carries over. "again": the
   * same card asks again (a reset) and keeps how it was opened.
   */
  private async open(target: FieldTarget, how: "hover" | "purpose" | "again"): Promise<void> {
    const snapshot = this.snapshot;
    const subject = this.subjectOf(target);
    if (!snapshot || !subject) return;
    const { table, column, quickView } = subject;
    const related = quickView ? quickViewLine(table) : null;

    this.cancelHide();
    if (how === "hover") {
      this.purposeful = false;
      this.returnFocus = null;
      this.refindFocus = null;
    }
    this.active = target;
    this.activeMode = null;
    let focusFirstDraw = how === "purpose";
    const anchor = () => {
      if (focusFirstDraw) this.view.takeFocus();
      focusFirstDraw = false;
      const rect = target.container.getBoundingClientRect();
      this.anchorRect = rect;
      return rect;
    };
    const request = ++this.request;
    const current = () => request === this.request && this.active === target;
    if (this.gone) return this.view.showState(anchor(), table, column, EXTENSION_UPDATED, null);

    const settings = await this.sources.settings().catch(() => undefined);
    if (!current()) return;
    this.activeMode = settings?.mode ?? null;
    // With no settings the mode is not known, so the card claims neither.
    if (!settings) return this.view.showState(anchor(), table, column, this.failure(NO_ANSWER), null);

    if (settings.mode === "lite") {
      this.view.showMessage(anchor(), table, column, "Reading Dataverse…", "lite");
      const cards = await this.sources
        .liteCards({
          table,
          column,
          control: target.controlName,
          // A quick view field is not on this form's table: the form's id, edits and locks are not about it.
          formId: quickView ? null : snapshot.formId,
          dirtyColumns: quickView ? [] : snapshot.dirtyColumns,
          locked: !quickView && snapshot.lockedControls.includes(target.controlName),
          showTips: settings.showTips,
        })
        .catch(() => undefined);
      if (!current()) return;
      if (cards) this.view.showLiteCards(anchor(), cards, related);
      else this.view.showState(anchor(), table, column, this.failure(DATAVERSE_ERROR), this.gone ? null : "lite");
      return;
    }

    this.view.showMessage(anchor(), table, column, "Loading from Pathix…", "connected");
    const response = await this.sources
      .connectedCard({
        kind: "fieldCard",
        organizationId: snapshot.organizationId,
        host: snapshot.host,
        table,
        column,
      })
      .catch(() => undefined);
    if (!current()) return;
    if (response?.kind !== "card") {
      const state = response?.kind === "status" ? stateForConnection(response.status) : null;
      if (!state && this.gone) return this.view.showState(anchor(), table, column, EXTENSION_UPDATED, null);
      return this.view.showState(anchor(), table, column, state ?? NO_ANSWER, "connected");
    }

    // The Pathix card shows as soon as Pathix answers. The live reads that
    // pair with it follow, and the card is drawn
    // again as each one comes back: the user's own state, only for the
    // checklist of a field the form shows read-only, and the freshness of the
    // listed writers. A sign-in prompt, an error or "not scanned" makes no
    // Dataverse read, and neither does a column not in Pathix's latest scan:
    // that is not a fact to pair with, so its card shows no checklist at all.
    const { card } = response;
    // A quick view field is read-only because it is another record's: the card says so in its own line, not the checklist.
    const checklist = !quickView && snapshot.lockedControls.includes(target.controlName) && !card.notInScan;
    const context = { table, column, control: target.controlName, formId: snapshot.formId };
    const contrast = card.notInScan ? null : contrastLine(card.platformDependentCount, writerCountOf(card), card.platformCountRead);
    const drawn: { card: FieldCardModel; locked: LockedCardModel | null } = {
      card,
      locked: checklist ? buildConnectedLockedCard(context, card.locked, "checking") : null,
    };
    const draw = () => this.view.showCard(anchor(), drawn.card, contrast, drawn.locked, related);
    draw();

    await Promise.all([
      checklist
        ? this.readUser(table).then((user) => {
            if (!current()) return;
            drawn.locked = buildConnectedLockedCard(context, card.locked, user);
            draw();
          })
        : null,
      this.checkFreshness(card).then((fresh) => {
        if (!fresh || !current()) return;
        drawn.card = fresh;
        draw();
      }),
    ]);
  }

  /** What a failed read shows: the reason, unless the extension changed under the page, which is the real one. */
  private failure(state: CardState): CardState {
    return this.gone ? EXTENSION_UPDATED : state;
  }

  /** The user's own state, live, or "timedOut" when it does not answer in time; a failure is null. */
  private readUser(table: string): Promise<LiveUserRead> {
    let timer: number | undefined;
    const timeout = new Promise<LiveUserRead>((resolve) => {
      timer = window.setTimeout(() => resolve("timedOut"), this.userReadTimeoutMs);
    });
    const read = this.sources.userSecurity(table).catch((): LiveUserFacts | null => null);
    return Promise.race([read, timeout]).finally(() => window.clearTimeout(timer));
  }

  /**
   * The live check (M11): a second, separate read of the components' modified
   * dates, after the card is up. It answers the card with its badges, or null
   * when there is nothing to check. When the read cannot run, the components
   * are unknown and the card says so; it never reads as "unchanged".
   */
  private async checkFreshness(card: FieldCardModel): Promise<FieldCardModel | null> {
    const refs = liveRefsOf(card);
    if (refs.length === 0) return null;
    const live = await this.sources.liveModified(refs).catch(() => null);
    return applyCardFreshness(card, live);
  }

  /**
   * The table and column the field shows, or null. A field whose label names
   * another form (a quick create over this one, a dialog, a hidden session)
   * is not this form's field, even when its control name is on this form too:
   * it gets no card (form-scope.ts).
   *
   * A field inside a quick view is matched first, and the label rule does not
   * apply to it: its label can carry the quick view form's id, and its card is
   * about the quick view's table and column, which do not depend on which
   * form hosts the quick view.
   */
  private subjectOf(target: FieldTarget): FieldSubject | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const inQuickView = snapshot.quickViewColumns?.find((entry) => entry.control === target.controlName);
    if (inQuickView) return { table: inQuickView.table, column: inQuickView.column, quickView: true };
    // The page is read only when the label names another form: most fields never get that far.
    if (formRelation(target.container, target.controlName, this.pageFormId) === "other" && formOnPage(document, this.pageFormId!)) return null;
    const column = snapshot.columns.find((entry) => entry.control === target.controlName)?.column;
    return column ? { table: snapshot.table, column, quickView: false } : null;
  }

  private dismiss(): void {
    this.dismissedControl = this.active?.controlName ?? null;
    this.close();
  }

  /**
   * Closes the card. If focus was inside it, focus goes back to where it was
   * before the card took it. Only a card opened on purpose (or reached by
   * keyboard) falls back to the field: a mouse user who clicked into a hover
   * card did not come from the field, and focusing it could open a lookup's
   * flyout.
   */
  private close(options: { fieldFallback?: boolean } = {}): void {
    const field = this.active;
    const purposeful = this.purposeful || this.returnFocus !== null;
    this.clearShow();
    this.cancelHide();
    this.active = null;
    this.activeMode = null;
    this.purposeful = false;
    this.anchorRect = null;
    this.request++;
    const hadFocus = this.view.hasFocus;
    this.view.hide();
    const back = this.returnFocus;
    const refind = this.refindFocus;
    this.returnFocus = null;
    this.refindFocus = null;
    if (!hadFocus) return;
    if (back?.isConnected) return back.focus({ preventScroll: true });
    const found = refind?.();
    if (found?.isConnected) return found.focus({ preventScroll: true });
    if (purposeful && options.fieldFallback !== false && field) this.focusField(field);
  }

  /**
   * D365 re-renders a field's control after a save or an on-change script, so
   * the node focus came from can be gone. Focus goes to the field's first
   * control that really takes it, found again by its control name, on this
   * form only, if the field itself was replaced. If none does, focus is left alone.
   */
  private focusField(field: FieldTarget): void {
    let container: Element | null = field.container.isConnected ? field.container : null;
    if (!container) {
      const found = containerOnForm(document, field.controlName, this.pageFormId, isRendered).container;
      container = found && formRelation(found, field.controlName, this.pageFormId) === "same" ? found : null;
    }
    if (container) focusFirstIn(container);
  }

  private scheduleHide(): void {
    if (!this.view.isOpen || this.hideTimer !== undefined) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = undefined;
      this.close();
    }, HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private clearShow(): void {
    window.clearTimeout(this.showTimer);
    this.showTimer = undefined;
  }
}

/** What may take focus inside a field's container, first one first; focusFirstIn rules out the rest. */
const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button, a[href], [tabindex]';

/**
 * Focuses the first control in `container` that really takes focus: not
 * taken out of the tab order (tabindex -1, as Fluent's hidden inner inputs
 * are), not disabled (a disabled fieldset included), not hidden from
 * assistive technology or inert, and drawn. Stops at the first one that
 * becomes the active element. Answers whether one did.
 */
export function focusFirstIn(container: Element): boolean {
  for (const candidate of Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (candidate.getAttribute("tabindex") === "-1") continue;
    if ((candidate as HTMLElement & { disabled?: boolean }).disabled === true || candidate.matches(":disabled")) continue;
    if (candidate.closest('[aria-hidden="true"], [inert]')) continue;
    if (!isRendered(candidate)) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return true;
  }
  return false;
}

/** The slice of an element focus goes back to. */
export interface FocusTarget {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

type RectLike = Pick<DOMRect, "top" | "left" | "bottom" | "right">;

/**
 * Whether a field moved from where its card was drawn, or left the viewport.
 * A pixel of rounding is not a move.
 */
export function fieldMoved(before: RectLike | null, now: RectLike, viewport = { width: window.innerWidth, height: window.innerHeight }): boolean {
  if (!before) return true;
  const moved = Math.abs(now.top - before.top) > 1 || Math.abs(now.left - before.left) > 1;
  const outside = now.bottom <= 0 || now.right <= 0 || now.top >= viewport.height || now.left >= viewport.width;
  return moved || outside;
}
