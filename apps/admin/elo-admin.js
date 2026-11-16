const API_ROOT="../api/v1";
const nav=document.querySelector('.section-nav.portal-menu');
const main=document.querySelector('main.main');
const clubSelect=document.getElementById('clubSelect');
let activeClubId=0;
let periods=[];
let currentPeriod=null;
let loading=false;

const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const token=()=>localStorage.getItem("bd:token")||"";
const clubId=()=>Number(clubSelect?.value||localStorage.getItem("bd:selectedClubId")||0);
const pretty=(iso)=>iso?new Intl.DateTimeFormat("nb-NO",{day:"numeric",month:"short",year:"numeric"})
  .format(new Date(iso+"T12:00:00")):"Ingen sluttdato";
const nextDay=(iso)=>iso?new Date(Date.parse(iso+"T12:00:00Z")+86400000).toISOString().slice(0,10):"";
const today=()=>new Date().toLocaleDateString("sv-SE");
function api(path,options={}){
  const headers={};
  if(token())headers.Authorization="Bearer "+token();
  if(options.body!==undefined)headers["Content-Type"]="application/json";
  return fetch(API_ROOT+path,{method:options.method||"GET",headers,
    body:options.body===undefined?undefined:JSON.stringify(options.body),cache:"no-store"})
    .then(async response=>{
      const payload=await response.json().catch(()=>null);
      if(!response.ok||!payload?.ok)throw Error(payload?.error?.message||"Kunne ikke hente ELO.");
      return payload.data;
    });
}

