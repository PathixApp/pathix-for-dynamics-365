// Runs the admin center overlay on one page (M14). The page is a client-routed
// app: the path changes without a load and the grids and panes re-render, so
// this watches the DOM and the path, draws on the three pages it knows, and
// removes everything when the path moves to another page or the overlay is
// turned off.
//
// The page script is the isolated-world content script the worker registered
// after the user granted the admin host. It reads ids only (routes.ts, dom.ts),
// makes no network call, and never touches the page's tokens, storage or
// cookies: every Pathix answer comes from the service worker, through `ask`,
// which sends ids and gets back strings to show.
//
// Silence is the failure mode (DESIGN.md, "Absence is not evidence"): a page
// that does not match, a Pathix that is not set up, an environment Pathix does
// not scan, or an answer that did not come all leave the admin center exactly
// as it was.

import {
  isAppUserChipModel,
  isRoleBadgeModel,
  isRoleBannerModel,
  MAX_ADMIN_IDS,
  type AdminAppUsersRequest,
  type AdminRoleListRequest,
  type AdminRoleRequest,
  type AppUserChipModel,
  type RoleBadgeModel,
  type RoleBannerModel,
} from "../runtime/admin-overlay";
import { appIdCells, bannerAnchor, roleLinks } from "./dom";
import { parseAdminRoute, routeKey, type AdminRoute } from "./routes";
import { drawBadge, drawBanner, drawChip, type Drawn } from "./view";

export interface AdminDeps {
  /** The page's path, nothing else of its address. */
  pathname(): string;
  /** Sends one validated request to the service worker. */
  ask(request: AdminRoleRequest | AdminRoleListRequest | AdminAppUsersRequest): Promise<unknown>;
  document: Document;
  /** Listens for the page moving without a load; returns a function that stops listening. */
  onNavigate(listener: () => void): () => void;
  /** Timers, so a test or smoke run can drive them. */
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** A burst of page changes is one refresh. */
const REFRESH_DELAY_MS = 150;
/** A request that got no answer is not retried for this long. */
const RETRY_MS = 30_000;

export class AdminController {
  private key = "";
  /** Bumped on every route change and on stop: an answer from an earlier page is dropped. */
  private generation = 0;
  private stopped = false;
  private observer: MutationObserver | null = null;
  private stopListening: (() => void) | null = null;
  private timer: number | null = null;
  private bannerRetryAt = 0;

  private banner: { requested: boolean; model: RoleBannerModel | null; drawn: Drawn | null } = emptyBanner();
  private readonly badges = new Wanted<RoleBadgeModel>(isRoleBadgeModel);
  private readonly chips = new Wanted<AppUserChipModel>(isAppUserChipModel);
  /** The hosts drawn beside role links and in app-id cells, by the node they sit beside. */
  private readonly badgeHosts = new Map<Element, DrawnFor>();
  private readonly chipHosts = new Map<Element, DrawnFor>();

  constructor(private readonly deps: AdminDeps) {}

  start(): void {
    this.observer = new MutationObserver(() => this.schedule());
    // A grid that sorts, filters or pages can reuse a node and change only what it points at or says, so
    // the link target and the text of a node are watched as well as the nodes that come and go.
    this.observer.observe(this.deps.document.body ?? this.deps.document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.stopListening = this.deps.onNavigate(() => this.schedule());
    this.refresh();
  }

  /** Removes everything drawn and stops watching. The overlay was turned off. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.observer?.disconnect();
    this.observer = null;
    this.stopListening?.();
    this.stopListening = null;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.removeEverything();
  }

  /**
   * The user signed out, or the Pathix address changed: every banner, badge
   * and chip comes off, every answer in flight is dropped, and the page asks
   * again. Asked while signed out, the worker answers nothing to draw, so the
   * page stays as the admin center left it.
   */
  pathixReset(): void {
    if (this.stopped) return;
    this.reset();
    this.key = "";
    this.refresh();
  }

  /** What is in the page right now, for tests. */
  get drawn(): { banner: boolean; badges: number; chips: number } {
    return {
      banner: this.banner.drawn?.host.isConnected === true,
      badges: [...this.badgeHosts.values()].filter(({ drawn }) => drawn.host.isConnected).length,
      chips: [...this.chipHosts.values()].filter(({ drawn }) => drawn.host.isConnected).length,
    };
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_DELAY_MS);
  }

