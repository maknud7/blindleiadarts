import { asTablePrefix, type MySqlConnectionBudget, type TablePrefix, validateConnectionBudget } from "../mysql/contracts.js";

export type RuntimeEnvironment = "development" | "test" | "prod";
export type RuntimeMode = "readonly" | "test-write" | "prod-canary";

export interface BackendRuntimeConfig {
  environment: RuntimeEnvironment;
  mode: RuntimeMode;
  host: string;
  port: number;
  releaseSha: string;
  internalToken: string | null;
  prodCanaryWritesEnabled: boolean;
  canonicalSideEffectsReady: boolean;
  prefixes: {
    runtime: TablePrefix;
    identity: TablePrefix;
    hardware: TablePrefix;
  };
  mysql: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    connectTimeoutMs: number;
    idleConnectionTimeoutMs: number;
    budget: MySqlConnectionBudget;
  };
  realtime: {
    publishUrl: string | null;
    publishSecret: string | null;
    timeoutMs: number;
    publishEnabled: boolean;
  };
}

const PROD_WRITE_CONFIRMATION = "ALLOW_PROD_SCORING_WRITES";

// Deliberately compile-time false while ELO, playoff reconciliation, tournament
// ELO and linear ranking are still being migrated behind the canonical
// orchestration boundary. An environment variable alone must never be able to
// turn partial backend-v2 semantics into a production writer.
const FULL_CANONICAL_SIDE_EFFECTS_READY = false;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BackendRuntimeConfig {
  const environment = parseEnvironment(env.BD_APP_ENV ?? env.APP_ENV ?? "development");
  const mode = parseMode(env.BD_BACKEND_V2_MODE ?? "readonly");
  const runtimePrefix = asTablePrefix(required(env, "DB_TABLE_PREFIX"));
  const identityPrefix = asTablePrefix(env.IDENTITY_TABLE_PREFIX?.trim() || runtimePrefix);
  const hardwarePrefix = asTablePrefix(env.HARDWARE_TABLE_PREFIX?.trim() || runtimePrefix);
  const maxConcurrentConnections = integer(env.BD_BACKEND_V2_MAX_CONNECTIONS ?? "1", "BD_BACKEND_V2_MAX_CONNECTIONS");
  const acquireTimeoutMs = integer(env.BD_BACKEND_V2_ACQUIRE_TIMEOUT_MS ?? "2500", "BD_BACKEND_V2_ACQUIRE_TIMEOUT_MS");
  const connectTimeoutMs = integer(env.BD_BACKEND_V2_CONNECT_TIMEOUT_MS ?? "5000", "BD_BACKEND_V2_CONNECT_TIMEOUT_MS");
  const idleConnectionTimeoutMs = integer(
    env.BD_BACKEND_V2_DB_IDLE_MS ?? "15000",
    "BD_BACKEND_V2_DB_IDLE_MS",
  );
  const realtimeTimeoutMs = integer(
    env.BD_BACKEND_V2_REALTIME_TIMEOUT_MS ?? "1500",
    "BD_BACKEND_V2_REALTIME_TIMEOUT_MS",
  );
  if (realtimeTimeoutMs > 10_000) {
    throw new TypeError("BD_BACKEND_V2_REALTIME_TIMEOUT_MS may not exceed 10000.");
  }
  const realtimePublishUrl = optional(env.REALTIME_PUBLISH_URL);
  const realtimePublishSecret = optional(env.REALTIME_PUBLISH_SECRET);
  const realtimePublishEnabled = realtimePublishUrl !== null && realtimePublishSecret !== null;

  // Backend-v2 deliberately owns only a tiny slice of hosted DB capacity while
  // PHP remains live. Raising this ceiling requires an explicit architecture change.
  if (maxConcurrentConnections > 2) {
    throw new TypeError("BD_BACKEND_V2_MAX_CONNECTIONS may not exceed 2 during coexistence with PHP.");
  }

  const budget = validateConnectionBudget({
    maxConcurrentConnections,
    acquireTimeoutMs,
  });

  if (mode === "test-write") {
    if (environment !== "test") {
      throw new TypeError("test-write mode requires BD_APP_ENV=test.");
    }
    if (runtimePrefix !== "bd_test_") {
      throw new TypeError("test-write mode requires DB_TABLE_PREFIX=bd_test_.");
    }
  }

  if (mode === "prod-canary") {
    if (environment !== "prod") {
      throw new TypeError("prod-canary mode requires BD_APP_ENV=prod.");
    }
    if (runtimePrefix !== "bd_prod_") {
      throw new TypeError("prod-canary mode requires DB_TABLE_PREFIX=bd_prod_.");
    }
  }

  const prodWriteConfirmationPresent =
    mode === "prod-canary" && env.BD_BACKEND_V2_PROD_WRITE_CONFIRMATION === PROD_WRITE_CONFIRMATION;
  const prodCanaryWritesEnabled = prodWriteConfirmationPresent && FULL_CANONICAL_SIDE_EFFECTS_READY;

  const internalToken = env.BD_BACKEND_V2_INTERNAL_TOKEN?.trim() || null;
  if (mode !== "readonly" && internalToken === null) {
    throw new TypeError("Writable backend-v2 modes require BD_BACKEND_V2_INTERNAL_TOKEN.");
  }

  return {
    environment,
    mode,
    host: env.HOST?.trim() || "0.0.0.0",
    port: integer(env.PORT ?? "8082", "PORT"),
    releaseSha: env.RELEASE_SHA?.trim() || env.GITHUB_SHA?.trim() || "unknown",
    internalToken,
    prodCanaryWritesEnabled,
    canonicalSideEffectsReady: FULL_CANONICAL_SIDE_EFFECTS_READY,
    prefixes: {
      runtime: runtimePrefix,
      identity: identityPrefix,
      hardware: hardwarePrefix,
    },
    mysql: {
      host: required(env, "DB_HOST"),
      port: integer(env.DB_PORT ?? "3306", "DB_PORT"),
      database: required(env, "DB_NAME"),
      username: required(env, "DB_USERNAME"),
      password: required(env, "DB_PASSWORD"),
      connectTimeoutMs,
      idleConnectionTimeoutMs,
      budget,
    },
    realtime: {
      publishUrl: realtimePublishUrl,
      publishSecret: realtimePublishSecret,
      timeoutMs: realtimeTimeoutMs,
      publishEnabled: realtimePublishEnabled,
    },
  };
}

