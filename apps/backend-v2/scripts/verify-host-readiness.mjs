import { pathToFileURL } from "node:url";

const REQUIRED_TABLES = [
  "bd_prod_matches",
  "bd_prod_legs",
  "bd_prod_visits",
  "bd_prod_match_statistics",
];

export async function verifyReadOnlyHost({ baseUrl, expectedReleaseSha, timeoutMs = 5000, fetchImpl = fetch }) {
  if (typeof expectedReleaseSha !== "string" || !/^[0-9a-f]{40}$/i.test(expectedReleaseSha)) {
    throw new TypeError("expectedReleaseSha must be a full 40-character Git SHA.");
  }

  const origin = normalizeBaseUrl(baseUrl);
  const [health, ready] = await Promise.all([
    readJson(fetchImpl, new URL("/health", origin), timeoutMs),
    readJson(fetchImpl, new URL("/ready", origin), timeoutMs),
  ]);

  assertEqual(health.ok, true, "health.ok");
  assertEqual(health.service, "blindleia-backend-v2", "health.service");
  assertEqual(health.environment, "prod", "health.environment");
  assertEqual(health.mode, "readonly", "health.mode");
  assertEqual(health.writes_armed, false, "health.writes_armed");
  assertEqual(health.canonical_side_effects_ready, true, "health.canonical_side_effects_ready");
  assertEqual(health.release_sha, expectedReleaseSha, "health.release_sha");
  assertEqual(health.runtime_prefix, "bd_prod_", "health.runtime_prefix");
  assertEqual(health.max_connections, 1, "health.max_connections");
  assertEqual(health.connection_mode, "idle-reuse", "health.connection_mode");

  assertEqual(ready.ok, true, "ready.ok");
  assertEqual(ready.service, "blindleia-backend-v2", "ready.service");
  assertEqual(ready.environment, "prod", "ready.environment");
  assertEqual(ready.mode, "readonly", "ready.mode");
  assertEqual(ready.writes_armed, false, "ready.writes_armed");
  assertEqual(ready.canonical_side_effects_ready, true, "ready.canonical_side_effects_ready");
  assertEqual(ready.release_sha, expectedReleaseSha, "ready.release_sha");
  assertEqual(ready.runtime_prefix, "bd_prod_", "ready.runtime_prefix");

  if (!Array.isArray(ready.checked_tables)) {
    throw new Error("ready.checked_tables must be an array.");
  }
  for (const table of REQUIRED_TABLES) {
    if (!ready.checked_tables.includes(table)) {
      throw new Error(`ready.checked_tables is missing ${table}.`);
    }
  }

  return {
    ok: true,
    release_sha: expectedReleaseSha,
    mysql_version: String(ready.mysql_version ?? "unknown"),
    checked_tables: [...ready.checked_tables],
  };
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("baseUrl is required.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("baseUrl must use http or https.");
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl must not contain credentials.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function readJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${url.pathname} did not return application/json.`);
  }
  const body = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${url.pathname} did not return a JSON object.`);
  }
  return body;
}

function assertEqual(actual, expected, field) {
  if (actual !== expected) {
    throw new Error(`${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new TypeError("Usage: verify-host-readiness.mjs --url <base-url> --release-sha <40-char-sha>");
    }
    args.set(key, value);
  }

  const result = await verifyReadOnlyHost({
    baseUrl: args.get("--url") ?? process.env.BD_BACKEND_V2_HOST_URL,
    expectedReleaseSha: args.get("--release-sha") ?? process.env.BD_BACKEND_V2_EXPECTED_RELEASE_SHA,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
