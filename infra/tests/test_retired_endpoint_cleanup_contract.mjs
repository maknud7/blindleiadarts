import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/test-retired-endpoint-cleanup.yml", "utf8");

assert.match(workflow, /workflows:\s*\n\s*- Deploy Test/);
assert.match(workflow, /head_branch == 'develop'/);
assert.match(workflow, /environment: test/);
assert.match(workflow, /\/www\/blindleiadarts\/test\/api\/kiosk-scolia-test-lease\.php/);
assert.match(workflow, /\/www\/blindleiadarts\/test\/api\/scolia-bridge-control\.php/);
assert.doesNotMatch(workflow, /\/www\/blindleiadarts\/prod\//);
assert.match(workflow, /status" != "404"/);

console.log("Retired TEST endpoint cleanup contract OK");
