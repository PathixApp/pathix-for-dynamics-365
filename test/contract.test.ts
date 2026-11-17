// Contract test: every response field the extension reads (the types in
// src/pathix/api.ts) exists in the Pathix API slice, contract/pathix-api.slice.json.
// When api.ts reads a new field, add it here. When this fails after the slice
// is regenerated, Pathix dropped or renamed a field the extension depends on.
//
// A field path walks the response schema: "a.b" reads property b of property
// a, and "[]" steps into an array's items.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_PATHS, sliceOpenApi } from "../scripts/slice-openapi.mjs";

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
};

interface Spec {
  paths: Record<string, { get?: { responses: Record<string, { content?: Record<string, { schema: Schema }> }> } }>;
  components: { schemas: Record<string, Schema> };
}

const slice = JSON.parse(readFileSync("contract/pathix-api.slice.json", "utf8")) as Spec;

/** The fields the save preview reads off one pipeline entry. */
function saveEntryFields(entry: string): string[] {
  return [
    "componentName",
    "componentType",
    "isSystem",
    "matchedColumns",
    "executionOrder",
    "orderUnknown",
    "tiedOrder",
    "allTables",
    "conditional",
    "rowFilterUnknown",
    "trigger.stage",
    "trigger.executionMode",
    "trigger.filteringColumns",
    "trigger.firesOnEveryUpdate",
  ].map((field) => `${entry}.${field}`);
}

const FIELDS_READ: Record<string, string[]> = {
  // Sign-in (M15): the tenant from azureAd; the extension's own client ID and read scope from extension.
  // azureAd's client ID and scope are read only to check extension against them, never to sign in.
  "/config": [
    "msalEnabled",
    "azureAd.tenantId",
    "azureAd.authority",
    "azureAd.clientId",
    "azureAd.apiScope",
    "extension.clientId",
    "extension.apiScope",
  ],
  "/environments": ["[].id", "[].name", "[].url", "[].dataverseEnvironmentId"],
  "/scans": ["[].id", "[].status", "[].startedAt", "[].completedAt"],
  "/findings/field-writers": [
    "[].componentId",
    "[].componentName",
    "[].componentType",
    "[].isSystem",
    "[].isConditional",
    "[].isHumanDriven",
    "[].confidence",
    "[].actionTypes",
    "[].sourceId",
    "[].triggers",
    "[].triggers[].message",
    "[].triggers[].stage",
    "[].triggers[].executionMode",
    "[].triggers[].table",
    "[].triggers[].filteringColumns",
    "[].triggers[].firesOnEveryUpdate",
    "[].triggers[].hasRowFilter",
  ],
  "/findings/field-dependents": [
    "results[].componentId",
    "results[].componentName",
    "results[].componentType",
    "results[].confidence",
    "results[].referenceKind",
    "results[].sourceId",
    "results[].formControls[].controlId",
    "results[].formControls[].locked",
    "results[].formControls[].hidden",
    "results[].formControls[].location",
    "results[].formControls[].embed",
    "coverageWarning",
    "platformDependentCount",
  ],
  "/findings/field-permissions": [
    "isSecured",
    "grants[].profileId",
    "grants[].profileName",
    "grants[].canUpdate",
    "grants[].userCount",
    "grants[].teamCount",
    // Per-record field sharing, and whether the scan read all of it.
    "sharePrincipalCount",
    "shareCoverageIncomplete",
  ],
  "/findings/security-writers": ["scopeBreakdown.totalPrincipals", "tableResolved", "withheldPrincipalCount"],
  "/findings/open-counts": [
    "fields[].subjectKey",
    "fields[].openCount",
    "fields[].maxOpenSeverity",
    // The admin center overlay (M14): open findings per role.
    "roles[].roleId",
    "roles[].openCount",
    "roles[].maxOpenSeverity",
    "readiness.findings.status",
    "readiness.findings.failedDetectorFindingTypes",
  ],
  "/components/{id}": [
    "registration.message",
    "registration.stage",
    "registration.executionMode",
    "registration.primaryEntity",
    "registration.triggers[].message",
    "registration.triggers[].filteringColumns",
    "registration.images[].imageType",
    "registration.images[].name",
    "registration.images[].entityAlias",
    "registration.images[].columns",
  ],
  "/changes": [
    "from",
    "to",
    "totalCount",
    "entries[].changeKind",
    "entries[].subjectKind",
    "entries[].subjectId",
    "entries[].subjectName",
    "entries[].targetColumn",
    "entries[].detectedAt",
    "entries[].scanId",
    "entries[].scanSequenceNumber",
    "entries[].subjectComponentType",
    "entries[].subjectIsSystem",
    "baselineScanNumber",
    "findingDeltaGate",
    // Every scan in the window, not just the latest.
    "windowCoverage.scanCount",
    "windowCoverage.diffNotComparedCount",
    "windowCoverage.diffNotRecordedCount",
    "windowCoverage.findingsNotComparedCount",
    "windowCoverage.findingsWithExclusionsCount",
    "windowCoverage.findingGateNotRecordedCount",
  ],
  // Rows from a Pathix update are not counted.
  "/changes/field": ["historySince", "totalCount", "entries[].scanId", "entries[].detectedAt", "entries[].pathixChange"],
  "/environments/{id}/forms/{formId}/handlers": [
    "formId",
    "formName",
    "table",
    "scope.scannedAt",
    "coverage",
    "notModeledReason",
    "ordered",
    "handlers[].event",
    "handlers[].scope",
    "handlers[].scopeName",
    "handlers[].column",
    "handlers[].function",
    "handlers[].library",
    "handlers[].isEnabled",
    "handlers[].isPlatformLoaded",
    "handlers[].ordinal",
  ],
  // The admin center overlay (M14). The parent root role and the split by kind.
  "/roles": [
    "[].id",
    "[].sourceId",
    "[].name",
    "[].assignmentCount",
    "[].parentRootRoleId",
    "[].humanAssignmentCount",
    "[].integrationAssignmentCount",
    "[].teamAssignmentCount",
    "[].platformManagedAssignmentCount",
  ],
  // The exact lookup by Application ID.
  "/principals/by-app-id": [
    "requestedAppIds",
    "scope",
    "principals[].id",
    "principals[].principalType",
    "principals[].appId",
    "principals[].isEnabled",
    "principals[].roleCount",
  ],
  "/tables/{logicalName}/save-pipeline": [
    "table",
    "message",
    "columns",
    "browseMode",
    "scope.scannedAt",
    "lanes[].lane",
    "lanes[].stage",
    "lanes[].kind",
    "lanes[].ordered",
    ...saveEntryFields("lanes[].entries[]"),
    ...saveEntryFields("unplaced[]"),
    "serverBusinessRules[].componentName",
    "serverBusinessRules[].isSystem",
    "excludedDisabled",
    // Steps on a table the platform does not name, counted and never listed.
    "unresolvedTableSteps",
    "clientLayer.coverage",
    "clientLayer.notModeledReason",
    "clientLayer.ordered",
    "clientLayer.handlers[].library",
    "clientLayer.handlers[].function",
    "clientLayer.handlers[].isEnabled",
    "clientLayer.handlers[].isPlatformLoaded",
    "disclosures",
  ],
};

