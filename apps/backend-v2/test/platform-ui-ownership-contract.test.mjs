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
  assert.match(adminCss, /#players \.member-access-summary\{display:grid!important/);
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
