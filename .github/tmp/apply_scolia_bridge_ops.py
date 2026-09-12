from pathlib import Path

bridge_path = Path('apps/backend-v2/src/mysql/scolia-bridge-repository.ts')
bridge = bridge_path.read_text()
marker = '  async enqueueEvent(serialInput: unknown, messageInput: unknown, routedKioskIdInput?: unknown): Promise<Record<string, unknown>> {'
assert marker in bridge
methods = r'''  async bridgeRouterState(): Promise<Record<string, unknown>> {
    return this.sessions.withConnection(async (db) => {
      const testPrefix = (
        this.runtimePrefix !== this.hardwarePrefix
          ? this.runtimePrefix
          : this.hardwarePrefix.endsWith("prod_")
            ? `${this.hardwarePrefix.slice(0, -5)}test_`
            : this.runtimePrefix
      ) as TablePrefix;
      const activityRows = await db.query<QueryResultRow>(
        `SELECT club_id,
                MAX(CASE
                  WHEN status='in_progress' THEN 1
                  WHEN status IN ('draft','ready') AND start_at IS NOT NULL
                    AND start_at BETWEEN DATE_SUB(NOW(3), INTERVAL 8 HOUR) AND DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                  THEN 1 ELSE 0 END) AS tournament_active,
                MIN(CASE WHEN status IN ('draft','ready') AND start_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                  THEN start_at ELSE NULL END) AS next_start_at,
                MIN(CASE WHEN status IN ('draft','ready') AND start_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                  THEN TIMESTAMPDIFF(SECOND,NOW(3),DATE_SUB(start_at,INTERVAL 30 MINUTE)) ELSE NULL END) AS next_activation_seconds
           FROM ${this.table(this.hardwarePrefix, "tournaments")}
          WHERE status IN ('draft','ready','in_progress')
          GROUP BY club_id`,
      );
      const activity = new Map<string, QueryResultRow>();
      let nextActivationSeconds: number | null = null;
      for (const row of activityRows) {
        const clubId = requiredId(row.club_id, "club_id");
        activity.set(clubId, row);
        if (row.next_activation_seconds !== null && row.next_activation_seconds !== undefined) {
          const seconds = Math.max(0, numberValue(row.next_activation_seconds));
          nextActivationSeconds = nextActivationSeconds === null ? seconds : Math.min(nextActivationSeconds, seconds);
        }
      }

      const rows = await db.query<QueryResultRow>(
        `SELECT k.id AS physical_kiosk_id,k.club_id,k.code,k.name,k.board_number,
                s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override,
                c.access_token,c.force_connect,c.forward_messages_to_scolia,c.disconnect_fallback_enabled,
                l.test_kiosk_id,l.expires_at,
                tk.id AS active_test_kiosk_id,tk.code AS test_code,tk.name AS test_name,tk.board_number AS test_board_number
           FROM ${this.table(this.hardwarePrefix, "scolia_board_settings")} s
           INNER JOIN ${this.table(this.hardwarePrefix, "kiosks")} k ON k.id=s.kiosk_id AND k.is_active=1
           INNER JOIN ${this.table(this.hardwarePrefix, "scolia_club_settings")} c ON c.club_id=k.club_id AND c.enabled=1
           LEFT JOIN ${this.table(this.hardwarePrefix, "scolia_test_leases")} l ON l.physical_kiosk_id=k.id AND l.expires_at>NOW(3)
           LEFT JOIN ${this.table(testPrefix, "kiosks")} tk ON tk.id=l.test_kiosk_id AND tk.source_kiosk_id=k.id AND tk.is_active=1
          WHERE s.mode='live' AND s.serial_number IS NOT NULL AND s.serial_number<>''
            AND c.access_token IS NOT NULL AND c.access_token<>''
          ORDER BY k.club_id,k.board_number,k.id`,
      );

      const boards: Record<string, unknown>[] = [];
      let activeTestLeases = 0;
      const activeTournamentClubs = new Set<string>();
      for (const row of rows) {
        const physicalKioskId = requiredId(row.physical_kiosk_id, "physical_kiosk_id");
        const clubId = requiredId(row.club_id, "club_id");
        const testKioskId = optionalId(row.active_test_kiosk_id);
        const leasedToTest = testKioskId !== null;
        const tournamentActive = numberValue(activity.get(clubId)?.tournament_active) === 1;
        if (!leasedToTest && !tournamentActive) continue;
        if (leasedToTest) activeTestLeases += 1;
        else activeTournamentClubs.add(clubId);
        const forceConnect = row.force_connect_override == null ? numberValue(row.force_connect) : numberValue(row.force_connect_override);
        const forwardMessages = row.forward_messages_override == null
          ? numberValue(row.forward_messages_to_scolia)
          : numberValue(row.forward_messages_override);
        boards.push({
          connection_key: stringValue(row.serial_number),
          kiosk_id: leasedToTest ? testKioskId : physicalKioskId,
          physical_kiosk_id: physicalKioskId,
          club_id: clubId,
          code: leasedToTest ? stringValue(row.test_code) : stringValue(row.code),
          name: leasedToTest ? stringValue(row.test_name) : stringValue(row.name),
          board_number: leasedToTest ? numberValue(row.test_board_number) : numberValue(row.board_number),
          serial_number: stringValue(row.serial_number),
          mode: "live",
          auto_fallback_to_manual: numberValue(row.auto_fallback_to_manual || 1),
          access_token: stringValue(row.access_token),
          force_connect: leasedToTest ? 1 : forceConnect,
          forward_messages_to_scolia: forwardMessages,
          disconnect_fallback_enabled: numberValue(row.disconnect_fallback_enabled || 1),
          target_api_base: leasedToTest
            ? "https://test.blindleiadart.ingenting.org/api/v1"
            : "https://blindleiadart.ingenting.org/api/v1",
          environment: leasedToTest ? "test" : "prod",
          activation_reason: leasedToTest ? "test_lease" : "tournament",
          lease_expires_at: leasedToTest ? nullableString(row.expires_at) : null,
          configuration_scope: "production_hardware",
        });
      }
      return {
        boards,
        bridge_mode: boards.length === 0 ? "idle" : "active",
        idle_poll_seconds: 300,
        prewarm_minutes: 30,
        late_start_grace_hours: 8,
        next_activation_in_seconds: nextActivationSeconds,
        configuration_scope: "production_hardware",
        shared_across_environments: true,
        configured_boards: rows.length,
        active_test_leases: activeTestLeases,
        active_tournament_clubs: activeTournamentClubs.size,
      };
    });
  }

  async bridgeHealthState(secretConfigured: boolean): Promise<Record<string, unknown>> {
    return this.sessions.withConnection(async (db) => {
      const testPrefix = (
        this.runtimePrefix !== this.hardwarePrefix
          ? this.runtimePrefix
          : this.hardwarePrefix.endsWith("prod_")
            ? `${this.hardwarePrefix.slice(0, -5)}test_`
            : this.runtimePrefix
      ) as TablePrefix;
      const activityRows = await db.query<QueryResultRow>(
        `SELECT club_id,
                MAX(CASE
                  WHEN status='in_progress' THEN 1
                  WHEN status IN ('draft','ready') AND start_at IS NOT NULL
                    AND start_at BETWEEN DATE_SUB(NOW(3), INTERVAL 8 HOUR) AND DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                  THEN 1 ELSE 0 END) AS tournament_active,
                MIN(CASE WHEN status IN ('draft','ready') AND start_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                  THEN start_at ELSE NULL END) AS next_start_at
           FROM ${this.table(this.hardwarePrefix, "tournaments")}
          WHERE status IN ('draft','ready','in_progress')
          GROUP BY club_id`,
      );
      const activity = new Map<string, QueryResultRow>();
      let nextTournamentStartAt: string | null = null;
      for (const row of activityRows) {
        const clubId = requiredId(row.club_id, "club_id");
        activity.set(clubId, row);
        const next = nullableString(row.next_start_at);
        if (next !== null && (nextTournamentStartAt === null || next < nextTournamentStartAt)) nextTournamentStartAt = next;
      }
      const configured = await db.query<QueryResultRow>(
        `SELECT k.id AS physical_kiosk_id,k.club_id,k.board_number,k.name,l.test_kiosk_id,l.expires_at
           FROM ${this.table(this.hardwarePrefix, "scolia_board_settings")} s
           INNER JOIN ${this.table(this.hardwarePrefix, "kiosks")} k ON k.id=s.kiosk_id AND k.is_active=1
           INNER JOIN ${this.table(this.hardwarePrefix, "scolia_club_settings")} c ON c.club_id=k.club_id AND c.enabled=1
           LEFT JOIN ${this.table(this.hardwarePrefix, "scolia_test_leases")} l ON l.physical_kiosk_id=k.id AND l.expires_at>NOW(3)
          WHERE s.mode='live' AND s.serial_number IS NOT NULL AND s.serial_number<>''
            AND c.access_token IS NOT NULL AND c.access_token<>''
          ORDER BY k.board_number,k.id`,
      );

      const boards: Record<string, unknown>[] = [];
      let expectedActiveCount = 0;
      let freshHeartbeatCount = 0;
      let connectedCount = 0;
      let activeTestLeases = 0;
      let activeTournamentBoards = 0;
      let latestHeartbeatAt: string | null = null;
      let latestHeartbeatAge: number | null = null;
      for (const board of configured) {
        const clubId = requiredId(board.club_id, "club_id");
        const physicalId = requiredId(board.physical_kiosk_id, "physical_kiosk_id");
        const testKioskId = optionalId(board.test_kiosk_id);
        const leasedToTest = testKioskId !== null;
        const tournamentActive = numberValue(activity.get(clubId)?.tournament_active) === 1;
        const expectedActive = leasedToTest || tournamentActive;
        const activationReason = leasedToTest ? "test_lease" : tournamentActive ? "tournament" : "none";
        if (leasedToTest) activeTestLeases += 1;
        if (tournamentActive && !leasedToTest) activeTournamentBoards += 1;
        if (expectedActive) expectedActiveCount += 1;

        const runtimePrefix = leasedToTest ? testPrefix : this.hardwarePrefix;
        const runtimeKioskId = leasedToTest ? testKioskId : physicalId;
        let runtime: QueryResultRow = {};
        if (expectedActive && runtimeKioskId !== null) {
          const runtimeRows = await db.query<QueryResultRow>(
            `SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                    last_bridge_heartbeat_at,last_event_at,
                    CASE WHEN last_bridge_heartbeat_at IS NULL THEN NULL
                      ELSE TIMESTAMPDIFF(SECOND,last_bridge_heartbeat_at,NOW(3)) END AS heartbeat_age_seconds
               FROM ${this.table(runtimePrefix, "scolia_board_runtime")} WHERE kiosk_id=? LIMIT 1`,
            [runtimeKioskId],
          );
          runtime = runtimeRows[0] ?? {};
        }
        const heartbeatAge = runtime.heartbeat_age_seconds == null ? null : Math.max(0, numberValue(runtime.heartbeat_age_seconds));
        const heartbeatFresh = expectedActive && heartbeatAge !== null && heartbeatAge <= 60;
        const connectionState = expectedActive ? (stringValue(runtime.connection_state) || "unknown") : "sleeping";
        const connected = expectedActive && heartbeatFresh && connectionState === "connected";
        if (heartbeatFresh) freshHeartbeatCount += 1;
        if (connected) connectedCount += 1;
        if (heartbeatAge !== null && (latestHeartbeatAge === null || heartbeatAge < latestHeartbeatAge)) {
          latestHeartbeatAge = heartbeatAge;
          latestHeartbeatAt = nullableString(runtime.last_bridge_heartbeat_at);
        }
        boards.push({
          board_number: numberValue(board.board_number),
          name: stringValue(board.name),
          route: leasedToTest ? "test" : "prod",
          expected_active: expectedActive,
          activation_reason: activationReason,
          test_lease_active: leasedToTest,
          lease_expires_at: leasedToTest ? nullableString(board.expires_at) : null,
          connection_state: connectionState,
          board_status: runtime.board_status ?? null,
          board_phase: runtime.board_phase ?? null,
          heartbeat_fresh: heartbeatFresh,
          heartbeat_age_seconds: heartbeatAge,
          last_bridge_heartbeat_at: runtime.last_bridge_heartbeat_at ?? null,
          last_event_at: runtime.last_event_at ?? null,
          fallback_active: numberValue(runtime.fallback_active) === 1,
          needs_reconciliation: numberValue(runtime.needs_reconciliation) === 1,
        });
      }
      const bridgeRequired = expectedActiveCount > 0;
      const bridgeAlive = bridgeRequired ? freshHeartbeatCount > 0 : null;
      return {
        configuration_scope: "production_hardware",
        secret_configured: secretConfigured,
        bridge_status: !secretConfigured ? "misconfigured" : !bridgeRequired ? "sleeping" : bridgeAlive ? "online" : "stale",
        bridge_required: bridgeRequired,
        bridge_alive: bridgeAlive,
        heartbeat_stale_after_seconds: 60,
        latest_heartbeat_at: latestHeartbeatAt,
        latest_heartbeat_age_seconds: latestHeartbeatAge,
        configured_boards: configured.length,
        expected_active_boards: expectedActiveCount,
        fresh_heartbeat_boards: freshHeartbeatCount,
        connected_boards: connectedCount,
        active_test_leases: activeTestLeases,
        active_tournament_boards: activeTournamentBoards,
        next_tournament_start_at: nextTournamentStartAt,
        prewarm_minutes: 30,
        boards,
      };
    });
  }

'''
bridge = bridge.replace(marker, methods + marker, 1)
bridge_path.write_text(bridge)

