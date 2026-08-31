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
  link.href = new URL("./tournament-detail-desktop-ux.css?v=20260831-1015", import.meta.url).href;
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

function markDetailPlayerRow(row, name, { arrow = false } = {}){
  if(!row) return;
  const playerId = Number(row.dataset.tdxPlayerId || 0);
  if(!playerId && !name) return;
  if(name) row.dataset.tdxProfileName = detailNormalizeName(name);
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

function enhanceTournamentDetail(){
  const dialog = document.querySelector("dialog.tdx-detail");
  if(!dialog?.open) return;
  dialog.classList.add("tdx-responsive-detail");

  const playerSection = [...dialog.querySelectorAll(".tdx-section")]
    .find(section => section.querySelector(".tdx-person"));
  playerSection?.classList.add("tdx-players-section");

  dialog.querySelectorAll(".tdx-person").forEach(row => {
    const name = row.querySelector("strong")?.textContent || "";
    markDetailPlayerRow(row, name, { arrow: true });
  });

  dialog.querySelectorAll(".tdx-group-tr:not(.tdx-group-th)").forEach(row => {
    const nameNode = row.querySelector(".tdx-group-name");
    markDetailPlayerRow(row, detailDirectName(nameNode));
  });
}

function scheduleDetailEnhance(){
  window.clearTimeout(detailEnhanceTimer);
  detailEnhanceTimer = window.setTimeout(enhanceTournamentDetail, 35);
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

async function openDetailPlayer(row){
  if(!row) return;
  const directId = Number(row.dataset.tdxPlayerId || 0);
  if(directId){
    openDetailPlayerProfile(directId);
    return;
  }
  if(!detailTournamentId) return;
  const name = String(row.dataset.tdxProfileName || "");
  if(!name) return;
  row.classList.add("is-loading-player");
  try{
    const players = await detailPlayersForTournament(detailTournamentId);
    const playerId = Number(players.get(name) || 0);
    if(playerId) openDetailPlayerProfile(playerId);
  }finally{
    row.classList.remove("is-loading-player");
  }
}

detailLoadStyles();

document.addEventListener("click", event => {
  const source = event.target instanceof Element ? event.target : null;
  const tournamentOpen = source?.closest("[data-open]");
  if(tournamentOpen){
    detailTournamentId = Number(tournamentOpen.getAttribute("data-open") || 0);
    scheduleDetailEnhance();
  }

  const playerRow = source?.closest("[data-tdx-player-id],[data-tdx-profile-name]");
  if(playerRow){
    event.preventDefault();
    event.stopPropagation();
    openDetailPlayer(playerRow).catch(() => undefined);
  }
}, true);

document.addEventListener("keydown", event => {
  if(!["Enter", " "].includes(event.key)) return;
  const row = event.target instanceof Element ? event.target.closest("[data-tdx-player-id],[data-tdx-profile-name]") : null;
  if(!row) return;
  event.preventDefault();
  openDetailPlayer(row).catch(() => undefined);
});

const detailObserver = new MutationObserver(scheduleDetailEnhance);
detailObserver.observe(document.body, { subtree: true, childList: true });
window.addEventListener("resize", scheduleDetailEnhance);
