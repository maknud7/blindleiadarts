import assert from "node:assert/strict";
import fs from "node:fs";

const application = fs.readFileSync("apps/api/src/Application.php", "utf8");
const screenReadme = fs.readFileSync("apps/screen/README.md", "utf8");
const screenIndex = fs.readFileSync("apps/screen/index.html", "utf8");

assert.doesNotMatch(application, /GET \/v1\/public\/screen/);
assert.doesNotMatch(application, /POST \/v1\/public\/screen\/connect/);
assert.doesNotMatch(application, /\$path === 'v1\/public\/screen'/);
assert.doesNotMatch(application, /\$path === 'v1\/public\/screen\/connect'/);

assert.match(application, /GET \/v1\/clubs\/\{id\}\/screen-devices/);
assert.match(application, /POST \/v1\/clubs\/\{id\}\/screen-devices/);

assert.match(screenReadme, /standalone \/screen\/ venue display has been retired/i);
assert.match(screenReadme, /\/live\/ is now the single canonical wall\/public live surface/i);
assert.match(screenIndex, /url=\.\.\/live\//);
assert.match(screenIndex, /window\.location\.replace\(target\.toString\(\)\)/);

console.log("Retired public screen API contract OK");
