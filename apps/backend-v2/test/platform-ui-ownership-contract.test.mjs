import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("member register reads are cancellable, bounded and recoverable", () => {
  const members = read("apps/admin/member-onboarding-admin.js");
  assert.match(members, /const controller=method==="GET"\?new AbortController\(\):null/);
  assert.match(members, /controller\.abort\(\),12000/);
  assert.match(members, /memberListController\?\.abort\(\)/);
  assert.match(members, /revision!==memberListRevision/);
  assert.match(members, /member-retry-load/);
  assert.match(members, /if\(document\.body\.dataset\.portalActive==="players"\)load\(true\)/);
  assert.doesNotMatch(members, /loadLinkConfig\(\)\.catch\(\(\)=>null\);load\(true\)/);
});

test("members dashboard remains visible on mobile", () => {
  const adminCss = read("apps/admin/admin-ux.css");
  assert.doesNotMatch(adminCss, /\.member-access-summary\{display:none!important\}/);
  const membersCss = read("apps/admin/member-onboarding-admin.css");
  assert.doesNotMatch(adminCss, /#players \.member-access-summary\{display:grid!important/);
  assert.match(membersCss, /#players \.member-access-summary\{display:grid!important/);
  assert.doesNotMatch(read("apps/admin/member-onboarding-admin.js"), /style\.textContent=`/);
  assert.match(read("apps/admin/index.html"), /Betaling vises som status/);
});

test("navigation has one owner for route changes, and lazy failures can retry", () => {
  const menu = read("packages/ui-assets/unified-portal-shell.js");
  const loader = read("apps/admin/admin-section-loader.js");
  assert.doesNotMatch(menu, /if \(surface === "admin"\) window\.setTimeout\(syncMenu, 0\)/);
  assert.match(menu, /window\.addEventListener\("bd:portal-view", \(\) => \{\s*syncMobileBottomNav\(\)/);
  assert.match(loader, /failedModuleAttempts/);
  assert.match(loader, /url\.searchParams\.set\("moduleRetry", String\(attempt\)\)/);
  assert.match(loader, /loadedModules\.delete\(path\)/);
  assert.match(loader, /status\.replaceChildren\(message, retry\)/);
});

test("a single owned presentation layer replaces late Live, kiosk and player CSS patches", () => {
  const live = read("apps/live/index.html");
  const kiosk = read("apps/kiosk/index.html");
  const player = read("apps/player/index.html");
  assert.match(live, /venue-wall-current[.]css/);
  for (let n = 5; n <= 10; n += 1) assert.doesNotMatch(live, new RegExp("venue-wall-v" + n + "[.]css"));
  assert.match(kiosk, /kiosk-state-actions[.]css/);
  for (const old of ["state-visibility-fix.css", "tablet-action-row-fix.css", "mode-switch-visibility-fix.css"]) {
    assert.doesNotMatch(kiosk, new RegExp(old.replace(".", "[.]")));
  }
  assert.match(read("apps/kiosk/service-worker.js"), /kiosk-state-actions[.]css/);
  assert.doesNotMatch(player, /player-card-polish[.]css/);
  assert.match(player, /player-design-system[.]css/);
  assert.match(read("apps/live/venue-wall-current.css"), /Former venue-wall-v10[.]css/);
  assert.doesNotMatch(read("packages/ui-assets/portal-menu.js"), /style[.]textContent = `/);
  assert.doesNotMatch(read("packages/ui-assets/unified-portal-shell.js"), /ensureRuntimeStyles/);
  const shell = read("packages/ui-assets/unified-portal-shell.css");
  assert.match(shell, /[.]portal-view-hidden\{display:none!important\}/);
  assert.match(shell, /[.]unified-group-label[.]admin[.]club-admin/);

});
