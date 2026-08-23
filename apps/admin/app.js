const API_ROOT = "../api/v1";
const DARTSATLAS_ADMIN_URL = "../api/dartsatlas-admin.php";
const DARTSATLAS_LIVE_URL = "../api/dartsatlas-live.php";

const state = {
  token: localStorage.getItem("bd:token") || "",
  me: null,
  clubs: [],
  clubId: Number(localStorage.getItem("bd:selectedClubId") || 0),
  admin: null,
  live: null,
  loading: false,
};

const el = {
  authGate: document.getElementById("authGate"),
  adminApp: document.getElementById("adminApp"),
  loginForm: document.getElementById("loginForm"),
  loginUsername: document.getElementById("loginUsername"),
  loginPassword: document.getElementById("loginPassword"),
  loginMessage: document.getElementById("loginMessage"),
  logoutButton: document.getElementById("logoutButton"),
  refreshAllButton: document.getElementById("refreshAllButton"),
  refreshDartsAtlasButton: document.getElementById("refreshDartsAtlasButton"),
  clubSelect: document.getElementById("clubSelect"),
  clubName: document.getElementById("clubName"),
  globalMessage: document.getElementById("globalMessage"),
  metrics: document.getElementById("metrics"),
  dartsAtlasStatus: document.getElementById("dartsAtlasStatus"),
  seasonLabel: document.getElementById("seasonLabel"),
  tournamentList: document.getElementById("tournamentList"),
  memberRegistryStatus: document.getElementById("memberRegistryStatus"),
  playerRows: document.getElementById("playerRows"),
  unlinkedOnly: document.getElementById("unlinkedOnly"),
  screenForm: document.getElementById("screenForm"),
  screenList: document.getElementById("screenList"),
  screenCount: document.getElementById("screenCount"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function persistToken(token) {
  state.token = token || "";
  if (state.token) localStorage.setItem("bd:token", state.token);
  else localStorage.removeItem("bd:token");
}

function showMessage(target, message, tone = "info") {
  target.textContent = message;
  target.className = `message ${tone}`;
}

function hideMessage(target) {
  target.textContent = "";
  target.className = "message hidden";
}

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  }
  return payload.data;
}

