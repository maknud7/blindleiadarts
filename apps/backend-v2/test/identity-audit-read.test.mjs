import assert from "node:assert/strict";
import test from "node:test";

import { MySqlIdentityAuditReadRepository } from "../dist/mysql/identity-audit-read-repository.js";
import { IdentityAuditReadRouter } from "../dist/runtime/identity-audit-read-router.js";

function request(authorization = "Bearer audit-session", url = "/v1/player-identities/history") {
  return { headers: authorization === null ? {} : { authorization }, url };
}

function identity(role = "super_admin") {
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
        admin_club_ids: "",
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