function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  const target = slice.components.schemas[name];
  if (!target) throw new Error(`${schema.$ref} is not in the slice.`);
  return resolve(target);
}

/** The non-null shapes a schema can take: a nullable reference is a oneOf with a null branch. */
function variants(schema: Schema): Schema[] {
  const resolved = resolve(schema);
  const union = resolved.oneOf ?? resolved.anyOf ?? resolved.allOf;
  if (!union) return [resolved];
  return union.flatMap(variants).filter((variant) => variant.type !== "null");
}

function step(schema: Schema, segment: string): Schema | undefined {
  for (const variant of variants(schema)) {
    const next = segment === "[]" ? variant.items : variant.properties?.[segment];
    if (next) return next;
  }
  return undefined;
}

function segments(field: string): string[] {
  return field.split(".").flatMap((part) => (part.endsWith("[]") ? [part.slice(0, -2), "[]"] : [part])).filter(Boolean);
}

function hasField(root: Schema, field: string): boolean {
  let schema: Schema | undefined = root;
  for (const segment of segments(field)) {
    schema = schema && step(schema, segment);
  }
  return schema !== undefined;
}

function responseSchema(path: string): Schema {
  const schema = slice.paths[path]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`The slice has no JSON 200 response for GET ${path}.`);
  return schema;
}

describe("the Pathix API slice", () => {
  it("covers exactly the paths the extension calls", () => {
    expect(Object.keys(slice.paths).sort()).toEqual([...EXTENSION_PATHS].sort());
    expect(Object.keys(FIELDS_READ).sort()).toEqual([...EXTENSION_PATHS].sort());
  });

  it.each(Object.entries(FIELDS_READ))("declares every field the extension reads from %s", (path, fields) => {
    const root = responseSchema(path);
    expect(fields.filter((field) => !hasField(root, field))).toEqual([]);
  });

  it("catches a field the schema does not declare", () => {
    expect(hasField(responseSchema("/scans"), "[].notAField")).toBe(false);
    expect(hasField(responseSchema("/components/{id}"), "registration.notAField")).toBe(false);
  });
});

