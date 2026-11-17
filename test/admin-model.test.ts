// The admin center overlay's models and loaders (M14): what the banner, the
// role-list badge and the application-user chip say, and how many requests it
// takes to say it. The Pathix answers are hand-written stand-ins in the shape
// of the contract slice (test/admin-fixtures.ts).

import { describe, expect, it } from "vitest";
import {
  ASSIGNMENTS_UNKNOWN,
  appUserChips,
  assignedLine,
  bannerKnowsAnything,
  buildAppUserChip,
  buildNotInPathixChip,
  buildRoleBadge,
  buildRoleBanner,
  findingsFor,
  findingsLine,
  findRole,
  FINDINGS_NONE_HERE,
  FINDINGS_UNKNOWN,
  foldIsExact,
  holdersOf,
  isRoleList,
  NO_FINDINGS,
  roleGroup,
  roleOpenCounts,
  type RoleFindings,
  type RoleGroup,
} from "../src/card/admin";
import { APP_IDS_BATCH, loadAppUserChips, loadRoleBadges, loadRoleBanner, ROLE_COUNTS_BATCH } from "../src/background/admin";
import type { OpenFindingCounts, RoleSummary } from "../src/pathix/api";
import {
  appIdOf,
  appUser,
  byAppId,
  COMPLETED,
  context,
  EMPTY,
  ENV,
  fakePathix,
  INTEGRATION,
  LEGACY_ROLES,
  olderRow,
  OMITTED,
  OPEN_COUNTS,
  openCounts,
  PATHIX,
  roleOf,
  roleRow,
  ROLES,
  SALES,
  SALES_EAST_COPY,
  SALES_WEST_COPY,
  SCOPE,
} from "./admin-fixtures";

const rolesPath = `/roles?environmentId=${ENV}`;
const countsPath = (...ids: string[]) => `/findings/open-counts?environmentId=${ENV}&${[...ids].sort().map((id) => `roleId=${id}`).join("&")}`;
const group = (roles: RoleSummary[], ids: { sourceId: string }): RoleGroup => roleGroup(roles, ids.sourceId)!;
const counts = (rows = OPEN_COUNTS, readiness: OpenFindingCounts["readiness"] = COMPLETED) =>
  roleOpenCounts([{ fields: [], roles: Object.entries(rows).map(([roleId, row]) => ({ roleId, ...row })), readiness }]);
const RUNNING: OpenFindingCounts["readiness"] = { findings: { status: "Running", failedDetectorFindingTypes: [] } };

/** A root role held only through a copy: 0 here, 40 in another business unit. */
const ROOT = { id: "a2000000-0000-4000-8000-000000000001", sourceId: "d2000000-0000-4000-8000-000000000001" };
const ROOT_COPY = { id: "a2000000-0000-4000-8000-000000000002", sourceId: "d2000000-0000-4000-8000-000000000002" };

describe("mapping an admin center role id to Pathix's role", () => {
  it("finds the role by its Dataverse id, in any case", () => {
    expect(findRole(ROLES, SALES.sourceId.toUpperCase())?.id).toBe(SALES.id);
  });

  it("finds a business unit copy by its own id", () => {
    expect(findRole(ROLES, SALES_EAST_COPY.sourceId)?.id).toBe(SALES_EAST_COPY.id);
  });

  it("finds nothing for a role Pathix has not scanned: unknown, not an empty role", () => {
    expect(findRole(ROLES, "d9999999-0000-4000-8000-000000000000")).toBeNull();
    expect(roleGroup(ROLES, "d9999999-0000-4000-8000-000000000000")).toBeNull();
  });

  it("accepts only a role list in the contract's shape", () => {
    expect(isRoleList(ROLES)).toBe(true);
    expect(isRoleList(ROLES.map(olderRow))).toBe(true);
    expect(isRoleList([...ROLES, { id: "x", sourceId: "y", name: "z", assignmentCount: "3" }])).toBe(false);
    expect(isRoleList({ rows: ROLES })).toBe(false);
  });
});

