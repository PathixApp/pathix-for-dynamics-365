// Runs in the page's own JavaScript world (manifest "world": "MAIN") because
// that is the only place Xrm is visible. It shares that world with D365's
// scripts, so it does nothing but read names and post them to the
// isolated-world content script, which validates every message.
//
// The unified interface is a single-page app: moving between records, forms
// and grids never reloads the page. A cheap poll catches every transition,
// and a message goes out only when the snapshot actually changes. The poll
// pauses while the tab is hidden, and a read that keeps failing is logged
// once per reason (page-poll.ts).
//
// It runs only on a Dynamics 365 org host (src/bridge/org-host.ts). Anywhere
// else on dynamics.com it sets no flag, adds no listener and posts nothing.

import { buildPageMessage, type XrmLike } from "./form-snapshot";
import { PagePoll } from "./page-poll";
import { CHANNEL, isHelloMessage } from "../bridge/messages";
import { isDynamicsOrgHost } from "../bridge/org-host";

function startPoll(): void {
  const poll = new PagePoll({
    read: () => buildPageMessage((window as unknown as { Xrm?: XrmLike }).Xrm, window.location.host),
    // "/" restricts delivery to this page's own origin.
    post: (message) => window.postMessage(message, "/"),
    // The error stays in this page's console; only the fixed reason crosses the bridge.
    log: (error) => console.info("[pathix] reading the form failed", error),
    every: (handler, ms) => window.setInterval(handler, ms),
    stop: (id) => window.clearInterval(id),
    // A state of the tab, never what it shows. Anything but a plain true is not hidden.
    hidden: () => document.hidden === true,
  });

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source === window && isHelloMessage(event.data)) poll.hello();
  });
  document.addEventListener("visibilitychange", () => poll.visibilityChanged());
  poll.start();
}

if (isDynamicsOrgHost(window.location.host) && !(window as unknown as Record<string, unknown>)[CHANNEL]) {
  (window as unknown as Record<string, unknown>)[CHANNEL] = true;
  startPoll();
}
