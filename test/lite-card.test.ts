import { describe, expect, it } from "vitest";
import {
  buildDependenciesCard,
  contrastLine,
  DEPENDENCIES_TIP,
  dependenciesHeadline,
  groupDependents,
  LIVE_FROM_DATAVERSE,
  PATHIX_SITE,
  type DependencyGroup,
  type LiteCardModel,
} from "../src/card/lite";
import { PLATFORM_COUNT_EXPLAINED, writerCountOf, type FieldCardModel } from "../src/card/model";
import { createDataverseClient } from "../src/dataverse/client";
import type { DependentComponent } from "../src/dataverse/queries";
import { loadDependenciesCard, loadDependents, MAX_SINGLE_LOOKUPS } from "../src/lite/dependencies";
import {
  cardSettingsFrom,
  isCardSettings,
  isCardSettingsRequest,
  isHideTipsRequest,
  modeFor,
} from "../src/runtime/card-settings";
import { fakeDataverse, fixture, ORIGIN } from "./fake-dataverse";

function setup() {
  const server = fakeDataverse();
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

async function liteCard(column: string, showTips = true, server = setup()): Promise<LiteCardModel> {
  return loadDependenciesCard(server.get, { table: "account", column, showTips });
}

function summary(groups: DependencyGroup[]): string[] {
  return groups.map((group) => `${group.kind} ${group.label}`);
}

const NULL_GUID = "00000000-0000-0000-0000-000000000000";
function dependent(type: number, id: number): DependentComponent {
  return {
    dependentcomponenttype: type,
    dependentcomponentobjectid: `5c4a0000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    dependentcomponentparentid: NULL_GUID,
    dependencytype: 2,
  };
}

describe("the platform dependencies card, from the fixtures", () => {
  it("counts account.creditlimit's tracked dependencies and lists them by type and name", async () => {
    const card = await liteCard("creditlimit");
    expect(card.headline).toBe("Dataverse tracks 12 components that depend on this column.");
    expect(card.status).toBe(LIVE_FROM_DATAVERSE);
    expect(summary(card.groups)).toEqual([
      "PLG 4 plugin steps",
      "IMG 2 plugin step images",
      "WF 1 classic workflow",
      "DLG 1 dialog",
      "ACT 1 action",
      "FRM 3 forms",
    ]);
    // Real names, from plugin-steps-account.json and workflows-account.json.
    expect(card.groups[0]!.names).toEqual([
      "sim_NoOp_04_Update_account",
      "sim_NoOp_05_Update_account",
      "sim_NoOp_15_Update_account",
      "sim_NoOp_16_Update_account",
    ]);
    expect(card.groups[2]!.names).toEqual(["Account - On Update - Random"]);
    // Neither step image has a name in the real capture (it is ""), so both fall
    // back to their alias. The parent-step fallback is covered with inline rows below.
    expect(card.groups[1]!.names).toEqual(["PostBusinessEntity", "PreBusinessEntity"]);
    expect(card.groups.map((group) => `${group.kind} ${group.unnamedCount}`)).toEqual(["PLG 0", "IMG 0", "WF 0", "DLG 0", "ACT 0", "FRM 0"]);
  });

  it("names a step image by its name, then its alias, then its parent step, and counts it unnamed past that", async () => {
    const server = setup();
    const image = (id: number, name: string | null, entityalias: string | null, parent: string | null) => ({
      sdkmessageprocessingstepimageid: `5c4a0000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      name,
      entityalias,
      _sdkmessageprocessingstepid_value: parent,
    });
    server.server.answerWhen("RetrieveDependentComponents", { value: [dependent(93, 1), dependent(93, 2), dependent(93, 3), dependent(93, 4)] });
    server.server.answerWhen("sdkmessageprocessingstepimages", {
      value: [
        image(1, "Target", "pre", null),
        image(2, "", "PostImage", null),
        image(3, null, null, "5c4a0000-0000-4000-8000-000000000073"),
        image(4, "", "", null),
      ],
    });
    const card = await liteCard("name", true, server);
    expect(card.groups).toEqual([
      expect.objectContaining({ kind: "IMG", names: ["Image of sim_NoOp_04_Update_account", "PostImage", "Target"], unnamedCount: 1 }),
    ]);
  });

  it("keeps a step image unnamed when its parent step's name cannot be read", async () => {
    const server = setup();
    server.server.answerWhen("RetrieveDependentComponents", { value: [dependent(93, 52)] });
    server.server.answerWhen("sdkmessageprocessingstepimages", {
      value: [
        {
          sdkmessageprocessingstepimageid: "5c4a0000-0000-4000-8000-000000000052",
          name: null,
          entityalias: null,
          _sdkmessageprocessingstepid_value: "5c4a0000-0000-4000-8000-000000000073",
        },
      ],
    });
    server.server.failWhen("sdkmessageprocessingsteps", 403);
    const card = await liteCard("name", true, server);
    expect(card.groups).toEqual([expect.objectContaining({ kind: "IMG", names: [], unnamedCount: 1 })]);
  });

  it("lists every type account.name has, and counts the ones it cannot name", async () => {
    const card = await liteCard("name");
    const rows = fixture<{ value: DependentComponent[] }>("dependents-account-name").value;
    expect(card.headline).toBe(`Dataverse tracks ${rows.length} components that depend on this column.`);
    expect(summary(card.groups)).toEqual([
      "PLG 2 plugin steps",
      "IMG 2 plugin step images",
      "WF 4 classic workflows",
      "DLG 1 dialog",
      "ACT 1 action",
      "FRM 9 forms",
      "SQ 22 views",
      "CHT 3 charts",
      "COL 4 columns",
      "REL 7 relationships",
      "TPL 1 email template",
      "HR 1 hierarchy rule",
      "? 1 other component (type 10291)",
    ]);
    expect(card.groups.reduce((total, group) => total + group.count, 0)).toBe(rows.length);

    const columns = card.groups.find((group) => group.kind === "COL")!;
    expect(columns.names).toEqual(["customerrelationship.customerid"]);
    expect(columns.unnamedCount).toBe(3);
    const other = card.groups.at(-1)!;
    expect(other).toMatchObject({ names: [], unnamedCount: 1 });
  });

  it("sends one name lookup per kind, not one per component", async () => {
    const server = setup();
    await liteCard("name", true, server);
    const batched = server.server.requests.filter((url) => url.includes("Microsoft.Dynamics.CRM.In"));
    // Six kinds. Both real step images carry an alias, so no parent-step lookup follows.
    expect(batched).toHaveLength(6);
  });

  it("caps one-by-one lookups for columns and relationships", async () => {
    const server = setup();
    const rows = Array.from({ length: MAX_SINGLE_LOOKUPS + 5 }, (_, index) => dependent(10, 500 + index));
    server.server.answerWhen("RetrieveDependentComponents", { value: rows });
    const card = await liteCard("name", true, server);
    expect(server.server.requests.filter((url) => url.includes("RelationshipDefinitions"))).toHaveLength(MAX_SINGLE_LOOKUPS);
    expect(card.groups).toEqual([expect.objectContaining({ label: `${rows.length} relationships`, unnamedCount: rows.length })]);
  });
});

