const API_ROOT = "../api/v1";

function esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function n(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}
function val(value,digits=0){const parsed=n(value);return parsed===null?"—":parsed.toFixed(digits);}
function first(...values){return values.find(value=>value!==undefined&&value!==null&&value!=="")??null;}
async function api(path){const r=await fetch(`${API_ROOT}${path}`,{cache:"no-store"});const p=await r.json().catch(()=>null);if(!r.ok||!p?.ok)throw new Error(p?.error?.message||`Forespørselen feilet (${r.status})`);return p.data;}

function ensureStyles(){
  if(document.getElementById("bd-shared-match-card-style"))return;
  const s=document.createElement("style");s.id="bd-shared-match-card-style";s.textContent=`
.bd-shared-match-dialog{width:min(720px,calc(100vw - 18px));max-height:92dvh;border:0;border-radius:22px;padding:0;overflow:hidden;background:#fff;color:#0b2b50;box-shadow:0 28px 80px rgba(8,29,54,.34)}.bd-shared-match-dialog::backdrop{background:rgba(8,29,54,.52);backdrop-filter:blur(2px)}
.bd-shared-match-content{max-height:92dvh;padding:20px 18px 24px;overflow:auto}.bd-shared-match-head{position:relative;padding-right:52px;margin-bottom:16px}.bd-shared-match-head h2{font-size:clamp(1.35rem,4vw,1.9rem);line-height:1.08;margin:4px 0 7px}.bd-shared-match-head p{margin:0;color:#71849a;font-size:.82rem}.bd-shared-match-close{position:absolute;right:0;top:0;width:40px!important;height:40px!important;padding:0!important;border-radius:50%!important;border:1px solid #d7e1ec!important;background:#fff!important;color:#5f738c!important;box-shadow:none!important;font-size:1.45rem!important}
.bd-shared-match-elo{margin:0 0 14px;border:1px solid #d9e5f2;border-radius:14px;padding:12px;background:#f8fbff}.bd-shared-match-elo-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bd-shared-match-elo-player{padding:9px 10px;border:1px solid #e1e9f2;border-radius:10px;background:#fff}.bd-shared-match-elo-player small{display:block;color:#70839a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bd-shared-match-elo-player strong{font-size:1rem}.bd-shared-match-elo-player em{font-style:normal;font-size:.75rem;font-weight:850;margin-left:5px}.bd-shared-match-elo-player em.up{color:#087a4b}.bd-shared-match-elo-player em.down{color:#b4232e}
.bd-shared-match-board{border:1px solid #d9e3ee;border-radius:16px;overflow:hidden}.bd-shared-match-names,.bd-shared-match-row{display:grid;grid-template-columns:minmax(0,1fr) 118px minmax(0,1fr);gap:8px;align-items:center;text-align:center}.bd-shared-match-names{padding:10px 12px;background:#f6f9fd}.bd-shared-match-names strong:first-child,.bd-shared-match-row strong:first-child{text-align:left}.bd-shared-match-names strong:last-child,.bd-shared-match-row strong:last-child{text-align:right}.bd-shared-player-link{appearance:none!important;-webkit-appearance:none!important;width:auto!important;min-width:0!important;min-height:38px!important;margin:0!important;padding:6px 8px!important;border:0!important;border-radius:9px!important;background:transparent!important;color:#0b2b50!important;box-shadow:none!important;font:inherit!important;font-weight:850!important;text-align:left!important;display:inline-flex!important;align-items:center!important;gap:5px!important;justify-content:flex-start!important;overflow:hidden!important}.bd-shared-player-link:last-child{justify-content:flex-end!important;text-align:right!important}.bd-shared-player-link:hover,.bd-shared-player-link:focus-visible{background:#eaf2fb!important;color:#174f91!important}.bd-shared-player-link span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bd-shared-player-link .bd-shared-player-arrow{flex:0 0 auto;color:#5d7fa5;font-size:1.15rem;line-height:1}.bd-shared-match-row{padding:11px 12px;border-top:1px solid #e7edf2}.bd-shared-match-row span{font-size:.75rem;color:#71849a;font-weight:800}.bd-shared-match-row.primary{background:#f4f8ff}.bd-shared-match-row.primary strong{font-size:1.08rem;color:#123f74}.bd-shared-match-row.checkout{background:#f8fbff}.bd-shared-match-row.checkout span{color:#2f6fed}
.bd-shared-match-meta{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 12px}.bd-shared-match-meta span{border-radius:999px;background:#edf4fb;color:#526b82;padding:6px 9px;font-size:.72rem;font-weight:800}
.bd-shared-match-legs{display:grid;gap:8px;margin-top:16px}.bd-shared-match-leg{border:1px solid #e0e8ef;border-radius:12px;overflow:hidden}.bd-shared-match-leg>button{width:100%;display:flex;justify-content:space-between;gap:10px;padding:11px 12px!important;background:#fff!important;color:#0b2b50!important;border:0!important;border-radius:0!important;box-shadow:none!important;text-align:left!important}.bd-shared-match-leg>button span:last-child{text-align:right;color:#205da7;font-weight:800}.bd-shared-match-visits{padding:5px 12px 10px;background:#fbfcfe}.bd-shared-visit{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:9px;padding:6px 0;border-top:1px solid #edf1f5;font-size:.8rem}.bd-shared-visit:first-child{border-top:0}.bd-shared-visit span:last-child{color:#71849a}
@media(max-width:560px){.bd-shared-match-elo-grid{grid-template-columns:1fr}.bd-shared-match-names,.bd-shared-match-row{grid-template-columns:minmax(0,1fr) 102px minmax(0,1fr)}.bd-shared-match-row{padding:10px 9px}.bd-shared-match-content{padding:17px 14px 22px}}
`;document.head.appendChild(s);
}