async function dartsAdmin({ action = "", method = "GET", body } = {}) {
  const url = new URL(DARTSATLAS_ADMIN_URL, window.location.href);
  url.searchParams.set("club_id", String(state.clubId));
  if (action) url.searchParams.set("action", action);

  const headers = { Authorization: `Bearer ${state.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  }
  return payload.data;
}

async function loadMe() {
  if (!state.token) return false;
  try {
    const data = await api("/auth/me", { auth: true });
    state.me = data.user;
    if (!["club_admin", "super_admin"].includes(state.me?.role || "")) {
      throw new Error("Denne kontoen har ikke administratortilgang.");
    }
    return true;
  } catch (error) {
    persistToken("");
    state.me = null;
    showMessage(el.loginMessage, error.message, "error");
    return false;
  }
}

async function loadClubs() {
  const data = await api("/clubs");
  let clubs = data.items || [];

  if (state.me?.role === "club_admin" && state.me?.player?.club_id) {
    clubs = clubs.filter((club) => Number(club.id) === Number(state.me.player.club_id));
  }

  state.clubs = clubs;
  if (!state.clubs.some((club) => Number(club.id) === state.clubId)) {
    state.clubId = Number(state.clubs[0]?.id || 0);
  }
  localStorage.setItem("bd:selectedClubId", String(state.clubId || ""));
  renderClubSelect();
}

function renderClubSelect() {
  el.clubSelect.innerHTML = state.clubs
    .map((club) => `<option value="${Number(club.id)}">${escapeHtml(club.name)}</option>`)
    .join("");
  el.clubSelect.value = String(state.clubId || "");
  el.clubSelect.classList.toggle("hidden", state.clubs.length <= 1);
}

async function loadLive(force = false) {
  const url = new URL(DARTSATLAS_LIVE_URL, window.location.href);
  if (force) url.searchParams.set("refresh", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.detail || payload?.error?.message || "DartsAtlas Live er utilgjengelig.");
  }
  state.live = payload.data;
}

async function loadAdmin() {
  state.admin = await dartsAdmin();
}

async function loadAll({ forceLive = false } = {}) {
  if (!state.clubId || state.loading) return;
  state.loading = true;
  el.refreshAllButton.disabled = true;
  el.refreshDartsAtlasButton.disabled = true;
  hideMessage(el.globalMessage);

  try {
    const results = await Promise.allSettled([loadAdmin(), loadLive(forceLive)]);
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) {
      showMessage(el.globalMessage, errors.map((result) => result.reason.message).join(" · "), "warning");
    }
    renderAll();
  } finally {
    state.loading = false;
    el.refreshAllButton.disabled = false;
    el.refreshDartsAtlasButton.disabled = false;
  }
}

function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["ok", "live", "ready", "in_progress", "completed", "fresh"].includes(value)) return "good";
  if (["error", "failed", "stale"].includes(value)) return "bad";
  return "neutral";
}

function formatDate(value) {
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

function formatAge(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "ukjent";
  const value = Number(seconds);
  if (value < 60) return `${value} sek`;
  if (value < 3600) return `${Math.floor(value / 60)} min`;
  return `${Math.floor(value / 3600)} t`;
}

function metric(label, value, hint, tone = "neutral") {
  return `<article class="metric ${tone}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(hint || "")}</small>
  </article>`;
}

function renderMetrics() {
  const admin = state.admin;
  const live = state.live;
  const registry = admin?.member_registry || {};
  const tournament = live?.tournament;
  const feed = live?.feed || {};

  el.metrics.innerHTML = [
    metric("DartsAtlas", feed.status || "ukjent", `Sist data: ${formatAge(feed.age_seconds)}`, statusTone(feed.status)),
    metric("Aktiv turnering", tournament?.name || "Ingen", tournament?.status || "", tournament ? "good" : "neutral"),
    metric("Medlemskobling", `${registry.linked_player_count || 0}/${admin?.players?.length || 0}`, registry.available ? "Delt medlemsregister tilkoblet" : "Medlemsregister utilgjengelig", registry.available ? "good" : "bad"),
    metric("Live-skjermer", String(admin?.screens?.length || 0), "Skjermkoder opprettet", admin?.screens?.length ? "good" : "neutral"),
  ].join("");
}

function renderDartsAtlas() {
  const admin = state.admin;
  const live = state.live;
  const feed = live?.feed || {};
  const da = admin?.dartsatlas || {};
  const bootstrap = feed.bootstrap || {};

  el.seasonLabel.textContent = da.season_external_id ? `Sesong ${da.season_external_id}` : "Sesong ikke satt";
  el.dartsAtlasStatus.innerHTML = [
    ["Feed", feed.status || "ukjent", statusTone(feed.status)],
    ["Alder på data", formatAge(feed.age_seconds), "neutral"],
    ["Poll-intervall", `${da.poll_interval_seconds || feed.poll_interval_seconds || 8} sek`, "neutral"],
    ["Medlemskilde", feed.member_registry_source || admin?.member_registry?.source || "ukjent", admin?.member_registry?.available ? "good" : "bad"],
    ["Bootstrap", bootstrap.status || "ikke nødvendig", statusTone(bootstrap.status)],
    ["Importert", `${da.tournament_count || 0} turneringer / ${da.player_count || 0} DartsAtlas-spillere`, "neutral"],
  ].map(([label, value, tone]) => `<div class="status-item ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");

  const tournaments = admin?.tournaments || [];
  if (!tournaments.length) {
    el.tournamentList.innerHTML = `<div class="empty">Ingen DartsAtlas-turneringer er importert ennå.</div>`;
    return;
  }

  el.tournamentList.innerHTML = tournaments.map((tournament) => `
    <article class="list-row">
      <div>
        <strong>${escapeHtml(tournament.name)}</strong>
        <div class="row-meta">
          <span>${escapeHtml(formatDate(tournament.start_at))}</span>
          <span>${escapeHtml(tournament.dartsatlas_external_id || "ingen ekstern ID")}</span>
        </div>
      </div>
      <div class="row-right">
        <span class="badge ${statusTone(tournament.status)}">${escapeHtml(tournament.status)}</span>
        <small>${Number(tournament.completed_match_count || 0)}/${Number(tournament.match_count || 0)} kamper ferdig</small>
      </div>
    </article>`).join("");
}

