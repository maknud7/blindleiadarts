const API_ROOT = "../api/v1";
let activeTournamentId = 0;
let timer = null;
let cache = new Map();

function token(){ return localStorage.getItem("bd:token") || ""; }
function esc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function num(value){ const parsed=Number(value); return Number.isFinite(parsed)?parsed:0; }
function avg(value){ const parsed=Number(value); return Number.isFinite(parsed)&&parsed>0?parsed.toFixed(2):"—"; }
async function api(path,{auth=false}={}){ const headers={}; if(auth&&token()) headers.Authorization=`Bearer ${token()}`; const r=await fetch(`${API_ROOT}${path}`,{headers,cache:"no-store"}); const p=await r.json().catch(()=>null); if(!r.ok||!p?.ok) throw new Error(p?.error?.message||`Forespørselen feilet (${r.status})`); return p.data; }

const style=document.createElement("style");
style.textContent=`
.tdx-detail-tabs{display:flex!important;grid-template-columns:none!important;gap:4px;overflow-x:auto;scrollbar-width:none;min-width:0}.tdx-detail-tabs::-webkit-scrollbar{display:none}.tdx-detail-tabs button{flex:0 0 auto!important;width:auto!important;min-width:0!important;padding-left:14px!important;padding-right:14px!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important}
.tdx-groups-panel{display:grid;gap:14px;min-width:0}
.tdx-group-picker{display:flex;gap:8px;overflow-x:auto;padding:2px 0 4px;scrollbar-width:none}.tdx-group-picker::-webkit-scrollbar{display:none}
.tdx-group-picker button{flex:0 0 auto!important;width:auto!important;min-width:0!important;border:1px solid #d4e0eb!important;border-radius:999px!important;background:#fff!important;color:#63788f!important;padding:9px 14px!important;font-weight:850!important;white-space:nowrap!important;box-shadow:none!important}.tdx-group-picker button.active{background:#174f91!important;border-color:#174f91!important;color:#fff!important}
.tdx-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}.tdx-group-head h3{margin:0}.tdx-group-head p{margin:3px 0 0;color:#73869a;font-size:13px}
.tdx-group-table{display:grid;min-width:0}.tdx-group-tr{display:grid;grid-template-columns:28px minmax(0,1fr) 30px 30px 30px 42px 54px 32px;align-items:center;gap:5px;min-height:44px;border-top:1px solid #e8eef3;font-size:13px}.tdx-group-tr:first-child{border-top:0}.tdx-group-tr.is-me{background:#eef5ff;margin:0 -8px;padding:0 8px;border-radius:10px}.tdx-group-tr.is-qualified .tdx-group-pos{color:#176b35}.tdx-group-th{color:#8090a0;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;min-height:30px}.tdx-group-name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#0b2b50;font-weight:800}.tdx-group-pos{font-weight:900;color:#63788f}.tdx-group-stat{text-align:right;color:#435b73}.tdx-group-3da{font-variant-numeric:tabular-nums}.tdx-group-points{font-weight:900;color:#0b2b50}.tdx-qualified-mark{color:#2d7a45;margin-left:4px}
.tdx-group-legend{display:flex;gap:12px;flex-wrap:wrap;color:#718399;font-size:12px;margin-top:8px}.tdx-group-legend strong{color:#2d7a45}
.tdx-group-matches{display:grid}.tdx-section .tdx-group-match{appearance:none!important;-webkit-appearance:none!important;box-sizing:border-box!important;width:100%!important;min-width:0!important;min-height:0!important;height:auto!important;margin:0!important;border:0!important;border-top:1px solid #e8eef3!important;border-radius:0!important;background:#fff!important;background-image:none!important;color:#0b2b50!important;box-shadow:none!important;font:inherit!important;font-size:14px!important;font-weight:400!important;line-height:1.25!important;text-align:inherit!important;display:grid!important;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)!important;align-items:center!important;gap:8px!important;padding:10px 2px!important;cursor:pointer!important}.tdx-section .tdx-group-match:first-child{border-top:0!important}.tdx-section .tdx-group-match:active,.tdx-section .tdx-group-match:hover{background:#f4f8fc!important;transform:none!important}.tdx-group-match span:first-child{text-align:left}.tdx-group-match span:nth-child(3){text-align:right}.tdx-group-match strong{font-size:14px!important;color:#0b2b50!important}.tdx-group-match small{grid-column:1/-1;color:#7a8da0!important;font-size:11px!important;text-align:left!important}.tdx-group-live{color:#b22b2b!important}.tdx-match-chevron{color:#9aabba!important;margin-left:5px;font-weight:900}
.tdx-match-detail{border:0;padding:0;width:min(92vw,520px);max-width:520px;border-radius:20px;background:#fff;color:#0b2b50;box-shadow:0 22px 60px rgba(6,31,58,.28)}.tdx-match-detail::backdrop{background:rgba(4,20,38,.46)}.tdx-match-detail-card{padding:18px;display:grid;gap:16px}.tdx-match-detail-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.tdx-match-detail-head h3{margin:0}.tdx-match-close{border:0;background:#edf3f8;color:#0b2b50;border-radius:999px;width:38px;height:38px;font-size:22px}.tdx-match-detail-score{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;background:#f4f7fa;border-radius:16px;padding:16px}.tdx-match-detail-score span:last-child{text-align:right}.tdx-match-detail-score strong{font-size:24px}.tdx-match-detail-meta{display:grid;gap:8px;color:#667c92;font-size:13px}.tdx-match-detail-meta div{display:flex;justify-content:space-between;gap:14px}.tdx-match-detail-meta b{color:#0b2b50;text-align:right}
@media(max-width:520px){.tdx-detail-tabs button{padding-left:12px!important;padding-right:12px!important}.tdx-group-tr{grid-template-columns:25px minmax(0,1fr) 27px 27px 39px 48px 30px}.tdx-group-tr>*:nth-child(5){display:none}.tdx-group-th>*:nth-child(5){display:none}.tdx-section .tdx-group-match{padding:9px 2px!important;font-size:13px!important}.tdx-group-match strong{font-size:13px!important}}
`;
document.head.appendChild(style);

