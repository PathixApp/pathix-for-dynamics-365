import { describe, expect, it } from "vitest";
import { appIdFromCellText, parseAdminRoute, roleIdFromHref, routeKey } from "../src/admin/routes";

const ORG = "5c4a0000-0000-4000-8000-000000000003";
const ROLE = "d1000000-0000-4000-8000-000000000001";
const BAP = "e2000000-0000-4000-8000-000000000009";

describe("the three routes the overlay draws on", () => {
  it("parses the role list", () => {
    expect(parseAdminRoute(`/manage/environments/${ORG}/securityroles`)).toEqual({ kind: "roleList", organizationId: ORG });
  });

  it("parses the role editor, with the role id", () => {
    expect(parseAdminRoute(`/manage/environments/${ORG}/securityroles/${ROLE}/roleeditor`)).toEqual({
      kind: "roleEditor",
      organizationId: ORG,
      roleId: ROLE,
    });
  });

  it("parses application users", () => {
    expect(parseAdminRoute(`/manage/environments/${ORG}/appusers`)).toEqual({ kind: "appUsers", organizationId: ORG });
  });

  it("accepts a trailing slash and any case, and returns lowercase ids", () => {
    expect(parseAdminRoute(`/manage/environments/${ORG.toUpperCase()}/securityroles/${ROLE.toUpperCase()}/roleeditor/`)).toEqual({
      kind: "roleEditor",
      organizationId: ORG,
      roleId: ROLE,
    });
    expect(parseAdminRoute(`/Manage/Environments/${ORG}/AppUsers/`)).toEqual({ kind: "appUsers", organizationId: ORG });
  });
});

describe("every other page is not ours", () => {
  it.each([
    ["the users page, which is out of scope", `/manage/environments/${ORG}/${BAP}/users`],
    ["teams", `/manage/environments/${ORG}/teams`],
    ["the environment hub", `/manage/environments/environment/${BAP}/hub`],
    ["the environment list", "/manage/environments"],
    ["the home page", "/"],
    ["an empty path", ""],
    ["a role id where the organization id goes", `/manage/environments/${ROLE}/securityroles/x/roleeditor`],
    ["a role editor with no role id", `/manage/environments/${ORG}/securityroles//roleeditor`],
    ["a role id that is not a GUID", `/manage/environments/${ORG}/securityroles/not-a-guid/roleeditor`],
    ["a longer path under the editor", `/manage/environments/${ORG}/securityroles/${ROLE}/roleeditor/privileges`],
    ["a longer path under the list", `/manage/environments/${ORG}/securityroles/${ROLE}`],
    ["a path with a prefix", `/x/manage/environments/${ORG}/securityroles`],
    ["an organization id with a suffix", `/manage/environments/${ORG}0/securityroles`],
    ["a path that only contains a route", `/redirect?to=/manage/environments/${ORG}/securityroles`],
  ])("%s", (_name, path) => {
    expect(parseAdminRoute(path)).toBeNull();
  });
});

describe("routeKey", () => {
  it("is empty for a page that is not ours and differs per page", () => {
    expect(routeKey(null)).toBe("");
    const list = routeKey(parseAdminRoute(`/manage/environments/${ORG}/securityroles`));
    const editor = routeKey(parseAdminRoute(`/manage/environments/${ORG}/securityroles/${ROLE}/roleeditor`));
    const other = routeKey(parseAdminRoute(`/manage/environments/${ORG}/securityroles/${ROLE.replace("1", "2")}/roleeditor`));
    expect(new Set([list, editor, other]).size).toBe(3);
  });
});

describe("roleIdFromHref: the id a role-list row links to", () => {
  // The real admin center's role list (captured 2026-10-09) links each role
  // without the /manage prefix that its own page path carries.
  it("reads the real admin center's link, which has no /manage prefix", () => {
    expect(roleIdFromHref(`/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBe(ROLE);
    expect(roleIdFromHref(`https://admin.powerplatform.microsoft.com/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBe(ROLE);
  });

  it("reads a relative link to the role editor with the /manage prefix too", () => {
    expect(roleIdFromHref(`/manage/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBe(ROLE);
  });

  it("keeps page paths strict: the page itself still needs /manage", () => {
    expect(parseAdminRoute(`/environments/${ORG}/securityroles/${ROLE}/roleeditor`)).toBeNull();
    expect(parseAdminRoute(`/environments/${ORG}/securityroles`)).toBeNull();
  });

  it("reads an absolute link on the admin host, ignoring the query and hash", () => {
    expect(
      roleIdFromHref(`https://admin.powerplatform.microsoft.com/manage/environments/${ORG}/securityroles/${ROLE.toUpperCase()}/roleeditor?x=1#y`, ORG),
    ).toBe(ROLE);
  });

  it("refuses a link to another organization, another host, another page or garbage", () => {
    const other = "6d5b0000-0000-4000-8000-000000000004";
    expect(roleIdFromHref(`/manage/environments/${other}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`/environments/${other}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`https://evil.example/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`/other/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`/managex/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`/environments/${ORG}/securityroles/${ROLE}/roleeditor/privileges`, ORG)).toBeNull();
    expect(roleIdFromHref(`https://evil.example/manage/environments/${ORG}/securityroles/${ROLE}/roleeditor`, ORG)).toBeNull();
    expect(roleIdFromHref(`/manage/environments/${ORG}/appusers`, ORG)).toBeNull();
    expect(roleIdFromHref("", ORG)).toBeNull();
    expect(roleIdFromHref("http://[", ORG)).toBeNull();
  });
});

describe("appIdFromCellText: an Application ID, and only that", () => {
  it("accepts a GUID, trimmed, in any case, and returns it lowercase", () => {
    expect(appIdFromCellText("  C3000000-0000-4000-8000-000000000001\n")).toBe("c3000000-0000-4000-8000-000000000001");
  });

  it.each([
    "Contoso Integration",
    "someone@contoso.com",
    "",
    "c3000000-0000-4000-8000-000000000001 (Contoso)",
    "App c3000000-0000-4000-8000-000000000001",
    "c3000000-0000-4000-8000-00000000000",
    "c3000000-0000-4000-8000-0000000000012",
    "{c3000000-0000-4000-8000-000000000001}",
    "c3000000-0000-4000-8000-000000000001 c3000000-0000-4000-8000-000000000002",
  ])("drops %j", (text) => {
    expect(appIdFromCellText(text)).toBeNull();
  });
});
