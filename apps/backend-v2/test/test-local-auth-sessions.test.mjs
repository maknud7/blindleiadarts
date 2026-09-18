import assert from "node:assert/strict";
import test from "node:test";

import { MySqlAccountProfileRepository } from "../dist/mysql/account-profile-repository.js";
import { MySqlIdentityAuthRepository } from "../dist/mysql/identity-auth-repository.js";

function activeUser(overrides = {}) {
  return {
    id: "42",
    email: "member@example.invalid",
    display_name: "Member",
    account_status: "active",
    role: "player",
    is_active: "1",
    contact_phone: null,
    player_id: "77",
    player_display_name: "Member",
    player_club_id: "1",
    member_id: "9",
    admin_club_ids: null,
    global_roles: null,
    ...overrides,
  };
}

test("TEST login sessions are inserted only into bd_test_auth_sessions", async () => {
  const executes = [];
  const sessions = {
    async withTransaction(work) {
      return work({
        async execute(sql, params) {
          executes.push({ sql, params });
          return { affectedRows: 1 };
        },
      });
    },
  };
  const repository = new MySqlIdentityAuthRepository(sessions, "bd_test_", "bd_prod_");
  const session = await repository.createSession("42");

  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(executes.length, 1);
  assert.match(executes[0].sql, /`bd_test_auth_sessions`/);
  assert.doesNotMatch(executes[0].sql, /bd_prod_auth_sessions|UPDATE `bd_prod_user_accounts`/);
  assert.equal(executes[0].params[0], "42");
});

test("TEST resolves and refreshes a local session while reading canonical PROD identity", async () => {
  const queries = [];
  const executes = [];
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes("bd_test_auth_sessions")) {
            return [{
              ...activeUser(),
              session_id: "123",
              expires_at: "2099-01-01 00:00:00",
              last_used_at: "2020-01-01 00:00:00",
            }];
          }
          throw new Error("Unexpected query");
        },
        async execute(sql, params) {
          executes.push({ sql, params });
          return { affectedRows: 1 };
        },
      });
    },
  };
  const repository = new MySqlIdentityAuthRepository(sessions, "bd_test_", "bd_prod_");
  const user = await repository.findBySessionToken("local-token", true);

  assert.equal(user.id, "42");
  assert.match(queries[0].sql, /`bd_prod_user_accounts`/);
  assert.match(queries[0].sql, /`bd_test_auth_sessions`/);
  assert.equal(executes.length, 1);
  assert.match(executes[0].sql, /UPDATE `bd_test_auth_sessions`/);
  assert.doesNotMatch(executes[0].sql, /bd_prod_/);
});

test("TEST may accept a PROD session read-only but never touches it", async () => {
  const queries = [];
  const executes = [];
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes("bd_test_auth_sessions")) return [];
          if (sql.includes("bd_prod_auth_sessions")) {
            return [{
              ...activeUser(),
              session_id: "555",
              expires_at: "2099-01-01 00:00:00",
              last_used_at: "2020-01-01 00:00:00",
            }];
          }
          throw new Error("Unexpected query");
        },
        async execute(sql, params) {
          executes.push({ sql, params });
          return { affectedRows: 1 };
        },
      });
    },
  };
  const repository = new MySqlIdentityAuthRepository(sessions, "bd_test_", "bd_prod_");
  const user = await repository.findBySessionToken("prod-token", true);

  assert.equal(user.id, "42");
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /`bd_test_auth_sessions`/);
  assert.match(queries[1].sql, /`bd_prod_auth_sessions`/);
  assert.deepEqual(executes, []);
});

test("TEST profile update mutates only the local player actor", async () => {
  const executes = [];
  const sessions = {
    async withTransaction(work) {
      return work({
        async execute(sql, params) {
          executes.push({ sql, params });
          return { affectedRows: 1 };
        },
      });
    },
    async withConnection(work) {
      return work({
        async query(sql, params) {
          if (sql.includes("bd_test_players")) {
            return [{
              id: "77",
              club_id: "1",
              member_id: "9",
              display_name: "New Name",
              nickname: "Nick",
              avatar_url: null,
            }];
          }
          throw new Error("Unexpected query");
        },
      });
    },
  };
  const repository = new MySqlAccountProfileRepository(sessions, "bd_test_", "bd_prod_");
  const profile = await repository.updateProfile(activeUser(), "New Name", "Nick");

  assert.equal(profile.display_name, "New Name");
  assert.equal(executes.length, 1);
  assert.match(executes[0].sql, /UPDATE `bd_test_players`/);
  assert.doesNotMatch(executes[0].sql, /bd_prod_/);
});
