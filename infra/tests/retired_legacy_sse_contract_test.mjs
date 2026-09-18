import assert from "node:assert/strict";
import fs from "node:fs";

const application = fs.readFileSync("apps/api/src/Application.php", "utf8");
const liveApp = fs.readFileSync("apps/live/app.js", "utf8");

assert.doesNotMatch(application, /GET \/v1\/clubs\/\{id\}\/live/);
assert.doesNotMatch(application, /GET \/v1\/kiosks\/\{code\}\/live/);
assert.doesNotMatch(application, /handleStreamRequest/);
assert.doesNotMatch(application, /streamJsonEvents/);
assert.doesNotMatch(application, /text\/event-stream/);

assert.match(liveApp, /\/public\/clubs\/\$\{encodeURIComponent\(clubSlug\)\}\/live/);
assert.match(liveApp, /\/public\/check-in-display/);
assert.match(liveApp, /new WebSocket\(config\.websocket_url\)/);
assert.match(liveApp, /setInterval\(\(\) => load\(\)\.catch/);

console.log("Retired legacy SSE contract OK");
