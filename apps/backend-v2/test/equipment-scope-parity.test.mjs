import assert from "node:assert/strict";
import test from "node:test";

import { EquipmentAdminRouter } from "../dist/runtime/equipment-admin-router.js";

const scope = {
  configuration_scope: "production_hardware",
  shared_across_environments: true,
  configuration_table_prefix: "bd_prod_",
  runtime_table_prefix: "bd_test_",
};

function makeRouter() {
  const equipment = {
    async listBoards(clubId, includeInactive) {
      return [{ id: "9", club_id: clubId, board_number: 1, include_inactive: includeInactive }];
    },
    scope() {
      return scope;
    },
  };
  const identity = {
    async findBySessionToken() {
      return { id: "1", role: "super_admin", admin_club_ids: "" };
    },
  };
  const config = {
    environment: "test",
    prefixes: { runtime: "bd_test_", identity: "bd_prod_", hardware: "bd_prod_" },
  };
  return new EquipmentAdminRouter(config, identity, equipment, {}, {});
}

function request(headers = {}) {
  return { headers };
}

test("public kiosk board list preserves legacy top-level hardware scope", async () => {
  const result = await makeRouter().handle("GET", "/v1/clubs/7/kiosks", request());

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.club_id, "7");
  assert.deepEqual(result.payload.items, [{ id: "9", club_id: "7", board_number: 1, include_inactive: false }]);
  assert.deepEqual(
    {
      configuration_scope: result.payload.configuration_scope,
      shared_across_environments: result.payload.shared_across_environments,
      configuration_table_prefix: result.payload.configuration_table_prefix,
      runtime_table_prefix: result.payload.runtime_table_prefix,
    },
    scope,
  );
});

test("admin equipment board list preserves the same top-level hardware scope", async () => {
  const result = await makeRouter().handle(
    "GET",
    "/v1/clubs/7/equipment/boards",
    request({ authorization: "Bearer equipment-scope-test" }),
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.club_id, "7");
  assert.deepEqual(result.payload.items, [{ id: "9", club_id: "7", board_number: 1, include_inactive: true }]);
  assert.deepEqual(
    {
      configuration_scope: result.payload.configuration_scope,
      shared_across_environments: result.payload.shared_across_environments,
      configuration_table_prefix: result.payload.configuration_table_prefix,
      runtime_table_prefix: result.payload.runtime_table_prefix,
    },
    scope,
  );
});
