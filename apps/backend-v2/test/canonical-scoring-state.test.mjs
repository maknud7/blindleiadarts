import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { MySqlCanonicalScoringState } from "../dist/mysql/canonical-scoring-state.js";

class RecordingSessions {
  constructor(resolver) {
    this.resolver = resolver;
    this.calls = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async withConnection(work) {
    assert.equal(this.active, 0, "state reads must never nest scarce sessions");
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await work({
        query: async (sql, params = []) => {
          this.calls.push({ sql, params: [...params] });
          return this.resolver(sql, params);
        },
        execute: async () => { throw new Error("state port must be read-only"); },
      });
    } finally {
      this.active -= 1;
    }
  }

  async withTransaction() {
    throw new Error("state port must not open transactions");
  }
}

const kiosk = asDbId("9007199254745001");
const match = "9007199254745003";

test("startState mirrors PHP ordering and preserves BIGINT ids as strings", async () => {
  const sessions = new RecordingSessions((sql, params) => {
    assert.match(sql, /FIELD\(m\.status,"in_progress","assigned"\)/);
    assert.match(sql, /FROM `bd_test_matches` m/);
    assert.match(sql, /FROM `bd_test_legs` l/);
    assert.deepEqual(params, [kiosk]);
    return [{ id: match, status: "assigned", has_open_leg: "0" }];
  });
  const state = new MySqlCanonicalScoringState(sessions, asTablePrefix("bd_test_"));
  assert.deepEqual(await state.startState(kiosk), {
    id: match,
    status: "assigned",
    has_open_leg: false,
  });
  assert.equal(sessions.maxActive, 1);
});

test("undo targeting includes completed and prefers the latest completed id after live statuses", async () => {
  const sessions = new RecordingSessions((sql) => {
    assert.match(sql, /IN \("in_progress","assigned","completed"\)/);
    assert.match(sql, /CASE WHEN status="completed" THEN id END DESC/);
    return [{ id: match }];
  });
  const state = new MySqlCanonicalScoringState(sessions, asTablePrefix("bd_test_"));
  assert.equal(await state.targetMatchIdForKiosk(kiosk, true), match);
});

test("completed-state lookup uses one short read session", async () => {
  const sessions = new RecordingSessions((sql, params) => {
    assert.match(sql, /SELECT status FROM `bd_test_matches`/);
    assert.deepEqual(params, [match]);
    return [{ status: "completed" }];
  });
  const state = new MySqlCanonicalScoringState(sessions, asTablePrefix("bd_test_"));
  assert.equal(await state.matchIsCompleted(asDbId(match)), true);
  assert.equal(sessions.calls.length, 1);
});

test("numeric BIGINT results are rejected instead of losing precision", async () => {
  const sessions = new RecordingSessions(() => [{
    id: 9007199254745004,
    status: "in_progress",
    has_open_leg: 1,
  }]);
  const state = new MySqlCanonicalScoringState(sessions, asTablePrefix("bd_test_"));
  await assert.rejects(state.startState(kiosk), /matches\.id must be returned from MySQL as a decimal string/);
});
