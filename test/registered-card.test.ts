// The "Registered to fire when this changes" card (M2), built from the real
// fixtures in contract/dataverse/ through the fake Dataverse.

import { describe, expect, it } from "vitest";
import {
  EVERY_UPDATE_TITLE,
  MAX_EDITED_COLUMNS,
  isMicrosoftPublisher,
  MICROSOFT_PUBLISHERS,
  REGISTERED_TIP,
  REGISTERED_TITLE,
  filteringAttributes,
  type FiringGroup,
  type RegisteredCardModel,
} from "../src/card/registered";
import { PATHIX_SITE } from "../src/card/lite";
import { createDataverseClient } from "../src/dataverse/client";
import { loadRegisteredCard } from "../src/lite/registered";
import { fakeDataverse, ORIGIN } from "./fake-dataverse";

const PROCESSES = "workflows?$select=workflowid,name,category,mode,type";
/** The table's own steps. */
const STEPS = "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon&$expand=sdkmessageid($select=name),sdkmessagefilterid";
/** Steps on Update for every table: no message filter. */
const ALL_TABLES = "sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,solutionid,modifiedon&$expand=sdkmessageid($select=name)&$filter=_sdkmessagefilterid_value";

/**
 * Most tests here are about the table's own steps, so the read of steps
 * registered for every table answers an empty list. Pass allTables: true for
 * its real fixture (plugin-steps-update-all-tables.json).
 */
function setup(options: { allTables?: boolean } = {}) {
  const server = fakeDataverse();
  if (!options.allTables) server.answerWhen(ALL_TABLES, { value: [] });
  return { server, get: createDataverseClient(ORIGIN, server.fetch) };
}

async function card(column: string, options: { dirty?: string[]; showTips?: boolean; server?: ReturnType<typeof setup> } = {}): Promise<RegisteredCardModel> {
  const { get } = options.server ?? setup();
  return loadRegisteredCard(get, { table: "account", column, dirtyColumns: options.dirty ?? [], showTips: options.showTips ?? true });
}

function summary(groups: FiringGroup[]): string[] {
  return groups.map((group) => `${group.title}: ${group.items.map((item) => item.name).join(", ")}${group.microsoft.length ? ` +${group.microsoft.length} Microsoft` : ""}`);
}

let nextId = 900;
function rule(overrides: Record<string, unknown> = {}) {
  return {
    workflowid: `5c4a0000-0000-4000-8000-000000000${nextId++}`,
    name: "Credit check rule",
    category: 2,
    mode: 1,
    type: 1,
    statecode: 1,
    triggeronupdateattributelist: null,
    updatestage: null,
    _parentworkflowid_value: null,
    ...overrides,
  };
}

function processDependent(id: string) {
  return { dependentcomponenttype: 29, dependentcomponentobjectid: id, dependentcomponentparentid: "00000000-0000-0000-0000-000000000000", dependencytype: 2 };
}

