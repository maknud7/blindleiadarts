import assert from "node:assert/strict";
import test from "node:test";

import { SingleEliminationService } from "../dist/service/single-elimination-service.js";

const service = new SingleEliminationService();

test("single-elimination bracket sizing and seed order match the legacy playoff contract", () => {
  assert.equal(service.bracketSize(2), 2);
  assert.equal(service.bracketSize(3), 4);
  assert.equal(service.bracketSize(12), 16);
  assert.deepEqual(service.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.equal(service.roundLabel(8, 1), "Kvartfinale");
  assert.equal(service.roundLabel(8, 2), "Semifinale");
  assert.equal(service.roundLabel(8, 3), "Finale");
});

test("qualifier seeding keeps qualification tiers and avoids an immediate same-group rematch when possible", () => {
  const seeded = service.seedQualifiers([
    qualifier("101", "A winner", "11", 1, 6, 5, 7),
    qualifier("102", "B winner", "12", 1, 6, 4, 6),
    qualifier("103", "A runner-up", "11", 2, 4, 1, 5),
    qualifier("104", "B runner-up", "12", 2, 4, 0, 4),
  ]);

  assert.deepEqual(seeded.map((row) => row.source_group_position), [1, 1, 2, 2]);
  assert.deepEqual(seeded.map((row) => row.playoff_seed), [1, 2, 3, 4]);

  const bySeed = new Map(seeded.map((row) => [row.playoff_seed, row]));
  for (const [leftSeed, rightSeed] of [[1, 4], [2, 3]]) {
    assert.notEqual(bySeed.get(leftSeed).source_group_id, bySeed.get(rightSeed).source_group_id);
  }
});

test("playoff validation rejects unsupported bracket sizes", () => {
  assert.throws(() => service.bracketSize(33), (error) => {
    assert.equal(error.code, "playoff_too_large");
    return true;
  });
});

function qualifier(playerId, displayName, groupId, position, points, legDiff, legsWon) {
  return {
    player_id: playerId,
    display_name: displayName,
    seed_number: null,
    source_group_id: groupId,
    source_group_name: `Group ${groupId}`,
    source_group_position: position,
    points,
    leg_diff: legDiff,
    legs_won: legsWon,
  };
}
