// The Playwright smoke test (M4): the unpacked build in Chromium against a
// fake model-driven page. Run `npm run build` first, then `npm run smoke`.
// Unit tests stay in vitest (npm test); this only checks the extension loads
// and draws on a page.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "smoke",
  testMatch: "*.smoke.ts",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
});
