// Smoke test for the Power Platform admin center overlay (M14), in real
// Chromium, in two parts.
//
// Part 1 bundles the page script's controller and view (src/admin) and runs
// them on a fake admin center page served under the real host name, with
// hand-written Pathix answers from the real model builders. It checks what only
// a browser can: where the banner lands (below the breadcrumb, above "Details"),
// one badge per role row, a chip per Application ID cell, closed shadow roots,
// that the admin center's own nodes are left as they were, that a client-side
// move cleans up, that a missing answer leaves the page untouched, and that the
// page script makes no request of its own.
//
// Part 2 loads the real build, with the admin host granted in a test-only copy
// of the manifest (a permission prompt cannot be answered in headless
// Chromium), and checks the runtime registration: nothing is registered until
// the overlay is turned on, turning it on registers the script for the admin
// host, the script then runs on the admin page and not on a sign-in page, and
// turning it off unregisters it. With no Pathix set up, the script draws
// nothing: silence is the failure mode.
//
// The Pathix side (what the answers say, how many requests) is in
// test/admin-model.test.ts.

import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  buildAppUserChip,
  buildNotInPathixChip,
  buildRoleBadge,
  buildRoleBanner,
  findingsFor,
  roleGroup,
  roleOpenCounts,
} from "../src/card/admin";
import type { RoleSummary } from "../src/pathix/api";
import {
  ORG as ORGANIZATION,
  COMPLETED,
  EMPTY,
  INTEGRATION,
  LEGACY_ROLES,
  OMITTED,
  OPEN_COUNTS,
  ROLES,
  SALES,
  appUser,
  context as pathixContext,
  roleRow,
} from "../test/admin-fixtures";

const ADMIN = "https://admin.powerplatform.microsoft.com";
const ORG = ORGANIZATION;
const EDITOR = `/manage/environments/${ORG}/securityroles/${SALES.sourceId}/roleeditor`;
const LIST = `/manage/environments/${ORG}/securityroles`;
/** How the real role list links each role: no /manage prefix (captured 2026-10-09). */
const ROLE_LINK_BASE = `/environments/${ORG}/securityroles`;
const USERS = `/manage/environments/${ORG}/appusers`;
const OTHER = `/manage/environments/${ORG}/e2000000-0000-4000-8000-000000000009/users`;

/** The real Application ID cell (captured 2026-10-09): 270px, clipped, on one line. A chip after the GUID fell outside it. */
const APP_ID_CELL_STYLE = "display:block;width:270px;overflow:hidden;white-space:nowrap";

const SAMPLE_ROLE = "Sales Manager";
const EMAIL_IN_GRID = "someone@contoso.com";

// --- the fake admin center ---------------------------------------------------------------

function pageFor(path: string): string {
  const crumbs = `<header id="top"><div id="bar"><nav aria-label="Breadcrumb" id="crumbs"><ol><li><a href="${LIST}">Security roles</a></li><li>${SAMPLE_ROLE}</li></ol></nav></div></header>`;
  const body = (() => {
    if (path.endsWith("/roleeditor")) return `${crumbs}<section id="details"><h2>Details</h2><p>Role name: ${SAMPLE_ROLE}</p></section>`;
    if (path.endsWith("/securityroles")) {
      const rows = LIST_ROLES
        .map(
          (role, index) =>
            `<div role="row" id="row-${index}"><div role="gridcell"><a id="icon-${index}" href="${ROLE_LINK_BASE}/${role.sourceId}/roleeditor">icon</a>` +
            `<a id="link-${index}" role="link" href="${ROLE_LINK_BASE}/${role.sourceId}/roleeditor">${SAMPLE_ROLE} ${index}</a></div><div role="gridcell">Business unit</div></div>`,
        )
        .join("");
      // A link to a role of another organization, and one that is not a role at all: neither gets a badge.
      return `${crumbs}<div role="grid" id="grid"><div role="row" id="row-head"><div role="columnheader">Name</div></div>${rows}` +
        `<div role="row" id="row-foreign"><div role="gridcell"><a id="foreign" href="/environments/6d5b0000-0000-4000-8000-000000000004/securityroles/${SALES.sourceId}/roleeditor">Foreign</a></div></div>` +
        `<div role="row" id="row-help"><div role="gridcell"><a id="help" href="/help/securityroles/x">Help</a></div></div></div>`;
    }
    if (path.endsWith("/appusers")) {
      const row = (id: string, name: string, appId: string, extra = "") =>
        `<div role="row" id="${id}"><div role="gridcell">${name}</div><div role="gridcell" id="${id}-app" style="${APP_ID_CELL_STYLE}">${appId}</div><div role="gridcell">${extra}</div></div>`;
      return (
        `${crumbs}<div role="grid" id="grid"><div role="row"><div role="columnheader">Name</div><div role="columnheader">Application ID</div></div>` +
        row("u1", "Contoso Integration", appUser(1).appId!, EMAIL_IN_GRID) +
        row("u2", "Unscanned App", "c3000000-0000-4000-8000-0000000fffff") +
        // Two GUIDs in one row: not known to be the Application ID, so skipped.
        row("u3", "Ambiguous", appUser(3).appId!, appUser(4).appId!) +
        // Not a GUID alone: skipped.
        row("u4", "Mixed", `${appUser(5).appId} (Contoso)`) +
        `</div>`
      );
    }
    return `<h1>Somewhere else</h1><p>${OTHER}</p>`;
  })();
  return `<!doctype html><html><head><title>Power Platform admin center</title></head><body><div id="app">${body}</div></body></html>`;
}

