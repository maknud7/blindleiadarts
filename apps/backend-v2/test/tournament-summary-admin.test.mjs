import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { MySqlTournamentSummaryRepository } from "../dist/mysql/tournament-summary-repository.js";
import { TournamentRuntimeRouter } from "../dist/runtime/tournament-runtime-router.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withTransaction(work) { return work(this.db); }
  async withConnection(work) { return work(this.db); }
}

function request(body = {}, authorization = "Bearer test-session") {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    headers: authorization === null ? {} : { authorization },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
}

function config(mode = "test-write") {
  return {
    environment: "test",
    mode,
    host: "127.0.0.1",
    port: 18082,
    releaseSha: "test",
    internalToken: "internal",
    prodCanaryWritesEnabled: false,
    canonicalSideEffectsReady: true,
    prefixes: { runtime: "bd_test_", identity: "bd_prod_", hardware: "bd_prod_" },
    mysql: {
      host: "localhost", port: 3306, database: "test", username: "test", password: "test",
      connectTimeoutMs: 1000, idleConnectionTimeoutMs: 1000,
      budget: { maxConcurrentConnections: 1, acquireTimeoutMs: 1000 },
    },
    realtime: { websocketUrl: null, publishUrl: null, publishSecret: null, timeoutMs: 1000, publishEnabled: false },
  };
}

function fixture({ mode = "test-write", role = "club_admin", adminClubIds = "42" } = {}) {
  const touches = [];
  const calls = [];
  const summaryRepository = {
    async getTournamentSummary(id, includeDraft) {
      calls.push({ op: "get", id, includeDraft });
      return { id: "90071992547409937", tournament_id: id, club_id: "42", status: "draft" };
    },
    async saveTournamentSummary(id, body, userId) {
      calls.push({ op: "save", id, body, userId });
      return { id: "90071992547409937", tournament_id: id, club_id: "42", ...body };
    },
  };
  const identity = {
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "test-session") return null;
      return {
        id: "90071992547409935", email: "admin@example.invalid", display_name: "Admin",
        role, is_active: 1, account_status: "active", contact_phone: null,
        player_id: null, player_display_name: null, player_club_id: null, member_id: null,
        admin_club_ids: adminClubIds, global_roles: role === "super_admin" ? "super_admin" : "",
      };
    },
    tournamentSummaryRepository() { return summaryRepository; },
  };
  const tournaments = {
    async findTournament(id) { return { id, club_id: "42", name: "Summary test" }; },
  };
  const router = new TournamentRuntimeRouter(config(mode), identity, {}, {}, tournaments);
  return { router, touches, calls };
}

test("summary mutation is blocked before identity lookup in readonly mode", async () => {
  const { router, touches, calls } = fixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("PATCH", "/v1/tournaments/90071992547409931/summary/admin", request({ title: "A", body_text: "B" })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(touches, []);
  assert.deepEqual(calls, []);
});

test("summary admin GET reads shared PROD identity without touching the session", async () => {
  const { router, touches, calls } = fixture();
  const result = await router.handle("GET", "/v1/tournaments/90071992547409931/summary/admin", request());
  assert.equal(result?.statusCode, 200);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [{ op: "get", id: "90071992547409931", includeDraft: true }]);
  assert.equal(result?.payload.summary.id, "90071992547409937");
});

test("summary admin write preserves exact user and tournament ids", async () => {
  const { router, touches, calls } = fixture();
  const body = { title: "Round five", body_text: "Good darts", status: "published" };
  const result = await router.handle("PUT", "/v1/tournaments/90071992547409931/summary/admin", request(body));
  assert.equal(result?.statusCode, 200);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [{ op: "save", id: "90071992547409931", body, userId: "90071992547409935" }]);
  assert.equal(result?.payload.summary.tournament_id, "90071992547409931");
});

test("summary admin enforces authentication and club scope", async () => {
  {
    const { router, calls } = fixture();
    await assert.rejects(
      router.handle("GET", "/v1/tournaments/5/summary/admin", request({}, null)),
      (error) => error?.code === "authentication_required" && error?.statusCode === 401,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = fixture({ role: "player" });
    await assert.rejects(
      router.handle("GET", "/v1/tournaments/5/summary/admin", request()),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = fixture({ adminClubIds: "41" });
    await assert.rejects(
      router.handle("GET", "/v1/tournaments/5/summary/admin", request()),
      (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
});

test("summary repository validates content and status before writing", async () => {
  const repo = new MySqlTournamentSummaryRepository(new FakeSessions({}), "bd_test_");
  await assert.rejects(
    repo.saveTournamentSummary("5", { title: "", body_text: "Body" }, "7"),
    (error) => error?.code === "summary_content_required" && error?.statusCode === 422,
  );
  await assert.rejects(
    repo.saveTournamentSummary("5", { title: "Title", body_text: "Body", status: "public" }, "7"),
    (error) => error?.code === "invalid_summary_status" && error?.statusCode === 422,
  );
});

test("summary repository uses legacy upsert semantics and BIGINT-safe output", async () => {
  const executes = [];
  const db = {
    async query(sql) {
      if (sql.includes("FOR UPDATE")) return [{ id: "90071992547409931" }];
      return [{
        id: "90071992547409937", tournament_id: "90071992547409931", club_id: "90071992547409933",
        title: "Title", body_text: "Body", status: "published", published_at: "2026-09-14 10:00:00",
        created_at: "2026-09-14 09:00:00", updated_at: "2026-09-14 10:00:00",
        tournament_name: "Big", start_at: null,
      }];
    },
    async execute(sql, params) { executes.push({ sql, params }); return { affectedRows: 1 }; },
  };
  const repo = new MySqlTournamentSummaryRepository(new FakeSessions(db), "bd_test_");
  const result = await repo.saveTournamentSummary(
    "90071992547409931",
    { title: " Title ", body_text: " Body ", status: "PUBLISHED" },
    "90071992547409935",
  );
  assert.equal(executes.length, 1);
  assert.match(executes[0].sql, /COALESCE\(published_at,VALUES\(published_at\)\)/);
  assert.deepEqual(executes[0].params.slice(0, 4), ["90071992547409931", "Title", "Body", "published"]);
  assert.equal(executes[0].params[5], "90071992547409935");
  assert.equal(executes[0].params[6], "90071992547409935");
  assert.equal(result.id, "90071992547409937");
  assert.equal(result.tournament_id, "90071992547409931");
  assert.equal(result.club_id, "90071992547409933");
});

test("tournament PHP frontdoor captures only GET/PUT/PATCH summary admin", () => {
  const source = fs.readFileSync("apps/api/src/BackendV2TournamentProxyApplication.php", "utf8");
  assert.match(source, /\['GET', 'PUT', 'PATCH'\].+summary\/admin/s);
  assert.doesNotMatch(source, /\['GET', 'POST'.+summary\/admin/s);
});