describe("registered to fire, from the fixtures", () => {
  it("groups account.creditlimit's steps by stage and mode, from their filtering attributes", async () => {
    const model = await card("creditlimit");
    expect(model.title).toBe(REGISTERED_TITLE);
    expect(model.headline).toBe(
      "10 plugin steps are registered to fire when this column changes. 5 of them are from Microsoft publishers.",
    );
    expect(summary(model.groups)).toEqual([
      "Pre-operation, synchronous: sim_NoOp_04_Update_account, sim_NoOp_05_Update_account",
      "Post-operation, synchronous: sim_NoOp_15_Update_account, sim_NoOp_16_Update_account",
      `${EVERY_UPDATE_TITLE}: sim_NoOp_17_Update_account +5 Microsoft`,
    ]);
    expect(model.unknowns).toEqual([]);
  });

  it("lists steps with no filtering attributes in their own group, saying they fire on every update", async () => {
    const model = await card("telephone1");
    const every = model.groups.at(-1)!;
    expect(every.title).toBe("Fires on every update");
    expect(every.note).toMatch(/no filtering attributes/);
    expect(every.items[0]).toMatchObject({ name: "sim_NoOp_17_Update_account", detail: expect.stringContaining("Post-operation, asynchronous") });
    expect(summary(model.groups)[0]).toBe("Pre-operation, synchronous: sim_NoOp_07_Update_account");
  });

  it("lists an activated classic workflow whose update trigger names the column, once, from its activation", async () => {
    const model = await card("address1_composite");
    expect(model.headline).toMatch(/^7 plugin steps and 1 classic workflow are registered to fire when this column changes\./);
    const workflows = model.groups.find((group) => group.title === "Classic workflows")!;
    expect(workflows.items).toEqual([
      expect.objectContaining({ kind: "WF", name: "Account - On Update - Random", detail: "Background, after the change is saved · on change of address1_composite" }),
    ]);
    // The platform's own WorkflowExpansion step sits on an internal stage, named as such, with no rank.
    expect(model.groups[0]).toMatchObject({ title: "Platform stage 45, asynchronous" });
    expect(model.groups[0]!.items[0]!.detail).not.toMatch(/rank/);
  });

  it("leaves out disabled steps, other messages and draft workflows", async () => {
    const { server, get } = setup();
    server.answerWhen(STEPS, {
      value: [
        step({ name: "Disabled", statecode: 1, filteringattributes: "name" }),
        step({ name: "On create", message: "Create", filteringattributes: null }),
        step({ name: "On update", filteringattributes: "name" }),
      ],
    });
    server.answerWhen(PROCESSES, { value: [rule({ category: 0, name: "Draft", statecode: 0, triggeronupdateattributelist: "name" })] });
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    expect(summary(model.groups)).toEqual(["Pre-operation, synchronous: On update"]);
  });

  it("tells a real-time workflow that runs before the save from one that runs after", async () => {
    const { server, get } = setup();
    server.answerWhen(PROCESSES, {
      value: [
        rule({ category: 0, name: "Before", mode: 1, updatestage: 20, triggeronupdateattributelist: "name" }),
        rule({ category: 0, name: "After", mode: 1, updatestage: 40, triggeronupdateattributelist: "name,telephone1" }),
      ],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    expect(model.groups.find((group) => group.title === "Classic workflows")!.items.map((item) => `${item.name}: ${item.detail}`)).toEqual([
      "After: Real-time, after the change is saved · on change of name, telephone1",
      "Before: Real-time, before the change is saved · on change of name",
    ]);
  });
});

describe("steps registered on Update for every table", () => {
  it("lists them beside the table's own, marked all tables, and folds Microsoft's by publisher", async () => {
    const model = await card("creditlimit", { server: setup({ allTables: true }) });
    expect(model.headline).toBe("30 plugin steps are registered to fire when this column changes. 24 of them are from Microsoft publishers.");
    const every = model.groups.at(-1)!;
    expect(every.title).toBe(EVERY_UPDATE_TITLE);
    // sim_NoOp_25_Update_global is a test-environment step on Update with no table.
    expect(every.items.map((item) => `${item.name}: ${item.detail}`)).toEqual([
      "sim_NoOp_25_Update_global: Update · all tables · Pre-operation, synchronous · rank 25 · in the Active layer",
      "sim_NoOp_17_Update_account: Update · Post-operation, asynchronous · rank 17 · in the Active layer",
    ]);
    expect(every.microsoft.filter((item) => item.detail.includes("all tables"))).toHaveLength(19);
    expect(model.unknowns).toEqual([]);
  });

  it("lists one whose filtering attributes name the column, and leaves it out otherwise", async () => {
    const model = await card("subject", { server: setup({ allTables: true }) });
    const listed = model.groups.flatMap((group) => [...group.items, ...group.microsoft]).map((item) => item.name);
    expect(listed).toContain("ActionCardActivityPlugin");
    const other = await card("creditlimit", { server: setup({ allTables: true }) });
    expect(other.groups.flatMap((group) => [...group.items, ...group.microsoft]).map((item) => item.name)).not.toContain("ActionCardActivityPlugin");
  });

  it.each([
    [403, "You don't have access to steps registered on Update for every table."],
    [500, "Could not read steps registered on Update for every table."],
  ])("makes the count a minimum and says so when that read answers %i", async (status, line) => {
    const { server, get } = setup({ allTables: true });
    server.failWhen(ALL_TABLES, status);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("At least 10 plugin steps are registered to fire when this column changes. 5 of them are from Microsoft publishers.");
    expect(model.unknowns).toEqual([line]);
  });

  it("never says no steps are registered when that read failed", async () => {
    const { server, get } = setup({ allTables: true });
    server.failWhen(ALL_TABLES, 500);
    server.answerWhen(STEPS, { value: [] });
    server.answerWhen(PROCESSES, { value: [] });
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("Of what Lite could read, nothing is registered to fire when this column changes.");
  });

  it("still lists them when the table's own steps cannot be read, as a minimum", async () => {
    const { server, get } = setup({ allTables: true });
    server.failWhen(STEPS, 500);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("At least 20 plugin steps are registered to fire when this column changes. 19 of them are from Microsoft publishers.");
    expect(model.unknowns).toEqual(["Could not read plugin step registrations."]);
  });

  it("reads them once with a fixed query, whatever the table", async () => {
    const { server, get } = setup({ allTables: true });
    await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    await loadRegisteredCard(get, { table: "contact", column: "fullname", dirtyColumns: [], showTips: true });
    const reads = server.requests.map((url) => decodeURIComponent(url)).filter((url) => url.includes("_sdkmessagefilterid_value eq null"));
    expect(reads).toHaveLength(1);
  });
});

describe("Microsoft-shipped steps, by publisher only", () => {
  it("folds steps whose owning solution's publisher is a Microsoft publisher, and names every publisher", async () => {
    const model = await card("creditlimit");
    const every = model.groups.at(-1)!;
    expect(every.microsoft.map((item) => item.detail)).toEqual([
      "Update · Platform stage 25, synchronous · MicrosoftCorporation",
      "Update · Main operation, synchronous · MicrosoftCorporation",
      "Update · Main operation, synchronous · MicrosoftCorporation",
      "UpdateMultiple · Main operation, synchronous · MicrosoftCorporation",
      "UpdateMultiple · Main operation, synchronous · MicrosoftCorporation",
    ]);
    expect(model.groups[0]!.items[0]!.detail).toBe("Update · rank 4 · in the Active layer");
  });

  // A step's solutionid is its top layer. The Active solution's publisher is
  // the default publisher whoever wrote the step, and a customized Microsoft
  // step lands there too, so the card names no author for it and never folds it.
  it("says a step is in the Active layer, never names the default publisher as its owner, and never folds it", async () => {
    const { server, get } = setup();
    // Even when the Active solution's publisher reads as Microsoft's.
    server.answerWhen("publishers?", {
      value: [
        { publisherid: "5c4a0000-0000-4000-8000-000000000195", uniquename: "MicrosoftCorporation", friendlyname: "MicrosoftCorporation" },
        { publisherid: "5c4a0000-0000-4000-8000-000000000196", uniquename: "MicrosoftCorporation", friendlyname: "MicrosoftCorporation" },
      ],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const active = model.groups.flatMap((group) => group.items).filter((item) => item.detail.endsWith("in the Active layer"));
    expect(active.map((item) => item.name)).toEqual([
      "sim_NoOp_04_Update_account",
      "sim_NoOp_05_Update_account",
      "sim_NoOp_15_Update_account",
      "sim_NoOp_16_Update_account",
      "sim_NoOp_17_Update_account",
    ]);
    expect(JSON.stringify(model.groups)).not.toContain("Default Publisher");
    expect(model.groups.flatMap((group) => group.microsoft).some((item) => item.detail.includes("Active layer"))).toBe(false);
    expect(model.info.join(" ")).toMatch(/"in the Active layer" was created or changed in this environment/);
  });

  it("tells the Active solution by its unique name, read beside the publisher link and never with managed state", async () => {
    const { server, get } = setup();
    await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const reads = server.requests.map((url) => decodeURIComponent(url)).filter((url) => url.includes("/solutions?"));
    expect(reads.length).toBeGreaterThan(0);
    for (const url of reads) expect(url).toContain("$select=solutionid,uniquename,_publisherid_value&");
  });

  it("adds the Active layer line only when a step the card lists sits there", async () => {
    // The table has steps in the Active layer, but none fires on this column.
    const { server, get } = setup();
    server.answerWhen(STEPS, {
      value: [
        { ...step({ name: "Other column", filteringattributes: "telephone1" }), solutionid: "5c4a0000-0000-4000-8000-000000000084" },
        { ...step({ name: "This column", filteringattributes: "creditlimit" }), solutionid: "5c4a0000-0000-4000-8000-000000000077" },
      ],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const listed = model.groups.flatMap((group) => [...group.items, ...group.microsoft]);
    expect(listed.map((item) => item.name)).toEqual(["This column"]);
    expect(listed.some((item) => item.detail.includes("Active layer"))).toBe(false);
    expect(model.info.join(" ")).not.toMatch(/Active layer/);

    // An unsaved edit to the other column lists that step, and the line comes back.
    const edited = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: ["telephone1"], showTips: true });
    expect(edited.edits!.groups.flatMap((group) => group.items).map((item) => item.detail)).toContain("Update · rank 1 · in the Active layer");
    expect(edited.info.join(" ")).toMatch(/"in the Active layer" was created or changed/);
  });

  it("names no Active layer, and adds no line about it, when no step sits there", async () => {
    const { server, get } = setup();
    server.answerWhen("solutions?", {
      value: [{ solutionid: "5c4a0000-0000-4000-8000-000000000084", uniquename: "contoso_core", _publisherid_value: "5c4a0000-0000-4000-8000-000000000196" }],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.groups[0]!.items[0]!.detail).toBe("Update · rank 4 · Default Publisher for contoso");
    expect(model.info.join(" ")).not.toMatch(/Active layer/);
  });

  // Exactly the Microsoft publisher list in the Pathix server's publisher classifier.
  it("pins the Microsoft publishers to Pathix's own classifier", () => {
    expect([...MICROSOFT_PUBLISHERS]).toEqual([
    "MicrosoftCorporation",
    "MicrosoftDynamics",
    "MicrosoftDynamics365",
    "MicrosoftCorporationscm",
    "microsoftdynamics",
    "microsoftcrm",
    "dynamics365customerengagement",
    "adxstudio",
    "msdyn",
    "PowerCat",
    "DynamicsMKT",
    "QMSAnchor",
    ]);
  });

  it.each([
    ...MICROSOFT_PUBLISHERS,
    "microsoftcorporation",
    "MSDYN",
    "powercat",
    "ADXStudio",
    "dynamicsmkt",
    "qmsanchor",
    // The case-insensitive "Microsoft" prefix backstop.
    "microsoftfirstparty",
    "MicrosoftFirstParty",
    "MicrosoftSomethingNew",
  ])("treats %s as a Microsoft publisher", (name) => {
    expect(isMicrosoftPublisher(name)).toBe(true);
  });

  it.each(["DefaultPublishercontoso", "contoso", "msdynext", "PowerCatalyst", "notmicrosoft", "", null])(
    "keeps %s with the customer's steps",
    (name) => {
      expect(isMicrosoftPublisher(name)).toBe(false);
    },
  );

  it("folds a step from a listed publisher that is not named Microsoft", async () => {
    const { server, get } = setup();
    server.answerWhen("publishers?", {
      value: [
        { publisherid: "5c4a0000-0000-4000-8000-000000000195", uniquename: "msdyn", friendlyname: "Dynamics 365" },
        { publisherid: "5c4a0000-0000-4000-8000-000000000196", uniquename: "msdyn", friendlyname: "Dynamics 365" },
        { publisherid: "5c4a0000-0000-4000-8000-000000000197", uniquename: "msdyn", friendlyname: "Dynamics 365" },
      ],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    // Every step folds except those in the Active layer, which name no publisher.
    expect(model.groups.flatMap((group) => group.items).every((item) => item.detail.endsWith("in the Active layer"))).toBe(true);
    expect(model.headline).toMatch(/5 of them are from Microsoft publishers\.$/);
  });

  it("never reads whether a solution is managed", async () => {
    const { server, get } = setup();
    await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    const solutionReads = server.requests.filter((url) => url.includes("/solutions?"));
    expect(solutionReads.length).toBeGreaterThan(0);
    for (const url of solutionReads) expect(decodeURIComponent(url)).not.toMatch(/ismanaged/);
  });

  it("keeps a managed solution from a customer's publisher with the customer's steps", async () => {
    const { server, get } = setup();
    // The customer ships its code as a managed solution: still the customer's.
    server.answerWhen("solutions?", {
      value: [{ solutionid: "5c4a0000-0000-4000-8000-000000000083", _publisherid_value: "5c4a0000-0000-4000-8000-000000000196", ismanaged: true }],
    });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.groups[0]!.items).toHaveLength(2);
    expect(model.groups.every((group) => group.microsoft.length === 0)).toBe(true);
  });

  it.each([
    ["solutions?", 403],
    ["publishers?", 500],
  ])("sets nothing apart when %s cannot be read, and says so", async (prefix, status) => {
    const { server, get } = setup();
    server.failWhen(prefix, status);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.groups.every((group) => group.microsoft.length === 0)).toBe(true);
    expect(model.groups.at(-1)!.items).toHaveLength(6);
    expect(model.headline).toBe("10 plugin steps are registered to fire when this column changes.");
    expect(model.info.join(" ")).toMatch(/could not read the steps' publishers/);
    expect(model.groups[0]!.items[0]!.detail).toBe("Update · rank 4");
  });
});

describe("business rules", () => {
  it("lists an activated business rule Dataverse tracks as using the column", async () => {
    const { server, get } = setup();
    const active = rule({ name: "Credit check rule" });
    server.answerWhen(PROCESSES, { value: [active, rule({ name: "Draft rule", statecode: 0 })] });
    server.answerWhen("RetrieveDependentComponents", { value: [processDependent(active.workflowid)] });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.headline).toMatch(/^10 plugin steps and 1 business rule are registered/);
    expect(model.groups.find((group) => group.title === "Business rules")!.items).toEqual([
      expect.objectContaining({ kind: "BR", name: "Credit check rule" }),
    ]);
  });

  it("says it could not read which business rules use the column, never none", async () => {
    const { server, get } = setup();
    server.answerWhen(PROCESSES, { value: [rule()] });
    server.failWhen("RetrieveDependentComponents", 500);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.unknowns).toEqual(["Could not read whether the table's 1 active business rule uses this column."]);
    expect(model.headline).not.toMatch(/business rule/);
  });

  it("skips dependency tracking when the table has no active business rule", async () => {
    const { server, get } = setup();
    await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: ["name"], showTips: true });
    expect(server.requests.some((url) => url.includes("RetrieveDependentComponents"))).toBe(false);
  });
});

describe("absence is not evidence", () => {
  it.each([
    [403, "You don't have access to plugin step registrations."],
    [500, "Could not read plugin step registrations."],
  ])("says so when plugin steps answer %i, and never counts them as none", async (status, line) => {
    const { server, get } = setup({ allTables: true });
    server.failWhen("sdkmessageprocessingsteps", status);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.unknowns).toEqual([
      line,
      status === 403 ? "You don't have access to steps registered on Update for every table." : "Could not read steps registered on Update for every table.",
    ]);
    expect(model.headline).toBe("Of what Lite could read, nothing is registered to fire when this column changes.");
    expect(model.headline).not.toMatch(/\b0\b/);
  });

  it("says so when processes cannot be read", async () => {
    const { server, get } = setup();
    server.failWhen("workflows", 403);
    const model = await loadRegisteredCard(get, { table: "account", column: "address1_composite", dirtyColumns: [], showTips: true });
    expect(model.unknowns).toEqual(["You don't have access to classic workflows and business rules."]);
    expect(model.headline).toMatch(/^7 plugin steps are registered/);
  });

  it("says it could not read anything when nothing answers", async () => {
    const { server, get } = setup();
    server.failWhen("sdkmessageprocessingsteps", 500);
    server.failWhen("workflows", 500);
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("Lite could not read what is registered to fire when this column changes.");
    expect(model.groups).toEqual([]);
  });

  it("says 'at least' when Dataverse has more pages of steps", async () => {
    const { server, get } = setup();
    server.answerWhen(STEPS, { value: [step({ filteringattributes: "name" })], "@odata.nextLink": "next" });
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    expect(model.headline).toMatch(/^At least 1 plugin step is registered/);
    expect(model.unknowns).toContain("Lite could not read every page of plugin steps Dataverse returned, so some may be missing.");
  });

  it("says none is registered only when every source answered with none, and names only what it read", async () => {
    const { server, get } = setup();
    server.answerWhen(STEPS, { value: [] });
    server.answerWhen(PROCESSES, { value: [] });
    const model = await loadRegisteredCard(get, { table: "account", column: "name", dirtyColumns: [], showTips: true });
    // Lite never reads cloud flows, so it never says nothing at all fires.
    expect(model.headline).toBe("No plugin steps, classic workflows or business rules are registered to fire when this column changes.");
    expect(model.headline).not.toMatch(/^Nothing/);
  });

  it("says 'at least' for business rules when Dataverse has more pages of processes", async () => {
    const { server, get } = setup();
    const active = rule({ name: "Credit check rule" });
    server.answerWhen(STEPS, { value: [] });
    server.answerWhen(PROCESSES, { value: [active], "@odata.nextLink": "next" });
    server.answerWhen("RetrieveDependentComponents", { value: [processDependent(active.workflowid)] });
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: [], showTips: true });
    expect(model.headline).toBe("At least 1 business rule is registered to fire when this column changes.");
    expect(model.unknowns).toContain("Lite could not read every page of processes Dataverse returned, so some may be missing.");
  });
});