async function serveAdmin(target: Page | BrowserContext, requests: string[] = []): Promise<void> {
  await target.route(`${ADMIN}/**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    return route.fulfill({ status: 200, contentType: "text/html", body: pageFor(url.pathname) });
  });
}

// --- the answers the worker would give ------------------------------------------------------

// A role and an application user that are on no first screen: the page reaches them by paging or sorting,
// so their numbers can only come from a second request.
const LATE_ROLE = { id: "a9000000-0000-4000-8000-0000000000aa", sourceId: "d9000000-0000-4000-8000-0000000000aa" };
const LATE_APP_ID = "c3000000-0000-4000-8000-0000000ddddd";
const WITH_LATE: RoleSummary[] = [...ROLES, roleRow(LATE_ROLE, "Late Role", { humans: 5, integrations: 2 })];

// The admin center lists root roles: Sales Manager (with two business unit copies in Pathix), a role held by one
// application user, a role the open counts leave out (its findings read "?"), and a role nobody holds.
const LIST_ROLES = [SALES, INTEGRATION, OMITTED, EMPTY];

// The worker's answers, built by the real model builders from the fake Pathix answers in test/admin-fixtures.ts.
const COUNTS = roleOpenCounts([
  {
    fields: [],
    roles: Object.entries({ ...OPEN_COUNTS, [LATE_ROLE.id]: { openCount: 4, maxOpenSeverity: "Medium" } }).map(([roleId, row]) => ({ roleId, ...row })),
    readiness: COMPLETED,
  },
]);
function bannerFor(roles: RoleSummary[], ids: { sourceId: string }) {
  const group = roleGroup(roles, ids.sourceId)!;
  return buildRoleBanner(pathixContext, group, findingsFor(COUNTS, group.rows));
}
function badgesFor(roles: RoleSummary[], list: Array<{ sourceId: string }>) {
  return Object.fromEntries(
    list.map((ids) => {
      const group = roleGroup(roles, ids.sourceId)!;
      return [ids.sourceId, buildRoleBadge(pathixContext, group, findingsFor(COUNTS, group.rows))];
    }),
  );
}

const bannerAnswer = { kind: "role", banner: bannerFor(ROLES, SALES) };
const badgesAnswer = { kind: "roles", badges: badgesFor(WITH_LATE, [...LIST_ROLES, LATE_ROLE]) };
const chipsAnswer = {
  kind: "appUsers",
  chips: {
    [appUser(1).appId!]: buildAppUserChip(pathixContext, appUser(1)),
    "c3000000-0000-4000-8000-0000000fffff": buildNotInPathixChip(pathixContext),
    [LATE_APP_ID]: buildAppUserChip(pathixContext, { ...appUser(2), appId: LATE_APP_ID, roleCount: 5 }),
  },
};
const answers = { adminRole: bannerAnswer, adminRoleList: badgesAnswer, adminAppUsers: chipsAnswer };

// --- part 1: the controller and view in a page -------------------------------------------------

let browser: Browser;
let bundle: string;

test.beforeAll(async () => {
  const executablePath = process.env.PATHIX_SMOKE_CHROMIUM;
  if (executablePath && !existsSync(executablePath)) throw new Error(`No browser at ${executablePath}.`);
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chromium" });
  const result = await build({
    entryPoints: ["src/admin/controller.ts"],
    bundle: true,
    format: "iife",
    globalName: "PathixAdmin",
    target: "chrome113",
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

test.afterAll(async () => {
  await browser?.close();
});

interface Overlay {
  drawn: { banner: boolean; badges: number; chips: number };
  stop(): void;
  refresh(): void;
  pathixReset(): void;
}

async function openAdmin(
  path: string,
  canned: Record<string, unknown> = answers,
  delayMs = 0,
): Promise<{ page: Page; requests: string[] }> {
  const page = await browser.newPage();
  const requests: string[] = [];
  await serveAdmin(page, requests);
  await page.goto(`${ADMIN}${path}`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(({ canned, delayMs }) => {
    const w = window as unknown as Record<string, unknown>;
    w.asked = [];
    // A test can swap the worker's answers, as a sign-out does.
    w.canned = canned;
    const nav = (window as unknown as { navigation: EventTarget }).navigation;
    w.overlay = new (w.PathixAdmin as { AdminController: new (deps: unknown) => Overlay }).AdminController({
      pathname: () => location.pathname,
      ask: async (request: { kind: string }) => {
        (w.asked as unknown[]).push(request);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const answer = (w.canned as Record<string, unknown>)[request.kind] ?? { kind: "none" };
        // Like Pathix, answer only for the ids asked about: an id on a later screen has no numbers until it is asked for.
        const only = (records: Record<string, unknown> | undefined, ids: string[] | undefined) =>
          records && ids ? Object.fromEntries(Object.entries(records).filter(([id]) => ids.some((asked) => asked.toLowerCase() === id.toLowerCase()))) : records;
        const typed = answer as { badges?: Record<string, unknown>; chips?: Record<string, unknown> };
        const req = request as { roleIds?: string[]; appIds?: string[] };
        if (typed.badges) return { ...typed, badges: only(typed.badges, req.roleIds) };
        if (typed.chips) return { ...typed, chips: only(typed.chips, req.appIds) };
        return answer;
      },
      document,
      onNavigate: (listener: () => void) => {
        nav.addEventListener("currententrychange", listener);
        return () => nav.removeEventListener("currententrychange", listener);
      },
      setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
      clearTimeout: (handle: number) => window.clearTimeout(handle),
    });
    (w.overlay as { start(): void }).start();
  }, { canned, delayMs });
  return { page, requests };
}

const drawn = (page: Page) => page.evaluate(() => (window as unknown as { overlay: Overlay }).overlay.drawn);
const asked = (page: Page) => page.evaluate(() => (window as unknown as { asked: Array<Record<string, unknown>> }).asked);

/** Waits until the drawn counts are these. */
async function expectDrawn(page: Page, expected: { banner: boolean; badges: number; chips: number }): Promise<void> {
  await expect.poll(() => drawn(page), { timeout: 5000 }).toEqual(expected);
}

/** Every text node on the page, closed shadow roots included, read through the DevTools protocol. */
async function screenText(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  const texts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 3 && node.parentName !== "STYLE" && node.parentName !== "SCRIPT") texts.push(node.nodeValue ?? "");
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk({ ...child, parentName: node.nodeName });
  };
  walk(root);
  return texts.join("\n");
}

interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentName?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/** The page's own markup with our hosts left out, to prove none of the admin center's nodes changed. */
const pageMarkup = (page: Page) =>
  page.evaluate(() => {
    const copy = document.getElementById("app")!.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").forEach((host) => host.remove());
    return copy.innerHTML;
  });

const navigate = (page: Page, path: string) => page.evaluate((path) => history.pushState({}, "", path), path);

test("draws the banner below the breadcrumb and above Details, in a closed shadow root", async () => {
  const { page, requests } = await openAdmin(EDITOR);
  const before = await pageMarkup(page);
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });

  // Directly after the bar that holds the breadcrumb, directly before the Details section.
  const order = await page.evaluate(() => Array.from(document.getElementById("app")!.children).map((node) => node.localName + (node.id ? `#${node.id}` : "")));
  expect(order).toEqual(["header#top", "pathix-admin-banner", "section#details"]);
  // Closed: the page cannot reach into it.
  expect(await page.evaluate(() => document.querySelector("pathix-admin-banner")!.shadowRoot)).toBeNull();

  const text = await screenText(page);
  // The role's two business unit copies are folded in: exact numbers, platform-managed users apart, no hedge.
  expect(text).toContain("Assigned to 6 humans, 1 integration and 1 platform-managed user");
  expect(text).toContain("2 teams also hold this role. Their members are not counted.");
  expect(text).toContain("The numbers include 2 business unit copies of this role.");
  expect(text).toContain("3 open findings name this role (highest: Critical)");
  expect(text).not.toMatch(/at least/i);
  expect(text).toContain("From Pathix's latest scan, on 2026-10-06");
  expect(text).toContain("Open in Pathix");

  // The admin center's own nodes are exactly as they were.
  expect(await pageMarkup(page)).toBe(before);
  // One request, with the ids from the address and nothing else.
  expect(await asked(page)).toEqual([{ kind: "adminRole", organizationId: ORG, roleId: SALES.sourceId }]);
  // The page script made no request of its own: the page was fetched once.
  expect(requests).toEqual([EDITOR]);
  await page.close();
});

