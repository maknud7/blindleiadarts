const API_ROOT = "../api/v1";
const MEMBERS_URL = "../api/member-onboarding.php";
const root = document.getElementById("memberAccountCard");
const refreshButton = document.getElementById("refreshButton");

let lastToken = null;
let loading = false;

function token() { return localStorage.getItem("bd:token") || ""; }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function money(value) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(number) : "—"; }
function number(value, digits = 0) { const n = Number(value || 0); return Number.isFinite(n) ? n.toFixed(digits) : "—"; }
function date(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

async function json(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Hentingen tok for lang tid. Trykk Oppdater for å prøve igjen.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function empty(message) {
  if (root) root.innerHTML = `<p class="muted">${esc(message)}</p>`;
}

function renderMembership(membership) {
  if (!membership) return `<div class="mini-card"><strong>Medlemskap</strong><p class="muted">Ingen medlemskobling er registrert på kontoen.</p></div>`;
  const latest = membership.latest_payment || null;
  const override = String(membership.status_override || "").trim();
  const period = [membership.dues_start ? date(membership.dues_start) : "", membership.dues_end ? date(membership.dues_end) : ""].filter(Boolean).join(" – ");
  return `<div class="mini-card stack">
    <div class="section-head"><div><strong>Kontingent</strong><p class="muted">Medlemsnr. ${Number(membership.member_number || 0) || "—"}</p></div>${override ? `<span class="pill">${esc(override)}</span>` : ""}</div>
    <div class="stats-grid">
      <div class="stat-card"><small>Månedsbeløp</small><strong>${money(membership.monthly_amount)}</strong></div>
      <div class="stat-card"><small>Siste betaling</small><strong>${latest ? money(latest.amount) : "—"}</strong><small>${latest ? `${esc(latest.period || "")} · ${date(latest.date)}` : "Ingen betaling registrert"}</small></div>
    </div>
    ${period ? `<p class="muted">Registrert kontingentperiode: ${esc(period)}</p>` : ""}
    ${(membership.payments || []).length ? `<details><summary>Se betalinger</summary><div class="stack">${membership.payments.slice(0, 12).map((payment) => `<div class="history-row"><div><strong>${money(payment.amount)}</strong><small>${esc(payment.period || payment.source || "Kontingent")}</small></div><span>${date(payment.date)}</span></div>`).join("")}</div></details>` : ""}
  </div>`;
}

function renderStats(profile) {
  if (!profile) return `<div class="mini-card"><strong>Kastestatistikk</strong><p class="muted">Ingen spillerprofil er koblet til kontoen.</p></div>`;
  const player = profile.player || {};
  const stats = profile.stats || {};
  const elo = profile.elo || {};
  return `<div class="mini-card stack">
    <div><strong>Kastestatistikk</strong><p class="muted">${esc(player.display_name || "Min spillerprofil")}</p></div>
    <div class="stats-grid">
      <div class="stat-card"><small>ELO</small><strong>${number(elo.rating || 1000, 1)}</strong></div>
      <div class="stat-card"><small>Kamper</small><strong>${Number(stats.matches_played || 0)}</strong></div>
      <div class="stat-card"><small>3-dart snitt</small><strong>${number(stats.three_dart_average || stats.recorded_average || stats.visit_average || 0, 2)}</strong></div>
      <div class="stat-card"><small>Høy checkout</small><strong>${Number(stats.highest_checkout || 0)}</strong></div>
      <div class="stat-card"><small>Checkout %</small><strong>${stats.checkout_percentage === null || stats.checkout_percentage === undefined ? "—" : `${number(stats.checkout_percentage, 1)}%`}</strong></div>
      <div class="stat-card"><small>180</small><strong>${Number(stats.visits_180 || 0)}</strong></div>
      <div class="stat-card"><small>140+</small><strong>${Number(stats.visits_140_plus || 0)}</strong></div>
      <div class="stat-card"><small>100+</small><strong>${Number(stats.visits_100_plus || 0)}</strong></div>
    </div>
  </div>`;
}

async function load(force = false) {
  if (!root || loading) return;
  const currentToken = token();
  if (!currentToken) {
    lastToken = null;
    empty("Logg inn for å se kontingent og egen kastestatistikk.");
    return;
  }
  if (!force && currentToken === lastToken) return;
  loading = true;
  root.innerHTML = `<p class="muted">Henter medlemskap og statistikk …</p>`;
  try {
    const selfUrl = new URL(MEMBERS_URL, window.location.href);
    selfUrl.searchParams.set("action", "self");
    const self = await json(selfUrl, { headers: { Authorization: `Bearer ${currentToken}` } });
    const playerId = Number(self.player_id || 0);
    const profile = playerId > 0 ? await json(`${API_ROOT}/players/${playerId}/profile`) : null;
    root.innerHTML = `${renderMembership(self.membership)}${renderStats(profile)}`;
    lastToken = currentToken;
  } catch (error) {
    lastToken = null;
    empty(error.message);
  } finally { loading = false; }
}

refreshButton?.addEventListener("click", () => setTimeout(() => load(true), 50));
window.addEventListener("focus", () => load(true));
window.addEventListener("storage", () => load(true));
setInterval(() => load(false), 10000);
load(true);
