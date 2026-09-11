export type ApiTarget = "php" | "backend-v2";

export type ApiRouteDecision = {
  target: ApiTarget;
  url: string;
};

const PROD_BROWSER_ORIGIN = "https://blindleiadart.ingenting.org";
const BACKEND_V2_ORIGIN = "https://blindleia-backend-v2-readonly.onrender.com";

/**
 * Routes listed here have canonical Node implementations and hosted TEST/E2E
 * coverage. Everything else remains same-origin PHP until explicitly migrated.
 *
 * This is a pre-request single-writer decision. Callers must never try Node and
 * then fall back to PHP after an unknown mutation outcome.
 */
export function backendV2OwnsApiRoute(path: string, method = "GET"): boolean {
  const verb = method.trim().toUpperCase() || "GET";
  const normalized = normalizePath(path);

  if (normalized === "/auth/login") return verb === "POST";
  if (normalized === "/auth/me") return verb === "GET";
  if (normalized === "/me/profile") return verb === "GET" || verb === "PUT" || verb === "PATCH";
  if (normalized === "/me/payments") return verb === "GET";
  if (normalized === "/me/eligibility") return verb === "GET";
  if (normalized === "/me/password") return verb === "POST";

  if (/^\/clubs\/[1-9][0-9]*\/registration-tournaments$/.test(normalized)) {
    return verb === "GET";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/groups$/.test(normalized)) {
    return verb === "GET";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/registration-settings$/.test(normalized)) {
    return verb === "PUT" || verb === "PATCH";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/groups\/draw$/.test(normalized)) {
    return verb === "POST";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/groups\/round-robin$/.test(normalized)) {
    return verb === "POST";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/register$/.test(normalized)) {
    return verb === "POST" || verb === "DELETE";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/check-in$/.test(normalized)) {
    return verb === "POST";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/registrations$/.test(normalized)) {
    return verb === "POST";
  }
  if (/^\/tournaments\/[1-9][0-9]*\/registrations\/[1-9][0-9]*$/.test(normalized)) {
    return verb === "DELETE";
  }

  return false;
}

export function resolveApiRoute(
  browserOrigin: string,
  path: string,
  method = "GET",
): ApiRouteDecision {
  const normalized = normalizePath(path);
  const phpUrl = `/api/v1${normalized}`;

  if (browserOrigin === PROD_BROWSER_ORIGIN && backendV2OwnsApiRoute(normalized, method)) {
    return {
      target: "backend-v2",
      url: `${BACKEND_V2_ORIGIN}/api/v1${normalized}`,
    };
  }

  return { target: "php", url: phpUrl };
}

function normalizePath(path: string): string {
  const value = path.trim();
  if (value === "") return "/";
  const withoutPrefix = value.startsWith("/api/v1/") ? value.slice(7) : value;
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}