document.addEventListener("click",event=>{
  const source=event.target instanceof Element?event.target:null;
  const open=source?.closest("[data-open]");
  if(open){ activeTournamentId=Number(open.getAttribute("data-open")||0); schedule(); }
  const groupTab=source?.closest('dialog.tdx-detail .tdx-detail-tabs [data-tab="groups"]');
  if(groupTab&&activeTournamentId){
    event.preventDefault();
    event.stopPropagation();
    openGroups(activeTournamentId,groupTab);
  }
},true);
function schedule(){ clearTimeout(timer); timer=setTimeout(enhance,40); }

async function load(id){
  if(cache.has(id)) return cache.get(id);
  const promise=Promise.all([
    api(`/tournaments/${id}/groups`).catch(()=>({groups:[]})),
    api(`/tournaments/${id}/tables`).catch(()=>({groups:[]})),
    api(`/tournaments/${id}/matches`).catch(()=>({items:[]})),
    api(`/tournaments/${id}/results`).catch(()=>({items:[]})),
    api(`/tournaments/${id}/playoffs`).catch(()=>({bracket:null})),
    token()?api('/auth/me',{auth:true}).catch(()=>null):Promise.resolve(null),
  ]).then(([groups,tables,matches,results,playoff,me])=>({groups:groups?.groups||[],tables:tables?.groups||[],matches:matches?.items||[],results:results?.items||[],playoff:playoff||{},me:me?.user||null}));
  cache.set(id,promise);
  return promise;
}

function enhance(){
  const dialog=document.querySelector("dialog.tdx-detail");
  if(!dialog?.open||!activeTournamentId) return;
  const tabs=dialog.querySelector(".tdx-detail-tabs");
  if(!tabs) return;
  if(!tabs.querySelector('[data-tab="groups"]')){
    const button=document.createElement("button");
    button.type="button";
    button.dataset.tab="groups";
    button.textContent="Grupper";
    const overview=tabs.querySelector('[data-tab="overview"]');
    if(overview?.nextSibling) tabs.insertBefore(button,overview.nextSibling); else tabs.prepend(button);
  }
}

