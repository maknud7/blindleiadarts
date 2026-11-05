import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Resolve all QA output paths from the repository root, not from where
// Playwright happens to interpret the configuration file's relative paths.
// The GitHub Actions artifact uploader reads this exact root-level folder.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = path.join(repositoryRoot, "artifacts");

export default defineConfig({
  testDir: ".",
  timeout: 25000,
  expect: { timeout: 10000 },
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    // Successful tests must produce visual evidence for UX sign-off too.
    screenshot: "on",
  },
  reporter: [["list"], ["html", { outputFolder: path.join(artifactRoot, "player-attendance-browser-report"), open: "never" }]],
  outputDir: path.join(artifactRoot, "player-attendance-browser-results"),
  retries: 0,
  workers: 2,
});
