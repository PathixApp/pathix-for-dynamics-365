// When a connected-card writer runs: the trigger lines Pathix serves on a
// writers row and a plugin step's images.

import { describe, expect, it } from "vitest";
import { firesWhen, imagesFor, listedTriggerLines, MAX_TRIGGER_LINES, triggerLabel, triggerLines } from "../src/card/triggers";
import type { ComponentRegistration, FieldWriter, TriggerSummary } from "../src/pathix/api";

function writer(overrides: Partial<FieldWriter> = {}): FieldWriter {
  return {
    componentId: "c1",
    componentName: "Credit check",
    componentType: "PluginStep",
    isSystem: false,
    isConditional: false,
    isHumanDriven: false,
    confidence: "Parsed",
    actionTypes: ["Update"],
    ...overrides,
  };
}

function trigger(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    message: "Update",
    stage: "PostOperation",
    executionMode: "Asynchronous",
    table: "account",
    filteringColumns: [],
    firesOnEveryUpdate: false,
    hasRowFilter: null,
    ...overrides,
  };
}

const lines = (w: FieldWriter, registration: ComponentRegistration | null = null) => triggerLines(w, registration, "account");

describe("triggerLabel", () => {
  it.each([
    ["an update step", trigger(), "On Update · Post-op · Async"],
    ["a bulk update step, which fires like an update", trigger({ message: "UpdateMultiple", stage: "PreOperation", executionMode: "Synchronous" }), "On Update · Pre-op · Sync"],
    ["the legacy bulk update", trigger({ message: "UpdateMultipleLegacy" }), "On Update · Post-op · Async"],
    ["a trigger on another table", trigger({ message: "Create", table: "contact", stage: null }), "On contact create · Async"],
    ["a bulk update on another table", trigger({ message: "UpdateMultiple", table: "contact", stage: null, executionMode: null }), "On contact update"],
    ["a custom message", trigger({ message: "pathix_SetCreditLimit", stage: "MainOperation", executionMode: "Synchronous", table: null }), "Runs as pathix_SetCreditLimit · Sync"],
  ])("labels %s", (_name, source, expected) => {
    expect(triggerLabel(source, "account")).toBe(expected);
  });

  it("has nothing to say without a message", () => {
    expect(triggerLabel(null, "account")).toBeNull();
    expect(triggerLabel(trigger({ message: null }), "account")).toBeNull();
  });
});

describe("what scopes a trigger", () => {
  it("lists the filtering columns of an update step", () => {
    const result = lines(writer({ triggers: [trigger({ filteringColumns: ["creditlimit", "name"] })] }));
    expect(result).toEqual([{ label: "On Update · Post-op · Async", scope: "Fires when creditlimit, name change", rowFilter: null }]);
  });

  it("says a step with no filtering columns fires on every update", () => {
    const result = lines(writer({ triggers: [trigger({ firesOnEveryUpdate: true })] }));
    expect(result[0]).toMatchObject({ scope: "Fires on every update" });
  });

  it("does not say anything about scope for an update trigger Pathix recorded no columns for and does not call unfiltered", () => {
    // Empty columns without the flag cannot be read as either answer.
    expect(lines(writer({ triggers: [trigger()] }))[0]!.scope).toBeNull();
  });

  it("says nothing of scope for a create trigger, whose list is always empty", () => {
    expect(lines(writer({ triggers: [trigger({ message: "Create" })] }))[0]!.scope).toBeNull();
  });

  it("names filtering columns that sit on a message other than update without claiming when it fires", () => {
    const result = lines(writer({ triggers: [trigger({ message: "pathix_Custom", filteringColumns: ["a"] })] }));
    expect(result[0]!.scope).toBe("Filtering column: a");
  });

  it("agrees the verb with the column count: one column changes, several change", () => {
    expect(lines(writer({ triggers: [trigger({ filteringColumns: ["name"] })] }))[0]!.scope).toBe("Fires when name changes");
    expect(lines(writer({ triggers: [trigger({ filteringColumns: ["name", "sic"] })] }))[0]!.scope).toBe("Fires when name, sic change");
    expect(lines(writer({ triggers: [trigger({ message: "pathix_Custom", filteringColumns: ["a", "b"] })] }))[0]!.scope).toBe("Filtering columns: a, b");
    expect(firesWhen("name", 1)).toBe("Fires when name changes");
    expect(firesWhen("a, b, c, d +2 more", 6)).toBe("Fires when a, b, c, d +2 more change");
  });

  it("caps a long column list and counts the rest", () => {
    const columns = ["a", "b", "c", "d", "e", "f"];
    expect(lines(writer({ triggers: [trigger({ filteringColumns: columns })] }))[0]!.scope).toBe("Fires when a, b, c, d +2 more change");
  });

  it("reads an older Pathix, which sends no filter facts, as saying nothing about scope", () => {
    const old: TriggerSummary = { message: "Update", stage: "PostOperation", executionMode: "Asynchronous", table: "account" };
    expect(lines(writer({ triggers: [old] }))).toEqual([{ label: "On Update · Post-op · Async", scope: null, rowFilter: null }]);
  });
});

