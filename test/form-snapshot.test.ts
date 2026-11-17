import { describe, expect, it } from "vitest";
import { isPageMessage } from "../src/bridge/messages";
import { buildPageMessage, type XrmAttribute, type XrmControl, type XrmLike, type XrmQuickView } from "../src/page/form-snapshot";

const RECORD_ID = "{11111111-2222-4333-8444-555555555555}";
const SECRET_VALUE = "Contoso Secret Holdings";

// A fake attribute that, like the real one, can hand out its value and its
// record's id. The snapshot builder must never ask for either.
const SECRET_EDIT = "Contoso Secret Edit";

function attribute(name: string, dirty = false, submitMode = "dirty"): XrmAttribute & { getValue(): string; getInitialValue(): string } {
  return {
    getName: () => name,
    getIsDirty: () => dirty,
    getSubmitMode: () => submitMode,
    getValue: () => (dirty ? SECRET_EDIT : SECRET_VALUE),
    getInitialValue: () => SECRET_VALUE,
  };
}

function boundControl(controlName: string, attr: XrmAttribute, disabled = false): XrmControl & { getValue(): string } {
  return { getName: () => controlName, getAttribute: () => attr, getDisabled: () => disabled, getValue: () => SECRET_VALUE };
}

function fakeXrm(controls: XrmControl[], attributes: XrmAttribute[], formType?: () => number): XrmLike {
  return {
    Page: {
      data: {
        entity: Object.assign(
          { getEntityName: () => "account", attributes: { get: () => attributes } },
          { getId: () => RECORD_ID, getPrimaryAttributeValue: () => SECRET_VALUE },
        ),
      },
      ui: {
        controls: { get: () => controls },
        getFormType: formType ?? (() => 2),
        formSelector: { getCurrentItem: () => ({ getId: () => "{8448B78F-8F42-454E-8E2A-F8196B0419AF}" }) },
      },
    },
    Utility: {
      getGlobalContext: () => ({ organizationSettings: { organizationId: "C0DE0000-0000-4000-8000-000000000003" } }),
    },
  };
}

