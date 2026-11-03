import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { CanonicalScoringService } from "../dist/service/canonical-scoring-service.js";
import { CanonicalRealtimePublisher } from "../dist/runtime/canonical-realtime-publisher.js";

test("manual visit publishes kiosk and club realtime refresh without any Scolia dependency", async () => {
  const kioskId = asDbId("9007199254740993");
  const matchId = asDbId("9007199254740995");
  const messages = [];
  const queries = [];
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params) {
          queries.push({ sql, params });
          return [{ code: "BOARD-4", club_id: "7" }];
        },
      });
    },
    async withTransaction() {
      throw new Error("realtime publish must not open a transaction");
    },
  };
  const realtime = new CanonicalRealtimePublisher(
    sessions,
    asTablePrefix("bd_test_"),
    { publishUrl: "https://realtime.example.test/publish", publishSecret: "test-secret" },
    async (_url, request) => {
      messages.push(JSON.parse(request.body));
      return new Response("accepted", { status: 202 });
    },
  );
  const service = new CanonicalScoringService(
    { async recordVisit() { return { kind: "recorded" }; } },
    { async targetMatchIdForKiosk() { return matchId; }, async matchIsCompleted() { return false; } },
    { async afterMutation() {} },
    { async applyCompletedMatch() {} },
    { async syncTournamentElo() {} },
    { async reconcileLinearRanking() {} },
    realtime,
  );

  await service.recordVisit({ kiosk_id: kioskId, source: "manual", payload: { score: 60, darts_used: 3 } });

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [kioskId]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    secret: "test-secret",
    channels: ["kiosk:BOARD-4", "club:7"],
    event: "snapshot",
    payload: {
      refresh: true,
      reason: "visit_recorded",
      source: "manual",
      kiosk_id: kioskId,
      match_id: matchId,
    },
  });
});
