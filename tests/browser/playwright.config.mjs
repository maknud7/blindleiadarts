import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["*.spec.mjs"],
  timeout: 65000,
  expect: { timeout: 22000 },
  retries: 1,
  workers: 2,
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../test-results/browser-report", open: "never" }],
  ],
  outputDir: "../../test-results/browser-artifacts",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 16000,
    navigationTimeout: 30000,
  },
});
