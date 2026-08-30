function hideClubSwitcher(){
  const wrap=document.querySelector(".portal-context");
  if(!wrap)return;
  wrap.classList.add("hidden");
  wrap.setAttribute("aria-hidden","true");
  wrap.style.setProperty("display","none","important");
}

function addStyles(){
  if(document.getElementById("playerMobileConsolidationStyles"))return;
  const s=document.createElement("style");
  s.id="playerMobileConsolidationStyles";
  s.textContent=`.portal-context{display:none!important}`;
  document.head.appendChild(s);
}

addStyles();
hideClubSwitcher();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",hideClubSwitcher,{once:true});
window.addEventListener("bd:portal-view",hideClubSwitcher);
document.getElementById("clubSelect")?.addEventListener("change",hideClubSwitcher);
window.addEventListener("bd:player-state-changed",hideClubSwitcher);

import("./remove-checkout-percentage.js?v=20260830-1835")
  .then(()=>import("./tournament-discovery-ux.js?v=20260830-1818"))
  .then(()=>import("./tournament-calendar-polish.js?v=20260829-1945"))
  .then(()=>import("./tournament-prestart-detail.js?v=20260829-2055"))
  .then(()=>import("./tournament-groups-detail.js?v=20260830-2315"))
  .then(()=>import("./tournament-match-card-detail.js?v=20260830-2315"))
  .then(()=>import("./tournament-inline-admin.js?v=20260830-0715"))
  .then(()=>import("./tournament-finished-participants-polish.js?v=20260829-2326"));