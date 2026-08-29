const API_ROOT = "../api/v1";
let latestUpcomingCount = 0;
let tournamentObserver = null;
let latestNextName = "";

function token(){ return localStorage.getItem("bd:token") || ""; }
function clubId(){ return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function dateValue(value){ const d=value?new Date(String(value).replace(" ","T")):null; return d&&!Number.isNaN(d.getTime())?d:null; }
async function api(path){ const r=await fetch(`${API_ROOT}${path}`,{cache:"no-store",headers:token()?{Authorization:`Bearer ${token()}`}:{}}); const p=await r.json().catch(()=>null); if(!r.ok||!p?.ok)throw new Error(p?.error?.message||"Kunne ikke hente data"); return p.data; }

function hideClubSwitcher(){
  const wrap=document.querySelector(".portal-context");
  if(!wrap)return;
  wrap.classList.add("hidden");
  wrap.setAttribute("aria-hidden","true");
  wrap.style.setProperty("display","none","important");
}

function isFinished(status){ return ["completed","archived","cancelled","canceled"].includes(String(status||"").toLowerCase()); }
function isUpcoming(tournament){
  if(isFinished(tournament?.status||tournament?.tournament_status))return false;
  const d=dateValue(tournament?.start_at);
  if(!d)return true;
  return d.getTime()>=Date.now()-18*60*60*1000;
}

function cardName(card){ return String(card?.querySelector("strong")?.textContent||"").trim(); }

function syncEmptyState(){
  const list=document.getElementById("tournamentList");
  if(!list)return;
  const candidates=[...list.querySelectorAll(".mini-card,.list-item,article,div")]
    .filter(node=>String(node.textContent||"").includes("Ingen kommende turneringer"));
  candidates.forEach(node=>{
    if(latestUpcomingCount>0){
      node.classList.add("hidden");
      node.setAttribute("aria-hidden","true");
      node.style.setProperty("display","none","important");
    }else{
      node.classList.remove("hidden");
      node.removeAttribute("aria-hidden");
      node.style.removeProperty("display");
    }
  });
}

function decorateNextCard(){
  const list=document.getElementById("tournamentList");
  if(!list)return false;
  list.querySelectorAll(".is-next-tournament").forEach(card=>{
    card.classList.remove("is-next-tournament");
    card.querySelector(".next-tournament-kicker-inline")?.remove();
  });
  if(!latestNextName)return false;
  const card=[...list.querySelectorAll(":scope > .list-item")].find(node=>cardName(node)===latestNextName);
  if(!card)return false;
  card.classList.add("is-next-tournament");
  const head=card.querySelector(".section-head > div") || card.firstElementChild;
  if(head && !head.querySelector(".next-tournament-kicker-inline")){
    const kicker=document.createElement("span");
    kicker.className="next-tournament-kicker-inline";
    kicker.textContent="Neste turnering";
    head.prepend(kicker);
  }
  return true;
}

function observeTournamentList(){
  const list=document.getElementById("tournamentList");
  if(!list||tournamentObserver)return;
  tournamentObserver=new MutationObserver(()=>{
    syncEmptyState();
    decorateNextCard();
  });
  tournamentObserver.observe(list,{childList:true,subtree:true});
}

function syncTournamentList(items){
  const list=document.getElementById("tournamentList");
  if(!list)return;
  latestUpcomingCount=items.length;
  latestNextName=String(items[0]?.name||"").trim();
  const names=new Set(items.map(item=>String(item.name||"").trim()).filter(Boolean));
  list.querySelectorAll("[data-upcoming-overflow]").forEach(node=>node.remove());
  document.getElementById("nextTournamentCard")?.remove();
  syncEmptyState();

  const cards=[...list.querySelectorAll(":scope > .list-item")];
  cards.forEach(card=>card.classList.toggle("hidden",!names.has(cardName(card))));
  for(const item of items){
    const name=String(item.name||"").trim();
    const card=cards.find(node=>cardName(node)===name);
    if(card){card.classList.remove("hidden");list.appendChild(card);}
  }
  decorateNextCard();
  syncEmptyState();
}

async function renderNextTournament(){
  const id=clubId();
  if(!id)return;
  observeTournamentList();
  try{
    const data=await api(`/clubs/${id}/registration-tournaments`);
    const items=(Array.isArray(data?.items)?data.items:[])
      .filter(isUpcoming)
      .sort((a,b)=>(dateValue(a.start_at)?.getTime()??Number.MAX_SAFE_INTEGER)-(dateValue(b.start_at)?.getTime()??Number.MAX_SAFE_INTEGER));
    syncTournamentList(items);
    if(items.length && !decorateNextCard()) window.setTimeout(decorateNextCard,180);
  }catch{
    latestUpcomingCount=0;
    latestNextName="";
  }
}

function addStyles(){
  if(document.getElementById("playerMobileConsolidationStyles"))return;
  const s=document.createElement("style");s.id="playerMobileConsolidationStyles";
  s.textContent=`.portal-context{display:none!important}#nextTournamentCard{display:none!important}.is-next-tournament{border-color:#b9d5f5!important;background:linear-gradient(135deg,#f8fbff,#eef5ff)!important}.next-tournament-kicker-inline{display:block;margin-bottom:6px;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2f6fed}@media(max-width:680px){.is-next-tournament{padding-top:14px!important}}`;
  document.head.appendChild(s);
}
function refresh(){hideClubSwitcher();renderNextTournament();}
addStyles();
hideClubSwitcher();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",refresh,{once:true});else refresh();
window.addEventListener("bd:portal-view",e=>{hideClubSwitcher();if(e.detail?.target==="tournaments"){window.setTimeout(renderNextTournament,80);window.setTimeout(renderNextTournament,500);}});
document.getElementById("clubSelect")?.addEventListener("change",refresh);
window.addEventListener("bd:player-state-changed",()=>window.setTimeout(refresh,80));
