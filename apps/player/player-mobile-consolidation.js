function hideClubSwitcher(){
  const wrap=document.querySelector(".portal-context");
  if(!wrap)return;
  wrap.classList.add("hidden");
  wrap.setAttribute("aria-hidden","true");
  wrap.style.setProperty("display","none","important");
}

function addStyles(){
  if(!document.getElementById("playerMobileConsolidationStyles")){
    const s=document.createElement("style");
    s.id="playerMobileConsolidationStyles";
    s.textContent=`.portal-context{display:none!important}`;
    document.head.appendChild(s);
  }
  if(!document.getElementById("playerPortalSectionChrome")){
    const link=document.createElement("link");
    link.id="playerPortalSectionChrome";
    link.rel="stylesheet";
    link.href=new URL("./portal-section-chrome.css?v=20260831-0820",import.meta.url).href;
    document.head.appendChild(link);
  }
}

addStyles();
hideClubSwitcher();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",hideClubSwitcher,{once:true});
window.addEventListener("bd:portal-view",hideClubSwitcher);
document.getElementById("clubSelect")?.addEventListener("change",hideClubSwitcher);
window.addEventListener("bd:player-state-changed",hideClubSwitcher);

import("./remove-checkout-percentage.js?v=20260830-1835")
  .then(()=>import("./tournament-discovery-ux.js?v=20260831-1004b"))
  .then(()=>import("./tournament-calendar-polish.js?v=20260829-1945"))
  .then(()=>import("./tournament-prestart-detail.js?v=20260831-0905"))
  .then(()=>import("./tournament-groups-detail.js?v=20260831-1025"))
  .then(()=>import("./shared-match-card-adapter.js?v=20260831-1004b"))
  .then(()=>import("./tournament-compact-match-links.js?v=20260830-2335"))
  .then(()=>import("./tournament-inline-admin.js?v=20260830-0715"))
  .then(()=>import("./tournament-finished-participants-polish.js?v=20260829-2326"))
  .then(()=>import("./tournament-detail-desktop-ux.js?v=20260831-1040"));