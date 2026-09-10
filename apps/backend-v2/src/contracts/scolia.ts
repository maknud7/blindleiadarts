import type { DbId, EvaluatedVisit, NormalizedDart } from "./scoring.js";
import type { RecordVisitCommand } from "./canonical-scoring.js";

export type ScoliaMode = "off" | "shadow" | "live";

export type KnownScoliaEventType =
  | "BRIDGE_CONNECTED"
  | "BRIDGE_DISCONNECTED"
  | "BRIDGE_ERROR"
  | "HELLO_CLIENT"
  | "SBC_STATUS_CHANGED"
  | "SBC_BOARD_AVAILABILITY_CHANGED"
  | "TAKEOUT_STARTED"
  | "TAKEOUT_FINISHED"
  | "THROW_DETECTED";

export interface ScoliaMessage {
  id?: unknown;
  type?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

export interface ScoliaIngressIdentity {
  serial_number: string;
  provider_event_id: string | null;
  event_type: string;
  priority: number;
  dedupe_basis: string;
  dedupe_key: string;
}

export interface ScoliaVisitBuffer {
  kiosk_id: DbId;
  match_id: DbId;
  player_id: DbId;
  darts: NormalizedDart[];
  event_ids: DbId[];
  provider_event_ids: string[];
}

export interface PreparedScoliaVisit {
  context: {
    kiosk_id: DbId;
    match_id: DbId;
    player_id: DbId;
    remaining_before: number;
  };
  evaluation: EvaluatedVisit;
  canonical_command: RecordVisitCommand;
}

export type ScoliaEventDisposition =
  | { kind: "connection"; event_type: "BRIDGE_CONNECTED" | "BRIDGE_DISCONNECTED" | "BRIDGE_ERROR" }
  | { kind: "runtime_status"; event_type: "HELLO_CLIENT" | "SBC_STATUS_CHANGED" | "SBC_BOARD_AVAILABILITY_CHANGED" }
  | { kind: "takeout"; event_type: "TAKEOUT_STARTED" | "TAKEOUT_FINISHED" }
  | { kind: "throw"; event_type: "THROW_DETECTED" }
  | { kind: "ignore"; event_type: string };
