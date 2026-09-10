import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { MySqlCoreOnlyMutationGuard } from "../dist/mysql/core-only-mutation-guard.js";

class Sessions {
  constructor(row) {
    this.row = row;
    this.calls = [];
  }

  async withConnection(work) {
    return work({
      query: async (sql, params = []) => {
        this.calls.push({ sql, params: [...params] });
        return this.row === null ? [] : [this.row];
      },
      execute: async () => { throw new Error("guard must never write"); },
    });
  }

  async withTransaction() {
    throw new Error("guard must never open transactions");
  }
}

const kiosk = asDbId("9007199254746001");
const safe = {
  tournament_slug: "backend-v2-e2e-tournament-abc123",
  season_id: null,
  tournament_group_id: null,
  planned_tournament_format: null,
  planned_auto_create_playoff: "0",
  is_playoff: "0",
};

test("isolated backend-v2 E2E fixtures are allowed", async () => {
  const sessions = new Sessions(safe);
  const guard = new MySqlCoreOnlyMutationGuard(sessions, asTablePrefix("bd_test_"));
  await assert.doesNotReject(guard.assertAllowed(kiosk, "visit"));
  assert.match(sessions.calls[0].sql, /FROM `bd_test_matches` m/);
  assert.match(sessions.calls[0].sql, /`bd_test_tournament_playoff_nodes`/);
});

test("ordinary TEST tournaments fail closed while canonical side effects are missing", async () => {
  const guard = new MySqlCoreOnlyMutationGuard(
    new Sessions({ ...safe, tournament_slug: "mandagsserien-6" }),
    asTablePrefix("bd_test_"),
  );
  await assert.rejects(
    guard.assertAllowed(kiosk, "visit"),
    (error) => error?.code === "backend_v2_side_effects_not_ready" && error?.statusCode === 409,
  );
});

test("season, playoff and auto-playoff fixtures are independently rejected", async () => {
  for (const row of [
    { ...safe, season_id: "7" },
    { ...safe, is_playoff: "1" },
    {
      ...safe,
      tournament_group_id: "3",
      planned_tournament_format: "groups_playoff",
      planned_auto_create_playoff: "1",
    },
  ]) {
    const guard = new MySqlCoreOnlyMutationGuard(new Sessions(row), asTablePrefix("bd_test_"));
    await assert.rejects(guard.assertAllowed(kiosk, "start"), /side effects are migrated/);
  }
});

test("undo lookup includes completed matches while forward mutations do not", async () => {
  const undoSessions = new Sessions(safe);
  const undoGuard = new MySqlCoreOnlyMutationGuard(undoSessions, asTablePrefix("bd_test_"));
  await undoGuard.assertAllowed(kiosk, "undo");
  assert.match(undoSessions.calls[0].sql, /IN \("in_progress","assigned","completed"\)/);

  const visitSessions = new Sessions(safe);
  const visitGuard = new MySqlCoreOnlyMutationGuard(visitSessions, asTablePrefix("bd_test_"));
  await visitGuard.assertAllowed(kiosk, "visit");
  assert.match(visitSessions.calls[0].sql, /IN \("in_progress","assigned"\)/);
});