describe("a cloud flow's row filter", () => {
  const flow = (hasRowFilter: boolean | null, overrides: Partial<TriggerSummary> = {}) =>
    lines(writer({ componentType: "ModernFlow", triggers: [trigger({ stage: null, executionMode: null, hasRowFilter, ...overrides })] }));

  it.each([
    [true, "Row filter set"],
    [false, "No row filter"],
    [null, "Row filter unknown"],
  ])("reads %s as %s, never null as no filter", (value, expected) => {
    expect(flow(value)[0]!.rowFilter).toBe(expected);
  });

  it("reads a flow update with a row filter and no select columns as both, since the two are separate facts", () => {
    expect(flow(true, { firesOnEveryUpdate: true })[0]).toMatchObject({ scope: "Fires on every update", rowFilter: "Row filter set" });
  });

  it("says nothing of a row filter for anything that is not a flow", () => {
    expect(lines(writer({ triggers: [trigger({ hasRowFilter: null })] }))[0]!.rowFilter).toBeNull();
    expect(lines(writer({ componentType: "ClassicWorkflow", triggers: [trigger()] }))[0]!.rowFilter).toBeNull();
  });

  it("leaves the row filter out of a trigger Pathix does not model, such as a schedule or a button", () => {
    const result = flow(null, { message: null });
    expect(result).toEqual([{ label: "Other trigger", scope: null, rowFilter: null }]);
  });

  it("covers an agent flow too", () => {
    expect(lines(writer({ componentType: "AgentFlow", triggers: [trigger({ hasRowFilter: false })] }))[0]!.rowFilter).toBe("No row filter");
  });
});