describe("folding business unit copies into the root role", () => {
  it("folds every row whose parent root role is the root's Dataverse id", () => {
    const sales = group(ROLES, SALES);
    expect(sales.rows.map((row) => row.id)).toEqual([SALES.id, SALES_EAST_COPY.id, SALES_WEST_COPY.id]);
    expect(sales.fold).toEqual({ kind: "whole", copies: 2 });
    expect(sales.role.id).toBe(SALES.id);
  });

  it("compares the parent with the root's sourceId, never its Pathix id, in any case", () => {
    const byPathixId = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 }, ROOT.id)];
    expect(group(byPathixId, ROOT).rows).toHaveLength(1);
    const upper = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 }, ROOT.sourceId.toUpperCase())];
    expect(group(upper, ROOT).rows).toHaveLength(2);
  });

  it("keeps a business unit copy the admin center opens to its own row, and says it is a copy", () => {
    const east = group(ROLES, SALES_EAST_COPY);
    expect(east.rows.map((row) => row.id)).toEqual([SALES_EAST_COPY.id]);
    expect(east.fold).toEqual({ kind: "copy" });
  });

  it("reads a root that names itself as its parent as a root", () => {
    const self = [roleRow(ROOT, "Salesperson", {}, ROOT.sourceId), roleRow(ROOT_COPY, "Salesperson", { humans: 40 }, ROOT.sourceId)];
    expect(group(self, ROOT).fold).toEqual({ kind: "whole", copies: 1 });
  });

  it("is exact when any row names a parent, so a root with no copy has none", () => {
    expect(foldIsExact(ROLES)).toBe(true);
    expect(group(ROLES, INTEGRATION).fold).toEqual({ kind: "whole", copies: 0 });
  });

  it("does not fold two root roles that only share a name, in a scan that names parents", () => {
    const twins = [...ROLES, roleRow({ id: "a3000000-0000-4000-8000-000000000001", sourceId: "d3000000-0000-4000-8000-000000000001" }, "Integration Writer", { humans: 9 })];
    expect(group(twins, INTEGRATION).rows).toHaveLength(1);
    expect(group(twins, INTEGRATION).fold).toEqual({ kind: "whole", copies: 0 });
  });

  it("is exact with no parents and no shared names: one business unit", () => {
    const single = [roleRow(SALES, "Sales Manager", { humans: 3 }), roleRow(INTEGRATION, "Integration Writer")];
    expect(foldIsExact(single)).toBe(true);
    expect(group(single, SALES).fold).toEqual({ kind: "whole", copies: 0 });
  });

  it("is not exact with no parents and shared names: the scan predates the column, and each row is a minimum", () => {
    expect(foldIsExact(LEGACY_ROLES)).toBe(false);
    expect(group(LEGACY_ROLES, SALES).fold).toEqual({ kind: "partial", sameName: 2 });
    expect(group(LEGACY_ROLES, SALES).rows).toHaveLength(1);
    expect(group(LEGACY_ROLES, SALES_EAST_COPY).fold).toEqual({ kind: "partial", sameName: 2 });
    // A role whose name no other row shares is whole even then.
    expect(group(LEGACY_ROLES, INTEGRATION).fold).toEqual({ kind: "whole", copies: 0 });
  });

  it("reads a Pathix that does not serve the parent at all like a scan that predates it", () => {
    const older = ROLES.map(olderRow);
    expect(foldIsExact(older)).toBe(false);
    expect(group(older, SALES).fold).toEqual({ kind: "partial", sameName: 2 });
  });
});

describe("who holds the role", () => {
  it("sums the split by kind over the root and its copies", () => {
    expect(holdersOf(group(ROLES, SALES).rows)).toEqual({
      total: 10,
      kinds: { humans: 6, integrations: 1, platformManaged: 1, teams: 2, other: 0 },
    });
  });

  it("counts platform-managed users as their own kind, never as humans", () => {
    const west = holdersOf(group(ROLES, SALES_WEST_COPY).rows);
    expect(west.kinds).toMatchObject({ humans: 1, platformManaged: 1 });
    expect(assignedLine(west.kinds!)).toBe("Assigned to 1 human, 0 integrations and 1 platform-managed user");
    const agents = holdersOf([roleRow(ROOT, "Copilot Agents", { platformManaged: 3 })]);
    expect(assignedLine(agents.kinds!)).toBe("Assigned to 0 humans, 0 integrations and 3 platform-managed users");
  });

  it("counts holders the four kinds do not cover as other principals, never drops them", () => {
    const row = { ...roleRow(ROOT, "Odd", { humans: 1 }), assignmentCount: 2 };
    const holders = holdersOf([row]);
    expect(holders.kinds).toEqual({ humans: 1, integrations: 0, platformManaged: 0, teams: 0, other: 1 });
    expect(assignedLine(holders.kinds!)).toBe("Assigned to 1 human, 0 integrations and 1 other principal");
  });

  it("has no split when Pathix serves none, or when the split does not add up", () => {
    expect(holdersOf(group(ROLES.map(olderRow), SALES).rows)).toEqual({ total: 6, kinds: null });
    expect(holdersOf([{ ...roleRow(ROOT, "Odd", { humans: 3 }), assignmentCount: 2 }]).kinds).toBeNull();
    // One row without a split leaves the sum without one.
    expect(holdersOf([roleRow(ROOT, "A", { humans: 1 }), olderRow(roleRow(ROOT_COPY, "A", { humans: 1 }))]).kinds).toBeNull();
  });

  it("reads in the singular and the plural", () => {
    const kinds = (humans: number, integrations: number) => ({ humans, integrations, platformManaged: 0, teams: 0, other: 0 });
    expect(assignedLine(kinds(1, 1))).toBe("Assigned to 1 human and 1 integration");
    expect(assignedLine(kinds(3, 2))).toBe("Assigned to 3 humans and 2 integrations");
  });

  it("leaves a zero part out of an at-least sentence rather than printing a bare 0", () => {
    const kinds = (humans: number, integrations: number, other = 0) => ({ humans, integrations, platformManaged: 0, teams: 0, other });
    expect(assignedLine(kinds(0, 2), "at least ")).toBe("Assigned to at least 2 integrations");
    expect(assignedLine(kinds(3, 0, 1), "at least ")).toBe("Assigned to at least 3 humans and 1 other principal");
    expect(assignedLine(kinds(3, 1), "at least ")).toBe("Assigned to at least 3 humans and 1 integration");
    // Without a floor the zero is the answer of a read that succeeded, and stays.
    expect(assignedLine(kinds(1, 0))).toBe("Assigned to 1 human and 0 integrations");
  });
});

