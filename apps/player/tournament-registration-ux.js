// Tournament registration behaviour that is still needed outside the visual tournament discovery UI.
// The visual hierarchy, cards and tournament details are owned by tournament-discovery-ux.js.
const API_ROOT = "../api/v1";
const tournamentList = document.getElementById("tournamentList");
const refreshButton = document.getElementById("refreshButton");
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
  if (!observer || !tournamentList) return;
  observer.observe(tournamentList, { childList: true, subtree: true });
}

async function enhance() {
  if (enhancing) return;
  enhancing = true;
  disconnectObserver();
  try {
    const eligibilityData = token() ? await api("/me/eligibility", { auth: true }).catch(() => null) : null;
    applyMembershipEligibility(eligibilityData?.eligibility || null);
  } finally {
    enhancing = false;
    connectObserver();
  }
}

function scheduleEnhance(delay = 100) {
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
