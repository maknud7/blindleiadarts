const API_ROOT = "../api/v1";
const registrationList = document.getElementById("registrationList");
const tournamentList = document.getElementById("tournamentList");
const refreshButton = document.getElementById("refreshButton");
const signupSection = registrationList?.closest("section") || null;
const tournamentSection = tournamentList?.closest("section") || null;
let enhancing = false;
let refreshTimer = null;
let observer = null;

function token() { return localStorage.getItem("bd:token") || ""; }

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

function focusRegistrations(registrations) {
  if (!registrationList || !signupSection) return;
  if (!token()) {
    signupSection.classList.add("hidden");
    return;
  }

  const relevant = registrations.filter(isRelevantRegistration);
  const names = new Set(relevant.map((registration) => String(registration.tournament_name || "").trim()).filter(Boolean));
  const cards = [...registrationList.querySelectorAll(":scope > .list-item")];
  cards.forEach((card) => card.classList.toggle("hidden", !names.has(cardName(card))));

  if (!relevant.length) {
    signupSection.classList.add("hidden");
    return;
  }

  signupSection.classList.remove("hidden");
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
    }
  });
  const stack = card.querySelector(".stack");
  if (stack) stack.appendChild(button);
  else card.appendChild(button);
}

function applyMembershipEligibility(eligibility) {
  if (!tournamentList) return;
  const blocked = eligibility?.can_register === false;
  tournamentList.querySelectorAll(".membership-registration-note").forEach((node) => node.remove());

  tournamentList.querySelectorAll("[data-payment-locked]").forEach((button) => {
    if (blocked) return;
    const tournamentId = button.dataset.paymentTournament;
    if (tournamentId) button.dataset.register = tournamentId;
    delete button.dataset.paymentLocked;
    delete button.dataset.paymentTournament;
    button.textContent = "Meld meg på";
  });

  if (!blocked) return;
  tournamentList.querySelectorAll("[data-register]").forEach((button) => {
    const tournamentId = String(button.dataset.register || "");
    if (!tournamentId) return;
    delete button.dataset.register;
    button.dataset.paymentLocked = "1";
    button.dataset.paymentTournament = tournamentId;
    button.textContent = "Påmelding låst · kontingent";
    const note = document.createElement("p");
    note.className = "muted membership-registration-note";
    note.textContent = eligibility.message || "Kontingenten må ordnes før du kan melde deg på nye turneringer.";
    button.parentElement?.insertBefore(note, button);
  });
}

function disconnectObserver() { observer?.disconnect(); }
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
    const [dashboard, eligibilityData] = await Promise.all([
      token() ? api("/me/dashboard", { auth: true }).catch(() => null) : Promise.resolve(null),
      token() ? api("/me/eligibility", { auth: true }).catch(() => null) : Promise.resolve(null),
    ]);
    const registrations = dashboard?.dashboard?.registrations || [];
    const eligibility = eligibilityData?.eligibility || null;

    focusRegistrations(registrations);
    for (const registration of registrations) {
      if (String(registration.status) !== "checked_in") continue;
      if (["in_progress", "completed", "archived"].includes(String(registration.tournament_status))) continue;
      const tournamentId = Number(registration.tournament_id || 0);
      const name = String(registration.tournament_name || "");
      if (!tournamentId || !name) continue;
      addWithdraw(findCard(registrationList, name), tournamentId);
      addWithdraw(findCard(tournamentList, name), tournamentId);
    }
    applyMembershipEligibility(eligibility);
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
tournamentList?.addEventListener("click", (event) => {
  const locked = event.target.closest("[data-payment-locked]");
  if (!locked) return;
  window.location.hash = "#profile";
  window.setTimeout(() => document.getElementById("memberAccountSection")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
});
window.setTimeout(enhance, 400);