  /** Reads the path, resets when the page changed, and draws what the page and the answers allow. */
  refresh(): void {
    if (this.stopped) return;
    const route = parseAdminRoute(this.deps.pathname());
    const key = routeKey(route);
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    // Most pages are not ours: no query, no request, no cost.
    if (!route) return;

    switch (route.kind) {
      case "roleEditor":
        this.refreshEditor(route);
        break;
      case "roleList":
        this.refreshRoleList(route);
        break;
      case "appUsers":
        this.refreshAppUsers(route);
        break;
    }
    // Our own inserts are already queued for the observer; only the page's changes should wake us.
    this.observer?.takeRecords();
  }

  // --- the role editor ---------------------------------------------------------------

  private refreshEditor(route: Extract<AdminRoute, { kind: "roleEditor" }>): void {
    if (!this.banner.requested && Date.now() >= this.bannerRetryAt) {
      this.banner.requested = true;
      const generation = this.generation;
      void this.answer(generation, { kind: "adminRole", organizationId: route.organizationId, roleId: route.roleId }, (answer) => {
        const model = (answer as { banner?: unknown } | null)?.banner;
        if ((answer as { kind?: unknown } | null)?.kind === "role" && isRoleBannerModel(model)) this.banner.model = model;
      }).then((ok) => {
        if (ok || generation !== this.generation) return;
        this.banner.requested = false;
        this.bannerRetryAt = Date.now() + RETRY_MS;
      });
    }
    if (!this.banner.model) return;

    const anchor = bannerAnchor(this.deps.document, this.banner.drawn?.host ?? null);
    if (!anchor) {
      // No place we are sure of: draw nothing, and take back a banner the page re-rendered out from under.
      this.banner.drawn?.host.remove();
      return;
    }
    const drawn = (this.banner.drawn ??= drawBanner(this.deps.document, this.banner.model));
    if (anchor.nextElementSibling !== drawn.host) anchor.after(drawn.host);
  }

  // --- the role list -----------------------------------------------------------------

  private refreshRoleList(route: Extract<AdminRoute, { kind: "roleList" }>): void {
    const links = roleLinks(this.deps.document, route.organizationId);
    this.badges.want(
      links.map((link) => link.roleId),
      (ids, accept) => this.ask({ kind: "adminRoleList", organizationId: route.organizationId, roleIds: ids }, "badges", accept),
    );
    this.sweep(this.badgeHosts, new Map(links.map((link) => [link.link, link.roleId])));
    for (const { roleId, link } of links) {
      const model = this.badges.models.get(roleId);
      if (!model) continue;
      const drawn = this.hostFor(this.badgeHosts, link, roleId, () => drawBadge(this.deps.document, model));
      if (link.nextElementSibling !== drawn.host) link.after(drawn.host);
    }
  }

  // --- application users --------------------------------------------------------------

  private refreshAppUsers(route: Extract<AdminRoute, { kind: "appUsers" }>): void {
    const cells = appIdCells(this.deps.document);
    this.chips.want(
      cells.map((cell) => cell.appId),
      (ids, accept) => this.ask({ kind: "adminAppUsers", organizationId: route.organizationId, appIds: ids }, "chips", accept),
    );
    this.sweep(this.chipHosts, new Map(cells.map((cell) => [cell.cell, cell.appId])));
    for (const { appId, cell } of cells) {
      const model = this.chips.models.get(appId);
      if (!model) continue;
      const drawn = this.hostFor(this.chipHosts, cell, appId, () => drawChip(this.deps.document, model));
      // At the start of the cell, before the GUID: the real cell is 270px with
      // overflow hidden and no wrap, so a chip after the GUID was clipped. The
      // GUID's tail may be clipped instead, by the admin center's own overflow.
      if (cell.firstChild !== drawn.host) cell.prepend(drawn.host);
    }
  }

  // --- shared -------------------------------------------------------------------------