router_path = Path('apps/backend-v2/src/runtime/scolia-runtime-router.ts')
router = router_path.read_text()
marker = '  async handle(method: string, path: string, request: IncomingMessage): Promise<ScoliaRuntimeRouteResult | null> {\n    if (path.startsWith("/v1/scolia/bridge/")) {'
replacement = '''  async handle(method: string, path: string, request: IncomingMessage): Promise<ScoliaRuntimeRouteResult | null> {
    if (method === "GET" && path === "/v1/scolia/health") {
      return ok({
        service: "scolia-bridge",
        generated_at: new Date().toISOString(),
        data: await this.bridge.bridgeHealthState(this.config.internalToken !== null),
      });
    }

    if (path.startsWith("/v1/scolia/bridge/")) {'''
assert marker in router
router = router.replace(marker, replacement, 1)
marker2 = '      if (method === "GET" && path === "/v1/scolia/bridge/config") {\n        return ok({ boards: await this.bridge.listBridgeBoards(), ...this.bridge.scope() });\n      }'
replacement2 = marker2 + '\n      if (method === "GET" && path === "/v1/scolia/bridge/router") {\n        return ok({ data: await this.bridge.bridgeRouterState() });\n      }'
assert marker2 in router
router = router.replace(marker2, replacement2, 1)
router_path.write_text(router)