test("links open Pathix in a new tab without handing it the opener", async () => {
  const { page } = await openAdmin(EDITOR);
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });
  const cdp = await page.context().newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: { children?: unknown[] } };
  await cdp.detach();
  expect(JSON.stringify(root)).toContain("noopener noreferrer");
  expect(JSON.stringify(root)).toContain("_blank");
  await page.close();
});

test("puts the banner back when the page re-renders, and draws nothing if the breadcrumb is gone", async () => {
  const { page } = await openAdmin(EDITOR);
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });

  // The app re-renders its whole content: our host goes with it.
  await page.evaluate(() => {
    const app = document.getElementById("app")!;
    const html = app.innerHTML.replace(/<pathix-admin-banner[^>]*><\/pathix-admin-banner>/g, "");
    app.innerHTML = html;
  });
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner").length)).toBe(1);

  // No breadcrumb: no place we are sure of, so nothing is drawn.
  await page.evaluate(() => document.getElementById("crumbs")!.remove());
  await expectDrawn(page, { banner: false, badges: 0, chips: 0 });
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner").length)).toBe(0);
  await page.close();
});

test("draws one badge per role row, links to the editor only, and follows the list as it changes", async () => {
  const { page } = await openAdmin(LIST);
  const before = await pageMarkup(page);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });

  // After the row's first link (the icon); the row's second link, the foreign link and the help link get none.
  const next = await page.evaluate(() => ["icon-0", "link-0", "icon-1", "foreign", "help"].map((id) => document.getElementById(id)!.nextElementSibling?.localName ?? null));
  expect(next).toEqual(["pathix-admin-badge", null, "pathix-admin-badge", null, null]);
  expect(await page.evaluate(() => document.querySelector("pathix-admin-badge")!.shadowRoot)).toBeNull();

  const text = await screenText(page);
  // Sales Manager counts its business unit copies too, exactly: no "+".
  expect(text).toContain("10 assigned");
  expect(text).toMatch(/(^|\n)3(\n|$)/);
  expect(text).not.toMatch(/\d\+/);
  expect(text).toContain("0 assigned");
  // A count that could not be loaded is ?, never 0: the open counts left one role out.
  expect(text).toContain("4 assigned");
  expect(text).toMatch(/(^|\n)\?(\n|$)/);

  // One request for every row on the page, with ids only.
  const requests = await asked(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ kind: "adminRoleList", organizationId: ORG });
  expect((requests[0]!.roleIds as string[]).sort()).toEqual(LIST_ROLES.map((ids) => ids.sourceId).sort());
  expect(await pageMarkup(page)).toBe(before);

  // The grid pages: a row leaves, a new role arrives. The badge leaves with its row, and the new row (unknown to Pathix) draws nothing.
  await page.evaluate(() => {
    document.getElementById("row-1")!.remove();
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    const link = document.createElement("a");
    // The one link in the /manage form: both forms are read.
    link.href = `/manage/environments/${location.pathname.split("/")[3]}/securityroles/d9999999-0000-4000-8000-000000000000/roleeditor`;
    link.textContent = "Next page role";
    row.append(link);
    document.getElementById("grid")!.append(row);
  });
  await expectDrawn(page, { banner: false, badges: 3, chips: 0 });
  await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBe(2);
  const second = await asked(page);
  expect(second[1]!.roleIds).toEqual(["d9999999-0000-4000-8000-000000000000"]);
  await page.close();
});

