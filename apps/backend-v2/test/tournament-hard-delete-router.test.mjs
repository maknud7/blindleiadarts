import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { TournamentOperationsLegacyRouter } from "../dist/runtime/tournament-operations-legacy-router.js";

const config = {
  environment: "test",
  mode: "test-write",
  prodCanaryWritesEnabled: false,
  canonicalSideEffectsReady: true,
  prefixes: {
    runtime: "bd_test_",
    identity: "bd_prod_",
    hardware: "bd_prod_",
  },
};

function requestWithBody(body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.headers = { authorization: "Bearer shared-prod-session" };
  return request;
}

test("hard delete uses shared PROD identity read without session touch and dispatches once", async () => {
  const authCalls = [];
  const hardDeleteCalls = [];
  const realtimeCalls = [];
  const tournamentId = "90071992547409931";

  const identity = {
    async findBySessionToken(token, touchSession) {
      authCalls.push({ token, touchSession });
      return { role: "club_admin", admin_club_ids: "42" };
    },
  };
  const operations = {
    async findTournament(id) {
      assert.equal(id, tournamentId);
      return { id, club_id: "42" };
    },
  };
  const hardDelete = {
    async hardDeleteTournament(id) {
      hardDeleteCalls.push(id);
      return { tournament_id: id, matches: 2, deleted_rows: 11 };
    },
  };
  const realtime = {
    async publishClubRefresh(clubId, reason) {
      realtimeCalls.push({ clubId, reason });
    },
  };

  const router = new TournamentOperationsLegacyRouter(
    config,
    identity,
    operations,
    {},
    hardDelete,
    realtime,
  );

  const result = await router.handle(
    "DELETE",
    `/v1/tournaments/${tournamentId}/hard-delete`,
    requestWithBody({ confirm_delete: true }),
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.tournament_id, tournamentId);
  assert.deepEqual(authCalls, [{ token: "shared-prod-session", touchSession: false }]);
  assert.deepEqual(hardDeleteCalls, [tournamentId]);
  assert.deepEqual(realtimeCalls, [{ clubId: "42", reason: "tournament_deleted" }]);
});

test("hard delete fails before mutation without explicit confirmation", async () => {
  let deleteCalls = 0;
  const router = new TournamentOperationsLegacyRouter(
    config,
    {
      async findBySessionToken(_token, touchSession) {
        assert.equal(touchSession, false);
        return { role: "super_admin", admin_club_ids: "" };
      },
    },
    {
      async findTournament(id) {
        return { id, club_id: "42" };
      },
    },
    {},
    {
      async hardDeleteTournament() {
        deleteCalls += 1;
        return {};
      },
    },
    { async publishClubRefresh() {} },
  );

  await assert.rejects(
    () => router.handle("DELETE", "/v1/tournaments/9/hard-delete", requestWithBody({})),
    (error) => {
      assert.equal(error.code, "hard_delete_confirmation_required");
      assert.equal(error.statusCode, 422);
      return true;
    },
  );
  assert.equal(deleteCalls, 0);
});
