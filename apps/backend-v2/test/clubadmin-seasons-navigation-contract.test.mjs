import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const adminHtml = fs.readFileSync("apps/admin/index.html", "utf8");
const rootHtml = fs.readFileSync("index.html", "utf8");
const shell = fs.readFileSync("packages/ui-assets/admin-shell-v2.js", "utf8");
const portalMenu = fs.readFileSync("packages/ui-assets/portal-menu.js", "utf8");
const season = fs.readFileSync("apps/admin/season-admin.js", "utf8");
const unified = fs.readFileSync("packages/ui-assets/unified-portal-shell.js", "utf8");

test("Klubbadmin has exactly one permanent Sesonger navigation entry", () => {
  const matches = [...adminHtml.matchAll(/<a href="#seasons" data-portal-nav>Sesonger<\/a>/g)];
  assert.equal(matches.length, 1);
  assert.ok(adminHtml.indexOf('href="#tournaments" data-portal-nav') < matches[0].index);
  assert.ok(matches[0].index < adminHtml.indexOf('href="#players" data-portal-nav'));
  assert.match(unified, /getAdminLocalLinks\(\)/);
  assert.match(unified, /markClubAdminLinks\(localLinks\)/);
});

test("Season module is loaded before canonical menu and resolves to deployed URL", () => {
  const entry = /<script src="\.\/season-admin\.js\?v=[^"]+" type="module"><\/script>/;
  const nav = /<script src="\.\.\/packages\/ui-assets\/portal-menu\.js\?v=[^"]+" type="module"><\/script>/;
  assert.match(adminHtml, entry);
  assert.match(adminHtml, nav);
  assert.ok(adminHtml.search(entry) < adminHtml.search(nav));
  assert.match(shell, /\.\.\/\.\.\/admin\/season-admin\.js\?v=/);
  assert.doesNotMatch(shell, /\.\.\/\.\.\/apps\/admin\/season-admin\.js/);
  const relativePath = shell.match(/\.\.\/\.\.\/admin\/season-admin\.js\?v=[^"]+/)?.[0];
  assert.equal(new URL(relativePath, "https://test.blindleiadarts.ingenting.org/packages/ui-assets/admin-shell-v2.js").pathname, "/admin/season-admin.js");
  assert.match(season, /section\.id = "seasons"/);
  assert.match(season, /section\.dataset\.portalSection = "seasons"/);
});

test("Canonical admin routes still enforce role guard and use fresh assets", () => {
  assert.match(rootHtml, /if \(route\.surface === "admin" && !app\.session\.isAdmin\(user\)\)/);
  assert.match(rootHtml, /const VERSION = "20261116-independent-elo-01"/);
  assert.match(portalMenu, /admin-shell-v2\.js\?v=20261116-season-nav-01/);
  assert.match(portalMenu, /seasons: "seasons"/);
});
