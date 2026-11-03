import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
function moveFixture() {
  const source = read("apps/admin/tournament-operations-admin.js");
  const from = source.indexOf("  const selectedMoveTargets = new Map();");
  const to = source.indexOf("  function render() {", from);
  assert.ok(from > -1 && to > from, "move UI helper source exists");
  const state = {
    boardSelection: {
      boards: [
        { id: "9007199254740993", board_number: 1, selected: true, is_active: true, is_busy: false, is_reserved: false },
        { id: "9007199254740995", board_number: 2, name: "Ledig", selected: true, is_active: true, is_busy: false, is_reserved: false },
        { id: "9007199254740996", board_number: 3, selected: true, is_active: true, is_busy: true, is_reserved: false },
        { id: "9007199254740998", board_number: 4, selected: true, is_active: true, is_busy: false, is_reserved: true },
      ],
    },
  };
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const data = vm.runInNewContext(source.slice(from, to) + "\n({ renderMove, selectedMoveTargets, movableBoards });", { state, esc });
  return { ...data, state };
}

test("equipment read-only requests have finite deadline and reusable UI on errors", () => {
  const shared = read("apps/platform-v2/src/shared/api.ts");
  const equipment = read("apps/platform-v2/src/equipment/EquipmentWorkspace.tsx");
  const scolia = read("apps/platform-v2/src/equipment/ScoliaPanel.tsx");
  const editor = read("apps/platform-v2/src/equipment/BoardEditor.tsx");
  assert.match(shared, /timeoutMs\?: number/);
  assert.match(shared, /controller\.abort\(\)/);
  assert.match(shared, /window\.clearTimeout\(timeout\)/);
  assert.match(equipment, /timeoutMs: 12000/);
  assert.match(equipment, /Prøv igjen/);
  assert.match(equipment, /Oppdaterer utstyrsstatus/);
  assert.match(scolia, /timeoutMs: 8000/);
  assert.match(editor, /timeoutMs: 8000/);
  assert.doesNotMatch(shared, /retry.*fetch\(/i);
});

test("legacy admin does not react to its own delete buttons in equipment observer", () => {
  const source = read("apps/admin/equipment-admin-ux.js");
  assert.match(source, /node\.matches\?\.\(".board-row,.screen-row"\)/);
  assert.match(source, /if \(!rowsChanged \|\| pending\) return/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /if \(!state\.screenIds\.size\) await loadScreenIds/);
});

test("tournament move has no silently preselected destination and preserves exact BIGINT IDs", () => {
  const { renderMove, movableBoards } = moveFixture();
  const match = { id: "9007199254740997", kiosk_id: "9007199254740993", board_number: 1, status: "in_progress" };
  const options = movableBoards(match);
  assert.equal(options.length, 1);
  assert.equal(String(options[0].id), "9007199254740995");
  const html = renderMove(match);
  assert.match(html, /value="">Velg ledig skive/);
  assert.match(html, /data-move-match="9007199254740997" disabled/);
  assert.doesNotMatch(html, /9007199254740996"/);
  assert.doesNotMatch(html, /9007199254740998"/);
  assert.match(html, /Velg en ledig skive/);
});

test("intentional match destination survives polling and invalid target is rejected", () => {
  const { state, selectedMoveTargets, renderMove } = moveFixture();
  const match = { id: "9007199254740997", kiosk_id: "9007199254740993", board_number: 1, status: "assigned" };
  selectedMoveTargets.set(String(match.id), "9007199254740995");
  let html = renderMove(match);
  assert.match(html, /value="9007199254740995" selected/);
  assert.match(html, /skive 1 → Skive 2/);
  // Simulated periodic refresh must retain the chosen target, never reset it.
  html = renderMove({ ...match, player_a_name: "Oppdatert navn" });
  assert.match(html, /value="9007199254740995" selected/);
  state.boardSelection.boards[1].is_reserved = true;
  html = renderMove(match);
  assert.match(html, /Ingen ledig skive/);
  assert.equal(selectedMoveTargets.has(String(match.id)), false);
});

test("successful move is not re-sent after read refresh failure", () => {
  const source = read("apps/admin/tournament-operations-admin.js");
  assert.match(source, /let committed = false/);
  assert.match(source, /committed = true/);
  assert.match(source, /Flyttingen til .* er lagret, men oversikten kunne ikke oppdateres/);
  assert.match(source, /confirm_in_progress: confirmInProgress/);
  assert.match(source, /if \(!tournamentId \|\| !match \|\| !kioskId \|\| !targetBoard\)/);
  assert.match(source, /el\.opsQueue\.addEventListener\("change"/);
  assert.match(source, /el\.opsQueue\.addEventListener\("click"/);
  assert.match(source, /document\.activeElement\?\.matches\?\./);
});
