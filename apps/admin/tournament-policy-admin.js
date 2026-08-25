const TP_API_ROOT = "../api/v1";

const tpState = { tournamentId: 0, loading: false, policy: null, groups: [] };

function tpToken() { return localStorage.getItem("bd:token") || ""; }
function tpTournamentId() { return Number(document.getElementById("trTournament")?.value || localStorage.getItem("bd:adminTournamentId") || 0); }
function tpEsc(value) { return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function tpDate(value) { if (!value) return "—"; const d=new Date(String(value).replace(" ","T")); return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat("nb-NO",{weekday:"short",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d); }
function tpMoney(ore) { return new Intl.NumberFormat("nb-NO",{style:"currency",currency:"NOK",maximumFractionDigits:2}).format(Number(ore||0)/100); }

async function tpApi(path,{method="GET",body}={}) {
  const headers={Authorization:`Bearer ${tpToken()}`};
  if(body!==undefined) headers["Content-Type"]="application/json";
  const response=await fetch(`${TP_API_ROOT}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload?.ok) throw new Error(payload?.error?.message||`Forespørselen feilet (${response.status})`);
  return payload.data;
}

function tpInstallStyles(){
  if(document.getElementById("tournamentPolicyStyles")) return;
  const style=document.createElement("style"); style.id="tournamentPolicyStyles";
  style.textContent=`
    .tp-card{display:grid;gap:14px;margin:14px 0;padding:16px;border:1px solid #c9dfe9;border-radius:16px;background:#f7fbfd;color:#12384d}
    .tp-head{display:flex;justify-content:space-between;gap:14px;align-items:start}.tp-head h3{margin:2px 0 4px}.tp-status{font-weight:800;color:#11435d}
    .tp-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.tp-grid>div{padding:11px;border-radius:12px;background:#fff;border:1px solid #dbe8ef}.tp-grid span{display:block;color:#607989;font-size:12px}.tp-grid strong{display:block;margin-top:4px;font-size:14px}
    .tp-start{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:13px 14px;border-radius:13px;background:#e8f5fb}.tp-start-copy{display:grid;gap:3px}.tp-start-copy small{color:#587384}.tp-start .button{white-space:nowrap}
    .tp-billing-warning{background:#fff7e6;border:1px solid #e9c56e;padding:10px 12px;border-radius:11px;color:#634b11}
    .tc-fixed-timing-note{padding:12px 14px;border:1px solid #c9dfe9;border-radius:13px;background:#eef7fc;margin-bottom:12px}.tc-fixed-timing-note strong{display:block;margin-bottom:3px}
    @media(max-width:760px){.tp-grid{grid-template-columns:1fr 1fr}.tp-start{align-items:stretch;flex-direction:column}.tp-start .button{width:100%}}
  `; document.head.appendChild(style);
}

function tpNormalizeLegacyRegistration(){
  const opens=document.getElementById("tcOpens"), closes=document.getElementById("tcCloses");
  opens?.closest("label")?.classList.add("hidden"); closes?.closest("label")?.classList.add("hidden");
  const save=document.getElementById("tcSaveSettings"); if(save) save.textContent="Lagre maks antall";
  const parent=document.querySelector("#tournaments .tournament-control-grid .create-card");
  if(parent&&!parent.querySelector(".tc-fixed-timing-note")){
    const note=document.createElement("div"); note.className="tc-fixed-timing-note";
    note.innerHTML="<strong>Påmeldingsfristen styres automatisk</strong><span class='muted'>Åpner 6 dager og 23 timer før planlagt start og stenger når turneringen startes.</span>";
    parent.insertBefore(note,parent.querySelector("label")||parent.firstChild);
  }
}

function tpEnsureCard(){
  const room=document.getElementById("tournamentRoom"); if(!room) return null;
  let card=document.getElementById("tournamentPolicyCard");
  if(!card){card=document.createElement("section");card.id="tournamentPolicyCard";card.className="tp-card";document.getElementById("trProgress")?.insertAdjacentElement("afterend",card);}
  return card;
}

function tpBillingLabel(p){
  if(p.club_billing_mode==="free"||p.billing_status==="waived") return "Gratis";
  if(p.billing_status==="paid") return `Betalt · ${tpMoney(p.billing_amount_ore)}`;
  return `Venter betaling · ${tpMoney(p.billing_amount_ore)}`;
}

function tpRender(){
  tpNormalizeLegacyRegistration(); const card=tpEnsureCard(); const p=tpState.policy; if(!card||!p) return;
  const started=Boolean(p.actual_started_at)||["in_progress","completed","archived"].includes(String(p.status));
  const unpaid=p.club_billing_mode==="stripe"&&Number(p.billing_amount_ore)>0&&p.billing_status!=="paid";
  card.innerHTML=`
    <div class="tp-head"><div><p class="eyebrow">Turneringsregler</p><h3>${tpEsc(p.name)}</h3><span class="tp-status">${started?`Startet ${tpEsc(tpDate(p.actual_started_at))}`:"Ikke startet"}</span></div><span class="pill">${tpEsc(p.season_name||"Ingen serie/sesong")}</span></div>
    <div class="tp-grid">
      <div><span>Påmelding åpner</span><strong>${tpEsc(tpDate(p.registration_opens_at))}</strong></div>
      <div><span>Check-in åpner</span><strong>${tpEsc(tpDate(p.checkin_opens_at))}</strong></div>
      <div><span>Begge stenger</span><strong>${started?tpEsc(tpDate(p.actual_started_at)):"Når Start trykkes"}</strong></div>
      <div><span>Klubbpris</span><strong>${tpEsc(tpBillingLabel(p))}</strong></div>
    </div>
    ${unpaid?`<div class="tp-billing-warning"><strong>Betaling kreves før start.</strong> Stripe-flyten kobles på denne betalingsstatusen. Superadmin kan sette klubben til Gratis.</div>`:""}
    <div class="tp-start"><div class="tp-start-copy"><strong>${started?"Turneringen er startet":"Klar når du er klar"}</strong><small>${started?"Påmelding og check-in er stengt.":"Start er en eksplisitt handling. Den stenger påmelding og check-in umiddelbart og åpner kampdriften."}</small></div>${started?"":`<button id="tpStartTournament" type="button" class="button" ${unpaid?"disabled":""}>Start turnering</button>`}</div>`;
  document.getElementById("tpStartTournament")?.addEventListener("click",tpStart);
  tpOverrideRecommendedStep(started);
}

function tpOverrideRecommendedStep(started){
  const button=document.getElementById("trNextButton");
  if(!button) return;
  if(!started&&tpState.groups.length>0){
    button.disabled=false; button.textContent="Start turnering"; button.dataset.policyStart="1"; button.dataset.targetView="overview"; button.dataset.focusId="tpStartTournament";
    const copy=document.querySelector("#trNext .tournament-room-next-copy"); if(copy) copy.innerHTML="<strong>Neste anbefalte steg</strong><small>Start turneringen når check-in er ferdig.</small>";
  } else { delete button.dataset.policyStart; }
}

async function tpStart(){
  const id=tpTournamentId(); if(!id) return;
  const button=document.getElementById("tpStartTournament"); if(button) button.disabled=true;
  const ok=window.confirm("Starte turneringen nå? Påmelding og check-in stenger umiddelbart.");
  if(!ok){if(button)button.disabled=false;return;}
  try{
    await tpApi(`/tournaments/${id}/start`,{method:"POST",body:{}});
    await tpLoad(true);
    document.getElementById("refreshAllButton")?.click();
    document.getElementById("tcRefresh")?.click();
    window.dispatchEvent(new CustomEvent("bd:tournament-started",{detail:{tournamentId:id}}));
  }catch(error){window.alert(error.message);if(button)button.disabled=false;}
}

async function tpLoad(force=false){
  const id=tpTournamentId(); if(!id||tpState.loading) return; if(!force&&id===tpState.tournamentId&&tpState.policy) {tpRender();return;}
  tpState.loading=true;
  try{
    const [policy,groups]=await Promise.all([tpApi(`/tournaments/${id}/policy`),tpApi(`/tournaments/${id}/groups`)]);
    tpState.tournamentId=id;tpState.policy=policy.tournament||null;tpState.groups=groups.groups||[];tpRender();
  }catch(error){const card=tpEnsureCard();if(card)card.innerHTML=`<div class="message error">${tpEsc(error.message)}</div>`;}
  finally{tpState.loading=false;}
}

function tpBoot(){
  tpInstallStyles();tpNormalizeLegacyRegistration();
  document.addEventListener("change",(event)=>{if(event.target?.id==="trTournament")setTimeout(()=>tpLoad(true),30);});
  document.getElementById("trNextButton")?.addEventListener("click",(event)=>{if(event.currentTarget.dataset.policyStart==="1"){event.preventDefault();event.stopImmediatePropagation();document.getElementById("tpStartTournament")?.focus();document.getElementById("tpStartTournament")?.scrollIntoView({behavior:"smooth",block:"center"});}},true);
  window.addEventListener("bd:tournament-created",()=>setTimeout(()=>tpLoad(true),300));
  document.getElementById("refreshAllButton")?.addEventListener("click",()=>setTimeout(()=>tpLoad(true),300));
  new MutationObserver(()=>{tpNormalizeLegacyRegistration();if(document.getElementById("tournamentRoom")){tpEnsureCard();if(!tpState.loading)tpLoad();}}).observe(document.getElementById("tournaments")||document.body,{childList:true,subtree:true});
  const timer=setInterval(()=>{if(document.getElementById("trTournament")){clearInterval(timer);tpLoad(true);}},120);
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",tpBoot,{once:true});else tpBoot();
