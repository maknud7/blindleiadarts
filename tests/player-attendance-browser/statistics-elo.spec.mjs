import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = "http://127.0.0.1:4195";
const html = '<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/player/styles.css"><link rel="stylesheet" href="/player/player-design-system.css"><link rel="stylesheet" href="/player/statistics-ux.css"><link rel="stylesheet" href="/player/elo-tournament-history.css"><style>html,body{margin:0;max-width:100%;font-family:system-ui;background:#f3f6fa;color:#132f51}body{padding:12px;box-sizing:border-box}.card{padding:12px;border-radius:15px;background:#fff}.hidden{display:none!important}</style></head><body data-portal-active="statistics"><select id="clubSelect"><option value="7">Blindleia</option></select><button id="refreshButton">Oppdater</button><section id="statistics" class="card stack statistics-page" data-portal-section="statistics"><div class="statistics-panel-head statistics-page-head"><h2>Statistikk</h2></div><div class="statistics-tabs" data-tab-count="4" role="tablist"><button type="button" class="active" data-statistics-view="players">Finn spiller</button><button type="button" data-statistics-view="season">Sesong</button><button type="button" data-statistics-view="tournament">Turnering</button><button type="button" data-statistics-view="mine">Mine kamper</button></div><div class="statistics-panel" data-statistics-panel="players"><div class="statistics-panel-head player-directory-head"><div><h3>Finn spiller</h3></div><label class="player-search"><input id="playerSearch" type="search" placeholder="Søk spiller"></label></div><p id="playerSearchCount" class="statistics-player-count"></p><div id="playerDirectory" class="player-directory"></div><article id="playerProfile" class="profile-card hidden"></article></div><div class="statistics-panel hidden" data-statistics-panel="season"><div class="statistics-panel-head"><h3>Sesongranking</h3></div><div id="seasonStandings"></div></div><div class="statistics-panel hidden" data-statistics-panel="tournament"><select id="tableTournamentSelect"></select><button type="button" data-tournament-view="table">Tabell</button><div id="groupTables" data-tournament-panel="table"></div><div id="tournamentMatches"></div></div><div id="myMatches" class="statistics-panel hidden" data-statistics-panel="mine"><div id="myMatchList"></div></div><div id="eloTable" class="hidden"></div></section><dialog id="matchDetailDialog"><div id="matchDetailContent"></div></dialog><script type="module" src="/player/portal-content.js"></script><script type="module" src="/player/statistics-ux.js"></script><script type="module" src="/player/elo-history-exact.js"></script></body></html>';

const event = (id, name, before, after, matches, date) => ({
  tournament_id: id, season_id: 6, tournament_name: name, start_at: date,
  end_at: date, completed: true, tournament_status: "completed",
  rating_before: before, rating_after: after, tournament_matches: matches,
  delta: after - before, played_elo: matches > 0,
});
const history = [
  event("1001", "August Grand Prix", 1000, 1000, 0, "2026-08-10"),
  event("1002", "Mandagsdart runde 2", 1000, 1030, 3, "2026-08-17"),
  event("1003", "DIDO uten deltakelse", 1030, 1030, 0, "2026-08-24"),
  event("1004", "September Grand Prix", 1030, 1014, 2, "2026-09-04"),
];

function data(url) {
  const p = url.pathname;
  if (p === "/api/v1/clubs/7/player-directory" || p === "/api/v1/clubs/7/elo") {
    return { items: [
      { id: 12, display_name: "Bjørn Jarle", nickname: "Bullseye", elo_rating: 1014,
        matches_played: 5, three_dart_average: 54.7 },
      { id: 13, display_name: "Andreas Hansen", nickname: "Andy", elo_rating: 1024,
        matches_played: 5, three_dart_average: 52 },
    ] };
  }
  if (p === "/api/v1/clubs/7/registration-tournaments") return { items: [] };
  if (p === "/api/v1/clubs/7/seasons") return { items: [] };
  if (p === "/api/v1/players/12/profile" || p === "/api/v1/players/13/profile") {
    return { player: { id: Number(p.split("/")[4]), display_name: p.includes("/12/") ? "Bjørn Jarle" : "Andreas Hansen", nickname: "Bullseye" },
      stats: { matches_played: 5, matches_won: 3, three_dart_average: 54.7, visits_180: 1,
        highest_checkout: 116 }, elo: { rating: 1014 }, elo_history: [], recent_matches: [] };
  }
  if (p === "/api/player-elo-tournaments.php") return { player_id: Number(url.searchParams.get("player_id")), items: history };
  if (p === "/api/player-elo-history.php") return { player_id: Number(url.searchParams.get("player_id")), items: [] };
  return {};
}

async function boot(page) {
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("bd:playerClubId", "7"));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/player/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: route.request().method(), path: url.pathname });
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, data: data(url) }) });
    }
    if (url.pathname.startsWith("/player/")) {
      const filename = path.join(root, "apps", url.pathname.slice(1));
      const bytes = await fs.readFile(filename).catch(() => null);
      if (bytes) return route.fulfill({ status: 200, body: bytes,
        contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    }
    return route.fulfill({ status: 404, body: "Not mocked" });
  });
  await page.goto(base + "/player/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('#playerDirectory [data-player-profile]')).toHaveCount(2);
  return { requests, errors };
}

for (const width of [360, 390, 768, 1365]) {
  test("player discovery, ELO points, and no overflow at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, requests } = await boot(page);
    await expect(page.locator('[data-statistics-panel="players"]')).toBeVisible();
    await page.locator("#playerSearch").fill("Bjørn");
    await expect(page.locator("#playerSearchCount")).toContainText("1 av 2");
    await expect(page.locator("#playerDirectory .player-card:visible")).toHaveCount(1);
    await page.locator("#playerDirectory .player-card:visible").click();
    await expect(page.locator("#playerEloSection .elo-chart-navigation button")).toHaveCount(4);
    await expect(page.locator("#playerEloSection .elo-chart-selection")).toContainText("September Grand Prix");
    await page.locator('[data-elo-point-index="2"]').click();
    await expect(page.locator("#playerEloSection .elo-chart-selection")).toContainText("DIDO uten deltakelse");
    await expect(page.locator("#playerEloSection .elo-chart-selection")).toContainText("Ingen ELO-kamper");
    await expect(page.locator("#playerEloSection [data-elo-point-index='2']")).toHaveAttribute("aria-pressed", "true");
    const noOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(noOverflow).toBe(true);
    await page.locator("#playerProfile [data-player-back]").click();
    await expect(page.locator("#playerDirectory .player-card:visible")).toHaveCount(1);
    await expect(page.locator("#playerProfile")).toBeHidden();
    expect(errors).toEqual([]);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });
}
