const API_ROOT = "../api/v1";
const registrationList = document.getElementById("registrationList");
const tournamentList = document.getElementById("tournamentList");
const refreshButton = document.getElementById("refreshButton");
let enhancing = false;

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

function findCard(root, name) {
  if (!root || !name) return null;
  return [...root.querySelectorAll(".list-item")].find((card) => (card.textContent || "").includes(name)) || null;
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
      window.setTimeout(enhance, 350);
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

async function enhance() {
  if (enhancing || !token()) return;
  enhancing = true;
  try {
    const dashboard = await api("/me/dashboard", { auth: true });
    const registrations = dashboard.dashboard?.registrations || [];
    for (const registration of registrations) {
      if (String(registration.status) !== "checked_in") continue;
      if (["in_progress", "completed", "archived"].includes(String(registration.tournament_status))) continue;
      const tournamentId = Number(registration.tournament_id || 0);
      const name = String(registration.tournament_name || "");
      if (!tournamentId || !name) continue;
      addWithdraw(findCard(registrationList, name), tournamentId);
      addWithdraw(findCard(tournamentList, name), tournamentId);
    }
  } catch {
    // Base player portal owns authentication and error presentation.
  } finally {
    enhancing = false;
  }
}

const observer = new MutationObserver(() => window.setTimeout(enhance, 0));
if (registrationList) observer.observe(registrationList, { childList: true, subtree: true });
if (tournamentList) observer.observe(tournamentList, { childList: true, subtree: true });
refreshButton?.addEventListener("click", () => window.setTimeout(enhance, 350));
document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(enhance, 350));
window.setTimeout(enhance, 400);