describe("the form's unsaved edits", () => {
  it("shows what the current set of edits is registered to fire, by name only", async () => {
    const model = await card("creditlimit", { dirty: ["telephone1", "name", "name"] });
    expect(model.edits?.columns).toEqual(["name", "telephone1"]);
    expect(model.edits?.headline).toBe(
      "9 plugin steps are registered to fire when you save your edits to 2 columns. 5 of them are from Microsoft publishers.",
    );
    expect(summary(model.edits!.groups)).toEqual([
      "Pre-operation, synchronous: sim_NoOp_06_Update_account, sim_NoOp_07_Update_account",
      "Post-operation, asynchronous: PathixDemo: LateBoundCreditLimitWriter on Account.Update",
      `${EVERY_UPDATE_TITLE}: sim_NoOp_17_Update_account +5 Microsoft`,
    ]);
  });

  it("names a single edit", async () => {
    const model = await card("creditlimit", { dirty: ["telephone1"] });
    expect(model.edits?.headline).toMatch(/when you save your edit to telephone1\./);
  });

  it("has no edits section when nothing is edited", async () => {
    expect((await card("creditlimit")).edits).toBeNull();
  });

  it(`checks at most ${MAX_EDITED_COLUMNS} edited columns and says so`, async () => {
    const dirty = Array.from({ length: MAX_EDITED_COLUMNS + 2 }, (_, index) => `new_column${String(index).padStart(2, "0")}`);
    const model = await card("creditlimit", { dirty });
    expect(model.edits?.columns).toHaveLength(MAX_EDITED_COLUMNS + 2);
    expect(model.edits?.unknowns).toContain(`Only the first ${MAX_EDITED_COLUMNS} edited columns were checked.`);
  });
});

