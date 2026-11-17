// The host a form snapshot is relayed with. The page script reports the host,
// but anything on the page can post a snapshot, so the content script writes
// its own location.host over it: the host of the tab it runs in. That is the
// only part of the address it reads (test/page-source.test.ts), and the
// service worker checks it against the sender's origin again.

import type { PageMessage } from "../bridge/messages";

export function withPageHost(message: PageMessage, pageHost: string): PageMessage {
  return message.kind === "formSnapshot" ? { ...message, host: pageHost.toLowerCase() } : message;
}
