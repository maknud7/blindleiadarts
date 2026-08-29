const POLISH_API_ROOT = "../api/v1";

const polishStyle = document.createElement("style");
polishStyle.id = "tournamentCalendarPolishStyles";
polishStyle.textContent = `
  .tdx-root .tdx-tabs{background:#edf2f7!important;gap:5px!important;padding:5px!important}
  .tdx-root .tdx-tabs button{background:transparent!important;color:#61758b!important;border:0!important;box-shadow:none!important}
  .tdx-root .tdx-tabs button.active{background:#fff!important;color:#1767d8!important;box-shadow:0 2px 8px rgba(11,43,80,.10)!important}
  .tdx-root .tdx-next{background:linear-gradient(135deg,#eaf4ff,#f7fbff)!important;border:1px solid #bcd5f3!important;color:#0b2b50!important;box-shadow:0 8px 22px rgba(28,93,170,.10)!important}
  .tdx-root .tdx-next .tdx-kicker{color:#1767d8!important}
  .tdx-root .tdx-next h3{color:#0b2b50!important}
  .tdx-root .tdx-next .tdx-meta{color:#5f7893!important}
  .tdx-root .tdx-list{background:transparent!important;border:0!important;border-radius:0!important;overflow:visible!important;display:grid!important;gap:10px!important}
  .tdx-root .tdx-row{background:#fff!important;border:1px solid #dce6ef!important;border-left:4px solid #2f75e8!important;border-radius:16px!important;color:#0b2b50!important;box-shadow:0 4px 14px rgba(11,43,80,.06)!important;min-height:78px!important;padding:14px 14px!important}
  .tdx-root .tdx-row-title{color:#0b2b50!important}
  .tdx-root .tdx-row-sub{color:#667d95!important}
  .tdx-root .tdx-row .tdx-pill,.tdx-root .tdx-next .tdx-pill{background:#eef5ff!important;border:1px solid #c8dcf3!important;color:#174f91!important}
  .tdx-root .tdx-chevron{color:#2f75e8!important}
  @media(max-width:520px){
    .tdx-root{gap:14px!important}
    .tdx-root .tdx-head h2{font-size:29px!important}
    .tdx-root .tdx-tabs button{min-height:46px!important;font-size:14px!important;padding:0 5px!important}
    .tdx-root .tdx-next{padding:15px!important;gap:8px!important}
    .tdx-root .tdx-next h3{font-size:21px!important}
    .tdx-root .tdx-row{min-height:74px!important}
    .tdx-root .tdx-row-title{font-size:17px!important}
    .tdx-root .tdx-row-sub{font-size:13px!important}
    .tdx-root .tdx-pill{padding:6px 9px!important;font-size:12px!important}
  }
`;
document.head.appendChild(polishStyle);

function tournamentPolishDate(value){
  if(!value) return null;
  const date = new Date(String(value).replace(" ","T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function tournamentPolishFinished(t){
  const status = String(t?.status || "").toLowerCase();
  if(["completed","archived","cancelled","canceled"].includes(status)) return true;
  const end = tournamentPolishDate(t?.end_at);
  return !!end && end.getTime() < Date.now();
}

let tournamentPolishFinishedIds = new Set();
let tournamentPolishLoading = false;

async function refreshTournamentPolishState(){
  if(tournamentPolishLoading) return;
  const clubId = Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0);
  if(!clubId) return;
  tournamentPolishLoading = true;
  try{
    const response = await fetch(`${POLISH_API_ROOT}/clubs/${clubId}/tournaments`,{cache:"no-store"});
    const payload = await response.json().catch(()=>null);
    const items = payload?.ok && Array.isArray(payload?.data?.items) ? payload.data.items : [];
    tournamentPolishFinishedIds = new Set(items.filter(tournamentPolishFinished).map(t=>Number(t.id)));
  }catch(_error){
    // The calendar still works without the extra relevance pass.
  }finally{
    tournamentPolishLoading = false;
    polishTournamentCalendar();
  }
}

function polishTournamentCalendar(){
  const root = document.querySelector(".tdx-root");
  if(!root) return;

  const active = root.querySelector(".tdx-tabs button.active")?.dataset?.filter || "upcoming";
  const next = active === "upcoming" ? root.querySelector(".tdx-next[data-open]") : null;
  const nextId = next ? Number(next.dataset.open) : 0;

  root.querySelectorAll(".tdx-list .tdx-row[data-open]").forEach(row=>{
    const id = Number(row.dataset.open);
    const duplicateNext = active === "upcoming" && nextId > 0 && id === nextId;
    const staleMine = active === "mine" && tournamentPolishFinishedIds.has(id);
    row.hidden = duplicateNext || staleMine;
    row.style.display = row.hidden ? "none" : "";
  });

  const list = root.querySelector(".tdx-list");
  if(list){
    const visibleRows = [...list.querySelectorAll(".tdx-row")].filter(row=>!row.hidden);
    let empty = list.querySelector(".tdx-polish-empty");
    if(active === "mine" && visibleRows.length === 0){
      if(!empty){
        empty = document.createElement("div");
        empty.className = "tdx-empty tdx-polish-empty";
        empty.textContent = "Ingen aktuelle turneringer du er påmeldt i akkurat nå.";
        list.appendChild(empty);
      }
    }else{
      empty?.remove();
    }
  }
}

const tournamentPolishObserver = new MutationObserver(()=>polishTournamentCalendar());
tournamentPolishObserver.observe(document.body,{childList:true,subtree:true});

window.addEventListener("bd:portal-view",event=>{
  if(event.detail?.target === "tournaments") refreshTournamentPolishState();
});
window.addEventListener("bd:player-state-changed",refreshTournamentPolishState);
document.getElementById("clubSelect")?.addEventListener("change",refreshTournamentPolishState);
window.setTimeout(refreshTournamentPolishState,700);
window.setTimeout(polishTournamentCalendar,900);