describe("open findings that name a role", () => {
  it("sums the open findings of the root and its copies, with the most severe", () => {
    expect(findingsFor(counts(), group(ROLES, SALES).rows)).toEqual({ count: 3, highest: "Critical", partial: false });
    expect(findingsFor(counts(), group(ROLES, INTEGRATION).rows)).toEqual({ count: 1, highest: "Low", partial: false });
  });

  it("reads a role the answer leaves out as unknown, never zero", () => {
    expect(findingsFor(counts(), group(ROLES, OMITTED).rows)).toBeNull();
  });

  it("makes the sum a minimum when one of the copies is left out", () => {
    const { [SALES_EAST_COPY.id]: _left, ...rest } = OPEN_COUNTS;
    expect(findingsFor(counts(rest), group(ROLES, SALES).rows)).toEqual({ count: 2, highest: "High", partial: true });
    // A zero over the rows that came is not a zero for the role.
    const zeros = { [SALES.id]: { openCount: 0, maxOpenSeverity: null } };
    expect(findingsFor(counts(zeros), group(ROLES, SALES).rows)).toBeNull();
  });

  it("says none only when the findings sweep finished with every detector", () => {
    expect(findingsFor(counts(), group(ROLES, EMPTY).rows)).toEqual({ count: 0, highest: null, partial: false });
    expect(findingsFor(counts(OPEN_COUNTS, RUNNING), group(ROLES, EMPTY).rows)).toBeNull();
    const lost = { findings: { status: "Completed", failedDetectorFindingTypes: ["SharedRole"] } };
    expect(findingsFor(counts(OPEN_COUNTS, lost), group(ROLES, EMPTY).rows)).toBeNull();
  });

  it("still shows a count above zero from an unfinished sweep", () => {
    expect(findingsFor(counts(OPEN_COUNTS, RUNNING), group(ROLES, SALES).rows)?.count).toBe(3);
  });

  it("is unknown when no answer came, or no answer carries roles (a Pathix older than the role counts)", () => {
    expect(roleOpenCounts([])).toBeNull();
    expect(roleOpenCounts([null])).toBeNull();
    expect(roleOpenCounts([{ fields: [], readiness: COMPLETED }])).toBeNull();
    expect(findingsFor(null, group(ROLES, SALES).rows)).toBeNull();
  });

  it("joins the answers of several batches, and a batch that failed leaves its roles out", () => {
    const first = { fields: [], roles: [{ roleId: SALES.id, openCount: 2, maxOpenSeverity: "High" }], readiness: COMPLETED };
    const joined = roleOpenCounts([first, null]);
    expect(findingsFor(joined, group(ROLES, SALES).rows)).toEqual({ count: 2, highest: "High", partial: true });
    // Any batch from an unfinished sweep makes every zero unknown.
    const second = { fields: [], roles: [{ roleId: EMPTY.id, openCount: 0, maxOpenSeverity: null }], readiness: RUNNING };
    expect(findingsFor(roleOpenCounts([first, second]), group(ROLES, EMPTY).rows)).toBeNull();
  });

  it("matches ids in any case, reads counts sent as strings, and skips a row it cannot read", () => {
    const answer = roleOpenCounts([
      {
        fields: [],
        roles: [
          { roleId: SALES.id.toUpperCase(), openCount: "4", maxOpenSeverity: "Medium" },
          { roleId: INTEGRATION.id, openCount: "lots", maxOpenSeverity: "High" },
        ],
        readiness: COMPLETED,
      },
    ]);
    expect(findingsFor(answer, [roleOf(SALES)])).toEqual({ count: 4, highest: "Medium", partial: false });
    expect(findingsFor(answer, [roleOf(INTEGRATION)])).toBeNull();
  });

  it("puts a severity it does not know last, and shows it as written when it is all there is", () => {
    const spicy = counts({ [SALES.id]: { openCount: 1, maxOpenSeverity: "Spicy" }, [SALES_EAST_COPY.id]: { openCount: 1, maxOpenSeverity: "Low" }, [SALES_WEST_COPY.id]: { openCount: 0, maxOpenSeverity: null } });
    expect(findingsFor(spicy, group(ROLES, SALES).rows)?.highest).toBe("Low");
    expect(findingsFor(spicy, [roleOf(SALES)])?.highest).toBe("Spicy");
  });

  it("says open findings, in the singular and the plural, and hedges a minimum", () => {
    expect(findingsLine({ count: 2, highest: "High", partial: false })).toBe("2 open findings name this role (highest: High)");
    expect(findingsLine({ count: 1, highest: "Low", partial: false })).toBe("1 open finding names this role (highest: Low)");
    expect(findingsLine({ count: 2, highest: "High", partial: true }, true)).toBe("At least 2 open findings name this role (highest seen: High)");
    expect(findingsLine({ count: 0, highest: null, partial: false })).toBe(NO_FINDINGS);
    expect(findingsLine(null)).toBe(FINDINGS_UNKNOWN);
  });

  it("says in the zero line that system noise and suppressed types are hidden, as on Pathix's findings page", () => {
    expect(NO_FINDINGS).toBe("No open findings name this role (system noise and suppressed types hidden, as in Pathix)");
  });
});

