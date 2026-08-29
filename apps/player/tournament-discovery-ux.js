const TD_API_ROOT = "../api/v1";
const tournamentList = document.getElementById("tournamentList");
const registrationList = document.getElementById("registrationList");
const signupSection = registrationList?.closest("section") || null;
let tournamentData = [];
let registrationData = [];
let observer = null;
let refreshTimer = null;
let enhancing = false;

function tdToken(){ return localStorage.getItem("bd:token") || ""; }
function tdClubId(){ return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function fmt(value){
  if(!value) return "Ikke satt";
  const d=new Date(String(value).replace(" ","T"));
  if(Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(d);
}
function statusLabel(status){
  return {registered:"Påmeldt",waitlisted:"Venteliste",checked_in:"Sjekket inn",withdrawn:"Meldt av",no_show:"Ikke møtt",eliminated:"Ute"}[String(status||"")] || "Ikke påmeldt";
}
function registrationStateLabel(value){
  return value === "not_open" ? "Påmelding åpner senere" : value === "closed" ? "Påmelding stengt" : "Påmelding åpen";
}
async function tdApi(path,{auth=false}={}){
  const headers={};
  if(auth && tdToken()) headers.Authorization=`Bearer ${tdToken()}`;
  const r=await fetch(`${TD_API_ROOT}${path}`,{headers,cache:"no-store"});
  const p=await r.json().catch(()=>null);
  if(!r.ok || !p?.ok) throw new Error(p?.error?.message || `Forespørselen feilet (${r.status})`);
  return p.data;
}
function cardName(card){ return String(card?.querySelector("strong")?.textContent || "").trim(); }
function registrationFor(t){ return registrationData.find(r=>Number(r.tournament_id)===Number(t.id)) || null; }
function participantNames(t){
  const raw=t?.registrations || t?.participants || t?.players || [];
  if(!Array.isArray(raw)) return [];
  return raw.map(p=>p.display_name || p.player_name || p.name).filter(Boolean);
}

const style=document.createElement("style");
style.textContent=`
  #signup.td-compact{padding:14px 18px!important;gap:8px!important}
  #signup.td-compact .section-head{margin:0!important}
  #signup.td-compact .section-head .eyebrow{font-size:12px!important}
  #signup.td-compact .section-head h2{font-size:20px!important}
  #registrationList.td-registration-list{gap:0!important}
  #registrationList.td-registration-list>.list-item{position:relative;padding:12px 38px 12px 0!important;border:0!important;border-top:1px solid #e4eaf0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;cursor:pointer}
  #registrationList.td-registration-list>.list-item:first-child{border-top:0!important}
  #registrationList.td-registration-list>.list-item .stack,#registrationList.td-registration-list>.list-item button{display:none!important}
  #registrationList.td-registration-list>.list-item .section-head{margin:0!important;gap:8px!important}
  #registrationList.td-registration-list>.list-item .section-head>div>p{display:none!important}
  #registrationList.td-registration-list>.list-item:after,#tournamentList>.list-item.td-card:after{content:"›";position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:34px;line-height:1;color:#2f75e8;font-weight:700}
  #tournamentList>.list-item.td-card{position:relative;padding-right:42px!important;cursor:pointer}
  #tournamentList>.list-item.td-card>.stack,#tournamentList>.list-item.td-card>button{display:none!important}
  #tournamentList>.list-item.td-card>p.muted{display:none!important}
  #tournamentList>.list-item.td-card .pill{white-space:nowrap}
  .td-detail-dialog{border:0;border-radius:24px 24px 0 0;padding:0;width:min(680px,100%);max-width:680px;margin:auto 0 0 auto;background:#fff;box-shadow:0 -12px 50px rgba(10,35,64,.2)}
  .td-detail-dialog::backdrop{background:rgba(7,26,48,.48)}
  .td-sheet{padding:22px 20px calc(22px + env(safe-area-inset-bottom));display:grid;gap:18px}
  .td-sheet-head{display:flex;justify-content:space-between;gap:12px;align-items:start}
  .td-sheet-head h2{margin:3px 0 4px;font-size:28px;line-height:1.08;color:#0b2b50}
  .td-close{width:44px;height:44px;border-radius:50%;padding:0;font-size:25px;background:#eef3f8;color:#0b2b50;border:0}
  .td-status{display:flex;gap:8px;flex-wrap:wrap}
  .td-status span{padding:7px 11px;border-radius:999px;background:#edf4ff;color:#174f91;font-weight:700;font-size:13px}
  .td-facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .td-fact{border:1px solid #dce5ed;border-radius:14px;padding:12px;background:#f8fbfe}
  .td-fact small{display:block;text-transform:uppercase;letter-spacing:.08em;color:#70839a;font-weight:800;font-size:11px;margin-bottom:4px}
  .td-fact strong{color:#0b2b50;font-size:16px}
  .td-section h3{margin:0 0 8px;color:#0b2b50;font-size:17px}
  .td-players{display:grid;gap:6px}
  .td-player{padding:9px 0;border-top:1px solid #e6edf3;color:#0b2b50;font-weight:650}
  .td-actions{display:grid;gap:10px}
  .td-actions button{min-height:50px;border-radius:14px;font-size:17px;font-weight:800}
  .td-actions .ghost{background:#fff;color:#0b2b50;border:1px solid #d7e1e9}
  @media(min-width:681px){.td-detail-dialog{margin:auto;border-radius:22px}.td-sheet{padding:24px}}
`;
document.head.appendChild(style);

const dialog=document.createElement("dialog");
dialog.className="td-detail-dialog";
dialog.id="tournamentDetailDialog";
document.body.appendChild(dialog);

dialog.addEventListener("click",e=>{ if(e.target===dialog) dialog.close(); });

function findUnderlyingButton(tournamentId, kind){
  const selector=kind==="register"?`[data-register="${tournamentId}"]`:kind==="withdraw"?`[data-withdraw="${tournamentId}"]`:`[data-checkin="${tournamentId}"]`;
  return document.querySelector(selector);
}
function renderActions(t,reg){
  const status=String(reg?.status||"");
  if(status==="checked_in") return `<div class="td-actions"><button class="ghost" data-td-action="withdraw">Meld av</button></div>`;
  if(status==="registered") return `<div class="td-actions"><button data-td-action="checkin">Sjekk inn på arena</button><button class="ghost" data-td-action="withdraw">Meld av</button></div>`;
  if(status==="waitlisted") return `<div class="td-actions"><button class="ghost" data-td-action="withdraw">Fjern meg fra ventelisten</button></div>`;
  if(!tdToken()) return `<div class="td-actions"><button disabled>Logg inn for å melde deg på</button></div>`;
  if(String(t.registration_state||"open")==="open") return `<div class="td-actions"><button data-td-action="register">Meld meg på</button></div>`;
  return `<div class="td-actions"><button disabled>${esc(registrationStateLabel(t.registration_state))}</button></div>`;
}
function openDetail(t){
  const reg=registrationFor(t);
  const max=t.max_players?Number(t.max_players):null;
  const count=Number(t.registration_count||0);
  const names=participantNames(t);
  const format=t.format_name || t.format || t.mode || t.tournament_type || "Turnering";
  const closeText=t.registration_closes_at ? fmt(t.registration_closes_at) : registrationStateLabel(t.registration_state);
  dialog.innerHTML=`<div class="td-sheet">
    <div class="td-sheet-head"><div><p class="eyebrow">Turnering</p><h2>${esc(t.name)}</h2><p class="muted">${esc(fmt(t.start_at))}</p></div><button class="td-close" type="button" aria-label="Lukk">×</button></div>
    <div class="td-status"><span>${esc(statusLabel(reg?.status))}</span><span>${esc(registrationStateLabel(t.registration_state))}</span></div>
    <div class="td-facts">
      <div class="td-fact"><small>Når</small><strong>${esc(fmt(t.start_at))}</strong></div>
      <div class="td-fact"><small>Påmeldte</small><strong>${esc(max?`${count} / ${max}`:String(count))}</strong></div>
      <div class="td-fact"><small>Format</small><strong>${esc(format)}</strong></div>
      <div class="td-fact"><small>Påmeldingsfrist</small><strong>${esc(closeText)}</strong></div>
    </div>
    ${t.description?`<div class="td-section"><h3>Om turneringen</h3><p>${esc(t.description)}</p></div>`:""}
    <div class="td-section"><h3>Deltakere</h3>${names.length?`<div class="td-players">${names.map(n=>`<div class="td-player">${esc(n)}</div>`).join("")}</div>`:`<p class="muted">${count ? `${count} ${count===1?"spiller er":"spillere er"} påmeldt.` : "Ingen påmeldte ennå."}</p>`}</div>
    ${renderActions(t,reg)}
  </div>`;
  dialog.querySelector(".td-close")?.addEventListener("click",()=>dialog.close());
  dialog.querySelectorAll("[data-td-action]").forEach(btn=>btn.addEventListener("click",()=>{
    const action=btn.dataset.tdAction;
    const source=findUnderlyingButton(t.id,action);
    if(source){ source.click(); dialog.close(); window.setTimeout(()=>scheduleEnhance(450),500); }
  }));
  dialog.showModal();
}

function compactRegistrations(){
  if(!registrationList || !signupSection) return;
  signupSection.classList.add("td-compact");
  registrationList.classList.add("td-registration-list");
  registrationList.querySelectorAll(":scope > .list-item").forEach(card=>{
    const name=cardName(card);
    const reg=registrationData.find(r=>String(r.tournament_name||"").trim()===name);
    const t=tournamentData.find(x=>Number(x.id)===Number(reg?.tournament_id)) || tournamentData.find(x=>String(x.name||"").trim()===name);
    if(!t) return;
    card.dataset.tdTournamentId=String(t.id);
    card.tabIndex=0;
    card.setAttribute("role","button");
    card.setAttribute("aria-label",`Se detaljer for ${name}`);
  });
}
function enhanceTournamentCards(){
  if(!tournamentList) return;
  tournamentList.querySelectorAll(":scope > .list-item").forEach(card=>{
    const name=cardName(card);
    const t=tournamentData.find(x=>String(x.name||"").trim()===name);
    if(!t) return;
    card.classList.add("td-card");
    card.dataset.tdTournamentId=String(t.id);
    card.tabIndex=0;
    card.setAttribute("role","button");
    card.setAttribute("aria-label",`Se detaljer for ${name}`);
  });
}
function openFromCard(target){
  const card=target.closest?.("[data-td-tournament-id]");
  if(!card) return;
  if(target.closest("button")) return;
  const t=tournamentData.find(x=>Number(x.id)===Number(card.dataset.tdTournamentId));
  if(t) openDetail(t);
}
registrationList?.addEventListener("click",e=>openFromCard(e.target));
tournamentList?.addEventListener("click",e=>openFromCard(e.target));
for(const root of [registrationList,tournamentList]) root?.addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-td-tournament-id]")){ e.preventDefault(); openFromCard(e.target); } });

async function enhance(){
  if(enhancing) return;
  enhancing=true;
  try{
    const club=tdClubId();
    if(!club) return;
    const [tData,dData]=await Promise.all([
      tdApi(`/clubs/${club}/registration-tournaments`).catch(()=>null),
      tdToken()?tdApi("/me/dashboard",{auth:true}).catch(()=>null):Promise.resolve(null)
    ]);
    tournamentData=tData?.items || [];
    registrationData=dData?.dashboard?.registrations || [];
    compactRegistrations();
    enhanceTournamentCards();
  } finally { enhancing=false; }
}
function scheduleEnhance(delay=100){ clearTimeout(refreshTimer); refreshTimer=setTimeout(enhance,delay); }
observer=new MutationObserver(()=>scheduleEnhance(120));
if(registrationList) observer.observe(registrationList,{childList:true,subtree:true});
if(tournamentList) observer.observe(tournamentList,{childList:true,subtree:true});
document.getElementById("clubSelect")?.addEventListener("change",()=>scheduleEnhance(300));
window.addEventListener("bd:player-state-changed",()=>scheduleEnhance(250));
window.addEventListener("bd:portal-view",event=>{ if(event.detail?.target==="tournaments") scheduleEnhance(80); });
window.setTimeout(enhance,450);