// The query parameters the extension sends must be ones the contract declares.
describe("the Pathix API slice: request parameters", () => {
  const parameters = (path: string) =>
    ((slice.paths[path]?.get as { parameters?: Array<{ name: string; in: string; required?: boolean }> } | undefined)?.parameters ?? []).map((p) => p.name);

  it.each([
    ["/changes", ["environmentId", "table", "includePathixChanges"]],
    ["/changes/field", ["environmentId", "table", "column"]],
    ["/findings/field-writers", ["environmentId", "table", "column"]],
    ["/tables/{logicalName}/save-pipeline", ["environmentId", "message", "columns", "formId"]],
    ["/findings/open-counts", ["environmentId", "fieldKey", "roleId"]],
    ["/roles", ["environmentId"]],
    ["/principals/by-app-id", ["environmentId", "appId"]],
  ])("%s declares the parameters the extension sends", (path, sent) => {
    expect(sent.filter((name) => !parameters(path).includes(name))).toEqual([]);
  });

  it("requires the table and the environment on the save pipeline, and checks the message itself (a 400 names Create and Update)", () => {
    const declared = (slice.paths["/tables/{logicalName}/save-pipeline"]?.get as unknown as { parameters: Array<{ name: string; required?: boolean }> }).parameters;
    expect(declared.filter((p) => p.required).map((p) => p.name)).toEqual(["logicalName", "environmentId"]);
  });

  it("requires only environmentId on /changes, so a table and the default window are enough", () => {
    const declared = (slice.paths["/changes"]?.get as unknown as { parameters: Array<{ name: string; required?: boolean }> }).parameters;
    expect(declared.filter((p) => p.required).map((p) => p.name)).toEqual(["environmentId"]);
  });

  // The admin center overlay (M14) repeats roleId and appId, one per id, as the cards repeat fieldKey.
  it.each([
    ["/findings/open-counts", "fieldKey"],
    ["/findings/open-counts", "roleId"],
    ["/principals/by-app-id", "appId"],
  ])("%s takes %s as a repeated parameter", (path, name) => {
    const parameter = (slice.paths[path]?.get as unknown as { parameters: Array<{ name: string; in: string; schema: Schema }> }).parameters.find((p) => p.name === name);
    expect(parameter?.in).toBe("query");
    expect(resolve(parameter!.schema).type).toBe("array");
  });

  it("serves every count the overlay sums on every role row, so a missing one is never read as zero", () => {
    const required = (slice.components.schemas["RoleSummaryResponse"] as unknown as { required: string[] }).required;
    expect(required).toEqual(
      expect.arrayContaining([
        "parentRootRoleId",
        "assignmentCount",
        "humanAssignmentCount",
        "integrationAssignmentCount",
        "teamAssignmentCount",
        "platformManagedAssignmentCount",
      ]),
    );
  });

  it("always sends extension on /config, null when Pathix has no registration, and both its values when it has one", () => {
    const config = resolve(responseSchema("/config")) as Schema & { required: string[] };
    expect(config.required).toContain("extension");
    const extension = config.properties?.extension ?? {};
    expect((extension.oneOf ?? []).some((variant) => variant.type === "null")).toBe(true);
    const registration = slice.components.schemas["ExtensionRuntimeConfig"] as unknown as { required: string[] };
    expect(registration.required).toEqual(expect.arrayContaining(["clientId", "apiScope"]));
  });

  it("names the scan behind an Application ID lookup, or null when there is none", () => {
    const lookup = slice.components.schemas["PrincipalAppIdLookupResponse"] as unknown as { required: string[]; properties: { scope: Schema } };
    expect(lookup.required).toEqual(expect.arrayContaining(["requestedAppIds", "scope", "principals"]));
    expect((lookup.properties.scope.oneOf ?? []).some((variant) => variant.type === "null")).toBe(true);
  });
});

describe("sliceOpenApi", () => {
  const spec = {
    openapi: "3.1.1",
    info: { title: "t", version: "1" },
    paths: {
      "/kept": { get: { tags: ["A"], responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Outer" } } } } } }, post: {} },
      "/dropped": { get: { tags: ["B"], responses: {} } },
    },
    components: {
      schemas: {
        Outer: { type: "object", properties: { inner: { oneOf: [{ type: "null" }, { $ref: "#/components/schemas/Inner" }] } } },
        Inner: { type: "object", properties: { leaf: { type: "array", items: { $ref: "#/components/schemas/Leaf" } } } },
        Leaf: { type: "string" },
        Unused: { type: "string" },
      },
    },
    tags: [{ name: "A" }, { name: "B" }],
  };

  it("keeps the GET on listed paths, the schemas they reach, and their tags", () => {
    const result = sliceOpenApi(spec, ["/kept"]);
    expect(Object.keys(result.paths)).toEqual(["/kept"]);
    expect(Object.keys(result.paths["/kept"] ?? {})).toEqual(["get"]);
    expect(Object.keys(result.components.schemas)).toEqual(["Inner", "Leaf", "Outer"]);
    expect(result.tags).toEqual([{ name: "A" }]);
  });

  it("fails on a path the spec does not have", () => {
    expect(() => sliceOpenApi(spec, ["/missing"])).toThrow(/no GET \/missing/);
  });
});
