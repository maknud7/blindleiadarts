const DETAIL_API_ROOT = "../api/v1";
let detailTournamentId = 0;
let detailEnhanceTimer = null;
const detailPlayerCache = new Map();

function detailNormalizeName(value){
  return String(value ?? "")
    .replace(/✓/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("nb-NO");
}

async function detailPlayersForTournament(id){
  if(!id) return new Map();
  if(detailPlayerCache.has(id)) return detailPlayerCache.get(id);
  const promise = fetch(`${DETAIL_API_ROOT}/tournaments/${id}`, { cache: "no-store" })
    .then(response => response.json().catch(() => null))
    .then(payload => {
      if(!payload?.ok) return new Map();
      const tournament = payload.data?.tournament || payload.data || {};
      const registrations = Array.isArray(tournament.registrations) ? tournament.registrations : [];
      const grouped = new Map();
      registrations.forEach(player => {
        const playerId = Number(player.player_id || player.id || 0);
        const name = detailNormalizeName(player.display_name || player.player_name || player.name);
        if(!playerId || !name) return;
        if(!grouped.has(name)) grouped.set(name, []);
        grouped.get(name).push(playerId);
      });
      const unique = new Map();
      grouped.forEach((ids, name) => {
        const distinct = [...new Set(ids)];
        if(distinct.length === 1) unique.set(name, distinct[0]);
      });
      return unique;
    })
    .catch(() => new Map());
  detailPlayerCache.set(id, promise);
  return promise;
}

function detailLoadStyles(){
  if(document.getElementById("tournamentDetailDesktopUxStyles")) return;
  const link = document.createElement("link");
  link.id = "tournamentDetailDesktopUxStyles";
  link.rel = "stylesheet";
  link.href = new URL("./tournament-detail-desktop-ux.css?v=20260831-0845", import.meta.url).href;
  document.head.appendChild(link);
}

function detailDirectName(node){
  if(!node) return "";
  const direct = [...node.childNodes]
    .filter(child => child.nodeType === Node.TEXT_NODE)
    .map(child => child.textContent || "")
    .join(" ")
    .trim();
  return direct || String(node.textContent || "").replace(/✓/g, "").trim();
}

function markDetailPlayerRow(row, playerId, { arrow = false } = {}){
  if(!row || !playerId) return;
  row.dataset.tdxProfilePlayer = String(playerId);
  row.classList.add("is-player-link");
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.setAttribute("title", "Åpne spillerprofil");
  if(arrow && !row.querySelector(".tdx-player-arrow")){
    const arrowNode = document.createElement("span");
    arrowNode.className = "tdx-player-arrow";
    arrowNode.setAttribute("aria-hidden", "true");
    arrowNode.textContent = "›";
    row.appendChild(arrowNode);
  }
}

async function enhanceTournamentDetail(){
  const dialog = document.querySelector("dialog.tdx-detail");
  if(!dialog?.open) return;
  dialog.classList.add("tdx-responsive-detail");

  const playerSection = [...dialog.querySelectorAll(".tdx-section")]
    .find(section => section.querySelector(".tdx-person"));
  playerSection?.classList.add("tdx-players-section");

  if(!detailTournamentId) return;
  const players = await detailPlayersForTournament(detailTournamentId);
  if(!dialog.open || !players.size) return;

  dialog.querySelectorAll(".tdx-person").forEach(row => {
    const name = row.querySelector("strong")?.textContent || "";
    const playerId = players.get(detailNormalizeName(name));
    if(playerId) markDetailPlayerRow(row, playerId, { arrow: true });
  });

  dialog.querySelectorAll(".tdx-group-tr:not(.tdx-group-th)").forEach(row => {
    const nameNode = row.querySelector(".tdx-group-name");
    const playerId = players.get(detailNormalizeName(detailDirectName(nameNode)));
    if(playerId) markDetailPlayerRow(row, playerId);
  });
}

function scheduleDetailEnhance(){
  window.clearTimeout(detailEnhanceTimer);
  detailEnhanceTimer = window.setTimeout(() => enhanceTournamentDetail().catch(() => undefined), 50);
}

function openDetailPlayerProfile(playerId){
  if(!playerId) return;
  const dialog = document.querySelector("dialog.tdx-detail");
  if(dialog?.open) dialog.close();
  localStorage.setItem("bd:statisticsView", "players");
  window.location.hash = "#statistics";

  let attempts = 0;
  const open = () => {
    attempts += 1;
    document.querySelector('[data-statistics-view="players"]')?.click();
    const playerCard = document.querySelector(`#playerDirectory [data-player-profile="${Number(playerId)}"]`);
    if(playerCard){
      playerCard.click();
      window.setTimeout(() => document.getElementById("playerProfile")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
      return;
    }
    if(attempts < 12) window.setTimeout(open, 120);
  };
  window.setTimeout(open, 80);
}

detailLoadStyles();

document.addEventListener("click", event => {
  const source = event.target instanceof Element ? event.target : null;
  const tournamentOpen = source?.closest("[data-open]");
  if(tournamentOpen){
    detailTournamentId = Number(tournamentOpen.getAttribute("data-open") || 0);
    scheduleDetailEnhance();
  }

  const playerRow = source?.closest("[data-tdx-profile-player]");
  if(playerRow){
    event.preventDefault();
    event.stopPropagation();
    openDetailPlayerProfile(Number(playerRow.getAttribute("data-tdx-profile-player") || 0));
  }
}, true);

document.addEventListener("keydown", event => {
  if(!["Enter", " "].includes(event.key)) return;
  const row = event.target instanceof Element ? event.target.closest("[data-tdx-profile-player]") : null;
  if(!row) return;
  event.preventDefault();
  openDetailPlayerProfile(Number(row.getAttribute("data-tdx-profile-player") || 0));
});

const detailObserver = new MutationObserver(scheduleDetailEnhance);
detailObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "open"] });
window.addEventListener("resize", scheduleDetailEnhance);
