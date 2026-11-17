// Which form requests the service worker answers. A snapshot, a card, X-ray,
// the event map, the save preview and the change ledger all name an
// organization id and a host. The organization id comes from the page, and
// anything on the page can post a snapshot, so the worker answers only:
//
// - for the host of the tab that asked: the content script writes its own
//   location.host into the snapshot, and the worker checks it against the
//   sender's origin, so a page cannot name another environment's host;
// - for a few organization ids per tab, so random ids cannot drive unbounded
//   Pathix reads or sign-ins. A page load starts the count again.

/** The host of the page a message came from, or null when the sender names none. */
export function senderHost(sender: { origin?: string; url?: string }): string | null {
  const address = sender.origin ?? sender.url;
  if (!address) return null;
  try {
    return new URL(address).host.toLowerCase();
  } catch {
    return null;
  }
}

/** How many distinct organization ids one tab may ask about between page loads. */
export const MAX_ORGANIZATIONS_PER_TAB = 3;

/** The organization ids each tab has asked about since its page loaded. */
export class TabOrganizations {
  private readonly seen = new Map<number, Set<string>>();

  constructor(private readonly max = MAX_ORGANIZATIONS_PER_TAB) {}

  /** Whether this tab may ask about this organization. A request with no tab is refused. */
  admit(tabId: number | undefined, organizationId: string): boolean {
    if (tabId === undefined) return false;
    const id = organizationId.toLowerCase();
    const known = this.seen.get(tabId) ?? new Set<string>();
    if (known.has(id)) return true;
    if (known.size >= this.max) return false;
    known.add(id);
    this.seen.set(tabId, known);
    return true;
  }

  /** The tab loaded a new page, or closed. */
  reset(tabId: number): void {
    this.seen.delete(tabId);
  }
}

/** A form request's own claim: the organization and the host it is about. */
export interface FormRequestScope {
  organizationId: string;
  host: string;
}

/** Answered only when it names the host of the tab that sent it, and an organization that tab may ask about. */
export function admitFormRequest(
  request: FormRequestScope,
  sender: { origin?: string; url?: string; tab?: { id?: number } },
  tabs: TabOrganizations,
): boolean {
  const host = senderHost(sender);
  if (host === null || request.host.toLowerCase() !== host) return false;
  return tabs.admit(sender.tab?.id, request.organizationId);
}
