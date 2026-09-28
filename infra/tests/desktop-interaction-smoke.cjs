const { chromium } = require("playwright");

const base = String(process.env.BASE_URL || "https://test.blindleiadarts.ingenting.org").replace(/\/$/, "");
const viewport = { width: 1440, height: 900 };

function responseData(pathname) {
  const path = pathname.replace(/^\/api\/v1\/?/, "");
  if (path === "auth/me") {
    return {
      user: {
        id: "900000000000000001",
        email: "desktop-smoke@example.invalid",
        display_name: "Desktop Smoke",
        role: "super_admin",
        player: { id: "900000000000000002", club_id: "1", name: "Desktop Smoke" },
        admin_club_ids: ["1"],
      },
    };
  }
  if (path === "activity/session") {
    return { session: { id: 999001 } };
  }
  if (path === "clubs") {
    return { items: [{ id: "1", slug: "blindleia-dartklubb", name: "Blindleia Dartklubb" }] };
  }
  if (path === "me/dashboard") {
    return {
      dashboard: {
        registrations: [],
        tournaments: [],
        active_tournament: null,
        next_match: null,
        player: { id: "900000000000000002", club_id: "1", name: "Desktop Smoke" },
      },
    };
  }
  if (path === "me/eligibility") return { eligibility: null };
  if (/^clubs\/1\/(?:players|tournaments|screen-devices|kiosks|kiosk-pairing-requests|registration-tournaments|match-calls|player-directory|elo|summaries|seasons)$/.test(path)) {
    return { club_id: "1", items: [] };
  }
  if (path === "clubs/1/dashboard") return { club: { id: "1", name: "Blindleia Dartklubb" } };
  if (path === "realtime/config") return { enabled: false };
  if (/^seasons\/\d+(?:\/standings)?$/.test(path)) return { season: null, items: [] };
  if (/^players\/\d+\/(?:profile|matches|elo-tournaments)$/.test(path)) return { items: [] };
  if (/^tournaments\/\d+\/(?:tables|results|summary|live-highlights)$/.test(path)) return { items: [] };
  return { items: [] };
}

async function installApiStubs(page) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const data = responseData(url.pathname);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data }),
      headers: { "cache-control": "no-store" },
    });
  });
}