test("draws a chip in the Application ID cell of the rows it can be sure of, and reads nothing else", async () => {
  const { page } = await openAdmin(USERS);
  await expectDrawn(page, { banner: false, badges: 0, chips: 2 });

  // The chip comes first in the cell and is wholly inside the cell's box, though the cell clips what overflows it.
  const boxes = await page.evaluate(() =>
    ["u1-app", "u2-app"].map((id) => {
      const cell = document.getElementById(id)!;
      const chip = cell.querySelector("pathix-admin-chip")!;
      const [c, p] = [cell.getBoundingClientRect(), chip.getBoundingClientRect()];
      return { first: cell.firstChild === chip, inside: p.left >= c.left && p.right <= c.right && p.top >= c.top && p.bottom <= c.bottom, width: p.width };
    }),
  );
  for (const box of boxes) expect(box).toMatchObject({ first: true, inside: true });
  for (const box of boxes) expect(box.width).toBeGreaterThan(20);

  const inCells = await page.evaluate(() => ["u1-app", "u2-app", "u3-app", "u4-app"].map((id) => document.getElementById(id)!.querySelectorAll("pathix-admin-chip").length));
  expect(inCells).toEqual([1, 1, 0, 0]);

  const text = await screenText(page);
  expect(text).toContain("Pathix: 1 role");
  expect(text).toContain("Not in Pathix's latest scan");

  // Only the Application IDs went out: no name, no email, nothing of the rows that were skipped.
  const requests = await asked(page);
  expect(requests).toEqual([{ kind: "adminAppUsers", organizationId: ORG, appIds: [appUser(1).appId, "c3000000-0000-4000-8000-0000000fffff"] }]);
  expect(JSON.stringify(requests)).not.toContain(EMAIL_IN_GRID);
  expect(JSON.stringify(requests)).not.toContain("Contoso");
  await page.close();
});

