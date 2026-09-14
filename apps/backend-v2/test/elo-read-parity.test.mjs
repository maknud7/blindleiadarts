import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { eloBaselineFor } from "../dist/data/mandagsserien-elo-2026-08-24.js";
import { MySqlTournamentCatalogReadRepository } from "../dist/mysql/tournament-catalog-read-repository.js";
import { SeasonPublicReadRouter } from "../dist/runtime/season-public-read-router.js";
import { TournamentCatalogReadRouter } from "../dist/runtime/tournament-catalog-read-router.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
}

function fakeDb() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM `bd_test_seasons`") && sql.includes("ORDER BY is_active DESC")) {
        return [{ id: "90071992547409931" }];
      }
      if (sql.includes("FROM `bd_test_players` p") && sql.includes("elo_current_ratings")) {
        return [
          {
            id: "2",
            display_name: "Alice Alpha",
            nickname: null,
            avatar_url: null,
            elo_rating: "1100.0",
            elo_matches_played: "3",
            elo_calculated_at: "2026-09-14 08:00:00",
            local_matches_played: "2",
            matches_won: "2",
          },
          {
            id: "3",
            display_name: "ALICE ALPHA",
            nickname: "duplicate",
            avatar_url: null,
            elo_rating: null,
            elo_matches_played: null,
            elo_calculated_at: null,
            local_matches_played: "99",
            matches_won: "90",
          },
          {
            id: "9007199254740993",
            display_name: "Magnus Knudsen",
            nickname: null,
            avatar_url: null,
            elo_rating: null,
            elo_matches_played: null,
            elo_calculated_at: null,
            local_matches_played: "7",
            matches_won: "4",
          },
          {
            id: "4",
            display_name: "Bob Beta",
            nickname: null,
            avatar_url: null,
            elo_rating: "1100.0",
            elo_matches_played: "1",
            elo_calculated_at: "2026-09-14 08:00:00",
            local_matches_played: "1",
            matches_won: "0",
          },
          {
            id: "5",
            display_name: "Nobody New",
            nickname: null,
            avatar_url: null,
            elo_rating: null,
            elo_matches_played: null,
            elo_calculated_at: null,
            local_matches_played: "0",
            matches_won: "0",
          },
        ];
      }
      if (sql.includes("SELECT id,club_id,season_id,name,elo_enabled") && sql.includes("FROM `bd_test_tournaments`")) {
        if (String(params[0]) === "999") return [];
        return [{
          id: "9007199254740995",
          club_id: "9007199254740997",
          season_id: "90071992547409931",
          name: "Mandagsserien #6",
          elo_enabled: "1",
        }];
      }
      throw new Error(`Unexpected SQL in ELO test: ${sql}`);
    },
  };
}

test("historical ELO baseline mirrors the legacy PHP fallback for known players", () => {
  assert.deepEqual(eloBaselineFor(" Magnus Knudsen "), { rating: 1018.3, played: 15 });
  assert.deepEqual(eloBaselineFor("JON-HENNING NÆSS"), { rating: 1067.3, played: 17 });
  assert.equal(eloBaselineFor("Nobody New"), null);
});

test("club ELO read matches legacy ledger/baseline precedence and preserves BIGINT ids", async () => {
  const db = fakeDb();
  const repo = new MySqlTournamentCatalogReadRepository(new FakeSessions(db), "bd_test_");
  const items = await repo.listClubElo("9007199254740997");

  assert.deepEqual(items.map((item) => item.display_name), ["Alice Alpha", "Bob Beta", "Magnus Knudsen"]);
  assert.equal(items[0].elo_source, "elo_ledger");
  assert.equal(items[0].elo_rating, 1100);
  assert.equal(items[0].matches_played, 3);
  assert.equal(items[0].baseline_played, 3);
  assert.equal(items[0].position, 1);

  const magnus = items[2];
  assert.equal(magnus.id, "9007199254740993");
  assert.equal(typeof magnus.id, "string");
  assert.equal(magnus.season_id, "90071992547409931");
  assert.equal(magnus.elo_source, "mandagsserien_2026_08_24");
  assert.equal(magnus.elo_rating, 1018.3);
  assert.equal(magnus.elo_matches_played, 15);
  assert.equal(magnus.matches_played, 15);

  assert.equal(items.some((item) => String(item.display_name).toLowerCase() === "alice alpha" && item.id === "3"), false);
  assert.equal(items.some((item) => item.display_name === "Nobody New"), false);
  assert.deepEqual(db.queries[0].params, ["9007199254740997"]);
  assert.deepEqual(db.queries[1].params, ["90071992547409931", "9007199254740997"]);
});

test("tournament ELO settings read is boolean and BIGINT-safe", async () => {
  const repo = new MySqlTournamentCatalogReadRepository(new FakeSessions(fakeDb()), "bd_test_");
  const setting = await repo.getTournamentEloSetting("9007199254740995");
  assert.deepEqual(setting, {
    id: "9007199254740995",
    club_id: "9007199254740997",
    season_id: "90071992547409931",
    name: "Mandagsserien #6",
    elo_enabled: true,
  });
  assert.equal(await repo.getTournamentEloSetting("999"), null);
});

test("catalog router owns both ELO GET routes while mutations fall through", async () => {
  const repo = new MySqlTournamentCatalogReadRepository(new FakeSessions(fakeDb()), "bd_test_");
  const router = new TournamentCatalogReadRouter(repo);

  const club = await router.handle("GET", "/v1/clubs/9007199254740997/elo");
  assert.equal(club?.statusCode, 200);
  assert.equal(club?.payload.club_id, "9007199254740997");
  assert.equal(club?.payload.items[2].id, "9007199254740993");

  const setting = await router.handle("GET", "/v1/tournaments/9007199254740995/elo-settings");
  assert.equal(setting?.statusCode, 200);
  assert.equal(setting?.payload.tournament.id, "9007199254740995");

  const missing = await router.handle("GET", "/v1/tournaments/999/elo-settings");
  assert.equal(missing?.statusCode, 404);
  assert.equal(missing?.payload.error.code, "tournament_not_found");

  assert.equal(await router.handle("PUT", "/v1/tournaments/9007199254740995/elo-settings"), null);
  assert.equal(await router.handle("PATCH", "/v1/tournaments/9007199254740995/elo-settings"), null);
});

test("season router no longer shadows the canonical club ELO owner", async () => {
  const seasons = {
    async listEloTable() { throw new Error("legacy Node ELO projection must not be called"); },
  };
  const router = new SeasonPublicReadRouter(seasons);
  assert.equal(await router.handle("GET", "/v1/clubs/7/elo"), null);
});

test("PHP tournament frontdoor captures only GET elo-settings so writes stay legacy", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../../api/src/BackendV2TournamentProxyApplication.php"), "utf8");
  assert.match(source, /\$method === 'GET' && preg_match\('#\^\/v1\/tournaments\/\\d\+\/elo-settings\$#'/);
  assert.doesNotMatch(source, /in_array\(\$method, \['GET', 'PUT'[^\]]*\][^\n]*elo-settings/);
  assert.doesNotMatch(source, /in_array\(\$method, \['GET', 'PATCH'[^\]]*\][^\n]*elo-settings/);
});
