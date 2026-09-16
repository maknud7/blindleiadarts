import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentCatalogReadRepository } from "../dist/mysql/tournament-catalog-read-repository.js";
import { TournamentCatalogReadRouter } from "../dist/runtime/tournament-catalog-read-router.js";

test("club dashboard read preserves the legacy aggregate contract in TEST runtime", async () => {
  const executed = [];
  const db = {
    async query(sql, params) {
      executed.push({ sql, params });
      if (/FROM `bd_test_clubs`/.test(sql)) {
        return [{
          id: "90071992547409931",
          name: "Blindleia Dartklubb",
          slug: "blindleia-dartklubb",
          logo_url: null,
          kiosk_pairing_code: "BDK-1234",
          created_at: "2026-01-01 12:00:00",
          updated_at: "2026-09-16 12:00:00",
        }];
      }
      if (/FROM `bd_test_players` p/.test(sql)) {
        return [{
          id: "17",
          display_name: "Spiller",
          first_name: null,
          last_name: null,
          nickname: null,
          avatar_url: null,
          is_active: 1,
          contact_email: null,
          contact_phone: null,
          user_account_id: null,
          username: null,
          role: null,
        }];
      }
      if (/FROM `bd_test_kiosks`/.test(sql)) {
        return [{
          id: "90071992547409932",
          code: "BD-01",
          name: "Skive 1",
          board_number: 1,
          sponsor_label: null,
          sponsor_logo_url: null,
          scoring_mode: "scolia",
          is_paired: 1,
          paired_device_name: "Tablet",
          paired_at: "2026-09-16 10:00:00",
          is_active: 1,
          last_seen_at: "2026-09-16 11:59:00",
        }];
      }
      if (/FROM `bd_test_tournaments` t/.test(sql) && /registration_count/.test(sql)) {
        return [{
          id: "429",
          name: "Mandagsserien",
          slug: "mandagsserien",
          provider_system: "internal",
          status: "in_progress",
          start_at: "2026-09-14 18:30:00",
          end_at: null,
          registration_count: "14",
          match_count: "20",
          completed_match_count: "18",
        }];
      }
      if (/FROM `bd_test_matches` m/.test(sql)) {
        return [{
          id: "90071992547409933",
          status: "completed",
          round_label: "Runde 4",
          bracket_label: null,
          starts_at: "2026-09-14 20:00:00",
          finished_at: "2026-09-14 20:12:00",
          tournament_id: "429",
          tournament_name: "Mandagsserien",
          kiosk_code: "BD-01",
          board_number: 1,
          player_a_name: "A",
          player_b_name: "B",
          winner_name: "A",
        }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const sessions = {
    async withConnection(callback) {
      return callback(db);
    },
  };
  const repository = new MySqlTournamentCatalogReadRepository(sessions, "bd_test_");

  const result = await repository.getClubDashboard("90071992547409931");

  assert.equal(executed.length, 5);
  assert.ok(executed.every(({ params }) => params?.[0] === "90071992547409931"));
  assert.ok(executed.every(({ sql }) => /bd_test_/.test(sql)));
  assert.ok(executed.every(({ sql }) => !/bd_prod_/.test(sql)));
  assert.equal(result.club.id, "90071992547409931");
  assert.equal(result.kiosks[0].id, "90071992547409932");
  assert.equal(result.recent_matches[0].id, "90071992547409933");
  assert.equal(result.recent_matches[0].tournament_id, "429");
  assert.equal(result.players[0].id, "17");
  assert.equal(result.tournaments[0].registration_count, 14);
  assert.equal(result.tournaments[0].completed_match_count, 18);
});

test("club dashboard router is GET-only, preserves unsafe integer ids, and matches legacy 404", async () => {
  const calls = [];
  const catalog = {
    async getClubDashboard(clubId) {
      calls.push(clubId);
      if (clubId === "42") return null;
      return {
        club: { id: clubId, name: "Klubb" },
        players: [],
        kiosks: [],
        tournaments: [],
        recent_matches: [],
      };
    },
  };
  const router = new TournamentCatalogReadRouter(catalog);

  const unsafe = await router.handle("GET", "/v1/clubs/90071992547409931/dashboard");
  assert.equal(unsafe?.statusCode, 200);
  assert.equal(unsafe?.payload.ok, true);
  assert.equal(unsafe?.payload.club.id, "90071992547409931");

  const missing = await router.handle("GET", "/v1/clubs/42/dashboard");
  assert.deepEqual(missing, {
    statusCode: 404,
    payload: {
      ok: false,
      error: { code: "club_not_found", message: "Club was not found." },
    },
  });

  assert.deepEqual(calls, ["90071992547409931", "42"]);
  assert.equal(await router.handle("POST", "/v1/clubs/42/dashboard"), null);
  assert.equal(await router.handle("GET", "/v1/clubs/0/dashboard"), null);
});