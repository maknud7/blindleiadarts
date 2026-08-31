const API_ROOT = "../api/v1";
const STATUS_TTL_MS = 15000;
let activeTournamentId = 0;
let refreshTimer = null;
let openingTimer = null;
let enhancing = false;
const statusCache = new Map();
const planCache = new Map();

function token(){ return localStorage.getItem("bd:token") || ""; }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function parseDate(value){ if(!value) return null; const d=new Date(String(value).replace(" ","T")); return Number.isNaN(d.getTime())?null:d; }
function formatClock(value){ const d=parseDate(value); return d ? new Intl.DateTimeFormat("nb-NO",{hour:"2-digit",minute:"2-digit"}).format(d) : ""; }
function formatLabel(value){ return ({groups_playoff:"Gruppespill → sluttspill",groups_only:"Gruppespill",single_elimination:"Cup",swiss:"Swiss"})[String(value||"")] || String(value||""); }
async function api(path,{auth=false}={}){ const headers={}; if(auth&&token()) headers.Authorization=`Bearer ${token()}`; const r=await fetch(`${API_ROOT}${path}`,{headers,cache:"no-store"}); const p=await r.json().catch(()=>null); if(!r.ok||!p?.ok) throw new Error(p?.error?.message||`Forespørselen feilet (${r.status})`); return p.data; }

const style=document.createElement("style");
style.textContent=`
.tdx-detail .tdx-actions{position:static!important;left:auto!important;right:auto!important;bottom:auto!important;margin:0;padding:10px 16px calc(18px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #dce5ed;backdrop-filter:none!important}
.tdx-detail .tdx-content{padding-bottom:18px!important}
.tdx-actions button:disabled{background:#e7edf4!important;color:#7d8da0!important;border-color:#d7e0e8!important;box-shadow:none!important;cursor:not-allowed!important}
.tdx-prestart-note{background:#f1f6fc;border:1px solid #d4e2f2;border-radius:14px;padding:12px 14px;color:#0b2b50;display:grid;gap:3px}
.tdx-prestart-note strong{font-size:14px}.tdx-prestart-note span{font-size:13px;color:#63788f}
.tdx-format-lines{display:grid;gap:8px;margin-top:12px}.tdx-format-line{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #e7edf2}.tdx-format-line:first-child{border-top:0}.tdx-format-line span{color:#74869a}.tdx-format-line strong{color:#0b2b50;text-align:right}
`;
document.head.appendChild(style);

document.addEventListener("click",(event)=>{
  const open=event.target instanceof Element?event.target.closest("[data-open]"):null;
  if(open){
    activeTournamentId=Number(open.getAttribute("data-open")||0);
    schedule(100);
  }
},true);

function schedule(delay=80){
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(enhance,delay);
}

function polishCurrentTab(dialog){
  const overviewActive=!!dialog.querySelector('[data-tab="overview"].active');
  if(!overviewActive) dialog.querySelectorAll(".tdx-format-lines").forEach((node)=>node.remove());

  const playersActive=!!dialog.querySelector('[data-tab="players"].active');
  if(playersActive){
    dialog.querySelectorAll(".tdx-person small").forEach((node)=>{
      if(String(node.textContent||"").trim()==="Påmeldt") node.remove();
    });
  }
  return overviewActive;
}

async function cachedStatus(id,{force=false}={}){
  const cached=statusCache.get(id);
  if(!force&&cached&&Date.now()-cached.at<STATUS_TTL_MS) return cached.data;
  if(!token()) return null;
  const data=await api(`/tournaments/${id}/check-in-status`,{auth:true}).catch(()=>null);
  if(data) statusCache.set(id,{at:Date.now(),data});
  return data;
}

async function cachedPlan(id){
  if(planCache.has(id)) return planCache.get(id);
  const promise=api(`/tournaments/${id}/wizard-plan`).catch(()=>null);
  planCache.set(id,promise);
  return promise;
}

function scheduleOpeningRefresh(status){
  clearTimeout(openingTimer);
  const opens=parseDate(status?.opens_at);
  if(!opens) return;
  const delay=opens.getTime()-Date.now()+250;
  if(delay<=0||delay>24*60*60*1000) return;
  openingTimer=setTimeout(()=>{
    statusCache.delete(activeTournamentId);
    schedule(0);
  },delay);
}