describe("buildPageMessage", () => {
  const name = attribute("name", true);
  const owner = attribute("ownerid");
  const xrm = fakeXrm(
    [
      boundControl("name", name),
      boundControl("header_ownerid", owner),
      { getName: () => "Contacts" }, // a subgrid: no attribute
      { getName: () => "WebResource_banner", getAttribute: () => null },
    ],
    [name, owner],
  );

  it("captures the table, form, organization and bound controls", () => {
    const message = buildPageMessage(xrm, "Contoso.crm.dynamics.com");
    expect(message).toEqual({
      channel: "pathix-extension",
      kind: "formSnapshot",
      version: 1,
      organizationId: "c0de0000-0000-4000-8000-000000000003",
      host: "contoso.crm.dynamics.com",
      table: "account",
      formId: "8448b78f-8f42-454e-8e2a-f8196b0419af",
      columns: [
        { control: "name", column: "name" },
        { control: "header_ownerid", column: "ownerid" },
      ],
      dirtyColumns: ["name"],
      lockedControls: [],
      saveKind: "update",
      alwaysSubmitColumns: [],
      quickViewColumns: [],
    });
    expect(isPageMessage(message)).toBe(true);
  });

  it("never carries a field value or the record id", () => {
    const serialized = JSON.stringify(buildPageMessage(xrm, "contoso.crm.dynamics.com"));
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized.toLowerCase()).not.toContain("11111111-2222-4333-8444-555555555555");
  });

  it("carries the names of dirty columns and never the edits (M2)", () => {
    const phone = attribute("telephone1", true);
    const message = buildPageMessage(fakeXrm([boundControl("name", name), boundControl("telephone1", phone)], [name, owner, phone]), "x.crm.dynamics.com");
    expect(message.kind === "formSnapshot" && message.dirtyColumns).toEqual(["name", "telephone1"]);
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain(SECRET_EDIT);
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  it("carries the names of read-only bound controls and nothing about why (M3)", () => {
    const owner = attribute("ownerid");
    const message = buildPageMessage(
      fakeXrm(
        [
          boundControl("name", name),
          boundControl("header_ownerid", owner, true),
          { getName: () => "Contacts", getDisabled: () => true }, // a locked subgrid: no attribute
          boundControl("odd-control name", attribute("telephone1"), true),
        ],
        [name, owner],
      ),
      "x.crm.dynamics.com",
    );
    expect(message.kind === "formSnapshot" && message.lockedControls).toEqual(["header_ownerid"]);
    expect(isPageMessage(message)).toBe(true);
    expect(JSON.stringify(message)).not.toContain(SECRET_VALUE);
  });

  it("treats a control whose getDisabled throws, or that has none, as not locked", () => {
    const throwing: XrmControl = {
      getName: () => "telephone1",
      getAttribute: () => attribute("telephone1"),
      getDisabled: () => {
        throw new Error("not supported");
      },
    };
    const bare: XrmControl = { getName: () => "fax", getAttribute: () => attribute("fax") };
    const message = buildPageMessage(fakeXrm([throwing, bare], []), "x.crm.dynamics.com");
    expect(message.kind === "formSnapshot" && message.lockedControls).toEqual([]);
  });

  it("asks a control only for its name, its attribute and whether it is disabled", () => {
    const asked: string[] = [];
    const spy = new Proxy(boundControl("name", attribute("name"), true), {
      get(target, property, receiver) {
        asked.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    buildPageMessage(fakeXrm([spy], []), "x.crm.dynamics.com");
    expect([...new Set(asked)].sort()).toEqual(["getAttribute", "getDisabled", "getName"]);
  });

  it("asks a dirty attribute only for its name and whether it is dirty", () => {
    const asked: string[] = [];
    const spy = new Proxy(attribute("telephone1", true), {
      get(target, property, receiver) {
        asked.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    buildPageMessage(fakeXrm([], [spy]), "x.crm.dynamics.com");
    // The submit mode is a setting (always, dirty or never), read for the save preview (M12). Never the value.
    expect([...new Set(asked)].sort()).toEqual(["getIsDirty", "getName", "getSubmitMode"]);
  });

  describe("the save preview's inputs (M12)", () => {
    const build = (formType: (() => number) | undefined, attributes: XrmAttribute[] = [name]) => {
      const message = buildPageMessage(fakeXrm([], attributes, formType), "x.crm.dynamics.com");
      return message.kind === "formSnapshot" ? message : null;
    };

    it.each([
      [1, "create"],
      [11, "create"],
      [2, "update"],
      [3, null],
      [4, null],
      [6, null],
      [0, null],
    ])("reads form type %s as %s", (type, expected) => {
      expect(build(() => type)?.saveKind).toBe(expected);
    });

    it("reads no save kind when the form has no type, or reading it throws", () => {
      const noType: XrmLike = fakeXrm([], [name]);
      delete (noType.Page!.ui as { getFormType?: unknown }).getFormType;
      const absent = buildPageMessage(noType, "x.crm.dynamics.com");
      expect(absent.kind === "formSnapshot" && absent.saveKind).toBeNull();
      const throwing = build(() => {
        throw new Error("not supported");
      });
      expect(throwing?.saveKind).toBeNull();
    });

    it("names only the columns the form submits always, never the ones set to dirty or never", () => {
      const always = attribute("statecode", false, "always");
      const alwaysEdited = attribute("telephone1", true, "always");
      const never = attribute("fax", true, "never");
      const noMode: XrmAttribute = { getName: () => "websiteurl", getIsDirty: () => false };
      const throwing: XrmAttribute = {
        getName: () => "emailaddress1",
        getIsDirty: () => false,
        getSubmitMode: () => {
          throw new Error("not supported");
        },
      };
      const message = build(undefined, [name, always, alwaysEdited, never, noMode, throwing]);
      expect(message?.alwaysSubmitColumns).toEqual(["statecode", "telephone1"]);
      // The dirty list is unchanged by the submit mode: the preview sends the union.
      expect(message?.dirtyColumns).toEqual(["name", "telephone1", "fax"]);
    });

    it("drops an always-submitted column whose name the bridge would reject", () => {
      const odd = attribute("Contoso Secret Edit", false, "always");
      const message = build(undefined, [odd, attribute("statecode", false, "always")]);
      expect(message?.alwaysSubmitColumns).toEqual(["statecode"]);
      expect(message && isPageMessage(message)).toBe(true);
    });

    it("carries no value, edit or record id with the new fields", () => {
      const message = build(() => 1, [attribute("telephone1", true, "always"), attribute("statecode", false, "always")]);
      const serialized = JSON.stringify(message);
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain(SECRET_EDIT);
      expect(serialized.toLowerCase()).not.toContain("11111111-2222-4333-8444-555555555555");
      expect(message && isPageMessage(message)).toBe(true);
    });

    it("asks the form for its type and nothing about the record", () => {
      const asked: string[] = [];
      const xrm = fakeXrm([], [name]);
      const ui = xrm.Page!.ui!;
      xrm.Page!.ui = new Proxy(ui, {
        get(target, property, receiver) {
          asked.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      });
      buildPageMessage(xrm, "x.crm.dynamics.com");
      expect(asked).toContain("getFormType");
      expect(asked.filter((property) => /^get[A-Z]/.test(property)).sort()).toEqual(["getFormType"]);
    });
  });

  it("drops a dirty column whose name the bridge would reject", () => {
    const odd = attribute("Contoso Secret Edit", true);
    const message = buildPageMessage(fakeXrm([], [odd, name]), "x.crm.dynamics.com");
    expect(message.kind === "formSnapshot" && message.dirtyColumns).toEqual(["name"]);
    expect(isPageMessage(message)).toBe(true);
  });

  it("drops a control whose name the bridge would reject instead of the whole form", () => {
    const odd = boundControl("odd-control name", attribute("telephone1"));
    const message = buildPageMessage(fakeXrm([boundControl("name", name), odd], [name]), "x.crm.dynamics.com");
    expect(message.kind === "formSnapshot" && message.columns).toEqual([{ control: "name", column: "name" }]);
    expect(isPageMessage(message)).toBe(true);
  });

  it("skips a control whose getAttribute throws", () => {
    const throwing: XrmControl = {
      getName: () => "quickview",
      getAttribute: () => {
        throw new Error("not supported");
      },
    };
    const message = buildPageMessage(fakeXrm([throwing, boundControl("name", name)], [name]), "x.crm.dynamics.com");
    expect(message.kind === "formSnapshot" && message.columns).toEqual([{ control: "name", column: "name" }]);
  });

  // The Primary Contact quick view on Account, shaped as captured live in a
  // development environment (Account main form): the quick view is
  // named contactquickform; getControl() answers an array of inner controls
  // named by their bare column (emailaddress1, telephone1), or null before the
  // quick view loads; each inner attribute's parent entity is "contact"; and
  // the field's data-id is "contactquickform.emailaddress1-FieldSectionItemContainer".
  describe("the fields inside a quick view", () => {
    const QV = "contactquickform";
    // Like the real one, the parent entity can hand out the record's id and name. Only its logical name is asked for.
    const entity = (table: string) => ({ getEntityName: () => table, getId: () => RECORD_ID, getPrimaryAttributeValue: () => SECRET_VALUE });
    const innerAttribute = (column: string, table: string | null = "contact") =>
      Object.assign(attribute(column), { getParent: () => (table === null ? null : entity(table)) });
    const inner = (column: string, table: string | null = "contact") => boundControl(column, innerAttribute(column, table), true);
    const quickView = (name: string, controls: XrmControl[] | { get(): XrmControl[] } | null): XrmQuickView & { getLabel(): string; isLoaded(): boolean } => ({
      getName: () => name,
      getControl: () => controls,
      getLabel: () => SECRET_VALUE,
      isLoaded: () => controls !== null,
    });
    const build = (quickViews: XrmQuickView[] | (() => XrmQuickView[]), controls: XrmControl[] = [boundControl("name", name)]) => {
      const xrm = fakeXrm(controls, [name]);
      (xrm.Page!.ui as { quickForms?: unknown }).quickForms = { get: typeof quickViews === "function" ? quickViews : () => quickViews };
      const message = buildPageMessage(xrm, "x.crm.dynamics.com");
      expect(isPageMessage(message)).toBe(true);
      expect(JSON.stringify(message)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(message)).not.toContain("11111111-2222");
      return message.kind === "formSnapshot" ? message : null;
    };

    it("carries each bound inner field, keyed by the quick view's name and its own, with the table its attribute belongs to", () => {
      const message = build([quickView(QV, [inner("emailaddress1"), inner("telephone1"), { getName: () => "contactsubgrid" }])]);
      expect(message?.quickViewColumns).toEqual([
        { control: `${QV}.emailaddress1`, table: "contact", column: "emailaddress1" },
        { control: `${QV}.telephone1`, table: "contact", column: "telephone1" },
      ]);
      expect(message?.columns).toEqual([{ control: "name", column: "name" }]);
    });

    it("keeps an inner field apart from the form's own control of the same name", () => {
      // Account's own telephone1 and the contact quick view's telephone1, both on one form.
      const ownPhone = attribute("telephone1");
      const message = build([quickView(QV, [inner("telephone1")])], [boundControl("name", name), boundControl("telephone1", ownPhone)]);
      expect(message?.columns).toEqual([
        { control: "name", column: "name" },
        { control: "telephone1", column: "telephone1" },
      ]);
      expect(message?.quickViewColumns).toEqual([{ control: `${QV}.telephone1`, table: "contact", column: "telephone1" }]);
    });

    it("reads the inner controls whether getControl answers a list or a collection", () => {
      const message = build([quickView(QV, { get: () => [inner("emailaddress1")] })]);
      expect(message?.quickViewColumns.map((entry) => entry.control)).toEqual([`${QV}.emailaddress1`]);
    });

    it("leaves out an inner field whose table cannot be read, since a column on the wrong table is worse than none", () => {
      const noParent = boundControl("fax", attribute("fax"), true);
      const throwing = boundControl("mobilephone", Object.assign(attribute("mobilephone"), { getParent: () => { throw new Error("not supported"); } }), true);
      const message = build([quickView(QV, [noParent, inner("telephone1", null), inner("jobtitle", "Contact Person"), throwing])]);
      expect(message?.quickViewColumns).toEqual([]);
    });

    it("carries nothing when there are no quick views, the quick view has not loaded, or it cannot be read", () => {
      expect(build([])?.quickViewColumns).toEqual([]);
      // Live: getControl() answers null until the related record is picked and the quick view loads.
      expect(build([quickView(QV, null)])?.quickViewColumns).toEqual([]);
      expect(build([quickView("odd name", [inner("emailaddress1")])])?.quickViewColumns).toEqual([]);
      const throwing = () => {
        throw new Error("not supported");
      };
      expect(build(throwing)?.quickViewColumns).toEqual([]);
      expect(build([{ getName: () => QV, getControl: throwing }])?.quickViewColumns).toEqual([]);
      const noQuickForms = buildPageMessage(fakeXrm([boundControl("name", name)], [name]), "x.crm.dynamics.com");
      expect(noQuickForms.kind === "formSnapshot" && noQuickForms.quickViewColumns).toEqual([]);
    });

    it("asks a quick view only for its name and its controls, and an inner attribute's entity only for its logical name", () => {
      const asked: string[] = [];
      const record = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(object, property, receiver) {
            asked.push(String(property));
            return Reflect.get(object, property, receiver);
          },
        });
      const watchedEntity = record(entity("contact"));
      const control = boundControl("emailaddress1", Object.assign(attribute("emailaddress1"), { getParent: () => watchedEntity }), true);
      build([record(quickView(QV, [control]))]);
      expect([...new Set(asked)].sort()).toEqual(["getControl", "getEntityName", "getName"]);
    });
  });

  describe("the form id when the user can open only one form", () => {
    const FORM = "{8448B78F-8F42-454E-8E2A-F8196B0419AF}";
    // A form item can name itself too; the snapshot asks only for its id.
    const item = (id: string) => ({ getId: () => id, getLabel: () => SECRET_VALUE });
    const withSelector = (formSelector: unknown) => {
      const xrm = fakeXrm([boundControl("name", name)], [name]);
      (xrm.Page!.ui as { formSelector?: unknown }).formSelector = formSelector;
      const message = buildPageMessage(xrm, "x.crm.dynamics.com");
      expect(isPageMessage(message)).toBe(true);
      expect(JSON.stringify(message)).not.toContain(SECRET_VALUE);
      return message.kind === "formSnapshot" ? message.formId : "no form";
    };

    it("takes the one form the selector lists when the current item is null, as Microsoft documents for a single form", () => {
      expect(withSelector({ getCurrentItem: () => null, items: { get: () => [item(FORM)] } })).toBe("8448b78f-8f42-454e-8e2a-f8196b0419af");
    });

    it("is unknown when the selector lists more than one form, none, or cannot be read", () => {
      expect(withSelector({ getCurrentItem: () => null, items: { get: () => [item(FORM), item("{11111111-0000-4000-8000-000000000000}")] } })).toBeNull();
      expect(withSelector({ getCurrentItem: () => null, items: { get: () => [] } })).toBeNull();
      expect(withSelector({ getCurrentItem: () => null })).toBeNull();
      expect(withSelector({ getCurrentItem: () => null, items: null })).toBeNull();
      const throwing = {
        getCurrentItem: () => null,
        items: {
          get: () => {
            throw new Error("not supported");
          },
        },
      };
      expect(withSelector(throwing)).toBeNull();
      expect(withSelector(null)).toBeNull();
    });

    it("prefers the current item to the list", () => {
      expect(withSelector({ getCurrentItem: () => item(FORM), items: { get: () => [item("{11111111-0000-4000-8000-000000000000}")] } })).toBe(
        "8448b78f-8f42-454e-8e2a-f8196b0419af",
      );
    });

    it("drops an id that is not a GUID instead of the whole form", () => {
      expect(withSelector({ getCurrentItem: () => item(SECRET_VALUE) })).toBeNull();
      expect(withSelector({ getCurrentItem: () => null, items: { get: () => [item(SECRET_VALUE)] } })).toBeNull();
    });

    it("asks a form item only for its id", () => {
      const asked: string[] = [];
      const spy = new Proxy(item(FORM), {
        get(target, property, receiver) {
          asked.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      });
      withSelector({ getCurrentItem: () => null, items: { get: () => [spy] } });
      expect([...new Set(asked)]).toEqual(["getId"]);
    });
  });

  it("reports no form when Xrm is missing", () => {
    expect(buildPageMessage(undefined, "x.crm.dynamics.com")).toMatchObject({ kind: "noForm", reason: "noXrm" });
  });

  it("reports no form on a grid or dashboard, where there is no entity", () => {
    const grid: XrmLike = { ...fakeXrm([], []), Page: { data: null, ui: null } };
    expect(buildPageMessage(grid, "x.crm.dynamics.com")).toMatchObject({ kind: "noForm", reason: "noFormContext" });
  });

  it("reports a missing global context separately from a missing form", () => {
    const noUtility: XrmLike = { ...fakeXrm([], []), Utility: undefined };
    expect(buildPageMessage(noUtility, "x.crm.dynamics.com")).toMatchObject({ kind: "noForm", reason: "noGlobalContext" });
  });
});
