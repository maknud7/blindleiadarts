import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/test-retired-endpoint-cleanup.yml", "utf8");

assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- develop/);
assert.doesNotMatch(workflow, /workflow_run:/);
assert.match(workflow, /actions: read/);
assert.match(workflow, /actions\/workflows\/deploy-test\.yml\/runs\?head_sha=/);
assert.match(workflow, /conclusion" == "success"/);
assert.match(workflow, /release\.json\?cb=/);
assert.match(workflow, /environment: test/);
assert.match(workflow, /\/www\/blindleiadarts\/test\/api\/kiosk-scolia-test-lease\.php/);
assert.match(workflow, /\/www\/blindleiadarts\/test\/api\/scolia-bridge-control\.php/);
assert.match(workflow, /\/www\/blindleiadarts\/test\/api\/kiosk-scolia-ui\.php/);
assert.doesNotMatch(workflow, /\/www\/blindleiadarts\/prod\//);
assert.match(workflow, /status" != "404"/);
assert.match(workflow, /\/api\/kiosk-scolia-ui\.php/);

console.log("Retired TEST endpoint cleanup contract OK");
