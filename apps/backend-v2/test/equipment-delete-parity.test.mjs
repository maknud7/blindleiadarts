import assert from "node:assert/strict";
import test from "node:test";

import { MySqlEquipmentAdminRepository } from "../dist/mysql/equipment-admin-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

function fakeDb(matchCount = 0) {
  const executed = [];
  return {
    executed,
    async query(sql) {
      if (sql.includes("SELECT id,club_id,code,name") && sql.includes("FROM `bd_prod_kiosks`")) {
        return [{ id: "9", club_id: "1", code: "BOARD-9", name: "Skive 9", board_number: 9, scoring_mode: "scolia", is_active: 1 }];
      }
      if (sql.includes("SELECT COUNT(*) AS c FROM `bd_prod_matches`")) return [{ c: String(matchCount) }];
      return [];
    },
    async execute(sql, params = []) {
      executed.push({ sql, params });
      if (sql.includes("DELETE FROM `bd_prod_kiosks`")) return { affectedRows: 1, insertId: 0 };
      return { affectedRows: 1, insertId: 0 };
    },
  };
}

test("board delete refuses canonical match history", async () => {
  const db = fakeDb(2);
  const repository = new MySqlEquipmentAdminRepository(new FakeSessions(db), "bd_prod_", "bd_prod_");
  await assert.rejects(
    () => repository.deleteBoard("1", "9"),
    (error) => error?.code === "board_has_match_history" && error?.statusCode === 409,
  );
  assert.ok(!db.executed.some(({ sql }) => sql.includes("DELETE FROM `bd_prod_kiosks`")));
});

test("safe board delete clears references before canonical hardware row", async () => {
  const db = fakeDb(0);
  const repository = new MySqlEquipmentAdminRepository(new FakeSessions(db), "bd_prod_", "bd_prod_");
  assert.equal(await repository.deleteBoard("1", "9"), true);

  const statements = db.executed.map(({ sql }) => sql);
  for (const table of ["tournament_board_reservations", "tournament_kiosks", "kiosk_sessions"]) {
    assert.ok(statements.some((sql) => sql.includes("DELETE FROM `bd_prod_" + table + "`")));
  }
  assert.ok(statements.some((sql) => sql.includes("UPDATE `bd_prod_kiosk_pairing_requests` SET approved_kiosk_id=NULL")));
  const boardDeleteIndex = statements.findIndex((sql) => sql.includes("DELETE FROM `bd_prod_kiosks`"));
  assert.ok(boardDeleteIndex > 0);
});
