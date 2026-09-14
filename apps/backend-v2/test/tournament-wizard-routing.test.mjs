import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { TournamentRuntimeRouter } from "../dist/runtime/tournament-runtime-router.js";

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
  const wizardRepository = {
    async getPlan(id) {
      calls.push({ op: "get", id });
      return {
        tournament_id: id,
        club_id: "42",
        name: "Wizard test",
        status: "draft",
        tournament_format: "groups_playoff",
        starting_score: 501,
      };
    },
    async updatePlan(id, body) {
      calls.push({ op: "update", id, body });
      return { tournament_id: id, club_id: "42", ...body };
    },
    async deleteDraftTournament(id) {
      calls.push({ op: "delete", id });
      return { deleted: true, tournament_id: id, name: "Wizard test" };
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
    tournamentWizardRepository() { return wizardRepository; },
  };
  const router = new TournamentRuntimeRouter(config(mode), identity, {}, {}, {});
  return { router, touches, calls };
}

test("wizard GET is public and preserves exact BIGINT tournament ids", async () => {
  const { router, touches, calls } = fixture();
  const result = await router.handle("GET", "/v1/tournaments/90071992547409931/wizard-plan", request({}, null));
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.plan.tournament_id, "90071992547409931");
  assert.deepEqual(touches, []);
  assert.deepEqual(calls, [{ op: "get", id: "90071992547409931" }]);
});

test("wizard mutation is blocked before repository or identity access in readonly mode", async () => {
  const { router, touches, calls } = fixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("PATCH", "/v1/tournaments/5/wizard-plan", request({ starting_score: 301 })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(touches, []);
  assert.deepEqual(calls, []);
});

test("wizard writes authenticate against shared PROD identity without touching the session", async () => {
  const { router, touches, calls } = fixture();
  const body = { tournament_format: "groups_only", starting_score: 301 };
  const result = await router.handle("PUT", "/v1/tournaments/90071992547409931/wizard-plan", request(body));
  assert.equal(result?.statusCode, 200);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [
    { op: "get", id: "90071992547409931" },
    { op: "update", id: "90071992547409931", body },
  ]);
});

test("wizard writes enforce club-admin scope", async () => {
  {
    const { router } = fixture({ role: "player" });
    await assert.rejects(
      router.handle("PATCH", "/v1/tournaments/5/wizard-plan", request({ starting_score: 301 })),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
  }
  {
    const { router } = fixture({ adminClubIds: "41" });
    await assert.rejects(
      router.handle("PATCH", "/v1/tournaments/5/wizard-plan", request({ starting_score: 301 })),
      (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
    );
  }
});

test("wizard DELETE preserves legacy top-level deletion shape", async () => {
  const { router, touches, calls } = fixture({ role: "super_admin" });
  const result = await router.handle("DELETE", "/v1/tournaments/90071992547409931/wizard-plan", request());
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.deleted, true);
  assert.equal(result?.payload.tournament_id, "90071992547409931");
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [
    { op: "get", id: "90071992547409931" },
    { op: "delete", id: "90071992547409931" },
  ]);
});

test("tournament PHP frontdoor already captures the complete wizard method matrix", () => {
  const source = fs.readFileSync("apps/api/src/BackendV2TournamentProxyApplication.php", "utf8");
  const wizardLine = source.split("\n").find((line) => line.includes("wizard-plan"));
  assert.ok(wizardLine, "wizard-plan frontdoor route must exist");
  assert.match(wizardLine, /\['GET', 'PUT', 'PATCH', 'DELETE'\]/);
});
