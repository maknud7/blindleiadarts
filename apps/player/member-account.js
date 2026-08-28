const API_ROOT = "../api/v1";
const root = document.getElementById("memberAccountCard");
const accountSection = document.getElementById("memberAccountSection");
const refreshButton = document.getElementById("refreshButton");
const loginForm = document.getElementById("loginForm");
const authSummary = document.getElementById("authSummary");
const logoutButton = document.getElementById("logoutButton");
const statusArea = document.getElementById("statusArea");
const profileSection = loginForm?.closest('[data-portal-section="profile"]') || null;

let lastToken = null;
let loading = false;
let currentProfile = null;

function token() { return localStorage.getItem("bd:token") || ""; }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function money(value) { const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n) : "—"; }
function number(value, digits = 0) { const n = Number(value || 0); return Number.isFinite(n) ? n.toFixed(digits) : "—"; }
function date(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}
function initials(name) {
  return String(name || "Spiller").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "BD";
}
function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

async function api(path, options = {}) {
  const currentToken = token();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      cache: "no-store",
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data || {};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Hentingen tok for lang tid. Trykk Oppdater for å prøve igjen.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function ensureProfileRoot() {
  if (!profileSection) return null;
  let node = document.getElementById("profileSelfService");
  if (node) return node;
  node = document.createElement("div");
  node.id = "profileSelfService";
  node.className = "hidden";
  const head = profileSection.querySelector(".section-head");
  if (head) head.insertAdjacentElement("afterend", node);
  else profileSection.prepend(node);
  return node;
}

function setAuthenticated(authenticated) {
  document.body.classList.toggle("profile-authenticated", authenticated);
  const selfService = ensureProfileRoot();
  selfService?.classList.toggle("hidden", !authenticated);
  if (!authenticated) {
    currentProfile = null;
    if (!new URLSearchParams(window.location.search).has("reset_token")) loginForm?.classList.remove("hidden");
  } else {
    loginForm?.classList.add("hidden");
    authSummary?.classList.add("hidden");
    statusArea?.classList.add("hidden");
    document.getElementById("passwordResetPanel")?.classList.add("hidden");
  }
}

function profileHero(profile) {
  const avatar = safeUrl(profile.avatar_url);
  const nickname = String(profile.nickname || "").trim();
  return `
    <div class="profile-v2-hero">
      <div class="profile-v2-avatar-wrap">
        <div class="profile-v2-avatar">${avatar ? `<img src="${esc(avatar)}" alt="Profilbilde">` : esc(initials(profile.display_name))}</div>
        <span class="profile-v2-avatar-note">Profilbilde kommer senere</span>
      </div>
      <div class="profile-v2-identity">
        <h3>${esc(profile.display_name || "Min profil")}</h3>
        ${nickname ? `<span class="profile-v2-nickname">«${esc(nickname)}»</span>` : `<span class="profile-v2-nickname">Legg til kallenavn</span>`}
        <span class="profile-v2-email">${esc(profile.email || "")}</span>
      </div>
      <div class="profile-v2-identity-actions">
        <button type="button" data-profile-edit>Rediger profil</button>
        <button type="button" class="ghost" data-profile-password>Endre passord</button>
      </div>
    </div>`;
}

function renderProfile(profile) {
  currentProfile = profile;
  const node = ensureProfileRoot();
  if (!node) return;
  node.innerHTML = `
    ${profileHero(profile)}
    <details id="profileEditPanel" class="profile-v2-panel">
      <summary>Navn og kallenavn</summary>
      <div class="profile-v2-panel-body">
        <form id="profileEditForm" class="profile-v2-form">
          <label class="profile-v2-field"><span>Navn i dartplattformen</span><input id="profileDisplayName" maxlength="150" autocomplete="name" value="${esc(profile.display_name || "")}" required></label>
          <label class="profile-v2-field"><span>Kallenavn <em class="muted">(valgfritt)</em></span><input id="profileNickname" maxlength="120" value="${esc(profile.nickname || "")}" placeholder="F.eks. The Iceman"></label>
          <p class="profile-v2-help">Navnet brukes i kamper, tabeller og statistikk. Kallenavnet er et tillegg og kan endres når som helst.</p>
          <div class="profile-v2-form-actions"><button type="submit">Lagre profil</button></div>
          <div id="profileEditMessage" class="profile-v2-message hidden"></div>
        </form>
      </div>
    </details>
    <details id="profilePasswordPanel" class="profile-v2-panel">
      <summary>Passord og sikkerhet</summary>
      <div class="profile-v2-panel-body">
        <form id="profilePasswordForm" class="profile-v2-form">
          <label class="profile-v2-field"><span>Nåværende passord</span><input id="profileCurrentPassword" type="password" autocomplete="current-password" required></label>
          <label class="profile-v2-field"><span>Nytt passord</span><input id="profileNewPassword" type="password" autocomplete="new-password" minlength="8" required></label>
          <label class="profile-v2-field"><span>Gjenta nytt passord</span><input id="profileRepeatPassword" type="password" autocomplete="new-password" minlength="8" required></label>
          <p class="profile-v2-help">Minst 8 tegn. Når passordet endres, logges andre aktive innlogginger ut.</p>
          <div class="profile-v2-form-actions"><button type="submit">Endre passord</button></div>
          <div id="profilePasswordMessage" class="profile-v2-message hidden"></div>
        </form>
      </div>
    </details>
    <div id="profileLogoutSlot"></div>`;

  const logoutSlot = node.querySelector("#profileLogoutSlot");
  if (logoutButton && logoutSlot) logoutSlot.appendChild(logoutButton);
  logoutButton?.classList.remove("hidden");

  node.querySelector("[data-profile-edit]")?.addEventListener("click", () => openPanel("profileEditPanel"));
  node.querySelector("[data-profile-password]")?.addEventListener("click", () => openPanel("profilePasswordPanel"));
  node.querySelector("#profileEditForm")?.addEventListener("submit", saveProfile);
  node.querySelector("#profilePasswordForm")?.addEventListener("submit", changePassword);
}

function openPanel(id) {
  const panel = document.getElementById(id);
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = true;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setMessage(id, text, tone = "info") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.className = `profile-v2-message ${tone}`;
}

async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    const data = await api("/me/profile", {
      method: "PATCH",
      body: {
        display_name: document.getElementById("profileDisplayName")?.value.trim() || "",
        nickname: document.getElementById("profileNickname")?.value.trim() || "",
      },
    });
    setMessage("profileEditMessage", data.message || "Profilen er oppdatert.", "success");
    if (data.profile) {
      currentProfile = data.profile;
      window.setTimeout(() => renderProfile(data.profile), 350);
    }
  } catch (error) {
    setMessage("profileEditMessage", error.message || "Kunne ikke lagre profilen.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const currentPassword = document.getElementById("profileCurrentPassword")?.value || "";
  const newPassword = document.getElementById("profileNewPassword")?.value || "";
  const repeatPassword = document.getElementById("profileRepeatPassword")?.value || "";
  if (newPassword !== repeatPassword) {
    setMessage("profilePasswordMessage", "De nye passordene er ikke like.", "error");
    return;
  }
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    const data = await api("/me/password", {
      method: "POST",
      body: { current_password: currentPassword, new_password: newPassword },
    });
    form.reset();
    setMessage("profilePasswordMessage", data.message || "Passordet er endret.", "success");
  } catch (error) {
    setMessage("profilePasswordMessage", error.message || "Kunne ikke endre passordet.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderPaymentOptions(options = {}) {
  const recurringUrl = safeUrl(options.recurring_url);
  const oneTimeUrl = safeUrl(options.one_time_url);
  const vippsNumber = String(options.vipps_number || "").trim();
  const vippsName = String(options.vipps_name || options.club_name || "Blindleia Dartklubb").trim();
  const configured = Boolean(options.configured);

  const recurringAction = recurringUrl
    ? `<a class="profile-payment-link" href="${esc(recurringUrl)}" target="_blank" rel="noopener">Start fast betaling</a>`
    : `<span class="profile-v2-help">Fast betalingslenke er ikke lagt inn i portalen ennå.</span>`;
  const oneTimeAction = oneTimeUrl
    ? `<a class="profile-payment-link" href="${esc(oneTimeUrl)}" target="_blank" rel="noopener">Betal med Vipps</a>`
    : vippsNumber
      ? `<div class="profile-vipps-number">Vipps ${esc(vippsNumber)}</div>`
      : `<span class="profile-v2-help">Vipps-nummer eller betalingslenke er ikke lagt inn i portalen ennå.</span>`;

  return `
    <div class="profile-payment-options">
      <article class="profile-payment-option">
        <div><h4>Fast betaling</h4><p>For månedlig kontingent uten at du må huske hver betaling.</p></div>
        ${recurringAction}
      </article>
      <article class="profile-payment-option">
        <div><h4>Enkeltbetaling</h4><p>Betal én kontingent manuelt til ${esc(vippsName)}.</p></div>
        ${oneTimeAction}
      </article>
      <div class="profile-vipps-guide">
        <strong>Endre eller avslutte fast betaling i Vipps</strong><br>
        Gå til <strong>Meg → Betalingsavtaler</strong>, åpne avtalen med ${esc(vippsName)}. Der kan du endre betalingskort eller velge <strong>Avbryt gjentakende betaling</strong>. Hvis avbryt-valget ikke vises, kontakt klubben.
        ${!configured ? `<br><br><span>Klubbens Vipps-detaljer er klargjort i portalen, men må konfigureres før betalingsknappene kan vises.</span>` : ""}
      </div>
    </div>`;
}

function renderPaymentHistory(payments = []) {
  if (!payments.length) return `<div class="profile-payment-history"><div class="profile-v2-panel-body"><p class="muted">Ingen betalinger er registrert ennå.</p></div></div>`;
  return `
    <details class="profile-payment-history">
      <summary>Alle betalinger (${payments.length})</summary>
      <div class="profile-payment-list">
        ${payments.map((payment) => `
          <div class="profile-payment-row">
            <div><strong>${esc(payment.period || "Kontingent")}</strong><small>${date(payment.date)}${payment.source ? ` · ${esc(payment.source)}` : ""}</small></div>
            <span class="profile-payment-amount">${money(payment.amount)}</span>
          </div>`).join("")}
      </div>
    </details>`;
}

function renderMembership(data) {
  const membership = data?.membership || null;
  const options = data?.payment_options || {};
  if (!membership) {
    return `<div class="profile-payment-stack"><div class="profile-membership-summary"><strong>Medlemskap</strong><p class="muted">Ingen medlemskobling er registrert på kontoen.</p></div>${renderPaymentOptions(options)}</div>`;
  }
  const latest = membership.latest_payment || null;
  const override = String(membership.status_override || "").trim();
  const period = [membership.dues_start ? date(membership.dues_start) : "", membership.dues_end ? date(membership.dues_end) : ""].filter(Boolean).join(" – ");
  return `
    <div class="profile-payment-stack">
      <section class="profile-membership-summary">
        <div class="profile-membership-head">
          <div><strong>Kontingent</strong><p class="muted">Medlemsnr. ${Number(membership.member_number || 0) || "—"}</p></div>
          ${override ? `<span class="pill">${esc(override)}</span>` : ""}
        </div>
        <div class="profile-membership-metrics">
          <div class="profile-membership-metric"><small>Månedsbeløp</small><strong>${money(membership.monthly_amount)}</strong></div>
          <div class="profile-membership-metric"><small>Siste betaling</small><strong>${latest ? money(latest.amount) : "—"}</strong><small>${latest ? `${esc(latest.period || "")} · ${date(latest.date)}` : "Ingen registrert"}</small></div>
        </div>
        ${period ? `<p class="profile-v2-help">Registrert kontingentperiode: ${esc(period)}</p>` : ""}
      </section>
      ${renderPaymentOptions(options)}
      ${renderPaymentHistory(membership.payments || [])}
    </div>`;
}

function renderStats(profileData) {
  if (!profileData) return "";
  const player = profileData.player || {};
  const stats = profileData.stats || {};
  const elo = profileData.elo || {};
  return `
    <details class="profile-stats-disclosure">
      <summary>Mine darttall · ${esc(player.display_name || "spillerprofil")}</summary>
      <div class="profile-stats-body">
        <div class="stats-grid">
          <div class="stat-card"><small>ELO</small><strong>${number(elo.rating || 1000, 1)}</strong></div>
          <div class="stat-card"><small>Kamper</small><strong>${Number(stats.matches_played || 0)}</strong></div>
          <div class="stat-card"><small>3DA</small><strong>${number(stats.three_dart_average || stats.recorded_average || stats.visit_average || 0, 2)}</strong></div>
          <div class="stat-card"><small>Høy checkout</small><strong>${Number(stats.highest_checkout || 0)}</strong></div>
          <div class="stat-card"><small>Checkout %</small><strong>${stats.checkout_percentage === null || stats.checkout_percentage === undefined ? "—" : `${number(stats.checkout_percentage, 1)}%`}</strong></div>
          <div class="stat-card"><small>180</small><strong>${Number(stats.visits_180 || 0)}</strong></div>
          <div class="stat-card"><small>140+</small><strong>${Number(stats.visits_140_plus || 0)}</strong></div>
          <div class="stat-card"><small>100+</small><strong>${Number(stats.visits_100_plus || 0)}</strong></div>
        </div>
      </div>
    </details>`;
}

function tuneHeadings() {
  const eyebrow = accountSection?.querySelector(".section-head .eyebrow");
  const title = accountSection?.querySelector(".section-head h2");
  if (eyebrow) eyebrow.textContent = "Medlemskap";
  if (title) title.textContent = "Kontingent og betaling";
}

async function load(force = false) {
  if (!root || loading) return;
  const currentToken = token();
  if (!currentToken) {
    lastToken = null;
    setAuthenticated(false);
    root.innerHTML = `<p class="muted">Logg inn for å se medlemskap, betalinger og egne tall.</p>`;
    return;
  }
  if (!force && currentToken === lastToken) return;
  loading = true;
  tuneHeadings();
  root.innerHTML = `<p class="muted">Henter medlemskap og betalinger …</p>`;
  try {
    const profileResponse = await api("/me/profile");
    const profile = profileResponse.profile || null;
    if (!profile) throw new Error("Spillerprofilen kunne ikke lastes.");
    setAuthenticated(true);
    renderProfile(profile);

    const [payments, playerStats] = await Promise.all([
      api("/me/payments"),
      profile.player_id ? api(`/players/${Number(profile.player_id)}/profile`) : Promise.resolve(null),
    ]);
    root.innerHTML = `${renderMembership(payments)}${renderStats(playerStats)}`;
    lastToken = currentToken;
  } catch (error) {
    lastToken = null;
    setAuthenticated(false);
    root.innerHTML = `<div class="mini-card"><strong>Kunne ikke laste Min profil</strong><p class="muted">${esc(error.message)}</p></div>`;
  } finally {
    loading = false;
  }
}

refreshButton?.addEventListener("click", () => window.setTimeout(() => load(true), 50));
loginForm?.addEventListener("submit", () => window.setTimeout(() => load(true), 700));
logoutButton?.addEventListener("click", () => window.setTimeout(() => load(true), 80));
window.addEventListener("focus", () => load(true));
window.addEventListener("storage", () => load(true));
window.addEventListener("bd:player-state-changed", () => load(true));
window.setInterval(() => load(false), 30000);
load(true);
