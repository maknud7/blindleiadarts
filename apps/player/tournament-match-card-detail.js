const MATCH_API_ROOT = "../api/v1";

function mEsc(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function mNum(value){ const n=Number(value); return Number.isFinite(n)?n:null; }
function mVal(value,digits=0){ const n=mNum(value); return n===null?"—":n.toFixed(digits); }
function firstValue(...values){ return values.find(value=>value!==undefined&&value!==null&&value!=="") ?? null; }
async function matchApi(path){ const r=await fetch(`${MATCH_API_ROOT}${path}`,{cache:"no-store"}); const p=await r.json().catch(()=>null); if(!r.ok||!p?.ok) throw new Error(p?.error?.message||`Forespørselen feilet (${r.status})`); return p.data; }

const matchStyle=document.createElement("style");
matchStyle.textContent=`
.tdx-section .tdx-group-match{min-height:0!important;height:auto!important;border-radius:0!important;background:#fff!important;color:#0b2b50!important;box-shadow:none!important;padding:9px 2px!important;font-size:13px!important;font-weight:400!important;line-height:1.25!important}
.tdx-section .tdx-group-match:hover,.tdx-section .tdx-group-match:active{background:#f4f8fc!important;transform:none!important}
.bd-match-full{border:0;padding:0;width:min(94vw,560px);max-width:560px;max-height:88dvh;border-radius:20px;background:#fff;color:#0b2b50;box-shadow:0 24px 70px rgba(5,28,52,.3);overflow:auto}.bd-match-full::backdrop{background:rgba(4,20,38,.5)}
.bd-match-full-card{padding:18px;display:grid;gap:16px}.bd-match-full-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.bd-match-full-head h3{margin:0;font-size:21px}.bd-match-full-head p{margin:3px 0 0;color:#71859a;font-size:12px}.bd-match-full-close{flex:0 0 auto;border:0;border-radius:999px;width:38px;height:38px;background:#edf3f8;color:#0b2b50;font-size:22px}
.bd-match-score{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:10px;padding:16px;background:#f4f7fa;border-radius:16px}.bd-match-score span:last-child{text-align:right}.bd-match-score b{display:block;font-size:16px}.bd-match-score strong{font-size:26px}
.bd-match-statboard{display:grid;border:1px solid #dde6ee;border-radius:16px;overflow:hidden}.bd-match-stat-head,.bd-match-stat-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,.75fr) minmax(0,1fr);gap:8px;align-items:center;text-align:center}.bd-match-stat-head{padding:10px;background:#f4f7fa;font-size:12px}.bd-match-stat-head b:first-child{text-align:left}.bd-match-stat-head b:last-child{text-align:right}.bd-match-stat-row{padding:10px 12px;border-top:1px solid #e7edf2}.bd-match-stat-row strong:first-child{text-align:left}.bd-match-stat-row strong:last-child{text-align:right}.bd-match-stat-row span{color:#73869a;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.bd-match-meta{display:flex;gap:8px;flex-wrap:wrap}.bd-match-meta span{border-radius:999px;background:#edf4fb;color:#526b82;padding:6px 9px;font-size:11px;font-weight:800}.bd-match-note{margin:0;color:#71859a;font-size:12px}.bd-match-legs{display:grid;gap:8px}.bd-match-leg{border:1px solid #e0e8ef;border-radius:12px;padding:10px 12px}.bd-match-leg strong{display:block}.bd-match-leg small{color:#71859a}
`;
document.head.appendChild(matchStyle);

function eloValue(stats,match,side){
  const direct=firstValue(stats?.elo_after,stats?.elo_rating,stats?.elo,match?.[`${side}_elo_after`],match?.[`${side}_elo`],match?.[`${side}_rating_after`]);
  const before=firstValue(stats?.elo_before,match?.[`${side}_elo_before`],match?.[`${side}_rating_before`]);
  const change=firstValue(stats?.elo_change,match?.[`${side}_elo_change`],match?.[`${side}_rating_change`]);
  if(direct!==null){ const n=mNum(direct); const c=mNum(change); return `${n===null?mEsc(direct):Math.round(n)}${c===null?"":` (${c>0?"+":""}${Math.round(c)})`}`; }
  if(before!==null&&change!==null){ const b=mNum(before),c=mNum(change); if(b!==null&&c!==null) return `${Math.round(b+c)} (${c>0?"+":""}${Math.round(c)})`; }
  return "—";
}
function statRow(label,a,b){ return `<div class="bd-match-stat-row"><strong>${mEsc(a)}</strong><span>${mEsc(label)}</span><strong>${mEsc(b)}</strong></div>`; }
function fullScore(match,a,b){ const al=firstValue(a?.legs_won,match?.player_a_legs,match?.player_a_score); const bl=firstValue(b?.legs_won,match?.player_b_legs,match?.player_b_score); return al!==null&&bl!==null?`${mVal(al)}–${mVal(bl)}`:String(match?.status)==="in_progress"?"LIVE":"–"; }

async function openCompleteMatch(matchId,fallback={}){
  document.querySelector("dialog.bd-match-full")?.remove();
  const dialog=document.createElement("dialog"); dialog.className="bd-match-full"; dialog.innerHTML=`<div class="bd-match-full-card"><div class="bd-match-full-head"><div><h3>Kampdetaljer</h3><p>Henter komplett kampkort …</p></div><button class="bd-match-full-close" type="button">×</button></div></div>`; document.body.appendChild(dialog); dialog.querySelector(".bd-match-full-close")?.addEventListener("click",()=>dialog.close()); dialog.addEventListener("click",e=>{if(e.target===dialog)dialog.close();}); dialog.addEventListener("close",()=>dialog.remove(),{once:true}); dialog.showModal();
  try{
    const data=await matchApi(`/matches/${matchId}/detail`);
    const match={...fallback,...(data?.match||{})}; const a=data?.player_a_stats||{}; const b=data?.player_b_stats||{};
    const nameA=match.player_a_name||"Spiller A", nameB=match.player_b_name||"Spiller B";
    const checkoutA=firstValue(a.highest_checkout,a.high_checkout,match.player_a_highest_checkout); const checkoutB=firstValue(b.highest_checkout,b.high_checkout,match.player_b_highest_checkout);
    const legs=Array.isArray(data?.legs)?data.legs:[];
    dialog.innerHTML=`<div class="bd-match-full-card"><div class="bd-match-full-head"><div><h3>Kampdetaljer</h3><p>${mEsc(match.round_label||match.bracket_label||match.group_name||"Kamp")}</p></div><button class="bd-match-full-close" type="button">×</button></div><div class="bd-match-score"><span><b>${mEsc(nameA)}</b></span><strong>${mEsc(fullScore(match,a,b))}</strong><span><b>${mEsc(nameB)}</b></span></div><div class="bd-match-meta">${match.best_of_legs?`<span>Best av ${mVal(match.best_of_legs)}</span>`:""}${match.board_number?`<span>Skive ${mVal(match.board_number)}</span>`:""}<span>${mEsc(({completed:"Ferdig",in_progress:"Pågår",assigned:"Tildelt",pending:"Ikke startet"})[String(match.status||"")]||String(match.status||""))}</span></div><div class="bd-match-statboard"><div class="bd-match-stat-head"><b>${mEsc(nameA)}</b><span></span><b>${mEsc(nameB)}</b></div>${statRow("ELO",eloValue(a,match,"player_a"),eloValue(b,match,"player_b"))}${statRow("3DA",mVal(firstValue(a.average,a.three_dart_average),2),mVal(firstValue(b.average,b.three_dart_average),2))}${statRow("First 9",mVal(a.first_nine_average,2),mVal(b.first_nine_average,2))}${statRow("Høy checkout",mVal(checkoutA),mVal(checkoutB))}${statRow("100+",mVal(a.score_100_plus),mVal(b.score_100_plus))}${statRow("140+",mVal(a.score_140_plus),mVal(b.score_140_plus))}${statRow("180",mVal(a.score_180),mVal(b.score_180))}</div>${legs.length?`<div class="bd-match-legs"><strong>Legs</strong>${legs.map(leg=>`<div class="bd-match-leg"><strong>Leg ${mVal(leg.leg_number)} · ${mEsc(leg.winner_name||((Number(leg.winner_player_id)===Number(match.player_a_id))?nameA:(Number(leg.winner_player_id)===Number(match.player_b_id))?nameB:"—"))}</strong><small>3DA ${mVal(leg.player_a_average,2)} · ${mVal(leg.player_b_average,2)}</small></div>`).join("")}</div>`:""}<p class="bd-match-note">Checkout-prosent vises ikke. «Høy checkout» er høyeste vinnende checkout i kampen.</p></div>`;
    dialog.querySelector(".bd-match-full-close")?.addEventListener("click",()=>dialog.close());
  }catch(error){ dialog.querySelector(".bd-match-full-card").innerHTML=`<div class="bd-match-full-head"><div><h3>Kunne ikke hente kampdetaljer</h3><p>${mEsc(error.message)}</p></div><button class="bd-match-full-close" type="button">×</button></div>`; dialog.querySelector(".bd-match-full-close")?.addEventListener("click",()=>dialog.close()); }
}

document.addEventListener("click",event=>{
  if(!(event.target instanceof Element)) return;
  const node=event.target.closest("[data-match-id],[data-hub-match]");
  if(!node) return;
  const id=Number(node.getAttribute("data-match-id")||node.getAttribute("data-hub-match")||0);
  if(!id) return;
  event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  const fallback={player_a_name:node.querySelector("span:first-child")?.textContent?.trim()||undefined,player_b_name:node.querySelector("span:nth-child(3)")?.textContent?.trim()||undefined};
  openCompleteMatch(id,fallback);
},true);