describe("the role editor banner", () => {
  it("with the copies known: says who holds the role across its business units, its open findings, the scan and where to open it", () => {
    const sales = group(ROLES, SALES);
    const banner = buildRoleBanner(context, sales, findingsFor(counts(), sales.rows));
    expect(banner.assigned).toBe("Assigned to 6 humans, 1 integration and 1 platform-managed user");
    expect(banner.teams).toBe("2 teams also hold this role. Their members are not counted.");
    expect(banner.copies).toBe("The numbers include 2 business unit copies of this role.");
    expect(banner.findings).toBe("3 open findings name this role (highest: Critical)");
    expect(banner.findingsCount).toBe(3);
    expect(banner.findingsFloor).toBe(false);
    expect(banner.scan).toBe("From Pathix's latest scan, on 2026-10-06");
    expect(banner.href).toBe(`${PATHIX}/roles/${SALES.id}?env=${ENV}`);
  });

  it("leaves out the team and copy lines when there is nothing to say", () => {
    const solo = group(ROLES, INTEGRATION);
    const banner = buildRoleBanner(context, solo, { count: 0, highest: null, partial: false });
    expect(banner.teams).toBeNull();
    expect(banner.copies).toBeNull();
    expect(banner.assigned).toBe("Assigned to 0 humans and 1 integration");
    expect(banner.findings).toBe(NO_FINDINGS);
    expect(banner.findingsFloor).toBe(false);
  });

  it("reads a root role held only through a copy from the copy's holders: exact, with no hedge", () => {
    const roles = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 }, ROOT.sourceId)];
    const root = group(roles, ROOT);
    const banner = buildRoleBanner(context, root, { count: 0, highest: null, partial: false });
    expect(banner.assigned).toBe("Assigned to 40 humans and 0 integrations");
    expect(banner.copies).toBe("The numbers include 1 business unit copy of this role.");
    expect(banner.findings).toBe(NO_FINDINGS);
    expect(banner.findingsCount).toBe(0);
    expect(Object.values(banner).join(" ")).not.toMatch(/at least/i);
  });

  it("on a business unit copy, counts the copy alone and says so", () => {
    const east = group(ROLES, SALES_EAST_COPY);
    const banner = buildRoleBanner(context, east, findingsFor(counts(), east.rows));
    expect(banner.assigned).toBe("Assigned to 2 humans and 0 integrations");
    expect(banner.copies).toBe("This is a business unit copy of a role. The numbers are for this copy only.");
    expect(banner.findings).toBe("1 open finding names this role (highest: Critical)");
    expect(banner.findingsFloor).toBe(false);
  });

  it("marks the findings as a minimum when a copy was left out of the open counts", () => {
    const { [SALES_EAST_COPY.id]: _left, ...rest } = OPEN_COUNTS;
    const sales = group(ROLES, SALES);
    const banner = buildRoleBanner(context, sales, findingsFor(counts(rest), sales.rows));
    expect(banner.findings).toBe("At least 2 open findings name this role (highest seen: High)");
    expect(banner.findingsFloor).toBe(true);
    // The holders come from the role list and stay exact.
    expect(banner.assigned).toBe("Assigned to 6 humans, 1 integration and 1 platform-managed user");
  });

  describe("when the scan does not say which rows are copies", () => {
    it("marks the headline and the findings as a minimum", () => {
      const sales = group(LEGACY_ROLES, SALES);
      const banner = buildRoleBanner(context, sales, findingsFor(counts(), sales.rows));
      expect(banner.assigned).toBe("Assigned to at least 3 humans and 1 integration");
      expect(banner.copies).toBe(
        "Pathix lists 2 other roles with this name, such as business unit copies. Their holders and findings are not counted here.",
      );
      expect(banner.findings).toBe("At least 2 open findings name this role (highest seen: High)");
      expect(banner.findingsCount).toBe(2);
      expect(banner.findingsFloor).toBe(true);
    });

    it("never opens on a bare zero: a root at 0 with a copy at 40", () => {
      const roles = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 })];
      const banner = buildRoleBanner(context, group(roles, ROOT), { count: 0, highest: null, partial: false });
      expect(banner.assigned).toBe(ASSIGNMENTS_UNKNOWN);
      expect(banner.assigned).not.toMatch(/\d/);
      expect(banner.copies).toContain("Their holders and findings are not counted here");
      expect(banner.findings).toBe(FINDINGS_NONE_HERE);
      expect(banner.findingsCount).toBeNull();
      expect(banner.findingsFloor).toBe(false);
      // Holders here are a floor, and an integration count of zero sits inside it.
      const held = buildRoleBanner(context, group([roleRow(ROOT, "Salesperson", { humans: 1 }), roles[1]!], ROOT), { count: 1, highest: "Low", partial: false });
      expect(held.assigned).toBe("Assigned to at least 1 human");
      expect(held.findings).toBe("At least 1 open finding names this role (highest seen: Low)");
      // The same role with no same-name row reads as an exact answer.
      const alone = buildRoleBanner(context, group([roles[0]!], ROOT), { count: 0, highest: null, partial: false });
      expect(alone.assigned).toBe("Assigned to 0 humans and 0 integrations");
      expect(alone.findings).toBe(NO_FINDINGS);
      expect(alone.findingsCount).toBe(0);
    });

    it("knows nothing about a role whose only content is the copies note", () => {
      const copy = roleRow(ROOT_COPY, "Salesperson", { humans: 40 });
      const banner = (root: RoleSummary, findings: RoleFindings = { count: 0, highest: null, partial: false }) =>
        buildRoleBanner(context, group([root, copy], ROOT), findings);
      const empty = banner(roleRow(ROOT, "Salesperson"));
      expect(empty.copies).not.toBeNull();
      expect(bannerKnowsAnything(empty)).toBe(false);
      // A team that holds the role, a holder here, or a findings count above zero is something to say.
      expect(bannerKnowsAnything(banner(roleRow(ROOT, "Salesperson", { teams: 1 })))).toBe(true);
      expect(bannerKnowsAnything(banner(roleRow(ROOT, "Salesperson", { humans: 1 })))).toBe(true);
      expect(bannerKnowsAnything(banner(roleRow(ROOT, "Salesperson"), { count: 1, highest: "Low", partial: false }))).toBe(true);
      // A platform-managed holder is a holder.
      expect(bannerKnowsAnything(banner(roleRow(ROOT, "Salesperson", { platformManaged: 1 })))).toBe(true);
    });
  });

  it("says unknown for a part that did not load, never 0 humans", () => {
    const older = group(ROLES.map(olderRow).filter((role) => role.name !== "Sales Manager" || role.id === SALES.id), SALES);
    const banner = buildRoleBanner(context, older, { count: 1, highest: "Low", partial: false });
    expect(banner.assigned).toBe(ASSIGNMENTS_UNKNOWN);
    expect(banner.assigned).not.toMatch(/\d/);
    expect(banner.teams).toBeNull();
    const noFindings = buildRoleBanner(context, group(ROLES, SALES), null);
    expect(noFindings.findings).toBe(FINDINGS_UNKNOWN);
    expect(noFindings.findingsCount).toBeNull();
    expect(noFindings.findingsFloor).toBe(false);
  });

  it("uses no em dash and no registered mark", () => {
    for (const roles of [ROLES, LEGACY_ROLES]) {
      for (const ids of [SALES, SALES_EAST_COPY, INTEGRATION, EMPTY, OMITTED]) {
        const text = Object.values(buildRoleBanner(context, group(roles, ids), findingsFor(counts(), group(roles, ids).rows))).join(" ");
        expect(text).not.toContain("—");
        expect(text).not.toContain("®");
      }
    }
  });
});

