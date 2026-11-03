import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:4186";

async function loadCanonicalAdmin(browser, viewport, failEquipment = false) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 800 });
  const page = await context.newPage();
  const errors = [];
  const mutations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("bd:token", "qa-logged-in-club-admin");
    localStorage.setItem("bd:selectedClubId", "7");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") {
      mutations.push(method + " " + path);
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Mock test forbids mutations" } }) });
      return;
    }
    if (failEquipment && (/\/clubs\/7\/kiosks$/.test(path) || path.includes("kiosk-pairing-requests"))) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Simulert driftsfeil" } }) });
      return;
    }
    const data = path.endsWith("/auth/me")
      ? { user: { id: "10", role: "club_admin", player: { club_id: "7", display_name: "QA testleder" }, name: "QA testleder" } }
      : path.endsWith("/clubs") ? { items: [{ id: "7", name: "Blindleia Dartklubb", slug: "blindleia-dartklubb" }] }
      : path.endsWith("/kiosks") ? { items: [{ id: "3", code: "QA-3", name: "Skive 3", board_number: 3, scoring_mode: "manual", is_active: 1 }] }
      : path.endsWith("/health") ? { status: "ok", environment: "test" }
      : { items: [], tournament: null, boards: [], queue: { items: [] }, progress: {} };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });
  const response = await page.goto(BASE + "/#club", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("#adminApp")).toBeVisible({ timeout: 20000 });
  return { context, page, errors, mutations };
}

for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`Canonical Klubbadmin navigates Utstyr without stuck menu at ${size.width}px`, async ({ browser }, testInfo) => {
    const { context, page, errors, mutations } = await loadCanonicalAdmin(browser, size);
    try {
      if (size.width < 760) {
        await expect(page.locator("#unifiedMobileMore")).toBeVisible();
        await page.locator("#unifiedMobileMore").click();
        await expect(page.locator(".portal-menu")).not.toHaveAttribute("inert", "");
      }
      const nav = page.locator(".portal-menu a[href='#kiosks']").first();
      await expect(nav).toBeVisible();
      await nav.click();
      await expect(page).toHaveURL(/\/#equipment$/);
      await expect(page.locator("#kiosks")).toBeVisible();
      await expect(page.locator("#kioskList .board-row")).toHaveCount(1);
      // URL must stay in canonical admin. Never silently open /v2/equipment/.
      expect(new URL(page.url()).pathname).toBe("/");
      await expect(page.locator("#kiosks h2").first()).toContainText("Utstyr");
      if (size.width < 760) {
        await page.locator("#unifiedMobileMore").click();
        await expect(page.locator(".portal-menu")).not.toHaveAttribute("inert", "");
      }
      await page.locator(".portal-menu a[href='#players']").first().click();
      await expect(page).toHaveURL(/\/#members$/);
      await expect(page.locator("#players")).toBeVisible();
      // A browser animation-frame after leaving equipment is proof that the
      // frontend is still interactive, not just that a hidden DOM node exists.
      const responsive = await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => resolve(document.body.dataset.portalActive));
      }));
      expect(responsive).toBe("players");
      await page.screenshot({ path: testInfo.outputPath(`canonical-admin-${size.width}.png`), animations: "disabled" });
      expect(errors).toEqual([]);
      expect(mutations).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("Canonical Utstyr keeps navigation after read-only equipment API 503", async ({ browser }, testInfo) => {
  const { context, page, errors, mutations } = await loadCanonicalAdmin(browser, { width: 1440, height: 900 }, true);
  try {
    await page.locator(".portal-menu a[href='#kiosks']").first().click();
    await expect(page.locator("#kiosks")).toBeVisible();
    await expect(page.locator("#globalMessage")).toContainText(/Skivene kunne ikke lastes|pairingstatus kunne ikke hentes/i);
    await page.locator(".portal-menu a[href='#tournaments']").first().click();
    await expect(page.locator("#tournaments")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("canonical-equipment-error.png"), animations: "disabled" });
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  } finally {
    await context.close();
  }
});
