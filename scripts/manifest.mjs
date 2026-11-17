// Builds the manifest that goes into dist/.
//
// manifest.json carries no `key`. A developer whose sign-in depends on a fixed
// extension ID (the Entra redirect URI is https://<extension-id>.chromiumapp.org/)
// keeps the key in an untracked manifest.key.local.json, shaped { "key": "..." },
// and the build adds it. Without that file the build has no key, and the
// browser derives the ID from the folder the extension is loaded from.
//
// A release build (node build.mjs --release v1.2.3) takes its version from the
// tag and never carries a key: it refuses to run while a local key file exists.
import { access, readFile } from "node:fs/promises";

export const KEY_FILE = "manifest.key.local.json";

/**
 * Whether a value is a valid Chrome manifest `version`: one to four
 * dot-separated integers, each 0 to 65535, with no leading zeros.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isManifestVersion(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length > 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535);
}

/**
 * The manifest version a release tag names: "v1.2.3" gives "1.2.3". Throws on anything else.
 * @param {string} tag
 * @returns {string}
 */
export function versionFromTag(tag) {
  const match = /^v(.*)$/.exec(String(tag));
  if (!match) throw new Error(`Release tag "${tag}" must start with "v", for example v1.2.3.`);
  const version = match[1] ?? "";
  if (!isManifestVersion(version)) {
    throw new Error(
      `Release tag "${tag}" does not name a valid extension version. ` +
        "Use one to four numbers separated by dots, each 0 to 65535, with no leading zeros, for example v1.2.3. " +
        "Browsers do not accept suffixes such as -beta.",
    );
  }
  return version;
}

/**
 * The manifest for dist/. With `version`, this is a release build: the version
 * replaces the one in manifest.json, and a local key file is refused, not added.
 * @param {string} [manifestPath]
 * @param {string} [keyPath]
 * @param {{ version?: string }} [options]
 */
export async function buildManifest(manifestPath = "manifest.json", keyPath = KEY_FILE, { version } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if ("key" in manifest) throw new Error(`${manifestPath} must not carry a key. Put it in ${KEY_FILE}.`);

  if (version !== undefined) {
    if (!isManifestVersion(version)) throw new Error(`"${version}" is not a valid extension version.`);
    if (await exists(keyPath)) throw new Error(`A release build never carries a key. Move ${keyPath} aside to build a release.`);
    return { ...manifest, version };
  }

  const key = await readLocalKey(keyPath);
  return key === null ? manifest : { ...manifest, key };
}

/** Words that mark a build as not for the stores. Matched without regard to case. */
const UNSHIPPABLE = [/prototype/i, /not for distribution/i];

/** The license and notice files every copy carries at the package root (Apache 2.0, section 4). */
export const LICENSE_FILES = ["LICENSE", "NOTICE"];

/**
 * Throws unless a packaged manifest is fit to release as `version`: it has that
 * version and no key, its name and description do not say it is a prototype
 * or not for distribution, it names a 128 px icon that is in the package,
 * and the package carries LICENSE and NOTICE at its root.
 * @param {unknown} manifest
 * @param {string} version
 * @param {readonly string[]} files every path in the package, as the zip lists them
 */
export function checkReleaseManifest(manifest, version, files) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The packaged manifest is not a JSON object.");
  }
  if ("key" in manifest) throw new Error("The packaged manifest carries a key. A release must not.");
  const { version: packaged, name, description, icons } = /** @type {{ version?: unknown, name?: unknown, description?: unknown, icons?: unknown }} */ (manifest);
  if (packaged !== version) throw new Error(`The packaged manifest has version "${packaged}", but the tag names "${version}".`);
  for (const [field, text] of [["name", name], ["description", description]]) {
    if (typeof text === "string" && UNSHIPPABLE.some((pattern) => pattern.test(text))) {
      throw new Error(`The packaged manifest's ${field} says it is a prototype or not for distribution: "${text}". Write the store copy first.`);
    }
  }
  const icon = icons !== null && typeof icons === "object" ? /** @type {Record<string, unknown>} */ (icons)["128"] : undefined;
  if (typeof icon !== "string" || icon === "") {
    throw new Error('The packaged manifest has no icons["128"]. The Chrome Web Store and Edge Add-ons need a 128 px icon.');
  }
  const iconPath = icon.replace(/^\.?\//, "");
  if (!files.includes(iconPath)) {
    throw new Error(`The packaged manifest's icons["128"] is "${icon}", but the package has no such file. The stores need a 128 px icon.`);
  }
  for (const file of LICENSE_FILES) {
    if (!files.includes(file)) {
      throw new Error(`The package has no ${file} at its root. Every copy must carry LICENSE and NOTICE.`);
    }
  }
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false;
    throw error;
  }
}

async function readLocalKey(keyPath) {
  let text;
  try {
    text = await readFile(keyPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const { key } = JSON.parse(text);
  if (typeof key !== "string" || key.length === 0) throw new Error(`${keyPath} must be { "key": "<base64 public key>" }.`);
  return key;
}
