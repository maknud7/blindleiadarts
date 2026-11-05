import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: ".",
  // Run the real checkout/next-match lifecycle in the same PR gate as viewport QA.
  testMatch: ["viewport.spec.mjs", "completion-flow.spec.mjs"],
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "../../test-results/kiosk-browser-report", open: "never" }]],
  outputDir: "../../test-results/kiosk-browser-traces",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    cwd: repositoryRoot,
    command: "npx vite --config apps/platform-v2/vite.config.mjs --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/v2/kiosk/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
