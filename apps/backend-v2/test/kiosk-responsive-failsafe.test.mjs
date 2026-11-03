import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("kiosk responsive safety overrides load last and preserve prior tablet CSS", () => {
  const main = read("apps/platform-v2/src/kiosk/main.tsx");
  const original = main.indexOf('import "./kiosk-tablet.css"');
  const interactions = main.indexOf('import "./kiosk-interactions.css"');
  const edit = main.indexOf('import "./recent-visit-editor.css"');
  const safe = main.indexOf('import "./kiosk-responsive-failsafe.css"');
  assert.ok(original >= 0 && interactions > original && edit > interactions && safe > edit);
});

test("kiosk viewport hook uses actual measured dimensions and offers stable scroll fallback", () => {
  const hook = read("apps/platform-v2/src/kiosk/useKioskViewportSafety.ts");
  const workspace = read("apps/platform-v2/src/kiosk/KioskWorkspace.tsx");
  assert.match(hook, /window\.visualViewport\?\.height/);
  assert.match(hook, /ResizeObserver/);
  assert.doesNotMatch(hook, /MutationObserver/, "kiosk layout stays within React state architecture");
  assert.match(hook, /useEffect\(\(\) => \{\s*refreshRef\.current\(\);\s*\}, \[contentKey\]\)/);
  assert.match(hook, /window\.visualViewport\?\.addEventListener\("resize"/);
  assert.match(hook, /height < 790/);
  assert.match(hook, /element\.scrollHeight > element\.clientHeight \+ 3/);
  assert.match(hook, /root\.dataset\.kioskLayout = "scroll"/);
  assert.match(hook, /if \(root\.dataset\.kioskLayout === "scroll"\) return/);
  assert.match(workspace, /useKioskViewportSafety\(viewportContentKey\)/);
  assert.match(workspace, /ref=\{kioskViewportRef\}/);
});

test("clipped kiosk scoring controls and all four recent visits remain reachable", () => {
  const css = read("apps/platform-v2/src/kiosk/kiosk-responsive-failsafe.css");
  const base = read("apps/platform-v2/src/kiosk/kiosk-tablet.css");
  assert.match(base, /overflow: hidden/);
  assert.match(css, /\.kiosk-shell\[data-kiosk-layout="scroll"\] \.kiosk-main/);
  assert.match(css, /\.kiosk-shell\[data-kiosk-layout="scroll"\] \.score-entry/);
  assert.match(css, /\.kiosk-shell\[data-kiosk-layout="scroll"\] \.manual-dart-entry/);
  assert.match(css, /touch-action: pan-y/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.visits \.editable-visits-v2 > \.visit-editable-v2:nth-child\(n\)/);
  assert.match(css, /@media \(max-width: 479px\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /grid-template-rows: repeat\(5, minmax\(44px, 1fr\)\)/);
});

test("each physical terminal can force safe mode without changing any backend or PROD hardware", () => {
  const storage = read("apps/platform-v2/src/shared/storage.ts");
  const hook = read("apps/platform-v2/src/kiosk/useKioskViewportSafety.ts");
  const workspace = read("apps/platform-v2/src/kiosk/KioskWorkspace.tsx");
  assert.match(storage, /kioskSafeLayout: "bd:kioskSafeLayout"/);
  assert.match(hook, /read\("kioskSafeLayout"\) === "1"/);
  assert.match(hook, /STORAGE_EVENT/);
  assert.match(workspace, /Vis alle knapper \(sikker visning\)/);
  assert.match(workspace, /Bruk automatisk visning/);
  assert.match(workspace, /write\("kioskSafeLayout", next \? "1" : null\)/);
});

test("kiosk cannot advance to another match until canonical post-match result confirmed", () => {
  const workspace = read("apps/platform-v2/src/kiosk/KioskWorkspace.tsx");
  assert.match(workspace, /if \(!completion\?\.confirmed \|\| manualQueueDepth > 0 \|\| manualQueueError\) return/);
  assert.match(workspace, /if \(!kioskCode \|\| !completion\?\.confirmed \|\| manualQueueDepth > 0/);
  assert.match(workspace, /confirmed: Boolean\(data\.last_completed_match\)/);
  assert.match(workspace, /completion\.confirmed \? "KAMP FERDIG" : "AVVENTER RESULTAT"/);
  assert.match(workspace, /Lagrer \{manualQueueDepth\} kast/);
  assert.doesNotMatch(workspace, /if \(next === 0\) window\.setTimeout\(\(\) => void finishCompletion/);
});

test("PROD kiosk is only an existing entry point; v2 TEST code loads in TEST iframe", () => {
  const launcher = read("apps/kiosk/prod-test-entry.js");
  const handoff = read("apps/platform-v2/src/kiosk/testHandoff.ts");
  assert.match(launcher, /new URL\("\/v2\/kiosk\/".*testOrigin\(\)\)/);
  assert.match(launcher, /target\.searchParams\.set\("testmode", "1"\)/);
  assert.match(launcher, /frame\.src = target\.href/);
  assert.match(handoff, /if \(!freshLaunch && !activeSession\) return redirectToProd\(\)/);
  assert.match(handoff, /read\("testMode"\) === "1"/);
});
