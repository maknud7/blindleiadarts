import assert from "node:assert/strict";
import test from "node:test";

import { PlayerLiveReadRouter } from "../dist/runtime/player-live-read-router.js";

test("member dashboard validates the session without touching canonical identity state", async () => {
  const calls = [];
  const identity = {
    async findBySessionToken(token, touchSession) {
      calls.push({ token, touchSession });
      return {
        id: "9",
        email: "member@example.test",
        display_name: "Member",
        role: "player",
        is_active: 1,
        account_status: "active",
        contact_phone: null,
        player_id: "19",
        player_display_name: "Member",
        player_club_id: "1",
        member_id: "29",
        admin_club_ids: "",
        global_roles: "",
      };
    },
  };
  const reads = {
    async memberDashboard() {
      return { player: { id: 19 }, tournaments: [] };
    },
  };
  const router = new PlayerLiveReadRouter({ realtime: { websocketUrl: null } }, identity, reads);
  const result = await router.handle(
    "GET",
    "/v1/me/dashboard",
    { headers: { authorization: "Bearer session-token" } },
  );

  assert.equal(result?.statusCode, 200);
  assert.deepEqual(calls, [{ token: "session-token", touchSession: false }]);
});
