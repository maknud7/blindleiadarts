import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "http://127.0.0.1:4197";
const html = '<!doctype html><html lang="no"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/player/styles.css"></head><body><div class="shell"><select id="clubSelect"><option value="7">Blindleia</option></select><section class="card"><div id="registrationList"></div></section><section class="card"><div id="tournamentList"></div></section><section class="card" id="summaries"></section></div><script type="module" src="/player/tournament-discovery-ux.js"></script><script type="module" src="/player/tournament-calendar-polish.js"></script></body></html>';

const tournament = (id, name, status, when) => ({
  id, club_id: 7, name, status, start_at: when,
  end_at: status === "completed" ? "2026-10-21 21:00:00" : null,
  registration_count: 12, registration_state: "open",
});
const tournaments = [
  tournament(101, "Min neste turnering", "registration_open", "2026-12-02 18:00:00"),
  tournament(102, "Annen kommende turnering", "registration_open", "2026-12-09 18:00:00"),
  tournament(201, "Spilte kamper – gammel registrering", "completed", "2026-10-21 18:00:00"),
  tournament(202, "Bare påmeldt, deltok ikke", "completed", "2026-10-14 18:00:00"),
  tournament(203, "Tidligere sjekket inn", "completed", "2026-10-07 18:00:00"),
  tournament(204, "Tidligere ikke møtt", "completed", "2026-09-30 18:00:00"),
  tournament(205, "Annen tidligere turnering", "completed", "2026-09-23 18:00:00"),
  tournament(206, "Bare venteliste", "completed", "2026-09-16 18:00:00"),
  tournament(207, "Avlyst med innsjekking", "cancelled", "2026-09-09 18:00:00"),
];
const registrations = [
  { tournament_id: 101, club_id: 7, status: "registered" },
  { tournament_id: 201, club_id: 7, status: "registered" },
  { tournament_id: 202, club_id: 7, status: "registered" },
  { tournament_id: 203, club_id: 7, status: "checked_in" },
  { tournament_id: 204, club_id: 7, status: "no_show" },
  { tournament_id: 206, club_id: 7, status: "waitlisted" },
  { tournament_id: 207, club_id: 7, status: "checked_in" },
];

