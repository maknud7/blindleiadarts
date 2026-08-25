const API_ROOT = "../api/v1";

function token() { return localStorage.getItem("bd:token") || ""; }
function statusArea() { return document.getElementById("statusArea"); }

function showStatus(message, tone = "info") {
  const root = statusArea();
  if (!root) { window.alert(message); return; }
  const card = document.createElement("div");
  card.className = "mini-card";
  const title = tone === "error" ? "Check-in feilet" : tone === "success" ? "Check-in OK" : "Check-in";
  card.innerHTML = `<strong>${title}</strong><p class="muted"></p>`;
  card.querySelector("p").textContent = message;
  root.prepend(card);
  while (root.children.length > 4) root.lastElementChild?.remove();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureDialog() {
  if (document.getElementById("checkinCodeDialog")) return;
  const style = document.createElement("style");
  style.textContent = `.ci-dialog{border:1px solid rgba(255,255,255,.15);border-radius:18px;background:#101820;color:inherit;width:min(430px,calc(100% - 28px));padding:0;box-shadow:0 24px 80px rgba(0,0,0,.55)}.ci-dialog::backdrop{background:rgba(0,0,0,.72)}.ci-body{padding:20px;display:grid;gap:14px}.ci-body h3{margin:0}.ci-code{font-size:28px;letter-spacing:.18em;text-transform:uppercase;text-align:center;font-weight:800}.ci-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ci-message{min-height:20px}.ci-dialog button{min-height:44px}`;
  document.head.appendChild(style);
  const dialog = document.createElement("dialog");
  dialog.id = "checkinCodeDialog";
  dialog.className = "ci-dialog";
  dialog.innerHTML = `<form method="dialog" class="ci-body" id="checkinCodeForm"><div><p class="eyebrow">Turneringscheck-in</p><h3>Check inn</h3></div><p id="ciHelp" class="muted"></p><input id="ciCode" class="ci-code" inputmode="text" autocomplete="one-time-code" maxlength="12" placeholder="KODE"><div id="ciMessage" class="muted ci-message"></div><div class="ci-actions"><button id="ciCancel" type="button" class="ghost">Avbryt</button><button id="ciSubmit" type="submit">Check inn</button></div></form>`;
  document.body.appendChild(dialog);
  document.getElementById("ciCancel").addEventListener("click", () => dialog.close());
}

let activeTournamentId = 0;
let activeStatus = null;

async function openCheckin(tournamentId) {
  if (!token()) throw new Error("Logg inn før du checker inn.");
  ensureDialog();
  const dialog = document.getElementById("checkinCodeDialog");
  const status = await api(`/tournaments/${tournamentId}/check-in-status`);
  activeTournamentId = tournamentId;
  activeStatus = status;

  if (status.registration_status === "checked_in") { showStatus("Du er allerede checket inn.", "success"); return; }
  if (status.window_state === "not_open") throw new Error(`Check-in er ikke åpnet ennå. Den åpner ${String(status.opens_at).replace(" ", " kl. ")}.`);
  if (status.window_state === "closed") throw new Error("Check-in er stengt. Kontakt turneringsleder.");
  if (status.method === "admin_only") { showStatus("Denne turneringen checkes inn av turneringsleder. Gå til check-in-bordet."); return; }

  const codeInput = document.getElementById("ciCode");
  document.getElementById("ciMessage").textContent = "";
  codeInput.value = "";
  document.getElementById("ciHelp").textContent = "Tast koden som vises på Live-skjermen i lokalet. Turneringsleder kan også checke deg inn fra admin.";
  dialog.showModal();
  window.setTimeout(() => codeInput.focus(), 50);
}

async function submitCode(event) {
  event.preventDefault();
  if (!activeTournamentId || !activeStatus?.code_allowed) return;
  const code = document.getElementById("ciCode").value.trim();
  if (!code) { document.getElementById("ciMessage").textContent = "Tast inn koden fra Live-skjermen."; return; }
  const button = document.getElementById("ciSubmit");
  button.disabled = true;
  try {
    await api(`/tournaments/${activeTournamentId}/check-in`, { method: "POST", body: { code } });
    document.getElementById("checkinCodeDialog").close();
    showStatus("Du er checket inn og klar for turneringen.", "success");
    window.setTimeout(() => window.location.reload(), 500);
  } catch (error) {
    document.getElementById("ciMessage").textContent = error.message;
  } finally { button.disabled = false; }
}

ensureDialog();
document.getElementById("checkinCodeForm")?.addEventListener("submit", submitCode);

// Capture phase owns existing check-in buttons before the older app.js click handler.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-checkin]") : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const tournamentId = Number(target.getAttribute("data-checkin") || 0);
  if (!tournamentId) return;
  openCheckin(tournamentId).catch((error) => showStatus(error.message, "error"));
}, true);
