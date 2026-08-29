const TD_API_ROOT = "../api/v1";
const tournamentList = document.getElementById("tournamentList");
const registrationList = document.getElementById("registrationList");
const signupSection = registrationList?.closest("section") || null;
let tournamentData = [];
let registrationData = [];
let refreshTimer = null;
let enhancing = false;

function tdToken(){ return localStorage.getItem("bd:token") || ""; }
function tdClubId(){ return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0); }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function parseDate(value){ if(!value) return null; const d=new Date(String(value).replace(" ","T")); return Number.isNaN(d.getTime())?null:d; }
function fmtDate(value){ const d=parseDate(value); if(!d) return value || "Ikke satt"; return new Intl.DateTimeFormat("nb-NO",{weekday:"short",day:"numeric",month:"short"}).format(d); }
function fmtTime(value){ const d=parseDate(value); if(!d) return ""; return new Intl.DateTimeFormat("nb-NO",{hour:"2-digit",minute:"2-digit"}).format(d); }
function fmtFull(value){ const d=parseDate(value); if(!d) return value || "Ikke satt"; return new Intl.DateTimeFormat("nb-NO",{weekday:"long",day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"}).format(d); }
function statusLabel(status){ return {registered:"Påmeldt",waitlisted:"Venteliste",checked_in:"Sjekket inn",withdrawn:"Meldt av",no_show:"Ikke møtt",eliminated:"Ute"}[String(status||"")] || "Ikke påmeldt"; }
function registrationStateLabel(value){ return value === "not_open" ? "Åpner senere" : value === "closed" ? "Påmelding stengt" : "Påmelding åpen"; }
function registrationFor(t){ return registrationData.find(r=>Number(r.tournament_id)===Number(t.id)) || null; }
function participantNames(t){ const raw=t?.registrations || t?.participants || t?.players || []; return Array.isArray(raw)?raw.map(p=>p.display_name || p.player_name || p.name).filter(Boolean):[]; }
function formatName(t){ return t.format_name || t.format || t.mode || t.tournament_type || "Turnering"; }

async function tdApi(path,{auth=false}={}){
  const headers={};
  if(auth && tdToken()) headers.Authorization=`Bearer ${tdToken()}`;
  const r=await fetch(`${TD_API_ROOT}${path}`,{headers,cache:"no-store"});
  const p=await r.json().catch(()=>null);
  if(!r.ok || !p?.ok) throw new Error(p?.error?.message || `Forespørselen feilet (${r.status})`);
  return p.data;
}

const style=document.createElement("style");
style.id="tournamentDiscoveryUXStyles";
style.textContent=`
  #signup.td-hidden-signup{display:none!important}
  #tournamentList.td-list{gap:12px!important}
  #tournamentList>.list-item.td-card{position:relative!important;padding:0!important;border:1px solid #dbe5ef!important;border-radius:18px!important;background:#fff!important;box-shadow:none!important;overflow:hidden!important;cursor:pointer!important}
  #tournamentList>.list-item.td-card>.section-head,#tournamentList>.list-item.td-card>p.muted,#tournamentList>.list-item.td-card>.stack,#tournamentList>.list-item.td-card>button{display:none!important}
  .td-card-ui{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:14px;align-items:center;padding:16px}
  .td-date{width:62px;min-height:62px;border-radius:15px;background:#edf4ff;color:#174f91;display:grid;place-items:center;text-align:center;padding:7px 4px}
  .td-date strong{font-size:22px;line-height:1}.td-date span{font-size:11px;font-weight:850;text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
  .td-card-main{min-width:0}.td-card-main strong{display:block;color:#0b2b50;font-size:18px;line-height:1.15;margin-bottom:5px}.td-card-main p{margin:0;color:#6f8298;font-size:14px;line-height:1.35}
  .td-card-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.td-chip{display:inline-flex;align-items:center;min-height:28px;padding:4px 9px;border-radius:999px;background:#f1f5f8;color:#48627d;font-size:12px;font-weight:800}.td-chip.is-own{background:#e8f7ef;color:#17734b}.td-chip.is-open{background:#edf4ff;color:#235fa9}
  .td-chevron{font-size:30px;line-height:1;color:#2f75e8;font-weight:700;padding-left:2px}
  .td-detail-dialog{border:0;padding:0;width:min(680px,100%);max-width:680px;max-height:92dvh;margin:auto 0 0 auto;border-radius:26px 26px 0 0;background:#fff;box-shadow:0 -18px 60px rgba(7,26,48,.24);overflow:hidden}
  .td-detail-dialog::backdrop{background:rgba(7,26,48,.48)}
  .td-sheet{display:flex;flex-direction:column;max-height:92dvh;background:#fff}
  .td-sheet-scroll{overflow:auto;padding:20px 20px 10px;display:grid;gap:18px;-webkit-overflow-scrolling:touch}
  .td-grabber{width:42px;height:5px;border-radius:999px;background:#d8e1e9;margin:9px auto 0}
  .td-sheet-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.td-sheet-head .eyebrow{margin:0 0 4px}.td-sheet-head h2{margin:0;color:#0b2b50;font-size:28px;line-height:1.08}.td-sheet-head p{margin:7px 0 0}
  .td-close{flex:0 0 auto;width:42px;height:42px;border-radius:50%;padding:0;background:#eef3f7!important;color:#0b2b50!important;border:0!important;font-size:24px!important;box-shadow:none!important}
  .td-own-status{border-radius:17px;padding:14px 15px;background:#f3f8fd;display:flex;align-items:center;justify-content:space-between;gap:12px}.td-own-status small{display:block;text-transform:uppercase;letter-spacing:.08em;color:#70839a;font-size:11px;font-weight:850;margin-bottom:3px}.td-own-status strong{color:#0b2b50;font-size:17px}.td-own-status .td-status-pill{padding:7px 11px;border-radius:999px;background:#e8f7ef;color:#17734b;font-size:13px;font-weight:850;white-space:nowrap}
  .td-facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.td-fact{padding:13px;border-radius:15px;background:#f8fafc;border:1px solid #e1e8ef}.td-fact small{display:block;text-transform:uppercase;letter-spacing:.07em;color:#7b8da1;font-size:10px;font-weight:850;margin-bottom:5px}.td-fact strong{color:#0b2b50;font-size:15px;line-height:1.25}
  .td-section{display:grid;gap:9px}.td-section h3{margin:0;color:#0b2b50;font-size:17px}.td-section p{margin:0;line-height:1.45}.td-player-list{border-top:1px solid #e5ebf0}.td-player{padding:10px 2px;border-bottom:1px solid #e5ebf0;color:#0b2b50;font-weight:700}
  .td-next-note{border-radius:14px;padding:12px 13px;background:#fff8e6;color:#654c08;font-size:13px;line-height:1.4}
  .td-actions{position:sticky;bottom:0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:rgba(255,255,255,.97);border-top:1px solid #e2e9ef;display:grid;gap:8px}.td-actions button{min-height:50px;border-radius:14px;font-size:17px;font-weight:850}.td-actions .ghost{background:#fff;color:#0b2b50;border:1px solid #d7e1e9;box-shadow:none}
  @media(max-width:680px){.td-card-ui{grid-template-columns:58px minmax(0,1fr) 18px;padding:14px;gap:12px}.td-date{width:58px;min-height:58px}.td-card-main strong{font-size:17px}.td-detail-dialog{width:100%;margin:auto 0 0}.td-sheet-scroll{padding:18px 18px 8px}.td-actions{padding-left:18px;padding-right:18px}}
  @media(min-width:681px){.td-detail-dialog{margin:auto;border-radius:24px;max-height:84vh}.td-sheet{max-height:84vh}}
`;
document.head.appendChild(style);

const dialog=document.createElement("dialog");
dialog.className="td-detail-dialog";
dialog.id="tournamentDetailDialog";
document.body.appendChild(dialog);
dialog.addEventListener("click",e=>{ if(e.target===dialog) dialog.close(); });

function sourceButton(tournamentId,kind){
  const selector=kind==="register"?`[data-register="${tournamentId}"]`:kind==="withdraw"?`[data-withdraw="${tournamentId}"]`:`[data-checkin="${tournamentId}"]`;
  return document.querySelector(selector);
}

function actionHtml(t,reg){
  const status=String(reg?.status||"");
  if(status==="checked_in") return `<div class="td-actions"><button class="ghost" data-td-action="withdraw">Meld meg av</button></div>`;
  if(status==="registered") return `<div class="td-actions"><button data-td-action="checkin">Sjekk inn på arena</button><button class="ghost" data-td-action="withdraw">Meld meg av</button></div>`;
  if(status==="waitlisted") return `<div class="td-actions"><button class="ghost" data-td-action="withdraw">Fjern meg fra ventelisten</button></div>`;
  if(!tdToken()) return `<div class="td-actions"><button disabled>Logg inn for å melde deg på</button></div>`;
  if(String(t.registration_state||"open")==="open") return `<div class="td-actions"><button data-td-action="register">Meld meg på</button></div>`;
  return `<div class="td-actions"><button disabled>${esc(registrationStateLabel(t.registration_state))}</button></div>`;
}

function openDetail(t){
  const reg=registrationFor(t);
  const count=Number(t.registration_count||0);
  const max=t.max_players?Number(t.max_players):null;
  const names=participantNames(t);
  const own=statusLabel(reg?.status);
  const ownRegistered=["registered","waitlisted","checked_in"].includes(String(reg?.status||""));
  const deadline=t.registration_closes_at?fmtFull(t.registration_closes_at):registrationStateLabel(t.registration_state);
  dialog.innerHTML=`<div class="td-sheet">
    <div class="td-grabber"></div>
    <div class="td-sheet-scroll">
      <div class="td-sheet-head"><div><p class="eyebrow">Turnering</p><h2>${esc(t.name)}</h2><p class="muted">${esc(fmtFull(t.start_at))}</p></div><button class="td-close" type="button" aria-label="Lukk">×</button></div>
      <div class="td-own-status"><div><small>Din status</small><strong>${esc(own)}</strong></div><span class="td-status-pill">${esc(registrationStateLabel(t.registration_state))}</span></div>
      <div class="td-facts">
        <div class="td-fact"><small>Start</small><strong>${esc(fmtFull(t.start_at))}</strong></div>
        <div class="td-fact"><small>Påmeldte</small><strong>${esc(max?`${count} av ${max}`:String(count))}</strong></div>
        <div class="td-fact"><small>Format</small><strong>${esc(formatName(t))}</strong></div>
        <div class="td-fact"><small>Påmeldingsfrist</small><strong>${esc(deadline)}</strong></div>
      </div>
      ${t.description?`<div class="td-section"><h3>Om turneringen</h3><p>${esc(t.description)}</p></div>`:""}
      <div class="td-section"><h3>Deltakere${count?` · ${count}`:""}</h3>${names.length?`<div class="td-player-list">${names.map(n=>`<div class="td-player">${esc(n)}</div>`).join("")}</div>`:`<p class="muted">${count?`${count} ${count===1?"spiller er":"spillere er"} påmeldt. Navnelisten blir tilgjengelig når turneringsdataene inneholder deltakerne.`:"Ingen påmeldte ennå."}</p>`}</div>
      ${ownRegistered?`<div class="td-next-note">Når turneringen starter brukes denne turneringen videre til innsjekk, grupper, kamper og sluttspill.</div>`:""}
    </div>
    ${actionHtml(t,reg)}
  </div>`;
  dialog.querySelector(".td-close")?.addEventListener("click",()=>dialog.close());
  dialog.querySelectorAll("[data-td-action]").forEach(btn=>btn.addEventListener("click",()=>{
    const source=sourceButton(t.id,btn.dataset.tdAction);
    if(!source) return;
    source.click();
    dialog.close();
    window.setTimeout(()=>scheduleEnhance(450),550);
  }));
  dialog.showModal();
}

function cardUi(t){
  const reg=registrationFor(t);
  const d=parseDate(t.start_at);
  const day=d?String(d.getDate()).padStart(2,"0"):"–";
  const month=d?new Intl.DateTimeFormat("nb-NO",{month:"short"}).format(d).replace(".",""):"";
  const count=Number(t.registration_count||0);
  const max=t.max_players?Number(t.max_players):null;
  const own=reg && ["registered","waitlisted","checked_in"].includes(String(reg.status||""));
  const chips=[];
  if(own) chips.push(`<span class="td-chip is-own">${esc(statusLabel(reg.status))}</span>`);
  else if(String(t.registration_state||"open")==="open") chips.push(`<span class="td-chip is-open">Påmelding åpen</span>`);
  chips.push(`<span class="td-chip">${esc(max?`${count}/${max} påmeldt`: `${count} påmeldt`)}</span>`);
  return `<div class="td-card-ui" data-td-ui="1"><div class="td-date"><strong>${esc(day)}</strong><span>${esc(month)}</span></div><div class="td-card-main"><strong>${esc(t.name)}</strong><p>${esc(fmtDate(t.start_at))}${fmtTime(t.start_at)?` · ${esc(fmtTime(t.start_at))}`:""}</p><div class="td-card-meta">${chips.join("")}</div></div><span class="td-chevron" aria-hidden="true">›</span></div>`;
}

function enhanceCards(){
  if(!tournamentList) return;
  tournamentList.classList.add("td-list");
  tournamentList.querySelectorAll(":scope > .list-item").forEach(card=>{
    const originalName=String(card.querySelector(":scope > .section-head strong")?.textContent || card.querySelector("strong")?.textContent || "").trim();
    const t=tournamentData.find(x=>String(x.name||"").trim()===originalName);
    if(!t) return;
    card.classList.add("td-card");
    card.dataset.tdTournamentId=String(t.id);
    card.tabIndex=0;
    card.setAttribute("role","button");
    card.setAttribute("aria-label",`Åpne ${originalName}`);
    card.querySelector(":scope > [data-td-ui]")?.remove();
    card.insertAdjacentHTML("afterbegin",cardUi(t));
  });
}

function hideDuplicateSignup(){
  if(!signupSection) return;
  signupSection.classList.add("td-hidden-signup");
  signupSection.setAttribute("aria-hidden","true");
}

function openFromCard(target){
  const card=target.closest?.("[data-td-tournament-id]");
  if(!card || target.closest("button")) return;
  const t=tournamentData.find(x=>Number(x.id)===Number(card.dataset.tdTournamentId));
  if(t) openDetail(t);
}

tournamentList?.addEventListener("click",e=>openFromCard(e.target));
tournamentList?.addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-td-tournament-id]")){ e.preventDefault(); openFromCard(e.target); } });

async function enhance(){
  if(enhancing) return;
  enhancing=true;
  try{
    hideDuplicateSignup();
    const club=tdClubId();
    if(!club) return;
    const [tData,dData]=await Promise.all([
      tdApi(`/clubs/${club}/registration-tournaments`).catch(()=>null),
      tdToken()?tdApi("/me/dashboard",{auth:true}).catch(()=>null):Promise.resolve(null)
    ]);
    tournamentData=tData?.items || [];
    registrationData=dData?.dashboard?.registrations || [];
    enhanceCards();
  } finally { enhancing=false; }
}
function scheduleEnhance(delay=100){ clearTimeout(refreshTimer); refreshTimer=setTimeout(enhance,delay); }

const observer=new MutationObserver(()=>scheduleEnhance(100));
if(tournamentList) observer.observe(tournamentList,{childList:true,subtree:true});
document.getElementById("clubSelect")?.addEventListener("change",()=>scheduleEnhance(300));
window.addEventListener("bd:player-state-changed",()=>scheduleEnhance(250));
window.addEventListener("bd:portal-view",event=>{ if(event.detail?.target==="tournaments") scheduleEnhance(60); });
window.setTimeout(enhance,350);
