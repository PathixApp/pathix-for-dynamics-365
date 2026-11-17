import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Holds the project's workflow rules (M0, M5): actions pinned to
// commit SHAs, a read-only token at the top, no secrets, and write access only
// on the job that publishes a release. That job builds nothing: a read-only
// job builds and checks the zip, and releases come only from main, as drafts. Line-based on purpose: no YAML parser
// dependency for a handful of checks.

const dir = join(".github", "workflows");
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
const ci = readFileSync(join(dir, "ci.yml"), "utf8");
const release = readFileSync(join(dir, "release.yml"), "utf8");

/** The value of every `uses:` key in a workflow. */
function usesOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1] ?? "");
}

/** The single-line value of every `run:` key in a workflow, in order. A block scalar shows as "|". */
function runsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)].map((match) => match[1] ?? "");
}

/** The full text of every `run:` script in a workflow, block scalars included. */
function runScriptsOf(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const scripts: string[] = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) return;
    const indent = (match[1] ?? "").length;
    const body = [match[2] ?? ""];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push(body.join("\n"));
  });
  return scripts;
}

/**
 * The content of the `key:` block at exactly `indent` spaces, without the key
 * itself and without comments: the inline value as one entry, or the more
 * deeply indented lines below it.
 */
function blockOf(lines: string[], key: string, indent: number): string[] | undefined {
  const pad = " ".repeat(indent);
  const start = lines.findIndex((line) => line.startsWith(`${pad}${key}:`));
  if (start < 0) return undefined;
  const inline = lines[start]?.slice(indent + key.length + 1).replace(/#.*$/, "").trim();
  if (inline) return [inline];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (line.length - line.trimStart().length <= indent) break;
    const content = line.replace(/#.*$/, "").trim();
    if (content) block.push(content);
  }
  return block;
}

/** The lines of the top-level `permissions:` block, without the key itself. */
function topLevelPermissions(source: string): string[] | undefined {
  return blockOf(source.split("\n"), "permissions", 0);
}

/** Each job under `jobs:`, by name, as its own lines. */
function jobsOf(source: string): Map<string, string[]> {
  const lines = source.split("\n");
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([\w-]+):\s*$/.exec(line);
    if (header) jobs.set(header[1] ?? "", (current = []));
    else current?.push(line);
  }
  return jobs;
}

/** A job's own `permissions:` block. Job lines keep their indent, so job keys sit at 4 spaces. */
function jobPermissions(job: string[]): string[] | undefined {
  return blockOf(job, "permissions", 4);
}

