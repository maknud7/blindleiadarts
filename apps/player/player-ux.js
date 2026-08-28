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
  card.innerHTML = `
    <div class="player-now-head">
      <div><p class="eyebrow">Akkurat nå</p><h2>Din dartkveld</h2><p id="playerNowHint" class="muted player-now-hint">Det viktigste neste steget vises her.</p></div>
      <span id="playerNowStatus" class="player-now-status">Laster</span>
    </div>
    <div id="playerNowBody" class="player-now-main"><p class="muted">Henter det som er viktigst for deg nå …</p></div>`;
  nav.insertAdjacentElement("afterend", card);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtDate(value) {
  const date = parseDate(value);
  if (!date) return value ? String(value) : "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `I dag ${new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
  return new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function findTournament(tournaments, id) {
  return tournaments.find((item) => Number(item.id) === Number(id)) || null;
}

function isTournamentRelevant(tournament, registrationStatus = "") {
  if (!tournament) return false;
  const status = String(tournament.status || tournament.tournament_status || "").toLowerCase();
  if (["completed", "cancelled"].includes(status)) return false;

  const now = Date.now();
  const start = parseDate(tournament.start_at)?.getTime() ?? null;
  const end = parseDate(tournament.end_at)?.getTime() ?? null;
  if (end !== null && end < now) return false;
  if (end !== null && end >= now && (start === null || start <= now)) return true;

  const liveRegistration = ["checked_in", "paused", "eliminated"].includes(String(registrationStatus));
  if (start === null) return !liveRegistration || ["ready", "in_progress"].includes(status);
  const graceMs = 18 * 60 * 60 * 1000;
  return start >= now - graceMs;
}

function bestRegistration(registrations, tournaments) {
  const priority = { paused: 0, checked_in: 1, registered: 2, waitlisted: 3, eliminated: 4, withdrawn: 9, no_show: 9 };
  return [...registrations]
    .filter((item) => {
      const regStatus = String(item.status || "");
      if ((priority[regStatus] ?? 5) >= 9) return false;
      const tournament = findTournament(tournaments, item.tournament_id) || item;
      return isTournamentRelevant(tournament, regStatus);
    })
    .sort((a, b) => {
      const pa = priority[String(a.status)] ?? 5;
      const pb = priority[String(b.status)] ?? 5;
      if (pa !== pb) return pa - pb;
      const ta = findTournament(tournaments, a.tournament_id) || a;
      const tb = findTournament(tournaments, b.tournament_id) || b;
      return (parseDate(ta?.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (parseDate(tb?.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER);
    })[0] || null;
}

function bestOpenTournament(tournaments) {
  return [...tournaments]
    .filter((item) => String(item.registration_state) === "open" && isTournamentRelevant(item))
    .sort((a, b) => (parseDate(a.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (parseDate(b.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER))[0] || null;
}

function bestUpcomingTournament(tournaments) {
  const now = Date.now();
  return [...tournaments]
    .filter((item) => {
      const status = String(item.status || "").toLowerCase();
      const start = parseDate(item.start_at)?.getTime() ?? null;
      return !["completed", "cancelled"].includes(status) && start !== null && start >= now;
    })
    .sort((a, b) => (parseDate(a.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (parseDate(b.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER))[0] || null;
}

function playerMatch(matchCalls, playerId) {
  if (!playerId) return null;
  const priority = { in_progress: 0, assigned: 1, pending: 2 };
  return [...(matchCalls || [])]
    .filter((match) => Number(match.player_a_id) === Number(playerId) || Number(match.player_b_id) === Number(playerId))
    .sort((a, b) => (priority[String(a.status)] ?? 9) - (priority[String(b.status)] ?? 9) || Number(a.id) - Number(b.id))[0] || null;
}

function opponentName(match, playerId) {
  if (!match) return "Motstander";
  return Number(match.player_a_id) === Number(playerId) ? match.player_b_name : match.player_a_name;
}

function boardName(match) {
  if (!match) return "";
  const board = Number(match.board_number || 0);
  if (board > 0) return `Skive ${board}`;
  if (match.kiosk_name) return String(match.kiosk_name);
  if (match.kiosk_code) return `Kiosk ${match.kiosk_code}`;
  return "Skive ikke satt";
}

function matchContext(match) {
  return [...new Set([match?.round_label, match?.bracket_label].filter(Boolean).map(String))].join(" · ");
}

function go(hash) { window.location.hash = hash; }
function goStats(view = "season") {
  localStorage.setItem("bd:statisticsView", view);
  go("#statistics");
  window.setTimeout(() => document.querySelector(`[data-statistics-view="${view}"]`)?.click(), 80);
}

function triggerExisting(action, tournamentId) {
  const selector = action === "checkin" ? `[data-checkin="${Number(tournamentId)}"]` : `[data-register="${Number(tournamentId)}"]`;
  const button = document.querySelector(selector);
  go("#tournaments");
  if (button) window.setTimeout(() => button.click(), 80);
}

function setSituation(key, statusText, hint = "") {
  document.body.dataset.playerSituation = key;
  const card = document.getElementById("playerNowCard");
  const status = document.getElementById("playerNowStatus");
  const hintNode = document.getElementById("playerNowHint");
  if (card) card.dataset.situation = key;
  if (status) status.textContent = statusText;
  if (hintNode) hintNode.textContent = hint || "Det viktigste neste steget vises her.";

  const breakSection = document.getElementById("playerBreakSection");
  const statsSection = document.getElementById("statsGrid")?.closest('[data-portal-section="home"]');
  if (breakSection) breakSection.classList.toggle("situational-hidden", !["waiting", "paused"].includes(key));
  if (statsSection) statsSection.classList.toggle("situational-hidden", key === "logged_out");
}

function primaryFacts(items) {
  const usable = items.filter((item) => item?.value);
  if (!usable.length) return "";
  return `<div class="player-now-facts">${usable.map((item) => `<div><small>${pxEsc(item.label)}</small><strong>${pxEsc(item.value)}</strong></div>`).join("")}</div>`;
}

function journey(active) {
  const stages = [
    ["registered", "Påmeldt"],
    ["checked_in", "Innsjekket"],
    ["match", "Kamp"],
  ];
  const order = { registered: 0, checked_in: 1, match: 2 };
  const current = order[active] ?? -1;
  return `<div class="player-now-journey" aria-label="Turneringsstatus">${stages.map(([key, label], index) => `<span class="${index < current ? "done" : index === current ? "current" : ""}">${index < current ? "✓" : index + 1} ${label}</span>`).join("")}</div>`;
}

function renderNow({ me, dashboard, tournaments, matchCalls }) {
  ensureNowCard();
  const body = document.getElementById("playerNowBody");
  if (!body) return;

  if (!me) {
    setSituation("logged_out", "Ikke innlogget", "Logg inn for en personlig forside.");
    body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Personlig spillerportal</span><strong>Logg inn, så viser Hjem bare det som gjelder deg</strong><p class="muted">Påmelding, innsjekk, neste skive, motstander, pause og egne tall dukker opp her når de er relevante.</p></div><div class="player-now-actions"><button type="button" data-px-profile>Logg inn</button><button class="ghost" type="button" data-px-tournaments>Se turneringer</button></div>`;
    body.querySelector("[data-px-profile]")?.addEventListener("click", () => go("#profile"));
    body.querySelector("[data-px-tournaments]")?.addEventListener("click", () => go("#tournaments"));
    return;
  }

  const playerId = Number(me.player?.id || 0);
  const currentMatch = playerMatch(matchCalls, playerId);
  if (currentMatch) {
    const opponent = opponentName(currentMatch, playerId);
    const board = boardName(currentMatch);
    const context = matchContext(currentMatch);
    const isLive = String(currentMatch.status) === "in_progress";
    const isAssigned = String(currentMatch.status) === "assigned";
    const key = isLive ? "live_match" : isAssigned ? "assigned_match" : "pending_match";
    const label = isLive ? "Spiller nå" : isAssigned ? board : "Neste kamp";
    setSituation(key, label, isLive ? "Kampen er i gang." : isAssigned ? "Gå til skiven når du er klar." : "Kampen er opprettet og venter på skive.");
    body.innerHTML = `
      <div class="player-now-copy">
        <span class="player-now-kicker">${isLive ? "Kamp pågår" : isAssigned ? "Du er kalt opp" : "Neste kamp er kjent"}</span>
        <strong>${isLive ? `${pxEsc(board)} · mot ${pxEsc(opponent)}` : `Mot ${pxEsc(opponent)}`}</strong>
        <p class="muted">${isLive ? "Fokuser på kampen — resultat og statistikk lagres fortløpende." : isAssigned ? `Kampen er tildelt ${pxEsc(board)}.` : "Du trenger ikke lete i kampoversikten; Hjem oppdateres når skiven blir satt."}</p>
        ${primaryFacts([{ label: "Skive", value: board }, { label: "Motstander", value: opponent }, { label: "Runde", value: context }])}
        ${journey("match")}
      </div>
      <div class="player-now-actions"><a class="player-now-primary" href="../live/" target="_blank" rel="noopener">Åpne Live</a><button class="ghost" type="button" data-px-tournament>Turneringen</button></div>`;
    body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
    return;
  }

  const registrations = dashboard?.registrations || [];
  const registration = bestRegistration(registrations, tournaments);
  if (registration) {
    const tournament = findTournament(tournaments, registration.tournament_id) || registration;
    const regStatus = String(registration.status || "");
    const date = fmtDate(tournament.start_at);

    if (regStatus === "paused") {
      setSituation("paused", "Pause", "Du blir ikke sendt til ny kamp mens pausen er aktiv.");
      body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Spillerpause aktiv</span><strong>Ta pausen — systemet holder deg unna nytt opprop</strong><p class="muted">${pxEsc(tournament.name || registration.tournament_name)}. Når pausen er ferdig går du tilbake i vanlig kampflyt.</p>${journey("checked_in")}</div><div class="player-now-actions"><button type="button" data-px-break>Se pausen</button><a class="ghost" href="../live/" target="_blank" rel="noopener">Live</a></div>`;
      body.querySelector("[data-px-break]")?.addEventListener("click", () => document.getElementById("playerBreakSection")?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }

    if (regStatus === "checked_in") {
      setSituation("waiting", "Venter på kamp", "Du er klar. Hjem oppdateres når neste kamp eller skive er kjent.");
      body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Innsjekket og klar</span><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du trenger ikke gjøre noe nå. Når du blir kalt opp, vises skive og motstander her automatisk.</p>${primaryFacts([{ label: "Turnering", value: tournament.name || registration.tournament_name }, { label: "Start", value: date }])}${journey("checked_in")}</div><div class="player-now-actions"><a class="player-now-primary" href="../live/" target="_blank" rel="noopener">Følg Live</a><button class="ghost" type="button" data-px-tournament>Turneringen</button></div>`;
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }

    if (regStatus === "registered") {
      setSituation("registered", "Påmeldt", "Neste steg er innsjekk når du kommer til lokalet.");
      body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Plassen er sikret</span><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du er påmeldt. Innsjekk er det neste naturlige steget før turneringen starter.</p>${primaryFacts([{ label: "Når", value: date }, { label: "Status", value: "Påmeldt" }])}${journey("registered")}</div><div class="player-now-actions"><button type="button" data-px-checkin>Gå til innsjekk</button><button class="ghost" type="button" data-px-tournament>Turneringsdetaljer</button></div>`;
      body.querySelector("[data-px-checkin]")?.addEventListener("click", () => triggerExisting("checkin", registration.tournament_id));
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }

    if (regStatus === "waitlisted") {
      setSituation("waitlist", "Venteliste", "Du beholder plassen i køen automatisk.");
      body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Du står i kø</span><strong>${pxEsc(tournament.name || registration.tournament_name)}</strong><p class="muted">Du flyttes inn automatisk dersom det blir ledig plass. Ingen handling er nødvendig nå.</p>${primaryFacts([{ label: "Når", value: date }, { label: "Status", value: "Venteliste" }])}</div><div class="player-now-actions"><button class="ghost" type="button" data-px-tournament>Se turneringen</button></div>`;
      body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
      return;
    }

    if (regStatus === "eliminated") {
      setSituation("eliminated", "Ferdig for kvelden", "Kampene dine er lagret og klare for gjennomgang.");
      body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Turneringen fortsetter uten deg</span><strong>Dine kamper er ferdige</strong><p class="muted">Se kampsnitt, leg-snitt, kast og ELO-endringer i historikken.</p>${primaryFacts([{ label: "Turnering", value: tournament.name || registration.tournament_name }, { label: "Status", value: "Ute" }])}</div><div class="player-now-actions"><button type="button" data-px-matches>Mine kamper</button><a class="ghost" href="../live/" target="_blank" rel="noopener">Følg resten Live</a></div>`;
      body.querySelector("[data-px-matches]")?.addEventListener("click", () => goStats("mine"));
      return;
    }
  }

  const open = bestOpenTournament(tournaments);
  if (open) {
    setSituation("open_registration", "Påmelding åpen", "Du kan sikre deg plass direkte herfra.");
    body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">Neste mulighet</span><strong>${pxEsc(open.name)}</strong><p class="muted">Påmeldingen er åpen. Meld deg på nå, så følger Hjem deg videre til innsjekk og kamp.</p>${primaryFacts([{ label: "Når", value: fmtDate(open.start_at) }, { label: "Påmeldte", value: `${Number(open.registration_count || 0)}` }])}</div><div class="player-now-actions"><button type="button" data-px-register>Meld meg på</button><button class="ghost" type="button" data-px-tournament>Se detaljer</button></div>`;
    body.querySelector("[data-px-register]")?.addEventListener("click", () => triggerExisting("register", open.id));
    body.querySelector("[data-px-tournament]")?.addEventListener("click", () => go("#tournaments"));
    return;
  }

  const upcoming = bestUpcomingTournament(tournaments);
  const stats = dashboard?.stats || {};
  setSituation("idle", upcoming ? "Neste turnering" : "Ajour", upcoming ? "Ingen handling kreves ennå." : "Ingen turnering krever noe fra deg nå.");
  body.innerHTML = `<div class="player-now-copy"><span class="player-now-kicker">${upcoming ? "I kalenderen" : "Rolig akkurat nå"}</span><strong>${upcoming ? pxEsc(upcoming.name) : "Du er ajour"}</strong><p class="muted">${upcoming ? `Neste turnering er ${pxEsc(fmtDate(upcoming.start_at))}. Påmelding vises her når den åpner.` : `Du har ${Number(stats.matches_played || 0)} registrerte kamper og ${Number(stats.matches_won || 0)} seire.`}</p>${upcoming ? primaryFacts([{ label: "Når", value: fmtDate(upcoming.start_at) }, { label: "Påmelding", value: String(upcoming.registration_state) === "not_open" ? "Ikke åpnet" : "Stengt" }]) : ""}</div><div class="player-now-actions"><button type="button" data-px-stats>Se statistikk</button><button class="ghost" type="button" data-px-matches>Mine kamper</button></div>`;
  body.querySelector("[data-px-stats]")?.addEventListener("click", () => goStats("season"));
  body.querySelector("[data-px-matches]")?.addEventListener("click", () => goStats("mine"));
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
      renderNow({ me: null, dashboard: null, tournaments, matchCalls: [] });
      return;
    }
    const [meData, dashData, matchCallData] = await Promise.all([
      pxApi("/auth/me", true),
      pxApi("/me/dashboard", true),
      clubId ? pxApi(`/clubs/${clubId}/match-calls`).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);
    renderNow({ me: meData.user || null, dashboard: dashData.dashboard || null, tournaments, matchCalls: matchCallData.items || [] });
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
  window.addEventListener("bd:player-state-changed", () => window.setTimeout(loadPlayerNow, 20));
  window.addEventListener("storage", (event) => {
    if (!["bd:token", "bd:playerClubId"].includes(event.key)) return;
    loadPlayerNow();
  });
  window.addEventListener("focus", () => loadPlayerNow());
  window.setTimeout(loadPlayerNow, 250);
  window.setInterval(() => { if (!document.hidden) loadPlayerNow(); }, 10000);
}

bootPlayerUx();