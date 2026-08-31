import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const API_BASE = String(process.env.BLINDLEIA_API_BASE || "http://127.0.0.1/api/v1").replace(/\/$/, "");
const BRIDGE_SECRET = String(process.env.SCOLIA_BRIDGE_SECRET || "");
const ROUTER_URL = String(
  process.env.SCOLIA_ROUTER_URL
  || new URL("../scolia-bridge-router.php", `${API_BASE}/`).toString()
);
const SCOLIA_WSS_URL = String(process.env.SCOLIA_WSS_URL || "wss://game.scoliadarts.com/api/v1/external");
const CONFIG_POLL_MS = Math.max(2000, Number(process.env.SCOLIA_CONFIG_POLL_MS || 10000));
const COMMAND_POLL_MS = Math.max(250, Number(process.env.SCOLIA_COMMAND_POLL_MS || 750));
const DRAIN_POLL_MS = Math.max(500, Number(process.env.SCOLIA_DRAIN_POLL_MS || 2000));
const HEARTBEAT_MS = Math.max(5000, Number(process.env.SCOLIA_HEARTBEAT_MS || 15000));
const SPOOL_DIR = path.resolve(process.env.SCOLIA_SPOOL_DIR || "./data/scolia-spool");
const COMMAND_ACK_TIMEOUT_MS = Math.max(2000, Number(process.env.SCOLIA_COMMAND_ACK_TIMEOUT_MS || 8000));

if (!BRIDGE_SECRET) {
  console.error("SCOLIA_BRIDGE_SECRET is required");
  process.exit(1);
}

await fs.mkdir(SPOOL_DIR, { recursive: true });

const connections = new Map();
let flushing = false;
let routerFallbackWarned = false;

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
    routerFallbackWarned = false;
    return data;
  } catch (error) {
    if (!routerFallbackWarned) {
      console.warn(`Scolia router unavailable (${error.message}); falling back to ${API_BASE}.`);
      routerFallbackWarned = true;
    }
    const data = await targetApi(API_BASE, "/scolia/bridge/config");
    return {
      ...data,
      boards: (data.boards || []).map((board) => ({
        ...board,
        connection_key: board.connection_key || board.serial_number || String(board.kiosk_id),
        target_api_base: board.target_api_base || API_BASE,
        environment: board.environment || "default",
      })),
    };
  }
}

function safeFileName(serial) {
  return String(serial).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
}

