// Captures real Dataverse metadata responses as scrubbed fixtures, so Lite can
// be built and tested without a Dataverse environment.
//
//   node scripts/capture-dataverse-fixtures.mjs --org https://<org>.crm.dynamics.com
//
// The token comes from the Azure CLI (`az login` first). The requests come
// from contract/dataverse/queries.json, run in order. A query's path may use
// {<earlier query name>.<field>} to reuse a GUID from an earlier answer, for
// example {whoami.UserId}; {<query>[].<field>} for every GUID in that field
// across its rows; and {<query>[<field>=<value>].<field>} for the first row
// whose field has that value.
//
// Guard rails (DESIGN.md, "Names, never values"):
// - GET only, and only to the metadata tables and functions allowlisted below.
//   A path outside the allowlist is refused before anything is sent.
// - Every response is scrubbed before it touches the disk: the org host
//   becomes contoso.crm.dynamics.com, every GUID maps to a synthetic one (one
//   map per run, so references between files still line up), user names,
//   emails and domain names are replaced, and @odata.etag is dropped.
//   A GUID written without hyphens (Dataverse names some teams
//   "<32 hex>_1") maps through the same map as its hyphenated form. The run
//   learns every hyphenated GUID first, in the order it always has, so a
//   hyphenless one never takes a number and never renumbers the rest.
//
// Read every file this writes before you commit it.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_DIR = "contract/dataverse";
export const SCRUBBED_HOST = "contoso.crm.dynamics.com";

/** Metadata entity sets a query may start from. No business tables. */
export const METADATA_ENTITY_SETS = new Set([
  "EntityDefinitions",
  "RelationshipDefinitions",
  "sdkmessageprocessingsteps",
  "sdkmessageprocessingstepimages",
  "sdkmessagefilters",
  "sdkmessages",
  "plugintypes",
  "pluginassemblies",
  "workflows",
  "systemforms",
  "savedqueries",
  "savedqueryvisualizations",
  "fieldsecurityprofiles",
  "fieldpermissions",
  "solutions",
  "publishers",
  "solutioncomponents",
  // The roles and profiles of the user's teams, and who holds one privilege.
  "teamrolescollection",
  "teamprofilescollection",
  "roleprivilegescollection",
]);

/** Sets that hold every team's or role's links: a query must filter them. */
export const FILTER_REQUIRED = new Set(["teamrolescollection", "teamprofilescollection", "roleprivilegescollection"]);

/** Unbound functions a query may call. */
export const METADATA_FUNCTIONS = new Set(["WhoAmI", "RetrieveDependentComponents", "RetrieveDependenciesForDelete"]);

/** Navigation inside a metadata path, e.g. EntityDefinitions(...)/Attributes(...). */
export const METADATA_NAVIGATIONS = new Set(["Attributes", "Keys", "OneToManyRelationships", "ManyToOneRelationships"]);

/**
 * The current user may be addressed only to call one of these: their own
 * privileges and field security profiles. A plain read of systemusers is refused.
 */
export const USER_BOUND = new Set([
  "Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames",
  "systemuserprofiles_association",
  "teammembership_association",
]);

