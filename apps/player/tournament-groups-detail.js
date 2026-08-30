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
.tdx-detail-tabs{grid-template-columns:repeat(4,minmax(0,1fr))!important;min-width:0}
.tdx-detail-tabs button{min-width:0}
.tdx-groups-panel{display:grid;gap:14px;min-width:0}
.tdx-group-picker{display:flex;gap:8px;overflow-x:auto;padding:2px 0 4px;scrollbar-width:none}.tdx-group-picker::-webkit-scrollbar{display:none}
.tdx-group-picker button{flex:0 0 auto;border:1px solid #d4e0eb;border-radius:999px;background:#fff;color:#63788f;padding:9px 14px;font-weight:850}.tdx-group-picker button.active{background:#174f91;border-color:#174f91;color:#fff}
.tdx-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}.tdx-group-head h3{margin:0}.tdx-group-head p{margin:3px 0 0;color:#73869a;font-size:13px}
.tdx-group-table{display:grid;min-width:0}.tdx-group-tr{display:grid;grid-template-columns:28px minmax(0,1fr) 30px 30px 30px 42px 32px;align-items:center;gap:5px;min-height:44px;border-top:1px solid #e8eef3;font-size:13px}.tdx-group-tr:first-child{border-top:0}.tdx-group-tr.is-me{background:#eef5ff;margin:0 -8px;padding:0 8px;border-radius:10px}.tdx-group-tr.is-qualified .tdx-group-pos{color:#176b35}.tdx-group-th{color:#8090a0;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;min-height:30px}.tdx-group-name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#0b2b50;font-weight:800}.tdx-group-pos{font-weight:900;color:#63788f}.tdx-group-stat{text-align:right;color:#435b73}.tdx-group-points{font-weight:900;color:#0b2b50}.tdx-qualified-mark{color:#2d7a45;margin-left:4px}
.tdx-group-legend{display:flex;gap:12px;flex-wrap:wrap;color:#718399;font-size:12px;margin-top:8px}.tdx-group-legend strong{color:#2d7a45}
.tdx-group-matches{display:grid}.tdx-group-match{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;padding:11px 0;border-top:1px solid #e8eef3}.tdx-group-match:first-child{border-top:0}.tdx-group-match span:first-child{text-align:left}.tdx-group-match span:last-child{text-align:right}.tdx-group-match strong{font-size:15px;color:#0b2b50}.tdx-group-match small{grid-column:1/-1;color:#7a8da0}.tdx-group-live{color:#b22b2b!important}
@media(max-width:520px){.tdx-detail-tabs{display:flex!important;grid-template-columns:none!important;overflow-x:auto;scrollbar-width:none}.tdx-detail-tabs::-webkit-scrollbar{display:none}.tdx-detail-tabs button{flex:1 0 auto;padding-left:12px!important;padding-right:12px!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important}.tdx-group-tr{grid-template-columns:25px minmax(0,1fr) 27px 27px 39px 30px}.tdx-group-tr>*:nth-child(5){display:none}.tdx-group-th>*:nth-child(5){display:none}}
`;
document.head.appendChild(style);

document.addEventListener("click",event=>{ const open=event.target instanceof Element?event.target.closest("[data-open]"):null; if(open){ activeTournamentId=Number(open.getAttribute("data-open")||0); schedule(); } },true);
function schedule(){ clearTimeout(timer); timer=setTimeout(enhance,90); }

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
    button.addEventListener("click",()=>openGroups(activeTournamentId,button));
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
    return `<div class="tdx-group-tr ${playerId===me?"is-me":""} ${qualified?"is-qualified":""}"><span class="tdx-group-pos">${position}</span><span class="tdx-group-name">${esc(row.display_name||row.player_name||"Spiller")}${qualified?`<span class="tdx-qualified-mark">✓</span>`:""}</span><span class="tdx-group-stat">${num(row.played)}</span><span class="tdx-group-stat">${num(row.wins)}</span><span class="tdx-group-stat">${num(row.losses)}</span><span class="tdx-group-stat">${diff>0?"+":""}${diff}</span><span class="tdx-group-stat tdx-group-points">${num(row.points)}</span></div>`;
  }).join("");
  return `<div class="tdx-group-table"><div class="tdx-group-tr tdx-group-th"><span>#</span><span>Spiller</span><span class="tdx-group-stat">K</span><span class="tdx-group-stat">V</span><span class="tdx-group-stat">T</span><span class="tdx-group-stat">+/-</span><span class="tdx-group-stat">P</span></div>${body}</div>${q>0?`<div class="tdx-group-legend"><span><strong>✓</strong> Videre til sluttspill</span><span>Ved likt: legdiff → 3DA → innbyrdes</span></div>`:""}`;
}

function score(match){
  const a=match.player_a_legs??match.player_a_score??null;
  const b=match.player_b_legs??match.player_b_score??null;
  if(String(match.status)==="completed"&&a!==null&&b!==null) return `${num(a)}–${num(b)}`;
  if(String(match.status)==="in_progress") return "LIVE";
  return "–";
}
function renderMatches(group,data){
  const matches=mergedMatches(data).filter(match=>matchGroup(match,group)).sort((a,b)=>{
    const weight={in_progress:0,assigned:1,pending:2,completed:3};
    return (weight[String(a.status)]??9)-(weight[String(b.status)]??9)||num(a.id)-num(b.id);
  });
  if(!matches.length) return `<p class="muted">Ingen kamper i gruppen ennå.</p>`;
  return `<div class="tdx-group-matches">${matches.map(match=>`<div class="tdx-group-match"><span>${esc(match.player_a_name||"Spiller A")}</span><strong class="${String(match.status)==="in_progress"?"tdx-group-live":""}">${esc(score(match))}</strong><span>${esc(match.player_b_name||"Spiller B")}</span><small>${esc(match.round_label||match.bracket_label||group.name||"Gruppespill")}${match.board_number?` · Skive ${num(match.board_number)}`:""}</small></div>`).join("")}</div>`;
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
      const groupMatches=mergedMatches(data).filter(match=>matchGroup(match,group));
      const done=groupMatches.length>0&&groupMatches.every(match=>String(match.status)==="completed");
      panel.innerHTML=`<div class="tdx-group-picker">${groups.map(item=>`<button type="button" class="${num(item.id)===selected?"active":""}" data-group-id="${num(item.id)}">${esc(item.name||`Gruppe ${num(item.sort_order)||""}`)}</button>`).join("")}</div><div class="tdx-section"><div class="tdx-group-head"><div><h3>${esc(group.name||"Gruppe")}</h3><p>${done?"Ferdig":groupMatches.some(match=>String(match.status)==="in_progress")?"Pågår nå":"Gruppespill"}</p></div><span class="tdx-pill">${(tableFor(data,group)?.rows||group.players||[]).length} spillere</span></div>${renderTable(group,data)}</div><div class="tdx-section"><div class="tdx-group-head"><div><h3>Kamper i ${esc(group.name||"gruppen")}</h3><p>Pågående først, deretter kommende og ferdige.</p></div></div>${renderMatches(group,data)}</div>`;
      panel.querySelectorAll("[data-group-id]").forEach(node=>node.addEventListener("click",()=>{selected=num(node.dataset.groupId);render();}));
    };
    render();
  }catch(error){ panel.innerHTML=`<div class="tdx-section"><h3>Grupper</h3><p class="muted">${esc(error.message)}</p></div>`; }
}

const observer=new MutationObserver(schedule); observer.observe(document.body,{subtree:true,childList:true});