export function mutationsAllowed(config: BackendRuntimeConfig): boolean {
  if (config.mode === "test-write") return true;
  if (config.mode === "prod-canary") return config.prodCanaryWritesEnabled;
  return false;
}

export function assertMutationAllowed(config: BackendRuntimeConfig): void {
  if (!mutationsAllowed(config)) {
    throw new RuntimeAccessError(
      403,
      "backend_v2_read_only",
      config.mode === "prod-canary"
        ? config.canonicalSideEffectsReady
          ? "PROD canary is connected but scoring writes are not armed."
          : "PROD scoring writes are blocked until full canonical side effects are migrated."
        : "Backend v2 is running in read-only mode.",
    );
  }
}

export function assertInternalToken(config: BackendRuntimeConfig, supplied: string | undefined): void {
  if (config.internalToken === null || supplied === undefined || !constantTimeEqual(config.internalToken, supplied)) {
    throw new RuntimeAccessError(401, "backend_v2_auth_required", "Backend v2 internal authentication failed.");
  }
}

export class RuntimeAccessError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeAccessError";
  }
}

function parseEnvironment(value: string): RuntimeEnvironment {
  const normalized = value.trim().toLowerCase();
  if (normalized === "development" || normalized === "dev") return "development";
  if (normalized === "test") return "test";
  if (normalized === "prod" || normalized === "production") return "prod";
  throw new TypeError("BD_APP_ENV must be development, test or prod.");
}

function parseMode(value: string): RuntimeMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "readonly" || normalized === "test-write" || normalized === "prod-canary") {
    return normalized;
  }
  throw new TypeError("BD_BACKEND_V2_MODE must be readonly, test-write or prod-canary.");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function integer(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value.trim())) throw new TypeError(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return parsed;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }
  return mismatch === 0;
}
