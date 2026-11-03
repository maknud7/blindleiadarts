import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: ["legacy-admin.spec.mjs", "legacy-admin-isolation.spec.mjs"],
  timeout: 30000,
  expect: { timeout: 8000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "../../test-results/admin-legacy-report", open: "never" }]],
  outputDir: "../../test-results/admin-legacy-artifacts",
  use: { ...devices["Desktop Chrome"], headless: true, actionTimeout: 6500, navigationTimeout: 12000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    cwd: repositoryRoot,
    command: "node tests/admin-equipment-browser/static-server.mjs",
    url: "http://127.0.0.1:4186/",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