function applyCheckinState(dialog,action,status){
  if(!action||!status) return;
  const state=String(status.window_state||"");
  const notOpen=state==="not_open";
  const closed=state==="closed";
  action.dataset.prestartCheckin="1";

  if(notOpen||closed){
    action.disabled=true;
    action.removeAttribute("data-action");
    const text=notOpen?`Sjekk inn · åpner ${formatClock(status.opens_at)}`:"Innsjekk stengt";
    if(action.textContent!==text) action.textContent=text;
  }else{
    action.disabled=false;
    action.dataset.action="checkin";
    if(action.textContent!=="Sjekk inn") action.textContent="Sjekk inn";
  }

  const note=dialog.querySelector(".tdx-prestart-note");
  if(notOpen){
    if(!note){
      const next=document.createElement("div");
      next.className="tdx-prestart-note";
      next.innerHTML=`<strong>Innsjekk åpner ${esc(formatClock(status.opens_at))}</strong><span>Knappen blir aktiv når innsjekken åpner.</span>`;
      dialog.querySelector(".tdx-hero")?.appendChild(next);
    }
    scheduleOpeningRefresh(status);
  }else{
    note?.remove();
  }
}

function applyPlan(overview,plan){
  if(!overview||!plan||overview.querySelector(".tdx-format-lines")) return;
  const format=String(plan.tournament_format||"");
  const score=Number(plan.starting_score||0);
  const groupBo=Number(plan.group_best_of_legs||0), playoffBo=Number(plan.playoff_best_of_legs||0), qualifiers=Number(plan.qualifiers_per_group||0);
  if(!format||!score) return;

  const lines=[`<div class="tdx-format-line"><span>Format</span><strong>${esc(formatLabel(format))}</strong></div>`];
  if(["groups_playoff","groups_only"].includes(format)){
    lines.push(`<div class="tdx-format-line"><span>Gruppespill</span><strong>${score}${groupBo?` · Best av ${groupBo}`:""}</strong></div>`);
  }
  if(format==="groups_playoff"&&qualifiers){
    lines.push(`<div class="tdx-format-line"><span>Videre</span><strong>Topp ${qualifiers} fra hver gruppe</strong></div>`);
  }
  if(format==="groups_playoff"&&playoffBo){
    lines.push(`<div class="tdx-format-line"><span>Sluttspill</span><strong>${score} · Best av ${playoffBo}</strong></div>`);
  }
  if(format==="single_elimination"&&playoffBo){
    lines.push(`<div class="tdx-format-line"><span>Kamper</span><strong>${score} · Best av ${playoffBo}</strong></div>`);
  }
  const box=document.createElement("div");
  box.className="tdx-format-lines";
  box.innerHTML=lines.join("");
  overview.appendChild(box);
}

async function enhance(){
  if(enhancing) return;
  const dialog=document.querySelector("dialog.tdx-detail");
  if(!dialog?.open||!activeTournamentId) return;

  const action=dialog.querySelector('.tdx-actions [data-action="checkin"],.tdx-actions [data-prestart-checkin="1"]');
  const overviewActive=polishCurrentTab(dialog);
  const overview=overviewActive?dialog.querySelector('.tdx-section'):null;
  const needsPlan=!!overview&&!overview.querySelector(".tdx-format-lines");
  if(!action&&!needsPlan) return;

  enhancing=true;
  try{
    const [status,planData]=await Promise.all([
      action?cachedStatus(activeTournamentId):Promise.resolve(null),
      needsPlan?cachedPlan(activeTournamentId):Promise.resolve(null),
    ]);
    if(!dialog.open) return;
    if(action&&action.isConnected) applyCheckinState(dialog,action,status);
    if(overview&&overview.isConnected) applyPlan(overview,planData?.plan||null);
  }finally{
    enhancing=false;
  }
}

const dialog=document.querySelector("dialog.tdx-detail");
if(dialog){
  const observer=new MutationObserver(()=>{
    if(!dialog.open) return;
    const needsCheckin=!!dialog.querySelector('.tdx-actions [data-action="checkin"]');
    const overview=dialog.querySelector('[data-tab="overview"].active')?dialog.querySelector('.tdx-section'):null;
    const needsPlan=!!overview&&!overview.querySelector('.tdx-format-lines');
    const needsPlayerPolish=!!dialog.querySelector('[data-tab="players"].active .tdx-person small');
    if(needsCheckin||needsPlan||needsPlayerPolish) schedule(60);
  });
  observer.observe(dialog,{subtree:true,childList:true});
}
