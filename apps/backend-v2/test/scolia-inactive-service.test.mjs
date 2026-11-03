import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ScoliaRuntimeRouter } from "../dist/runtime/scolia-runtime-router.js";

function makeRouter({ enabled, token, hardwareMode = "scolia", mode = "live" }) {
  const queued = [];
  const router = new ScoliaRuntimeRouter(
    { environment: "test", mode: "test-write" },
    {},
    {
      async kioskUiSnapshot() {
        return {
          match_id: "9007199254740993",
          bridge_heartbeat_age_seconds: 1,
          last_status_probe_age_seconds: 30,
          physical_status: { status: "Ready", age_seconds: 1, event_type: "SBC_STATUS" },
          buffer: null, queue: {}, last_visit: null, latest_canonical_visit: null,
        };
      },
      async queueCommand(_clubId, _kioskId, kind) { queued.push(kind); },
    },
    {},
    { async resolve() { return { club_id: "11", kiosk_id: "17" }; } },
    {},
    {
      async getBoardSettings() {
        return {
          mode, scoring_mode: hardwareMode,
          club_scolia_enabled: enabled,
          club_scolia_token_configured: token,
          connection_state: "connected",
          fallback_active: 0, needs_reconciliation: 0,
        };
      },
    },
  );
  return { router, queued };
}

async function status(inputs) {
  const { router, queued } = makeRouter(inputs);
  const result = await router.handle("GET", "/v1/kiosks/BOARD/scolia/status", { headers: {} });
  return { board: result.payload.board, queued };
}

test("inactive Scolia subscription retains physical identity and enables manual scoring", async () => {
  const { board, queued } = await status({ enabled: 0, token: 1 });
  assert.equal(board.scoring_mode, "scolia");
  assert.equal(board.scolia_service_ready, false);
  assert.equal(board.scolia_inactive_reason, "club_disabled");
  assert.equal(board.effective_scoring_mode, "manual");
  assert.deepEqual(queued, [], "disabled service must not enqueue physical commands");
});

test("missing Service Account token cannot activate automatic scoring", async () => {
  const { board, queued } = await status({ enabled: 1, token: 0 });
  assert.equal(board.scolia_service_ready, false);
  assert.equal(board.scolia_inactive_reason, "access_token_missing");
  assert.equal(board.effective_scoring_mode, "manual");
  assert.deepEqual(queued, []);
});

test("configured Scolia with live Service Account keeps automatic scoring and status probes", async () => {
  const { board, queued } = await status({ enabled: 1, token: 1 });
  assert.equal(board.scolia_service_ready, true);
  assert.equal(board.scolia_inactive_reason, null);
  assert.equal(board.effective_scoring_mode, "scolia");
  assert.deepEqual(queued, ["GET_SBC_STATUS"]);
});

test("manual hardware stays manual even when club Service Account is configured", async () => {
  const { board, queued } = await status({ enabled: 1, token: 1, hardwareMode: "manual" });
  assert.equal(board.effective_scoring_mode, "manual");
  assert.deepEqual(queued, []);
});

test("both kiosk generations avoid external Scolia polling on manual hardware", () => {
  const legacy = fs.readFileSync("apps/kiosk/scolia-live-ux.js", "utf8");
  const v2Hook = fs.readFileSync("apps/platform-v2/src/kiosk/useScoliaRuntime.ts", "utf8");
  const v2Workspace = fs.readFileSync("apps/platform-v2/src/kiosk/KioskWorkspace.tsx", "utf8");

  assert.match(legacy, /function shouldPollScolia\(/);
  assert.match(legacy, /if \(!shouldPollScolia\(\)\)/);
  assert.match(legacy, /board\?\.scolia_service_ready === false/);
  assert.match(legacy, /renderInactiveService\(board\)/);
  assert.match(v2Hook, /if \(!enabled\) return null/);
  assert.match(v2Hook, /INACTIVE_SERVICE_STATUS_INTERVAL_MS = 30_000/);
  assert.match(v2Hook, /board\?\.scolia_service_ready === false/);
  assert.match(v2Workspace, /enabled: scolia\.automatic/);
  assert.match(v2Workspace, /Scolia API er ikke aktivt · manuell scoring/);
});
