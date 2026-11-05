import { expect, test } from "@playwright/test";

const ADMIN_PAGE = "http://127.0.0.1:4191/admin/";
const pageHtml = '<!doctype html><html lang="no"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-portal-active="players"><select id="clubSelect"><option value="7">Sjøbua</option><option value="8">Testklubb</option></select><button id="refreshAllButton">Oppdater</button><section id="players" data-portal-section="players"><div id="memberRegistryStatus">Laster medlemsregister …</div></section></body></html>';

const member = (id, name, active = true) => ({
  member_id: id,
  member_name: name,
  membership: { is_active_member: active, member_number: String(id), paid_current: active },
  account: active ? { id: id + 1000, status: "active", email: "qa@example.invalid", access_level: "player" } : null,
  player: { display_name: name },
});

async function boot(page, { delayedFirstClub = false, firstClubFails = false } = {}) {
  const requests = [];
  const errors = [];
  let failure = firstClubFails;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/") {
      return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml });
    }
    if (url.pathname === "/api/member-onboarding.php") {
      const club = url.searchParams.get("club_id");
      requests.push({ club, method: route.request().method() });
      if (route.request().method() !== "GET") {
        return route.fulfill({ status: 405, body: "Read-only UX test" });
      }
      if (club === "7" && delayedFirstClub) await new Promise((resolve) => setTimeout(resolve, 500));
      if (club === "7" && failure) {
        failure = false;
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { message: "Simulert API-feil" } }) }).catch(() => {});
      }
      const items = club === "8" ? [member(22, "Britt Ny")] : [member(11, "Ada A"), member(12, "Bo Inaktiv", false)];
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { items, pending_registrations: [], permissions: {} } }) }).catch(() => {});
    }
    return route.fulfill({ status: 404, body: "Not mocked" });
  });
  await page.goto(ADMIN_PAGE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("bd:token", "qa-member-readonly");
    localStorage.setItem("bd:selectedClubId", "7");
  });
  await page.addStyleTag({ path: "apps/admin/member-onboarding-admin.css" });
  await page.addStyleTag({ path: "apps/admin/admin-ux.css" });
  await page.addScriptTag({ path: "apps/admin/member-onboarding-admin.js" });
  return { requests, errors };
}

for (const width of [375, 768, 1440]) {
  test("Members summary and filters remain usable at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const { requests, errors } = await boot(page);
    await expect(page.locator("#memberAccessRows")).toContainText("Ada A");
    await expect(page.locator("#memberAccessSummary")).toBeVisible();
    await expect(page.locator("#memberAccessSummary button")).toHaveCount(4);
    await expect(page.locator("#memberAccessRows")).not.toContainText("Bo Inaktiv");
    await page.locator('[data-member-filter="inactive"]').click();
    await expect(page.locator("#memberAccessRows")).toContainText("Bo Inaktiv");
    await page.locator("#memberSearch").fill("ingen treff");
    await expect(page.locator("#memberAccessRows")).toContainText("Ingen medlemmer passer filteret");
    await page.locator("#memberSearch").fill("");
    await expect(page.locator("#memberAccessRows")).toContainText("Bo Inaktiv");
    expect(errors).toEqual([]);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });
}

test("Changing clubs while a read is pending never shows the previous club", async ({ page }) => {
  const { requests, errors } = await boot(page, { delayedFirstClub: true });
  await page.evaluate(() => {
    localStorage.setItem("bd:selectedClubId", "8");
    document.getElementById("clubSelect").value = "8";
    document.getElementById("clubSelect").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#memberAccessRows")).toContainText("Britt Ny");
  await page.waitForTimeout(650);
  await expect(page.locator("#memberAccessRows")).not.toContainText("Ada A");
  await expect(page.locator("#memberAccessRows")).toContainText("Britt Ny");
  expect(requests.some((req) => req.club === "8")).toBe(true);
  expect(errors).toEqual([]);
});

test("Failed member list read shows a clear retry action without mutations", async ({ page }) => {
  const { requests, errors } = await boot(page, { firstClubFails: true });
  await expect(page.locator("#memberAccessRows")).toContainText("Simulert API-feil");
  await page.locator(".member-retry-load").click();
  await expect(page.locator("#memberAccessRows")).toContainText("Ada A");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  expect(errors).toEqual([]);
});
