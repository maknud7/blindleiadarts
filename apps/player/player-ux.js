const PLAYER_UX_API = "../api/v1";

function pxToken() { return localStorage.getItem("bd:token") || ""; }
function pxClubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function pxEsc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function pxApi(path, auth = false) {
  const headers = {};
  if (auth && pxToken()) headers.Authorization = `Bearer ${pxToken()}`;
  const response = await fetch(`${PLAYER_UX_API}${path}`, { headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function normalizePlayerNavigation() {
  const nav = document.querySelector(".portal-nav.portal-menu");
  if (!nav) return;
  const tables = nav.querySelector('a[href="#tables"]');
  if (tables) tables.textContent = "Ranking";
  nav.querySelector('a[href="#summaries"]')?.remove();
  if (!nav.querySelector('a[href="#profile"]')) {
    const link = document.createElement("a");
    link.href = "#profile";
    link.dataset.portalNav = "1";
    link.textContent = "Min profil";
    const admin = document.getElementById("adminPortalLink");
    if (admin) nav.insertBefore(link, admin); else nav.appendChild(link);
  }

  const homeSections = [...document.querySelectorAll('section[data-portal-section="home"]')];
  const accountSection = homeSections.find((section) => section.querySelector("#loginForm"));
  if (accountSection) {
    accountSection.dataset.portalSection = "profile";
    accountSection.classList.add("player-profile-intro");
  }
  const member = document.getElementById("memberAccountSection");
  if (member) member.dataset.portalSection = "profile";
  const summaries = document.getElementById("summaries");
  if (summaries) summaries.dataset.portalSection = "tournaments";
}

function ensureNowCard() {
  if (document.getElementById("playerNowCard")) return;
  const nav = document.querySelector(".portal-nav.portal-menu");
  if (!nav) return;
  const card = document.createElement("section");
  card.id = "playerNowCard";
  card.dataset.portalSection = "home";
  card.className = "card player-now-card";
  card.innerHTML = `<div class="player-now-head"><div><p class="eyebrow">Akkurat nå</p><h2>Din dartkveld</h2></div><span id="playerNowStatus" class="player-now-status">Laster</span></div><div id="playerNowBody" class="player-now-main"><p class="muted">Henter det som er viktigst for deg nå …</p></div>`;
  nav.insertAdjacentElement("afterend", card);
}

function fmtDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function findTournament(tournaments, id) {
  return tournaments.find((item) => Number(item.id) === Number(id)) || null;
}

function bestRegistration(registrations, tournaments) {
  const priority = { checked_in: 0, registered: 1, waitlisted: 2, eliminated: 4, withdrawn: 9, no_show: 9 };
  return [...registrations]
    .filter((item) => (priority[String(item.status)] ?? 5) < 9)
    .sort((a, b) => {
      const pa = priority[String(a.status)] ?? 5;
      const pb = priority[String(b.status)] ?? 5;
      if (pa !== pb) return pa - pb;
      const ta = findTournament(tournaments, a.tournament_id);
      const tb = findTournament(tournaments, b.tournament_id);
      return new Date(String(ta?.start_at || "2999-01-01")).getTime() - new Date(String(tb?.start_at || "2999-01-01")).getTime();
    })[0] || null;
}

function bestOpenTournament(tournaments) {
  return [...tournaments]
    .filter((item) => String(item.registration_state) === "open" && !["completed", "cancelled"].includes(String(item.status)))
    .sort((a, b) => new Date(String(a.start_at || "2999-01-01")).getTime() - new Date(String(b.start_at || "2999-01-01")).getTime())[0] || null;
}

function go(hash) { window.location.hash = hash; }

function triggerExisting(action, tournamentId) {
  const selector = action === "checkin" ? `[data-checkin="${Number(tournamentId)}"]` : `[data-register="${Number(tournamentId)}"]`;
  const button = document.querySelector(selector);
  if (button) {
    go("#tournaments");
    window.setTimeout(() => button.click(), 80);
  } else {
    go("#tournaments");
  }
}

function renderNow({ me, dashboard, tournaments }) {
  ensureNowCard();
  const status = document.getElementById("playerNowStatus");
  const body = document.getElementById("playerNowBody");
  if (!status || !body) return;

  if (!me) {
    status.textContent = "Ikke innlogget";
    body.innerHTML = `<div><strong>Logg inn med e-post</strong><p class="muted">Da ser du påmelding, check-in, kontingent og dine egne darttall på ett sted.</p></div><div class="player-now-actions"><button type="button" data-px-profile>Logg inn</button></div>`;
    body.querySelector("[data-px-profile]")?.addEventListener("click", () => go("#profile"));
    return;
  }

  const registrations = dashboard?.registrations || [];
  const registration = bestRegistration(registrations, tournaments);
  if (registration) {
    const tournament = findTournament(tournaments, registration.tournament_id) || registration;
    const regStatus = String(registration.status || "");
    const meta = [fmtDate(tournament.start_at), tournament.registration_state === "open" ? "Påmelding åpen" : ""].filter(Boolean);
    if (regStatus === "checked_in") {
      status.textContent = "Klar";
      body.innerHTML = `<div><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du er checket inn. Følg opprop og Live for neste kamp og board.</p><div class="player-now-meta">${meta.map((item) => `<span>${pxEsc(item)}</span>`).join("")}</div></div><div class="player-now-actions"><button type="button" data-px-tournament>Se turneringen</button><a class="ghost" href="../live/" target="_blank" rel="noopener">Åpne Live</a></div>`;
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }
    if (regStatus === "registered") {
      status.textContent = "Påmeldt";
      body.innerHTML = `<div><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du har plass. Neste naturlige steg er å checke inn når turneringen åpner for det.</p><div class="player-now-meta">${meta.map((item) => `<span>${pxEsc(item)}</span>`).join("")}</div></div><div class="player-now-actions"><button type="button" data-px-checkin>Check inn</button><button class="ghost" type="button" data-px-tournament>Turneringsdetaljer</button></div>`;
      body.querySelector("[data-px-checkin]")?.addEventListener("click", () => triggerExisting("checkin", registration.tournament_id));
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }
    if (regStatus === "waitlisted") {
      status.textContent = "Venteliste";
      body.innerHTML = `<div><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du står på venteliste. Du flyttes automatisk inn dersom det blir ledig plass.</p><div class="player-now-meta">${meta.map((item) => `<span>${pxEsc(item)}</span>`).join("")}</div></div><div class="player-now-actions"><button class="ghost" type="button" data-px-tournament>Se turneringen</button></div>`;
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }
  }

  const open = bestOpenTournament(tournaments);
  if (open) {
    status.textContent = "Åpen påmelding";
    body.innerHTML = `<div><strong>${pxEsc(open.name)}</strong><p class="muted">Neste åpne turnering er klar for påmelding.</p><div class="player-now-meta"><span>${pxEsc(fmtDate(open.start_at))}</span><span>${Number(open.registration_count || 0)} påmeldte</span></div></div><div class="player-now-actions"><button type="button" data-px-register>Meld meg på</button></div>`;
    body.querySelector("[data-px-register]")?.addEventListener("click", () => triggerExisting("register", open.id));
    return;
  }

  const stats = dashboard?.stats || {};
  status.textContent = "Ingen handling nå";
  body.innerHTML = `<div><strong>Du er ajour</strong><p class="muted">Ingen turnering krever noe fra deg akkurat nå. Du har ${Number(stats.matches_played || 0)} registrerte kamper og ${Number(stats.matches_won || 0)} seire.</p></div><div class="player-now-actions"><button class="ghost" type="button" data-px-ranking>Se ranking</button><button class="ghost" type="button" data-px-profile>Min profil</button></div>`;
  body.querySelector("[data-px-ranking]")?.addEventListener("click", () => go("#tables"));
  body.querySelector("[data-px-profile]")?.addEventListener("click", () => go("#profile"));
}

let pxLoading = false;
async function loadPlayerNow() {
  if (pxLoading) return;
  pxLoading = true;
  try {
    normalizePlayerNavigation();
    ensureNowCard();
    const clubId = pxClubId();
    const tournaments = clubId ? (await pxApi(`/clubs/${clubId}/registration-tournaments`)).items || [] : [];
    if (!pxToken()) {
      renderNow({ me: null, dashboard: null, tournaments });
      return;
    }
    const [meData, dashData] = await Promise.all([pxApi("/auth/me", true), pxApi("/me/dashboard", true)]);
    renderNow({ me: meData.user || null, dashboard: dashData.dashboard || null, tournaments });
  } catch (error) {
    const body = document.getElementById("playerNowBody");
    const status = document.getElementById("playerNowStatus");
    if (status) status.textContent = "Kunne ikke oppdatere";
    if (body) body.innerHTML = `<p class="muted">${pxEsc(error.message)}</p>`;
  } finally {
    pxLoading = false;
  }
}

function bootPlayerUx() {
  normalizePlayerNavigation();
  ensureNowCard();
  document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(loadPlayerNow, 80));
  document.getElementById("refreshButton")?.addEventListener("click", () => window.setTimeout(loadPlayerNow, 80));
  window.addEventListener("storage", () => loadPlayerNow());
  window.addEventListener("focus", () => loadPlayerNow());
  window.setTimeout(loadPlayerNow, 250);
  window.setInterval(() => { if (!document.hidden) loadPlayerNow(); }, 15000);
}

bootPlayerUx();
