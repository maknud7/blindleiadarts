import assert from "node:assert/strict";
import test from "node:test";

import { TournamentGroupService } from "../dist/service/tournament-group-service.js";

function players(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    tournament_player_id: String(100 + index),
    player_id: String(index + 1),
    display_name: `Player ${String(index + 1).padStart(2, "0")}`,
    nickname: null,
    elo_rating: 1200 - index * 10,
    elo_rating_source: "ranking_snapshot",
  }));
}

test("elo_snake mirrors seeded snake allocation and keeps seed snapshots", () => {
  const service = new TournamentGroupService();
  const result = service.allocate(players(), 2, "elo_snake", "12345");

  assert.equal(result.mode, "elo_snake");
  assert.equal(result.draw_seed, "12345");
  assert.deepEqual(result.groups.map((group) => group.name), ["Gruppe A", "Gruppe B"]);
  assert.deepEqual(
    result.groups.map((group) => group.players.map((player) => player.player_id)),
    [["1", "4", "5", "8"], ["2", "3", "6", "7"]],
  );
  assert.deepEqual(result.groups[0].players.map((player) => player.seed_number), [1, 4, 5, 8]);
  assert.deepEqual(result.groups[0].players.map((player) => player.group_position), [1, 2, 3, 4]);
});

test("random and elo_pots are deterministic for an explicit BIGINT draw seed", () => {
  const service = new TournamentGroupService();
  const hugeSeed = "18446744073709551615";
  const first = service.allocate(players(12), 3, "random", hugeSeed);
  const second = service.allocate(players(12), 3, "random", hugeSeed);
  const potsA = service.allocate(players(12), 3, "elo_pots", hugeSeed);
  const potsB = service.allocate(players(12), 3, "elo_pots", hugeSeed);

  assert.equal(first.draw_seed, hugeSeed);
  assert.deepEqual(first, second);
  assert.deepEqual(potsA, potsB);
});

test("group draw rejects fewer than four players per group", () => {
  const service = new TournamentGroupService();
  assert.throws(() => service.allocate(players(7), 2, "elo_snake", "7"), (error) => {
    assert.equal(error.code, "group_too_small");
    return true;
  });
});

test("round robin creates every pair once for an even-sized group", () => {
  const service = new TournamentGroupService();
  const rounds = service.roundRobin(players(4));
  const pairs = rounds.flat().map(({ player_a_id, player_b_id }) =>
    [player_a_id, player_b_id].sort((a, b) => Number(a) - Number(b)).join("-"),
  );

  assert.equal(rounds.length, 3);
  assert.equal(pairs.length, 6);
  assert.equal(new Set(pairs).size, 6);
  assert.deepEqual([...new Set(pairs)].sort(), ["1-2", "1-3", "1-4", "2-3", "2-4", "3-4"]);
});

test("round robin handles an odd-sized group with one bye per round", () => {
  const service = new TournamentGroupService();
  const rounds = service.roundRobin(players(5));
  assert.equal(rounds.length, 5);
  assert.equal(rounds.flat().length, 10);
});
