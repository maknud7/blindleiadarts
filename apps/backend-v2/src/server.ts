import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ScoringSource } from "./contracts/canonical-scoring.js";
import { asDbId, type DbId, type VisitInput } from "./contracts/scoring.js";
import { DomainValidationError } from "./domain/errors.js";
import { MySqlAccountProfileRepository } from "./mysql/account-profile-repository.js";
import { MySqlCanonicalEloLedger } from "./mysql/canonical-elo-ledger.js";
import { MySqlCanonicalPlayoffReconciliation } from "./mysql/canonical-playoff-reconciliation.js";
import { MySqlCanonicalScoringRepository } from "./mysql/canonical-scoring-repository.js";
import { MySqlCanonicalScoringState } from "./mysql/canonical-scoring-state.js";
import { MySqlEquipmentAdminRepository } from "./mysql/equipment-admin-repository.js";
import { MySqlIdentityAuthRepository, type IdentityUser } from "./mysql/identity-auth-repository.js";
import { MySqlLinearRankingProjection } from "./mysql/linear-ranking-projection.js";
import { MySqlMembershipEligibilityRepository } from "./mysql/membership-eligibility-repository.js";
import { MySql2SessionProvider } from "./mysql/mysql2-session-provider.js";
import { MySqlPlayerLiveReadRepository } from "./mysql/player-live-read-repository.js";
import { MySqlPublicLiveReadRepository } from "./mysql/public-live-read-repository.js";
import { MySqlSeasonPublicReadRepository } from "./mysql/season-public-read-repository.js";
import { MySqlScoliaAdminRepository } from "./mysql/scolia-admin-repository.js";
import { MySqlScoliaBridgeRepository } from "./mysql/scolia-bridge-repository.js";
import { MySqlScoliaDashboardRepository } from "./mysql/scolia-dashboard-repository.js";
import { MySqlScoliaKioskAuthRepository } from "./mysql/scolia-kiosk-auth-repository.js";
import { MySqlScoliaKioskRuntimeRepository } from "./mysql/scolia-kiosk-runtime-repository.js";
import { MySqlTournamentEloProjection } from "./mysql/tournament-elo-projection.js";
import { MySqlTournamentFlowRepository } from "./mysql/tournament-flow-repository.js";
import { MySqlTournamentOperationsRepository } from "./mysql/tournament-operations-repository.js";
import { MySqlTournamentPlayoffRepository } from "./mysql/tournament-playoff-repository.js";
import { MySqlTournamentRuntimeRepository } from "./mysql/tournament-runtime-repository.js";
import { CanonicalRealtimePublisher } from "./runtime/canonical-realtime-publisher.js";
import {
  assertIdentityMutationAllowed,
  assertInternalToken,
  assertMutationAllowed,
  loadRuntimeConfig,
  mutationsAllowed,
  RuntimeAccessError,
} from "./runtime/config.js";
import { EquipmentAdminRouter } from "./runtime/equipment-admin-router.js";
import { PlayerLiveReadRouter } from "./runtime/player-live-read-router.js";
import { BackendScoringPreflight } from "./runtime/preflight.js";
import { PublicLiveReadRouter } from "./runtime/public-live-read-router.js";
import { SeasonPublicReadRouter } from "./runtime/season-public-read-router.js";
import { ScoliaRuntimeRouter } from "./runtime/scolia-runtime-router.js";
import { TournamentOperationsRouter } from "./runtime/tournament-operations-router.js";
import { TournamentRealtimePublisher } from "./runtime/tournament-realtime-publisher.js";
import { TournamentRuntimeRouter } from "./runtime/tournament-runtime-router.js";
import { CanonicalScoringService } from "./service/canonical-scoring-service.js";
import { IdentityAuthService } from "./service/identity-auth-service.js";
import { ScoliaEventProcessor } from "./service/scolia-event-processor.js";

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
  connectionReuse: "idle-reuse",
  idleConnectionTimeoutMs: config.mysql.idleConnectionTimeoutMs,
});
const scoringRepository = new MySqlCanonicalScoringRepository(sessions, config.prefixes.runtime);
const scoringState = new MySqlCanonicalScoringState(sessions, config.prefixes.runtime);
const playoffs = new MySqlCanonicalPlayoffReconciliation(sessions, config.prefixes.runtime);
const elo = new MySqlCanonicalEloLedger(sessions, config.prefixes.runtime);
const tournamentElo = new MySqlTournamentEloProjection(sessions, config.prefixes.runtime);
const ranking = new MySqlLinearRankingProjection(sessions, config.prefixes.runtime);
const realtime = new CanonicalRealtimePublisher(
  sessions,
  config.prefixes.runtime,
  {
    publishUrl: config.realtime.publishUrl,
    publishSecret: config.realtime.publishSecret,
    timeoutMs: config.realtime.timeoutMs,
  },
  globalThis.fetch.bind(globalThis),
  { warn: (message, details) => console.warn(message, details) },
);
const scoring = new CanonicalScoringService(
  scoringRepository,
  scoringState,
  playoffs,
  elo,
  tournamentElo,
  ranking,
  realtime,
);
const identityRepository = new MySqlIdentityAuthRepository(
  sessions,
  config.prefixes.runtime,
  config.prefixes.identity,
);
const identityAuth = new IdentityAuthService(identityRepository);
const accountProfiles = new MySqlAccountProfileRepository(
  sessions,
  config.prefixes.runtime,
  config.prefixes.identity,
);
const playerLiveReads = new MySqlPlayerLiveReadRepository(sessions, config.prefixes.runtime);
const playerLiveRuntime = new PlayerLiveReadRouter(config, identityRepository, playerLiveReads);
const publicLiveReads = new MySqlPublicLiveReadRepository(
  sessions,
  config.prefixes.runtime,
  config.prefixes.hardware,
);
const publicLiveRuntime = new PublicLiveReadRouter(publicLiveReads);
const seasonPublicReads = new MySqlSeasonPublicReadRepository(sessions, config.prefixes.runtime);
const seasonPublicRuntime = new SeasonPublicReadRouter(seasonPublicReads);
const membership = new MySqlMembershipEligibilityRepository(sessions, config.prefixes.runtime);
const equipment = new MySqlEquipmentAdminRepository(sessions, config.prefixes.runtime, config.prefixes.hardware);
const scoliaAdmin = new MySqlScoliaAdminRepository(sessions, config.prefixes.runtime, config.prefixes.hardware);
const scoliaDashboard = new MySqlScoliaDashboardRepository(sessions, config.prefixes.runtime);
const scoliaBridge = new MySqlScoliaBridgeRepository(sessions, config.prefixes.runtime, config.prefixes.hardware);
const scoliaKioskAuth = new MySqlScoliaKioskAuthRepository(sessions, config.prefixes.runtime);
const scoliaKioskRuntime = new MySqlScoliaKioskRuntimeRepository(sessions, config.prefixes.runtime);
const scoliaProcessor = new ScoliaEventProcessor(scoliaBridge, scoring);
const scoliaRuntime = new ScoliaRuntimeRouter(
  config,
  scoliaBridge,
  scoliaProcessor,
  scoliaKioskAuth,
  scoliaKioskRuntime,
  scoliaAdmin,
);
const equipmentRuntime = new EquipmentAdminRouter(
  config,
  identityRepository,
  equipment,
  scoliaAdmin,
  scoliaDashboard,
);
const tournaments = new MySqlTournamentRuntimeRepository(sessions, config.prefixes.runtime);
const tournamentFlow = new MySqlTournamentFlowRepository(sessions, config.prefixes.runtime);
const tournamentOperations = new MySqlTournamentOperationsRepository(sessions, config.prefixes.runtime);
const tournamentPlayoffs = new MySqlTournamentPlayoffRepository(sessions, config.prefixes.runtime);
const tournamentRealtime = new TournamentRealtimePublisher({
  publishUrl: config.realtime.publishUrl,
  publishSecret: config.realtime.publishSecret,
  timeoutMs: config.realtime.timeoutMs,
});
const tournamentRuntime = new TournamentRuntimeRouter(
  config,
  identityRepository,
  accountProfiles,
  membership,
  tournaments,
);
const tournamentOperationsRuntime = new TournamentOperationsRouter(
  config,
  identityRepository,
  tournamentOperations,
  tournamentPlayoffs,
  tournamentRealtime,
);
const preflight = new BackendScoringPreflight(sessions, config.prefixes.runtime);

