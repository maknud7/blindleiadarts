import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createCoalescingRunner } from "./coalescing-runner.js";

const API_BASE = String(process.env.BLINDLEIA_API_BASE || "http://127.0.0.1/api/v1").replace(/\/$/, "");
const BRIDGE_SECRET = String(process.env.SCOLIA_BRIDGE_SECRET || "");
const ROUTER_URL = String(
  process.env.SCOLIA_ROUTER_URL
  || new URL("../scolia-bridge-router.php", `${API_BASE}/`).toString()
);
const SCOLIA_WSS_URL = String(process.env.SCOLIA_WSS_URL || "wss://game.scoliadarts.com/api/v1/external");
const ACTIVE_CONFIG_POLL_MS = Math.max(2000, Number(process.env.SCOLIA_CONFIG_POLL_MS || 10000));
const IDLE_CONFIG_POLL_MS = Math.max(60000, Number(process.env.SCOLIA_IDLE_CONFIG_POLL_MS || 300000));
const COMMAND_POLL_MS = Math.max(250, Number(process.env.SCOLIA_COMMAND_POLL_MS || 750));
const DRAIN_POLL_MS = Math.max(250, Number(process.env.SCOLIA_DRAIN_POLL_MS || 500));
const HEARTBEAT_MS = Math.max(5000, Number(process.env.SCOLIA_HEARTBEAT_MS || 15000));
const SPOOL_RETRY_MS = Math.max(250, Number(process.env.SCOLIA_SPOOL_RETRY_MS || 1000));
const SPOOL_DIR = path.resolve(process.env.SCOLIA_SPOOL_DIR || "./data/scolia-spool");
const COMMAND_ACK_TIMEOUT_MS = Math.max(2000, Number(process.env.SCOLIA_COMMAND_ACK_TIMEOUT_MS || 8000));

if (!BRIDGE_SECRET) {
  console.error("SCOLIA_BRIDGE_SECRET is required");
  process.exit(1);
}

await fs.mkdir(SPOOL_DIR, { recursive: true });

const connections = new Map();
const pendingDrainTargets = new Set();
let commandPollInFlight = false;
let routerUnavailableWarned = false;
let configTimer = null;
let lastBridgeMode = "unknown";
let lastSpoolOrder = 0;

