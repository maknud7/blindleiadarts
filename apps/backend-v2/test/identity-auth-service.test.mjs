import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { IdentityAuthService, normalizePhpBcrypt } from "../dist/service/identity-auth-service.js";

class FakeRepository {
  constructor(user) {
    this.user = user;
    this.audits = [];
    this.createdFor = null;
    this.sessionUser = null;
  }
  async findByEmail(email) {
    this.lastEmail = email;
    return this.user;
  }
  async findBySessionToken(token, touch) {
    this.lastSession = { token, touch };
    return this.sessionUser;
  }
  async createSession(userId) {
    this.createdFor = userId;
    return { token: "session-token", expiresAt: "2027-03-10 12:00:00" };
  }
  async recordAudit(userId, clubId, event) {
    this.audits.push({ userId, clubId, event });
  }
}

function user(passwordHash) {
  return {
    id: "7",
    email: "player@example.com",
    password_hash: passwordHash,
    display_name: "Player One",
    account_status: "active",
    role: "club_admin",
    is_active: 1,
    contact_phone: "12345678",
    player_id: "11",
    player_display_name: "Player One",
    player_club_id: "2",
    member_id: "42",
    admin_club_ids: "2",
    global_roles: null,
  };
}

test("normalizes PHP $2y$ bcrypt prefix without changing the hash body", () => {
  const hash = "$2y$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1234567890abcd";
  assert.equal(normalizePhpBcrypt(hash), `$2b$${hash.slice(4)}`);
});

test("login accepts existing PHP bcrypt identity and creates the same bearer-session shape", async () => {
  const bHash = bcrypt.hashSync("secret-password", 4);
  const phpHash = `$2y$${bHash.slice(4)}`;
  const repository = new FakeRepository(user(phpHash));
  const service = new IdentityAuthService(repository);

  const result = await service.login("PLAYER@example.com", "secret-password");
  assert.equal(repository.lastEmail, "player@example.com");
  assert.equal(repository.createdFor, "7");
  assert.deepEqual(repository.audits.at(-1), { userId: "7", clubId: "2", event: "login_success" });
  assert.equal(result.token_type, "Bearer");
  assert.equal(result.access_token, "session-token");
  assert.equal(result.user.email, "player@example.com");
  assert.equal(result.user.username, "player@example.com");
  assert.equal(result.user.role, "club_admin");
  assert.equal(result.user.player.id, 11);
});

test("invalid password never creates a session", async () => {
  const repository = new FakeRepository(user(bcrypt.hashSync("right", 4)));
  const service = new IdentityAuthService(repository);
  await assert.rejects(() => service.login("player@example.com", "wrong"), (error) => {
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "invalid_credentials");
    return true;
  });
  assert.equal(repository.createdFor, null);
  assert.equal(repository.audits.at(-1).event, "login_failed_invalid_credentials");
});

test("me reuses existing bearer sessions and preserves 180-day touch intent", async () => {
  const repository = new FakeRepository(null);
  repository.sessionUser = user(null);
  const service = new IdentityAuthService(repository);
  const result = await service.me("existing-session", true);
  assert.deepEqual(repository.lastSession, { token: "existing-session", touch: true });
  assert.equal(result.user.id, 7);
});
