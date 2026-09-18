import assert from "node:assert/strict";
import test from "node:test";

import { MySqlIdentityAuditReadRepository } from "../dist/mysql/identity-audit-read-repository.js";
import { IdentityAuditReadRouter } from "../dist/runtime/identity-audit-read-router.js";

function request(authorization = "Bearer audit-session", url = "/v1/player-identities/history") {
  return { headers: authorization === null ? {} : { authorization }, url };
}

function jsonRequest(body, authorization = "Bearer audit-session", url = "/") {
  return {
    headers: authorization === null ? {} : { authorization },
    url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

function identity(role = "super_admin", adminClubIds = "") {
  const touches = [];
  return {
    touches,
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "audit-session") return null;
      return {
        id: "90071992547409931",
        email: "audit@example.invalid",
        display_name: "Audit Admin",
        role,
        is_active: 1,
        account_status: "active",
        contact_phone: null,
        player_id: null,
        player_display_name: null,
        player_club_id: null,
        member_id: null,
        admin_club_ids: adminClubIds,
        global_roles: role === "super_admin" ? "super_admin" : "",
      };
    },
  };
}

test("identity audit router is GET-only, superadmin-only and never touches shared identity sessions", async () => {
  const auth = identity();
  const calls = [];
  const audit = {
    async mergeHistory(limit) { calls.push(["history", limit]); return [{ id: "90071992547409933" }]; },
    async health() { calls.push(["health"]); return { ok: true, duplicate_groups: 0 }; },
  };
  const router = new IdentityAuditReadRouter(auth, audit);

  const history = await router.handle(
    "GET",
    "/v1/player-identities/history",
    request("Bearer audit-session", "/v1/player-identities/history?limit=25"),
  );
  assert.equal(history?.statusCode, 200);
  assert.equal(history?.payload.items[0].id, "90071992547409933");
  assert.deepEqual(calls, [["history", "25"]]);
  assert.deepEqual(auth.touches, [false]);

  assert.equal(await router.handle("POST", "/v1/player-identities/history", request()), null);
  assert.equal(await router.handle("GET", "/v1/player-identities/other", request()), null);

  const forbidden = new IdentityAuditReadRouter(identity("club_admin"), audit);
  await assert.rejects(
    forbidden.handle("GET", "/v1/player-identities/health", request()),
    (error) => error?.code === "super_admin_required" && error?.statusCode === 403,
  );

  await assert.rejects(
    router.handle("GET", "/v1/player-identities/health", request(null)),
    (error) => error?.code === "authentication_required" && error?.statusCode === 401,
  );
});

