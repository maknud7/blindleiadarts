const STYLE_ID = "bdUserGuideAccessStyles";

function closeMobileDrawer() {
  document.body.classList.remove("unified-mobile-drawer-open");
  const overlay = document.getElementById("unifiedMobileDrawerOverlay");
  if (overlay) overlay.hidden = true;
  const more = document.getElementById("unifiedMobileMore");
  if (more) {
    more.setAttribute("aria-expanded", "false");
    more.classList.remove("active");
  }
  const nav = document.querySelector(".portal-menu");
  if (nav && window.matchMedia("(max-width: 760px)").matches) {
    nav.setAttribute("aria-hidden", "true");
    if ("inert" in nav) nav.inert = true;
  }
}

function openGuide() {
  closeMobileDrawer();
  window.BlindleiaUserGuide?.open?.();
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .bd-guide-open{
      border:1px solid rgba(47,111,237,.24)!important;
      background:#edf4ff!important;
      color:#174f91!important;
      font-weight:800!important;
      opacity:1!important;
    }
    .bd-guide-open::before{
      opacity:1!important;
      background:rgba(255,255,255,.7)!important;
    }
    .bd-guide-open:hover,.bd-guide-open:focus-visible{
      border-color:rgba(47,111,237,.38)!important;
      background:#e3eeff!important;
      color:#123f77!important;
    }
    .bd-guide-mobile-open{display:none!important}

    @media(min-width:981px){
      .portal-menu .bd-guide-open{
        margin-top:8px!important;
        border-color:rgba(255,255,255,.18)!important;
        background:rgba(255,255,255,.08)!important;
        color:#eef6ff!important;
      }
      .portal-menu .bd-guide-open::before{background:rgba(255,255,255,.08)!important}
      .portal-menu .bd-guide-open:hover,.portal-menu .bd-guide-open:focus-visible{
        border-color:rgba(255,255,255,.28)!important;
        background:rgba(255,255,255,.14)!important;
        color:#fff!important;
      }
    }

    @media(min-width:761px) and (max-width:980px){
      .portal-menu .bd-guide-open{
        min-height:44px!important;
        justify-content:center!important;
        text-align:center!important;
      }
    }

    @media(max-width:760px){
      .portal-menu .bd-guide-open{
        min-height:46px!important;
        margin-top:6px!important;
        padding:11px 13px!important;
        border-color:rgba(255,255,255,.18)!important;
        background:rgba(255,255,255,.08)!important;
        color:#eef6ff!important;
        font-size:14px!important;
      }
      .portal-menu .bd-guide-open::before{background:rgba(255,255,255,.08)!important}
      .portal-menu .bd-guide-open:hover,.portal-menu .bd-guide-open:focus-visible{
        border-color:rgba(255,255,255,.28)!important;
        background:rgba(255,255,255,.14)!important;
        color:#fff!important;
      }
      .unified-mobile-bottom-nav:has(.bd-guide-mobile-open){
        grid-template-columns:repeat(5,minmax(0,1fr))!important;
      }
      .unified-mobile-bottom-nav .bd-guide-mobile-open{
        display:flex!important;
      }
      .bd-guide-mobile-icon{
        width:24px;
        height:24px;
        display:grid;
        place-items:center;
        border:2px solid currentColor;
        border-radius:50%;
        font-size:14px;
        font-weight:900;
        line-height:1;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureMobileButton() {
  const bottom = document.getElementById("unifiedMobileBottomNav");
  if (!bottom) return;
  let button = document.getElementById("bdGuideMobileOpen");
  if (!button) {
    button = document.createElement("button");
    button.id = "bdGuideMobileOpen";
    button.className = "bd-guide-mobile-open";
    button.type = "button";
    button.setAttribute("aria-label", "Åpne brukerguide");
    button.innerHTML = `<span class="bd-guide-mobile-icon" aria-hidden="true">?</span><span>Guide</span>`;
    button.addEventListener("click", openGuide);
  }
  const more = document.getElementById("unifiedMobileMore");
  if (more && button.nextElementSibling !== more) bottom.insertBefore(button, more);
  else if (!button.isConnected) bottom.appendChild(button);
}

function refresh() {
  ensureStyles();
  ensureMobileButton();
}

const observer = new MutationObserver(refresh);
observer.observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
else refresh();
