import { test, expect } from "@playwright/test";

// This harness renders the ACTUAL React KioskWorkspace and its production CSS,
// but intercepts every /api/* request locally. No account, PROD pairing, TEST
// alias or database is created. Real hardware and mutation UAT remain separate.
const ORIGIN = "http://127.0.0.1:4173";

function fixture(options = {}) {
  return {
    kiosk: {
      id: 7,
      code: "QA-MANUAL",
      name: "Skive 1",
      board_number: 1,
      scoring_mode: "manual",
      club: { id: 3, name: "Blindleia Dartklubb", slug: "blindleia-dartklubb" },
    },
    active_tournament: { id: 10, name: "QA turnering med langt norsk navn", status: "in_progress" },
    match: {
      id: 42,
      status: options.matchStatus ?? "in_progress",
      current_leg: 1,
      current_player_id: options.currentPlayerId ?? 101,
      best_of_legs: options.bestOfLegs ?? 3,
      round_label: "Gruppespill - runde 1",
      player_a: { id: 101, display_name: options.playerAName ?? "Spiller A med et ekstraordinært langt navn", remaining: 301, legs_won: 0 },
      player_b: { id: 102, display_name: options.playerBName ?? "Spiller B med et tilsvarende langt navn", remaining: 321, legs_won: 0 },
      recent_visits: [
        { id: 1, player_id: 102, player_name: "Spiller B med et tilsvarende langt navn", visit_number: 2, score: 100, remaining_after: 321, darts_used: 3 },
        { id: 2, player_id: 101, player_name: "Spiller A med et ekstraordinært langt navn", visit_number: 2, score: 140, remaining_after: 301, darts_used: 3 },
        { id: 3, player_id: 102, player_name: "Spiller B med et tilsvarende langt navn", visit_number: 1, score: 80, remaining_after: 421, darts_used: 3 },
        { id: 4, player_id: 101, player_name: "Spiller A med et ekstraordinært langt navn", visit_number: 1, score: 60, remaining_after: 441, darts_used: 3 },
      ],
    },
  };
}

function pathOf(request) { return new URL(request.url()).pathname; }

async function startMockKiosk(browser, size, options = {}) {
  const context = await browser.newContext({
    viewport: size,
    hasTouch: true,
    isMobile: size.width < 540,
  });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((forcedSafe) => {
    localStorage.setItem("bd:kioskCode", "QA-MANUAL");
    localStorage.setItem("bd:kioskPairingToken", "qa-local-mock");
    if (forcedSafe) localStorage.setItem("bd:kioskSafeLayout", "1");
  }, Boolean(options.safeLayout));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    if (request.method() === "POST" && options.mockSuccessfulVisit && pathOf(request).endsWith("/visit")) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: {} }) });
      return;
    }
    if (request.method() !== "GET") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { message: "Read-only browser fixture: mutation blocked" } }),
      });
      return;
    }
    const path = new URL(request.url()).pathname;
    const data = path.endsWith("/health")
      ? { status: "ok", environment: "test" }
      : path.endsWith("/kiosks/QA-MANUAL/state") ? fixture(options) : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  const response = await page.goto(ORIGIN + "/v2/kiosk/", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByText(options.matchStatus === "assigned" ? "Start kamp" : "Registrer kast")).toBeVisible();
  await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", /^(fit|scroll)$/);
  return { context, page, requests, errors };
}

async function reachControl(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
}

for (const size of [
  { width: 500, height: 720 },
  { width: 600, height: 960 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 600 },
  { width: 1440, height: 900 },
]) {
  test(`mocked kiosk UI stays operable at ${size.width}x${size.height}`, async ({ browser }, testInfo) => {
    const { context, page, requests, errors } = await startMockKiosk(browser, size);
    try {
      const cramped = size.width < 540 || size.height < 790 || size.width > size.height;
      if (cramped) await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
      await expect(page.locator(".editable-visits-v2 .visit-editable-v2")).toHaveCount(4);

      const sum = page.getByRole("button", { name: "Sum", exact: true });
      const perDart = page.getByRole("button", { name: "Per pil", exact: true });
      expect((await reachControl(page, sum)).height).toBeGreaterThanOrEqual(44);
      expect((await reachControl(page, perDart)).height).toBeGreaterThanOrEqual(44);

      const key = page.locator(".keypad button").filter({ hasText: /^1$/ }).first();
      expect((await reachControl(page, key)).height).toBeGreaterThanOrEqual(44);
      await key.click();
      const submit = page.locator(".keypad button.primary");
      await reachControl(page, submit);

      await perDart.click();
      await expect(page.locator(".number-grid-v2")).toBeVisible();
      const bull = page.getByRole("button", { name: "Bull", exact: true });
      expect((await reachControl(page, bull)).height).toBeGreaterThanOrEqual(44);
      await bull.click();
      await reachControl(page, page.getByRole("button", { name: /Lagre kast/ }).last());

      const undo = page.getByRole("button", { name: "Angre siste kast" });
      await reachControl(page, undo);

      await page.screenshot({ path: testInfo.outputPath(`kiosk-${size.width}x${size.height}.png`), fullPage: false, timeout: 12000, animations: "disabled" });
      expect(errors, "No unhandled render exceptions").toEqual([]);
      expect(requests.every((r) => r.method === "GET"), "No backend mutations in browser visual QA").toBe(true);
    } finally {
      await context.close();
    }
  });
}

