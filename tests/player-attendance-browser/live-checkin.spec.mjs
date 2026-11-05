import { test, expect } from "@playwright/test";
import fs from "node:fs";

const LIVE_PAGE = "http://127.0.0.1:4191/live/?club=blindleia-dartklubb";
// Use actual production HTML and application JavaScript. Remove bootstrapping
// and stylesheet network imports, then inject the local CSS and Live app
// directly. Every API call is mocked: no TEST or PROD data is touched.
const html = fs.readFileSync("apps/live/index.html", "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, "");

function roster({ method = "admin_only", code = null, checked = 2 } = {}) {
  return {
    active: true,
    checkin: {
      tournament_id: "9999", tournament_name: "Mandagsserien", method,
      code, code_missing: method !== "admin_only" && !code, code_allowed: Boolean(code),
      start_at: "2026-11-09 18:30:00", participant_count: 3,
      checked_in_count: checked, waitlisted_count: 1,
      participants: [
        { player_id: "1", display_name: "Ada", status: "checked_in" },
        { player_id: "2", display_name: "Ben", status: checked >= 2 ? "checked_in" : "registered" },
        { player_id: "3", display_name: "Cam", status: checked >= 3 ? "checked_in" : "registered" },
        { player_id: "4", display_name: "Dan", status: "waitlisted" },
      ],
    },
  };
}

async function boot(page, mock) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/live/" || url.pathname === "/live") {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Test Live</title>" });
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const result = mock(url.pathname);
      if (result instanceof Error) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: result.message } }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: result }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(LIVE_PAGE, { waitUntil: "domcontentloaded" });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  // Some Playwright/CDP versions reject injected style-tag load events on
  // document.write() fixtures. Append exact source via native DOM instead.
  const css = ["apps/live/styles.css", "apps/live/checkin.css", "apps/live/mobile.css"]
    .map((path) => fs.readFileSync(path, "utf8"));
  await page.evaluate((sheets) => {
    for (const sheet of sheets) {
      const element = document.createElement("style");
      element.textContent = sheet;
      document.head.appendChild(element);
    }
  }, css);
  await page.evaluate((source) => {
    const script = document.createElement("script");
    script.textContent = source;
    document.body.appendChild(script);
  }, fs.readFileSync("apps/live/app.js", "utf8"));
}

test("Admin-only registration appears on actual Live HTML and refreshes without roster rebuild", async ({ page }) => {
  let current = roster();
  await boot(page, (path) => {
    if (path.includes("/check-in-display")) return current;
    if (path.endsWith("/realtime/config")) return { enabled: false };
    return { tournament: { status: "draft" } };
  });
  await expect(page.locator("#checkinCount")).toHaveText("2 av 3 sjekket inn", { timeout: 10000 });
  await expect(page.locator("#checkinCode")).toHaveText("Hos turneringsleder");
  await expect(page.locator("#checkinUpdatedAt")).toContainText("Oppdatert kl.");
  await expect(page.locator("#checkinParticipants .checkin-person")).toHaveCount(4);
  await page.evaluate(() => document.querySelector("#checkinParticipants .checkin-person").dataset.qaPersistence = "kept");
  await page.waitForTimeout(3300);
  await expect(page.locator("#checkinParticipants .checkin-person").first()).toHaveAttribute("data-qa-persistence", "kept");
  current = roster({ checked: 3 });
  await expect(page.locator("#checkinCount")).toHaveText("3 av 3 sjekket inn", { timeout: 9000 });
  await expect(page.locator("#checkinParticipants .checked-in")).toHaveCount(3);
});

test("Live never represents stale cached attendance as freshly updated after 502", async ({ page }) => {
  let failure = false;
  let current = roster({ method: "admin_or_code", code: "ABC" });
  await boot(page, (path) => {
    if (path.includes("/check-in-display")) return failure ? new Error("Temporary 502") : current;
    if (path.endsWith("/realtime/config")) return { enabled: false };
    return { tournament: { status: "draft" } };
  });
  await expect(page.locator("#checkinCode")).toHaveText("ABC", { timeout: 10000 });
  failure = true;
  await expect(page.locator("#checkinUpdatedAt")).toContainText("Oppdatering forsinket", { timeout: 9500 });
  await expect(page.locator("#checkinCount")).toHaveText("2 av 3 sjekket inn");
  failure = false;
  current = roster({ method: "admin_or_code", code: "ABC", checked: 3 });
  await expect(page.locator("#checkinCount")).toHaveText("3 av 3 sjekket inn", { timeout: 9500 });
  await expect(page.locator("#checkinUpdatedAt")).not.toContainText("Oppdatering forsinket");
});

test("Check-in wall is readable on a phone, including a misconfigured code fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, (path) => {
    if (path.includes("/check-in-display")) return roster({ method: "code", code: null });
    if (path.endsWith("/realtime/config")) return { enabled: false };
    return { tournament: { status: "draft" } };
  });
  await expect(page.locator("#checkinCode")).toHaveText("Hos turneringsleder", { timeout: 10000 });
  await expect(page.locator("#checkinLead")).toContainText("ikke konfigurert");
  const size = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    code: document.getElementById("checkinCodeCard").getBoundingClientRect().width,
  }));
  expect(size.document).toBeLessThanOrEqual(size.viewport + 2);
  expect(size.code).toBeLessThan(size.viewport);
});
