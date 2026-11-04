import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/player-attendance-browser",
  timeout: 25000,
  expect: { timeout: 10000 },
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["html", { outputFolder: "artifacts/player-attendance-browser-report", open: "never" }]],
  outputDir: "artifacts/player-attendance-browser-results",
  retries: 0,
  workers: 2,
});