test("a grid that reuses a row for another role replaces or removes the badge, never leaves the old role's numbers", async () => {
  const { page } = await openAdmin(LIST);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });
  const count = async (pattern: RegExp) => (await screenText(page)).match(pattern)?.length ?? 0;
  expect(await count(/\b0 assigned/g)).toBe(1);
  expect(await count(/\b1 assigned/g)).toBe(1);

  // The same link, sorted to another role that Pathix has answered: the badge now speaks for that role.
  await page.evaluate(
    ({ id }) => {
      const link = document.getElementById("icon-3") as HTMLAnchorElement;
      link.setAttribute("href", link.getAttribute("href")!.replace(/securityroles\/[^/]+/, `securityroles/${id}`));
    },
    { id: INTEGRATION.sourceId },
  );
  await expect.poll(() => count(/\b1 assigned/g), { timeout: 5000 }).toBe(2);
  expect(await count(/\b0 assigned/g)).toBe(0);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });

  // The same link, sorted to a role Pathix has no answer for: no badge, and not the old role's.
  await page.evaluate(() => {
    const link = document.getElementById("icon-0") as HTMLAnchorElement;
    link.setAttribute("href", link.getAttribute("href")!.replace(/securityroles\/[^/]+/, "securityroles/d9999999-0000-4000-8000-000000000000"));
  });
  await expectDrawn(page, { banner: false, badges: 3, chips: 0 });
  expect(await count(/\b10 assigned/g)).toBe(0);
  expect(await page.evaluate(() => document.getElementById("icon-0")!.nextElementSibling?.localName)).not.toBe("pathix-admin-badge");
  await page.close();
});

