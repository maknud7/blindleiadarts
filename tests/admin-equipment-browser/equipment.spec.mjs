import { expect, test } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4185";
const CLUB_ID = "7";
function board() {
  return {
    id: "3", code: "BOARD-3", name: "Skive 3", board_number: 3,
    scoring_mode: "manual", is_active: 1, is_paired: 1,
    paired_device_name: "Nettbrett 3",
  };
}

async function visitEquipment(browser, viewport, opts = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 768 });
  const page = await context.newPage();
  const mutations = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("bd:token", "qa-equipment-local-token");
    localStorage.setItem("bd:selectedClubId", "7");
  });
  await page.route("**/api/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method !== "GET") {
      mutations.push(method + " " + path);
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Browser QA forbids mutations" } }) });
      return;
    }
    if (opts.failedBoardReads && (/\/clubs\/7\/kiosks$/.test(path) || path.endsWith("/screen-devices"))) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Simulert midlertidig API-feil" } }) });
      return;
    }
    if (opts.failedBoardReads && path.endsWith("/scolia")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Simulert Scolia-feil" } }) });
      return;
    }
    const data = path.endsWith("/auth/me")
      ? { user: { id: "10", role: "club_admin", player: { club_id: CLUB_ID } } }
      : path.endsWith("/health") ? { status: "ok", environment: "test" }
      : path.endsWith("/clubs") ? { items: [{ id: CLUB_ID, name: "Blindleia Dartklubb" }] }
      : path.endsWith("/equipment/boards") || path.endsWith("/kiosks") ? { items: [board()], configuration_scope: "production_hardware", shared_across_environments: true }
      : path.endsWith("/screen-devices") ? { items: [{ id: "51", label: "Sjøbua TV", access_code: "QA123", is_active: 1 }] }
      : path.endsWith("/scolia") ? { boards: [], configuration_scope: "production_hardware", settings: { enabled: false, queue_max_attempts: 8, queue_retry_base_seconds: 2, event_retention_days: 30 }, queue: {} }
      : path.includes("scolia-bridge-control.php") ? { board: { bridge_released: false } }
      : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  const response = await page.goto(ORIGIN + "/v2/equipment/", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Utstyr", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Oppdater", exact: true })).toBeVisible();
  return { page, context, mutations, errors };
}

for (const size of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`Klubbadmin Utstyr er brukbart etter innlasting på ${size.width}px`, async ({ browser }, testInfo) => {
    const { page, context, mutations, errors } = await visitEquipment(browser, size);
    try {
      await expect(page.getByText("Skive 3", { exact: true }).first()).toBeVisible();
      await expect(page.locator(".platform-nav")).toBeVisible();
      await expect(page.locator(".platform-nav")).not.toHaveAttribute("inert", "");
      const refresh = page.getByRole("button", { name: "Oppdater", exact: true });
      await refresh.click();
      await expect(refresh).toBeEnabled();

      const edit = page.getByRole("button", { name: "Detaljer" }).first();
      await edit.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Lukk" }).first().click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Ensure the admin navigation is not covered by a stale overlay.
      const nav = page.locator('.platform-nav-links a[href="/v2/equipment/"]');
      await nav.scrollIntoViewIfNeeded();
      await expect(nav).toBeInViewport();
      await nav.click();
      await expect(page.getByRole("heading", { name: "Utstyr", exact: true })).toBeVisible();

      await page.screenshot({ path: testInfo.outputPath(`equipment-${size.width}.png`), animations: "disabled" });
      expect(errors).toEqual([]);
      expect(mutations).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("Utstyr er fortsatt interaktivt når skive- og Scolia-API feiler", async ({ browser }, testInfo) => {
  const { page, context, errors, mutations } = await visitEquipment(browser, { width: 390, height: 844 }, { failedBoardReads: true });
  try {
    await expect(page.getByText(/Kunne ikke laste aktive skiver/)).toBeVisible();
    await expect(page.getByText(/Simulert Scolia-feil/)).toBeVisible();
    const button = page.getByRole("button", { name: "Oppdater", exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toBeEnabled();
    await expect(page.locator(".platform-nav-links")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("equipment-api-failure.png"), animations: "disabled" });
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  } finally {
    await context.close();
  }
});
