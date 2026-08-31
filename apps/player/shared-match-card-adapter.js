import { openSharedMatchCard } from "../../packages/ui-assets/match-detail-card.js?v=20260831-1008";

function openPlayerProfile(playerId){
  const id=Number(playerId||0);
  if(!id) return;
  document.querySelector("dialog.bd-shared-match-dialog")?.close();
  document.querySelector("dialog.tdx-detail")?.close();
  localStorage.setItem("bd:statisticsView","players");
  window.location.hash="#statistics";
  let attempts=0;
  const open=()=>{
    attempts+=1;
    document.querySelector('[data-statistics-view="players"]')?.click();
    const playerCard=document.querySelector(`#playerDirectory [data-player-profile="${id}"]`);
    if(playerCard){
      playerCard.click();
      window.setTimeout(()=>document.getElementById("playerProfile")?.scrollIntoView({behavior:"smooth",block:"start"}),80);
      return;
    }
    if(attempts<12) window.setTimeout(open,120);
  };
  window.setTimeout(open,80);
}

document.addEventListener("bd:open-player-profile",event=>{
  openPlayerProfile(event?.detail?.playerId);
});

document.addEventListener("click",event=>{
  if(!(event.target instanceof Element)) return;
  if(event.target.closest("[data-player-match],[data-player-link],[data-shared-player-id]")) return;
  const trigger=event.target.closest("[data-match-detail],[data-match-id],[data-hub-match],[data-compact-match-id]");
  if(!trigger) return;
  const id=Number(trigger.getAttribute("data-match-detail")||trigger.getAttribute("data-match-id")||trigger.getAttribute("data-hub-match")||trigger.getAttribute("data-compact-match-id")||0);
  if(!id) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openSharedMatchCard(id);
},true);