describe("the role-list badge", () => {
  it("with the copies known: shows the role's whole assignments and open findings, with a sentence for the tooltip", () => {
    const sales = group(ROLES, SALES);
    const badge = buildRoleBadge(context, sales, findingsFor(counts(), sales.rows));
    expect(badge.assigned).toBe("10 assigned");
    expect(badge.findingsCount).toBe(3);
    expect(badge.findingsFloor).toBe(false);
    expect(badge.title).toBe(
      "Pathix: 10 principals hold this role directly: 6 humans, 1 integration, 1 platform-managed user and 2 teams. The numbers include 2 business unit copies of this role. 3 open findings name this role (highest: Critical). From Pathix's latest scan, on 2026-10-06.",
    );
    expect(badge.href).toBe(`${PATHIX}/roles/${SALES.id}?env=${ENV}`);
  });

  it("reads 1 principal holds, a zero as an exact zero, and an omitted role's findings as unknown", () => {
    const one = buildRoleBadge(context, group(ROLES, INTEGRATION), findingsFor(counts(), [roleOf(INTEGRATION)]));
    expect(one.title).toContain("1 principal holds this role directly: 1 integration.");
    const empty = buildRoleBadge(context, group(ROLES, EMPTY), findingsFor(counts(), [roleOf(EMPTY)]));
    expect(empty.assigned).toBe("0 assigned");
    expect(empty.findingsCount).toBe(0);
    expect(empty.title).toContain("0 principals hold this role directly.");
    expect(empty.title).toContain(NO_FINDINGS);
    const omitted = buildRoleBadge(context, group(ROLES, OMITTED), findingsFor(counts(), [roleOf(OMITTED)]));
    expect(omitted.assigned).toBe("4 assigned");
    expect(omitted.findingsCount).toBeNull();
    expect(omitted.title).toContain(FINDINGS_UNKNOWN);
  });

  it("names the kinds plainly when Pathix serves no split", () => {
    const older = ROLES.map(olderRow).filter((role) => role.id === INTEGRATION.id);
    expect(buildRoleBadge(context, group(older, INTEGRATION), null).title).toContain("1 principal holds this role directly (users, integrations and teams).");
  });

  describe("when the scan does not say which rows are copies", () => {
    it("marks the counts as a minimum", () => {
      const sales = group(LEGACY_ROLES, SALES);
      const badge = buildRoleBadge(context, sales, findingsFor(counts(), sales.rows));
      expect(badge.assigned).toBe("6+ assigned");
      expect(badge.findingsCount).toBe(2);
      expect(badge.findingsFloor).toBe(true);
      expect(badge.title).toBe(
        "Pathix: 6 principals hold this role directly: 3 humans, 1 integration and 2 teams. Pathix lists 2 other roles with this name, such as business unit copies. Their holders and findings are not counted here. At least 2 open findings name this role (highest seen: High). From Pathix's latest scan, on 2026-10-06.",
      );
    });

    it("never reads a bare 0: a root role at 0 with a copy at 40", () => {
      const roles = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 })];
      const badge = buildRoleBadge(context, group(roles, ROOT), { count: 0, highest: null, partial: false });
      expect(badge.assigned).toBe("? assigned");
      expect(badge.assigned).not.toMatch(/\d/);
      expect(badge.title).toContain("Who holds this role: unknown");
      expect(badge.title).not.toMatch(/0 principals/);
      expect(badge.title).toContain("Their holders and findings are not counted here");
      expect(badge.findingsCount).toBeNull();
      expect(badge.findingsFloor).toBe(false);
      expect(badge.title).toContain(FINDINGS_NONE_HERE);
      expect(badge.title).not.toContain(NO_FINDINGS);
      const some = buildRoleBadge(context, group(roles, ROOT), { count: 3, highest: "Low", partial: false });
      expect(some.findingsCount).toBe(3);
      expect(some.findingsFloor).toBe(true);
      expect(some.title).toContain("At least 3 open findings name this role (highest seen: Low)");
    });
  });
});

