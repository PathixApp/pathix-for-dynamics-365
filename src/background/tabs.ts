// Messages from the service worker to every open tab's content script.
//
// Tab ids need no permission, and a tab with no content script (any page that
// is not D365) has no listener, so its send fails and is ignored. The message
// carries no address and nothing learned from the page.

import type { PathixResetCommand } from "../runtime/messages";

/** The slice of chrome.tabs this uses. */
export interface TabsApi {
  query(queryInfo: Record<string, never>): Promise<Array<{ id?: number }>>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/** Sign-out, or a new Pathix address: take Pathix's answers off every open form. */
export const PATHIX_RESET: PathixResetCommand = { kind: "pathixReset" };

/** Sends `message` to every tab. Never throws: a tab that cannot be reached has nothing to take down. */
export async function tellTabs(tabs: TabsApi, message: PathixResetCommand): Promise<void> {
  try {
    const all = await tabs.query({});
    await Promise.all(all.flatMap((tab) => (tab.id === undefined ? [] : [tabs.sendMessage(tab.id, message).catch(() => undefined)])));
  } catch {
    // The tabs could not be listed: there is nothing to tell.
  }
}

/** The real browser behind TabsApi. */
export function chromeTabs(api: Pick<typeof chrome, "tabs">): TabsApi {
  return {
    query: (queryInfo) => api.tabs.query(queryInfo),
    sendMessage: (tabId, message) => api.tabs.sendMessage(tabId, message),
  };
}