function install(){
  if(!nav||!main||document.getElementById("elo"))return;
  const section=document.createElement("section");
  section.id="elo";
  section.dataset.portalSection="elo";
  section.className="panel club-elo-admin";
  section.innerHTML=`
    <header class="club-elo-head">
      <div><p class="eyebrow">Klubbens rating</p><h2>ELO</h2>
      <p class="muted">ELO følger spillerne på tvers av Mandagsserien og andre sesonger. Bare ELO-tellende turneringer påvirker ratingen.</p></div>
    </header>
    <div id="clubEloStatus" role="status" aria-live="polite"></div>
    <div id="clubEloCurrent">Henter ratingperiode …</div>
    <div id="clubEloRating"></div>
    <section id="clubEloHistory" class="club-elo-history"></section>
  `;
  (document.getElementById("seasons")||document.getElementById("tournaments"))?.after(section);
  const style=document.createElement("style");
  style.textContent=`
    .club-elo-admin{display:grid;gap:18px;min-width:0;max-width:100%;overflow-wrap:anywhere}
    .club-elo-head h2{margin:.1rem 0 .5rem}
    .club-elo-head p.muted{max-width:70ch;line-height:1.55}
    .club-elo-card,.club-elo-history,.club-elo-rank{border:1px solid #d9e5f0;border-radius:16px;padding:18px;background:#fff;min-width:0}
    .club-elo-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
    .club-elo-header h3{margin:2px 0 4px;font-size:1.35rem}
    .club-elo-dates{display:flex;gap:12px;flex-wrap:wrap;color:#4c657e;font-size:13px;margin:12px 0}
    .club-elo-dates span{background:#f2f6fc;border-radius:9px;padding:8px 12px}
    .club-elo-hint{color:#51677e;line-height:1.5;font-size:13px}
    .club-elo-actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 0}
    .club-elo-form{margin-top:16px;padding:16px;background:#f4f8fd;border-radius:12px;display:grid;gap:12px}
    .club-elo-form label{display:grid;gap:6px;font-weight:750;font-size:13px}
    .club-elo-form input{width:100%;max-width:380px;min-height:44px;padding:10px;border:1px solid #b8cadc;border-radius:9px}
    .club-elo-form p{margin:0}
    .club-elo-form-actions{display:flex;flex-wrap:wrap;gap:8px}
    .club-elo-history{display:grid;gap:12px}
    .club-elo-history h3,.club-elo-rank h3{margin:0}
    .club-elo-period-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;border-top:1px solid #edf1f6;padding-top:10px}
    .club-elo-period-row small{display:block;color:#627b93;margin-top:4px}
    .club-elo-pill{font-weight:800;font-size:12px;padding:5px 9px;border:1px solid #c3d3e4;border-radius:999px;white-space:nowrap;align-self:start}
    .club-elo-pill.active{background:#e6f5ec;color:#17603b;border-color:#a6d5bb}
    .club-elo-rank-list{display:grid;gap:5px;margin-top:10px}
    .club-elo-rank-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;padding:8px 0;border-bottom:1px solid #ecf0f6;align-items:center}
    .club-elo-rank-row b{font-variant-numeric:tabular-nums}
    .club-elo-note{padding:11px 13px;background:#eef5fd;border:1px solid #c8daee;border-radius:10px;color:#2c537c;line-height:1.5}
    .club-elo-error{padding:10px 13px;border:1px solid #eab5b7;color:#9a2e39;background:#fff0f0;border-radius:10px}
    .club-elo-success{padding:10px 13px;border:1px solid #a5d9b5;color:#21643b;background:#f0fbf4;border-radius:10px}
    @media(max-width:540px){.club-elo-card,.club-elo-history,.club-elo-rank{padding:14px}.club-elo-form{padding:12px}.club-elo-actions button,.club-elo-form-actions button{min-height:44px;flex:1;min-width:0}}
  `;
  document.head.appendChild(style);
}
function notify(message,success=false){
  const node=document.getElementById("clubEloStatus");if(!node)return;
  node.className=success?"club-elo-success":"club-elo-error";node.textContent=message;
}
function clearNotice(){const node=document.getElementById("clubEloStatus");if(node){node.className="";node.textContent="";}}
function periodName(period){return period?.name||"ELO";}
function label(status){return {active:"Aktiv",scheduled:"Planlagt",completed:"Avsluttet"}[status]||status;}
function cardMarkup(period){
  if(!period)return `<div class="club-elo-card"><h3>Ingen ELO-ordning ennå</h3>
      <p class="club-elo-hint">Opprett én ELO for klubben. Den kan være løpende uten sluttdato.</p>
      <form id="eloFirstForm" class="club-elo-form"><label>Navn
      <input name="name" value="Klubbens ELO" maxlength="150" required></label>
      <label>Startdato<input name="starts_on" type="date" required value="${today()}"></label>
      <button type="submit" class="button">Start klubbens ELO</button></form></div>`;
  const rolloverAllowed=period.ends_on===null&&period.status==="active";
  const scheduled=period.status==="scheduled";
  return `<article class="club-elo-card">
    <div class="club-elo-header"><div><p class="eyebrow">${scheduled?"Neste ELO-periode":"Gjeldende ratingperiode"}</p>
       <h3>${esc(periodName(period))}</h3></div><span class="club-elo-pill ${esc(period.status)}">${esc(label(period.status))}</span></div>
    <div class="club-elo-dates"><span>Start: ${esc(pretty(period.starts_on))}</span><span>Slutt: ${esc(pretty(period.ends_on))}</span></div>
    <p class="club-elo-hint">${scheduled?"Denne perioden starter automatisk på datoen over.":"Ingen sluttdato betyr at ELO fortsetter også når en ny sesong starter."}</p>
    ${rolloverAllowed?`<div class="club-elo-actions"><button class="button secondary" id="eloNewPeriodButton" type="button">Avslutt og start ny ELO</button>
         <button class="button quiet" id="eloRenameButton" type="button">Endre navn</button></div>
       <form id="eloRolloverForm" class="club-elo-form hidden">
         <p><strong>Ny ELO-periode</strong></p>
         <p class="club-elo-hint">Den gamle ratingen fryses fra sluttdatoen. En ny rating starter på 1000 dagen etter. Klubbens konkurransesesonger påvirkes ikke.</p>
         <label>Sluttdato for gjeldende ELO<input name="ends_on" type="date" min="${today()}" required value="${today()}"></label>
         <p class="club-elo-note" id="eloNextStart">Ny ELO starter ${esc(pretty(nextDay(today())))}.</p>
         <label>Navn på ny ELO<input name="name" maxlength="150" value="Ny ELO" required></label>
         <div class="club-elo-form-actions"><button class="button" type="submit">Avslutt og opprett ny</button><button type="button" class="button secondary" data-elo-cancel>Avbryt</button></div>
       </form>
       <form id="eloRenameForm" class="club-elo-form hidden"><label>Navn<input name="name" maxlength="150" required value="${esc(period.name)}"></label>
          <div class="club-elo-form-actions"><button type="submit" class="button">Lagre navn</button><button type="button" class="button secondary" data-elo-cancel>Avbryt</button></div></form>`:""}
  </article>`;
}
function render(periodData,ratingData){
  periods=Array.isArray(periodData?.items)?periodData.items:[];
  const open=periods.find(p=>p.ends_on===null)||null;
  currentPeriod=periodData?.current||open;
  const currentNode=document.getElementById("clubEloCurrent");
  const history=document.getElementById("clubEloHistory");
  const rank=document.getElementById("clubEloRating");
  if(currentNode)currentNode.innerHTML=cardMarkup(currentPeriod);
  if(history)history.innerHTML=`<h3>ELO-historikk</h3>
    <p class="club-elo-hint">Det kan bare være én aktiv ELO per klubb. Tidligere perioder lagres med sine egne sluttdatoer.</p>
    ${periods.length?periods.map(p=>`<div class="club-elo-period-row"><div>
        <strong>${esc(p.name)}</strong><small>${esc(pretty(p.starts_on))} – ${esc(pretty(p.ends_on))}</small>
      </div><span class="club-elo-pill ${esc(p.status)}">${esc(label(p.status))}</span></div>`).join(""):"<p>Ingen ELO-perioder ennå.</p>"}`;
  const rows=Array.isArray(ratingData?.items)?ratingData.items.slice(0,8):[];
  if(rank)rank.innerHTML=`<section class="club-elo-rank"><h3>Ratingoversikt</h3>
    <p class="club-elo-hint">${esc(periodName(ratingData?.period))} · Bare medlemmer som har spilt tellende kamper</p>
    <div class="club-elo-rank-list">${rows.length?rows.map((p,i)=>`<div class="club-elo-rank-row"><span>${i+1}.</span><strong>${esc(p.display_name)}</strong>
      <b>${Number(p.elo_rating).toFixed(1)}</b></div>`).join(""):"Ingen tellende kamper registrert i denne perioden ennå."}</div>
    </section>`;
  bindActions();
}
function bindActions(){
  const node=document.getElementById("clubEloCurrent");if(!node)return;
  node.querySelector("#eloNewPeriodButton")?.addEventListener("click",()=>{
    node.querySelector("#eloRolloverForm")?.classList.remove("hidden");
    node.querySelector("#eloRenameForm")?.classList.add("hidden");
  });
  node.querySelector("#eloRenameButton")?.addEventListener("click",()=>{
    node.querySelector("#eloRenameForm")?.classList.remove("hidden");
    node.querySelector("#eloRolloverForm")?.classList.add("hidden");
  });
  node.querySelectorAll("[data-elo-cancel]").forEach(b=>b.addEventListener("click",()=>{
    b.closest("form")?.classList.add("hidden");
  }));
  const rollover=node.querySelector("#eloRolloverForm");
  rollover?.querySelector('[name="ends_on"]')?.addEventListener("change",event=>{
    const preview=node.querySelector("#eloNextStart");
    if(preview&&event.target.value)preview.textContent="Ny ELO starter "+pretty(nextDay(event.target.value))+".";
  });
  rollover?.addEventListener("submit",async event=>{
    event.preventDefault();
    const data=new FormData(rollover);
    const end=String(data.get("ends_on")||"");
    const name=String(data.get("name")||"").trim();
    if(end<today()){notify("Sluttdato kan ikke være i fortiden.");return;}
    if(!window.confirm("Avslutte gjeldende ELO "+pretty(end)+" og starte «"+name+"» "+pretty(nextDay(end))+"? Den nye ratingen starter på 1000."))return;
    await submit(rollover,()=>api("/clubs/"+activeClubId+"/elo-periods/rollover",
      {method:"POST",body:{ends_on:end,name}}));
  });
  node.querySelector("#eloRenameForm")?.addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const name=String(new FormData(form).get("name")||"").trim();
    await submit(form,()=>api("/elo-periods/"+currentPeriod.id,{method:"PATCH",body:{name}}));
  });
  node.querySelector("#eloFirstForm")?.addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    await submit(form,()=>api("/clubs/"+activeClubId+"/elo-periods",
      {method:"POST",body:{name:data.get("name"),starts_on:data.get("starts_on")}}));
  });
}
async function submit(form,request){
  const button=form.querySelector('[type="submit"]');
  if(button)button.disabled=true;
  clearNotice();
  try{
    await request();
    notify("ELO-oppsettet er lagret.",true);
    await load(true);
  }catch(error){notify(error.message||"Kunne ikke lagre.");}
  finally{if(button&&button.isConnected)button.disabled=false;}
}
async function load(force=false){
  if(document.body.dataset.portalActive!=="elo"&&!force)return;
  const id=clubId();
  if(!id||!token()||loading)return;
  loading=true;
  activeClubId=id;
  try{
    const [periodData,ratingData]=await Promise.all([
      api("/clubs/"+id+"/elo-periods"),
      api("/clubs/"+id+"/club-elo"),
    ]);
    if(id!==clubId())return;
    render(periodData,ratingData);
  }catch(error){notify(error.message||"Kunne ikke hente ELO.");}
  finally{loading=false;}
}
install();
window.addEventListener("bd:portal-view",event=>{if(event.detail?.target==="elo")void load(true);});
clubSelect?.addEventListener("change",()=>{if(document.body.dataset.portalActive==="elo")void load(true);});
window.addEventListener("bd:session",()=>{if(document.body.dataset.portalActive==="elo")void load(true);});
if(document.body.dataset.portalActive==="elo"||location.hash.endsWith("/elo")||location.hash==="#elo")void load(true);