describe("the application-user chip", () => {
  it("names the roles the user holds directly, and opens the principal", () => {
    const user = appUser(3);
    const chip = buildAppUserChip(context, user);
    expect(chip.text).toBe("Pathix: 3 roles");
    expect(chip.href).toBe(`${PATHIX}/principals/${user.id}?env=${ENV}`);
    expect(chip.title).toContain("holds 3 roles directly");
  });

  it("says when the user is disabled, and reads one role in the singular", () => {
    expect(buildAppUserChip(context, appUser(1, { isEnabled: false })).text).toBe("Pathix: 1 role, disabled");
  });

  it("says a user is not in the scan only as a statement about the scan, with nothing to open", () => {
    const chip = buildNotInPathixChip(context);
    expect(chip.text).toBe("Not in Pathix's latest scan");
    expect(chip.href).toBeNull();
  });

  const missing = "c3000000-0000-4000-8000-0000000fffff";
  const answer = (users = [appUser(1), appUser(2)], scope = SCOPE) => byAppId(users, scope)(`/principals/by-app-id?appId=${appIdOf(1)}&appId=${missing}`);

  it("matches each Application ID in any case, and calls one a miss only when a scanned answer says it was asked", () => {
    const result = answer();
    if (!result.ok) throw new Error("fake failed");
    const chips = appUserChips(context, [appIdOf(1).toUpperCase(), missing], result.data);
    expect(chips[appIdOf(1)]!.text).toBe("Pathix: 1 role");
    expect(chips[missing]!.text).toBe("Not in Pathix's latest scan");
    // An id the answer does not say was asked is not a miss.
    expect(appUserChips(context, [missing], { ...result.data, requestedAppIds: [] })).toEqual({});
    expect(appUserChips(context, [missing], { ...result.data, requestedAppIds: undefined as unknown as string[] })).toEqual({});
  });

  it("draws nothing when no scan is behind the answer: nothing was looked up, so nothing is missing", () => {
    const result = answer([appUser(1)], null as unknown as typeof SCOPE);
    if (!result.ok) throw new Error("fake failed");
    expect(result.data.scope).toBeNull();
    expect(appUserChips(context, [appIdOf(1), missing], result.data)).toEqual({});
  });

  it("draws nothing for no answer, an answer not in the contract's shape, or an Application ID two principals share", () => {
    expect(appUserChips(context, [appIdOf(1)], null)).toEqual({});
    expect(appUserChips(context, [appIdOf(1)], { requestedAppIds: [appIdOf(1)], scope: SCOPE, principals: "nope" } as never)).toEqual({});
    const twin = appUser(2, { appId: appIdOf(1).toUpperCase() });
    expect(appUserChips(context, [appIdOf(1)], { requestedAppIds: [appIdOf(1)], scope: SCOPE, principals: [appUser(1), twin] })).toEqual({});
  });
});

