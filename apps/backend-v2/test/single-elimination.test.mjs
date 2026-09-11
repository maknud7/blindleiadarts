import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import {
  bracketSize,
  roundCount,
  roundLabel,
  seedOrder,
  seedQualifiers,
} from "../dist/domain/single-elimination.js";

const id = (value) => asDbId(String(value));

function qualifier(player, group, groupPosition, points, legDiff, legsWon, seedNumber, name) {
  return {
    player_id: id(player),
    display_name: name,
    seed_number: seedNumber,
    source_group_id: id(group),
    source_group_name: `Group ${group}`,
    source_group_position: groupPosition,
    points,
    leg_diff: legDiff,
    legs_won: legsWon,
  };
}

test("bracket geometry mirrors PHP single elimination rules", () => {
  assert.equal(bracketSize(2), 2);
  assert.equal(bracketSize(3), 4);
  assert.equal(bracketSize(8), 8);
  assert.equal(bracketSize(17), 32);
  assert.throws(() => bracketSize(1));
  assert.throws(() => bracketSize(33));

  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.equal(roundCount(8), 3);
  assert.equal(roundLabel(8, 1), "Kvartfinale");
  assert.equal(roundLabel(8, 2), "Semifinale");
  assert.equal(roundLabel(8, 3), "Finale");
});

test("qualifiers are tiered by group position then group-table performance", () => {
  const seeded = seedQualifiers([
    qualifier(101, 1, 2, 7, 3, 8, 2, "Beta"),
    qualifier(102, 2, 1, 6, 2, 7, 1, "Alpha"),
    qualifier(103, 1, 1, 8, 4, 9, 3, "Gamma"),
    qualifier(104, 2, 2, 9, 5, 10, 4, "Delta"),
  ]);

  assert.deepEqual(seeded.map((row) => row.player_id), [id(103), id(102), id(104), id(101)]);
  assert.deepEqual(seeded.map((row) => row.playoff_seed), [1, 2, 3, 4]);
});

test("same qualification tier may swap seeds to avoid first-round same-group rematches", () => {
  const seeded = seedQualifiers([
    qualifier(101, 1, 1, 10, 8, 12, 1, "A winner"),
    qualifier(102, 2, 1, 9, 7, 11, 2, "B winner"),
    qualifier(103, 1, 2, 8, 5, 10, 3, "A runner"),
    qualifier(104, 2, 2, 7, 4, 9, 4, "B runner"),
  ]);

  const bySeed = new Map(seeded.map((row) => [row.playoff_seed, row]));
  const order = seedOrder(4);
  for (let slot = 0; slot < order.length; slot += 2) {
    const left = bySeed.get(order[slot]);
    const right = bySeed.get(order[slot + 1]);
    assert.ok(left && right);
    assert.notEqual(left.source_group_id, right.source_group_id);
  }
});
