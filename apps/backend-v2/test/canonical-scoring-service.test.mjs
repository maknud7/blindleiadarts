import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { CanonicalScoringService } from "../dist/service/canonical-scoring-service.js";

const ids = {
  kiosk: asDbId("9007199254743001"),
  match: asDbId("9007199254743003"),
  leg: asDbId("9007199254743005"),
  player: asDbId("9007199254743007"),
  visit: asDbId("9007199254743009"),
};

function fixture(overrides = {}) {
  const calls = [];
  const repository = {
    startMatch: async () => {
      calls.push("repository.startMatch");
      return { kind: "started", match_id: ids.match, leg_id: ids.leg };
    },
    recordVisit: async () => {
      calls.push("repository.recordVisit");
      return {
        kind: "recorded",
        match_id: ids.match,
        leg_id: ids.leg,
        player_id: ids.player,
        evaluation: {
          input_mode: "sum",
          score: 60,
          darts_used: 3,
          darts: [],
          is_bust: false,
          is_checkout: false,
          remaining_after: 441,
        },
        match_completed: false,
      };
    },
    undoLastVisit: async () => {
      calls.push("repository.undoLastVisit");
      return { kind: "undone", match_id: ids.match, leg_id: ids.leg, visit_id: ids.visit };
    },
    ...overrides.repository,
  };
  const state = {
    startState: async () => {
      calls.push("state.startState");
      return { id: ids.match, status: "assigned", has_open_leg: false };
    },
    targetMatchIdForKiosk: async () => {
      calls.push("state.targetMatchIdForKiosk");
      return ids.match;
    },
    matchIsCompleted: async () => {
      calls.push("state.matchIsCompleted");
      return false;
    },
    ...overrides.state,
  };
  const playoffs = {
    assertUndoAllowed: async () => {
      calls.push("playoffs.assertUndoAllowed");
      return ids.match;
    },
    afterMutation: async (_matchId, wasUndo) => {
      calls.push(`playoffs.afterMutation:${wasUndo ? "undo" : "forward"}`);
    },
    ...overrides.playoffs,
  };
  const elo = {
    applyCompletedMatch: async () => calls.push("elo.applyCompletedMatch"),
    revertMatch: async () => calls.push("elo.revertMatch"),
    ...overrides.elo,
  };
  const tournamentElo = {
    syncTournamentElo: async () => calls.push("tournamentElo.syncTournamentElo"),
    ...overrides.tournamentElo,
  };
  const ranking = {
    reconcileLinearRanking: async () => calls.push("ranking.reconcileLinearRanking"),
    ...overrides.ranking,
  };
  const realtime = {
    publishRefresh: async ({ reason }) => calls.push(`realtime.publishRefresh:${reason}`),
    ...overrides.realtime,
  };
  return {
    calls,
    service: new CanonicalScoringService(repository, state, playoffs, elo, tournamentElo, ranking, realtime),
  };
}

test("startMatch preserves PHP pre-state → mutation → playoff → realtime order", async () => {
  const { service, calls } = fixture();
  await service.startMatch({ kiosk_id: ids.kiosk, source: "manual" });
  assert.deepEqual(calls, [
    "state.startState",
    "repository.startMatch",
    "playoffs.afterMutation:forward",
    "realtime.publishRefresh:match_started",
  ]);
});

test("repeated start on an in-progress open leg stops after the canonical idempotent mutation", async () => {
  const { service, calls } = fixture({
    state: {
      startState: async () => {
        calls.push("state.startState");
        return { id: ids.match, status: "in_progress", has_open_leg: true };
      },
    },
  });
  await service.startMatch({ kiosk_id: ids.kiosk, source: "scolia" });
  assert.deepEqual(calls, ["state.startState", "repository.startMatch"]);
});

test("recordVisit applies completed-match ELO before playoff and explicit projections exactly like PHP", async () => {
  const { service, calls } = fixture({
    state: {
      matchIsCompleted: async () => {
        calls.push("state.matchIsCompleted");
        return true;
      },
    },
  });
  await service.recordVisit({
    kiosk_id: ids.kiosk,
    source: "scolia",
    payload: { score: 60, request_id: "same-php-order" },
  });
  assert.deepEqual(calls, [
    "state.targetMatchIdForKiosk",
    "repository.recordVisit",
    "state.matchIsCompleted",
    "elo.applyCompletedMatch",
    "playoffs.afterMutation:forward",
    "tournamentElo.syncTournamentElo",
    "ranking.reconcileLinearRanking",
    "realtime.publishRefresh:visit_recorded",
  ]);
});

test("undo guard runs before mutation, then ELO revert, playoff and explicit projections", async () => {
  const { service, calls } = fixture();
  await service.undoLastVisit({ kiosk_id: ids.kiosk, source: "manual" });
  assert.deepEqual(calls, [
    "playoffs.assertUndoAllowed",
    "repository.undoLastVisit",
    "elo.revertMatch",
    "playoffs.afterMutation:undo",
    "tournamentElo.syncTournamentElo",
    "ranking.reconcileLinearRanking",
    "realtime.publishRefresh:visit_undone",
  ]);
});

test("a rejected undo never reaches canonical state mutation", async () => {
  const rejection = new Error("playoff advanced");
  const { service, calls } = fixture({
    playoffs: {
      assertUndoAllowed: async () => {
        calls.push("playoffs.assertUndoAllowed");
        throw rejection;
      },
    },
  });
  await assert.rejects(
    service.undoLastVisit({ kiosk_id: ids.kiosk, source: "api" }),
    (error) => error === rejection,
  );
  assert.deepEqual(calls, ["playoffs.assertUndoAllowed"]);
});
