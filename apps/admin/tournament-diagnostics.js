const DIAGNOSTIC_ACTIVITY_URL = new URL("../api/v1/activity", import.meta.url);
const originalFetch = window.fetch.bind(window);

function token() {
  return localStorage.getItem("bd:token") || "";
}

function selectedClubId() {
  const value = Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
  return value > 0 ? value : null;
}

function selectedTournamentId(url) {
  const match = url.pathname.match(/\/api\/v1\/tournaments\/(\d+)/);
  if (match) return Number(match[1]) || null;
  const selected = Number(document.getElementById("tcTournament")?.value || 0);
  return selected > 0 ? selected : null;
}

function isTournamentApi(url) {
  if (url.origin !== window.location.origin) return false;
  const path = url.pathname;
  return path.includes("/api/v1/tournaments/")
    || /\/api\/v1\/clubs\/\d+\/registration-tournaments$/.test(path)
    || /\/api\/v1\/clubs\/\d+\/players$/.test(path);
}

function cleanEndpoint(url) {
  return `${url.pathname}${url.search ? url.search.replace(/([?&])cb=\d+(&|$)/, "$1").replace(/[?&]$/, "") : ""}`.slice(0, 180);
}

function currentPath() {
  return `${window.location.pathname}${window.location.hash || ""}`.slice(0, 255);
}

async function recordDiagnostic(eventName, url, method, detail = {}) {
  const auth = token();
  if (!auth) return;

  const event = {
    occurred_at: new Date().toISOString(),
    surface: "admin",
    event_name: eventName,
    path: currentPath(),
    page_title: document.title.slice(0, 180),
    club_id: selectedClubId(),
    tournament_id: selectedTournamentId(url),
    metadata: {
      endpoint: cleanEndpoint(url),
      method: String(method || "GET").toUpperCase().slice(0, 12),
      http_status: Number(detail.httpStatus || 0),
      error_code: String(detail.errorCode || "").slice(0, 180),
      elapsed_ms: Math.max(0, Math.round(Number(detail.elapsedMs || 0))),
      timeout: Boolean(detail.timeout),
      phase: String(detail.phase || "request").slice(0, 64),
      module: "tournament-admin",
      source: "automatic-diagnostic",
    },
  };

  try {
    await originalFetch(DIAGNOSTIC_ACTIVITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: [event] }),
      cache: "no-store",
      keepalive: true,
    });
  } catch {
    // Diagnostics must never affect the tournament workflow.
  }
}

// Global runtime diagnostics now covers every app surface. Keep this older,
// tournament-specific observer only as a fallback if the global monitor failed
// to initialize, so the same API error is never persisted twice.
if (!window.__bdTournamentFetchDiagnosticsInstalled && !window.__blindleiaRuntimeDiagnosticsInstalled) {
  window.__bdTournamentFetchDiagnosticsInstalled = true;

  window.fetch = async function tournamentDiagnosticFetch(input, init = {}) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    } catch {
      return originalFetch(input, init);
    }

    if (!isTournamentApi(url)) return originalFetch(input, init);

    const method = String(init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const started = performance.now();

    try {
      const response = await originalFetch(input, init);
      const elapsedMs = performance.now() - started;

      if (!response.ok) {
        const clone = response.clone();
        void clone.json().catch(() => null).then((payload) => recordDiagnostic(
          "tournament_api_error",
          url,
          method,
          {
            httpStatus: response.status,
            errorCode: payload?.error?.code || `http_${response.status}`,
            elapsedMs,
            phase: "response",
          },
        ));
      } else if (elapsedMs >= 5000) {
        void recordDiagnostic("tournament_api_slow", url, method, {
          httpStatus: response.status,
          elapsedMs,
          phase: "response",
        });
      }

      return response;
    } catch (error) {
      const elapsedMs = performance.now() - started;
      void recordDiagnostic("tournament_api_error", url, method, {
        httpStatus: 0,
        errorCode: error?.name === "AbortError" ? "request_timeout" : (error?.name || "network_error"),
        elapsedMs,
        timeout: error?.name === "AbortError",
        phase: "network",
      });
      throw error;
    }
  };

  window.addEventListener("unhandledrejection", (event) => {
    if (document.body.dataset.portalActive !== "tournaments") return;
    const reason = event.reason;
    const url = new URL("../api/v1/tournaments/0", import.meta.url);
    void recordDiagnostic("tournament_client_error", url, "CLIENT", {
      errorCode: reason?.code || reason?.name || "unhandled_rejection",
      phase: "client",
    });
  });
}