/** Lookups a query may $expand: all point at metadata tables. */
export const EXPANDABLE = new Set(["sdkmessageid", "sdkmessagefilterid", "plugintypeid", "publisherid", "fieldsecurityprofileid"]);

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A GUID with its hyphens left out, not part of a longer hex run. An underscore may follow it, as in a team's "<32 hex>_1". */
const BARE_GUID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const NULL_GUID = "00000000-0000-0000-0000-000000000000";
// Only common top-level domains, so OData annotations such as
// value@Microsoft.Dynamics.CRM.lookuplogicalname are not taken for an address.
const TLD = "(?:com|net|org|io|co|us|uk|de|fr|nl|ca|au|in|gov|edu|info|biz|app|dev|ai|cloud)";
const EMAIL = new RegExp(`[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)+${TLD}\\b`, "gi");
const DOMAIN = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+${TLD}\\b`, "gi");
/**
 * The org's unique name, as Dataverse generates it (e.g. org1a2b3c4d). Not
 * anchored at the start: Dataverse also glues it onto other names, as in the
 * default publisher's "DefaultPublisherorg1a2b3c4d".
 */
const ORG_UNIQUE_NAME = /org[0-9a-f]{8}(?![0-9a-z])/gi;
/** Domains that name no one: Microsoft's own, XML namespaces, and the scrubbed placeholders. */
const KEPT_DOMAINS = ["microsoft.com", "w3.org", "xmlsoap.org", "odata.org", "contoso.com", "example.com", SCRUBBED_HOST];
/** Properties that hold a person's name or sign-in. Email addresses are caught by EMAIL wherever they are. */
const PERSON_KEYS = new Set(["fullname", "firstname", "lastname", "middlename", "nickname", "yomifullname", "domainname"]);
const PERSON_TABLES = new Set(["systemuser", "team"]);
const FORMATTED = "@OData.Community.Display.V1.FormattedValue";
const LOOKUP_TABLE = "@Microsoft.Dynamics.CRM.lookuplogicalname";

// --- queries ---------------------------------------------------------------------

/** Throws unless the query is well-formed and stays on the metadata allowlist. */
export function validateQuery(query) {
  if (typeof query?.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(query.name)) {
    throw new Error(`Query name ${JSON.stringify(query?.name)} must be lower-case letters, digits and dashes.`);
  }
  if (typeof query.purpose !== "string" || query.purpose.trim() === "") throw new Error(`${query.name}: purpose is required.`);
  if (typeof query.path !== "string") throw new Error(`${query.name}: path is required.`);
  if (query.keep !== undefined && (!Array.isArray(query.keep) || !query.keep.every((field) => typeof field === "string"))) {
    throw new Error(`${query.name}: keep must be a list of property names.`);
  }
  checkPath(
    query.name,
    query.path.replace(LIST_PLACEHOLDER, `'${NULL_GUID}'`).replace(ROW_PLACEHOLDER, NULL_GUID).replace(PLACEHOLDER, NULL_GUID),
  );
}

function checkPath(name, path) {
  if (/^[a-z]+:|^\/|\.\.|\$batch|\$metadata/i.test(path)) throw new Error(`${name}: ${path} must be a relative Web API path.`);
  const [resource, query = ""] = splitOnce(path, "?");
  const segments = resource.split("/").map((segment) => splitOnce(segment, "(")[0]);
  const [first, ...rest] = segments;

  if (first === "systemusers") {
    if (rest.length !== 1 || !USER_BOUND.has(rest[0])) {
      throw new Error(`${name}: systemusers may only be addressed to call ${[...USER_BOUND].join(" or ")}.`);
    }
  } else if (METADATA_FUNCTIONS.has(first)) {
    if (rest.length > 0) throw new Error(`${name}: ${first} takes no further path.`);
  } else if (METADATA_ENTITY_SETS.has(first)) {
    const outside = rest.find((segment) => !METADATA_NAVIGATIONS.has(segment));
    if (outside) throw new Error(`${name}: ${outside} is not an allowlisted metadata navigation.`);
    if (!/(^|&)\$select=/.test(query)) throw new Error(`${name}: an entity set query needs $select.`);
    if (FILTER_REQUIRED.has(first) && !/(^|&)\$filter=/.test(query)) throw new Error(`${name}: ${first} needs a $filter.`);
  } else {
    throw new Error(`${name}: ${first} is not an allowlisted metadata table or function.`);
  }

  const expand = queryOption(query, "$expand");
  if (expand !== null) checkExpand(name, expand);
}

function checkExpand(name, expand) {
  for (const item of splitTopLevel(expand)) {
    const [navigation, options = ""] = splitOnce(item, "(");
    if (!EXPANDABLE.has(navigation)) throw new Error(`${name}: $expand=${navigation} is not an allowlisted lookup.`);
    const inner = options.replace(/\)$/, "");
    if (!/(^|;)\$select=/.test(inner)) throw new Error(`${name}: $expand=${navigation} needs its own $select.`);
    const nested = queryOption(inner.replaceAll(";", "&"), "$expand");
    if (nested !== null) checkExpand(name, nested);
  }
}

function queryOption(query, option) {
  for (const part of splitTopLevel(query, "&")) {
    const [key, value] = splitOnce(part, "=");
    if (key === option) return value ?? "";
  }
  return null;
}

function splitTopLevel(text, separator = ",") {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return index === -1 ? [text] : [text.slice(0, index), text.slice(index + 1)];
}

const PLACEHOLDER = /\{([a-z0-9-]+)\.([A-Za-z_]+)\}/g;
const LIST_PLACEHOLDER = /\{([a-z0-9-]+)\[\]\.([A-Za-z_]+)\}/g;
const ROW_PLACEHOLDER = /\{([a-z0-9-]+)(?:\.([A-Za-z]+))?\[([A-Za-z_]+)=([A-Za-z0-9_-]+)\]\.([A-Za-z_]+)\}/g;

/**
 * Fills placeholders from earlier raw answers. Only GUIDs are substituted.
 * - {<query>.<field>}: one GUID from a single-object answer.
 * - {<query>[].<field>}: every distinct GUID in that field across the answer's
 *   rows, quoted and comma-separated, for an In(...) filter.
 * - {<query>[<match>=<value>].<field>}: one GUID from the first row whose
 *   <match> field equals <value>, e.g. the first dependency of one type. Rows
 *   are the answer's "value" list, or the list named in
 *   {<query>.<list>[<match>=<value>].<field>}, e.g. a table's Privileges.
 */
export function fillPlaceholders(path, answers) {
  return path
    .replace(ROW_PLACEHOLDER, (placeholder, query, list, match, expected, field) => {
      const rows = answers.get(query)?.[list ?? "value"];
      const row = Array.isArray(rows) ? rows.find((candidate) => String(candidate?.[match]) === expected) : undefined;
      const value = row?.[field];
      if (!isGuid(value)) throw new Error(`${placeholder}: no row of ${query} with ${match}=${expected} and a GUID ${field}.`);
      return value;
    })
    .replace(LIST_PLACEHOLDER, (placeholder, query, field) => {
      const values = distinctValues(answers.get(query)?.value, field);
      if (values.length === 0 || !values.every(isGuid)) throw new Error(`${placeholder}: no GUIDs in ${field} across the rows of ${query}.`);
      return values.map((value) => `'${value}'`).join(",");
    })
    .replace(PLACEHOLDER, (placeholder, query, field) => {
      const value = answers.get(query)?.[field];
      if (!isGuid(value)) throw new Error(`${placeholder}: no GUID ${field} in the answer to ${query}.`);
      return value;
    });
}

function distinctValues(rows, field) {
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.map((row) => row?.[field]).filter((value) => value != null))].sort();
}

function isGuid(value) {
  return typeof value === "string" && new RegExp(`^${GUID.source}$`, "i").test(value);
}

/** Keeps only the listed properties on each row, for answers that ignore $select. */
export function keepFields(answer, fields) {
  if (!fields || !Array.isArray(answer?.value)) return answer;
  const value = answer.value.map((row) => Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]])));
  return { ...answer, value };
}

// --- scrubbing --------------------------------------------------------------------

/**
 * One scrubber per run: the same real GUID, user or domain maps to the same
 * synthetic value in every file.
 *
 * `learn` walks an answer the way `scrub` does and fills the maps, writing
 * nothing. A run learns every answer first, then scrubs them, so a GUID
 * written without hyphens finds its hyphenated form wherever in the run that
 * appears. Hyphenless GUIDs never take a number in the main map: one whose
 * hyphenated form the run never saw gets a number of its own, in a separate
 * range (5c4a0000-0000-4000-8001-...), so it cannot renumber anything else.
 */
export function createScrubber(orgHost) {
  const host = orgHost.toLowerCase();
  const orgLabel = host.split(".")[0] ?? "";
  // A short label ("crm", "org") would also hit unrelated words, so only a
  // distinctive one is replaced on its own.
  const orgLabelPattern = orgLabel.length >= 5 ? new RegExp(`\\b${escapeRegExp(orgLabel)}\\b`, "gi") : /$^/;
  const guids = new Map();
  const bareGuids = new Map();
  const people = new Map();
  const emails = new Map();
  const domains = new Map();

  const synthetic = (map, key, make) => {
    if (!map.has(key)) map.set(key, make(map.size + 1));
    return map.get(key);
  };

  const person = (name) => synthetic(people, name, (n) => `User ${n}`);

  const syntheticGuid = (guid) => {
    if (guid === NULL_GUID) return guid;
    const mapped = synthetic(guids, guid.toLowerCase(), (n) => `5c4a0000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    return /[A-F]/.test(guid) ? mapped.toUpperCase() : mapped;
  };

  // In the learning pass, a bare GUID is left alone: only the scrubbing pass,
  // with every hyphenated GUID known, maps it.
  const syntheticBareGuid = (bare, learning) => {
    if (learning) return bare;
    const hyphenated = `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`.toLowerCase();
    if (hyphenated === NULL_GUID) return bare;
    const mapped = guids.get(hyphenated) ?? synthetic(bareGuids, hyphenated, (n) => `5c4a0000-0000-4000-8001-${String(n).padStart(12, "0")}`);
    const flat = mapped.replaceAll("-", "");
    return /[A-F]/.test(bare) ? flat.toUpperCase() : flat;
  };

  function scrubText(text, learning) {
    return text
      .replace(new RegExp(escapeRegExp(host), "gi"), SCRUBBED_HOST)
      .replace(EMAIL, (email) => synthetic(emails, email.toLowerCase(), (n) => `user${n}@contoso.com`))
      .replace(DOMAIN, (domain) => {
        const lower = domain.toLowerCase();
        if (KEPT_DOMAINS.some((kept) => lower === kept || lower.endsWith(`.${kept}`))) return domain;
        return synthetic(domains, lower, (n) => `domain${n}.example.com`);
      })
      .replace(orgLabelPattern, "contoso")
      .replace(ORG_UNIQUE_NAME, "contoso")
      .replace(GUID, syntheticGuid)
      .replace(BARE_GUID, (bare) => syntheticBareGuid(bare, learning));
  }

  function scrubNode(node, learning) {
    if (Array.isArray(node)) return node.map((item) => scrubNode(item, learning));
    if (node === null || typeof node !== "object") return typeof node === "string" ? scrubText(node, learning) : node;

    const result = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "@odata.etag" || key === "@odata.nextLink") continue;
      result[key] = isPersonValue(node, key, value) ? person(value) : scrubNode(value, learning);
    }
    return result;
  }

  return {
    learn: (node) => void scrubNode(node, true),
    scrub: (node) => scrubNode(node, false),
  };
}