const server = createServer(async (request, response) => {
  try {
    if (handleCors(request, response)) return;
    await dispatch(request, response);
  } catch (error) {
    sendError(response, error);
  }
});

async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://backend-v2.internal");
  const publicPath = normalizePublicPath(url.pathname);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "blindleia-backend-v2",
      environment: config.environment,
      mode: config.mode,
      writes_armed: mutationsAllowed(config),
      canonical_side_effects_ready: config.canonicalSideEffectsReady,
      realtime_publish_enabled: config.realtime.publishEnabled,
      release_sha: config.releaseSha,
      runtime_prefix: config.prefixes.runtime,
      identity_prefix: config.prefixes.identity,
      hardware_prefix: config.prefixes.hardware,
      max_connections: config.mysql.budget.maxConcurrentConnections,
      connection_mode: "idle-reuse",
      db_idle_ms: config.mysql.idleConnectionTimeoutMs,
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
      realtime_publish_enabled: config.realtime.publishEnabled,
      release_sha: config.releaseSha,
    });
    return;
  }

  if (method === "POST" && publicPath === "/v1/auth/login") {
    assertIdentityMutationAllowed(config);
    const body = await readJsonObject(request);
    const result = await identityAuth.login(body.email ?? body.username, body.password);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === "GET" && publicPath === "/v1/auth/me") {
    const user = await requireIdentityUser(request, identityTouchAllowed());
    sendJson(response, 200, { ok: true, user: formatPublicUser(user) });
    return;
  }

  if (method === "GET" && publicPath === "/v1/me/profile") {
    const user = await requireIdentityUser(request, identityTouchAllowed());
    sendJson(response, 200, { ok: true, profile: await accountProfiles.profileForUser(user) });
    return;
  }

  if (method === "GET" && publicPath === "/v1/me/payments") {
    const user = await requireIdentityUser(request, identityTouchAllowed());
    sendJson(response, 200, { ok: true, ...(await accountProfiles.membershipAndPayments(user)) });
    return;
  }

  if (method === "GET" && publicPath === "/v1/me/eligibility") {
    const user = await requireIdentityUser(request, identityTouchAllowed());
    const playerId = safeIdString(user.player_id);
    if (playerId === null) {
      throw new DomainValidationError("player_profile_missing", "Denne kontoen er ikke koblet til en spillerprofil.");
    }
    const eligibility = await membership.forPlayer(playerId);
    eligibility.payment_options = await accountProfiles.publicPaymentOptions(eligibility.club_id, eligibility.member_id);
    sendJson(response, 200, { ok: true, eligibility });
    return;
  }

  if ((method === "PUT" || method === "PATCH") && publicPath === "/v1/me/profile") {
    assertIdentityMutationAllowed(config);
    const user = await requireIdentityUser(request, true);
    const body = await readJsonObject(request);
    const profile = await accountProfiles.updateProfile(user, body.display_name, body.nickname);
    sendJson(response, 200, { ok: true, profile, message: "Profilen er oppdatert." });
    return;
  }

  if (method === "POST" && publicPath === "/v1/me/password") {
    assertIdentityMutationAllowed(config);
    const user = await requireIdentityUser(request, true);
    const body = await readJsonObject(request);
    await accountProfiles.changePassword(user, body.current_password, body.new_password);
    sendJson(response, 200, { ok: true, message: "Passordet er endret. Andre innlogginger er logget ut." });
    return;
  }

  const publicLiveRoute = await publicLiveRuntime.handle(method, publicPath, request);
  if (publicLiveRoute !== null) {
    sendJson(response, publicLiveRoute.statusCode, publicLiveRoute.payload);
    return;
  }

  const playerLiveRoute = await playerLiveRuntime.handle(method, publicPath, request);
  if (playerLiveRoute !== null) {
    sendJson(response, playerLiveRoute.statusCode, playerLiveRoute.payload);
    return;
  }

  const seasonPublicRoute = await seasonPublicRuntime.handle(method, publicPath);
  if (seasonPublicRoute !== null) {
    sendJson(response, seasonPublicRoute.statusCode, seasonPublicRoute.payload);
    return;
  }

  const scoliaRoute = await scoliaRuntime.handle(method, publicPath, request);
  if (scoliaRoute !== null) {
    sendJson(response, scoliaRoute.statusCode, scoliaRoute.payload);
    return;
  }

  const equipmentRoute = await equipmentRuntime.handle(method, publicPath, request);
  if (equipmentRoute !== null) {
    sendJson(response, equipmentRoute.statusCode, equipmentRoute.payload);
    return;
  }

  const tournamentRoute = await tournamentRuntime.handle(method, publicPath, request);
  if (tournamentRoute !== null) {
    sendJson(response, tournamentRoute.statusCode, tournamentRoute.payload);
    return;
  }

  const tournamentOperationsRoute = await tournamentOperationsRuntime.handle(method, publicPath, request);
  if (tournamentOperationsRoute !== null) {
    sendJson(response, tournamentOperationsRoute.statusCode, tournamentOperationsRoute.payload);
    return;
  }

  const startTournamentMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/start$/.exec(publicPath);
  if (method === "POST" && startTournamentMatch) {
    assertMutationAllowed(config);
    const tournamentId = startTournamentMatch[1];
    const tournament = await tournamentFlow.findTournament(tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }
    const clubId = safeIdString(tournament.club_id);
    if (clubId === null) {
      throw new DomainValidationError("tournament_club_missing", "Turneringen mangler klubbtilknytning.", 409);
    }
    await requireClubAdmin(request, clubId);
    sendJson(response, 200, { ok: true, start: await tournamentFlow.startTournament(tournamentId) });
    return;
  }

  const registrationMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/register$/.exec(publicPath);
  if (method === "POST" && registrationMatch) {
    assertMutationAllowed(config);
    const user = await requireIdentityUser(request, identityTouchAllowed());
    const playerId = safeIdString(user.player_id);
    if (playerId === null) {
      throw new DomainValidationError("player_profile_missing", "Denne kontoen er ikke koblet til en spillerprofil.");
    }
    const eligibility = await membership.forPlayer(playerId);
    eligibility.payment_options = await accountProfiles.publicPaymentOptions(eligibility.club_id, eligibility.member_id);
    if (eligibility.can_register !== true) {
      throw new DomainValidationError(
        "membership_payment_required",
        typeof eligibility.message === "string" ? eligibility.message : "Kontingenten må ordnes før du kan melde deg på nye turneringer.",
        403,
      );
    }
    const registration = await membership.registerPlayer(registrationMatch[1], playerId);
    sendJson(response, 201, { ok: true, registration, eligibility });
    return;
  }

  if (method === "POST" && url.pathname === "/internal/v1/scoring/start-match") {
    const { kioskId, source } = await scoringCommandContext(request);
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

async function requireIdentityUser(request: IncomingMessage, touchSession: boolean): Promise<IdentityUser> {
  const token = bearerToken(request);
  if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
  const user = await identityRepository.findBySessionToken(token, touchSession);
  if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
  return user;
}

async function requireClubAdmin(request: IncomingMessage, clubId: string): Promise<IdentityUser> {
  const user = await requireIdentityUser(request, identityTouchAllowed());
  const role = String(user.role ?? "");
  if (role === "super_admin") return user;
  if (role !== "club_admin") {
    throw new RuntimeAccessError(403, "admin_required", "Club administrator access is required.");
  }
  const clubIds = String(user.admin_club_ids ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[1-9][0-9]*$/.test(value));
  if (!clubIds.includes(clubId)) {
    throw new RuntimeAccessError(403, "club_access_denied", "You cannot manage this club.");
  }
  return user;
}

function identityTouchAllowed(): boolean {
  return (
    (config.environment === "prod" && config.prefixes.identity === "bd_prod_" && mutationsAllowed(config)) ||
    (config.environment === "test" && config.prefixes.identity === "bd_test_" && mutationsAllowed(config))
  );
}

function formatPublicUser(user: IdentityUser): Record<string, unknown> {
  const email = typeof user.email === "string" ? user.email : null;
  const role = typeof user.role === "string" ? user.role : null;
  return {
    id: safePublicNumber(user.id),
    email,
    username: email,
    display_name: user.display_name ?? null,
    role,
    is_super_admin: role === "super_admin",
    contact_email: email,
    contact_phone: user.contact_phone ?? null,
    player: {
      id: safePublicNumber(user.player_id),
      display_name: user.player_display_name ?? null,
      club_id: safePublicNumber(user.player_club_id),
    },
  };
}

function safeIdString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function safePublicNumber(value: unknown): number | null {
  const normalized = safeIdString(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

function bearerToken(request: IncomingMessage): string | null {
  const authorization = header(request, "authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
}

function normalizePublicPath(pathname: string): string {
  if (pathname.startsWith("/api/v1/")) return pathname.slice(4);
  return pathname;
}

function handleCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = header(request, "origin")?.trim() ?? "";
  const allowed = new Set([
    "https://blindleiadart.ingenting.org",
    "https://test.blindleiadart.ingenting.org",
    "https://test.blindleiadarts.ingenting.org",
    "https://dart.ingenting.org",
  ]);
  if (origin !== "" && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "Content-Type, Authorization, X-Kiosk-Pairing-Token, X-Scolia-Bridge-Secret");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  if ((request.method ?? "GET") === "OPTIONS") {
    if (!allowed.has(origin)) {
      response.statusCode = 403;
      response.end();
      return true;
    }
    response.statusCode = 204;
    response.end();
    return true;
  }
  return false;
}

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event: "backend_v2_started",
    environment: config.environment,
    mode: config.mode,
    writes_armed: mutationsAllowed(config),
    canonical_side_effects_ready: config.canonicalSideEffectsReady,
    realtime_publish_enabled: config.realtime.publishEnabled,
    host: config.host,
    port: config.port,
    max_connections: config.mysql.budget.maxConcurrentConnections,
    connection_mode: "idle-reuse",
    db_idle_ms: config.mysql.idleConnectionTimeoutMs,
    release_sha: config.releaseSha,
  }));
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "backend_v2_shutdown", signal }));
  server.close((error) => {
    void (async () => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      try {
        await sessions.close();
      } catch (closeError) {
        console.error("backend-v2 MySQL shutdown failed", closeError);
        process.exitCode = 1;
      }
    })();
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));