test("a grid that reuses a cell for another Application ID replaces or removes the chip", async () => {
  const { page } = await openAdmin(USERS);
  await expectDrawn(page, { banner: false, badges: 0, chips: 2 });

  // The cell's text node is rewritten in place (no node added or removed): the first row is now the unscanned app.
  await page.evaluate(() => {
    (Array.from(document.getElementById("u1-app")!.childNodes).find((node) => node.nodeType === 3) as Text).data = "c3000000-0000-4000-8000-0000000fffff";
  });
  await expect.poll(async () => (await screenText(page)).match(/Not in Pathix's latest scan/g)?.length ?? 0, { timeout: 5000 }).toBe(2);
  expect(await screenText(page)).not.toContain("Pathix: 1 role");

  // Rewritten to an Application ID Pathix has no answer for: no chip at all.
  await page.evaluate(() => {
    (Array.from(document.getElementById("u2-app")!.childNodes).find((node) => node.nodeType === 3) as Text).data = "c3000000-0000-4000-8000-0000000eeeee";
  });
  await expectDrawn(page, { banner: false, badges: 0, chips: 1 });
  expect(await page.evaluate(() => document.getElementById("u2-app")!.querySelectorAll("pathix-admin-chip").length)).toBe(0);
  await page.close();
});

test("a reused row whose new role needs a second request draws its badge from that answer", async () => {
  const { page } = await openAdmin(LIST);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });
  expect(await asked(page)).toHaveLength(1);
  // The first answer held nothing for the role the grid will bring in.
  expect(await screenText(page)).not.toContain("7 assigned");

  await page.evaluate(
    ({ id }) => {
      const link = document.getElementById("icon-3") as HTMLAnchorElement;
      link.setAttribute("href", link.getAttribute("href")!.replace(/securityroles\/[^/]+/, `securityroles/${id}`));
    },
    { id: LATE_ROLE.sourceId },
  );
  await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBe(2);
  expect((await asked(page))[1]).toMatchObject({ kind: "adminRoleList", roleIds: [LATE_ROLE.sourceId] });
  await expect.poll(async () => (await screenText(page)).includes("7 assigned"), { timeout: 5000 }).toBe(true);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });
  // The old row's numbers are gone: only the new role speaks for that link.
  expect((await screenText(page)).match(/\b0 assigned/g)?.length ?? 0).toBe(0);
  await page.close();
});

test("a reused cell whose new Application ID needs a second request draws its chip from that answer", async () => {
  const { page } = await openAdmin(USERS);
  await expectDrawn(page, { banner: false, badges: 0, chips: 2 });
  expect(await asked(page)).toHaveLength(1);
  expect(await screenText(page)).not.toContain("Pathix: 5 roles");

  await page.evaluate(
    ({ id }) => {
      (Array.from(document.getElementById("u1-app")!.childNodes).find((node) => node.nodeType === 3) as Text).data = id;
    },
    { id: LATE_APP_ID },
  );
  await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBe(2);
  expect((await asked(page))[1]).toMatchObject({ kind: "adminAppUsers", appIds: [LATE_APP_ID] });
  await expect.poll(async () => (await screenText(page)).includes("Pathix: 5 roles"), { timeout: 5000 }).toBe(true);
  await expectDrawn(page, { banner: false, badges: 0, chips: 2 });
  expect(await screenText(page)).not.toContain("Pathix: 1 role");
  await page.close();
});

test("cleans up on a client-side move and draws nothing on a page that is not one of the three", async () => {
  const { page } = await openAdmin(EDITOR);
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });

  await navigate(page, LIST);
  await page.evaluate((html) => {
    document.getElementById("app")!.innerHTML = html;
  }, pageFor(LIST).match(/<div id="app">([\s\S]*)<\/div><\/body>/)![1]!);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });

  // The users page (L2) and anything else: everything is removed and nothing is asked for.
  const askedBefore = (await asked(page)).length;
  await navigate(page, OTHER);
  await expectDrawn(page, { banner: false, badges: 0, chips: 0 });
  await page.evaluate(() => document.getElementById("app")!.append(document.createElement("div")));
  await page.waitForTimeout(400);
  expect((await asked(page)).length).toBe(askedBefore);
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").length)).toBe(0);
  await page.close();
});

