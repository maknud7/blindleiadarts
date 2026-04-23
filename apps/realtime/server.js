import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8081);
const host = process.env.HOST || "0.0.0.0";
const publishSecret = (process.env.REALTIME_PUBLISH_SECRET || "").trim();
const allowedOrigins = (process.env.REALTIME_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const subscriptions = new Map();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function normalizeChannels(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function canAcceptOrigin(origin) {
  if (!origin || allowedOrigins.length === 0) {
    return true;
  }

  return allowedOrigins.includes(origin);
}

function broadcastToChannels(channels, eventName, payload) {
  if (!channels.length) {
    return 0;
  }

  const sent = new Set();
  const message = JSON.stringify({
    type: "event",
    event: eventName,
    channels,
    payload,
    published_at: new Date().toISOString(),
  });

  for (const [socket, socketChannels] of subscriptions.entries()) {
    if (socket.readyState !== socket.OPEN) {
      continue;
    }

    const interested = channels.some((channel) => socketChannels.has(channel));
    if (!interested || sent.has(socket)) {
      continue;
    }

    socket.send(message);
    sent.add(socket);
  }

  return sent.size;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "blindleia-darts-realtime",
      clients: Array.from(subscriptions.keys()).filter((socket) => socket.readyState === socket.OPEN).length,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/publish") {
    if (!publishSecret) {
      sendJson(response, 503, {
        ok: false,
        error: "publish_secret_missing",
      });
      return;
    }

    let rawBody = "";

    for await (const chunk of request) {
      rawBody += chunk;
    }

    let body;

    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      sendJson(response, 400, {
        ok: false,
        error: "invalid_json",
      });
      return;
    }

    if ((body?.secret || "") !== publishSecret) {
      sendJson(response, 401, {
        ok: false,
        error: "invalid_secret",
      });
      return;
    }

    const channels = normalizeChannels(body?.channels);
    const eventName = typeof body?.event === "string" && body.event.trim() !== ""
      ? body.event.trim()
      : "snapshot";
    const payload = body?.payload ?? {};
    const receivers = broadcastToChannels(channels, eventName, payload);

    sendJson(response, 202, {
      ok: true,
      receivers,
      channels,
      event: eventName,
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "not_found",
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, request) => {
  const origin = request.headers.origin || "";

  if (!canAcceptOrigin(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }

  subscriptions.set(socket, new Set());

  socket.send(JSON.stringify({
    type: "welcome",
    message: "Connected to Blindleia realtime.",
    published_at: new Date().toISOString(),
  }));

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      socket.send(JSON.stringify({
        type: "error",
        error: "invalid_json",
      }));
      return;
    }

    if (message?.type === "subscribe") {
      const channels = normalizeChannels(message?.channels);
      subscriptions.set(socket, new Set(channels));
      socket.send(JSON.stringify({
        type: "subscribed",
        channels,
      }));
      return;
    }

    if (message?.type === "ping") {
      socket.send(JSON.stringify({
        type: "pong",
        published_at: new Date().toISOString(),
      }));
      return;
    }

    socket.send(JSON.stringify({
      type: "error",
      error: "unsupported_message_type",
    }));
  });

  socket.on("close", () => {
    subscriptions.delete(socket);
  });

  socket.on("error", () => {
    subscriptions.delete(socket);
  });
});

server.listen(port, host, () => {
  console.log(`Blindleia realtime listening on ${host}:${port}`);
});
