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

test("canonical admin Utstyr navigation never silently switches to v2", () => {
  const nav = read("apps/platform-v2/src/shared/PlatformNav.tsx");
  const shell = read("packages/ui-assets/portal-menu.js");
  const adminPage = read("apps/admin/index.html");
  assert.match(nav, /canonicalEquipment: "\/#equipment"/);
  assert.match(nav, /equipmentHref = testHost \? routes\.equipment : routes\.canonicalEquipment/);
  assert.match(nav, /Utstyr · Klubbadmin/);
  assert.match(adminPage, /kiosks: "equipment"/);
  assert.match(shell, /equipment: "kiosks"/);
  assert.match(shell, /clearStaleNavigationOverlay\(\{ closeDrawer: true \}\)/);
  assert.match(shell, /menu\.removeAttribute\("inert"\)/);
  assert.match(shell, /overlay\.hidden = true/);
});

test("equipment refreshes are parallel and Scolia background polling cannot block section changes", () => {
  const admin = read("apps/admin/app.js");
  const scolia = read("apps/admin/scolia-admin.js");
  assert.match(admin, /const \[boardResult, pairingResult\] = await Promise\.allSettled/);
  assert.match(admin, /state\.kiosks = boardResult\.value\.items \|\| \[\]/);
  assert.match(admin, /timeoutMs: 10000/);
  assert.match(scolia, /controller\?\.signal\.aborted/);
  assert.match(scolia, /if \(loading \|\| !onEquipment \|\| document\.hidden/);
  assert.match(scolia, /\}, 15000\)/);
  assert.doesNotMatch(scolia, /\}, 5000\)/);
});

test("user-guide observer must never monitor the entire admin document subtree", () => {
  const guide = read("packages/ui-assets/user-guide-access.js");
  const menu = read("packages/ui-assets/portal-menu.js");
  assert.doesNotMatch(guide, /observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
  assert.match(guide, /observer\.observe\(observedRoot, \{ childList: true \}\)/);
  assert.match(guide, /menuObserver\.observe\(guideMenu, \{ childList: true \}\)/);
  assert.match(guide, /node\.id === "unifiedMobileBottomNav"/);
  assert.match(guide, /window\.requestAnimationFrame\(/);
  assert.match(menu, /user-guide-access\.js\?v=20261103-equipment-freeze-03/);
});

test("terminal pairing decoration cannot recursively invoke its own MutationObserver", () => {
  const terminal = read("apps/admin/terminal-pairing-ux.js");
  const bundle = read("apps/admin/pairing-claim.js");
  const loader = read("apps/admin/admin-section-loader.js");
  const adminHtml = read("apps/admin/index.html");
  assert.doesNotMatch(terminal, /window\.queueMicrotask\(decorateDynamicCopy\)/);
  assert.doesNotMatch(terminal, /window\.queueMicrotask\(decorateBoardEditor\)/);
  assert.match(terminal, /observer\.observe\(kioskSection, \{ childList: true, subtree: true \}\)/);
  assert.match(terminal, /editorObserver\.observe\(editorRoot, \{ childList: true, subtree: true \}\)/);
  assert.match(terminal, /window\.requestAnimationFrame/);
  assert.match(terminal, /record\.addedNodes, \.\.\.record\.removedNodes/);
  assert.doesNotMatch(terminal, /attributeFilter: \["class"\]/);
  assert.match(bundle, /terminal-pairing-ux\.js\?v=20261104-terminal-ux-freeze-01/);
  assert.match(loader, /pairing-claim\.js\?v=20261104-terminal-ux-freeze-01/);
  assert.match(adminHtml, /admin-section-loader\.js\?v=20261105-ui-cleanup-01/);
});

test("TEST legacy equipment hash cannot be hijacked into V2 without an explicit click", () => {
  const router = read("apps/admin/platform-v2-test-routing.js");
  assert.match(router, /Åpne Utstyr v2 \(TEST\)/);
  assert.match(router, /link\.href = ROUTES\.equipment/);
  assert.doesNotMatch(router, /redirectLegacyEquipmentRoute/);
  assert.doesNotMatch(router, /window\.location\.assign\(ROUTES\.equipment\)/);
  assert.doesNotMatch(router, /window\.location\.replace\(ROUTES\.equipment\)/);
  assert.doesNotMatch(router, /setAttribute\("href", ROUTES\.equipment\)/);
});
