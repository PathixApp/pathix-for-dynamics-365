// Isolated-world content script. Receives snapshots from the page script,
// validates them, relays them to the service worker, and runs the hover card.
// It never calls Pathix directly: the service worker does, and the fitness
// test holds that line. Lite's Dataverse reads start here, through the one
// Dataverse client, against this page's own origin.
//
// Anything on the page can call window.postMessage, so every message is
// checked against the bridge schema before it is used or forwarded.

import {
  CHANNEL,
  helloMessage,
  isHelloMessage,
  isPageMessage,
  type FormSnapshot,
  type PageMessage,
} from "../bridge/messages";
import { createDataverseClient } from "../dataverse/client";
import { loadDependenciesCard } from "../lite/dependencies";
import { loadUserSecurity } from "../lite/user-security";
import { loadLiteChanges, loadLiveModified } from "../lite/changes";
import { loadEventMap } from "../lite/event-map";
import { loadLockedCard } from "../lite/locked";
import { loadRegisteredCard } from "../lite/registered";
import { isCardSettings, type CardSettings } from "../runtime/card-settings";
import {
  describeConnection,
  type ConnectionStatus,
  type EventMapResponse,
  type ConnectionStatusAnswer,
  type FormState,
  type FieldCardResponse,
  type SavePreviewResponse,
  type TableChangesResponse,
  type XrayResponse,
} from "../runtime/messages";
import { contentCommandListener, pathixResetListener, refreshBadgeListener } from "../runtime/toolbar";
import { isDynamicsOrgHost } from "../bridge/org-host";
import { BadgeRefresh } from "./badge-refresh";
import { withPageHost } from "./page-host";
import { CardView } from "./card-view";
import { EventMapController } from "./event-map-controller";
import { EventMapView } from "./event-map-view";
import { ContextWatch } from "./extension-context";
import { formIdFromLabels, isRendered } from "./form-scope";
import { HoverController } from "./hover-controller";
import { LabelFormId } from "./label-form-id";
import { SavePreviewController } from "./save-preview-controller";
import { SavePreviewView } from "./save-preview-view";
import { WhatChangedController } from "./what-changed-controller";
import { WhatChangedView } from "./what-changed-view";
import { XrayController } from "./xray-controller";
import { XrayLines } from "./xray-lines";
import { XrayView } from "./xray-view";