describe("loading the role editor banner", () => {
  const answers = () => ({ "/roles?": ROLES, "/findings/open-counts?": openCounts() });

  it("takes two requests: the role list, and the open counts of the role and its copies", async () => {
    const pathix = fakePathix(answers());
    const response = await loadRoleBanner(context, SALES.sourceId, pathix.get);
    expect(pathix.paths).toEqual([rolesPath, countsPath(SALES.id, SALES_EAST_COPY.id, SALES_WEST_COPY.id)]);
    expect(response.kind === "role" && response.banner.assigned).toBe("Assigned to 6 humans, 1 integration and 1 platform-managed user");
    expect(response.kind === "role" && response.banner.findings).toBe("3 open findings name this role (highest: Critical)");
  });

  it("maps a business unit copy's own id to the copy alone", async () => {
    const pathix = fakePathix(answers());
    const response = await loadRoleBanner(context, SALES_EAST_COPY.sourceId, pathix.get);
    expect(pathix.paths).toEqual([rolesPath, countsPath(SALES_EAST_COPY.id)]);
    expect(response.kind === "role" && response.banner.copies).toContain("business unit copy");
  });

  it("asks for the open counts 100 roles at a time", async () => {
    const copies = Array.from({ length: 120 }, (_, n) =>
      roleRow({ id: `a4000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, sourceId: `d4000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}` }, "Salesperson", { humans: 1 }, ROOT.sourceId),
    );
    const pathix = fakePathix({ "/roles?": [roleRow(ROOT, "Salesperson"), ...copies], "/findings/open-counts?": openCounts({}) });
    const response = await loadRoleBanner(context, ROOT.sourceId, pathix.get);
    expect(pathix.paths).toHaveLength(3);
    expect(pathix.paths.slice(1).map((path) => new URL(path, "https://x").searchParams.getAll("roleId").length)).toEqual([ROLE_COUNTS_BATCH, 21]);
    expect(response.kind === "role" && response.banner.assigned).toBe("Assigned to 120 humans and 0 integrations");
  });

  it("is silent for a role Pathix does not have", async () => {
    const pathix = fakePathix(answers());
    expect(await loadRoleBanner(context, "d9999999-0000-4000-8000-000000000000", pathix.get)).toEqual({ kind: "none" });
    expect(pathix.paths).toEqual([rolesPath]);
  });

  it("is silent when the role list fails or is not the contract's shape, with no further request", async () => {
    const failed = fakePathix({});
    expect(await loadRoleBanner(context, SALES.sourceId, failed.get)).toEqual({ kind: "none" });
    expect(failed.paths).toEqual([rolesPath]);
    const odd = fakePathix({ "/roles?": [{ id: SALES.id }] });
    expect(await loadRoleBanner(context, SALES.sourceId, odd.get)).toEqual({ kind: "none" });
    expect(odd.paths).toEqual([rolesPath]);
  });

  it("says unknown for the findings when the open counts failed, and draws the holders", async () => {
    const response = await loadRoleBanner(context, SALES.sourceId, fakePathix({ "/roles?": ROLES }).get);
    expect(response.kind === "role" && response.banner.assigned).toBe("Assigned to 6 humans, 1 integration and 1 platform-managed user");
    expect(response.kind === "role" && response.banner.findings).toBe(FINDINGS_UNKNOWN);
  });

  it("reads a role the open counts leave out as unknown", async () => {
    const response = await loadRoleBanner(context, OMITTED.sourceId, fakePathix(answers()).get);
    expect(response.kind === "role" && response.banner.findings).toBe(FINDINGS_UNKNOWN);
    expect(response.kind === "role" && response.banner.findingsCount).toBeNull();
  });

  it("is silent for a role with copies the scan does not identify, no holders here and no findings here", async () => {
    const roles = [roleRow(ROOT, "Salesperson"), roleRow(ROOT_COPY, "Salesperson", { humans: 40 })];
    const counts0 = { [ROOT.id]: { openCount: 0, maxOpenSeverity: null } };
    expect(await loadRoleBanner(context, ROOT.sourceId, fakePathix({ "/roles?": roles, "/findings/open-counts?": openCounts(counts0) }).get)).toEqual({ kind: "none" });
  });

  it("is silent against a Pathix with neither the split nor the role counts, rather than two unknown lines", async () => {
    const older = fakePathix({ "/roles?": ROLES.map(olderRow), "/findings/open-counts?": { fields: [], readiness: COMPLETED } });
    expect(await loadRoleBanner(context, INTEGRATION.sourceId, older.get)).toEqual({ kind: "none" });
  });
});

describe("loading role-list badges", () => {
  const manyRoles = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      roleRow({ id: `a9000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, sourceId: `d9000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}` }, `Role ${i}`, { humans: i }),
    );

  it("takes two requests for a page of up to 100 roles, and none per row", async () => {
    const roles = manyRoles(50);
    const pathix = fakePathix({ "/roles?": roles, "/findings/open-counts?": openCounts({}) });
    const response = await loadRoleBadges(context, roles.map((role) => role.sourceId), pathix.get);
    expect(pathix.paths).toEqual([rolesPath, countsPath(...roles.map((role) => role.id))]);
    expect(response.kind === "roles" && Object.keys(response.badges)).toHaveLength(50);
  });

  it("asks for the open counts of a longer page 100 roles at a time", async () => {
    const roles = manyRoles(150);
    const pathix = fakePathix({ "/roles?": roles, "/findings/open-counts?": openCounts({}) });
    await loadRoleBadges(context, roles.map((role) => role.sourceId), pathix.get);
    expect(pathix.paths).toHaveLength(1 + Math.ceil(150 / ROLE_COUNTS_BATCH));
  });

  it("folds each listed role's copies into one read of the open counts", async () => {
    const pathix = fakePathix({ "/roles?": ROLES, "/findings/open-counts?": openCounts() });
    const response = await loadRoleBadges(context, [SALES.sourceId, INTEGRATION.sourceId], pathix.get);
    expect(pathix.paths).toEqual([rolesPath, countsPath(SALES.id, SALES_EAST_COPY.id, SALES_WEST_COPY.id, INTEGRATION.id)]);
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.assigned).toBe("10 assigned");
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.findingsCount).toBe(3);
  });

  it("keys badges by the role id the page asked about, leaves out roles Pathix does not have, and badges the rest", async () => {
    const pathix = fakePathix({ "/roles?": ROLES, "/findings/open-counts?": openCounts() });
    const unknown = "d9999999-0000-4000-8000-000000000000";
    const response = await loadRoleBadges(context, [SALES.sourceId.toUpperCase(), EMPTY.sourceId, OMITTED.sourceId, unknown], pathix.get);
    expect(response.kind).toBe("roles");
    if (response.kind !== "roles") return;
    expect(Object.keys(response.badges).sort()).toEqual([EMPTY.sourceId, OMITTED.sourceId, SALES.sourceId].sort());
    expect(response.badges[EMPTY.sourceId]!.assigned).toBe("0 assigned");
    expect(response.badges[EMPTY.sourceId]!.findingsCount).toBe(0);
    // A role the open counts leave out has numbers of its own, and an unknown findings count.
    expect(response.badges[OMITTED.sourceId]!.assigned).toBe("4 assigned");
    expect(response.badges[OMITTED.sourceId]!.findingsCount).toBeNull();
  });

  it("keeps today's hedges on a scan that predates the parent column", async () => {
    const response = await loadRoleBadges(context, [SALES.sourceId], fakePathix({ "/roles?": LEGACY_ROLES, "/findings/open-counts?": openCounts() }).get);
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.assigned).toBe("6+ assigned");
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.findingsFloor).toBe(true);
  });

  it("shows ? for findings when the open counts failed, and still shows the assignments", async () => {
    const response = await loadRoleBadges(context, [SALES.sourceId], fakePathix({ "/roles?": ROLES }).get);
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.findingsCount).toBeNull();
    expect(response.kind === "roles" && response.badges[SALES.sourceId]!.assigned).toBe("10 assigned");
  });

  it("is silent when the role list fails or none of the rows is a scanned role, and then asks nothing more", async () => {
    expect(await loadRoleBadges(context, [SALES.sourceId], fakePathix({}).get)).toEqual({ kind: "none" });
    const pathix = fakePathix({ "/roles?": ROLES, "/findings/open-counts?": openCounts() });
    expect(await loadRoleBadges(context, ["d9999999-0000-4000-8000-000000000000"], pathix.get)).toEqual({ kind: "none" });
    expect(pathix.paths).toEqual([rolesPath]);
  });
});