function memberOptions(selectedId) {
  const members = state.admin?.members || [];
  return [
    `<option value="">— Ikke koblet —</option>`,
    ...members.map((member) => `<option value="${Number(member.id)}" ${Number(member.id) === Number(selectedId) ? "selected" : ""}>${escapeHtml(member.navn)} (#${Number(member.id)})</option>`),
  ].join("");
}

function renderMembers() {
  const registry = state.admin?.member_registry || {};
  const players = state.admin?.players || [];
  const filtered = el.unlinkedOnly.checked ? players.filter((player) => !player.member_id) : players;

  el.memberRegistryStatus.innerHTML = registry.available
    ? `<span class="dot good"></span><strong>Samme medlemsregister som klubbadmin</strong><span>${Number(registry.member_count || 0)} medlemmer · ${Number(registry.unlinked_player_count || 0)} spillere mangler kobling</span>`
    : `<span class="dot bad"></span><strong>Medlemsregister utilgjengelig</strong><span>Kan ikke koble spillere før den delte sqlconnect.php er tilgjengelig.</span>`;

  if (!filtered.length) {
    el.playerRows.innerHTML = `<tr><td colspan="4" class="empty-cell">Ingen spillere å vise.</td></tr>`;
    return;
  }

  el.playerRows.innerHTML = filtered.map((player) => {
    const source = player.dartsatlas_external_id ? "DartsAtlas" : "Lokal";
    const linkLabel = player.member_id
      ? (player.member_link_source === "manual" ? "Manuell" : "Automatisk")
      : "Ikke koblet";
    const tone = player.member_id ? "good" : "warning";

    return `<tr>
      <td>
        <strong>${escapeHtml(player.display_name)}</strong>
        ${player.nickname ? `<small>${escapeHtml(player.nickname)}</small>` : ""}
      </td>
      <td><span class="badge neutral">${source}</span></td>
      <td>
        <select class="member-select" data-player-id="${Number(player.id)}" ${registry.available ? "" : "disabled"}>
          ${memberOptions(player.member_id)}
        </select>
      </td>
      <td>
        <span class="badge ${tone}">${escapeHtml(linkLabel)}</span>
        ${player.member_name ? `<small>${escapeHtml(player.member_name)} · #${Number(player.member_id)}</small>` : ""}
      </td>
    </tr>`;
  }).join("");

  document.querySelectorAll(".member-select").forEach((select) => {
    select.addEventListener("change", async () => {
      const playerId = Number(select.dataset.playerId);
      const memberId = select.value ? Number(select.value) : null;
      select.disabled = true;
      try {
        await dartsAdmin({ action: "member-link", method: "POST", body: { player_id: playerId, member_id: memberId } });
        await loadAdmin();
        renderAll();
        showMessage(el.globalMessage, memberId ? "Medlemskoblingen er lagret." : "Medlemskoblingen er fjernet.", "success");
      } catch (error) {
        showMessage(el.globalMessage, error.message, "error");
        await loadAdmin();
        renderAll();
      }
    });
  });
}

function renderScreens() {
  const screens = state.admin?.screens || [];
  el.screenCount.textContent = `${screens.length} stk`;

  if (!screens.length) {
    el.screenList.innerHTML = `<div class="empty">Ingen skjermkoder er laget ennå.</div>`;
    return;
  }

  el.screenList.innerHTML = screens.map((screen) => `
    <article class="list-row screen-row">
      <div>
        <strong>${escapeHtml(screen.label || "Venue Screen")}</strong>
        <div class="screen-code">${escapeHtml(screen.access_code || "")}</div>
        <div class="row-meta"><span>Sist koblet: ${escapeHtml(formatDate(screen.last_connected_at))}</span></div>
      </div>
      <div class="row-right">
        <span class="badge ${Number(screen.is_active) === 1 ? "good" : "bad"}">${Number(screen.is_active) === 1 ? "Aktiv" : "Inaktiv"}</span>
        <button type="button" class="copy-button" data-code="${escapeHtml(screen.access_code || "")}">Kopier kode</button>
      </div>
    </article>`).join("");

  document.querySelectorAll(".copy-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.dataset.code || "";
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "Kopiert";
        setTimeout(() => { button.textContent = "Kopier kode"; }, 1200);
      } catch {
        showMessage(el.globalMessage, `Skjermkode: ${code}`, "info");
      }
    });
  });
}

function renderAll() {
  const club = state.admin?.club || state.clubs.find((item) => Number(item.id) === state.clubId);
  el.clubName.textContent = club?.name || "Blindleia Darts";
  renderMetrics();
  renderDartsAtlas();
  renderMembers();
  renderScreens();
}

function showAdmin() {
  el.authGate.classList.add("hidden");
  el.adminApp.classList.remove("hidden");
}

function showLogin() {
  el.adminApp.classList.add("hidden");
  el.authGate.classList.remove("hidden");
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(el.loginMessage);
  const submit = el.loginForm.querySelector("button[type=submit]");
  submit.disabled = true;

  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: { username: el.loginUsername.value.trim(), password: el.loginPassword.value },
    });
    persistToken(data.access_token);
    state.me = data.user;
    if (!["club_admin", "super_admin"].includes(state.me?.role || "")) {
      throw new Error("Denne kontoen har ikke administratortilgang.");
    }
    await loadClubs();
    showAdmin();
    await loadAll();
  } catch (error) {
    persistToken("");
    showMessage(el.loginMessage, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

el.logoutButton.addEventListener("click", () => {
  persistToken("");
  state.me = null;
  state.admin = null;
  state.live = null;
  showLogin();
});

el.refreshAllButton.addEventListener("click", () => loadAll());
el.refreshDartsAtlasButton.addEventListener("click", () => loadAll({ forceLive: true }));
el.unlinkedOnly.addEventListener("change", renderMembers);

el.clubSelect.addEventListener("change", async () => {
  state.clubId = Number(el.clubSelect.value || 0);
  localStorage.setItem("bd:selectedClubId", String(state.clubId || ""));
  await loadAll();
});

el.screenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(el.screenForm);
  const label = String(form.get("label") || "").trim();
  if (!label) return;

  const submit = el.screenForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const data = await api(`/clubs/${state.clubId}/screen-devices`, {
      method: "POST",
      auth: true,
      body: { label },
    });
    el.screenForm.reset();
    await loadAdmin();
    renderAll();
    showMessage(el.globalMessage, `Skjermkode ${data.device.access_code} er opprettet.`, "success");
  } catch (error) {
    showMessage(el.globalMessage, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

async function boot() {
  if (!state.token) {
    showLogin();
    return;
  }

  const authenticated = await loadMe();
  if (!authenticated) {
    showLogin();
    return;
  }

  try {
    await loadClubs();
    showAdmin();
    await loadAll();
  } catch (error) {
    showAdmin();
    showMessage(el.globalMessage, error.message, "error");
  }
}

boot();