// Everything runs inside start(), and start() runs only on a Dynamics 365 org
// host (src/bridge/org-host.ts). On any other dynamics.com page this script
// adds no listener, starts no observer or timer and sends no message.
function start(): void {
  const dataverse = createDataverseClient(window.location.origin);

  // The extension can be updated, reloaded or removed under the open page. This
  // script is then left behind and every call to the extension throws. The watch
  // notices, and teardown() takes down what this script runs (see
  // extension-context.ts). Every call to the extension goes through send().
  const context = new ContextWatch({
    alive: () => Boolean(globalThis.chrome?.runtime?.id),
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (id) => window.clearInterval(id),
  });

  function send<T>(message: unknown): Promise<T> {
    return context.call(() => chrome.runtime.sendMessage(message) as Promise<T>);
  }

  async function askSettings(kind: "cardSettings" | "hideTips"): Promise<CardSettings | undefined> {
    const answer: unknown = await send({ kind });
    return isCardSettings(answer) ? answer : undefined;
  }

  const hover = new HoverController(new CardView(), {
    settings: () => askSettings("cardSettings"),
    connectedCard: (request) => send<FieldCardResponse | undefined>(request),
    liteCards: async ({ table, column, control, formId, dirtyColumns, locked, showTips }) => {
      const [registered, dependencies, lockedCard] = await Promise.all([
        loadRegisteredCard(dataverse, { table, column, dirtyColumns, showTips }),
        loadDependenciesCard(dataverse, { table, column, showTips }),
        // Only a field the form shows read-only gets the checklist.
        locked ? loadLockedCard(dataverse, { table, column, control, formId, showTips }) : Promise.resolve(null),
      ]);
      return { registered, dependencies, locked: lockedCard };
    },
    userSecurity: (table) => loadUserSecurity(dataverse, table),
    liveModified: (refs) => loadLiveModified(dataverse, refs),
    hideTips: async () => void (await askSettings("hideTips")),
    openOptions: async () => void (await send({ kind: "openOptions" })),
  });

  // A card opened from an X-ray line gives focus back to that line, or, when X-ray redrew its lines meanwhile
  // (a sign-out reset), to the new line for the same field.
  const xrayLines: XrayLines = new XrayLines((control, container, line) => hover.openFor(control, container, line, () => xrayLines.buttonFor(control)));
  const xray = new XrayController(new XrayView(), xrayLines, (request) => send<XrayResponse | undefined>(request));

  const eventMap = new EventMapController(new EventMapView(), {
    settings: () => askSettings("cardSettings"),
    load: (context) => loadEventMap(dataverse, context),
    connectedMap: (request) => send<EventMapResponse | undefined>(request),
    hideTips: async () => void (await askSettings("hideTips")),
  });

  const whatChanged = new WhatChangedController(new WhatChangedView(), {
    settings: () => askSettings("cardSettings"),
    liteChanges: (context) => loadLiteChanges(dataverse, { ...context, now: Date.now() }),
    connectedChanges: (request) => send<TableChangesResponse | undefined>(request),
    liveModified: (refs) => loadLiveModified(dataverse, refs),
    hideTips: async () => void (await askSettings("hideTips")),
  });

  const savePreview = new SavePreviewController(new SavePreviewView(), {
    settings: () => askSettings("cardSettings"),
    savePreview: (request) => send<SavePreviewResponse | undefined>(request),
    hideTips: async () => void (await askSettings("hideTips")),
  });

  function onWindowMessage(event: MessageEvent): void {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (isHelloMessage(event.data)) return; // our own hello, echoed back
    if (!isPageMessage(event.data)) {
      // D365 posts its own messages too; only complain about ones claiming ours.
      if ((event.data as { channel?: unknown } | null)?.channel === CHANNEL) {
        console.warn("[pathix] dropped a message that failed the bridge schema");
      }
      return;
    }
    // The page's own host, never the one it posted: every request names this tab's host.
    const message = withPageHost(event.data, window.location.host);
    if (context.check()) {
      // Only the hover card still runs, to say the page needs a reload. It keeps
      // up with the form, and nothing is relayed.
      hover.setSnapshot(message.kind === "formSnapshot" ? message : null);
      return;
    }
    logSnapshot(message);
    labelFormId.cancel();
    if (message.kind !== "formSnapshot") return share(message, null);
    const snapshot = labelFormId.fill(message);
    share(snapshot, message.formId);
    labelFormId.retry(snapshot);
  }

  /**
   * Gives every controller the snapshot. `pageFormId` is the form id the page
   * reported, or null: only that one scopes which fields are this form's. A
   * form id read from the labels goes with requests, never scopes fields.
   */
  function share(message: PageMessage, pageFormId: string | null): void {
    const snapshot = message.kind === "formSnapshot" ? message : null;
    // For the toolbar popup: the same snapshot, with the page's own host.
    openForm = snapshot;
    hover.setSnapshot(snapshot, pageFormId);
    xray.setSnapshot(snapshot, pageFormId);
    eventMap.setSnapshot(snapshot, pageFormId);
    whatChanged.setSnapshot(snapshot);
    savePreview.setSnapshot(snapshot);
    badgeRefresh.onPageMessage(message);
    if (snapshot) void relaySnapshot(snapshot);
  }

  // The page may not say which form is open (label-form-id.ts): the drawn field
  // labels may, and are read again a few times while the snapshot is the open one.
  const labelFormId = new LabelFormId({
    read: (controls) => formIdFromLabels(document, controls, isRendered),
    current: () => openForm,
    share: (snapshot) => share(snapshot, null),
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  });

  // The page posts a snapshot only when the form changes, so the badge's scan age
  // is re-read on focus, every few minutes, and when a page move finishes (the
  // worker's tab update, or the page's own navigation event). Neither carries an
  // address, and this script never reads one.
  // See badge-refresh.ts for why a move to a page with no form keeps the badge.
  const BADGE_REFRESH_MS = 10 * 60 * 1000;
  const badgeRefresh = new BadgeRefresh({
    relay: (snapshot) => void relaySnapshot(snapshot),
    isVisible: () => document.visibilityState === "visible",
  });

  let lastConnection = "";

  /** Sends the snapshot to the worker, which sets the badge; answers the tab's connection status, or null. */
  async function relaySnapshot(snapshot: FormSnapshot): Promise<ConnectionStatus | null> {
    let status: ConnectionStatus | undefined;
    try {
      status = await send<ConnectionStatus | undefined>(snapshot);
    } catch {
      // The service worker restarts on demand; the next change the page reports
      // tries again.
      return null;
    }
    if (!status) return null;
    const line = describeConnection(status);
    if (line !== lastConnection) {
      lastConnection = line;
      console.info(`[pathix] ${line}`);
    }
    return status;
  }

  /** The record form the page last reported, or null when none is open. */
  let openForm: FormSnapshot | null = null;

  /** The toolbar popup's first question, answered at once: no call to the worker or Pathix. */
  function formState(): FormState {
    return { kind: "formState", form: openForm !== null, xray: xray.isOn };
  }

  /** The popup's second question. The snapshot is relayed afresh, so the popup shows the badge's current answer. */
  async function connectionStatus(): Promise<ConnectionStatusAnswer> {
    const connection = openForm ? await relaySnapshot(openForm) : null;
    return { kind: "connectionStatus", connection };
  }

  let lastFormKey = "";

  // Logged once per form, not on every edit. The hover-target count shows how
  // many of the form's controls the DOM lookup can find; controls on tabs that
  // have not been opened yet are not rendered, so a lower number is normal.
  function logSnapshot(message: PageMessage): void {
    if (message.kind === "noForm") {
      lastFormKey = "";
      console.info(`[pathix] no form open (${message.reason})`);
      return;
    }
    const formKey = `${message.table}|${message.formId}`;
    if (formKey === lastFormKey) return;
    lastFormKey = formKey;
    const found = message.columns.filter((column) =>
      document.querySelector(`[data-id="${CSS.escape(column.control)}-FieldSectionItemContainer"]`),
    ).length;
    console.info(
      `[pathix] ${message.table} form, ${message.columns.length} bound controls, ${found} found on the page for hover`,
      message.columns.map((column) => column.column),
    );
  }

  const refreshBadge = () => badgeRefresh.refresh();
  // The Navigation API reports an in-app move (pushState) with no address needed.
  const navigation = (window as { navigation?: EventTarget }).navigation;

  window.addEventListener("message", onWindowMessage);
  document.addEventListener("visibilitychange", refreshBadge);
  window.addEventListener("focus", refreshBadge);
  const badgeTimer = window.setInterval(refreshBadge, BADGE_REFRESH_MS);
  navigation?.addEventListener("navigatesuccess", refreshBadge);

  /**
   * The extension changed under the page. Stops everything this script runs that
   * would call it, takes the X-ray lines and panel off the form, closes the
   * event map, what changed and save preview panels (their answers can no
   * longer be checked or refreshed), and leaves the hover card to say the page
   * needs a reload.
   */
  function teardown(): void {
    labelFormId.cancel();
    window.clearInterval(badgeTimer);
    document.removeEventListener("visibilitychange", refreshBadge);
    window.removeEventListener("focus", refreshBadge);
    navigation?.removeEventListener("navigatesuccess", refreshBadge);
    xray.setOn(false);
    eventMap.close();
    whatChanged.close();
    savePreview.close();
    hover.extensionGone();
    console.info("[pathix] the extension was updated; reload this page to use it");
  }
  context.onGone(teardown);
  context.start();

  hover.attach();
  eventMap.attach();
  whatChanged.attach();
  savePreview.attach();

  // The toolbar popup, and the keyboard commands the worker relays. Both reach
  // the same controller entry points; no shortcut is a page key handler.
  chrome.runtime.onMessage.addListener(
    contentCommandListener(chrome.runtime.id, {
      formState,
      connectionStatus,
      setXray: (on) => {
        xray.setOn(on);
        return xray.isOn;
      },
      toggleXray: () => xray.toggle(),
      openEventMap: () => eventMap.open(),
      openWhatChanged: () => whatChanged.open(),
      openSavePreview: () => savePreview.open(),
      openFieldCard: () => hover.openFocused(),
    }),
  );
  // The worker's tab update: a page finished loading or moving.
  chrome.runtime.onMessage.addListener(refreshBadgeListener(chrome.runtime.id, () => badgeRefresh.refresh()));
  // Sign-out, or a new Pathix address: everything on the form that shows Pathix's answers asks again, so it says
  // what the connection is now; what shows only Lite's answers is left alone. The card's reset asks again and moves
  // no focus. If it is closed later, its focus goes back to the X-ray line for its field as X-ray has redrawn it.
  chrome.runtime.onMessage.addListener(
    pathixResetListener(chrome.runtime.id, () => {
      hover.reset();
      xray.reset();
      eventMap.reset();
      whatChanged.reset();
      savePreview.reset();
    }),
  );
  console.info("[pathix] content script loaded");
  window.postMessage(helloMessage(), "/");
}

if (isDynamicsOrgHost(window.location.host)) start();
