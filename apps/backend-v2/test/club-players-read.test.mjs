import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentCatalogReadRepository } from "../dist/mysql/tournament-catalog-read-repository.js";
import { TournamentCatalogReadRouter } from "../dist/runtime/tournament-catalog-read-router.js";

test("club players read preserves the legacy runtime-only contract", async () => {
  const executed = [];
  const rows = [
    {
      id: "17",
      display_name: "Aktiv Spiller",
      first_name: "Aktiv",
      last_name: "Spiller",
      nickname: null,
      avatar_url: null,
      is_active: 1,
      contact_email: "aktiv@example.invalid",
      contact_phone: null,
      user_account_id: "8",
      username: "aktiv@example.invalid",
      role: "player",
    },
    {
      id: "90071992547409931",
      display_name: "Inaktiv Spiller",
      first_name: null,
      last_name: null,
      nickname: "Pause",
      avatar_url: null,
      is_active: 0,
      contact_email: null,
      contact_phone: null,
      user_account_id: null,
      username: null,
      role: null,
    },
  ];
  const db = {
    async query(sql, params) {
      executed.push({ sql, params });
      return rows;
    },
  };
  const sessions = {
    async withConnection(callback) {
      return callback(db);
    },
  };
  const repository = new MySqlTournamentCatalogReadRepository(sessions, "bd_test_");

  const result = await repository.listClubPlayers("42");

  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].params, ["42"]);
  assert.match(executed[0].sql, /`bd_test_players`/);
  assert.match(executed[0].sql, /`bd_test_member_profiles`/);
  assert.match(executed[0].sql, /`bd_test_user_accounts`/);
  assert.doesNotMatch(executed[0].sql, /bd_prod_/);
  assert.doesNotMatch(executed[0].sql, /is_active\s*=\s*1/i, "legacy list includes inactive players");
  assert.match(executed[0].sql, /ORDER BY p\.display_name ASC/);

  assert.deepEqual(result, [
    {
      id: "17",
      display_name: "Aktiv Spiller",
      first_name: "Aktiv",
      last_name: "Spiller",
      nickname: null,
      avatar_url: null,
      is_active: 1,
      contact_email: "aktiv@example.invalid",
      contact_phone: null,
      user_account_id: "8",
      username: "aktiv@example.invalid",
      role: "player",
    },
    {
      id: "90071992547409931",
      display_name: "Inaktiv Spiller",
      first_name: null,
      last_name: null,
      nickname: "Pause",
      avatar_url: null,
      is_active: 0,
      contact_email: null,
      contact_phone: null,
      user_account_id: null,
      username: null,
      role: null,
    },
  ]);
});

test("club players router owns GET only and keeps all database ids as decimal strings", async () => {
  const calls = [];
  const catalog = {
    async listClubPlayers(clubId) {
      calls.push(clubId);
      return [{ id: "90071992547409931", display_name: "Stor ID" }];
    },
  };
  const router = new TournamentCatalogReadRouter(catalog);

  const safe = await router.handle("GET", "/v1/clubs/42/players");
  assert.deepEqual(safe, {
    statusCode: 200,
    payload: {
      ok: true,
      club_id: "42",
      items: [{ id: "90071992547409931", display_name: "Stor ID" }],
    },
  });

  const unsafe = await router.handle("GET", "/v1/clubs/90071992547409931/players");
  assert.equal(unsafe?.payload.club_id, "90071992547409931");
  assert.deepEqual(calls, ["42", "90071992547409931"]);

  assert.equal(await router.handle("POST", "/v1/clubs/42/players"), null);
  assert.equal(await router.handle("GET", "/v1/clubs/0/players"), null);
});