function tableFor(data,group){ return data.tables.find(entry=>num(entry.id)===num(group.id)||String(entry.name)===String(group.name))||null; }
function matchGroup(match,group){ return num(match.tournament_group_id)===num(group.id)||String(match.group_name||match.bracket_label||"")===String(group.name||""); }
function mergedMatches(data){ const map=new Map((data.results||[]).map(item=>[num(item.id),item])); return (data.matches||[]).map(item=>({...item,...(map.get(num(item.id))||{})})); }
function qualifiers(data){ return num(data.playoff?.bracket?.playoff?.qualifiers_per_group||data.playoff?.playoff?.qualifiers_per_group); }
function currentPlayerId(data){ return num(data.me?.player?.id); }

function renderTable(group,data){
  const table=tableFor(data,group);
  const rows=table?.rows||group.players||[];
  const q=qualifiers(data);
  const me=currentPlayerId(data);
  if(!rows.length) return `<p class="muted">Ingen spillere i gruppen ennå.</p>`;
  const body=rows.map((row,index)=>{
    const position=num(row.position)||index+1;
    const playerId=num(row.player_id);
    const diff=num(row.leg_diff);
    const qualified=q>0&&position<=q;
    return `<div class="tdx-group-tr ${playerId===me?"is-me":""} ${qualified?"is-qualified":""}" data-tdx-player-id="${playerId}"><span class="tdx-group-pos">${position}</span><span class="tdx-group-name">${esc(row.display_name||row.player_name||"Spiller")}${qualified?`<span class="tdx-qualified-mark">✓</span>`:""}</span><span class="tdx-group-stat">${num(row.played)}</span><span class="tdx-group-stat">${num(row.wins)}</span><span class="tdx-group-stat">${num(row.losses)}</span><span class="tdx-group-stat">${diff>0?"+":""}${diff}</span><span class="tdx-group-stat tdx-group-3da">${avg(row.three_dart_average)}</span><span class="tdx-group-stat tdx-group-points">${num(row.points)}</span></div>`;
  }).join("");
  return `<div class="tdx-group-table"><div class="tdx-group-tr tdx-group-th"><span>#</span><span>Spiller</span><span class="tdx-group-stat">K</span><span class="tdx-group-stat">V</span><span class="tdx-group-stat">T</span><span class="tdx-group-stat">+/-</span><span class="tdx-group-stat" title="3-dart average i gruppespillet">3DA</span><span class="tdx-group-stat">P</span></div>${body}</div>${q>0?`<div class="tdx-group-legend"><span><strong>✓</strong> Videre til sluttspill</span><span>Ved likt: legdiff → 3DA → innbyrdes</span></div>`:""}`;
}

function score(match){
  const a=match.player_a_legs??match.player_a_score??null;
  const b=match.player_b_legs??match.player_b_score??null;
  if(String(match.status)==="completed"&&a!==null&&b!==null) return `${num(a)}–${num(b)}`;
  if(String(match.status)==="in_progress") return "LIVE";
  return "–";
}
function statusLabel(match){ return ({completed:"Ferdig",in_progress:"Pågår",assigned:"Tildelt",pending:"Ikke startet",cancelled:"Avlyst"})[String(match.status||"")]||String(match.status||""); }
function renderMatches(group,data){
  const matches=mergedMatches(data).filter(match=>matchGroup(match,group)).sort((a,b)=>{
    const weight={in_progress:0,assigned:1,pending:2,completed:3};
    return (weight[String(a.status)]??9)-(weight[String(b.status)]??9)||num(a.id)-num(b.id);
  });
  if(!matches.length) return `<p class="muted">Ingen kamper i gruppen ennå.</p>`;
  return `<div class="tdx-group-matches">${matches.map(match=>`<button type="button" class="tdx-group-match" data-match-id="${num(match.id)}"><span>${esc(match.player_a_name||"Spiller A")}</span><strong class="${String(match.status)==="in_progress"?"tdx-group-live":""}">${esc(score(match))}</strong><span>${esc(match.player_b_name||"Spiller B")}</span><small>${esc(match.round_label||match.bracket_label||group.name||"Gruppespill")}${match.board_number?` · Skive ${num(match.board_number)}`:""}<span class="tdx-match-chevron">›</span></small></button>`).join("")}</div>`;
}
function showMatchDetail(match,group){
  document.querySelector("dialog.tdx-match-detail")?.remove();
  const modal=document.createElement("dialog"); modal.className="tdx-match-detail";
  const bo=num(match.best_of_legs); const avgA=match.player_a_average??match.player_a_three_dart_average??match.player_a_3da; const avgB=match.player_b_average??match.player_b_three_dart_average??match.player_b_3da;
  modal.innerHTML=`<div class="tdx-match-detail-card"><div class="tdx-match-detail-head"><div><h3>Kampdetaljer</h3><small>${esc(match.round_label||match.bracket_label||group.name||"Gruppespill")}</small></div><button type="button" class="tdx-match-close" aria-label="Lukk">×</button></div><div class="tdx-match-detail-score"><span><b>${esc(match.player_a_name||"Spiller A")}</b></span><strong>${esc(score(match))}</strong><span><b>${esc(match.player_b_name||"Spiller B")}</b></span></div><div class="tdx-match-detail-meta"><div><span>Status</span><b>${esc(statusLabel(match))}</b></div>${bo?`<div><span>Format</span><b>Best av ${bo}</b></div>`:""}${match.board_number?`<div><span>Skive</span><b>${num(match.board_number)}</b></div>`:""}${avgA||avgB?`<div><span>3-dart average</span><b>${avg(avgA)} · ${avg(avgB)}</b></div>`:""}</div></div>`;
  document.body.appendChild(modal); modal.querySelector(".tdx-match-close")?.addEventListener("click",()=>modal.close()); modal.addEventListener("click",e=>{if(e.target===modal)modal.close();}); modal.addEventListener("close",()=>modal.remove(),{once:true}); modal.showModal();
}

