const DESKTOP_QUERY="(min-width:981px)";
const managedSelector="dialog.tdx-detail,dialog.bd-shared-match-dialog";
const nativeShowModal=HTMLDialogElement.prototype.showModal;
const nativeShow=HTMLDialogElement.prototype.show;

function desktop(){return window.matchMedia(DESKTOP_QUERY).matches;}
function managed(dialog){return dialog?.matches?.(managedSelector);}
function openManaged(){return [...document.querySelectorAll(managedSelector)].filter(dialog=>dialog.open);}

function ensureStyle(){
  if(document.getElementById("tdxDesktopNavFailsafeStyle"))return;
  const style=document.createElement("style");
  style.id="tdxDesktopNavFailsafeStyle";
  style.textContent=`
  .tdx-desktop-shade{display:none}
  @media(min-width:981px){
    .tdx-desktop-shade{position:fixed;inset:0 0 0 var(--unified-rail,230px);z-index:95;background:rgba(7,26,48,.42);backdrop-filter:blur(2px)}
    .tdx-desktop-shade.is-open{display:block}
    body[data-portal-default="home"] .portal-nav.portal-menu{z-index:140!important}
    dialog.tdx-detail.tdx-desktop-nonmodal{
      position:fixed!important;
      top:24px!important;
      left:calc(var(--unified-rail,230px) + (100vw - var(--unified-rail,230px))/2)!important;
      right:auto!important;bottom:auto!important;
      transform:translateX(-50%)!important;
      width:min(1180px,calc(100vw - var(--unified-rail,230px) - 48px))!important;
      max-width:1180px!important;
      height:min(900px,calc(100vh - 48px))!important;
      max-height:calc(100vh - 48px)!important;
      margin:0!important;
      z-index:110!important;
    }
    dialog.bd-shared-match-dialog.tdx-desktop-nonmodal{
      position:fixed!important;
      top:50%!important;
      left:calc(var(--unified-rail,230px) + (100vw - var(--unified-rail,230px))/2)!important;
      right:auto!important;bottom:auto!important;
      transform:translate(-50%,-50%)!important;
      margin:0!important;
      z-index:130!important;
    }
  }`;
  document.head.appendChild(style);
}

function ensureShade(){
  let shade=document.querySelector(".tdx-desktop-shade");
  if(shade)return shade;
  shade=document.createElement("div");
  shade.className="tdx-desktop-shade";
  shade.setAttribute("aria-hidden","true");
  shade.addEventListener("click",()=>{
    const match=document.querySelector("dialog.bd-shared-match-dialog[open]");
    if(match){match.close();return;}
    document.querySelector("dialog.tdx-detail[open]")?.close();
  });
  document.body.appendChild(shade);
  return shade;
}

function syncShade(){
  const shade=ensureShade();
  const anyOpen=desktop()&&openManaged().length>0;
  shade.classList.toggle("is-open",anyOpen);
}

HTMLDialogElement.prototype.showModal=function(...args){
  if(desktop()&&managed(this)){
    this.classList.add("tdx-desktop-nonmodal");
    if(!this.open)nativeShow.call(this,...args);
    this.addEventListener("close",syncShade,{once:true});
    syncShade();
    return;
  }
  this.classList.remove("tdx-desktop-nonmodal");
  return nativeShowModal.call(this,...args);
};

function closeManagedDialogs(){
  openManaged().forEach(dialog=>dialog.close());
  syncShade();
}

ensureStyle();
ensureShade();

document.addEventListener("click",event=>{
  if(!desktop()||!(event.target instanceof Element))return;
  const nav=event.target.closest(".portal-nav.portal-menu a[href],.section-nav.portal-menu a[href]");
  if(nav)closeManagedDialogs();
},true);

window.addEventListener("bd:portal-view",()=>{if(desktop())closeManagedDialogs();});
window.addEventListener("resize",()=>{
  if(!desktop()){
    document.querySelector(".tdx-desktop-shade")?.classList.remove("is-open");
    return;
  }
  syncShade();
});
