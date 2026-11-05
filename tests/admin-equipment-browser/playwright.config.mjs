import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: ["equipment.spec.mjs", "operations.spec.mjs"],
  timeout: 45000,
  expect: { timeout: 16000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "../../test-results/admin-equipment-report", open: "never" }]],
  outputDir: "../../test-results/admin-equipment-artifacts",
  use: { ...devices["Desktop Chrome"], headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    cwd: repositoryRoot,
    command: "npx vite --config apps/platform-v2/vite.config.mjs --host 127.0.0.1 --port 4185 --strictPort",
    url: "http://127.0.0.1:4185/v2/equipment/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