function isPersonValue(node, key, value) {
  if (typeof value !== "string") return false;
  if (PERSON_KEYS.has(key.toLowerCase())) return true;
  if (!key.endsWith(FORMATTED)) return false;
  const lookup = key.slice(0, -FORMATTED.length);
  return PERSON_TABLES.has(node[`${lookup}${LOOKUP_TABLE}`]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrubs one run's answers, in query order, as the files to write: every
 * answer is learned first, then scrubbed, so the numbering is the same with
 * or without hyphenless GUIDs in the run.
 */
export function scrubRun(orgHost, answers) {
  const scrubber = createScrubber(orgHost);
  for (const [, answer] of answers) scrubber.learn(answer);
  return answers.map(([name, answer]) => [name, `${JSON.stringify(scrubber.scrub(answer), null, 2)}\n`]);
}

// --- running -----------------------------------------------------------------------

export function parseOrg(argv) {
  const index = argv.indexOf("--org");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error("Usage: node scripts/capture-dataverse-fixtures.mjs --org https://<org>.crm.dynamics.com");
  const url = new URL(value);
  if (url.protocol !== "https:" || !/\.dynamics\.com$/i.test(url.hostname)) {
    throw new Error("--org must be an https://<org>.crm*.dynamics.com address.");
  }
  return url.origin;
}

function accessToken(org) {
  return execFileSync("az", ["account", "get-access-token", "--resource", org, "--query", "accessToken", "--output", "tsv"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function get(org, token, path) {
  const response = await fetch(new URL(`/api/data/v9.2/${path}`, org), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Prefer: "odata.maxpagesize=500",
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function main(argv) {
  const org = parseOrg(argv);
  const queries = JSON.parse(await readFile(join(FIXTURE_DIR, "queries.json"), "utf8"));
  queries.forEach(validateQuery);

  const token = accessToken(org);
  const answers = new Map();
  const kept = [];
  const failures = [];

  for (const query of queries) {
    try {
      const path = fillPlaceholders(query.path, answers);
      checkPath(query.name, path);
      const answer = await get(org, token, path);
      answers.set(query.name, answer);
      if (answer["@odata.nextLink"]) console.warn(`${query.name}: more than one page; only the first is kept.`);
      kept.push([query.name, keepFields(answer, query.keep)]);
    } catch (error) {
      failures.push(query.name);
      console.error(`${query.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await mkdir(FIXTURE_DIR, { recursive: true });
  for (const [name, file] of scrubRun(new URL(org).hostname, kept)) {
    await writeFile(join(FIXTURE_DIR, `${name}.json`), file);
    console.log(`${name}: written`);
  }

  if (failures.length > 0) {
    console.error(`${failures.length} of ${queries.length} queries failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`Done. Read every file in ${FIXTURE_DIR} before you commit it.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