describe("every workflow", () => {
  it("exists", () => {
    expect(workflows).toContain("ci.yml");
    expect(workflows).toContain("release.yml");
  });

  it.each(workflows)("%s pins every action to a full commit SHA", (name) => {
    const uses = usesOf(readFileSync(join(dir, name), "utf8"));
    for (const ref of uses.filter((value) => !value.startsWith("./"))) {
      expect(ref, `${name}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it.each(workflows)("%s grants the token read access to contents at the top, and nothing else", (name) => {
    expect(topLevelPermissions(readFileSync(join(dir, name), "utf8"))).toEqual(["contents: read"]);
  });

  it.each(workflows)("%s references no secrets", (name) => {
    const source = readFileSync(join(dir, name), "utf8");
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/secrets\[/);
  });

  // A ${{ }} expression inside a script is pasted into the shell before it runs,
  // so a crafted tag or branch name becomes code. Values reach scripts through env:.
  it.each(workflows)("%s interpolates no ${{ }} expression into a run: script", (name) => {
    const source = readFileSync(join(dir, name), "utf8");
    const scripts = runScriptsOf(source);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script, `${name}: ${script}`).not.toContain("${{");
  });

  it("the run: script reader sees inside block scalars", () => {
    const sample = ["    steps:", "      - name: x", "        run: |", "          echo one", "          echo ${{ github.ref_name }}", "      - run: echo two"].join("\n");
    expect(runScriptsOf(sample).some((script) => script.includes("${{"))).toBe(true);
    expect(runScriptsOf(sample)).toHaveLength(2);
  });

  it.each(workflows)("%s does not leave the checkout token on disk", (name) => {
    const source = readFileSync(join(dir, name), "utf8");
    const checkouts = source.match(/uses: actions\/checkout@/g) ?? [];
    expect(source.match(/persist-credentials: false/g) ?? []).toHaveLength(checkouts.length);
  });

  it.each(workflows)("%s grants write access only to the release job", (name) => {
    const source = readFileSync(join(dir, name), "utf8");
    for (const [job, lines] of jobsOf(source)) {
      const permissions = jobPermissions(lines) ?? [];
      const writes = permissions.filter((line) => /write/.test(line));
      if (name === "release.yml" && job === "release") expect(writes).toEqual(["contents: write"]);
      else expect(writes, `${name}: ${job}`).toEqual([]);
    }
  });
});

describe("ci.yml", () => {
  it("runs on pull requests and on pushes to main", () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
  });

  it("sets permissions only at the top", () => {
    expect(ci.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it("installs, typechecks, tests and builds", () => {
    expect(runsOf(ci)).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run build"]);
  });

  it("the helpers would catch an unpinned action and broad permissions", () => {
    expect(usesOf("      - uses: actions/checkout@v6\n")).toEqual(["actions/checkout@v6"]);
    expect("actions/checkout@v6").not.toMatch(/@[0-9a-f]{40}$/);
    expect(topLevelPermissions("name: x\npermissions: write-all\njobs:\n")).toEqual(["write-all"]);
    const jobs = jobsOf("jobs:\n  a:\n    permissions:\n      contents: write\n      issues: write\n    steps: []\n  b:\n    runs-on: x\n");
    expect([...jobs.keys()]).toEqual(["a", "b"]);
    expect(jobPermissions(jobs.get("a") ?? [])).toEqual(["contents: write", "issues: write"]);
    expect(jobPermissions(jobs.get("b") ?? [])).toBeUndefined();
  });
});

describe("release.yml", () => {
  const jobs = jobsOf(release);
  const build = (jobs.get("build") ?? []).join("\n");
  const publish = (jobs.get("release") ?? []).join("\n");

  it("runs only when a v* tag is pushed", () => {
    expect(blockOf(release.split("\n"), "on", 0)).toEqual(["push:", "tags: ['v*']"]);
  });

  it("has a build job, a release job and a store placeholder, and nothing else", () => {
    expect([...jobs.keys()]).toEqual(["build", "release", "publish-stores"]);
  });

  describe("the build job", () => {
    it("keeps the read-only token: no permissions of its own", () => {
      expect(jobPermissions(jobs.get("build") ?? [])).toBeUndefined();
    });

    it("fetches the whole history and fails unless the tagged commit is on main, before anything else runs", () => {
      expect(build).toMatch(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials: false\n\s+fetch-depth: 0\n/);
      const runs = runsOf(build);
      expect(runs[0]).toBe("|");
      expect(build).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main \|\| \{\n[^}]*exit 1\n/);
      expect(build.indexOf("merge-base")).toBeLessThan(build.indexOf("npm ci"));
    });

    it("checks, builds with the tag's version, zips and checks the zip", () => {
      expect(runsOf(build)).toEqual([
        "|",
        "|",
        "npm ci",
        "npm run typecheck",
        "npm test",
        'node build.mjs --release "$GITHUB_REF_NAME"',
        "|",
        'node scripts/check-release.mjs "pathix-extension-$VERSION.zip" "$GITHUB_REF_NAME"',
      ]);
      expect(build).toMatch(/versionFromTag\(process\.env\.GITHUB_REF_NAME\)/);
      expect(build).toMatch(/cd dist\n\s+zip -r -X "\.\.\/pathix-extension-\$VERSION\.zip" \.\n/);
    });

    it("uploads the checked zip as an artifact and publishes nothing", () => {
      expect(usesOf(build).map((ref) => ref.split("@")[0])).toEqual(["actions/checkout", "actions/setup-node", "actions/upload-artifact"]);
      expect(build).toMatch(/upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: release-zip\n\s+path: pathix-extension-\$\{\{ steps\.version\.outputs\.version \}\}\.zip\n\s+if-no-files-found: error\n/);
      expect(build).not.toMatch(/gh release|GH_TOKEN|github\.token/);
    });
  });

  describe("the release job", () => {
    it("waits for the build", () => {
      expect(blockOf(jobs.get("release") ?? [], "needs", 4)).toEqual(["build"]);
    });

    it("downloads the zip, checks it again and creates a draft release, installing nothing", () => {
      expect(usesOf(publish).map((ref) => ref.split("@")[0])).toEqual(["actions/checkout", "actions/setup-node", "actions/download-artifact"]);
      expect(publish).toMatch(/download-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: release-zip\n/);
      expect(runsOf(publish)).toEqual([
        'node scripts/check-release.mjs "pathix-extension-$VERSION.zip" "$GITHUB_REF_NAME"',
        expect.stringMatching(/^gh release create "\$GITHUB_REF_NAME" "pathix-extension-\$VERSION\.zip" --draft --verify-tag /),
      ]);
      expect(publish).not.toMatch(/npm|build\.mjs/);
    });

    it("gives the release step the workflow's own token and nothing else", () => {
      expect(publish.match(/\$\{\{[^}]*\}\}/g)).toEqual([
        "${{ needs.build.outputs.version }}",
        "${{ needs.build.outputs.version }}",
        "${{ github.token }}",
        "${{ github.repository }}",
      ]);
    });
  });

  it("hands the version from the build job to the release job", () => {
    expect(blockOf(jobs.get("build") ?? [], "outputs", 4)).toEqual(["version: ${{ steps.version.outputs.version }}"]);
  });

  it("installs without the npm cache", () => {
    expect(release).not.toMatch(/^\s*cache:/m);
  });

  it("keeps store publishing switched off, behind the protected release environment", () => {
    const placeholder = jobs.get("publish-stores") ?? [];
    expect(blockOf(placeholder, "if", 4)).toEqual(["false"]);
    expect(blockOf(placeholder, "environment", 4)).toEqual(["release"]);
    expect(blockOf(placeholder, "needs", 4)).toEqual(["release"]);
    expect(jobPermissions(placeholder)).toEqual(["contents: read"]);
    expect(usesOf(placeholder.join("\n"))).toEqual([]);
  });
});

describe("the manifest name", () => {
  // M15 dropped "(prototype)"; checkReleaseManifest now refuses a release that says it.
  it("is the store name, with no (prototype)", () => {
    expect(JSON.parse(readFileSync("manifest.json", "utf8")).name).toBe("Pathix for Dynamics 365");
  });
});