async function openGroups(id,button){
  const dialog=document.querySelector("dialog.tdx-detail");
  const content=dialog?.querySelector(".tdx-content");
  const tabs=dialog?.querySelector(".tdx-detail-tabs");
  if(!dialog||!content||!tabs) return;
  tabs.querySelectorAll("button").forEach(node=>node.classList.toggle("active",node===button));
  content.querySelectorAll(":scope > .tdx-section,:scope > .tdx-groups-panel,:scope > .tdx-inline-admin").forEach(node=>node.remove());
  const panel=document.createElement("div"); panel.className="tdx-groups-panel"; panel.innerHTML=`<div class="tdx-section"><p class="muted">Henter grupper …</p></div>`; content.appendChild(panel);
  try{
    const data=await load(id);
    const groups=data.groups.length?data.groups:data.tables;
    if(!groups.length){ panel.innerHTML=`<div class="tdx-section"><h3>Grupper</h3><p class="muted">Gruppene er ikke trukket ennå.</p></div>`; return; }
    let selected=num(groups[0]?.id);
    const render=()=>{
      const group=groups.find(item=>num(item.id)===selected)||groups[0]; selected=num(group.id);
      const allMatches=mergedMatches(data); const groupMatches=allMatches.filter(match=>matchGroup(match,group));
      const done=groupMatches.length>0&&groupMatches.every(match=>String(match.status)==="completed");
      panel.innerHTML=`<div class="tdx-group-picker">${groups.map(item=>`<button type="button" class="${num(item.id)===selected?"active":""}" data-group-id="${num(item.id)}">${esc(item.name||`Gruppe ${num(item.sort_order)||""}`)}</button>`).join("")}</div><div class="tdx-section"><div class="tdx-group-head"><div><h3>${esc(group.name||"Gruppe")}</h3><p>${done?"Ferdig":groupMatches.some(match=>String(match.status)==="in_progress")?"Pågår nå":"Gruppespill"}</p></div><span class="tdx-pill">${(tableFor(data,group)?.rows||group.players||[]).length} spillere</span></div>${renderTable(group,data)}</div><div class="tdx-section"><div class="tdx-group-head"><div><h3>Kamper i ${esc(group.name||"gruppen")}</h3><p>Trykk på en kamp for detaljer.</p></div></div>${renderMatches(group,data)}</div>`;
      panel.querySelectorAll("[data-group-id]").forEach(node=>node.addEventListener("click",()=>{selected=num(node.dataset.groupId);render();}));
      panel.querySelectorAll("[data-match-id]").forEach(node=>node.addEventListener("click",()=>{const match=allMatches.find(item=>num(item.id)===num(node.dataset.matchId));if(match)showMatchDetail(match,group);}));
    };
    render();
  }catch(error){ panel.innerHTML=`<div class="tdx-section"><h3>Grupper</h3><p class="muted">${esc(error.message)}</p></div>`; }
}

const observer=new MutationObserver(schedule); observer.observe(document.body,{subtree:true,childList:true});