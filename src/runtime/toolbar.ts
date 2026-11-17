// The content script's side of the toolbar: the popup's commands, the
// keyboard commands the worker relays, and the worker's "refresh the badge"
// after a tab loads.
//
// The toolbar button opens the popup (src/popup). The popup asks the active
// tab's content script whether a record form is open, and sends it the
// feature the user picked. A keyboard shortcut is a manifest command
// (./commands.ts): the browser tells the worker, and the worker sends the same
// kind of message to the tab. A tab with no content script (any page that is
// not D365) never answers. Only the extension itself can send these; a page
// cannot reach chrome.runtime.

import { isContentCommand, isPathixResetCommand, isRefreshBadgeCommand, type ConnectionStatusAnswer, type FieldCardOpen, type FormState } from "./messages";

/**
 * What the content script does for each command. The popup and the keyboard
 * commands reach the same controller entry points (DESIGN.md, "Entry points").
 */
export interface ContentCommandHandlers {
  /** At once, from the content script's own state. */
  formState(): FormState;
  /** Can wait on Pathix. */
  connectionStatus(): Promise<ConnectionStatusAnswer>;
  /** Turns X-ray on or off; answers whether it is now on. */
  setXray(on: boolean): boolean;
  toggleXray(): void;
  openEventMap(): void;
  openWhatChanged(): void;
  openSavePreview(): void;
  /** Answers whether the card opened, or why not. */
  openFieldCard(): FieldCardOpen;
}

type Listener = (message: unknown, sender: { id?: string }, sendResponse: (response: unknown) => void) => boolean | undefined;

/** Content script side: answers the popup and the worker. Returns true only while an answer is still coming. */
export function contentCommandListener(extensionId: string, handlers: ContentCommandHandlers): Listener {
  return (message, sender, sendResponse) => {
    if (sender.id !== extensionId || !isContentCommand(message)) return undefined;
    switch (message.kind) {
      case "formState":
        sendResponse(handlers.formState());
        return undefined;
      case "connectionStatus":
        handlers.connectionStatus().then(sendResponse, () => sendResponse(undefined));
        return true;
      case "setXray":
        sendResponse(handlers.setXray(message.on));
        return undefined;
      case "openEventMap":
        handlers.openEventMap();
        break;
      case "openWhatChanged":
        handlers.openWhatChanged();
        break;
      case "openSavePreview":
        handlers.openSavePreview();
        break;
      case "openFieldCard":
        // The popup says so when no field has focus, or the one that has it has no card.
        sendResponse(handlers.openFieldCard());
        return undefined;
      case "toggleXray":
        handlers.toggleXray();
        break;
    }
    sendResponse(true);
    return undefined;
  };
}

/**
 * Content script side: the worker says a tab finished loading or moving, so
 * the badge is re-sent. A tab that is not D365 has no content script and
 * never hears this, so its badge stays cleared. No address is involved.
 */
export function refreshBadgeListener(
  extensionId: string,
  refresh: () => void,
): (message: unknown, sender: { id?: string }, sendResponse: (response: boolean) => void) => void {
  return (message, sender, sendResponse) => {
    if (sender.id !== extensionId || !isRefreshBadgeCommand(message)) return;
    refresh();
    sendResponse(true);
  };
}

/**
 * Content script side: the worker says the user signed out or the Pathix
 * address changed, so what the form shows from Pathix is taken down. Only the
 * extension itself can send it.
 */
export function pathixResetListener(
  extensionId: string,
  reset: () => void,
): (message: unknown, sender: { id?: string }, sendResponse: (response: boolean) => void) => void {
  return (message, sender, sendResponse) => {
    if (sender.id !== extensionId || !isPathixResetCommand(message)) return;
    reset();
    sendResponse(true);
  };
}
