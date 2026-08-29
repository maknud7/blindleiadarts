const TD_API_ROOT = "../api/v1";
const tournamentList = document.getElementById("tournamentList");
const registrationList = document.getElementById("registrationList");
const signupSection = registrationList?.closest("section") || null;
const baseTournamentSection = tournamentList?.closest("section") || null;
const summariesSection = document.getElementById("summaries");

let upcoming = [];
let allTournaments = [];
let registrations = [];
let activeFilter = "upcoming";
let loading = false;

function token(){ return localStorage.getItem("bd:token") || ""; }
function clubId(){ return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function parseDate(value){ if(!value) return null; const d=new Date(String(value).replace(" ","T")); return Number.isNaN(d.getTime())?null:d; }
function fmtDate(value){ const d=parseDate(value); return d ? new Intl.DateTimeFormat("nb-NO",{weekday:"short",day:"numeric",month:"short"}).format(d) : "Dato ikke satt"; }
function fmtTime(value){ const d=parseDate(value); return d ? new Intl.DateTimeFormat("nb-NO",{hour:"2-digit",minute:"2-digit"}).format(d) : ""; }
function fmtLong(value){ const d=parseDate(value); return d ? new Intl.DateTimeFormat("nb-NO",{weekday:"long",day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"}).format(d) : "Ikke satt"; }
function statusLabel(status){ return {registered:"Påmeldt",waitlisted:"Venteliste",checked_in:"Sjekket inn",withdrawn:"Meldt av",no_show:"Ikke møtt",eliminated:"Ute"}[String(status||"")] || "Ikke påmeldt"; }
function publicStatus(t){
  const s=String(t?.status||"").toLowerCase();
  if(s==="in_progress") return "Pågår";
  if(s==="ready") return "Klar";
  if(["completed","archived"].includes(s)) return "Ferdig";
  const r=String(t?.registration_state||"");
  if(r==="open") return "Påmelding åpen";
  if(r==="not_open") return "Påmelding åpner senere";
  if(r==="closed") return "Påmelding stengt";
  return "Kommende";
}
function regFor(t){ return registrations.find(r=>Number(r.tournament_id)===Number(t.id)) || null; }
function isFinished(t){ return ["completed","archived","cancelled","canceled"].includes(String(t?.status||"").toLowerCase()) || (!!t?.end_at && parseDate(t.end_at)?.getTime() < Date.now()); }
function isUpcoming(t){ return !isFinished(t); }
function isMine(t){ const r=regFor(t); return !!r && !["withdrawn","no_show"].includes(String(r.status||"")); }

async function api(path,{method="GET",auth=false}={}){
  const headers={};
  if(auth && token()) headers.Authorization=`Bearer ${token()}`;
  const response=await fetch(`${TD_API_ROOT}${path}`,{method,headers,cache:"no-store"});
  const payload=await response.json().catch(()=>null);
  if(!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

const style=document.createElement("style");
style.textContent=`
  .tdx-root{display:grid;gap:18px}
  .tdx-head{display:flex;align-items:end;justify-content:space-between;gap:12px}
  .tdx-head h2{margin:2px 0 0;font-size:30px;line-height:1.05;color:#0b2b50}
  .tdx-tabs{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;padding:4px;border-radius:14px;background:#e9eff5}
  .tdx-tabs button{min-height:42px;border:0;border-radius:11px;background:transparent;color:#61758b;font-weight:800;font-size:14px;padding:0 8px}
  .tdx-tabs button.active{background:#fff;color:#0b2b50;box-shadow:0 1px 5px rgba(10,35,64,.1)}
  .tdx-next{border-radius:18px;padding:16px;background:linear-gradient(135deg,#edf5ff,#f7fbff);border:1px solid #c8dcf5;display:grid;gap:10px;text-align:left}
  .tdx-next-top,.tdx-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .tdx-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#2f75e8;font-weight:900}
  .tdx-next h3{margin:0;font-size:23px;color:#0b2b50}
  .tdx-meta{color:#6f8298;font-size:15px}
  .tdx-pill{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:7px 10px;background:#edf4ff;border:1px solid #c9dbf3;color:#174f91;font-size:13px;font-weight:800}
  .tdx-list{background:#fff;border:1px solid #dce5ed;border-radius:18px;overflow:hidden}
  .tdx-row{width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid #e7edf2;padding:15px 16px;min-height:82px;color:inherit}
  .tdx-row:last-child{border-bottom:0}
  .tdx-row-main{min-width:0;display:grid;gap:4px;flex:1}
  .tdx-row-title{font-size:18px;font-weight:850;color:#0b2b50;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tdx-row-sub{font-size:14px;color:#70839a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tdx-row-side{display:flex;align-items:center;gap:8px;flex-shrink:0}
  .tdx-chevron{font-size:30px;line-height:1;color:#2f75e8;font-weight:700}
  .tdx-empty{padding:24px 16px;text-align:center;color:#70839a}
  .tdx-detail{border:0;padding:0;width:100%;max-width:760px;height:100%;max-height:none;margin:0 0 0 auto;background:#f4f7fa}
  .tdx-detail::backdrop{background:rgba(7,26,48,.48)}
  .tdx-page{min-height:100%;display:flex;flex-direction:column}
  .tdx-page-head{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #dce5ed;padding:14px 16px;display:flex;align-items:center;gap:12px}
  .tdx-back{width:44px;height:44px;border-radius:50%;padding:0;border:0;background:#edf2f6;color:#0b2b50;font-size:26px}
  .tdx-page-title{min-width:0;flex:1}.tdx-page-title h2{margin:0;color:#0b2b50;font-size:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tdx-page-title p{margin:2px 0 0;color:#75879a;font-size:13px}
  .tdx-content{padding:18px 16px calc(94px + env(safe-area-inset-bottom));display:grid;gap:16px}
  .tdx-hero{background:#fff;border:1px solid #dce5ed;border-radius:20px;padding:18px;display:grid;gap:14px}
  .tdx-hero h1{margin:0;color:#0b2b50;font-size:30px;line-height:1.04}
  .tdx-status-row{display:flex;gap:8px;flex-wrap:wrap}
  .tdx-facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .tdx-fact{background:#f7fafc;border-radius:14px;padding:12px}.tdx-fact small{display:block;text-transform:uppercase;letter-spacing:.08em;color:#7a8ca0;font-size:10px;font-weight:900;margin-bottom:4px}.tdx-fact strong{color:#0b2b50;font-size:15px}
  .tdx-detail-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#e9eff5;padding:4px;border-radius:14px;position:sticky;top:73px;z-index:1}
  .tdx-detail-tabs button{border:0;border-radius:10px;background:transparent;min-height:40px;font-weight:800;color:#6a7d91}.tdx-detail-tabs button.active{background:#fff;color:#0b2b50}
  .tdx-section{background:#fff;border:1px solid #dce5ed;border-radius:18px;padding:16px}.tdx-section h3{margin:0 0 12px;color:#0b2b50;font-size:18px}
  .tdx-person{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid #e7edf2}.tdx-person:first-of-type{border-top:0}.tdx-person strong{color:#0b2b50}.tdx-person small{color:#788a9c}
  .tdx-match{padding:11px 0;border-top:1px solid #e7edf2}.tdx-match:first-of-type{border-top:0}.tdx-match strong{color:#0b2b50}.tdx-match p{margin:3px 0 0;color:#74869a;font-size:13px}
  .tdx-actions{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);backdrop-filter:blur(14px);border-top:1px solid #dce5ed;padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:grid;gap:8px}
  .tdx-actions button{min-height:50px;border-radius:14px;font-size:17px;font-weight:850}.tdx-actions .ghost{background:#fff;color:#0b2b50;border:1px solid #d7e1e9}
  @media(min-width:760px){.tdx-detail{height:min(900px,92vh);margin:auto;border-radius:24px;overflow:hidden}.tdx-actions{position:sticky;bottom:0}.tdx-page-head{top:0}}
`;
document.head.appendChild(style);

if(signupSection) signupSection.classList.add("hidden");
if(baseTournamentSection) baseTournamentSection.classList.add("hidden");
if(summariesSection) summariesSection.classList.add("hidden");

const root=document.createElement("section");
root.className="card tdx-root";
root.dataset.portalSection="tournaments";
if(baseTournamentSection?.parentNode) baseTournamentSection.parentNode.insertBefore(root,baseTournamentSection);

const dialog=document.createElement("dialog");
dialog.className="tdx-detail";
document.body.appendChild(dialog);

function filtered(){
  if(activeFilter==="past") return allTournaments.filter(isFinished).sort((a,b)=>(parseDate(b.start_at)?.getTime()||0)-(parseDate(a.start_at)?.getTime()||0));
  return allTournaments.filter(isUpcoming).sort((a,b)=>(parseDate(a.start_at)?.getTime()||Infinity)-(parseDate(b.start_at)?.getTime()||Infinity));
}
function nextForMe(){ return allTournaments.filter(t=>isMine(t)&&!isFinished(t)).sort((a,b)=>(parseDate(a.start_at)?.getTime()||Infinity)-(parseDate(b.start_at)?.getTime()||Infinity))[0] || null; }

function render(){
  const items=filtered(); const next=nextForMe();
  root.innerHTML=`<div class="tdx-head"><div><p class="eyebrow">Turneringer</p><h2>Din dartkalender</h2></div></div>
    <div class="tdx-tabs" role="tablist"><button class="${activeFilter==="upcoming"?"active":""}" data-filter="upcoming">Kommende</button><button class="${activeFilter==="past"?"active":""}" data-filter="past">Tidligere</button></div>
    ${activeFilter==="upcoming"&&next?`<button class="tdx-next" data-open="${Number(next.id)}"><div class="tdx-next-top"><span class="tdx-kicker">Neste for deg</span><span class="tdx-pill">${esc(statusLabel(regFor(next)?.status))}</span></div><h3>${esc(next.name)}</h3><div class="tdx-meta">${esc(fmtDate(next.start_at))}${fmtTime(next.start_at)?` · ${esc(fmtTime(next.start_at))}`:""}</div></button>`:""}
    <div class="tdx-list">${items.length?items.map(rowHtml).join(""):`<div class="tdx-empty">${activeFilter==="past"?"Ingen tidligere turneringer ennå.":"Ingen kommende turneringer akkurat nå."}</div>`}</div>`;
  root.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{activeFilter=b.dataset.filter;render();}));
  root.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",()=>openDetail(Number(b.dataset.open))));
}
function rowHtml(t){
  const reg=regFor(t); const count=Number(t.registration_count||0); const mine=reg&&!['withdrawn','no_show'].includes(String(reg.status||''));
  return `<button class="tdx-row" data-open="${Number(t.id)}"><span class="tdx-row-main"><span class="tdx-row-title">${esc(t.name)}</span><span class="tdx-row-sub">${esc(fmtDate(t.start_at))}${fmtTime(t.start_at)?` · ${esc(fmtTime(t.start_at))}`:""} · ${esc(publicStatus(t))}</span></span><span class="tdx-row-side">${mine?`<span class="tdx-pill">${esc(statusLabel(reg.status))}</span>`:`<span class="tdx-pill">${count} ${count===1?"deltaker":"deltakere"}</span>`}<span class="tdx-chevron">›</span></span></button>`;
}

async function openDetail(id){
  dialog.innerHTML=`<div class="tdx-page"><div class="tdx-page-head"><button class="tdx-back">‹</button><div class="tdx-page-title"><h2>Turnering</h2><p>Henter detaljer …</p></div></div></div>`;
  dialog.querySelector(".tdx-back")?.addEventListener("click",()=>dialog.close()); dialog.showModal();
  try{ const detail=await api(`/tournaments/${id}`); const t=detail.tournament||detail; const players=Array.isArray(t.registrations)?t.registrations:[]; const matches=Array.isArray(t.matches)?t.matches:[]; renderDetail(t,players,matches,regFor(t),"overview"); }
  catch(error){ dialog.innerHTML=`<div class="tdx-page"><div class="tdx-page-head"><button class="tdx-back">‹</button><div class="tdx-page-title"><h2>Kunne ikke åpne turneringen</h2><p>${esc(error.message)}</p></div></div></div>`; dialog.querySelector('.tdx-back')?.addEventListener('click',()=>dialog.close()); }
}
function renderDetail(t,players,matches,reg,tab){
  const completed=matches.filter(m=>String(m.status)==="completed"); const participantCount=players.filter(p=>String(p.status)!=="withdrawn").length;
  dialog.innerHTML=`<div class="tdx-page"><div class="tdx-page-head"><button class="tdx-back">‹</button><div class="tdx-page-title"><h2>${esc(t.name)}</h2><p>${esc(fmtDate(t.start_at))}${fmtTime(t.start_at)?` · ${esc(fmtTime(t.start_at))}`:""}</p></div></div>
    <div class="tdx-content"><div class="tdx-hero"><div class="tdx-status-row"><span class="tdx-pill">${esc(publicStatus(t))}</span>${reg?`<span class="tdx-pill">${esc(statusLabel(reg.status))}</span>`:""}</div><h1>${esc(t.name)}</h1><div class="tdx-facts"><div class="tdx-fact"><small>Når</small><strong>${esc(fmtLong(t.start_at))}</strong></div><div class="tdx-fact"><small>Deltakere</small><strong>${participantCount}</strong></div><div class="tdx-fact"><small>Kamper</small><strong>${matches.length}</strong></div><div class="tdx-fact"><small>Ferdige</small><strong>${completed.length}</strong></div></div></div>
    <div class="tdx-detail-tabs"><button class="${tab==="overview"?"active":""}" data-tab="overview">Oversikt</button><button class="${tab==="players"?"active":""}" data-tab="players">Deltakere</button><button class="${tab==="matches"?"active":""}" data-tab="matches">Kamper</button></div>${tab==="players"?playersHtml(players):tab==="matches"?matchesHtml(matches):overviewHtml(t,players,matches)}</div>${actionsHtml(t,reg)}</div>`;
  dialog.querySelector('.tdx-back')?.addEventListener('click',()=>dialog.close()); dialog.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>renderDetail(t,players,matches,reg,b.dataset.tab))); dialog.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>performAction(t,b.dataset.action)));
}
function overviewHtml(t,players,matches){ const active=players.filter(p=>String(p.status)!=="withdrawn"); return `<div class="tdx-section"><h3>${isFinished(t)?"Oppsummering":"Om turneringen"}</h3><p class="muted">${active.length} ${active.length===1?"deltaker":"deltakere"} · ${matches.filter(m=>String(m.status)==="completed").length} ferdige kamper. Bruk fanene over for deltakerliste og kampoversikt.</p></div>`; }
function playersHtml(players){ const active=players.filter(p=>String(p.status)!=="withdrawn"); return `<div class="tdx-section"><h3>Deltakere (${active.length})</h3>${active.length?active.map(p=>`<div class="tdx-person"><span><strong>${esc(p.display_name||p.player_name||"Spiller")}</strong>${p.nickname?`<small> · ${esc(p.nickname)}</small>`:""}</span><small>${esc(statusLabel(p.status))}</small></div>`).join(""):`<p class="muted">Ingen deltakere registrert ennå.</p>`}</div>`; }
function matchesHtml(matches){ if(!matches.length) return `<div class="tdx-section"><h3>Kamper</h3><p class="muted">Kampoppsettet er ikke klart ennå.</p></div>`; return `<div class="tdx-section"><h3>Kamper (${matches.length})</h3>${matches.map(m=>`<div class="tdx-match"><strong>${esc(m.player_a_name||"Spiller A")} – ${esc(m.player_b_name||"Spiller B")}</strong><p>${esc(m.round_label||m.bracket_label||"Kamp")} · ${String(m.status)==="completed"?`Vinner: ${esc(m.winner_name||"—")}`:esc(publicStatus({status:m.status}))}</p></div>`).join("")}</div>`; }
function actionsHtml(t,reg){
  if(isFinished(t)) return ""; if(!token()) return `<div class="tdx-actions"><button disabled>Logg inn for å melde deg på</button></div>`; const s=String(reg?.status||"");
  if(s==="registered") return `<div class="tdx-actions"><button data-action="checkin">Sjekk inn</button><button class="ghost" data-action="withdraw">Meld av</button></div>`;
  if(s==="checked_in") return `<div class="tdx-actions"><button disabled>Sjekket inn</button><button class="ghost" data-action="withdraw">Meld av</button></div>`;
  if(s==="waitlisted") return `<div class="tdx-actions"><button class="ghost" data-action="withdraw">Fjern meg fra ventelisten</button></div>`;
  const state=String(t.registration_state||"open"); return state==="open"||!t.registration_state?`<div class="tdx-actions"><button data-action="register">Meld meg på</button></div>`:`<div class="tdx-actions"><button disabled>${esc(publicStatus(t))}</button></div>`;
}
async function performAction(t,action){ const id=Number(t.id); try{ if(action==="register") await api(`/tournaments/${id}/register`,{method:"POST",auth:true}); if(action==="withdraw") await api(`/tournaments/${id}/register`,{method:"DELETE",auth:true}); if(action==="checkin") await api(`/tournaments/${id}/check-in`,{method:"POST",auth:true}); await loadData(); dialog.close(); await openDetail(id); }catch(error){ const b=dialog.querySelector(`[data-action="${action}"]`); if(b) b.textContent=error.message; } }

async function loadData(){
  if(loading) return; loading=true;
  try{ const cid=clubId(); if(!cid) return; const [regData,allData,dashboard]=await Promise.all([api(`/clubs/${cid}/registration-tournaments`).catch(()=>({items:[]})),api(`/clubs/${cid}/tournaments`).catch(()=>({items:[]})),token()?api('/me/dashboard',{auth:true}).catch(()=>null):Promise.resolve(null)]); upcoming=regData?.items||[]; const all=allData?.items||[]; const byId=new Map(); [...all,...upcoming].forEach(t=>byId.set(Number(t.id),{...(byId.get(Number(t.id))||{}),...t})); allTournaments=[...byId.values()]; registrations=dashboard?.dashboard?.registrations||[]; render(); }
  finally{ loading=false; }
}
window.addEventListener('bd:portal-view',e=>{if(e.detail?.target==='tournaments')loadData();}); window.addEventListener('bd:player-state-changed',()=>loadData()); document.getElementById('clubSelect')?.addEventListener('change',()=>loadData()); window.setTimeout(loadData,350);