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

export type PlayerScore = {
  id: number;
  display_name: string;
  remaining: number;
  legs_won: number;
};

export type Visit = {
  player_name?: string;
  visit_number?: number;
  score?: number;
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