async function inspectInteraction(page, label) {
  const result = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const desc = (el) => {
      if (!el) return null;
      return {
        tag: el.tagName,
        id: el.id || "",
        class: typeof el.className === "string" ? el.className : "",
        hidden: !!el.hidden,
        inert: !!el.inert,
        pointerEvents: getComputedStyle(el).pointerEvents,
        position: getComputedStyle(el).position,
        opacity: getComputedStyle(el).opacity,
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      };
    };

    const blockers = [...document.querySelectorAll("body *")].filter((el) => {
      if (!visible(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === "none") return false;
      const r = el.getBoundingClientRect();
      const covers = r.width >= vw * 0.88 && r.height >= vh * 0.88;
      return covers && ["fixed", "absolute", "sticky"].includes(cs.position);
    }).map(desc);

    const inert = [...document.querySelectorAll("[inert]")].filter(visible).map(desc);

    const points = [
      [Math.round(vw * .25), Math.round(vh * .25)],
      [Math.round(vw * .5), Math.round(vh * .25)],
      [Math.round(vw * .75), Math.round(vh * .25)],
      [Math.round(vw * .5), Math.round(vh * .5)],
      [Math.round(vw * .5), Math.round(vh * .75)],
    ].map(([x,y]) => ({ x, y, hit: desc(document.elementFromPoint(x,y)) }));

    const nav = [...document.querySelectorAll(".portal-menu a, [data-portal-nav], .unified-mobile-bottom-nav a, .unified-mobile-bottom-nav button")]
      .filter(visible)
      .slice(0, 24)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(vw - 1, Math.round(r.left + r.width / 2)));
        const y = Math.max(0, Math.min(vh - 1, Math.round(r.top + r.height / 2)));
        const hit = document.elementFromPoint(x,y);
        const ancestors = [];
        let node = el;
        while (node && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          const nr = node.getBoundingClientRect();
          ancestors.push({
            tag: node.tagName,
            id: node.id || "",
            class: typeof node.className === "string" ? node.className : "",
            inert: !!node.inert,
            inertAttr: node.hasAttribute?.("inert") || false,
            ariaHidden: node.getAttribute?.("aria-hidden"),
            pointerEvents: cs.pointerEvents,
            visibility: cs.visibility,
            display: cs.display,
            position: cs.position,
            zIndex: cs.zIndex,
            overflow: cs.overflow,
            transform: cs.transform,
            rect: { x: Math.round(nr.x), y: Math.round(nr.y), w: Math.round(nr.width), h: Math.round(nr.height) },
          });
          node = node.parentElement;
        }
        return {
          target: desc(el),
          hit: desc(hit),
          hitInsideTarget: !!hit && (hit === el || el.contains(hit)),
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
          ancestors,
        };
      });

    return {
      surface: document.body.dataset.bdSurface || "",
      portalActive: document.body.dataset.portalActive || "",
      bodyClass: document.body.className,
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      blockers,
      inert,
      points,
      nav,
    };
  });

  console.log("\n=== " + label + " ===");
  console.log(JSON.stringify(result, null, 2));

  const badNav = result.nav.filter((item) => !item.hitInsideTarget);
  const failures = [];
  if (result.blockers.length) failures.push("full-screen pointer blocker(s): " + JSON.stringify(result.blockers));
  if (badNav.length) failures.push("navigation hit-test blocked: " + JSON.stringify(badNav));
  if (result.bodyPointerEvents === "none") failures.push("body has pointer-events:none");
  return failures;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.addInitScript(() => {
    localStorage.setItem("bd:token", "desktop-smoke-token");
    localStorage.setItem("bd:playerClubId", "1");
    localStorage.setItem("bd:selectedClubId", "1");
  });
  await installApiStubs(page);

  const failures = [];
  for (const [label, hash] of [
    ["Player home", "#home"],
    ["Player tournaments", "#tournaments"],
    ["Player statistics", "#statistics"],
    ["Player profile", "#profile"],
  ]) {
    await page.goto(base + "/" + hash, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    const pageFailures = await inspectInteraction(page, label);
    failures.push(...pageFailures.map((message) => label + ": " + message));
  }

  // Reproduce the actual cross-surface transition: player -> admin.
  await page.goto(base + "/#home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  const adminLink = page.locator('a[href="#club"], a[href$="#club"], #adminPortalLink').filter({ visible: true }).first();
  if (await adminLink.count()) {
    await adminLink.click();
    await page.waitForLoadState("domcontentloaded");
  } else {
    await page.goto(base + "/#club", { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await page.waitForTimeout(1500);
  await page.waitForSelector('body[data-bd-surface="admin"]', { timeout: 10000 });
  await page.waitForSelector('#adminApp:not(.hidden)', { timeout: 10000 });
  {
    const label = "Admin overview after player->admin transition";
    const pageFailures = await inspectInteraction(page, label);
    failures.push(...pageFailures.map((message) => label + ": " + message));
  }

  const adminRoutes = [
    ["Admin tournaments", "#tournament-admin"],
    ["Admin seasons", "#seasons"],
    ["Admin players", "#playerbase"],
    ["Admin members", "#members"],
    ["Admin equipment", "#equipment"],
    ["Admin settings", "#settings"],
    ["Admin superadmin", "#superadmin"],
  ];
  for (const [label, hash] of adminRoutes) {
    await page.goto(base + "/" + hash, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.waitForSelector('body[data-bd-surface="admin"]', { timeout: 10000 });
    await page.waitForSelector('#adminApp:not(.hidden)', { timeout: 10000 });
    const pageFailures = await inspectInteraction(page, label);
    failures.push(...pageFailures.map((message) => label + ": " + message));
  }

  if (consoleErrors.length) {
    console.log("\nBrowser console errors:");
    console.log(consoleErrors.join("\n"));
  }

  await browser.close();
  if (failures.length) {
    console.error("\nDESKTOP_INTERACTION_SMOKE_FAILED");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }
  console.log("\nDESKTOP_INTERACTION_SMOKE_OK");
}

main().catch((error) => {
  console.error("\nDESKTOP_INTERACTION_SMOKE_FAILED");
  console.error(error?.stack || error);
  process.exit(1);
});
