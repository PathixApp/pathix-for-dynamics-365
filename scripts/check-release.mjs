// Checks a release zip before it is published.
//
//   node scripts/check-release.mjs pathix-extension-1.2.3.zip v1.2.3
//
// Reads manifest.json from the root of the zip (so it fails if the manifest is
// not at the root, where the stores and Load unpacked expect it) and fails
// unless it carries the version the tag names, no `key`, no "prototype" or
// "not for distribution" in its name or description, a 128 px icon that is in
// the zip, and LICENSE and NOTICE at the zip's root.
// The release workflow (.github/workflows/release.yml) runs it.
import { execFileSync } from "node:child_process";
import { checkReleaseManifest, versionFromTag } from "./manifest.mjs";

const [zip, tag] = process.argv.slice(2);
if (!zip || !tag) throw new Error("Usage: node scripts/check-release.mjs <zip> <tag>");

const version = versionFromTag(tag);
const text = execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
// -Z1: zipinfo mode, one path per line.
const files = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
checkReleaseManifest(JSON.parse(text), version, files);
console.log(`${zip}: manifest.json at the root, version ${version}, no key, store copy, a 128 px icon, LICENSE and NOTICE`);
