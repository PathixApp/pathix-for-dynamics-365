// Entry point of the Power Platform admin center page script (M14). The service
// worker registers this file for admin.powerplatform.microsoft.com, and only
// after the user turned the overlay on and granted that host. It is a content
// script in the isolated world, so it shares the page's DOM and nothing else:
// not its variables, tokens, storage or cookies.
//
// The one thing it reads of the page's address is the path (src/admin/routes.ts).
// It sends ids to the service worker and draws the strings that come back.

import { isAdminOverlayOffCommand, isPathixResetCommand } from "../runtime/admin-overlay";
import { AdminController } from "./controller";

const GUARD = Symbol.for("pathix.admin-overlay");

interface NavigationTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function start(): void {
  // A second injection into the same page (a reload of the extension) must not draw twice.
  const world = globalThis as unknown as Record<symbol, unknown>;
  if (world[GUARD]) return;
  world[GUARD] = true;

  const controller = new AdminController({
    pathname: () => window.location.pathname,
    ask: (request) => chrome.runtime.sendMessage(request),
    document,
    onNavigate(listener) {
      // The Navigation API reports the admin center's client-side moves; popstate covers browsers without it.
      const navigation = (window as unknown as { navigation?: NavigationTarget }).navigation;
      navigation?.addEventListener("currententrychange", listener);
      window.addEventListener("popstate", listener);
      return () => {
        navigation?.removeEventListener("currententrychange", listener);
        window.removeEventListener("popstate", listener);
      };
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
  });

  // The worker says so when the overlay is turned off: remove everything now, not at the next load.
  // On sign-out or a new Pathix address, everything drawn comes off and the page asks again.
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (isAdminOverlayOffCommand(message)) controller.stop();
    else if (isPathixResetCommand(message)) controller.pathixReset();
    return false;
  });

  controller.start();
}

start();
