const UX_API_ROOT = "../api/v1";
const UX_VIEWS = ["overview", "participants", "matches", "playoffs", "results"];
const uxState = {
  tournaments: [],
  tournamentId: Number(localStorage.getItem("bd:adminTournamentId") || 0),
  view: sessionStorage.getItem("bd:tournamentRoomView") || "overview",
  syncing: false,
  loading: false,
};

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function api(path) {
  const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
  const response = await fetch(`${UX_API_ROOT}${path}`, { headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function normalizeAdminNavigation() {
  const nav = document.querySelector(".section-nav.portal-menu");
  if (!nav) return;
  const labels = { "#overview": "Oversikt", "#tournaments": "Turneringer", "#players": "Personer", "#kiosks": "Utstyr", "#integrations": "Innstillinger" };
  for (const [href, label] of Object.entries(labels)) {
    const link = nav.querySelector(`a[href="${href}"]`);
    if (link) link.textContent = label;
  }
  nav.querySelector('a[href="#screens"]')?.remove();
  const screens = document.getElementById("screens");
  if (screens) screens.dataset.portalSection = "kiosks";
  if (!nav.querySelector(".admin-menu-label")) {
    const label = document.createElement("span");
    label.className = "admin-menu-label";
    label.textContent = "Administrasjon";
    nav.prepend(label);
  }
}

function ensureRoom() {
  const host = document.getElementById("tournaments");
  if (!host || document.getElementById("tournamentRoom")) return;
  host.classList.add("tournament-room-ready");
  const room = document.createElement("section");
  room.id = "tournamentRoom";
  room.className = "tournament-room";
  room.innerHTML = `
    <div class="tournament-room-top">
      <div class="tournament-room-copy"><p class="eyebrow">Turneringsrom</p><h2 id="trTitle">Velg turnering</h2><p id="trSubtitle" class="muted">Alt arbeid med én turnering skjer i samme kontekst.</p></div>
      <label class="tournament-room-select"><span>Turnering</span><select id="trTournament"><option value="">Laster …</option></select></label>
    </div>
    <div id="trProgress" class="tournament-room-progress"></div>
    <div id="trNext" class="tournament-room-next"><div class="tournament-room-next-copy"><strong>Neste anbefalte steg</strong><small>Velg en turnering.</small></div><button id="trNextButton" type="button" class="button" disabled>Åpne</button></div>
    <nav class="tournament-room-tabs" aria-label="Arbeidsområder i turneringen">
      <button type="button" data-tr-view="overview">Oversikt</button>
      <button type="button" data-tr-view="participants">Deltakere</button>
      <button type="button" data-tr-view="matches">Kamper & boards</button>
      <button type="button" data-tr-view="playoffs">Sluttspill</button>
      <button type="button" data-tr-view="results">Resultater</button>
    </nav>`;
  host.querySelector(":scope > .panel-head")?.insertAdjacentElement("afterend", room);

  document.getElementById("trTournament")?.addEventListener("change", async (event) => {
    chooseTournament(Number(event.currentTarget.value || 0), true);
    await loadContext();
  });
  room.querySelectorAll("[data-tr-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.trView)));
  document.getElementById("trNextButton")?.addEventListener("click", () => {
    const button = document.getElementById("trNextButton");
    setView(button?.dataset.targetView || "overview");
    const focusId = button?.dataset.focusId || "";
    if (focusId) setTimeout(() => document.getElementById(focusId)?.focus?.(), 100);
  });
  setView(uxState.view);
}

function panels() {
  const host = document.getElementById("tournaments");
  if (!host) return Object.fromEntries(UX_VIEWS.map((view) => [view, []]));
  const participants = [...host.querySelectorAll(":scope > .tournament-control")]
    .filter((node) => !node.classList.contains("playoff-control") && !node.classList.contains("tc-summary-admin"));
  return {
    overview: [document.getElementById("tournamentList")].filter(Boolean),
    participants,
    matches: [...host.querySelectorAll(":scope > .ops-admin-panel")],
    playoffs: [...host.querySelectorAll(":scope > .playoff-control")],
    results: [...host.querySelectorAll(":scope > .tc-summary-admin")],
  };
}

function setView(view) {
  uxState.view = UX_VIEWS.includes(view) ? view : "overview";
  sessionStorage.setItem("bd:tournamentRoomView", uxState.view);
  const all = panels();
  for (const [key, nodes] of Object.entries(all)) nodes.forEach((node) => node.classList.toggle("tournament-room-view-hidden", key !== uxState.view));
  document.querySelectorAll("#tournamentRoom [data-tr-view]").forEach((button) => button.classList.toggle("active", button.dataset.trView === uxState.view));

  let empty = document.getElementById("tournamentRoomEmpty");
  if ((all[uxState.view] || []).length === 0 && uxState.view !== "overview") {
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "tournamentRoomEmpty";
      empty.className = "tournament-room-empty";
      document.getElementById("tournaments")?.appendChild(empty);
    }
    empty.textContent = "Laster dette arbeidsområdet …";
    empty.classList.remove("hidden");
  } else {
    empty?.classList.add("hidden");
  }
}

function childTournamentSelects() {
  return [...document.querySelectorAll('#tournaments select[id*="Tournament"]')].filter((select) => select.id !== "trTournament");
}

function syncSelectors() {
  if (!uxState.tournamentId) return;
  uxState.syncing = true;
  for (const select of childTournamentSelects()) {
    if (![...select.options].some((option) => Number(option.value) === uxState.tournamentId)) continue;
    if (Number(select.value || 0) === uxState.tournamentId) continue;
    select.value = String(uxState.tournamentId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  setTimeout(() => { uxState.syncing = false; }, 0);
}

function bindChildSelectors() {
  for (const select of childTournamentSelects()) {
    if (select.dataset.uxTournamentBound === "1") continue;
    select.dataset.uxTournamentBound = "1";
    select.addEventListener("change", () => {
      if (uxState.syncing) return;
      const id = Number(select.value || 0);
      if (!id || id === uxState.tournamentId) return;
      chooseTournament(id, false);
      loadContext().catch(() => undefined);
    });
  }
}

function chooseTournament(id, propagate) {
  if (!id) return;
  uxState.tournamentId = id;
  localStorage.setItem("bd:adminTournamentId", String(id));
  const room = document.getElementById("trTournament");
  if (room && [...room.options].some((option) => Number(option.value) === id)) room.value = String(id);
  if (propagate) syncSelectors();
}

function initialTournament(items) {
  const query = Number(new URLSearchParams(location.search).get("tournament") || 0);
  for (const candidate of [query, uxState.tournamentId]) if (candidate && items.some((item) => Number(item.id) === candidate)) return candidate;
  const preferred = items.find((item) => ["in_progress", "active", "started"].includes(String(item.status)))
    || items.find((item) => !["completed", "cancelled"].includes(String(item.status)))
    || items[0];
  return Number(preferred?.id || 0);
}

async function loadTournamentList() {
  ensureRoom();
  if (!clubId() || !token()) return;
  const data = await api(`/clubs/${clubId()}/registration-tournaments`);
  uxState.tournaments = data.items || [];
  const select = document.getElementById("trTournament");
  if (!select) return;
  select.innerHTML = uxState.tournaments.length
    ? uxState.tournaments.map((item) => `<option value="${Number(item.id)}">${esc(item.name)}</option>`).join("")
    : `<option value="">Ingen turneringer</option>`;
  const id = initialTournament(uxState.tournaments);
  if (id) chooseTournament(id, true);
  await loadContext();
}

function nextStep({ tournament, participantCount, checkedIn, groupCount, progress, hasPlayoff }) {
  const status = String(tournament?.status || "");
  if (status === "completed") return { label: "Se og publiser resultatene", view: "results", focusId: "tsaTitle" };
  if (participantCount === 0) return { label: "Få deltakere inn i turneringen", view: "participants", focusId: "tcPlayer" };
  if (!groupCount && checkedIn < participantCount) return { label: `Fortsett check-in · ${checkedIn}/${participantCount} klare`, view: "participants", focusId: "tcRegistrations" };
  if (!groupCount) return { label: "Trekk puljene", view: "participants", focusId: "tcDraw" };
  if (hasPlayoff) return { label: "Følg sluttspillet", view: "playoffs", focusId: "poBracket" };
  if (Number(progress?.total || 0) === 0) return { label: "Generer gruppekamper", view: "participants", focusId: "tcGenerate" };
  if (Number(progress?.completed || 0) < Number(progress?.total || 0)) return { label: "Følg kampene og ledige boards", view: "matches", focusId: "opsBoards" };
  return { label: "Opprett sluttspillet", view: "playoffs", focusId: "poGenerate" };
}

async function loadContext() {
  const id = uxState.tournamentId;
  if (!id || uxState.loading) return;
  uxState.loading = true;
  try {
    const settled = await Promise.allSettled([
      api(`/tournaments/${id}`),
      api(`/tournaments/${id}/groups`),
      api(`/tournaments/${id}/operations`),
      api(`/tournaments/${id}/playoffs`),
    ]);
    const detail = settled[0].status === "fulfilled" ? settled[0].value : {};
    const groups = settled[1].status === "fulfilled" ? settled[1].value : {};
    const operations = settled[2].status === "fulfilled" ? settled[2].value : {};
    const playoffData = settled[3].status === "fulfilled" ? settled[3].value : {};
    const tournament = detail.tournament || uxState.tournaments.find((item) => Number(item.id) === id) || {};
    const registrations = tournament.registrations || [];
    const participants = registrations.filter((item) => !["withdrawn", "no_show"].includes(String(item.status)));
    const checkedIn = registrations.filter((item) => String(item.status) === "checked_in" || item.checked_in_at).length;
    const groupCount = (groups.groups || []).length;
    const progress = operations.progress || {};
    const boardCount = (operations.boards || []).length;
    const hasPlayoff = Boolean(playoffData?.bracket?.playoff);
    const next = nextStep({ tournament, participantCount: participants.length, checkedIn, groupCount, progress, hasPlayoff });

    document.getElementById("trTitle").textContent = tournament.name || "Turneringsrom";
    const start = tournament.start_at ? new Date(String(tournament.start_at).replace(" ", "T")) : null;
    document.getElementById("trSubtitle").textContent = start && !Number.isNaN(start.getTime())
      ? `${new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }).format(start)} · ${String(tournament.status || "")}`
      : `Status: ${String(tournament.status || "—")}`;
    document.getElementById("trProgress").innerHTML = [
      ["Deltakere", participants.length],
      ["Checket inn", `${checkedIn}/${participants.length}`],
      ["Kamper", `${Number(progress.completed || 0)}/${Number(progress.total || 0)}`],
      ["Boards", boardCount],
    ].map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");

    document.querySelector("#trNext .tournament-room-next-copy").innerHTML = `<strong>Neste anbefalte steg</strong><small>${esc(next.label)}</small>`;
    const nextButton = document.getElementById("trNextButton");
    nextButton.disabled = false;
    nextButton.textContent = next.label;
    nextButton.dataset.targetView = next.view;
    nextButton.dataset.focusId = next.focusId || "";
    renderOverviewCard(tournament, next, participants.length, checkedIn, progress);
    syncSelectors();
  } catch (error) {
    const subtitle = document.getElementById("trSubtitle");
    if (subtitle) subtitle.textContent = error.message;
  } finally {
    uxState.loading = false;
  }
}

function renderOverviewCard(tournament, next, participantCount, checkedIn, progress) {
  const overview = document.getElementById("overview");
  if (!overview) return;
  let card = document.getElementById("adminOverviewNext");
  if (!card) {
    card = document.createElement("section");
    card.id = "adminOverviewNext";
    card.className = "admin-overview-next";
    document.getElementById("metrics")?.insertAdjacentElement("beforebegin", card);
  }
  card.innerHTML = `
    <div class="admin-overview-next-head"><div><p class="eyebrow">Neste i klubbdriften</p><h2>${esc(tournament.name || "Turnering")}</h2><p class="muted">${esc(next.label)}</p></div><div class="admin-overview-next-status"><span class="pill">${participantCount} deltakere</span><span class="pill">${checkedIn} checket inn</span><span class="pill">${Number(progress.completed || 0)}/${Number(progress.total || 0)} kamper</span></div></div>
    <div class="admin-overview-next-actions"><a class="button" href="#tournaments" data-open-room>Åpne turneringsrom</a><a class="button secondary" href="../live/" target="_blank" rel="noopener">Åpne Live</a></div>`;
  card.querySelector("[data-open-room]")?.addEventListener("click", () => setTimeout(() => setView(next.view), 40));
}

function observeModules() {
  const host = document.getElementById("tournaments");
  if (!host) return;
  new MutationObserver(() => {
    bindChildSelectors();
    syncSelectors();
    setView(uxState.view);
  }).observe(host, { childList: true, subtree: true });
  bindChildSelectors();
}

function boot() {
  normalizeAdminNavigation();
  ensureRoom();
  observeModules();
  const ready = setInterval(() => {
    normalizeAdminNavigation();
    if (!token() || !clubId() || document.getElementById("adminApp")?.classList.contains("hidden")) return;
    clearInterval(ready);
    loadTournamentList().catch(() => undefined);
  }, 250);
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    uxState.tournamentId = 0;
    localStorage.removeItem("bd:adminTournamentId");
    setTimeout(() => loadTournamentList().catch(() => undefined), 100);
  });
  document.getElementById("refreshAllButton")?.addEventListener("click", () => setTimeout(() => loadTournamentList().catch(() => undefined), 100));
}

boot();