test("safe layout can be manually forced and survives reload on same tablet", async ({ browser }) => {
  const { context, page, errors } = await startMockKiosk(browser, { width: 768, height: 1024 });
  try {
    await page.getByRole("button", { name: "Innstillinger" }).first().click();
    const safe = page.getByRole("button", { name: "Vis alle knapper (sikker visning)" });
    await safe.click();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
    await page.reload();
    await expect(page.getByText("Registrer kast")).toBeVisible();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "scroll");
    await page.getByRole("button", { name: "Innstillinger" }).first().click();
    await page.getByRole("button", { name: "Bruk automatisk visning" }).click();
    await expect(page.locator(".kiosk-shell")).toHaveAttribute("data-kiosk-layout", "fit");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});


test("best av 1 shows match format but not leg standings, with an obvious thrower", async ({ browser }) => {
  const { context, page, requests, errors } = await startMockKiosk(browser, { width: 768, height: 1024 }, { bestOfLegs: 1 });
  try {
    await expect(page.locator(".match-best-of")).toHaveText("Best av 1");
    await expect(page.locator(".match-leg-score")).toHaveCount(0);
    await expect(page.locator(".player-leg-score")).toHaveCount(0);
    await expect(page.locator(".player-tile.active .turn-indicator")).toHaveText("Kaster");
    await expect(page.locator(".player-tile:not(.active) .turn-indicator")).toBeHidden();
    await expect(page.locator(".match-tools .pill.good")).toHaveText("Live");
    await expect(page.locator(".kiosk-topbar .v2-top-actions .pill")).toContainText("Skive 1");
    expect(await page.locator(".match-tools").innerText()).not.toContain("Skive 1");
    const { activeBackground, inactiveBackground, activeBorder } = await page.locator(".versus").evaluate(el => {
      const a = getComputedStyle(el.querySelector(".player-tile.active"));
      const b = getComputedStyle(el.querySelector(".player-tile:not(.active)"));
      return { activeBackground: a.backgroundColor, inactiveBackground: b.backgroundColor, activeBorder: a.borderLeftWidth };
    });
    expect(activeBackground).not.toBe(inactiveBackground);
    expect(Number.parseFloat(activeBorder)).toBeGreaterThanOrEqual(5);
    expect(page.locator(".player-tile.active")).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(requests.every((req) => req.method === "GET")).toBe(true);
  } finally { await context.close(); }
});

