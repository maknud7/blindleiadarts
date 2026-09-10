export type EnvironmentName = "test" | "prod" | string;

export type ApiEnvelope<T> = {
  ok: boolean;
  data: T;
  error?: { code?: string; message?: string };
};

export type User = {
  id: number;
  role: "club_admin" | "super_admin" | "player" | string;
  display_name?: string;
  username?: string;
  email?: string;
  player?: { club_id?: number | null } | null;
};

export type Club = {
  id: number;
  name: string;
  slug: string;
  kiosk_pairing_code?: string | null;
  logo_url?: string | null;
};

export type EquipmentScope = {
  configuration_scope?: string;
  shared_across_environments?: boolean;
};

export type Board = EquipmentScope & {
  id: number;
  physical_kiosk_id?: number | null;
  runtime_kiosk_id?: number | null;
  code: string;
  name: string;
  board_number: number;
  sponsor_label?: string | null;
  sponsor_logo_url?: string | null;
  scoring_mode: "manual" | "scolia" | string;
  is_active?: number;
  is_paired?: number;
  paired_device_name?: string | null;
  paired_at?: string | null;
  last_seen_at?: string | null;
};

export type PairingRequest = {
  request_code: string;
  device_name?: string | null;
  expires_at?: string | null;
  status?: string;
};

export type ScreenDevice = {
  id: number;
  label: string;
  access_code: string;
  is_active?: number;
  last_connected_at?: string | null;
};

export type ScoliaSettings = EquipmentScope & {
  club_id: number;
  canonical_club_id?: number;
  enabled: number | boolean;
  access_token_configured?: boolean;
  access_token_masked?: string;
  force_connect: number | boolean;
  forward_messages_to_scolia: number | boolean;
  disconnect_fallback_enabled: number | boolean;
  queue_max_attempts: number;
  queue_retry_base_seconds: number;
  event_retention_days: number;
};

export type ScoliaQueue = {
  queued?: number;
  processing?: number;
  failed?: number;
  dead_letter?: number;
  processed?: number;
  ignored?: number;
};

export type ScoliaBoard = EquipmentScope & {
  id: number;
  physical_kiosk_id?: number | null;
  runtime_kiosk_id?: number | null;
  code?: string;
  name?: string;
  board_number: number;
  scoring_mode?: string;
  serial_number?: string | null;
  mode?: "off" | "live" | string;
  auto_fallback_to_manual?: number | boolean;
  force_connect_override?: number | null;
  forward_messages_override?: number | null;
  connection_state?: string | null;
  board_status?: string | null;
  board_phase?: string | null;
  error_type?: string | null;
  fallback_active?: number;
  needs_reconciliation?: number;
  turn_locked_until_takeout?: number;
  last_disconnect_reason?: string | null;
  last_bridge_heartbeat_at?: string | null;
  connected_at?: string | null;
  last_event_at?: string | null;
  last_disconnect_at?: string | null;
  last_reconciled_at?: string | null;
  effective_scoring_mode?: string;
  queue?: ScoliaQueue;
};

export type ScoliaIncident = {
  id: number;
  kiosk_id?: number | null;
  kiosk_name?: string | null;
  board_number?: number | null;
  severity?: string;
  category?: string;
  summary?: string;
  details?: string | null;
  occurrence_count?: number;
  last_seen_at?: string | null;
};

export type ScoliaFailedEvent = {
  id: number;
  kiosk_id?: number;
  board_number?: number;
  match_id?: number | null;
  event_type?: string;
  processing_status?: string;
  attempt_count?: number;
  received_at?: string | null;
  last_error?: string | null;
};

export type ScoliaDashboard = EquipmentScope & {
  settings: ScoliaSettings;
  boards: ScoliaBoard[];
  queue: ScoliaQueue;
  incidents: ScoliaIncident[];
  failed_events: ScoliaFailedEvent[];
};

export type ScoliaBridgeState = EquipmentScope & {
  id: number;
  physical_kiosk_id: number;
  runtime_kiosk_id?: number | null;
  board_number: number;
  name?: string;
  serial_number?: string;
  scoring_mode?: string;
  mode?: string;
  is_scolia: boolean;
  bridge_attached: boolean;
  bridge_released: boolean;
  direct_scolia_ready: boolean;
  can_change_bridge: boolean;
  connection_state?: string;
  fallback_active?: number;
  needs_reconciliation?: number;
  release_effective_within_seconds?: number;
};

export type PlayerScore = {
  id: number;
  display_name: string;
  remaining: number;
  legs_won: number;
};

export type Visit = {
  id?: number;
  player_id?: number;
  player_name?: string;
  visit_number?: number;
  score?: number;
  darts_used?: number;
  remaining_after?: number | null;
  is_bust?: number;
};

export type KioskMatch = {
  id?: number;
  status?: string;
  round_label?: string | null;
  bracket_label?: string | null;
  best_of_legs: number;
  current_leg?: number;
  current_player_id: number;
  player_a: PlayerScore;
  player_b: PlayerScore;
  recent_visits?: Visit[];
};

export type KioskSnapshot = {
  kiosk: Board & { club?: Club };
  match?: KioskMatch | null;
};

export type TestBoard = {
  id: number;
  source?: "physical" | "test" | string;
  club_name: string;
  club_slug?: string;
  board_number: number;
  name?: string | null;
  scoring_mode?: string;
};

export type Health = {
  status: string;
  environment: EnvironmentName;
};
