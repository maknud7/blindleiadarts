import { test, expect } from "@playwright/test";

const TEST_URL = (process.env.TEST_BASE_URL || "https://test.blindleiadarts.ingenting.org").replace(/\/$/, "");
const PROD_URL = (process.env.PROD_BASE_URL || "https://blindleiadarts.ingenting.org").replace(/\/$/, "");

/** Read-only. Never submit any player, score, check-in or pairing mutation. */
async function capture(page, testInfo, name) {
  await page.screenshot({
    path: testInfo.outputPath(name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
}

async function noPageExceptions(page, action) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await action();
  expect(errors, "uncaught browser JavaScript exceptions").toEqual([]);
}

async function assertNoHorizontalOverflow(page) {
  const width = await page.evaluate(() => {
    const root = document.documentElement;
    return { scroll: root.scrollWidth, viewport: root.clientWidth };
  });
  expect(width.scroll, "unexpected horizontal overflow").toBeLessThanOrEqual(width.viewport + 2);
}

for (const size of [
  { width: 375, height: 812 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test("TEST player portal loads and fits " + size.width + "x" + size.height, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: size, isMobile: size.width < 500, hasTouch: size.width < 500 });
    const page = await context.newPage();
    try {
      await noPageExceptions(page, async () => {
        const result = await page.goto(TEST_URL + "/player/", { waitUntil: "domcontentloaded" });
        expect(result?.ok(), "player page returned an HTTP error").toBeTruthy();
        await expect(page.locator("#brandTitle")).toBeVisible();
        await page.waitForTimeout(1200);
        await assertNoHorizontalOverflow(page);
        await capture(page, testInfo, "player-" + size.width);
      });
    } finally {
      await context.close();
    }
  });
}

test("TEST Live wall renders in desktop display aspect without page exceptions", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await noPageExceptions(page, async () => {
      const response = await page.goto(TEST_URL + "/live/", { waitUntil: "domcontentloaded" });
      expect(response?.ok()).toBeTruthy();
      await expect(page.locator("body")).toBeVisible();
      await page.waitForTimeout(1000);
      await capture(page, testInfo, "live-wall");
    });
  } finally {
    await context.close();
  }
});

for (const size of [
  { width: 600, height: 960 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test("Kiosk TEST launcher (PROD to isolated TEST) works at " + size.width + "x" + size.height, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: size, hasTouch: size.width < 900 });
    const page = await context.newPage();
    try {
      // PROD is opened only to reach the documented isolated TEST launch.
      // Do NOT pair a PROD board or issue any PROD mutations.
      const response = await page.goto(PROD_URL + "/kiosk/", { waitUntil: "domcontentloaded" });
      expect(response?.ok()).toBeTruthy();
      await expect(page.locator("#settingsButton")).toBeVisible();
      await page.locator("#settingsButton").click();
      await expect(page.locator("#prodStartTestMode")).toBeVisible();
      await page.locator("#prodStartTestMode").click();

      const frame = page.frameLocator("#prodTestRuntimeFrame");
      await expect(frame.getByText("Velg skiva du vil teste")).toBeVisible({ timeout: 30000 });
      await expect(frame.locator(".test-banner")).toContainText("TESTMODUS");
      expect(await frame.locator(".test-board").count(), "TEST must expose at least one simulated physical board").toBeGreaterThan(0);

      // On desktop, the v2 terminal should stay in portrait-tablet proportions.
      if (size.width >= 900) {
        const bounds = await frame.locator("#root").boundingBox();
        expect(bounds, "v2 canvas should exist").not.toBeNull();
        if (bounds) expect(bounds.width / bounds.height, "portrait tablet ratio").toBeLessThanOrEqual(0.92);
      }
      await capture(page, testInfo, "kiosk-test-chooser-" + size.width);
      // Only view the chooser; selecting a board would create a TEST alias and
      // is part of the separately approved mutating E2E scenario.
    } finally {
      await context.close();
    }
  });
}