e2e_path = Path('apps/backend-v2/e2e/scolia-runtime-lifecycle.mjs')
e2e = e2e_path.read_text()
marker = '  assert.equal(configuredBoard.mode, "live");\n\n'
insert = '''  assert.equal(configuredBoard.mode, "live");

  const bridgeRouter = await requestJson("/v1/scolia/bridge/router", { method: "GET" });
  assert.equal(bridgeRouter.ok, true);
  assert.equal(bridgeRouter.data.configuration_scope, "production_hardware");
  assert.ok(bridgeRouter.data.configured_boards >= 1);
  assert.equal(bridgeRouter.data.bridge_mode, "idle", "Ready fixture without start_at must not wake physical Scolia routing");

  const bridgeHealth = await requestJson("/v1/scolia/health", { method: "GET", bridgeAuth: false });
  assert.equal(bridgeHealth.ok, true);
  assert.equal(bridgeHealth.service, "scolia-bridge");
  assert.equal(bridgeHealth.data.configuration_scope, "production_hardware");
  assert.ok(bridgeHealth.data.configured_boards >= 1);
  assert.equal(bridgeHealth.data.bridge_status, "sleeping");

'''
assert marker in e2e
e2e = e2e.replace(marker, insert, 1)
e2e_path.write_text(e2e)