describe("absence is not evidence", () => {
  it("says the user has no access when the attribute read is forbidden", async () => {
    const server = setup();
    server.server.failWhen("EntityDefinitions(LogicalName='account')", 403);
    const card = await liteCard("name", true, server);
    expect(card.headline).toBe("You don't have access to Dataverse's dependency tracking for this column.");
    expect(card.groups).toEqual([]);
  });

  it("says it could not read, never zero, when RetrieveDependentComponents fails", async () => {
    const server = setup();
    server.server.failWhen("RetrieveDependentComponents", 500);
    const card = await liteCard("name", true, server);
    expect(card.headline).toBe("Could not read Dataverse's dependency tracking for this column.");
    expect(card.headline).not.toMatch(/\b0\b|no components/);
  });

  it("says it could not read a column Dataverse does not know", async () => {
    const card = await liteCard("doesnotexist");
    expect(card.headline).toBe("Could not read Dataverse's dependency tracking for this column.");
  });

  it("keeps components whose names failed, counted and marked", async () => {
    const server = setup();
    server.server.failWhen("savedqueries", 403);
    const card = await liteCard("name", true, server);
    expect(card.groups.find((group) => group.kind === "SQ")).toMatchObject({ count: 22, names: [], unnamedCount: 22, label: "22 views" });
  });

  it("says 'at least' when Dataverse has more pages", async () => {
    const server = setup();
    server.server.answerWhen("RetrieveDependentComponents", { value: [dependent(26, 8)], "@odata.nextLink": "next" });
    const card = await liteCard("name", true, server);
    expect(card.headline).toBe("Dataverse tracks at least 1 component that depends on this column.");
  });

  it("says none only when Dataverse answered with none", async () => {
    const server = setup();
    server.server.answerWhen("RetrieveDependentComponents", { value: [] });
    const card = await liteCard("name", true, server);
    expect(card.headline).toBe("Dataverse tracks no components that depend on this column.");
    expect(card.groups).toEqual([]);
  });
});

describe("dependenciesHeadline and groups", () => {
  it("counts a component Dataverse lists twice once", () => {
    const rows = [dependent(60, 21), dependent(60, 21), dependent(26, 8)];
    expect(dependenciesHeadline({ kind: "ok", rows, complete: true })).toBe("Dataverse tracks 2 components that depend on this column.");
    expect(summary(groupDependents(rows, new Map()))).toEqual(["FRM 1 form", "SQ 1 view"]);
  });

  it("reads a process with no category as a process", () => {
    expect(summary(groupDependents([dependent(29, 1)], new Map()))).toEqual(["WF 1 process"]);
  });
});