async function boot(page, { authenticated = true } = {}) {
  const requests = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript(({ authenticated }) => {
    localStorage.setItem("bd:playerClubId", "7");
    if (authenticated) localStorage.setItem("bd:token", "test-session");
    else localStorage.removeItem("bd:token");
  }, { authenticated });
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/player/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (u.pathname.startsWith("/api/")) {
      requests.push({ path: u.pathname, method: route.request().method() });
      let data = {};
      if (u.pathname === "/api/v1/clubs/7/tournaments") data = { items: tournaments };
      if (u.pathname === "/api/v1/clubs/7/registration-tournaments") data = { items: tournaments.filter((t) => t.id > 100 && t.id < 103) };
      if (u.pathname === "/api/v1/me/dashboard") data = { user: { player: { id: 12 } }, dashboard: { registrations } };
      if (u.pathname === "/api/v1/me/eligibility") data = { eligibility: { can_register: true } };
      if (u.pathname === "/api/v1/players/12/matches") data = { items: [{ tournament_id: 201, status: "completed" }] };
      const match = /^\/api\/v1\/tournaments\/(\d+)$/.exec(u.pathname);
      if (match) data = { tournament: { ...tournaments.find((t) => t.id === Number(match[1])), registrations: [], matches: [] } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    }
    if (u.pathname.startsWith("/player/") || u.pathname.startsWith("/packages/")) {
      const filename = path.join(root, "apps", u.pathname.replace(/^\//, ""));
      const original = u.pathname.startsWith("/packages/") ? path.join(root, u.pathname.slice(1)) : filename;
      const bytes = await fs.readFile(original).catch(() => null);
      if (bytes) return route.fulfill({ status: 200, body: bytes, contentType: u.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    }
    return route.fulfill({ status: 404, body: "Not mocked" });
  });
  await page.goto(origin + "/player/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".tdx-root")).toBeVisible();
  return { requests, pageErrors };
}

for (const width of [360, 390, 768, 1365]) {
  test("personal calendar shows only own events, history reflects matches, club calendar remains complete at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const { requests, pageErrors } = await boot(page);
    await expect(page.locator(".tdx-head h2")).toHaveText("Mine turneringer");
    await expect(page.locator(".tdx-next")).toContainText("Min neste turnering");
    await expect(page.locator(".tdx-root")).not.toContainText("Annen kommende turnering");

    await page.locator('[data-filter="past"]').click();
    await expect(page.locator(".tdx-list")).toContainText("Spilte kamper – gammel registrering");
    await expect(page.locator(".tdx-list")).toContainText("Tidligere sjekket inn");
    for (const excluded of ["Bare påmeldt, deltok ikke", "Tidligere ikke møtt", "Annen tidligere turnering", "Bare venteliste", "Avlyst med innsjekking"]) {
      await expect(page.locator(".tdx-list")).not.toContainText(excluded);
    }
    await expect(page.locator(".tdx-list")).toContainText("Deltok");
    await expect(page.locator(".tdx-list")).toContainText("Sjekket inn");
    await expect(page.locator(".tdx-root")).not.toContainText("Checket inn");

    await page.locator('[data-calendar-scope="club"]').click();
    await expect(page.locator(".tdx-head h2")).toHaveText("Klubbkalender");
    await expect(page.locator(".tdx-list")).toContainText("Annen tidligere turnering");
    await expect(page.locator(".tdx-list")).toContainText("Bare påmeldt, deltok ikke");
    await page.locator('[data-filter="upcoming"]').click();
    await expect(page.locator(".tdx-list")).toContainText("Annen kommende turnering");
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    // No redundant second club-calendar fetch from visual polish.
    expect(requests.filter((r) => r.path === "/api/v1/clubs/7/tournaments")).toHaveLength(1);
  });
}

test("anonymous user sees a login message, not the complete club calendar presented as personal history", async ({ page }) => {
  const { requests, pageErrors } = await boot(page, { authenticated: false });
  await expect(page.locator(".tdx-list")).toContainText("Logg inn for å se dine turneringer");
  await expect(page.locator(".tdx-list .tdx-row")).toHaveCount(0);
  await page.locator('[data-calendar-scope="club"]').click();
  await expect(page.locator(".tdx-list")).toContainText("Annen kommende turnering");
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("Norwegian check-in labels contain no English verb inflections", async () => {
  const source = await fs.readFile(path.join(root, "apps/player/app.js"), "utf8");
  const calendar = await fs.readFile(path.join(root, "apps/player/tournament-discovery-ux.js"), "utf8");
  assertMissing(source, "Checket inn");
  assertMissing(source, "checket inn");
  assertMissing(source, "Check inn på arena");
  assertMissing(source, "board-tildeling");
  expect(source).toContain("Sjekket inn");
  expect(calendar).toContain("Sjekk inn");
});
function assertMissing(source, phrase) {
  expect(source.includes(phrase), "Found non-Norwegian text: " + phrase).toBe(false);
}


test("logging out never leaves the previous member's personal calendar visible", async ({ page }) => {
  const { pageErrors } = await boot(page);
  await expect(page.locator(".tdx-next")).toContainText("Min neste turnering");
  await page.evaluate(() => {
    localStorage.removeItem("bd:token");
    window.dispatchEvent(new Event("bd:player-state-changed"));
  });
  await expect(page.locator(".tdx-list")).toContainText("Logg inn for å se dine turneringer");
  await expect(page.locator(".tdx-next")).toHaveCount(0);
  await expect(page.locator(".tdx-list .tdx-row")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
