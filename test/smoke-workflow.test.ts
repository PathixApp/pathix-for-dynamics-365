// Holds the smoke workflow (M4) to the project's CI rules (M0):
// actions pinned to commit SHAs, a read-only token, no secrets. Line-based on
// purpose, like test/ci-workflow.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const smoke = readFileSync(".github/workflows/smoke.yml", "utf8");

describe("smoke.yml", () => {
  it("runs on pull requests and on pushes to main", () => {
    expect(smoke).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
  });

  it("grants the token read access to contents, once, at the top", () => {
    expect(smoke).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(smoke.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it("uses no secrets and leaves no checkout token on disk", () => {
    expect(smoke).not.toMatch(/secrets\./);
    expect(smoke).toMatch(/persist-credentials: false/);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...smoke.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it("builds, installs Playwright's Chromium, then runs the smoke test", () => {
    const runs = [...smoke.matchAll(/^\s*- run: (.+)$/gm)].map((match) => match[1]);
    expect(runs).toEqual(["npm ci", "npm run build", "npx playwright install --with-deps chromium", "npm run smoke"]);
  });
});

describe("the Playwright dependency", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies: Record<string, string>; dependencies?: unknown };

  it("is the only one M4 adds, as a pinned dev dependency (maintainer approval, 2026-10-04)", () => {
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@playwright/test", "@types/chrome", "@types/node", "esbuild", "typescript", "vitest"]);
    expect(pkg.devDependencies["@playwright/test"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies).toBeUndefined();
  });
});
