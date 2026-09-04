const API_ROOT = "../api/v1";
let currentId = 0;
let loading = false;
let saveTimer = null;

function token(){ return localStorage.getItem("bd:token") || ""; }
async function api(path,{method="GET",body}={}){
  const headers={Authorization:`Bearer ${token()}`};
  if(body!==undefined) headers["Content-Type"]="application/json";
  const response=await fetch(`${API_ROOT}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload?.ok) throw new Error(payload?.error?.message||`Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureControls(){
  const advanced=document.getElementById("tcFormatAdvanced");
  const grid=advanced?.querySelector(".tournament-control-grid");
  if(!grid) return false;
  advanced.open=true;
  if(document.getElementById("tcTournamentFormat")) return true;

  const formatLabel=document.createElement("label");
  formatLabel.innerHTML=`<span>Turneringsformat</span><select id="tcTournamentFormat"><option value="groups_playoff">Gruppespill + sluttspill</option><option value="groups_only">Kun gruppespill</option></select>`;
  const scoreLabel=document.createElement("label");
  scoreLabel.innerHTML=`<span>Spill</span><select id="tcStartingScore"><option value="501">501</option><option value="301">301</option><option value="701">701</option><option value="1001">1001</option></select>`;
  grid.prepend(scoreLabel);
  grid.prepend(formatLabel);

  document.getElementById("tcTournamentFormat")?.addEventListener("change",()=>{syncVisibility(); scheduleSave();});
  document.getElementById("tcStartingScore")?.addEventListener("change",scheduleSave);
  ["tcGroupCount","tcDrawMode","tcBestOf","tcQualifiers","tcPlayoffBestOf"].forEach(id=>document.getElementById(id)?.addEventListener("change",scheduleSave));
  return true;
}

function syncVisibility(){
  const format=document.getElementById("tcTournamentFormat")?.value||"groups_playoff";
  const qualifiers=document.getElementById("tcQualifiers")?.closest("label");
  const playoff=document.getElementById("tcPlayoffBestOf")?.closest("label");
  const groupsOnly=format==="groups_only";
  if(qualifiers) qualifiers.style.display=groupsOnly?"none":"";
  if(playoff) playoff.style.display=groupsOnly?"none":"";
}

function planBody(){
  return {
    tournament_format: document.getElementById("tcTournamentFormat")?.value || "groups_playoff",
    starting_score: Number(document.getElementById("tcStartingScore")?.value || 501),
    group_count: Number(document.getElementById("tcGroupCount")?.value || 1),
    group_draw_mode: document.getElementById("tcDrawMode")?.value || "elo_snake",
    group_best_of_legs: Number(document.getElementById("tcBestOf")?.value || 3),
    qualifiers_per_group: Number(document.getElementById("tcQualifiers")?.value || 2),
    playoff_best_of_legs: Number(document.getElementById("tcPlayoffBestOf")?.value || 3),
  };
}

function scheduleSave(){
  if(!currentId||loading) return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>api(`/tournaments/${currentId}/wizard-plan`,{method:"PUT",body:planBody()}).catch(()=>{}),180);
}

async function load(id){
  currentId=Number(id||0);
  if(!currentId||!ensureControls()) return;
  loading=true;
  try{
    const data=await api(`/tournaments/${currentId}/wizard-plan`);
    const plan=data?.plan||{};
    const format=document.getElementById("tcTournamentFormat");
    const score=document.getElementById("tcStartingScore");
    if(format) format.value=["groups_playoff","groups_only"].includes(String(plan.tournament_format))?String(plan.tournament_format):"groups_playoff";
    if(score) score.value=String(Number(plan.starting_score||501));
    syncVisibility();
  }finally{ loading=false; }
}

window.addEventListener("bd:tournament-context",event=>{
  const context=event.detail||{};
  if(String(context.view)==="format"){
    ensureControls();
    load(context.id).catch(()=>{});
  }
});

/* Controls normally exist before this module is loaded. If module ordering changes,
   observe only Tournament Admin until the controls appear, then disconnect. A
   document.body observer made unrelated portal/menu DOM updates trigger format work. */
if(!ensureControls()){
  const observerRoot=document.getElementById("tournaments");
  if(observerRoot){
    const observer=new MutationObserver(()=>{
      if(!ensureControls()) return;
      observer.disconnect();
      if(window.__bdTournamentContext?.view==="format") load(window.__bdTournamentContext.id).catch(()=>{});
    });
    observer.observe(observerRoot,{subtree:true,childList:true});
  }
}
