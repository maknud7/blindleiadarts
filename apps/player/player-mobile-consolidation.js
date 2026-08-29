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