test("an answer that arrives after the page was left is dropped", async () => {
  const { page } = await openAdmin(EDITOR, answers, 700);
  await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBe(1);
  await navigate(page, OTHER);
  await page.waitForTimeout(1200);
  expect(await drawn(page)).toEqual({ banner: false, badges: 0, chips: 0 });
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner").length)).toBe(0);
  await page.close();
});

test("a role editor for another role asks again", async () => {
  const { page } = await openAdmin(EDITOR);
  await expectDrawn(page, { banner: true, badges: 0, chips: 0 });
  await navigate(page, `/manage/environments/${ORG}/securityroles/${INTEGRATION.sourceId}/roleeditor`);
  await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBe(2);
  expect((await asked(page))[1]).toMatchObject({ roleId: INTEGRATION.sourceId });
  await page.close();
});

test("on a scan that predates the parent role, draws the hedges: N+ on the badge, at least in the banner", async () => {
  const legacy = { adminRole: { kind: "role", banner: bannerFor(LEGACY_ROLES, SALES) }, adminRoleList: { kind: "roles", badges: badgesFor(LEGACY_ROLES, LIST_ROLES) } };

  const list = await openAdmin(LIST, legacy);
  await expectDrawn(list.page, { banner: false, badges: 4, chips: 0 });
  const listText = await screenText(list.page);
  expect(listText).toContain("6+ assigned");
  expect(listText).toMatch(/(^|\n)2\+(\n|$)/);
  await list.page.close();

  const editor = await openAdmin(EDITOR, legacy);
  await expectDrawn(editor.page, { banner: true, badges: 0, chips: 0 });
  const bannerText = await screenText(editor.page);
  expect(bannerText).toContain("Assigned to at least 3 humans and 1 integration");
  expect(bannerText).toContain("Pathix lists 2 other roles with this name");
  expect(bannerText).toContain("At least 2 open findings name this role (highest seen: High)");
  await editor.page.close();
});

test("stays silent when Pathix has nothing to say: no banner, no badge, no chip, nothing changed", async () => {
  for (const path of [EDITOR, LIST, USERS]) {
    const { page } = await openAdmin(path, {});
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    await expect.poll(async () => (await asked(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await drawn(page)).toEqual({ banner: false, badges: 0, chips: 0 });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
    await page.close();
  }
});

test("a sign-out takes every badge down and asks again; signed out, nothing is drawn back", async () => {
  const { page } = await openAdmin(LIST);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });
  const before = (await asked(page)).length;
  // Signed out, the worker answers nothing to draw.
  await page.evaluate(() => {
    const w = window as unknown as { canned: unknown; overlay: Overlay };
    w.canned = {};
    w.overlay.pathixReset();
  });
  await expectDrawn(page, { banner: false, badges: 0, chips: 0 });
  expect((await asked(page)).length).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").length)).toBe(0);
  await page.close();
});

test("an answer still in flight when a sign-out arrives is never drawn", async () => {
  // Every answer takes a second, so the first request is still out when the reset comes.
  const { page } = await openAdmin(LIST, answers, 1000);
  await expect.poll(async () => (await asked(page)).length).toBeGreaterThan(0);
  await page.evaluate(() => {
    const w = window as unknown as { canned: unknown; overlay: Overlay };
    w.canned = {};
    w.overlay.pathixReset();
  });
  // The old request answers with badges; the reset dropped it, and the re-ask answers nothing.
  await page.waitForTimeout(2500);
  expect(await drawn(page)).toEqual({ banner: false, badges: 0, chips: 0 });
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").length)).toBe(0);
  await page.close();
});

