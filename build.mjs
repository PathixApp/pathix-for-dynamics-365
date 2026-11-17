// Bundles each extension entry point into one self-contained IIFE file.
// MV3 content scripts cannot be ES modules, which is why this is esbuild
// rather than Vite.
//
//   node build.mjs                   one build into dist/
//   node build.mjs --watch           rebuild on change; reload the extension by hand
//   node build.mjs --release v1.2.3  a release build: version from the tag, never a key
import * as esbuild from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { buildManifest, KEY_FILE, LICENSE_FILES, versionFromTag } from "./scripts/manifest.mjs";

const outdir = "dist";
const watch = process.argv.includes("--watch");
const releaseAt = process.argv.indexOf("--release");
const release = releaseAt >= 0 ? versionFromTag(process.argv[releaseAt + 1]) : undefined;
if (release !== undefined && watch) throw new Error("--release and --watch do not go together.");

const options = {
  entryPoints: {
    page: "src/page/main-world.ts",
    content: "src/content/content.ts",
    background: "src/background/service-worker.ts",
    admin: "src/admin/admin.ts",
    options: "src/options/options.ts",
    popup: "src/popup/popup.ts",
    demo: "src/demo/demo.ts",
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome113",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const manifest = await buildManifest("manifest.json", KEY_FILE, { version: release });
if (release !== undefined) console.log(`manifest: release ${release}, no key`);
else console.log(manifest.key ? `manifest: key added from ${KEY_FILE}` : "manifest: no key (the browser picks the extension ID)");
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await cp("static", outdir, { recursive: true });
// The license and the notice, with its third-party section, ship in every copy.
for (const file of LICENSE_FILES) await cp(file, `${outdir}/${file}`);

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
