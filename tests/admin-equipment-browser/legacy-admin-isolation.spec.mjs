import { test, expect } from "@playwright/test";

// Diagnostic-only variant with deliberately suppressed, non-essential menu
// modules. It tells us which optional module creates a UI lock when the
// canonical board list changes. All backend APIs are locally mocked.
const BASE = "http://127.0.0.1:4186";
for (const [label, disabled] of [
  ["without guide modules", ["user-guide.js", "user-guide-access.js"]],
  ["without session badge", ["session-badge.js"]],
  ["without unified sidebar", ["unified-portal-shell.js"]],
  ["without guide, badge and sidebar", ["user-guide.js", "user-guide-access.js", "session-badge.js", "unified-portal-shell.js"]],
]) {
  test(label + ": equipment navigation does not starve browser", async ({ browser }) => {
    test.setTimeout(16000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        localStorage.setItem("bd:token", "qa-logged-in-club-admin");
        localStorage.setItem("bd:selectedClubId", "7");
        // Diagnostic only: instrument and cap runaway DOM observer callbacks
        // to reveal their source without leaving the browser unusable.
        const Native = window.MutationObserver;
        const stats = [];
        window.__qaObserverCounts = stats;
        window.MutationObserver = class extends Native {
          constructor(callback) {
            const id = stats.length;
            stats.push({ id, count: 0, stack: (new Error().stack || "").slice(0, 600) });
            super((records, observer) => {
              const row = stats[id];
              row.count += 1;
              if (row.count > 100) {
                row.disconnected = true;
                observer.disconnect();
                return;
              }
              callback(records, observer);
            });
          }
        };
      });
      await page.route("**/packages/ui-assets/**", async (route) => {
        const name = new URL(route.request().url()).pathname.split("/").pop();
        if (disabled.includes(name)) {
          await route.fulfill({ status: 200, contentType: "text/javascript", body: "export default {};" });
        } else await route.continue();
      });
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const data = path.endsWith("/auth/me")
          ? { user: { id: 10, role: "club_admin", player: { club_id: 7 } } }
          : path.endsWith("/clubs")
            ? { items: [{ id: 7, name: "Blindleia Dartklubb" }] }
            : path.endsWith("/kiosks")
              ? { items: [{ id: 3, code: "QA-3", name: "Skive 3", board_number: 3, scoring_mode: "manual", is_active: 1 }] }
              : { items: [], progress: {}, queue: { items: [] } };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
      });
      await page.goto(BASE + "/#club", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#adminApp")).toBeVisible({ timeout: 5000 });
      await page.locator(".portal-menu a[href='#kiosks']").first().click({ timeout: 3000 });
      await expect(page).toHaveURL(/#equipment$/);
      await expect(page.locator("#kioskList .board-row")).toHaveCount(1, { timeout: 4000 });
      const counts = await page.evaluate(() => window.__qaObserverCounts);
      console.log("Observer diagnostics", label, JSON.stringify(counts));
      const heartbeat = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(document.body.dataset.portalActive))));
      expect(heartbeat).toBe("kiosks");
      await page.locator(".portal-menu a[href='#players']").first().click({ timeout: 3000 });
      await expect(page).toHaveURL(/#members$/);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}
