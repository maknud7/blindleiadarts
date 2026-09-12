import assert from "node:assert/strict";
import test from "node:test";

import { MySqlPublicLiveReadRepository } from "../dist/mysql/public-live-read-repository.js";

class FakeSessions {
  constructor() {
    this.queries = [];
  }

  async withConnection(work) {
    return work({
      query: async (sql, params = []) => {
        this.queries.push({ sql, params });
        if (sql.includes("FROM `bd_prod_screen_devices` sd") && sql.includes("INNER JOIN `bd_prod_clubs` c")) {
          return [{ club_slug: "blindleia-dartklubb" }];
        }
        if (sql.includes("SELECT id FROM `bd_test_clubs` WHERE slug=?")) {
          return [{ id: "7" }];
        }
        if (sql.includes("FROM `bd_test_tournaments` t")) {
          return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    });
  }
}

test("screen token is resolved from canonical hardware while display data stays in TEST runtime", async () => {
  const sessions = new FakeSessions();
  const repo = new MySqlPublicLiveReadRepository(sessions, "bd_test_", "bd_prod_");

  const result = await repo.publicCheckinDisplay({ screenToken: "screen-secret" });

  assert.deepEqual(result, { active: false, checkin: null });
  assert.ok(
    sessions.queries.some(({ sql }) => sql.includes("FROM `bd_prod_screen_devices` sd")),
    "screen token must be read from canonical hardware scope",
  );
  assert.ok(
    sessions.queries.some(({ sql }) => sql.includes("SELECT id FROM `bd_test_clubs` WHERE slug=?")),
    "canonical hardware club must be mapped back to the TEST runtime club by slug",
  );
  assert.ok(
    sessions.queries.some(({ sql }) => sql.includes("FROM `bd_test_tournaments` t")),
    "display/tournament data must remain in TEST runtime scope",
  );
  assert.equal(
    sessions.queries.some(({ sql }) => sql.includes("`bd_test_screen_devices`")),
    false,
    "TEST must not resolve physical screen tokens from bd_test_",
  );
  assert.equal(
    sessions.queries.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
    "public check-in display must remain read-only",
  );
});