async function elo(matchId){
  try{const r=await fetch(`../api/match-elo.php?match_id=${encodeURIComponent(matchId)}`,{cache:"no-store"});const p=await r.json().catch(()=>null);return r.ok&&p?.ok?p.data?.event||null:null;}catch{return null;}
}
function row(label,a,b,digits=0,extra=""){return `<div class="bd-shared-match-row ${extra}"><strong>${val(a,digits)}</strong><span>${esc(label)}</span><strong>${val(b,digits)}</strong></div>`;}
function eloPlayer(name,before,after){const b=n(before),a=n(after),delta=b!==null&&a!==null?a-b:null;return `<div class="bd-shared-match-elo-player"><small>${esc(name)}</small><strong>${a===null?"—":a.toFixed(1)}</strong>${delta===null?"":`<em class="${delta>0?"up":delta<0?"down":""}">${delta>0?"+":""}${delta.toFixed(1)}</em>`}</div>`;}
function playerLink(playerId,name){const id=Number(playerId||0);return `<button type="button" class="bd-shared-player-link" data-shared-player-id="${id}" ${id?"":"disabled"}><span>${esc(name)}</span>${id?'<span class="bd-shared-player-arrow" aria-hidden="true">›</span>':""}</button>`;}
function winningCheckout(match,legs,visits){
  if(!legs.length)return {a:null,b:null};
  const finalLeg=[...legs].sort((x,y)=>Number(x.leg_number||0)-Number(y.leg_number||0)).at(-1);
  const winnerId=Number(finalLeg?.winner_player_id||0);
  if(!winnerId)return {a:null,b:null};
  const legNo=Number(finalLeg.leg_number||0);
  const winningVisit=[...visits].filter(v=>Number(v.leg_number||0)===legNo&&Number(v.player_id||0)===winnerId&&!Number(v.is_bust||0)&&Number(v.remaining_after)===0).sort((x,y)=>Number(x.visit_number||0)-Number(y.visit_number||0)).at(-1);
  const checkout=first(finalLeg?.winning_checkout,winningVisit?.score);
  if(winnerId===Number(match.player_a_id))return {a:checkout,b:null};
  if(winnerId===Number(match.player_b_id))return {a:null,b:checkout};
  return {a:null,b:null};
}
function orderedLegVisits(leg,visits,match){
  const startId=Number(leg?.starting_player_id||0);
  const aId=Number(match?.player_a_id||0),bId=Number(match?.player_b_id||0);
  const otherId=startId===aId?bId:startId===bId?aId:0;
  return [...visits].sort((x,y)=>{
    const xv=Number(x.visit_number||0),yv=Number(y.visit_number||0);
    if(xv!==yv)return xv-yv;
    const xp=Number(x.player_id||0),yp=Number(y.player_id||0);
    if(startId&&xp!==yp){if(xp===startId)return -1;if(yp===startId)return 1;if(otherId&&xp===otherId)return -1;if(otherId&&yp===otherId)return 1;}
    const xc=String(x.created_at||""),yc=String(y.created_at||"");
    if(xc!==yc)return xc.localeCompare(yc);
    return Number(x.id||0)-Number(y.id||0);
  });
}