describe("the form's unsaved edits, with business rules", () => {
  it("reads dependency tracking for exactly the edited columns it checks, whatever their order on the page", async () => {
    const { server, get } = setup();
    const active = rule({ name: "Rule on z" });
    server.answerWhen(PROCESSES, { value: [active] });
    server.answerWhen("RetrieveDependentComponents", { value: [processDependent(active.workflowid)] });
    server.answerWhen("EntityDefinitions(LogicalName='account')/Attributes", { MetadataId: "5c4a0000-0000-4000-8000-000000000005" });
    const dirty = Array.from({ length: MAX_EDITED_COLUMNS + 3 }, (_, index) => `new_c${String(MAX_EDITED_COLUMNS + 3 - index).padStart(2, "0")}`);
    const model = await loadRegisteredCard(get, { table: "account", column: "creditlimit", dirtyColumns: dirty, showTips: true });
    expect(model.edits?.unknowns).toEqual([`Only the first ${MAX_EDITED_COLUMNS} edited columns were checked.`]);
    expect(model.edits?.groups.find((group) => group.title === "Business rules")?.items).toHaveLength(1);
  });
});

describe("registered card copy", () => {
  it("never says writers and never shows a Pathix number", async () => {
    for (const column of ["name", "creditlimit", "telephone1", "address1_composite"]) {
      const model = await card(column, { dirty: ["name"] });
      const ours = JSON.stringify({ ...model, groups: [], edits: model.edits && { ...model.edits, groups: [] } });
      expect(ours).not.toMatch(/writer/i);
      expect(ours).not.toMatch(/Pathix found/);
      expect(ours).not.toContain("—");
    }
  });

  it("carries a footer line naming what it cannot see and what Pathix does", async () => {
    const model = await card("name");
    expect(model.tip).toEqual(REGISTERED_TIP);
    expect(model.tip?.text).toBe(
      "Registered isn't the same as writes. Pathix reads plugin code, scripts and flows to show what actually writes this column.",
    );
    expect(model.tip?.linkText).toBe("Pathix");
    expect(model.tip?.href).toBe(PATHIX_SITE);
    expect((await card("name", { showTips: false })).tip).toBeNull();
  });

  it("explains what it lists and what it does not behind the ?", async () => {
    const info = (await card("name")).info.join(" ");
    expect(info).toMatch(/filtering attributes/);
    expect(info).toMatch(/cloud flows/);
    expect(info).toMatch(/External integrations/);
    expect(info).toMatch(/never by whether the solution is managed/);
  });
});

describe("filteringAttributes", () => {
  it("splits, trims and lowercases, and reads blank as none", () => {
    expect(filteringAttributes("creditlimit, CreditOnHold ,")).toEqual(["creditlimit", "creditonhold"]);
    expect(filteringAttributes("")).toEqual([]);
    expect(filteringAttributes(null)).toEqual([]);
  });
});

let nextStep = 700;
function step(options: { name?: string; message?: string; stage?: number; mode?: number; statecode?: number; filteringattributes: string | null }) {
  return {
    sdkmessageprocessingstepid: `5c4a0000-0000-4000-8000-000000000${nextStep++}`,
    name: options.name ?? "Step",
    stage: options.stage ?? 20,
    mode: options.mode ?? 0,
    rank: 1,
    filteringattributes: options.filteringattributes,
    statecode: options.statecode ?? 0,
    solutionid: "5c4a0000-0000-4000-8000-000000000083",
    sdkmessageid: { name: options.message ?? "Update" },
    sdkmessagefilterid: { primaryobjecttypecode: "account" },
  };
}
