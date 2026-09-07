function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function statusCandidate(payload) {
  const root = objectValue(payload);
  const explicitKeys = ["boardStatus", "board_status", "sbcStatus", "sbc_status", "sbcState", "sbc_state"];
  for (const key of explicitKeys) {
    const value = root[key];
    if (typeof value === "string" && value.trim() !== "") {
      return { value: value.trim(), explicit: true };
    }
  }

  for (const key of ["status", "state"]) {
    const value = root[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const normalized = value.trim().toUpperCase();
    if (
      normalized.startsWith("SBC_STATUS_")
      || normalized.startsWith("BOARD_STATUS_")
      || ["RUNNING", "READY", "ONLINE", "OFFLINE", "UNAVAILABLE", "DISCONNECTED", "ERROR"].includes(normalized)
      || normalized.includes("CAMERA ERROR")
      || normalized.includes("CALIBRATION ERROR")
    ) {
      return { value: value.trim(), explicit: false };
    }
  }
  return null;
}

export function normalizeScoliaStatusPayload(payload) {
  const root = objectValue(payload);
  let merged = { ...root };

  // Scolia has used more than one response envelope for status replies. Flatten the
  // common wrappers while retaining the original fields for diagnostics.
  for (const key of ["sbcStatus", "sbc_status", "status", "data", "result", "payload"]) {
    const nested = objectValue(root[key]);
    if (Object.keys(nested).length > 0) merged = { ...merged, ...nested };
  }

  const candidate = statusCandidate(merged) || statusCandidate(root);
  if (candidate && (typeof merged.status !== "string" || merged.status.trim() === "")) {
    merged.status = candidate.value;
  }
  return merged;
}

export function hasScoliaPhysicalStatus(payload) {
  return statusCandidate(normalizeScoliaStatusPayload(payload)) !== null;
}

function correlationCandidates(message) {
  const root = objectValue(message);
  const payload = objectValue(root.payload);
  const data = objectValue(payload.data);
  const values = [];
  const keys = [
    "inReplyTo", "in_reply_to", "replyTo", "reply_to",
    "requestId", "request_id", "requestMessageId", "request_message_id",
    "correlationId", "correlation_id", "messageId", "message_id",
  ];
  for (const source of [root, payload, data]) {
    for (const key of keys) values.push(source[key]);
  }
  // Some Scolia ACKs reuse the request id as the ACK id.
  values.push(root.id, payload.id, data.id);
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim()))];
}

export function resolvePendingScoliaCommand(message, pendingCommands) {
  if (!(pendingCommands instanceof Map) || pendingCommands.size === 0) return null;

  for (const correlation of correlationCandidates(message)) {
    if (pendingCommands.has(correlation)) {
      return { key: correlation, pending: pendingCommands.get(correlation), inferred: false };
    }
  }

  // The bridge deliberately allows only one in-flight command per board. Some Scolia
  // GET_SBC_STATUS ACK variants contain the physical status but omit/rename the
  // correlation field. In that one safe case, bind the reply to the sole pending
  // status probe instead of blocking the board for the full ACK timeout.
  if (pendingCommands.size === 1 && hasScoliaPhysicalStatus(message?.payload)) {
    const [key, pending] = pendingCommands.entries().next().value;
    if (String(pending?.commandType || "").toUpperCase() === "GET_SBC_STATUS") {
      return { key, pending, inferred: true };
    }
  }

  return null;
}