test("club identity diagnostics allow the owning manager, never touch identity sessions and exclude merge", async () => {
  const clubId = "90071992547409930";
  const auth = identity("club_admin", `7,${clubId}`);
  const calls = [];
  const audit = {
    async duplicateCandidates(id) { calls.push(["duplicates", id]); return [{ id: "90071992547409931" }]; },
    async preview(id, source, target) {
      calls.push(["preview", id, source, target]);
      return { source: { id: source }, target: { id: target }, conflicts: [], safe_to_merge: true };
    },
  };
  const router = new IdentityAuditReadRouter(auth, audit);

  const duplicates = await router.handle(
    "GET",
    `/v1/clubs/${clubId}/player-identities/duplicates`,
    request(),
  );
  assert.equal(duplicates?.payload.items[0].id, "90071992547409931");

  const preview = await router.handle(
    "POST",
    `/v1/clubs/${clubId}/player-identities/preview`,
    jsonRequest({ source_player_id: "90071992547409931", target_player_id: "90071992547409932" }),
  );
  assert.equal(preview?.payload.safe_to_merge, true);
  assert.deepEqual(calls, [
    ["duplicates", clubId],
    ["preview", clubId, "90071992547409931", "90071992547409932"],
  ]);
  assert.deepEqual(auth.touches, [false, false]);

  assert.equal(
    await router.handle("POST", `/v1/clubs/${clubId}/player-identities/merge`, jsonRequest({})),
    null,
  );

  const wrongClub = new IdentityAuditReadRouter(identity("club_admin", "7"), audit);
  await assert.rejects(
    wrongClub.handle("GET", `/v1/clubs/${clubId}/player-identities/duplicates`, request()),
    (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
  );
});

test("merge history preserves unsafe BIGINT ids, parses summary and legacy identity scope", async () => {
  const db = {
    async query(sql, params) {
      if (sql.includes("information_schema.TABLES")) {
        return [{ present: 1 }];
      }
      if (sql.includes("FROM `bd_test_player_identity_merges` m")) {
        assert.match(sql, /LEFT JOIN `bd_prod_user_accounts` ua/);
        assert.match(sql, /LIMIT 500$/);
        return [{
          id: "90071992547409931",
          club_id: "42",
          source_player_id: "90071992547409932",
          target_player_id: "7",
          source_display_name: "A",
          target_display_name: "B",
          merged_by_user_account_id: "90071992547409933",
          reason: "duplicate",
          summary_json: JSON.stringify({ moved: { matches: 4, visits: "6" } }),
          created_at: "2026-09-14 10:00:00",
          club_name: "Blindleia",
          source_member_id: "90071992547409934",
          target_member_id: null,
          merged_by_name: "Admin",
          merged_by_email: "admin@example.invalid",
          source_merged_at: "2026-09-14 10:00:00",
        }];
      }
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params ?? [])}`);
    },
  };
  const sessions = { async withConnection(work) { return work(db); } };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_test_", "bd_prod_");
  const items = await repo.mergeHistory(9999);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "90071992547409931");
  assert.equal(items[0].source_player_id, "90071992547409932");
  assert.equal(items[0].merged_by_user_account_id, "90071992547409933");
  assert.equal(items[0].source_member_id, "90071992547409934");
  assert.equal(items[0].club_id, 42);
  assert.deepEqual(items[0].summary, { moved: { matches: 4, visits: "6" } });
  assert.equal(items[0].moved_relations, 10);
  assert.equal(items[0].identity_scope, "player_member");
  assert.equal(Object.hasOwn(items[0], "summary_json"), false);
});

test("merge history returns empty when the runtime merge table is absent", async () => {
  const sessions = {
    async withConnection(work) {
      return work({ async query(sql) {
        assert.match(sql, /information_schema\.TABLES/);
        return [];
      } });
    },
  };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_test_", "bd_prod_");
  assert.deepEqual(await repo.mergeHistory(), []);
});

test("identity health reports duplicate groups and preserves unsafe ids", async () => {
  let informationSchemaCalls = 0;
  const db = {
    async query(sql) {
      if (sql.includes("FROM `bd_test_players` p")) {
        return [{
          club_id: "90071992547409931",
          club_name: "Blindleia",
          normalized_name: "same name",
          display_name: "Same Name",
          player_ids: "2",
          ids: "90071992547409932,7",
        }];
      }
      if (sql.includes("information_schema.TABLES")) {
        informationSchemaCalls += 1;
        return [{ present: 1 }];
      }
      if (sql.includes("COUNT(*) AS c FROM `bd_test_player_identity_merges`")) return [{ c: "3" }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const sessions = { async withConnection(work) { return work(db); } };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_test_", "bd_prod_");
  const health = await repo.health();
  assert.equal(health.ok, false);
  assert.equal(health.duplicate_groups, 1);
  assert.equal(health.duplicate_player_ids, 2);
  assert.equal(health.merge_count, 3);
  assert.equal(health.duplicates[0].club_id, "90071992547409931");
  assert.deepEqual(health.duplicates[0].ids, ["90071992547409932", 7]);
  assert.equal(informationSchemaCalls, 1);
});

test("duplicate candidates preserve exact ids and legacy cross-prefix account scope", async () => {
  let identityQueries = 0;
  const db = {
    async query(sql, params = []) {
      if (sql.includes("information_schema.TABLES")) {
        assert.equal(params[0], "bd_test_elo_current_ratings");
        return [{ present: 1 }];
      }
      if (sql.includes("HAVING COUNT(*) > 1") && sql.includes("match_count")) {
        assert.deepEqual(params, ["42", "42"]);
        return [{
          id: "90071992547409931",
          club_id: "42",
          display_name: "Same Name",
          first_name: null,
          last_name: null,
          nickname: null,
          avatar_url: null,
          member_id: "90071992547409932",
          member_link_source: "manual",
          is_active: "1",
          elo_seasons: "2",
          top_elo: "1188",
          match_count: "12",
          visit_count: "3",
          tournament_count: "4",
        }];
      }
      if (sql.includes("bd_prod_user_accounts")) identityQueries += 1;
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const sessions = { async withConnection(work) { return work(db); } };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_test_", "bd_prod_");
  const items = await repo.duplicateCandidates("42");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "90071992547409931");
  assert.equal(items[0].member_id, "90071992547409932");
  assert.equal(items[0].club_id, 42);
  assert.equal(items[0].has_account, false);
  assert.equal(items[0].canonical_score, 601203);
  assert.equal(items[0].elo_seasons, 2);
  assert.equal(identityQueries, 0);
});

test("preview reproduces merge conflicts and reference counts without cross-prefix identity reads", async () => {
  const clubId = "90071992547409930";
  const sourceId = "90071992547409931";
  const targetId = "90071992547409932";
  let identityQueries = 0;
  const db = {
    async query(sql, params = []) {
      if (sql.includes("FROM `bd_test_players` WHERE id=? LIMIT 1")) {
        const id = params[0];
        return [{
          id,
          club_id: clubId,
          display_name: id === sourceId ? "Duplicate" : "duplicate",
          first_name: null,
          last_name: null,
          nickname: null,
          avatar_url: null,
          member_id: id === sourceId ? "100" : "101",
          member_link_source: "manual",
          is_active: "1",
          merged_into_player_id: null,
          merged_at: null,
        }];
      }
      if (sql.includes("information_schema.TABLES")) {
        const table = params[0];
        return ["bd_test_tournament_players", "bd_test_season_ranking_events"].includes(table)
          ? [{ present: 1 }]
          : [];
      }
      if (sql.includes("FROM `bd_test_tournament_players` a")) return [{ c: "1" }];
      if (sql.includes("FROM `bd_test_season_ranking_events` a")) return [{ c: "1" }];
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
        assert.deepEqual(params, ["bd_test_players"]);
        return [{ TABLE_NAME: "bd_test_matches", COLUMN_NAME: "player_a_id" }];
      }
      if (sql.includes("FROM `bd_test_matches` WHERE `player_a_id`=?")) return [{ c: "4" }];
      if (sql.includes("bd_prod_user_accounts")) identityQueries += 1;
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params)}`);
    },
  };
  const sessions = { async withConnection(work) { return work(db); } };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_test_", "bd_prod_");
  const preview = await repo.preview(clubId, sourceId, targetId);
  assert.equal(preview.source.id, sourceId);
  assert.equal(preview.target.id, targetId);
  assert.equal(preview.source.club_id, clubId);
  assert.deepEqual(preview.references, { "bd_test_matches.player_a_id": 4 });
  assert.deepEqual(preview.conflicts.map((conflict) => conflict.code), [
    "different_members",
    "same_tournament",
    "same_ranking_event",
  ]);
  assert.equal(preview.safe_to_merge, false);
  assert.equal(identityQueries, 0);

  await assert.rejects(
    repo.preview(clubId, sourceId, sourceId),
    (error) => error?.code === "validation_error" && error?.statusCode === 422,
  );
});