test("best av 3 shows leg number and standings; active side follows current thrower", async ({ browser }) => {
  const { context, page, errors } = await startMockKiosk(browser, { width: 500, height: 720 }, { bestOfLegs: 3, currentPlayerId: 102 });
  try {
    await expect(page.locator(".match-best-of")).toHaveText("Best av 3");
    await expect(page.locator(".match-current-leg")).toHaveText("Leg 1");
    await expect(page.locator(".match-leg-score")).toHaveText("0 – 0");
    await expect(page.locator(".player-leg-score")).toHaveCount(2);
    await expect(page.locator(".player-tile").nth(1)).toHaveClass(/active/);
    await expect(page.locator(".player-tile").nth(1).locator(".turn-indicator")).toHaveText("Kaster");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("saving a throw keeps keypad, save action and recent visits fixed in place", async ({ browser }) => {
  // All writes below are intercepted by this local Playwright fixture, never sent to a backend.
  const { context, page, requests, errors } = await startMockKiosk(browser, { width: 768, height: 1024 }, { bestOfLegs: 1, mockSuccessfulVisit: true });
  try {
    await page.getByRole("button", { name: "Per pil" }).click();
    const save = page.locator(".dart-entry-actions .save-visit-button");
    const undo = page.locator(".dart-entry-actions .button.secondary");
    const grid = page.locator(".number-grid-v2");
    const visits = page.locator(".visits");
    const key = grid.getByRole("button", { name: "1", exact: true });
    await key.click();
    await expect(save).toBeEnabled();
    expect((await save.boundingBox()).height).toBeGreaterThanOrEqual(58);
    expect((await save.boundingBox()).width).toBeGreaterThan((await undo.boundingBox()).width);
    const before = await Promise.all([grid, save, visits].map(locator => locator.boundingBox()));
    await save.click();
    await expect(page.locator('.match-view[aria-busy="true"]')).toBeVisible();
    // The former inline "Lagrer X kast" notice physically shortened the score controls.
    await expect(page.locator(".kiosk-card > .kiosk-pending-notice")).toHaveCount(0);
    const during = await Promise.all([grid, save, visits].map(locator => locator.boundingBox()));
    for (let index = 0; index < before.length; index += 1) {
      expect(Math.abs(before[index].y - during[index].y), "Control " + index + " cannot move while saving").toBeLessThanOrEqual(1);
      expect(Math.abs(before[index].height - during[index].height), "Control " + index + " cannot resize while saving").toBeLessThanOrEqual(1);
    }
    await expect(page.locator('.match-view[aria-busy="true"]')).toHaveCount(0, { timeout: 10000 });
    expect(requests.some(request => request.method === "POST" && request.path.endsWith("/visit"))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("both long names are shortened visually without losing full accessible identity", async ({ browser }) => {
  const first = "Magnus Nicolai Flørenæs Knudsen";
  const second = "Kristian Aleksander Julius Mellestad";
  for (const size of [{ width: 500, height: 720 }, { width: 768, height: 1024 }]) {
    const { context, page, errors } = await startMockKiosk(browser, size, { playerAName: first, playerBName: second });
    try {
      const left = page.locator(".match-view .player-tile").first().locator("h2");
      const right = page.locator(".match-view .player-tile").last().locator("h2");
      await expect(left).toHaveText("Magnus Knudsen");
      await expect(right).toHaveText("Kristian Mellestad");
      await expect(left).toHaveAttribute("title", first);
      await expect(right).toHaveAttribute("title", second);
      await expect(left).toHaveAttribute("aria-label", first);
      await expect(right).toHaveAttribute("aria-label", second);
      const nameFits = await page.locator(".match-view .player-tile h2").evaluateAll(headings => headings.every(h => h.scrollWidth <= h.clientWidth + 1 && h.scrollHeight <= h.clientHeight + 1));
      expect(nameFits, "Both compact names should fit within their score cards").toBe(true);
      const inactive = page.locator(".player-tile:not(.active) .turn-indicator");
      await expect(inactive).toBeHidden();
      await expect(page.getByText("Venter", { exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});

test("very long two-part names abbreviate the first name while preserving full name", async ({ browser }) => {
  const full = "Alexandermaksimilian Konstantinopoulos";
  const { context, page, errors } = await startMockKiosk(browser, { width: 500, height: 720 }, { playerAName: full });
  try {
    const heading = page.locator(".match-view .player-tile").first().locator("h2");
    await expect(heading).toHaveText("A. Konstantinopoulos");
    await expect(heading).toHaveAttribute("aria-label", full);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("assigned match uses the same shortened names and no duplicate board number", async ({ browser }) => {
  const first = "Magnus Nicolai Flørenæs Knudsen";
  const second = "Kristian Aleksander Julius Mellestad";
  const { context, page, errors } = await startMockKiosk(browser, { width: 768, height: 1024 }, {
    matchStatus: "assigned",
    playerAName: first,
    playerBName: second,
  });
  try {
    await expect(page.locator(".assigned-view .match-tools .pill.good")).toHaveText("Kamp klar");
    await expect(page.locator(".assigned-view .player-tile").first().locator("h2")).toHaveText("Magnus Knudsen");
    await expect(page.locator(".assigned-view .player-tile").last().locator("h2")).toHaveText("Kristian Mellestad");
    expect(await page.locator(".assigned-view .match-tools").innerText()).not.toContain("Skive 1");
    await expect(page.locator(".kiosk-topbar .v2-top-actions .pill")).toContainText("Skive 1");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
