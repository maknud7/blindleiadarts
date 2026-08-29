const API_ROOT = "../api/v1";
let activeTournamentId = 0;
let refreshTimer = null;

function token(){ return localStorage.getItem("bd:token") || ""; }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function parseDate(value){ if(!value) return null; const d=new Date(String(value).replace(" ","T")); return Number.isNaN(d.getTime())?null:d; }
function formatClock(value){ const d=parseDate(value); return d ? new Intl.DateTimeFormat("nb-NO",{hour:"2-digit",minute:"2-digit"}).format(d) : ""; }
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

document.addEventListener("click",(event)=>{ const open=event.target instanceof Element?event.target.closest("[data-open]"):null; if(open){ activeTournamentId=Number(open.getAttribute("data-open")||0); schedule(); }},true);

function schedule(){ clearTimeout(refreshTimer); refreshTimer=setTimeout(enhance,80); }

async function enhance(){
  const dialog=document.querySelector("dialog.tdx-detail");
  if(!dialog?.open||!activeTournamentId) return;
  const action=dialog.querySelector('.tdx-actions [data-action="checkin"]');
  const overview=dialog.querySelector('.tdx-section');
  if(!action&&!overview) return;
  const [statusData,planData]=await Promise.all([
    token()?api(`/tournaments/${activeTournamentId}/check-in-status`,{auth:true}).catch(()=>null):Promise.resolve(null),
    api(`/tournaments/${activeTournamentId}/wizard-plan`,{auth:true}).catch(()=>null)
  ]);
  const status=statusData||null;
  if(action&&status){
    const notOpen=String(status.window_state)==="not_open";
    const closed=String(status.window_state)==="closed";
    if(notOpen||closed){
      action.disabled=true;
      action.removeAttribute("data-action");
      action.textContent=notOpen?`Sjekk inn · åpner ${formatClock(status.opens_at)}`:"Innsjekk stengt";
    }
    if(notOpen&&!dialog.querySelector(".tdx-prestart-note")){
      const note=document.createElement("div"); note.className="tdx-prestart-note";
      note.innerHTML=`<strong>Innsjekk åpner ${esc(formatClock(status.opens_at))}</strong><span>Du kan sjekke inn fra 2 timer før turneringsstart.</span>`;
      dialog.querySelector(".tdx-hero")?.appendChild(note);
    }
  }
  const plan=planData?.plan||null;
  if(overview&&plan&&!overview.querySelector(".tdx-format-lines")){
    const groupBo=Number(plan.group_best_of_legs||0), playoffBo=Number(plan.playoff_best_of_legs||0), qualifiers=Number(plan.qualifiers_per_group||0);
    if(groupBo||playoffBo||qualifiers){
      const box=document.createElement("div"); box.className="tdx-format-lines";
      box.innerHTML=`<div class="tdx-format-line"><span>Format</span><strong>Gruppespill → sluttspill</strong></div><div class="tdx-format-line"><span>Gruppespill</span><strong>501${groupBo?` · Best av ${groupBo}`:""}</strong></div>${qualifiers?`<div class="tdx-format-line"><span>Videre</span><strong>Topp ${qualifiers} fra hver gruppe</strong></div>`:""}${playoffBo?`<div class="tdx-format-line"><span>Sluttspill</span><strong>501 · Best av ${playoffBo}</strong></div>`:""}`;
      overview.appendChild(box);
    }
  }
}

const observer=new MutationObserver(schedule); observer.observe(document.body,{subtree:true,childList:true});
