import type {
  KnownScoliaEventType,
  ScoliaEventDisposition,
  ScoliaIngressIdentity,
  ScoliaMessage,
} from "../contracts/scolia.js";
import { DomainValidationError } from "./errors.js";

export type Sha256Hex = (value: string) => string;

const KNOWN_TYPES = new Set<KnownScoliaEventType>([
  "BRIDGE_CONNECTED",
  "BRIDGE_DISCONNECTED",
  "BRIDGE_ERROR",
  "HELLO_CLIENT",
  "SBC_STATUS_CHANGED",
  "SBC_BOARD_AVAILABILITY_CHANGED",
  "TAKEOUT_STARTED",
  "TAKEOUT_FINISHED",
  "THROW_DETECTED",
]);

export function normalizeScoliaSerial(serialInput: string): string {
  const serial = serialInput.trim().toUpperCase();
  if (serial === "") {
    throw new DomainValidationError(
      "scolia_route_invalid",
      "Scolia-eventet mangler canonical serial.",
      422,
    );
  }
  return serial;
}

export function scoliaEventPriority(typeInput: string): number {
  const type = typeInput.trim().toUpperCase();
  switch (type) {
    case "THROW_DETECTED":
      return 100;
    case "TAKEOUT_STARTED":
    case "TAKEOUT_FINISHED":
      return 95;
    case "BRIDGE_DISCONNECTED":
    case "BRIDGE_ERROR":
      return 90;
    case "HELLO_CLIENT":
      return 50;
    case "BRIDGE_CONNECTED":
      return 40;
    case "SBC_STATUS_CHANGED":
    case "SBC_BOARD_AVAILABILITY_CHANGED":
      return 30;
    default:
      return 50;
  }
}

/**
 * Builds the same dedupe identity used by ScoliaRoutedEventRepository without
 * touching MySQL. The caller supplies SHA-256 so this domain code stays runtime-
 * neutral and does not pull Node-specific crypto into the shadow foundation.
 */
export function buildScoliaIngressIdentity(
  serialInput: string,
  message: ScoliaMessage,
  sha256Hex: Sha256Hex,
): ScoliaIngressIdentity {
  const serial = normalizeScoliaSerial(serialInput);
  const providerId = typeof message.id === "string" ? message.id.trim() : "";
  const typeCandidate = typeof message.type === "string" ? message.type.trim().toUpperCase() : "";
  const eventType = typeCandidate === "" ? "UNKNOWN" : typeCandidate;

  const encoded = JSON.stringify(message);
  if (encoded === undefined) {
    throw new DomainValidationError("scolia_event_invalid", "Scolia-eventet kunne ikke serialiseres.", 422);
  }

  const dedupeBasis = providerId !== ""
    ? `id:${serial}:${providerId}`
    : `payload:${serial}:${eventType}:${encoded}`;

  return {
    serial_number: serial,
    provider_event_id: providerId === "" ? null : providerId,
    event_type: eventType,
    priority: scoliaEventPriority(eventType),
    dedupe_basis: dedupeBasis,
    dedupe_key: sha256Hex(dedupeBasis),
  };
}

export function classifyScoliaEvent(typeInput: string): ScoliaEventDisposition {
  const eventType = typeInput.trim().toUpperCase() || "UNKNOWN";

  if (eventType === "BRIDGE_CONNECTED" || eventType === "BRIDGE_DISCONNECTED" || eventType === "BRIDGE_ERROR") {
    return { kind: "connection", event_type: eventType };
  }
  if (
    eventType === "HELLO_CLIENT"
    || eventType === "SBC_STATUS_CHANGED"
    || eventType === "SBC_BOARD_AVAILABILITY_CHANGED"
  ) {
    return { kind: "runtime_status", event_type: eventType };
  }
  if (eventType === "TAKEOUT_STARTED" || eventType === "TAKEOUT_FINISHED") {
    return { kind: "takeout", event_type: eventType };
  }
  if (eventType === "THROW_DETECTED") {
    return { kind: "throw", event_type: eventType };
  }
  return { kind: "ignore", event_type: eventType };
}

export function isKnownScoliaEventType(typeInput: string): typeInput is KnownScoliaEventType {
  return KNOWN_TYPES.has(typeInput.trim().toUpperCase() as KnownScoliaEventType);
}
