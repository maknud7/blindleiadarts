import { test, expect } from "@playwright/test";

const URL = "http://127.0.0.1:4191/admin/";
const fixture = `<!doctype html><html lang="no"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body data-portal-active="tournaments"><div id="tournaments"><div class="tc-workspace">
  <div class="tc-phase-nav"><button type="button" data-tc-view="checkin">Innsjekk</button><button type="button" data-tc-view="format" disabled>Format</button></div>
  <div id="tcMessage" class="message hidden"></div>
  <div id="tcStageCheckin"><div class="tc-stage-head"><h3>Hvem er her?</h3></div>
    <div id="tcNextTitle"></div><div id="tcNextText"></div><div id="tcRegistrations"></div>
    <button id="tcToFormat" type="button">Gå videre til format</button>
  </div>
  <div id="tcStageFormat"><div id="tcRecommendation"></div><div id="tcStartWarning"></div><button id="tcStart">Start turnering</button></div>
</div></div></body></html>`;

function people() {
  return [
    { player_id: "1", display_name: "Ada", status: "checked_in" },
    { player_id: "2", display_name: "Ben", status: "checked_in" },
    { player_id: "3", display_name: "Cam", status: "registered" },
    { player_id: "4", display_name: "Dan", status: "waitlisted" },
  ];
}

async function boot(page, { onFinish } = {}) {
  const state = { status: "draft", registrations: people(), writes: [] };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>Leader QA" });
    if (url.pathname.endsWith("/api/v1/tournaments/99")) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { tournament: {
          id: 99, name: "Mandagsserien", status: state.status, registrations: state.registrations,
        } } }) });
    }
    if (url.pathname.endsWith("/api/v1/tournaments/99/finish-checkin")) {
      const body = JSON.parse(route.request().postData() || "{}");
      state.writes.push(body);
      if (onFinish) {
        const outcome = onFinish(body, state);
        if (outcome?.error) return route.fulfill({ status: 409, contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "attendance_changed_since_confirmation", message: outcome.error } }) });
      }
      state.status = "ready";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true,
        data: { attendance: { status: "ready", checked_in_count: 2, no_show_count: 1, withdrawn_waitlist_count: 1 } } }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.setContent(fixture);
  await page.evaluate(() => {
    localStorage.setItem("bd:token", "qa-admin");
    window.__bdTournamentContext = { id: 99, status: "draft", view: "checkin" };
  });
  await page.addScriptTag({ path: "apps/admin/tournament-canonical-ux.js" });
  await expect(page.locator("#tcToFormat")).toBeEnabled({ timeout: 10000 });
  return state;
}

test("Leader sees exact no-shows and can cancel without a mutation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await boot(page);
  await page.locator("#tcToFormat").click();
  const modal = page.locator("#tcFinishAttendanceConfirm");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Cam");
  await expect(modal).toContainText("Venteliste");
  await expect(modal).toContainText("Dette kan ikke angres");
  expect(state.writes).toHaveLength(0);
  await modal.getByRole("button", { name: "Tilbake til innsjekk" }).click();
  await expect(modal).not.toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.locator("#tcToFormat").click();
  await modal.getByRole("button", { name: "Bekreft avslutning" }).click();
  await expect(page.locator("#tcMessage")).toContainText("ikke møtt");
  expect(state.writes).toEqual([{ checked_in_count: 2, not_checked_in_count: 1, waitlisted_count: 1 }]);
});

test("Leader gets explicit 409 and preserves draft if attendance changes during preflight", async ({ page }) => {
  const state = await boot(page, {
    onFinish: (body, state) => {
      if (body.checked_in_count !== state.registrations.filter((p) => p.status === "checked_in").length) {
        return { error: "Oppmøtet har endret seg. Oppdater listen og bekreft avslutningen på nytt." };
      }
      return null;
    },
  });
  await page.locator("#tcToFormat").click();
  await expect(page.locator("#tcFinishAttendanceConfirm")).toBeVisible();
  state.registrations = state.registrations.map((player) => player.player_id === "3"
    ? { ...player, status: "checked_in" } : player);
  await page.locator("#tcFinishAttendanceConfirm").getByRole("button", { name: "Bekreft avslutning" }).click();
  await expect(page.locator("#tcMessage")).toContainText("Oppmøtet har endret seg");
  expect(state.status).toBe("draft");
  expect(state.writes).toHaveLength(1);
});