export async function openSharedMatchCard(matchId){
  const id=Number(matchId||0);if(!id)return;
  ensureStyles();
  let dialog=document.querySelector("dialog.bd-shared-match-dialog");if(!dialog){dialog=document.createElement("dialog");dialog.className="bd-shared-match-dialog";dialog.innerHTML='<div class="bd-shared-match-content"></div>';document.body.appendChild(dialog);dialog.addEventListener("click",e=>{if(e.target===dialog)dialog.close();});}
  const root=dialog.querySelector(".bd-shared-match-content");root.innerHTML='<p class="muted">Henter kamp …</p>';if(!dialog.open)dialog.showModal();
  try{
    const [data,eloEvent]=await Promise.all([api(`/matches/${id}/detail`),elo(id)]);const match=data.match||{},a=data.player_a_stats||{},b=data.player_b_stats||{},legs=Array.isArray(data.legs)?data.legs:[],visits=Array.isArray(data.visits)?data.visits:[];
    const visitsByLeg=new Map();visits.forEach(v=>{const key=Number(v.leg_number||0);if(!visitsByLeg.has(key))visitsByLeg.set(key,[]);visitsByLeg.get(key).push(v);});
    const nameA=match.player_a_name||"Spiller A",nameB=match.player_b_name||"Spiller B";const aLegs=first(a.legs_won,match.player_a_legs,match.player_a_score),bLegs=first(b.legs_won,match.player_b_legs,match.player_b_score);const checkout=winningCheckout(match,legs,visits);
    root.innerHTML=`<div class="bd-shared-match-head"><p>${esc(match.tournament_name||"")}</p><h2>${esc(nameA)} ${val(aLegs)}–${val(bLegs)} ${esc(nameB)}</h2><p>${esc(match.round_label||match.bracket_label||match.group_name||"Kamp")}${match.board_number?` · Skive ${Number(match.board_number)}`:""}</p><button type="button" class="bd-shared-match-close" aria-label="Lukk">×</button></div>
    <div class="bd-shared-match-meta">${match.best_of_legs?`<span>Best av ${Number(match.best_of_legs)}</span>`:""}<span>${esc(({completed:"Ferdig",in_progress:"Pågår",assigned:"Tildelt",pending:"Ikke startet"})[String(match.status||"")]||String(match.status||""))}</span></div>
    <section class="bd-shared-match-elo"><div class="bd-shared-match-elo-grid">${eloPlayer(nameA,eloEvent?.rating_a_before,eloEvent?.rating_a_after)}${eloPlayer(nameB,eloEvent?.rating_b_before,eloEvent?.rating_b_after)}</div></section>
    <div class="bd-shared-match-board"><div class="bd-shared-match-names">${playerLink(match.player_a_id,nameA)}<span></span>${playerLink(match.player_b_id,nameB)}</div>${row("3DA",a.average,b.average,2,"primary")}${row("First 9",a.first_nine_average,b.first_nine_average,2)}${row("Vinnende checkout",checkout.a,checkout.b,0,"checkout")}${row("100+",a.score_100_plus,b.score_100_plus)}${row("140+",a.score_140_plus,b.score_140_plus)}${row("180",a.score_180,b.score_180)}</div>
    <div class="bd-shared-match-legs"><strong>Legs</strong>${legs.length?legs.map(leg=>{const raw=visitsByLeg.get(Number(leg.leg_number))||[];const lv=orderedLegVisits(leg,raw,match);const winner=Number(leg.winner_player_id)===Number(match.player_a_id)?nameA:Number(leg.winner_player_id)===Number(match.player_b_id)?nameB:"—";return `<article class="bd-shared-match-leg"><button type="button" data-shared-leg="${Number(leg.leg_number)}"><span><strong>Leg ${Number(leg.leg_number)}</strong><small>${esc(winner)} vant</small></span><span>3DA ${val(leg.player_a_average,2)} / ${val(leg.player_b_average,2)}</span></button><div class="bd-shared-match-visits hidden" data-shared-visits="${Number(leg.leg_number)}">${lv.length?lv.map(v=>`<div class="bd-shared-visit"><span>${Number(v.player_id)===Number(match.player_a_id)?esc(nameA):esc(nameB)}</span><strong>${Number(v.score)}</strong><span>${v.is_bust?"Bust":`${Number(v.remaining_after)} igjen`}</span></div>`).join(""):'<p class="muted">Ingen kastdetaljer lagret.</p>'}</div></article>`;}).join(""):'<p class="muted">Ingen leg-detaljer lagret.</p>'}</div>`;
    root.querySelector(".bd-shared-match-close")?.addEventListener("click",()=>dialog.close());
    root.querySelectorAll("[data-shared-player-id]").forEach(btn=>btn.addEventListener("click",()=>{const playerId=Number(btn.dataset.sharedPlayerId||0);if(playerId)document.dispatchEvent(new CustomEvent("bd:open-player-profile",{detail:{playerId}}));}));
    root.querySelectorAll("[data-shared-leg]").forEach(btn=>btn.addEventListener("click",()=>root.querySelector(`[data-shared-visits="${btn.dataset.sharedLeg}"]`)?.classList.toggle("hidden")));
  }catch(error){root.innerHTML=`<div class="bd-shared-match-head"><h2>Kunne ikke hente kampen</h2><p>${esc(error.message)}</p><button type="button" class="bd-shared-match-close">×</button></div>`;root.querySelector(".bd-shared-match-close")?.addEventListener("click",()=>dialog.close());}
}

if(!window.BlindleiaMatchCard){window.BlindleiaMatchCard={open:openSharedMatchCard};}