function playerIdFrom(node){ return Number(node?.getAttribute("data-player-link")||0); }
function openPlayerProfile(playerId){
  if(!playerId) return;
  document.querySelector("dialog.tdx-match-detail")?.close?.();
  document.querySelector("dialog.bd-match-full")?.close?.();
  document.querySelector("dialog.tdx-detail")?.close?.();
  window.location.hash="statistics";
  window.setTimeout(()=>{
    document.querySelector('[data-statistics-view="players"]')?.click();
    window.setTimeout(()=>document.querySelector(`#playerDirectory [data-player-profile="${playerId}"]`)?.click(),120);
  },80);
}

const style=document.createElement("style");
style.textContent=`
.tdx-group-matches{display:grid!important;gap:0!important}
.tdx-group-match-row{box-sizing:border-box;display:grid!important;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;width:100%;min-height:54px;padding:9px 2px;border-top:1px solid #e5edf3;background:#fff;color:#0b2b50;cursor:pointer}
.tdx-group-match-row:first-child{border-top:0}.tdx-group-match-row:active{background:#f4f8fc}.tdx-group-match-row>.tdx-player-link:last-of-type{text-align:right;justify-self:end}.tdx-group-match-row>strong{font-size:14px}.tdx-group-match-row>small{grid-column:1/-1;color:#7b8da0;font-size:11px}
.tdx-player-link{appearance:none!important;-webkit-appearance:none!important;display:inline!important;width:auto!important;min-width:0!important;min-height:0!important;height:auto!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;background-image:none!important;box-shadow:none!important;color:#174f91!important;font:inherit!important;font-weight:800!important;line-height:1.25!important;text-align:left!important;text-decoration:underline;text-decoration-color:#bed1e7;text-underline-offset:3px;cursor:pointer!important}
.tdx-group-name .tdx-player-link{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;color:#0b2b50!important}
.tdx-player-link:hover,.tdx-player-link:active{background:transparent!important;transform:none!important;color:#0b5fc0!important}
@media(max-width:520px){.tdx-group-match-row{min-height:50px;padding:8px 2px;font-size:13px}.tdx-group-match-row>strong{font-size:13px}}
`;
document.head.appendChild(style);

function compactMatches(root=document){
  root.querySelectorAll?.("button.tdx-group-match[data-match-id]").forEach(button=>{
    const row=document.createElement("div");
    row.className="tdx-group-match-row";
    row.dataset.matchId=button.dataset.matchId||"";
    row.setAttribute("role","button"); row.tabIndex=0;
    const children=[...button.children];
    const matchId=button.dataset.matchId;
    const sourceMatch=window.__bdTournamentMatchMap?.get?.(Number(matchId));
    const aId=Number(sourceMatch?.player_a_id||button.dataset.playerAId||0);
    const bId=Number(sourceMatch?.player_b_id||button.dataset.playerBId||0);
    const left=children[0]?.textContent?.trim()||"Spiller A";
    const score=children[1]?.textContent?.trim()||"–";
    const right=children[2]?.textContent?.trim()||"Spiller B";
    const meta=children[3]?.textContent?.trim()||"";
    row.innerHTML=`<button type="button" class="tdx-player-link" data-player-link="${aId}">${left}</button><strong>${score}</strong><button type="button" class="tdx-player-link" data-player-link="${bId}">${right}</button><small>${meta}</small>`;
    button.replaceWith(row);
  });
}

function linkGroupPlayers(root=document){
  root.querySelectorAll?.(".tdx-group-tr:not(.tdx-group-th)").forEach(row=>{
    const name=row.querySelector(".tdx-group-name");
    if(!name||name.querySelector("[data-player-link]")) return;
    const playerId=Number(row.getAttribute("data-player-id")||name.getAttribute("data-player-id")||0);
    if(!playerId) return;
    const mark=name.querySelector(".tdx-qualified-mark")?.outerHTML||"";
    const clean=name.cloneNode(true); clean.querySelector(".tdx-qualified-mark")?.remove();
    name.innerHTML=`<button type="button" class="tdx-player-link" data-player-link="${playerId}">${clean.textContent.trim()}</button>${mark}`;
  });
}

function enhance(){ compactMatches(document); linkGroupPlayers(document); }
const observer=new MutationObserver(()=>window.requestAnimationFrame(enhance)); observer.observe(document.body,{subtree:true,childList:true});
enhance();

document.addEventListener("click",event=>{
  if(!(event.target instanceof Element)) return;
  const player=event.target.closest("[data-player-link]");
  if(player){ event.preventDefault(); event.stopPropagation(); openPlayerProfile(playerIdFrom(player)); return; }
  const row=event.target.closest(".tdx-group-match-row[data-match-id]");
  if(row){ row.dispatchEvent(new CustomEvent("bd:open-match-detail",{bubbles:true,detail:{matchId:Number(row.dataset.matchId||0)}})); }
});
document.addEventListener("keydown",event=>{ if((event.key==="Enter"||event.key===" ")&&event.target instanceof Element&&event.target.matches(".tdx-group-match-row")){event.preventDefault();event.target.click();} });
