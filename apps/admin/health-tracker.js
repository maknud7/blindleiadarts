const HEALTH_URL = "../api/health.php";
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

async function authenticatedDiagnostics() {
  if (!localStorage.getItem("bd:token")) return [];
  return Promise.all([
    authenticatedProbe("auth_me", "Innlogget sesjon", "../api/v1/auth/me"),
    authenticatedProbe("me_dashboard", "Min side-dashboard med din sesjon", "../api/v1/me/dashboard"),
    authenticatedProbe("member_self", "Ditt medlemskap og kontingent", "../api/member-onboarding.php?action=self"),
    authenticatedProbe("break_context", "Spillerpause-kontekst", "../api/v1/me/break-context"),
  ]);
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
    ? (warnings.length ? `Fungerer, men ${warnings.length} treg sjekk` : "Alle kontroller er OK")
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
          <div class="health-check-time"><strong>${Number(item.ms || 0).toFixed(0)} ms</strong><span>${status === "ok" ? "OK" : status === "warn" ? "Treg" : "Feil"}</span></div>
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
  healthSummary.innerHTML = `<div><strong>Kjører selvdiagnose</strong><p>Tester både serveren og de samme innloggede kallene som Min side bruker.</p></div><span class="health-overall">…</span>`;
  healthRoot.innerHTML = `<div class="empty">Henter målinger …</div>`;

  try {
    const [{ response, payload }, authenticated] = await Promise.all([
      fetchHealth(),
      authenticatedDiagnostics(),
    ]);
    payload.diagnostics = [...(Array.isArray(payload.diagnostics) ? payload.diagnostics : []), ...authenticated];
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
window.addEventListener("focus", () => {
  const app = document.getElementById("adminApp");
  if (app && !app.classList.contains("hidden")) runHealthTracker();
});
window.setTimeout(runHealthTracker, 1200);