test_path = Path('apps/backend-v2/test/scolia-bridge-ops.test.mjs')
test_path.write_text('''import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaBridgeRepository } from "../dist/mysql/scolia-bridge-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

test("bridge router activates canonical tournament boards without writing", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 1, next_start_at: null, next_activation_seconds: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", code: "board-7", name: "Board 7", board_number: 7, serial_number: "SERIAL-7", mode: "live", auto_fallback_to_manual: 1, force_connect_override: null, forward_messages_override: null, access_token: "secret", force_connect: 1, forward_messages_to_scolia: 0, disconnect_fallback_enabled: 1, test_kiosk_id: null, expires_at: null, active_test_kiosk_id: null }];
      return [];
    },
    async execute() { throw new Error("bridge router is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_prod_", "bd_prod_");
  const state = await repo.bridgeRouterState();
  assert.equal(state.bridge_mode, "active");
  assert.equal(state.configured_boards, 1);
  assert.equal(state.active_tournament_clubs, 1);
  assert.equal(state.boards.length, 1);
  assert.equal(state.boards[0].environment, "prod");
  assert.equal(state.boards[0].kiosk_id, "7");
  assert.equal(state.boards[0].access_token, "secret");
  assert.ok(queries.some((sql) => sql.includes("LEFT JOIN `bd_test_kiosks`")));
});

test("bridge router sends a leased physical board only to TEST runtime alias", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 0, next_start_at: null, next_activation_seconds: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", code: "prod-7", name: "Prod 7", board_number: 7, serial_number: "SERIAL-7", mode: "live", auto_fallback_to_manual: 1, force_connect_override: null, forward_messages_override: null, access_token: "secret", force_connect: 0, forward_messages_to_scolia: 0, disconnect_fallback_enabled: 1, test_kiosk_id: "17", expires_at: "2099-01-01 00:00:00", active_test_kiosk_id: "17", test_code: "test-17", test_name: "Test 17", test_board_number: 17 }];
      return [];
    },
    async execute() { throw new Error("bridge router is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  const state = await repo.bridgeRouterState();
  assert.equal(state.active_test_leases, 1);
  assert.equal(state.boards.length, 1);
  assert.equal(state.boards[0].environment, "test");
  assert.equal(state.boards[0].kiosk_id, "17");
  assert.equal(state.boards[0].physical_kiosk_id, "7");
  assert.equal(state.boards[0].force_connect, 1);
  assert.equal(state.boards[0].activation_reason, "test_lease");
});

test("bridge health reads the active runtime prefix and reports fresh connectivity", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 0, next_start_at: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", board_number: 7, name: "Prod 7", test_kiosk_id: "17", expires_at: "2099-01-01 00:00:00" }];
      if (sql.includes("FROM `bd_test_scolia_board_runtime`")) return [{ connection_state: "connected", board_status: "Ready", board_phase: "Throw", error_type: null, fallback_active: 0, needs_reconciliation: 0, last_bridge_heartbeat_at: "2099-01-01 00:00:00", last_event_at: "2099-01-01 00:00:00", heartbeat_age_seconds: 5 }];
      return [];
    },
    async execute() { throw new Error("bridge health is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  const state = await repo.bridgeHealthState(true);
  assert.equal(state.bridge_status, "online");
  assert.equal(state.bridge_required, true);
  assert.equal(state.connected_boards, 1);
  assert.equal(state.active_test_leases, 1);
  assert.equal(state.boards[0].route, "test");
  assert.equal(state.boards[0].heartbeat_fresh, true);
  assert.ok(queries.some((sql) => sql.includes("FROM `bd_test_scolia_board_runtime`")));
});
''')

Path('.github/workflows/tmp-scolia-bridge-ops-patch.yml').unlink()
Path('.github/tmp/apply_scolia_bridge_ops.py').unlink()
