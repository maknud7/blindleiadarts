const HEALTH_URL = "../api/health.php";
const SCOLIA_HEALTH_URL = "../api/scolia-health.php";
const healthRoot = document.getElementById("healthTrackerResults");
const healthSummary = document.getElementById("healthTrackerSummary");
const healthRunButton = document.getElementById("runHealthTracker");
const healthRefreshButton = document.getElementById("refreshAllButton");

let healthBusy = false;

function healthEsc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function healthTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function healthDateTime(value) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function detailText(detail) {
  if (!detail || typeof detail !== "object") return "";
  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? (value ? "ja" : "nei") : value}`)
    .join(" · ");
}

async function fetchHealth() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const url = new URL(HEALTH_URL, window.location.href);
    url.searchParams.set("deep", "1");
    url.searchParams.set("cb", String(Date.now()));
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error(`Helsesjekken svarte uten gyldig JSON (${response.status}).`);
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Helsesjekken brukte mer enn 20 sekunder og ble avbrutt.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function scoliaHealthProbe() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const url = new URL(SCOLIA_HEALTH_URL, window.location.href);
    url.searchParams.set("cb", String(Date.now()));
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok || !payload?.ok) {
      return {
        name: "scolia_bridge",
        label: "Scolia bridge og fysiske skiver",
        status: "fail",
        ms: elapsed,
        detail: { error: payload?.error?.code || `HTTP ${response.status}` },
      };
    }

    const data = payload.data || {};
    const boards = Array.isArray(data.boards) ? data.boards : [];
    const configuredBoards = Number(data.configured_boards || 0);
    const secretConfigured = Boolean(data.secret_configured);
    const bridgeRequired = Boolean(data.bridge_required);
    const bridgeAlive = data.bridge_alive === true;
    const boardWarning = boards.some((board) =>
      Boolean(board.expected_active)
      && (!board.heartbeat_fresh || String(board.connection_state || "") !== "connected")
    );

    let status = "ok";
    if (!secretConfigured || (bridgeRequired && !bridgeAlive)) status = "fail";
    else if (configuredBoards === 0 || boardWarning) status = "warn";

    const boardSummary = boards.length
      ? boards.map((board) => {
          const number = Number(board.board_number || 0);
          if (!board.expected_active) return `Skive ${number}: dvale`;
          const state = String(board.connection_state || "ukjent");
          const route = String(board.route || "prod").toUpperCase();
          return `Skive ${number}: ${state} (${route})`;
        }).join(", ")
      : "ingen konfigurerte Scolia-skiver";

    const age = data.latest_heartbeat_age_seconds;
    return {
      name: "scolia_bridge",
      label: "Scolia bridge og fysiske skiver",
      status,
      ms: elapsed,
      detail: {
        bridge: data.bridge_status === "sleeping" ? "dvale" : String(data.bridge_status || "ukjent"),
        heartbeat: !bridgeRequired
          ? "ikke nødvendig i dvale"
          : (age === null || age === undefined ? "mangler" : `${Number(age)} s siden`),
        skiver: boardSummary,
        test_lease: Number(data.active_test_leases || 0),
        prod_innstilling: data.configuration_scope === "production_hardware",
      },
    };
  } catch (error) {
    return {
      name: "scolia_bridge",
      label: "Scolia bridge og fysiske skiver",
      status: "fail",
      ms: Math.round(performance.now() - started),
      detail: { error: error?.name === "AbortError" ? "timeout etter 12 sekunder" : error?.message || "nettverksfeil" },
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function authenticatedProbe(name, label, relativeUrl) {
  const token = localStorage.getItem("bd:token") || "";
  if (!token) {
    return { name, label, status: "fail", ms: 0, detail: { error: "ingen innlogget sesjon" } };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const url = new URL(relativeUrl, window.location.href);
    url.searchParams.set("cb", String(Date.now()));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const elapsed = Math.round(performance.now() - started);
    const ok = response.ok && payload?.ok;
    return {
      name,
      label,
      status: ok ? (elapsed >= 1500 ? "warn" : "ok") : "fail",
      ms: elapsed,
      detail: ok ? { http: response.status } : {
        http: response.status,
        error: payload?.error?.code || payload?.error?.message || "ugyldig svar",
      },
    };
  } catch (error) {
    const elapsed = Math.round(performance.now() - started);
    return {
      name,
      label,
      status: "fail",
      ms: elapsed,
      detail: { error: error?.name === "AbortError" ? "timeout etter 12 sekunder" : error?.message || "nettverksfeil" },
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function sessionProbe() {
  const token = localStorage.getItem("bd:token") || "";
  if (!token) return { name: "auth_session_id", label: "Din aktive sesjon", status: "fail", ms: 0, detail: { error: "ingen innlogget sesjon" } };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const response = await fetch("../api/v1/activity/session", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok || !payload?.ok) {
      return {
        name: "auth_session_id",
        label: "Din aktive sesjon",
        status: "fail",
        ms: elapsed,
        detail: { http: response.status, error: payload?.error?.code || payload?.error?.message || "ugyldig svar" },
      };
    }
    const session = payload.data?.session || {};
    const user = payload.data?.user || {};
    return {
      name: "auth_session_id",
      label: "Din aktive sesjon",
      status: Number(session.id || 0) > 0 ? "ok" : "warn",
      ms: elapsed,
      detail: {
        sesjon: Number(session.id || 0) > 0 ? `#${Number(session.id)}` : "ukjent",
        bruker: user.display_name || `#${Number(user.id || 0)}`,
        utløper: healthDateTime(session.expires_at),
      },
    };
  } catch (error) {
    return {
      name: "auth_session_id",
      label: "Din aktive sesjon",
      status: "fail",
      ms: Math.round(performance.now() - started),
      detail: { error: error?.name === "AbortError" ? "timeout etter 12 sekunder" : error?.message || "nettverksfeil" },
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function identityHealthProbe() {
  const token = localStorage.getItem("bd:token") || "";
  if (!token) return null;
  const started = performance.now();
  try {
    const me = await window.BlindleiaApp?.session?.resolve?.();
    if (me?.role !== "super_admin") return null;
    const response = await fetch("../api/v1/player-identities/health", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok || !payload?.ok) {
      return { name: "identity_health", label: "Canonical spiller- og medlemsidentitet", status: "fail", ms: elapsed, detail: { error: payload?.error?.message || `HTTP ${response.status}` } };
    }
    const data = payload.data || {};
    const groups = Number(data.duplicate_groups || 0);
    const ids = Number(data.duplicate_player_ids || 0);
    return {
      name: "identity_health",
      label: "Canonical spiller- og medlemsidentitet",
      status: groups > 0 ? "fail" : "ok",
      ms: elapsed,
      detail: groups > 0
        ? { duplikatgrupper: groups, spiller_IDer: ids, sammenslåinger: Number(data.merge_count || 0) }
        : { duplikatgrupper: 0, sammenslåinger: Number(data.merge_count || 0) },
    };
  } catch (error) {
    return { name: "identity_health", label: "Canonical spiller- og medlemsidentitet", status: "fail", ms: Math.round(performance.now() - started), detail: { error: error.message || "ukjent feil" } };
  }
}

async function authenticatedDiagnostics() {
  if (!localStorage.getItem("bd:token")) return [];
  const probes = await Promise.all([
    sessionProbe(),
    authenticatedProbe("auth_me", "Innlogget sesjon", "../api/v1/auth/me"),
    authenticatedProbe("me_dashboard", "Min side-dashboard med din sesjon", "../api/v1/me/dashboard"),
    authenticatedProbe("member_self", "Ditt medlemskap og kontingent", "../api/member-onboarding.php?action=self"),
    authenticatedProbe("break_context", "Spillerpause-kontekst", "../api/v1/me/break-context"),
    identityHealthProbe(),
  ]);
  return probes.filter(Boolean);
}

function renderHealth(payload, responseOk) {
  if (!healthRoot || !healthSummary) return;
  const diagnostics = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
  const failures = diagnostics.filter((item) => item.status === "fail");
  const warnings = diagnostics.filter((item) => item.status === "warn");
  const release = String(payload?.release?.sha || "");
  const overallOk = Boolean(payload?.ok) && responseOk && failures.length === 0;
  const tone = overallOk ? (warnings.length ? "warning" : "good") : "bad";
  const title = overallOk
    ? (warnings.length ? `Fungerer, men ${warnings.length} kontroll${warnings.length === 1 ? "" : "er"} trenger oppmerksomhet` : "Alle kontroller er OK")
    : `${Math.max(1, failures.length)} kontroll feiler`;

  healthSummary.className = `health-summary ${tone}`;
  healthSummary.innerHTML = `
    <div>
      <strong>${healthEsc(title)}</strong>
      <p>${healthEsc(`Kjørt ${healthTime(payload?.generated_at)} · ${Number(payload?.duration_ms || 0).toFixed(0)} ms serverdiagnose${release ? ` · release ${release.slice(0, 8)}` : ""}`)}</p>
    </div>
    <span class="health-overall">${overallOk ? (warnings.length ? "OBS" : "OK") : "FEIL"}</span>`;

  healthRoot.innerHTML = diagnostics.length
    ? diagnostics.map((item) => {
        const status = String(item.status || "unknown");
        const detail = detailText(item.detail);
        return `<article class="health-check ${healthEsc(status)}">
          <div class="health-check-main">
            <span class="health-dot" aria-hidden="true"></span>
            <div><strong>${healthEsc(item.label || item.name)}</strong>${detail ? `<small>${healthEsc(detail)}</small>` : ""}</div>
          </div>
          <div class="health-check-time"><strong>${Number(item.ms || 0).toFixed(0)} ms</strong><span>${status === "ok" ? "OK" : status === "warn" ? "Obs" : "Feil"}</span></div>
        </article>`;
      }).join("")
    : `<div class="empty">Ingen detaljer fra helsesjekken.</div>`;
}

async function runHealthTracker() {
  if (healthBusy || !healthRoot || !healthSummary) return;
  healthBusy = true;
  if (healthRunButton) {
    healthRunButton.disabled = true;
    healthRunButton.textContent = "Diagnostiserer …";
  }
  healthSummary.className = "health-summary neutral";
  healthSummary.innerHTML = `<div><strong>Kjører selvdiagnose</strong><p>Tester server, portal, canonical identiteter og Scolia bridge.</p></div><span class="health-overall">…</span>`;
  healthRoot.innerHTML = `<div class="empty">Henter målinger …</div>`;

  try {
    const [{ response, payload }, scolia, authenticated] = await Promise.all([
      fetchHealth(),
      scoliaHealthProbe(),
      authenticatedDiagnostics(),
    ]);
    payload.diagnostics = [...(Array.isArray(payload.diagnostics) ? payload.diagnostics : []), scolia, ...authenticated];
    renderHealth(payload, response.ok);
  } catch (error) {
    healthSummary.className = "health-summary bad";
    healthSummary.innerHTML = `<div><strong>Helsesjekken stoppet</strong><p>${healthEsc(error.message)}</p></div><span class="health-overall">FEIL</span>`;
    healthRoot.innerHTML = `<div class="empty">Kunne ikke fullføre selvdiagnosen.</div>`;
  } finally {
    healthBusy = false;
    if (healthRunButton) {
      healthRunButton.disabled = false;
      healthRunButton.textContent = "Kjør helsesjekk";
    }
  }
}

healthRunButton?.addEventListener("click", runHealthTracker);
healthRefreshButton?.addEventListener("click", () => window.setTimeout(runHealthTracker, 100));
window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "superadmin") runHealthTracker();
});
window.addEventListener("focus", () => {
  if (document.body.dataset.portalActive === "superadmin") runHealthTracker();
});
window.setTimeout(() => {
  if (document.body.dataset.portalActive === "superadmin" || window.BlindleiaApp?.router?.route?.().view === "superadmin") runHealthTracker();
}, 1200);