  /** Sends a request and hands the answer's records to `accept`, unless the page moved on. Resolves false when no answer came. */
  private ask(
    request: AdminRoleListRequest | AdminAppUsersRequest,
    field: "badges" | "chips",
    accept: (records: Record<string, unknown>) => void,
  ): Promise<boolean> {
    return this.answer(this.generation, request, (answer) => {
      const records = (answer as Record<string, unknown> | null)?.[field];
      if (typeof records === "object" && records !== null) accept(records as Record<string, unknown>);
    });
  }

  private async answer(generation: number, request: Parameters<AdminDeps["ask"]>[0], accept: (answer: unknown) => void): Promise<boolean> {
    let answer: unknown;
    try {
      answer = await this.deps.ask(request);
    } catch {
      // The worker restarts on demand; a later refresh asks again.
      return generation !== this.generation;
    }
    // An answer for a page we have left is dropped, and is not a failure of this page's request.
    if (generation !== this.generation || this.stopped) return true;
    if (typeof answer !== "object" || answer === null) return false;
    accept(answer);
    this.schedule();
    return true;
  }

  private hostFor(hosts: Map<Element, DrawnFor>, node: Element, id: string, draw: () => Drawn): Drawn {
    const existing = hosts.get(node);
    if (existing) return existing.drawn;
    const drawn = draw();
    hosts.set(node, { id, drawn });
    return drawn;
  }

  /**
   * Drops the hosts whose node the page removed or no longer lists, and the
   * hosts whose node now shows another id than the one drawn for (a grid that
   * reuses a row for another role or app user), so none outlives its row or
   * speaks for the wrong one. The node is drawn again when the new id has an answer.
   */
  private sweep(hosts: Map<Element, DrawnFor>, current: Map<Element, string>): void {
    for (const [node, { id, drawn }] of [...hosts]) {
      if (current.get(node) === id && node.isConnected) continue;
      drawn.host.remove();
      hosts.delete(node);
    }
  }

  private reset(): void {
    this.generation++;
    this.removeEverything();
  }

  private removeEverything(): void {
    this.banner.drawn?.host.remove();
    this.banner = emptyBanner();
    this.bannerRetryAt = 0;
    for (const { drawn } of this.badgeHosts.values()) drawn.host.remove();
    for (const { drawn } of this.chipHosts.values()) drawn.host.remove();
    this.badgeHosts.clear();
    this.chipHosts.clear();
    this.badges.clear();
    this.chips.clear();
  }
}

/** A drawn host and the id (role or Application ID) it was drawn for. */
interface DrawnFor {
  id: string;
  drawn: Drawn;
}

function emptyBanner(): { requested: boolean; model: RoleBannerModel | null; drawn: Drawn | null } {
  return { requested: false, model: null, drawn: null };
}

/**
 * The answers for a set of ids the page shows. An id is asked for once: the
 * ids a page shows grow as it pages and scrolls, and only new ids go out. An id
 * the answer leaves out has no model and nothing is drawn for it. A request
 * that got no answer is tried again after a pause.
 */
class Wanted<T> {
  readonly models = new Map<string, T>();
  private readonly asked = new Set<string>();
  private retryAt = 0;

  constructor(private readonly isModel: (value: unknown) => value is T) {}

  want(ids: string[], send: (ids: string[], accept: (records: Record<string, unknown>) => void) => Promise<boolean>): void {
    if (Date.now() < this.retryAt) return;
    const fresh = [...new Set(ids)].filter((id) => !this.asked.has(id)).slice(0, MAX_ADMIN_IDS);
    if (fresh.length === 0) return;
    for (const id of fresh) this.asked.add(id);
    void send(fresh, (records) => {
      for (const [id, model] of Object.entries(records)) {
        if (this.isModel(model)) this.models.set(id.toLowerCase(), model);
      }
    }).then((answered) => {
      if (answered) return;
      for (const id of fresh) this.asked.delete(id);
      this.retryAt = Date.now() + RETRY_MS;
    });
  }

  clear(): void {
    this.models.clear();
    this.asked.clear();
    this.retryAt = 0;
  }
}
