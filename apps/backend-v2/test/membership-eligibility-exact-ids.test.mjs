import assert from "node:assert/strict";
import test from "node:test";

import { MySqlMembershipEligibilityRepository } from "../dist/mysql/membership-eligibility-repository.js";

const BIG_PLAYER = "9007199254740993";
const BIG_CLUB = "9007199254740995";
const BIG_MEMBER = "9007199254740997";
const BIG_TOURNAMENT = "9007199254740999";

test("eligibility keeps unlinked player and club ids as exact decimal strings", async () => {
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params) {
          assert.match(sql, /bd_test_players/);
          assert.deepEqual(params, [BIG_PLAYER]);
          return [{
            id: BIG_PLAYER,
            club_id: BIG_CLUB,
            member_id: null,
            display_name: "Big Player",
          }];
        },
      });
    },
  };

  const repository = new MySqlMembershipEligibilityRepository(sessions, "bd_test_");
  const result = await repository.forPlayer(BIG_PLAYER);

  assert.equal(result.player_id, BIG_PLAYER);
  assert.equal(result.club_id, BIG_CLUB);
  assert.equal(result.member_id, undefined);
});

test("eligibility keeps missing member ids exact", async () => {
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params) {
          assert.match(sql, /FROM \`medlemmer\`/);
          assert.deepEqual(params, [BIG_MEMBER]);
          return [];
        },
      });
    },
  };

  const repository = new MySqlMembershipEligibilityRepository(sessions, "bd_test_");
  const result = await repository.forMember(BIG_MEMBER, BIG_CLUB, BIG_PLAYER);

  assert.equal(result.player_id, BIG_PLAYER);
  assert.equal(result.club_id, BIG_CLUB);
  assert.equal(result.member_id, BIG_MEMBER);
});

test("registration result and SQL parameters keep tournament and player ids exact", async () => {
  const queries = [];
  const executes = [];
  const sessions = {
    async withTransaction(work) {
      return work({
        async query(sql, params) {
          queries.push({ sql, params });
          return [];
        },
        async execute(sql, params) {
          executes.push({ sql, params });
          return { affectedRows: 1 };
        },
      });
    },
  };

  const repository = new MySqlMembershipEligibilityRepository(sessions, "bd_test_");
  const result = await repository.registerPlayer(BIG_TOURNAMENT, BIG_PLAYER);

  assert.deepEqual(queries[0].params, [BIG_TOURNAMENT, BIG_PLAYER]);
  assert.deepEqual(executes[0].params, [BIG_TOURNAMENT, BIG_PLAYER]);
  assert.equal(result.tournament_id, BIG_TOURNAMENT);
  assert.equal(result.player_id, BIG_PLAYER);
  assert.equal(result.status, "registered");
});
