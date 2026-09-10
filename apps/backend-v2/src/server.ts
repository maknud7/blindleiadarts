import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ScoringSource } from "./contracts/canonical-scoring.js";
import { asDbId, type DbId, type VisitInput } from "./contracts/scoring.js";
import { DomainValidationError } from "./domain/errors.js";
import { MySqlCanonicalScoringRepository } from "./mysql/canonical-scoring-repository.js";
import { MySqlCanonicalScoringState } from "./mysql/canonical-scoring-state.js";
import { MySqlCoreOnlyMutationGuard } from "./mysql/core-only-mutation-guard.js";
import { MySql2SessionProvider } from "./mysql/mysql2-session-provider.js";
import {
  assertInternalToken,
  assertMutationAllowed,
  loadRuntimeConfig,
  mutationsAllowed,
  RuntimeAccessError,
} from "./runtime/config.js";
import { CoreOnlyCanonicalSideEffects } from "./runtime/core-only-side-effects.js";
import { BackendScoringPreflight } from "./runtime/preflight.js";
import { CanonicalScoringService } from "./service/canonical-scoring-service.js";

const config = loadRuntimeConfig();
const sessions = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: mutationsAllowed(config),
});
const scoringRepository = new MySqlCanonicalScoringRepository(sessions, config.prefixes.runtime);
const scoringState = new MySqlCanonicalScoringState(sessions, config.prefixes.runtime);
const coreOnlyMutationGuard = new MySqlCoreOnlyMutationGuard(sessions, config.prefixes.runtime);
const coreOnlySideEffects = new CoreOnlyCanonicalSideEffects(scoringState);
const scoring = new CanonicalScoringService(
  scoringRepository,
  scoringState,
  coreOnlySideEffects,
  coreOnlySideEffects,
  coreOnlySideEffects,
  coreOnlySideEffects,
);
const preflight = new BackendScoringPreflight(sessions, config.prefixes.runtime);

const server = createServer(async (request, response) => {
  try {
    await dispatch(request, response);
  } catch (error) {
    sendError(response, error);
  }
});

async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://backend-v2.internal");

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "blindleia-backend-v2",
      environment: config.environment,
      mode: config.mode,
      writes_armed: mutationsAllowed(config),
      canonical_side_effects_ready: config.canonicalSideEffectsReady,
      release_sha: config.releaseSha,
      runtime_prefix: config.prefixes.runtime,
      max_connections: config.mysql.budget.maxConcurrentConnections,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/ready") {
    const result = await preflight.run();
    sendJson(response, 200, {
      ...result,
      service: "blindleia-backend-v2",
      environment: config.environment,
      mode: config.mode,
      writes_armed: mutationsAllowed(config),
      canonical_side_effects_ready: config.canonicalSideEffectsReady,
      release_sha: config.releaseSha,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/internal/v1/scoring/start-match") {
    const { kioskId, source } = await scoringCommandContext(request);
    await coreOnlyMutationGuard.assertAllowed(kioskId, "start");
    const result = await scoring.startMatch({ kiosk_id: kioskId, source });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (method === "POST" && url.pathname === "/internal/v1/scoring/visit") {
    assertInternalToken(config, header(request, "x-bd-backend-v2-token"));
    assertMutationAllowed(config);
    const body = await readJsonObject(request);
    const kioskId = asDbId(requiredString(body, "kiosk_id"));
    const source = scoringSource(body.source);
    const payload = body.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new DomainValidationError("invalid_visit_payload", "Scoring payload must be a JSON object.");
    }

    await coreOnlyMutationGuard.assertAllowed(kioskId, "visit");
    const result = await scoring.recordVisit({
      kiosk_id: kioskId,
      source,
      payload: payload as VisitInput,
    });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (method === "POST" && url.pathname === "/internal/v1/scoring/undo") {
    const { kioskId, source } = await scoringCommandContext(request);
    await coreOnlyMutationGuard.assertAllowed(kioskId, "undo");
    const result = await scoring.undoLastVisit({ kiosk_id: kioskId, source });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "route_not_found", message: "Backend v2 route was not found." },
  });
}

async function scoringCommandContext(request: IncomingMessage): Promise<{ kioskId: DbId; source: ScoringSource }> {
  assertInternalToken(config, header(request, "x-bd-backend-v2-token"));
  assertMutationAllowed(config);
  const body = await readJsonObject(request);
  return {
    kioskId: asDbId(requiredString(body, "kiosk_id")),
    source: scoringSource(body.source),
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof RuntimeAccessError || error instanceof DomainValidationError) {
    sendJson(response, error.statusCode, {
      ok: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("backend-v2 request failed", error);
  sendJson(response, 500, {
    ok: false,
    error: {
      code: "internal_server_error",
      message: "Unexpected backend v2 server error.",
      ...(config.environment === "prod" ? {} : { details: message }),
    },
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) {
      throw new RuntimeAccessError(413, "request_too_large", "Backend v2 request body exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RuntimeAccessError(400, "invalid_json", "Request body must contain valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeAccessError(400, "invalid_json_object", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeAccessError(400, "invalid_request", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function scoringSource(value: unknown): ScoringSource {
  if (value === undefined) return "api";
  if (value === "manual" || value === "scolia" || value === "import" || value === "api") return value;
  throw new RuntimeAccessError(400, "invalid_source", "source must be manual, scolia, import or api.");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event: "backend_v2_started",
    environment: config.environment,
    mode: config.mode,
    writes_armed: mutationsAllowed(config),
    canonical_side_effects_ready: config.canonicalSideEffectsReady,
    host: config.host,
    port: config.port,
    max_connections: config.mysql.budget.maxConcurrentConnections,
    release_sha: config.releaseSha,
  }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ event: "backend_v2_shutdown", signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
