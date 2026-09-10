import type { ApiEnvelope } from "./types";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  kioskToken?: string;
};

type KioskMatchWire = {
  current_leg?: unknown;
};

type KioskSnapshotWire = {
  match?: KioskMatchWire | null;
  snapshot?: unknown;
};

function headers(options: RequestOptions): HeadersInit {
  const result: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) result["Content-Type"] = "application/json";
  if (options.token) result.Authorization = `Bearer ${options.token}`;
  if (options.kioskToken) result["X-Kiosk-Pairing-Token"] = options.kioskToken;
  return result;
}

function normalizeKioskSnapshot(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const snapshot = value as KioskSnapshotWire;
  const currentLeg = snapshot.match?.current_leg;

  // The canonical PHP kiosk API exposes current_leg as a detail object. Platform v2
  // deliberately keeps its view contract as the leg number so React never receives
  // the wire object as a render child. Legacy kiosk continues to consume the PHP
  // shape unchanged; normalization happens only at the Platform v2 client boundary.
  if (currentLeg && typeof currentLeg === "object") {
    const legNumber = Number((currentLeg as { leg_number?: unknown }).leg_number || 0);
    if (snapshot.match) snapshot.match.current_leg = legNumber > 0 ? legNumber : 1;
  }

  if (snapshot.snapshot) normalizeKioskSnapshot(snapshot.snapshot);
}

function normalizeResponse<T>(path: string, data: T): T {
  if (path.startsWith("/api/v1/kiosks/") || path.startsWith("/api/v1/kiosk-pairing-requests/")) {
    normalizeKioskSnapshot(data);
  }
  return data;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: headers(options),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.ok) {
    throw new ApiError(
      payload?.error?.message || `Forespørselen feilet (${response.status})`,
      response.status,
      payload?.error?.code || "",
    );
  }
  return normalizeResponse(path, payload.data);
}

export function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/api/v1${path}`, options);
}

export function legacyApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/api/${path}`, options);
}