async function spool(serial, targetApiBase, message) {
  const record = {
    serial_number: serial,
    target_api_base: String(targetApiBase || API_BASE).replace(/\/$/, ""),
    message,
    spooled_at: new Date().toISOString(),
  };
  const name = `${Date.now()}-${safeFileName(serial)}-${randomUUID()}.json`;
  const temp = path.join(SPOOL_DIR, `.${name}.tmp`);
  const final = path.join(SPOOL_DIR, name);
  await fs.writeFile(temp, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  await fs.rename(temp, final);
  return final;
}

async function flushSpool() {
  if (flushing) return;
  flushing = true;
  try {
    const files = (await fs.readdir(SPOOL_DIR)).filter((name) => name.endsWith(".json")).sort();
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
        await targetApi(record.target_api_base || API_BASE, "/scolia/bridge/events", { method: "POST", body: record });
        await fs.unlink(file);
      } catch (error) {
        console.warn("Spool delivery paused:", error.message);
        break;
      }
    }
  } finally {
    flushing = false;
  }
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
  ]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
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
    this.commandTimer = null;
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
    clearInterval(this.commandTimer);
    this.commandTimer = null;
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
    await spool(
      this.config.serial_number,
      this.config.target_api_base,
      internalMessage("BRIDGE_CONNECTED", { kiosk_id: this.config.kiosk_id, environment: this.config.environment || "default" })
    );
    flushSpool().catch(() => undefined);
    this.commandTimer = setInterval(
      () => this.pollCommands().catch((error) => console.warn(`Command poll board ${this.config.board_number}:`, error.message)),
      COMMAND_POLL_MS
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
    if (type === "ACK" || type === "REFUSED") {
      const correlation = commandCorrelationId(message);
      if (correlation && this.pendingCommands.has(correlation)) {
        const pending = this.pendingCommands.get(correlation);
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

    if (type === "HELLO_CLIENT") {
      this.send({
        id: randomUUID(),
        type: "CONFIGURE_SBC",
        payload: { enableMessageForwardToScolia: Number(this.config.forward_messages_to_scolia || 0) === 1 },
      });
      this.send({ id: randomUUID(), type: "GET_SBC_STATUS" });
    }

    await spool(this.config.serial_number, this.config.target_api_base, message);
    flushSpool().catch(() => undefined);
  }

  async onClose(code, reasonBuffer) {
    clearInterval(this.commandTimer);
    this.commandTimer = null;
    const reason = `${code}: ${reasonBuffer?.toString("utf8") || "connection closed"}`;
    this.state = "disconnected";
    if (!this.closedByConfig) {
      await spool(
        this.config.serial_number,
        this.config.target_api_base,
        internalMessage("BRIDGE_DISCONNECTED", { code, reason, environment: this.config.environment || "default" })
      );
      flushSpool().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  async onError(error) {
    this.state = "error";
    await spool(
      this.config.serial_number,
      this.config.target_api_base,
      internalMessage("BRIDGE_ERROR", { error: String(error?.message || error), environment: this.config.environment || "default" })
    );
    flushSpool().catch(() => undefined);
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

  async pollCommands() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = await targetApi(this.config.target_api_base, `/scolia/bridge/commands/${this.config.kiosk_id}`);
    for (const command of data.items || []) {
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
        continue;
      }
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(command.message_id);
        targetApi(this.config.target_api_base, `/scolia/bridge/commands/${command.id}/result`, {
          method: "POST",
          body: { result: "failed", error: "no_ack_before_timeout" },
        }).catch((error) => console.warn("Could not mark command timeout:", error.message));
      }, COMMAND_ACK_TIMEOUT_MS);
      this.pendingCommands.set(command.message_id, { commandId: command.id, timeout });
    }
  }
}

async function reconcileConfig() {
  const data = await bridgeConfig();
  const wanted = new Map(
    (data.boards || []).map((board) => [String(board.connection_key || board.serial_number || board.kiosk_id), board])
  );

  for (const [connectionKey, connection] of connections.entries()) {
    const next = wanted.get(connectionKey);
    if (!next) {
      connection.stop("board disabled or routing changed");
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

async function heartbeat() {
  const groups = groupedConnections();
  await Promise.all([...groups.entries()].map(async ([apiBase, items]) => {
    const boards = items.map((connection) => ({ kiosk_id: Number(connection.config.kiosk_id), state: connection.state }));
    await targetApi(apiBase, "/scolia/bridge/heartbeat", { method: "POST", body: { boards } });
  }));
}

async function drainServerQueue() {
  const targets = new Set([API_BASE]);
  for (const connection of connections.values()) targets.add(connection.config.target_api_base || API_BASE);
  await Promise.all([...targets].map((apiBase) => targetApi(apiBase, "/scolia/bridge/drain", {
    method: "POST",
    body: { limit: 100 },
  }).catch((error) => console.warn(`Queue drain failed for ${apiBase}:`, error.message))));
}

async function boot() {
  console.log(`Blindleia Scolia Bridge starting. Control=${API_BASE}, router=${ROUTER_URL}, spool=${SPOOL_DIR}`);
  await flushSpool().catch((error) => console.warn("Initial spool flush failed:", error.message));
  await reconcileConfig().catch((error) => console.error("Initial Scolia config failed:", error.message));

  setInterval(() => reconcileConfig().catch((error) => console.warn("Scolia config refresh failed:", error.message)), CONFIG_POLL_MS);
  setInterval(() => flushSpool().catch((error) => console.warn("Spool flush failed:", error.message)), 1000);
  setInterval(() => heartbeat().catch((error) => console.warn("Bridge heartbeat failed:", error.message)), HEARTBEAT_MS);
  setInterval(() => drainServerQueue().catch((error) => console.warn("Server queue drain failed:", error.message)), DRAIN_POLL_MS);
}

process.on("SIGTERM", () => {
  for (const connection of connections.values()) connection.stop("bridge shutdown");
  process.exit(0);
});
process.on("SIGINT", () => {
  for (const connection of connections.values()) connection.stop("bridge shutdown");
  process.exit(0);
});

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
