const API_ROOT = "../api/v1";
const registrationList = document.getElementById("registrationList");
const tournamentList = document.getElementById("tournamentList");
const refreshButton = document.getElementById("refreshButton");
const signupSection = registrationList?.closest("section") || null;
const tournamentSection = tournamentList?.closest("section") || null;
const visibleUpcomingLimit = 3;
let enhancing = false;
let refreshTimer = null;
let observer = null;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }

async function api(path, { method = "GET", auth = false } = {}) {
  const headers = {};
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function cardName(card) {
  return String(card?.querySelector("strong")?.textContent || "").trim();
}

function findCard(root, name) {
  if (!root || !name) return null;
  return [...root.querySelectorAll(":scope > .list-item")].find((card) => cardName(card) === name)
    || [...root.querySelectorAll(".list-item")].find((card) => (card.textContent || "").includes(name))
    || null;
}

function parseStart(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(String(value).replace(" ", "T")).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isFinishedTournamentStatus(value) {
  return ["completed", "archived", "cancelled", "canceled"].includes(String(value || "").toLowerCase());
}

function isRelevantRegistration(registration) {
  const registrationStatus = String(registration?.status || "").toLowerCase();
  const tournamentStatus = String(registration?.tournament_status || "").toLowerCase();
  if (isFinishedTournamentStatus(tournamentStatus)) return false;
  if (["withdrawn", "no_show"].includes(registrationStatus)) return false;
  return ["registered", "waitlisted", "checked_in", "eliminated"].includes(registrationStatus);
}

function isUpcomingTournament(tournament) {
  const status = String(tournament?.status || tournament?.tournament_status || "").toLowerCase();
  if (isFinishedTournamentStatus(status) || status === "in_progress") return false;
  const start = parseStart(tournament?.start_at);
  if (!Number.isFinite(start)) return true;
  return start >= Date.now();
}

function prepareSectionCopy() {
  const signupHeading = signupSection?.querySelector("h2");
  if (signupHeading) signupHeading.textContent = "Neste for meg";

  const helper = [...(signupSection?.children || [])].find((element) =>
    element.classList?.contains("mini-card") && String(element.textContent || "").includes("Innsjekk i lokalet")
  );
  helper?.remove();

  const tournamentEyebrow = tournamentSection?.querySelector(".eyebrow");
  const tournamentHeading = tournamentSection?.querySelector("h2");
  if (tournamentEyebrow) tournamentEyebrow.textContent = "Kommende";
  if (tournamentHeading) tournamentHeading.textContent = "Kommende turneringer";
}

function addWithdraw(card, tournamentId) {
  if (!card || card.querySelector(`[data-checked-in-withdraw="${tournamentId}"]`)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.dataset.checkedInWithdraw = String(tournamentId);
  button.textContent = "Meld meg av";
  button.addEventListener("click", async () => {
    if (!window.confirm("Melde deg av turneringen? Du mister også innsjekkingen.")) return;
    button.disabled = true;
    try {
      await api(`/tournaments/${tournamentId}/register`, { method: "DELETE", auth: true });
      refreshButton?.click();
      scheduleEnhance(350);
    } catch (error) {
      button.disabled = false;
      const status = document.getElementById("statusArea");
      if (status) {
        const item = document.createElement("div");
        item.className = "mini-card";
        item.innerHTML = `<strong>Kunne ikke melde av</strong><p class="muted"></p>`;
        item.querySelector("p").textContent = error.message;
        status.prepend(item);
      }
    }
  });
  const stack = card.querySelector(".stack");
  if (stack) stack.appendChild(button);
  else card.appendChild(button);
}

function focusRegistrations(registrations) {
  if (!registrationList || !signupSection) return;

  if (!token()) {
    signupSection.classList.add("hidden");
    return;
  }

  const relevant = registrations.filter(isRelevantRegistration);
  const relevantNames = new Set(relevant.map((registration) => String(registration.tournament_name || "").trim()).filter(Boolean));
  const cards = [...registrationList.querySelectorAll(":scope > .list-item")];

  cards.forEach((card) => {
    card.classList.toggle("hidden", !relevantNames.has(cardName(card)));
  });

  if (!relevant.length) {
    signupSection.classList.add("hidden");
    return;
  }

  signupSection.classList.remove("hidden");
  relevant.forEach((registration) => {
    const name = String(registration.tournament_name || "").trim();
    const card = findCard(registrationList, name);
    if (card && card.parentElement === registrationList) registrationList.appendChild(card);
  });
}

function focusUpcomingTournaments(tournaments) {
  if (!tournamentList) return;

  tournamentList.querySelector("[data-upcoming-overflow]")?.remove();
  const cards = [...tournamentList.querySelectorAll(":scope > .list-item")];
  const upcoming = tournaments
    .filter(isUpcomingTournament)
    .sort((a, b) => parseStart(a.start_at) - parseStart(b.start_at));
  const byName = new Map(cards.map((card) => [cardName(card), card]));
  const upcomingNames = new Set(upcoming.map((tournament) => String(tournament.name || "").trim()).filter(Boolean));

  cards.forEach((card) => card.classList.toggle("hidden", !upcomingNames.has(cardName(card))));

  const orderedCards = [];
  upcoming.forEach((tournament) => {
    const card = byName.get(String(tournament.name || "").trim());
    if (!card) return;
    card.classList.remove("hidden");
    tournamentList.appendChild(card);
    orderedCards.push(card);
  });

  if (!orderedCards.length) {
    const empty = document.createElement("div");
    empty.className = "mini-card";
    empty.dataset.upcomingOverflow = "empty";
    empty.innerHTML = `<strong>Ingen kommende turneringer</strong><p class="muted">Ferdige turneringer og kamper finner du under Statistikk.</p>`;
    tournamentList.appendChild(empty);
    return;
  }

  const laterCards = orderedCards.slice(visibleUpcomingLimit);
  laterCards.forEach((card) => card.classList.add("hidden"));
  if (!laterCards.length) return;

  const control = document.createElement("div");
  control.className = "mini-card";
  control.dataset.upcomingOverflow = "control";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = `Vis ${laterCards.length} senere turneringer`;
  let expanded = false;
  button.addEventListener("click", () => {
    expanded = !expanded;
    laterCards.forEach((card) => card.classList.toggle("hidden", !expanded));
    button.textContent = expanded ? "Vis færre turneringer" : `Vis ${laterCards.length} senere turneringer`;
  });
  control.appendChild(button);
  tournamentList.appendChild(control);
}

function disconnectObserver() {
  observer?.disconnect();
}

function connectObserver() {
  if (!observer) return;
  if (registrationList) observer.observe(registrationList, { childList: true, subtree: true });
  if (tournamentList) observer.observe(tournamentList, { childList: true, subtree: true });
}

async function enhance() {
  if (enhancing) return;
  enhancing = true;
  disconnectObserver();
  try {
    prepareSectionCopy();
    const currentClubId = clubId();
    const [dashboard, tournamentData] = await Promise.all([
      token() ? api("/me/dashboard", { auth: true }).catch(() => null) : Promise.resolve(null),
      currentClubId ? api(`/clubs/${currentClubId}/registration-tournaments`).catch(() => null) : Promise.resolve(null),
    ]);
    const registrations = dashboard?.dashboard?.registrations || [];
    const tournaments = tournamentData?.items || [];

    for (const registration of registrations) {
      if (String(registration.status) !== "checked_in") continue;
      if (["in_progress", "completed", "archived"].includes(String(registration.tournament_status))) continue;
      const tournamentId = Number(registration.tournament_id || 0);
      const name = String(registration.tournament_name || "");
      if (!tournamentId || !name) continue;
      addWithdraw(findCard(registrationList, name), tournamentId);
      addWithdraw(findCard(tournamentList, name), tournamentId);
    }

    focusRegistrations(registrations);
    if (tournamentData) focusUpcomingTournaments(tournaments);
  } finally {
    enhancing = false;
    connectObserver();
  }
}

function scheduleEnhance(delay = 80) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(enhance, delay);
}

observer = new MutationObserver(() => scheduleEnhance());
connectObserver();
refreshButton?.addEventListener("click", () => scheduleEnhance(350));
document.getElementById("clubSelect")?.addEventListener("change", () => scheduleEnhance(350));
window.setTimeout(enhance, 400);
