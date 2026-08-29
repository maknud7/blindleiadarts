const API_ROOT = "../api/v1";

function token(){ return localStorage.getItem("bd:token") || ""; }
function clubId(){ return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function dateValue(value){ const d=value?new Date(String(value).replace(" ","T")):null; return d&&!Number.isNaN(d.getTime())?d:null; }
function fmt(value){ const d=dateValue(value); if(!d)return "Tid ikke satt"; return new Intl.DateTimeFormat("nb-NO",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(d); }
async function api(path){ const r=await fetch(`${API_ROOT}${path}`,{cache:"no-store",headers:token()?{Authorization:`Bearer ${token()}`}:{}}); const p=await r.json().catch(()=>null); if(!r.ok||!p?.ok)throw new Error(p?.error?.message||"Kunne ikke hente data"); return p.data; }

async function syncClubSwitcher(){
  const wrap=document.querySelector(".portal-context");
  const select=document.getElementById("clubSelect");
  if(!wrap||!select)return;
  try{
    const data=await api("/clubs");
    const clubs=Array.isArray(data?.items)?data.items:[];
    wrap.classList.toggle("hidden",clubs.length<=1);
  }catch{ wrap.classList.add("hidden"); }
}

function ensureNextTournamentCard(){
  const list=document.getElementById("tournamentList");
  if(!list)return null;
  let card=document.getElementById("nextTournamentCard");
  if(!card){ card=document.createElement("article"); card.id="nextTournamentCard"; card.className="next-tournament-card hidden"; list.insertAdjacentElement("beforebegin",card); }
  return card;
}

async function renderNextTournament(){
  const id=clubId();
  const card=ensureNextTournamentCard();
  if(!id||!card)return;
  try{
    const data=await api(`/clubs/${id}/registration-tournaments`);
    const now=Date.now();
    const items=(Array.isArray(data?.items)?data.items:[])
      .filter(t=>!["completed","archived","cancelled","canceled"].includes(String(t.status||"").toLowerCase()))
      .filter(t=>{const d=dateValue(t.start_at);return d&&d.getTime()>=now-6*60*60*1000;})
      .sort((a,b)=>dateValue(a.start_at)-dateValue(b.start_at));
    const next=items[0];
    if(!next){card.classList.add("hidden");card.innerHTML="";return;}
    const registration=String(next.registration_state||"open");
    const status=registration==="open"?"Påmelding åpen":registration==="not_open"?"Påmelding åpner senere":"Påmelding stengt";
    card.classList.remove("hidden");
    card.innerHTML=`<div><span class="next-tournament-kicker">Neste turnering</span><strong>${esc(next.name||"Turnering")}</strong><small>${esc(fmt(next.start_at))} · ${esc(status)}</small></div><span class="next-tournament-chevron" aria-hidden="true">›</span>`;
    card.onclick=()=>{const candidate=[...document.querySelectorAll("#tournamentList .list-item")].find(el=>(el.querySelector("strong")?.textContent||"").trim()===String(next.name||"").trim());candidate?.scrollIntoView({behavior:"smooth",block:"center"});};
  }catch{card.classList.add("hidden");}
}

function addStyles(){
  if(document.getElementById("playerMobileConsolidationStyles"))return;
  const s=document.createElement("style");s.id="playerMobileConsolidationStyles";
  s.textContent=`.next-tournament-card{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;padding:14px 15px;border:1px solid #cfe0f4;border-radius:14px;background:linear-gradient(135deg,#f8fbff,#eef5ff);cursor:pointer}.next-tournament-card>div{display:grid;gap:4px;min-width:0}.next-tournament-kicker{font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2f6fed}.next-tournament-card strong{font-size:18px;color:#0c2340}.next-tournament-card small{color:#697c94}.next-tournament-chevron{font-size:28px;color:#2f6fed}@media(max-width:680px){.portal-context.hidden{display:none!important}.next-tournament-card{margin:0 0 10px;padding:13px 14px}.next-tournament-card strong{font-size:17px}}`;
  document.head.appendChild(s);
}
function refresh(){syncClubSwitcher();renderNextTournament();}
addStyles();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",refresh,{once:true});else refresh();
window.addEventListener("bd:portal-view",e=>{if(e.detail?.target==="tournaments")renderNextTournament();});
document.getElementById("clubSelect")?.addEventListener("change",refresh);
window.addEventListener("bd:player-state-changed",refresh);