test("PROD preview reads same-prefix accounts without mutation", async () => {
  const clubId = "42";
  const sourceId = "1001";
  const targetId = "1002";
  const queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM \`bd_prod_players\` WHERE id=? LIMIT 1")) {
        const id = params[0];
        return [{
          id,
          club_id: clubId,
          display_name: id === sourceId ? "Same Name" : "same name",
          first_name: null,
          last_name: null,
          nickname: null,
          avatar_url: null,
          member_id: null,
          member_link_source: null,
          is_active: "1",
          merged_into_player_id: null,
          merged_at: null,
        }];
      }
      if (sql.includes("information_schema.TABLES")) {
        const table = params[0];
        return table === "bd_prod_user_accounts" ? [{ present: 1 }] : [];
      }
      if (sql.includes("SELECT COUNT(*) AS c FROM \`bd_prod_user_accounts\` WHERE player_id IN (?,?)")) {
        assert.deepEqual(params, [sourceId, targetId]);
        return [{ c: "2" }];
      }
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
        assert.deepEqual(params, ["bd_prod_players"]);
        return [];
      }
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params)}`);
    },
  };
  const sessions = { async withConnection(work) { return work(db); } };
  const repo = new MySqlIdentityAuditReadRepository(sessions, "bd_prod_", "bd_prod_");
  const preview = await repo.preview(clubId, sourceId, targetId);

  assert.equal(preview.safe_to_merge, false);
  assert.deepEqual(preview.conflicts.map((item) => item.code), ["two_accounts"]);
  assert.equal(
    queries.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql)),
    false,
  );
});
