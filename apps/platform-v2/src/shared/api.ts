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

function headers(options: RequestOptions): HeadersInit {
  const result: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) result["Content-Type"] = "application/json";
  if (options.token) result.Authorization = `Bearer ${options.token}`;
  if (options.kioskToken) result["X-Kiosk-Pairing-Token"] = options.kioskToken;
  return result;
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
  return payload.data;
}

export function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/api/v1${path}`, options);
}

export function legacyApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/api/${path}`, options);
}
