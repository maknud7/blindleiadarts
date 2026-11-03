import { test, expect } from "@playwright/test";

// This harness renders the ACTUAL React KioskWorkspace and its production CSS,
// but intercepts every /api/* request locally. No account, PROD pairing, TEST
// alias or database is created. Real hardware and mutation UAT remain separate.
const ORIGIN = "http://127.0.0.1:4173";

function fixture() {
  return {
    kiosk: {
      id: 7,
      code: "QA-MANUAL",
      name: "Skive 1",
      board_number: 1,
      scoring_mode: "manual",
      club: { id: 3, name: "Blindleia Dartklubb", slug: "blindleia-dartklubb" },
    },
    active_tournament: { id: 10, name: "QA turnering med langt norsk navn", status: "in_progress" },
    match: {
      id: 42,
      status: "in_progress",
      current_leg: 1,
      current_player_id: 101,
      best_of_legs: 3,
      round_label: "Gruppespill - runde 1",
      player_a: { id: 101, display_name: "Spiller A med et ekstraordinært langt navn", remaining: 301, legs_won: 0 },
      player_b: { id: 102, display_name: "Spiller B med et tilsvarende langt navn", remaining: 321, legs_won: 0 },
      recent_visits: [
        { id: 1, player_id: 102, player_name: "Spiller B med et tilsvarende langt navn", visit_number: 2, score: 100, remaining_after: 321, darts_used: 3 },
        { id: 2, player_id: 101, player_name: "Spiller A med et ekstraordinært langt navn", visit_number: 2, score: 140, remaining_after: 301, darts_used: 3 },
        { id: 3, player_id: 102, player_name: "Spiller B med et tilsvarende langt navn", visit_number: 1, score: 80, remaining_after: 421, darts_used: 3 },
        { id: 4, player_id: 101, player_name: "Spiller A med et ekstraordinært langt navn", visit_number: 1, score: 60, remaining_after: 441, darts_used: 3 },
      ],
    },
  };
}

async function startMockKiosk(browser, size, options = {}) {
  const context = await browser.newContext({
    viewport: size,
    hasTouch: true,
    isMobile: size.width < 540,
  });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((forcedSafe) => {
    localStorage.setItem("bd:kioskCode", "QA-MANUAL");
    localStorage.setItem("bd:kioskPairingToken", "qa-local-mock");
    if (forcedSafe) localStorage.setItem("bd:kioskSafeLayout", "1");
  }, Boolean(options.safeLayout));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    if (request.method() !== "GET") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { message: "Read-only browser fixture: mutation blocked" } }),
      });
      return;
    }
    const path = new URL(request.url()).pathname;
    const data = path.endsWith("/health")
      ? { status: "ok", environment: "test" }
      : path.endsWith("/kiosks/QA-MANUAL/state") ? fixture() : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  const response = await page.goto(ORIGIN + "/v2/kiosk/", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByText("Registrer kast")).toBeVisible();
  await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", /^(fit|scroll)$/);
  return { context, page, requests, errors };
}

async function reachControl(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
}

for (const size of [
  { width: 500, height: 720 },
  { width: 600, height: 960 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 600 },
  { width: 1440, height: 900 },
]) {
  test(`mocked kiosk UI stays operable at ${size.width}x${size.height}`, async ({ browser }, testInfo) => {
    const { context, page, requests, errors } = await startMockKiosk(browser, size);
    try {
      const cramped = size.width < 540 || size.height < 790 || size.width > size.height;
      if (cramped) await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
      await expect(page.locator(".editable-visits-v2 .visit-editable-v2")).toHaveCount(4);

      const sum = page.getByRole("button", { name: "Sum", exact: true });
      const perDart = page.getByRole("button", { name: "Per pil", exact: true });
      expect((await reachControl(page, sum)).height).toBeGreaterThanOrEqual(44);
      expect((await reachControl(page, perDart)).height).toBeGreaterThanOrEqual(44);

      const key = page.locator(".keypad button").filter({ hasText: /^1$/ }).first();
      expect((await reachControl(page, key)).height).toBeGreaterThanOrEqual(44);
      await key.click();
      const submit = page.locator(".keypad button.primary");
      await reachControl(page, submit);

      await perDart.click();
      await expect(page.locator(".number-grid-v2")).toBeVisible();
      const bull = page.getByRole("button", { name: "Bull", exact: true });
      expect((await reachControl(page, bull)).height).toBeGreaterThanOrEqual(44);
      await bull.click();
      await reachControl(page, page.getByRole("button", { name: /Lagre kast/ }).last());

      const undo = page.getByRole("button", { name: "Angre siste kast" });
      await reachControl(page, undo);

      await page.screenshot({ path: testInfo.outputPath(`kiosk-${size.width}x${size.height}.png`), fullPage: false, timeout: 12000, animations: "disabled" });
      expect(errors, "No unhandled render exceptions").toEqual([]);
      expect(requests.every((r) => r.method === "GET"), "No backend mutations in browser visual QA").toBe(true);
    } finally {
      await context.close();
    }
  });
}

test("safe layout can be manually forced and survives reload on same tablet", async ({ browser }) => {
  const { context, page, errors } = await startMockKiosk(browser, { width: 768, height: 1024 });
  try {
    await page.getByRole("button", { name: "Innstillinger" }).first().click();
    const safe = page.getByRole("button", { name: "Vis alle knapper (sikker visning)" });
    await safe.click();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
    await page.reload();
    await expect(page.getByText("Registrer kast")).toBeVisible();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
    await page.getByRole("button", { name: "Innstillinger" }).first().click();
    await page.getByRole("button", { name: "Bruk automatisk visning" }).click();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "fit");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
