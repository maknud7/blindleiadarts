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

// Tournament-specific enhancements are loaded only when the Turneringer view opens.
