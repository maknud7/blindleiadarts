const UX_API_ROOT = "../api/v1";

const uxState = {
  tournaments: [],
  tournamentId: Number(localStorage.getItem("bd:adminTournamentId") || 0),
  view: sessionStorage.getItem("bd:tournamentRoomView") || "overview",
  syncing: false,
  loading: false,
};

function uxToken() { return localStorage.getItem("bd:token") || ""; }
function uxClubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function uxEsc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function uxApi(path) {
  const headers = {};
  if (uxToken()) headers.Authorization = `Bearer ${uxToken()}`;
  const response = await fetch(`${UX_API_ROOT}${path}`, { headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function normalizeAdminNavigation() {
  const nav = document.querySelector(".section-nav.portal-menu");
  if (!nav) return;
  const labels = {
    "#overview": "Oversikt",
    "#tournaments": "Turneringer",
    "#players": "Personer",
    "#kiosks": "Utstyr",
    "#integrations": "Innstillinger",
  };
  Object.entries(labels).forEach(([href, label]) => {
    const link = nav.querySelector(`a[href="${href}"]`);
    if (link) link.textContent = label;
  });
  nav.querySelector('a[href="#screens"]')?.remove();
  const screens = document.getElementById("screens");
  if (screens) screens.dataset.portalSection = "kiosks";

  if (!nav.querySelector(".admin-menu-label")) {
    const label = document.createElement("span");
    label.className = "admin-menu-label";
    label.textContent = "Administrasjon";
    nav.prepend(label);
  }

  const playersTitle = document.querySelector("#players .panel-head h2");
  if (playersTitle) playersTitle.textContent = "Personer";
  const playersCopy = document.querySelector("#players .panel-head .muted");
  if (playersCopy) playersCopy.textContent = "Medlemskap, spillerprofil, kontingent og tilgang håndteres på samme person – uten at du trenger å tenke på den tekniske datamodellen.";

  const boardsTitle = document.querySelector("#kiosks .panel-head h2");
  if (boardsTitle) boardsTitle.textContent = "Utstyr";
  const boardsCopy = document.querySelector("#kiosks .panel-head .muted");
  if (boardsCopy) boardsCopy.textContent = "Boards, nettbrett, Scolia og venue-skjermer samlet på ett sted. Gå inn på et board for detaljene.";

  const screensTitle = document.querySelector("#screens .panel-head h2");
  if (screensTitle) screensTitle.textContent = "Venue-skjermer";
}

function ensureTournamentRoom() {
  const host = document.getElementById("tournaments");
  if (!host || document.getElementById("tournamentRoom")) return;
  host.classList.add("tournament-room-ready");
  const room = document.createElement("section");
  room.id = "tournamentRoom";
  room.className = "tournament-room";
  room.innerHTML = `
    <div class="tournament-room-top">
      <div class="tournament-room-copy">
        <p class="eyebrow">Turneringsrom</p>
        <h2 id="trTitle">Velg turnering</h2>
        <p id="trSubtitle" class="muted">Alt arbeid med én turnering skjer i samme kontekst.</p>
      </div>
      <label class="tournament-room-select"><span>Turnering</span><select id="trTournament"><option value="">Laster …</option></select></label>
    </div>
    <div id="trProgress" class="tournament-room-progress"></div>
    <div id="trNext" class="tournament-room-next">
      <div class="tournament-room-next-copy"><strong>Neste anbefalte steg</strong><small>Velg en turnering for å se hva som bør gjøres.</small></div>
      <button id="trNextButton" type="button" class="button" disabled>Åpne</button>
    </div>
    <nav class="tournament-room-tabs" aria-label="Arbeidsområder i turneringen">
      <button type="button" data-tr-view="overview">Oversikt</button>
      <button type="button" data-tr-view="participants">Deltakere</button>
      <button type="button" data-tr-view="matches">Kamper & boards</button>
      <button type="button" data-tr-view="playoffs">Sluttspill</button>
      <button type="button" data-tr-view="results">Resultater</button>
    </nav>`;
  const head = host.querySelector(":scope > .panel-head");
  head?.insertAdjacentElement("afterend", room);

  document.getElementById("trTournament")?.addEventListener("change", async (event) => {
    const id = Number(event.currentTarget.value || 0);
    selectTournament(id, true);
    await loadTournamentContext();
  });
  room.querySelectorAll("[data-tr-view]").forEach((button) => button.addEventListener("click", () => setTournamentView(button.dataset.trView)));
  document.getElementById("trNextButton")?.addEventListener("click", () => {
    const button = document.getElementById("trNextButton");
    setTournamentView(button?.dataset.targetView || "overview");
    const focusId = button?.dataset.focusId || "";
    if (focusId) window.setTimeout(() => document.getElementById(focusId)?.focus?.(), 120);
  });
  setTournamentView(uxState.view);
}

function tournamentPanels() {
  const host = document.getElementById("tournaments");
  if (!host) return { overview: [], participants: [], matches: [], playoffs: [], results: [] };
  const mainControl = [...host.querySelectorAll(":scope > .tournament-control")]
    .filter((node) => !node.classList.contains("playoff-control") && !node.classList.contains("tc-summary-admin"));
  return {
    overview: [document.getElementById("tournamentList")].filter(Boolean),
    participants: mainControl,
    matches: [...host.querySelectorAll(":scope > .ops-admin-panel")],
    playoffs: [...host.querySelectorAll(":scope > .playoff-control")],
    results: [...host.querySelectorAll(":scope > .tc-summary-admin")],
  };
}

function setTournamentView(view) {
  const allowed = ["overview", "participants", "matches", "playoffs", "results"];
  uxState.view = allowed.includes(view) ? view : "overview";
  sessionStorage.setItem("bd:tournamentRoomView", uxState.view);
  const panels = tournamentPanels();
  Object.entries(panels).forEach(([key, nodes]) => nodes.forEach((node) => node.classList.toggle("tournament-room-view-hidden", key !== uxState.view)));
  document.querySelectorAll("#tournamentRoom [data-tr-view]").forEach((button) => button.classList.toggle("active", button.dataset.trView === uxState.view));

  const activeNodes = panels[uxState.view] || [];
  if (activeNodes.length === 0 && uxState.view !== "overview") {
    const host = document.getElementById("tournaments");
    let empty = document.getElementById("tournamentRoomEmpty");
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "tournamentRoomEmpty";
      empty.className = "tournament-room-empty";
      host?.appendChild(empty);
    }
    empty.textContent = "Laster dette arbeidsområdet …";
    empty.classList.remove("hidden");
  } else {
    document.getElementById("tournamentRoomEmpty")?.classList.add("hidden");
  }
}

function syncTournamentSelectors() {
  const roomSelect = document.getElementById("trTournament");
  if (!roomSelect || !uxState.tournamentId) return;
  uxState.syncing = true;
  try {
    document.querySelectorAll('#tournaments select[id*="Tournament"]').forEach((select) => {
      if (select.id === "trTournament") return;
      if (![...select.options].some((option) => Number(option.value) === uxState.tournamentId)) return;
      if (Number(select.value || 0) === uxState.tournamentId) return;
      select.value = String(uxState.tournamentId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } finally {
    window.setTimeout(() => { uxState.syncing = false; }, 0);
  }
}

function bindChildTournamentSelectors() {
  document.querySelectorAll('#tournaments select[id*="Tournament"]').forEach((select) => {
    if (select.id === "trTournament" || select.dataset.uxTournamentBound === "1") return;
    select.dataset.uxTournamentBound = "1";
    select.addEventListener("change", () => {
      if (uxState.syncing) return;
      const id = Number(select.value || 0);
      if (!id || id === uxState.tournamentId) return;
      selectTournament(id, false);
      loadTournamentContext().catch(() => undefined);
    });
  });
}

function selectTournament(id, propagate = true) {
  if (!id) return;
  uxState.tournamentId = id;
  localStorage.setItem("bd:adminTournamentId", String(id));
  const roomSelect = document.getElementById("trTournament");
  if (roomSelect && [...roomSelect.options].some((option) => Number(option.value) === id)) roomSelect.value = String(id);
  if (propagate) syncTournamentSelectors();
}

function chooseInitialTournament(items) {
  const query = Number(new URLSearchParams(window.location.search).get("tournament") || 0);
  for (const candidate of [query, uxState.tournamentId]) {
    if (candidate && items.some((item) => Number(item.id) === candidate)) return candidate;
  }
  const preferred = items.find((item) => ["in_progress", "active", "started", "registration_open"].includes(String(item.status)))
    || items.find((item) => !["completed", "cancelled"].includes(String(item.status)))
    || items[0];
  return Number(preferred?.id || 0);
}

async function loadTournamentList() {
  ensureTournamentRoom();
  const clubId = uxClubId();
  if (!clubId || !uxToken()) return;
  const data = await uxApi(`/clubs/${clubId}/registration-tournaments`);
  uxState.tournaments = data.items || [];
  const select = document.getElementById("trTournament");
  if (!select) return;
  select.innerHTML = uxState.tournaments.length
    ? uxState.tournaments.map((t) => `<option value="${Number(t.id)}">${uxEsc(t.name)}</option>`).join("")
    : `<option value="">Ingen turneringer</option>`;
  const selected = chooseInitialTournament(uxState.tournaments);
  if (selected) selectTournament(selected, true);
  await loadTournamentContext();
}

function contextNextStep({ tournament, activeCount, checkedIn, groupCount, progress, playoff }) {
  const status = String(tournament?.status || "");
  if (status === "completed") return { label: "Se og publiser resultatene", view: "results", focusId: "tsaTitle" };
  if (activeCount === 0) return { label: "Få deltakere inn i turneringen", view: "participants", focusId: "tcPlayer" };
  if (groupCount === 0 && checkedIn < activeCount) return { label: `Fortsett check-in · ${checkedIn}/${activeCount} klare`, view: "participants", focusId: "tcRegistrations" };
  if (groupCount === 0) return { label: "Trekk puljene", view: "participants", focusId: "tcDraw" };
  if (Number(progress?.total || 0) === 0) return { label: "Generer gruppekamper", view: "participants", focusId: "tcGenerate" };
  if (Number(progress?.completed || 0) < Number(progress?.total || 0)) return { label: "Følg kampene og ledige boards", view: "matches", focusId: "opsBoards" };
  if (!playoff?.playoff) return { label: "Opprett sluttspillet", view: "playoffs", focusId: "poGenerate" };
  return { label: "Følg sluttspillet", view: "playoffs", focusId: "poBracket" };
}

async function loadTournamentContext() {
  const id = uxState.tournamentId;
  if (!id || uxState.loading) return;
  uxState.loading = true;
  try {
    const settled = await Promise.allSettled([
      uxApi(`/tournaments/${id}`),
      uxApi(`/tournaments/${id}/groups`),
      uxApi(`/tournaments/${id}/operations`),
      uxApi(`/tournaments/${id}/playoffs`),
    ]);
    const detail = settled[0].status === "fulfilled" ? settled[0].value : {};
    const groups = settled[1].status === "fulfilled" ? settled[1].value : {};
    const operations = settled[2].status === "fulfilled" ? settled[2].value : {};
    const playoff = settled[3].status === "fulfilled" ? settled[3].value : {};
    const tournament = detail.tournament || uxState.tournaments.find((item) => Number(item.id) === id) || {};
    const registrations = tournament.registrations || [];
    const active = registrations.filter((item) => !["withdrawn", "no_show"].includes(String(item.status)));
    const checkedIn = registrations.filter((item) => String(item.status) === "checked_in" || item.checked_in_at).length;
    const groupCount = (groups.groups || []).length;
    const progress = operations.progress || {};
    const boardCount = (operations.boards || []).length;
    const next = contextNextStep({ tournament, activeCount: active.length, checkedIn, groupCount, progress, playoff });

    document.getElementById("trTitle").textContent = tournament.name || "Turneringsrom";
    const start = tournament.start_at ? new Date(String(tournament.start_at).replace(" ", "T")) : null;
    document.getElementById("trSubtitle").textContent = start && !Number.isNaN(start.getTime())
      ? `${new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }).format(start)} · ${String(tournament.status || "")}`
      : `Status: ${String(tournament.status || "—")}`;
    document.getElementById("trProgress").innerHTML = [
      ["Deltakere", active.length],
      ["Checket inn", `${checkedIn}/${active.length || 0}`],
      ["Kamper", `${Number(progress.completed || 0)}/${Number(progress.total || 0)}`],
      ["Boards", boardCount],
    ].map(([label, value]) => `<div><span>${uxEsc(label)}</span><strong>${uxEsc(value)}</strong></div>`).join("");
    const nextRoot = document.getElementById("trNext");
    nextRoot.querySelector(".tournament-room-next-copy").innerHTML = `<strong>Neste anbefalte steg</strong><small>${uxEsc(next.label)}</small>`;
    const nextButton = document.getElementById("trNextButton");
    nextButton.disabled = false;
    nextButton.textContent = next.label;
    nextButton.dataset.targetView = next.view;
    nextButton.dataset.focusId = next.focusId || "";
    renderOverviewNext(tournament, next, active.length, checkedIn, progress);
    syncTournamentSelectors();
  } catch (error) {
    document.getElementById("trSubtitle").textContent = error.message;
  } finally {
    uxState.loading = false;
  }
}

function renderOverviewNext(tournament, next, activeCount, checkedIn, progress) {
  const overview = document.getElementById("overview");
  if (!overview) return;
  let card = document.getElementById("adminOverviewNext");
  if (!card) {
    card = document.createElement("section");
    card.id = "adminOverviewNext";
    card.className = "admin-overview-next";
    const metrics = document.getElementById("metrics");
    metrics?.insertAdjacentElement("beforebegin", card);
  }
  card.innerHTML = `
    <div class="admin-overview-next-head">
      <div><p class="eyebrow">Neste i klubbdriften</p><h2>${uxEsc(tournament.name || "Turnering")}</h2><p class="muted">${uxEsc(next.label)}</p></div>
      <div class="admin-overview-next-status"><span class="pill">${activeCount} deltakere</span><span class="pill">${checkedIn} checket inn</span><span class="pill">${Number(progress.completed || 0)}/${Number(progress.total || 0)} kamper</span></div>
    </div>
    <div class="admin-overview-next-actions"><a class="button" href="#tournaments" data-open-tournament-room>Åpne turneringsrom</a><a class="button secondary" href="../live/" target="_blank" rel="noopener">Åpne Live</a></div>`;
  card.querySelector("[data-open-tournament-room]")?.addEventListener("click", () => window.setTimeout(() => setTournamentView(next.view), 30));
}

function observeTournamentModules() {
  const host = document.getElementById("tournaments");
  if (!host) return;
  const observer = new MutationObserver(() => {
    bindChildTournamentSelectors();
    syncTournamentSelectors();
    setTournamentView(uxState.view);
  });
  observer.observe(host, { childList: true, subtree: true });
  bindChildTournamentSelectors();
}

function bootAdminUx() {
  normalizeAdminNavigation();
  ensureTournamentRoom();
  observeTournamentModules();
  const wait = window.setInterval(() => {
    normalizeAdminNavigation();
    if (!uxToken() || !uxClubId() || document.getElementById("adminApp")?.classList.contains("hidden")) return;
    clearInterval(wait);
    loadTournamentList().catch(() => undefined);
  }, 250);
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    uxState.tournamentId = 0;
    localStorage.removeItem("bd:adminTournamentId");
    window.setTimeout(() => loadTournamentList().catch(() => undefined), 100);
  });
  document.getElementById("refreshAllButton")?.addEventListener("click", () => window.setTimeout(() => loadTournamentList().catch(() => undefined), 100));
}

bootAdminUx();
