import { test, expect } from "@playwright/test";
import fs from "node:fs";

const ORIGIN = "http://127.0.0.1:4185";
const MATCH_ID = "9007199254740997";
const HOME_ID = "9007199254740993";
const TARGET_ID = "9007199254740995";

async function mountTournamentOperations(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  const moves = [];
  const operations = {
    tournament: { id: "55", name: "QA turnering", status: "in_progress", club_slug: "blindleia-dartklubb", auto_assign_enabled: 0 },
    progress: { completed: 1, total: 5, assigned: 1, in_progress: 1, pending: 2, percent: 20 },
    boards: [
      { id: HOME_ID, board_number: 1, name: "Hjemskive", active_match_id: MATCH_ID, active_match_status: "in_progress", player_a_name: "Spiller A", player_b_name: "Spiller B" },
      { id: TARGET_ID, board_number: 2, name: "Ledig skive", active_match_id: null },
      { id: "9007199254740996", board_number: 3, active_match_id: "66", active_match_status: "in_progress", player_a_name: "Andre A", player_b_name: "Andre B" },
      { id: "9007199254740998", board_number: 4, active_match_id: null, reservation: { player_a_name: "Reservert A", player_b_name: "Reservert B", remaining_seconds: 20 } },
    ],
    queue: { items: [
      { id: MATCH_ID, status: "in_progress", kiosk_id: HOME_ID, board_number: 1, player_a_name: "Spiller A", player_b_name: "Spiller B", round_label: "Gruppe A · kamp 1" },
    ] },
  };
  const selection = {
    boards: [
      { id: HOME_ID, board_number: 1, name: "Hjemskive", selected: true, is_active: true, is_busy: true, is_reserved: false },
      { id: TARGET_ID, board_number: 2, name: "Ledig skive", selected: true, is_active: true, is_busy: false, is_reserved: false },
      { id: "9007199254740996", board_number: 3, selected: true, is_active: true, is_busy: true, is_reserved: false },
      { id: "9007199254740998", board_number: 4, selected: true, is_active: true, is_busy: false, is_reserved: true },
    ],
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/tournament-operations-admin.css", async (route) => {
    await route.fulfill({ contentType: "text/css", body: fs.readFileSync("apps/admin/tournament-operations-admin.css", "utf8") });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let data;
    if (req.method() === "POST" && path.endsWith(`/operations/matches/${MATCH_ID}/move`)) {
      const body = req.postDataJSON();
      moves.push(body);
      operations.queue.items[0].kiosk_id = TARGET_ID;
      operations.queue.items[0].board_number = 2;
      operations.boards[0].active_match_id = null;
      operations.boards[1].active_match_id = MATCH_ID;
      selection.boards[0].is_busy = false;
      selection.boards[1].is_busy = true;
      data = { moved: true };
    } else if (req.method() !== "GET") {
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Unexpected mutation" } }) });
      return;
    } else if (path.endsWith("/registration-tournaments")) {
      data = { items: [{ id: "55", name: "QA turnering", status: "in_progress" }] };
    } else if (path.endsWith("/operations/boards")) {
      data = selection;
    } else if (path.endsWith("/operations")) {
      data = operations;
    } else {
      data = {};
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  await page.goto(ORIGIN + "/v2/ops-ui-fixture", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("bd:token", "mock-operator-token");
    localStorage.setItem("bd:selectedClubId", "7");
  });
  await page.setContent('<div id="tournaments"></div><select id="clubSelect"><option value="7">Blindleia</option></select>');
  await page.addScriptTag({ content: fs.readFileSync("apps/admin/tournament-operations-admin.js", "utf8") });
  await expect(page.locator("#opsQueue .ops-match-row")).toBeVisible();
  return { page, context, moves, errors, operations, selection };
}

test("tournament move: explicit target, persistent selection, active match confirmation", async ({ browser }, testInfo) => {
  const { page, context, moves, errors } = await mountTournamentOperations(browser);
  try {
    await expect(page.locator(".ops-board-state.available")).toContainText("Ledig");
    await expect(page.locator(".ops-board-state.busy")).toContainText("Pågår");
    await expect(page.locator(".ops-board-state.reserved")).toContainText("Reservert");

    const target = page.locator(`select[data-move-target="${MATCH_ID}"]`);
    const button = page.locator(`button[data-move-match="${MATCH_ID}"]`);
    await expect(target).toHaveValue("");
    await expect(button).toBeDisabled();
    await expect(target.locator("option")).toHaveCount(2); // placeholder + Skive 2 only

    await target.selectOption(TARGET_ID);
    await expect(button).toBeEnabled();
    await expect(page.locator(".ops-move-preview")).toContainText("skive 1 → Skive 2");

    await page.locator("#opsRefresh").click();
    await expect(target).toHaveValue(TARGET_ID);
    await expect(button).toBeEnabled();

    page.once("dialog", (dialog) => dialog.dismiss());
    await button.click();
    expect(moves).toHaveLength(0);
    await expect(button).toBeEnabled();

    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    await expect(page.locator("#opsMessage")).toContainText("Kampen er flyttet fra skive 1 til Skive 2");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({ kiosk_id: TARGET_ID, confirm_in_progress: true });

    await page.screenshot({ path: testInfo.outputPath("tournament-move-mobile.png"), animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
