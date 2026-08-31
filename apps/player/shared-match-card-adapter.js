import { openSharedMatchCard } from "../../packages/ui-assets/match-detail-card.js?v=20260831-0740";

document.addEventListener("click",event=>{
  if(!(event.target instanceof Element)) return;
  if(event.target.closest("[data-player-match],[data-player-link]")) return;
  const trigger=event.target.closest("[data-match-detail],[data-match-id],[data-hub-match],[data-compact-match-id]");
  if(!trigger) return;
  const id=Number(trigger.getAttribute("data-match-detail")||trigger.getAttribute("data-match-id")||trigger.getAttribute("data-hub-match")||trigger.getAttribute("data-compact-match-id")||0);
  if(!id) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openSharedMatchCard(id);
},true);