describe("loading application-user chips", () => {
  const users = Array.from({ length: 450 }, (_, n) => appUser(n + 1));
  const missing = "c3000000-0000-4000-8000-0000000fffff";

  it("looks up a page of Application IDs in one request", async () => {
    const pathix = fakePathix({ "/principals/by-app-id?": byAppId(users) });
    const response = await loadAppUserChips(context, [appIdOf(1), appIdOf(450), missing], pathix.get);
    expect(pathix.paths).toEqual([`/principals/by-app-id?environmentId=${ENV}&appId=${appIdOf(1)}&appId=${appIdOf(450)}&appId=${missing}`]);
    expect(response.kind === "appUsers" && response.chips[appIdOf(450)]!.text).toBe(`Pathix: ${450 % 4} roles`);
    expect(response.kind === "appUsers" && response.chips[missing]!.text).toBe("Not in Pathix's latest scan");
  });

  it("asks 100 Application IDs at a time, and a batch that fails costs only its own chips", async () => {
    const ids = users.slice(0, 150).map((user) => user.appId!);
    const pathix = fakePathix({
      "/principals/by-app-id?": (path: string) => (path.includes(appIdOf(1)) ? byAppId(users)(path) : { ok: false, kind: "failed", message: "boom" }),
    });
    const response = await loadAppUserChips(context, ids, pathix.get);
    expect(pathix.paths).toHaveLength(Math.ceil(150 / APP_IDS_BATCH));
    expect(pathix.paths.map((path) => new URL(path, "https://x").searchParams.getAll("appId").length)).toEqual([100, 50]);
    expect(response.kind === "appUsers" && Object.keys(response.chips)).toHaveLength(100);
  });

  it("asks each Application ID once, in lower case", async () => {
    const pathix = fakePathix({ "/principals/by-app-id?": byAppId(users) });
    await loadAppUserChips(context, [appIdOf(1).toUpperCase(), appIdOf(1)], pathix.get);
    expect(new URL(pathix.paths[0]!, "https://x").searchParams.getAll("appId")).toEqual([appIdOf(1)]);
  });

  it("is silent when the environment has no scan behind the answer, never calling an id missing", async () => {
    const response = await loadAppUserChips(context, [appIdOf(1), missing], fakePathix({ "/principals/by-app-id?": byAppId(users, null) }).get);
    expect(response).toEqual({ kind: "none" });
  });

  it("gives no chip for an Application ID two principals share", async () => {
    const twin = appUser(2, { appId: appIdOf(1) });
    const response = await loadAppUserChips(context, [appIdOf(1)], fakePathix({ "/principals/by-app-id?": byAppId([appUser(1), twin]) }).get);
    expect(response).toEqual({ kind: "none" });
  });

  it("is silent when the lookup fails", async () => {
    expect(await loadAppUserChips(context, [appIdOf(1)], fakePathix({}).get)).toEqual({ kind: "none" });
  });
});
