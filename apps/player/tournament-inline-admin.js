// Tournament control has ONE canonical home: the Clubadmin tournament room.
// Player tournament details may offer an administrator shortcut, but must
// never maintain a second check-in/start workflow or duplicate mutations.
const dialog = document.querySelector("dialog.tdx-detail");
const adminAccessByTournament = new Map();
let activeTournamentId = "";
let pending = 0;

const style = document.createElement("style");
style.textContent = `
.tdx-detail.has-leader-link .tdx-detail-tabs{grid-template-columns:repeat(4,minmax(0,1fr))!important}
.tdx-detail.has-leader-link .tdx-detail-tabs button{min-width:0;padding:0 3px;font-size:clamp(11px,3vw,15px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdx-leader-tab{color:#174f91!important}
.tdx-leader-tab:focus-visible{outline:3px solid #174f91;outline-offset:2px}
`;
document.head.appendChild(style);

function currentToken() { return localStorage.getItem("bd:token") || ""; }
async function mayLeadTournament(id) {
  const token = currentToken();
  if (!token || !id) return false;
  const key = `${token.slice(0,12)}:${id}`;
  if (adminAccessByTournament.has(key)) return adminAccessByTournament.get(key);
  try {
    const response = await fetch(`../api/v1/tournaments/${encodeURIComponent(id)}/checkin-settings`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    const allowed = Boolean(payload?.ok);
    if (allowed) adminAccessByTournament.set(key, true);
    return allowed;
  } catch { return false; }
}

async function showLeaderShortcut() {
  const id = activeTournamentId;
  const generation = ++pending;
  if (!dialog?.open || !id) return;
  if (!await mayLeadTournament(id)) return;
  if (generation !== pending || !dialog.open || id !== activeTournamentId) return;
  const tabs = dialog.querySelector(".tdx-detail-tabs");
  if (!tabs) return;
  dialog.classList.add("has-leader-link");
  let button = tabs.querySelector(".tdx-leader-tab");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "tdx-leader-tab tdx-admin-tab";
    button.textContent = "Ledelse";
    button.title = "Åpne turneringsrommet i Klubbadmin";
    tabs.appendChild(button);
  }
  button.onclick = () => {
    sessionStorage.setItem("bd:leader:selectedTournamentId", id);
    window.location.assign("../#tournament-admin");
  };
}

document.addEventListener("click", (event) => {
  const trigger = event.target instanceof Element ? event.target.closest("[data-open]") : null;
  if (!trigger) return;
  const id = String(trigger.getAttribute("data-open") || "");
  if (!/^[1-9][0-9]*$/.test(id)) return;
  activeTournamentId = id;
  window.setTimeout(showLeaderShortcut, 100);
}, true);

// The active detail rerenders tabs after player actions. Watch only this
// dialog, not document.body, and coalesce to a single animation frame.
if (dialog) {
  let frame = 0;
  const observer = new MutationObserver((records) => {
    if (!dialog.open || !activeTournamentId) return;
    if (!records.some((r) => [...r.addedNodes].some((node) =>
      node.nodeType === Node.ELEMENT_NODE && (node.classList?.contains("tdx-detail-tabs")
        || node.querySelector?.(".tdx-detail-tabs"))))) return;
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      showLeaderShortcut().catch(() => undefined);
    });
  });
  observer.observe(dialog, { childList: true, subtree: true });
}