test("turning off removes everything and nothing comes back", async () => {
  const { page } = await openAdmin(LIST);
  await expectDrawn(page, { banner: false, badges: 4, chips: 0 });
  await page.evaluate(() => (window as unknown as { overlay: Overlay }).overlay.stop());
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").length)).toBe(0);
  await page.evaluate(() => document.getElementById("app")!.append(document.createElement("div")));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelectorAll("pathix-admin-banner, pathix-admin-badge, pathix-admin-chip").length)).toBe(0);
  await page.close();
});

// --- part 2: the real build's registration ----------------------------------------------------------

test.describe("the runtime registration, in the real build", () => {
  test.describe.configure({ mode: "serial" });

  const DIST = resolve("dist");
  let extension: BrowserContext;
  let extensionId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("No build in dist/. Run npm run build first.");
    // A test-only copy that holds the admin host up front: the browser's permission prompt cannot be answered headless.
    // The committed manifest holds it as an optional permission only (test/admin-overlay.test.ts).
    const copy = mkdtempSync(join(tmpdir(), "pathix-admin-smoke-"));
    cpSync(DIST, copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8")) as Record<string, unknown>;
    manifest.host_permissions = [`${ADMIN}/*`];
    writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));

    extension = await chromium.launchPersistentContext("", {
      ...(process.env.PATHIX_SMOKE_CHROMIUM ? { executablePath: process.env.PATHIX_SMOKE_CHROMIUM } : { channel: "chromium" }),
      headless: true,
      args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
    });
    await serveAdmin(extension);
    await extension.route("https://login.microsoftonline.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sign in</title><p>Sign in</p>" }),
    );
    const worker = extension.serviceWorkers()[0] ?? (await extension.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  const worker = () => extension.serviceWorkers()[0]!;
  const registered = () => worker().evaluate(() => chrome.scripting.getRegisteredContentScripts().then((scripts) => scripts.map((s) => ({ id: s.id, matches: s.matches, js: s.js }))));

  /** Is the page script listening in this tab? A tab with no content script cannot receive the message. */
  async function scriptRuns(page: Page): Promise<boolean> {
    const url = page.url();
    return worker().evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      try {
        // The off command only asks a running overlay to remove what it drew; harmless to send.
        await chrome.tabs.sendMessage(tab!.id!, { kind: "adminOverlayOff" });
        return true;
      } catch {
        return false;
      }
    }, url);
  }

  test("registers nothing until the overlay is turned on", async () => {
    expect(await registered()).toEqual([]);
    const page = await extension.newPage();
    await page.goto(`${ADMIN}${LIST}`);
    expect(await scriptRuns(page)).toBe(false);
    await page.close();
  });

  test("turning the overlay on registers the script for the admin host alone, and the script then runs there", async () => {
    const options = await extension.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator("#admin-overlay").check();
    await expect(options.locator("#admin-status")).toContainText("On.", { timeout: 10_000 });

    expect(await registered()).toEqual([
      { id: "pathix-admin-overlay", matches: ["https://admin.powerplatform.microsoft.com/*"], js: ["admin.js"] },
    ]);

    const admin = await extension.newPage();
    await admin.goto(`${ADMIN}${EDITOR}`);
    expect(await scriptRuns(admin)).toBe(true);
    // No Pathix is set up, so the script says nothing: the page is as the admin center left it.
    await admin.waitForTimeout(500);
    expect(await admin.evaluate(() => document.querySelectorAll("pathix-admin-banner").length)).toBe(0);
    await admin.close();

    // A sign-in page is never matched.
    const signIn = await extension.newPage();
    await signIn.goto("https://login.microsoftonline.com/common/oauth2/authorize");
    expect(await scriptRuns(signIn)).toBe(false);
    await signIn.close();
    await options.close();
  });

  test("the registration survives the worker being asked again, and turning the overlay off unregisters it", async () => {
    const options = await extension.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(options.locator("#admin-overlay")).toBeChecked();

    await options.locator("#admin-overlay").uncheck();
    await expect(options.locator("#admin-status")).toContainText("Off", { timeout: 10_000 });
    expect(await registered()).toEqual([]);

    const admin = await extension.newPage();
    await admin.goto(`${ADMIN}${EDITOR}`);
    expect(await scriptRuns(admin)).toBe(false);
    await admin.close();
    await options.close();
  });
});