function bridgeHeaders(extra = {}) {
  return {
    "X-Scolia-Bridge-Secret": BRIDGE_SECRET,
    ...extra,
  };
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: bridgeHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const message = payload?.error?.message || `Bridge API ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

async function targetApi(apiBase, pathname, options = {}) {
  const base = String(apiBase || API_BASE).replace(/\/$/, "");
  return requestJson(`${base}${pathname}`, options);
}

async function bridgeConfig() {
  try {
    const data = await requestJson(ROUTER_URL);
    routerUnavailableWarned = false;
    return data;
  } catch (error) {
    if (!routerUnavailableWarned) {
      console.warn(`Scolia router unavailable (${error.message}); keeping current bridge state and retrying.`);
      routerUnavailableWarned = true;
    }
    throw error;
  }
}

function safeFileName(serial) {
  return String(serial).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
}

function nextSpoolOrder() {
  lastSpoolOrder = Math.max(Date.now(), lastSpoolOrder + 1);
  return lastSpoolOrder;
}

async function spool(serial, targetApiBase, message) {
  const record = {
    serial_number: serial,
    target_api_base: String(targetApiBase || API_BASE).replace(/\/$/, ""),
    message,
    spooled_at: new Date().toISOString(),
  };
  // The numeric prefix is strictly monotonic inside this bridge process. Scolia can
  // emit several messages in the same millisecond; a random UUID must never decide
  // the order in which throws/takeout events reach canonical scoring.
  const name = `${nextSpoolOrder()}-${safeFileName(serial)}-${randomUUID()}.json`;
  const temp = path.join(SPOOL_DIR, `.${name}.tmp`);
  const final = path.join(SPOOL_DIR, name);
  await fs.writeFile(temp, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  await fs.rename(temp, final);

  // Every durable write wakes the sender. If a message arrives while a flush is in
  // progress, the coalescing runner guarantees an immediate follow-up pass instead
  // of leaving the new file asleep until the periodic retry timer.
  requestSpoolFlush().catch((error) => console.warn("Spool flush failed:", error.message));
  return final;
}

async function flushSpoolPass() {
  const files = (await fs.readdir(SPOOL_DIR)).filter((name) => name.endsWith(".json")).sort();
  let deliveryPaused = false;
  for (const name of files.slice(0, 200)) {
    const file = path.join(SPOOL_DIR, name);
    let record;
    try {
      record = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      console.error("Invalid spool file", name, error.message);
      await fs.rename(file, `${file}.invalid`).catch(() => undefined);
      continue;
    }
    try {
      const targetBase = String(record.target_api_base || API_BASE).replace(/\/$/, "");
      await targetApi(targetBase, "/scolia/bridge/events", { method: "POST", body: record });
      await fs.unlink(file);

      // Ingress only persists/dedupes. Start canonical processing immediately after
      // acceptance instead of waiting up to the periodic server-queue interval.
      requestServerDrain(targetBase).catch((error) => console.warn(`Immediate queue drain failed for ${targetBase}:`, error.message));
    } catch (error) {
      console.warn("Spool delivery paused:", error.message);
      deliveryPaused = true;
      break;
    }
  }

  // Large recovered spools keep flowing in bounded passes without waiting for the
  // periodic timer. API failure is intentionally different: stop and let the retry
  // timer/new inbound traffic wake delivery later, avoiding a tight failure loop.
  if (!deliveryPaused && files.length > 200) {
    requestSpoolFlush().catch((error) => console.warn("Spool continuation failed:", error.message));
  }
}

const spoolFlushRunner = createCoalescingRunner(flushSpoolPass);

function requestSpoolFlush() {
  return spoolFlushRunner.trigger();
}

function internalMessage(type, payload = {}) {
  return { id: randomUUID(), type, payload };
}

function commandCorrelationId(message) {
  const payload = message && typeof message.payload === "object" && message.payload ? message.payload : {};
  for (const value of [
    message?.inReplyTo,
    message?.replyTo,
    message?.requestId,
    message?.correlationId,
    payload.inReplyTo,
    payload.replyTo,
    payload.requestId,
    payload.messageId,
    payload.id,
    message?.id,
  ]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function normalizedStatusPayload(payload) {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  for (const key of ["sbcStatus", "status", "data", "result"]) {
    const nested = root[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...root, ...nested };
    }
  }
  return root;
}

function hasPhysicalStatus(payload) {
  if (!payload || typeof payload !== "object") return false;
  return [payload.boardStatus, payload.board_status, payload.status]
    .some((value) => typeof value === "string" && value.trim() !== "");
}

class BoardConnection {
  constructor(config) {
    this.config = {
      ...config,
      target_api_base: String(config.target_api_base || API_BASE).replace(/\/$/, ""),
      connection_key: String(config.connection_key || config.serial_number || config.kiosk_id),
    };
    this.ws = null;
    this.closedByConfig = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pendingCommands = new Map();
    this.state = "disconnected";
  }

  fingerprint() {
    return JSON.stringify({
      serial_number: this.config.serial_number,
      access_token: this.config.access_token,
      force_connect: Number(this.config.force_connect || 0),
      forward_messages_to_scolia: Number(this.config.forward_messages_to_scolia || 0),
      mode: this.config.mode,
      kiosk_id: Number(this.config.kiosk_id || 0),
      target_api_base: this.config.target_api_base,
      environment: this.config.environment || "default",
    });
  }

  start() {
    this.closedByConfig = false;
    this.connect();
  }

  stop(reason = "configuration changed") {
    this.closedByConfig = true;
    clearTimeout(this.reconnectTimer);
    for (const pending of this.pendingCommands.values()) clearTimeout(pending.timeout);
    this.pendingCommands.clear();
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(1000, reason.slice(0, 120));
    }
    this.ws = null;
    this.state = "disconnected";
  }

  connect() {
    if (this.closedByConfig) return;
    const serial = String(this.config.serial_number || "");
    const token = String(this.config.access_token || "");
    if (!serial || !token) return;

    const url = new URL(SCOLIA_WSS_URL);
    url.searchParams.set("serialNumber", serial);
    url.searchParams.set("accessToken", token);
    if (Number(this.config.force_connect || 0) === 1) url.searchParams.set("forceConnect", "true");

    this.state = "connecting";
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data) => this.onMessage(data));
    this.ws.on("close", (code, reason) => this.onClose(code, reason));
    this.ws.on("error", (error) => this.onError(error));
  }

  async onOpen() {
    this.state = "connected";
    this.reconnectAttempt = 0;
    console.log(`Skive ${this.config.board_number}: Scolia connected · ${String(this.config.environment || "prod").toUpperCase()}`);
    await spool(
      this.config.serial_number,
      this.config.target_api_base,
      internalMessage("BRIDGE_CONNECTED", { kiosk_id: this.config.kiosk_id, environment: this.config.environment || "default" })
    );
  }

  async onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      console.warn(`Ignoring non-JSON Scolia message for board ${this.config.board_number}`);
      return;
    }

    const type = String(message?.type || "").toUpperCase();
    let matchedCommand = null;
    if (type === "ACK" || type === "REFUSED") {
      const correlation = commandCorrelationId(message);
      if (correlation && this.pendingCommands.has(correlation)) {
        const pending = this.pendingCommands.get(correlation);
        matchedCommand = pending;
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(correlation);
        await targetApi(this.config.target_api_base, `/scolia/bridge/commands/${pending.commandId}/result`, {
          method: "POST",
          body: {
            result: type === "ACK" ? "acked" : "refused",
            error: type === "REFUSED" ? JSON.stringify(message.payload || {}) : null,
          },
        }).catch((error) => console.warn("Could not report command result:", error.message));
      }
    }

    if (type === "ACK" && matchedCommand?.commandType === "GET_SBC_STATUS") {
      const payload = normalizedStatusPayload(message.payload);
      if (hasPhysicalStatus(payload)) {
        // GET_SBC_STATUS is a request/response command. Normalize its ACK into the
        // same status-event shape as spontaneous Scolia status notifications so
        // the API can keep physical availability fresh without inventing Offline.
        message = { ...message, type: "SBC_STATUS_CHANGED", payload };
      }
    }

    if (type === "HELLO_CLIENT") {
      this.send({
        id: randomUUID(),
        type: "CONFIGURE_SBC",
        payload: { enableMessageForwardToScolia: Number(this.config.forward_messages_to_scolia || 0) === 1 },
      });
      this.send({ id: randomUUID(), type: "GET_SBC_STATUS" });
    }

    await spool(this.config.serial_number, this.config.target_api_base, message);
  }

  async onClose(code, reasonBuffer) {
    const reason = `${code}: ${reasonBuffer?.toString("utf8") || "connection closed"}`;
    this.state = "disconnected";
    if (!this.closedByConfig) {
      console.warn(`Skive ${this.config.board_number}: Scolia disconnected · reconnecting`);
      this.scheduleReconnect();
      await spool(
        this.config.serial_number,
        this.config.target_api_base,
        internalMessage("BRIDGE_DISCONNECTED", { code, reason, environment: this.config.environment || "default" })
      );
    }
  }

  async onError(error) {
    this.state = "error";
    await spool(
      this.config.serial_number,
      this.config.target_api_base,
      internalMessage("BRIDGE_ERROR", { error: String(error?.message || error), environment: this.config.environment || "default" })
    );
  }

  scheduleReconnect() {
    if (this.closedByConfig) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30000, 750 * 2 ** Math.min(6, this.reconnectAttempt - 1)) + Math.floor(Math.random() * 500);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  async deliverCommand(command) {
    const outgoing = {
      id: command.message_id,
      type: command.command_type,
      ...(command.payload && Object.keys(command.payload).length ? { payload: command.payload } : {}),
    };
    if (!this.send(outgoing)) {
      await targetApi(this.config.target_api_base, `/scolia/bridge/commands/${command.id}/result`, {
        method: "POST",
        body: { result: "failed", error: "socket_not_open" },
      });
      return;
    }
    const timeout = setTimeout(() => {
      this.pendingCommands.delete(command.message_id);
      targetApi(this.config.target_api_base, `/scolia/bridge/commands/${command.id}/result`, {
        method: "POST",
        body: { result: "failed", error: "no_ack_before_timeout" },
      }).catch((error) => console.warn("Could not mark command timeout:", error.message));
    }, COMMAND_ACK_TIMEOUT_MS);
    this.pendingCommands.set(command.message_id, {
      commandId: command.id,
      commandType: String(command.command_type || "").toUpperCase(),
      timeout,
    });
  }
}

function setBridgeMode(mode) {
  const normalized = mode === "active" ? "active" : "idle";
  if (normalized === lastBridgeMode) return;
  lastBridgeMode = normalized;
  console.log(normalized === "active"
    ? "Scolia bridge ACTIVE · tournament/test demand detected"
    : "Scolia bridge IDLE · no tournament or TEST lease; physical sockets are sleeping");
}

async function reconcileConfig() {
  const data = await bridgeConfig();
  const wanted = new Map(
    (data.boards || []).map((board) => [String(board.connection_key || board.serial_number || board.kiosk_id), board])
  );

  for (const [connectionKey, connection] of connections.entries()) {
    const next = wanted.get(connectionKey);
    if (!next) {
      connection.stop("bridge idle or routing changed");
      connections.delete(connectionKey);
      continue;
    }
    const probe = new BoardConnection(next);
    if (connection.fingerprint() !== probe.fingerprint()) {
      connection.stop("configuration or environment changed");
      const replacement = new BoardConnection(next);
      connections.set(connectionKey, replacement);
      replacement.start();
    }
    wanted.delete(connectionKey);
  }

  for (const [connectionKey, board] of wanted.entries()) {
    const connection = new BoardConnection(board);
    connections.set(connectionKey, connection);
    connection.start();
  }

  setBridgeMode(data.bridge_mode || (connections.size > 0 ? "active" : "idle"));
  return data;
}

function groupedConnections() {
  const groups = new Map();
  for (const connection of connections.values()) {
    const base = connection.config.target_api_base || API_BASE;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(connection);
  }
  return groups;
}

async function pollAllCommands() {
  if (commandPollInFlight || connections.size === 0) return;
  commandPollInFlight = true;
  try {
    const groups = groupedConnections();
    await Promise.all([...groups.entries()].map(async ([apiBase, items]) => {
      const ready = items.filter((connection) => (
        connection.ws?.readyState === WebSocket.OPEN
        && connection.pendingCommands.size === 0
      ));
      if (ready.length === 0) return;

      const byKioskId = new Map(ready.map((connection) => [Number(connection.config.kiosk_id), connection]));
      const data = await targetApi(apiBase, "/scolia/bridge/commands/poll", {
        method: "POST",
        body: { kiosk_ids: [...byKioskId.keys()], limit: Math.min(200, byKioskId.size) },
      });
      for (const command of data.items || []) {
        const connection = byKioskId.get(Number(command.kiosk_id));
        if (!connection) continue;
        await connection.deliverCommand(command);
      }
    }));
  } catch (error) {
    console.warn("Bulk command poll failed:", error.message);
  } finally {
    commandPollInFlight = false;
  }
}

async function heartbeat() {
  const groups = groupedConnections();
  if (groups.size === 0) return;
  await Promise.all([...groups.entries()].map(async ([apiBase, items]) => {
    const boards = items.map((connection) => ({ kiosk_id: Number(connection.config.kiosk_id), state: connection.state }));
    await targetApi(apiBase, "/scolia/bridge/heartbeat", { method: "POST", body: { boards } });
  }));
}

async function drainServerQueuePass() {
  const targets = [...pendingDrainTargets];
  pendingDrainTargets.clear();
  if (targets.length === 0) return;

  await Promise.all(targets.map((apiBase) => targetApi(apiBase, "/scolia/bridge/drain", {
    method: "POST",
    body: { limit: 100 },
  }).catch((error) => console.warn(`Queue drain failed for ${apiBase}:`, error.message))));
}

const queueDrainRunner = createCoalescingRunner(drainServerQueuePass);

function requestServerDrain(apiBase = null) {
  if (apiBase) {
    pendingDrainTargets.add(String(apiBase).replace(/\/$/, ""));
  } else {
    for (const connection of connections.values()) {
      pendingDrainTargets.add(String(connection.config.target_api_base || API_BASE).replace(/\/$/, ""));
    }
  }
  if (pendingDrainTargets.size === 0) return Promise.resolve();
  return queueDrainRunner.trigger();
}

function nextConfigDelay(data) {
  if ((data?.bridge_mode || "idle") === "active") return ACTIVE_CONFIG_POLL_MS;

  let delay = Math.max(
    60000,
    Number(data?.idle_poll_seconds || 0) > 0
      ? Number(data.idle_poll_seconds) * 1000
      : IDLE_CONFIG_POLL_MS
  );

  const nextActivationSeconds = Number(data?.next_activation_in_seconds);
  if (Number.isFinite(nextActivationSeconds) && nextActivationSeconds >= 0) {
    delay = Math.min(delay, Math.max(5000, nextActivationSeconds * 1000));
  }
  return delay;
}

async function configLoop() {
  let delay = connections.size > 0 ? ACTIVE_CONFIG_POLL_MS : IDLE_CONFIG_POLL_MS;
  try {
    const data = await reconcileConfig();
    delay = nextConfigDelay(data);
  } catch (error) {
    console.warn("Scolia config refresh failed:", error.message);
  } finally {
    clearTimeout(configTimer);
    configTimer = setTimeout(configLoop, delay);
  }
}

async function boot() {
  console.log(`Blindleia Scolia Bridge starting. Control=${API_BASE}, router=${ROUTER_URL}, spool=${SPOOL_DIR}`);
  await requestSpoolFlush().catch((error) => console.warn("Initial spool flush failed:", error.message));
  await configLoop();

  // Local spool is the durable layer outside MySQL. Normal delivery is event-driven;
  // this short retry interval is only the recovery net for API/network failures.
  setInterval(() => requestSpoolFlush().catch((error) => console.warn("Spool flush failed:", error.message)), SPOOL_RETRY_MS);
  // One bulk command poll and one queue drain per API target, regardless of whether
  // there are 1, 10 or 50 connected boards. Coalescing runners prevent overlap and
  // guarantee that work arriving during a pass gets an immediate follow-up pass.
  setInterval(() => pollAllCommands().catch((error) => console.warn("Command poll failed:", error.message)), COMMAND_POLL_MS);
  setInterval(() => heartbeat().catch((error) => console.warn("Bridge heartbeat failed:", error.message)), HEARTBEAT_MS);
  setInterval(() => requestServerDrain().catch((error) => console.warn("Server queue drain failed:", error.message)), DRAIN_POLL_MS);
}

function shutdown() {
  clearTimeout(configTimer);
  for (const connection of connections.values()) connection.stop("bridge shutdown");
}

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});