describe("which triggers a writer has", () => {
  it("lists every trigger Pathix gives, and collapses identical lines", () => {
    const result = lines(writer({ triggers: [trigger({ message: "Create", stage: null }), trigger({ message: "Update" }), trigger({ message: "Update" })] }));
    expect(result.map((line) => line.label)).toEqual(["On Create · Async", "On Update · Post-op · Async"]);
  });

  it("keeps two update triggers that differ in their columns", () => {
    const result = lines(writer({ triggers: [trigger({ filteringColumns: ["a"] }), trigger({ filteringColumns: ["b"] })] }));
    expect(result.map((line) => line.scope)).toEqual(["Fires when a changes", "Fires when b changes"]);
  });

  it("calls a trigger Pathix does not model another trigger, never Custom", () => {
    const result = lines(writer({ componentType: "ModernFlow", triggers: [trigger({ message: null, stage: null, executionMode: null, table: null })] }));
    expect(result[0]!.label).toBe("Other trigger");
  });

  it("has no triggers for a component a person starts", () => {
    expect(lines(writer({ componentType: "CanvasApp", triggers: null }))).toEqual([]);
  });

  it("lists three and counts the rest", () => {
    const many = ["Create", "Delete", "Assign", "SetState", "Merge"].map((message) => trigger({ message }));
    const { shown, more } = listedTriggerLines(lines(writer({ triggers: many })));
    expect(shown).toHaveLength(MAX_TRIGGER_LINES);
    expect(more).toBe(2);
  });

  describe("from an older Pathix, whose writers rows carry no triggers", () => {
    const registration: ComponentRegistration = { message: "Create", stage: null, executionMode: "Asynchronous", primaryEntity: "account" };

    it("falls back to the registration's one trigger, with no scope to state", () => {
      expect(lines(writer({ componentType: "ClassicWorkflow" }), registration)).toEqual([{ label: "On Create · Async", scope: null, rowFilter: null }]);
    });

    it("prefers the registration's trigger list when it has one", () => {
      const listed = { ...registration, triggers: [trigger({ filteringColumns: ["a"] })] };
      expect(lines(writer(), listed)[0]!.scope).toBe("Fires when a changes");
    });

    it("shows nothing when the registration could not be read, never a guess", () => {
      expect(lines(writer(), null)).toEqual([]);
    });
  });
});

describe("a plugin step's images", () => {
  const registration = (images: ComponentRegistration["images"]): ComponentRegistration => ({
    message: "Update",
    stage: "PostOperation",
    executionMode: "Asynchronous",
    primaryEntity: "account",
    images,
  });
  const image = (overrides: Partial<NonNullable<ComponentRegistration["images"]>[number]> = {}) => ({
    imageType: "Pre",
    name: "PreImage",
    entityAlias: "PreImage",
    columns: [],
    ...overrides,
  });

  it("lists the type, the name and which columns each image holds", () => {
    const result = imagesFor(writer(), registration([image(), image({ imageType: "Post", name: "After", entityAlias: "A", columns: ["creditlimit", "name"] })]), "creditlimit");
    expect(result).toEqual({
      kind: "list",
      lines: [{ text: "Pre-image PreImage · all columns" }, { text: "Post-image After (alias A) · this column and 1 more" }],
    });
  });

  it("falls back to the alias when the name is empty, and says unnamed when both are", () => {
    const result = imagesFor(writer(), registration([image({ name: null }), image({ name: "  ", entityAlias: null })]), "name");
    expect(result).toMatchObject({ lines: [{ text: "Pre-image PreImage · all columns" }, { text: "Pre-image unnamed · all columns" }] });
  });

  it("says when an image does not hold the column the card is about", () => {
    const result = imagesFor(writer(), registration([image({ columns: ["telephone1"] })]), "creditlimit");
    expect(result).toMatchObject({ lines: [{ text: "Pre-image PreImage · 1 column, not this one" }] });
  });

  it("names a type it does not know as an image", () => {
    expect(imagesFor(writer(), registration([image({ imageType: "Unknown" })]), "x")).toMatchObject({ lines: [{ text: "Image PreImage · all columns" }] });
  });

  it("lists none for a step captured with none, but says unknown when Pathix gave no answer", () => {
    expect(imagesFor(writer(), registration([]), "x")).toEqual({ kind: "list", lines: [] });
    expect(imagesFor(writer(), registration(null), "x")).toEqual({ kind: "unknown" });
    expect(imagesFor(writer(), registration(undefined), "x")).toEqual({ kind: "unknown" });
    expect(imagesFor(writer(), null, "x")).toEqual({ kind: "unknown" });
  });

  it("is for plugin steps only", () => {
    expect(imagesFor(writer({ componentType: "ClassicWorkflow" }), registration([]), "x")).toBeNull();
    expect(imagesFor(writer({ componentType: "ModernFlow" }), null, "x")).toBeNull();
  });
});