describe("Lite copy rules", () => {
  // Our wording only: customer component names can say anything.
  it("never says writers and never shows a Pathix number", async () => {
    for (const column of ["name", "creditlimit", "telephone1", "primarycontactid"]) {
      const card = await liteCard(column);
      const text = JSON.stringify({ ...card, groups: card.groups.map((group) => ({ ...group, names: [] })) });
      expect(text).not.toMatch(/writer/i);
      expect(text).not.toMatch(/Pathix found/);
    }
  });

  it("uses no em dashes", async () => {
    const card = await liteCard("name");
    expect(JSON.stringify(card)).not.toContain("—");
    expect(contrastLine(3, 4)).not.toContain("—");
  });

  it("carries one tip line naming what platform tracking cannot see and what Pathix does, linking to pathix.app", async () => {
    const card = await liteCard("name", true);
    expect(card.tip).toEqual(DEPENDENCIES_TIP);
    expect(card.tip?.text).toBe("Dataverse can't see inside plugin code. Pathix reads it to find what writes this column.");
    expect(card.tip?.linkText).toBe("Pathix");
    expect(card.tip?.href).toBe(PATHIX_SITE);
  });

  it("drops the tip line when tips are off", async () => {
    expect((await liteCard("name", false)).tip).toBeNull();
  });
});

describe("contrastLine", () => {
  it("contrasts Dataverse's tracking with Pathix's writers", () => {
    expect(contrastLine(12, 3)).toBe("Dataverse has 12 dependency records. Pathix found 3 writers.");
    expect(contrastLine(1, 1)).toBe("Dataverse has 1 dependency record. Pathix found 1 writer.");
    expect(contrastLine(0, 2)).toBe("Dataverse has 0 dependency records. Pathix found 2 writers.");
  });

  // The count is Dataverse's dependency records, not Lite's
  // "components that depend on this column", and the "?" says the two can differ.
  it("labels the count as dependency records, apart from Lite's components, and discloses that it can differ", () => {
    expect(contrastLine(12, 3)).not.toMatch(/tracks|components/);
    expect(PLATFORM_COUNT_EXPLAINED).toMatch(/^"Dataverse has N dependency records"/);
    expect(PLATFORM_COUNT_EXPLAINED).toContain("usually the count in Dataverse's Show dependencies view, but it can differ");
    expect(PLATFORM_COUNT_EXPLAINED).not.toMatch(/own count|matches|exactly/);
  });

  it("says what it could not read rather than showing zero", () => {
    expect(contrastLine(null, 3)).toBe("Dataverse's dependency record count is not in this scan. Pathix found 3 writers.");
    expect(contrastLine(12, null)).toBe("Dataverse has 12 dependency records.");
    expect(contrastLine(null, null)).toBeNull();
  });

  it("takes the writer count from the connected card", () => {
    const card = { stats: [{ label: "writers", value: 7 }, { label: "readers", value: 2 }] } as FieldCardModel;
    expect(writerCountOf(card)).toBe(7);
    expect(writerCountOf({ stats: [{ label: "writers", value: null }] } as FieldCardModel)).toBeNull();
  });
});

describe("buildDependenciesCard", () => {
  it("explains itself behind the ?", () => {
    const card = buildDependenciesCard({ table: "account", column: "name", showTips: true }, { kind: "failed" }, new Map());
    expect(card.info.join(" ")).toMatch(/plugin code, scripts or flow internals/);
    expect(card.info.join(" ")).toMatch(/External integrations/);
  });

  it("loads dependents from the fixtures as rows", async () => {
    const { get } = setup();
    const answer = await loadDependents(get, "account", "telephone1");
    expect(answer.kind).toBe("ok");
  });
});

describe("mode and tips settings", () => {
  it("is Lite with no Pathix address, connected with one", () => {
    expect(modeFor({})).toBe("lite");
    expect(modeFor({ pathixUrl: "" })).toBe("lite");
    expect(modeFor({ pathixUrl: "https://pathix.contoso.com" })).toBe("connected");
  });

  it("shows tips unless the user or the organization's policy turns them off", () => {
    expect(cardSettingsFrom({}, {})).toEqual({ mode: "lite", showTips: true });
    expect(cardSettingsFrom({ hideTips: true }, {})).toEqual({ mode: "lite", showTips: false });
    expect(cardSettingsFrom({ hideTips: false }, { hideTips: true })).toEqual({ mode: "lite", showTips: false });
    expect(cardSettingsFrom({}, { hideTips: "yes" })).toEqual({ mode: "lite", showTips: true });
  });

  it("validates the messages", () => {
    expect(isCardSettingsRequest({ kind: "cardSettings" })).toBe(true);
    expect(isCardSettingsRequest({ kind: "cardSettings", extra: 1 })).toBe(false);
    expect(isHideTipsRequest({ kind: "hideTips" })).toBe(true);
    expect(isCardSettings({ mode: "lite", showTips: true })).toBe(true);
    expect(isCardSettings({ mode: "other", showTips: true })).toBe(false);
  });
});
