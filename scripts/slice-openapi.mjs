// Cuts the Pathix OpenAPI spec down to what the extension calls: the GET
// operations on the paths below, the schemas they reference (transitively),
// and the tags they use. The extension only reads, so other methods on the
// same paths are left out.
//
//   node scripts/slice-openapi.mjs <full-openapi.json> <output.json>
//
// When the extension starts calling a new path, add it here, regenerate the
// slice, and extend test/contract.test.ts.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const EXTENSION_PATHS = [
  "/config",
  "/environments",
  "/scans",
  "/findings/field-writers",
  "/findings/field-dependents",
  "/findings/field-permissions",
  "/findings/security-writers",
  "/findings/open-counts",
  "/components/{id}",
  "/changes",
  "/changes/field",
  "/environments/{id}/forms/{formId}/handlers",
  "/roles",
  "/principals/by-app-id",
  "/tables/{logicalName}/save-pipeline",
];

const SCHEMA_REF = "#/components/schemas/";

export function sliceOpenApi(spec, paths = EXTENSION_PATHS) {
  /** @type {Record<string, { get: any }>} */
  const slicedPaths = {};
  for (const path of paths) {
    const operation = spec.paths?.[path]?.get;
    if (!operation) throw new Error(`The spec has no GET ${path}.`);
    slicedPaths[path] = { get: operation };
  }

  const schemas = spec.components?.schemas ?? {};
  const kept = referencedSchemas(slicedPaths, schemas);
  const usedTags = new Set(Object.values(slicedPaths).flatMap((item) => item.get.tags ?? []));

  return {
    openapi: spec.openapi,
    info: spec.info,
    servers: spec.servers,
    paths: slicedPaths,
    components: { schemas: Object.fromEntries([...kept].sort().map((name) => [name, schemas[name]])) },
    tags: spec.tags?.filter((tag) => usedTags.has(tag.name)),
  };
}

function referencedSchemas(root, schemas) {
  const kept = new Set();
  const queue = [root];
  while (queue.length > 0) {
    for (const ref of refsIn(queue.pop())) {
      if (!ref.startsWith(SCHEMA_REF)) throw new Error(`Unsupported $ref ${ref}: only component schemas are followed.`);
      const name = ref.slice(SCHEMA_REF.length);
      if (kept.has(name)) continue;
      if (!(name in schemas)) throw new Error(`$ref ${ref} points at a schema the spec does not define.`);
      kept.add(name);
      queue.push(schemas[name]);
    }
  }
  return kept;
}

function refsIn(node) {
  if (Array.isArray(node)) return node.flatMap(refsIn);
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : refsIn(value),
  );
}

async function main([input, output]) {
  if (!input || !output) {
    console.error("Usage: node scripts/slice-openapi.mjs <full-openapi.json> <output.json>");
    process.exit(2);
  }
  const slice = sliceOpenApi(JSON.parse(await readFile(input, "utf8")));
  await writeFile(output, `${JSON.stringify(slice, null, 2)}\n`);
  console.log(`${output}: ${Object.keys(slice.paths).length} paths, ${Object.keys(slice.components.schemas).length} schemas.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv.slice(2));
