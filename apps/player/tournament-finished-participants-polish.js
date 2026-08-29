let timer=null;

function schedule(){
  clearTimeout(timer);
  timer=setTimeout(polish,60);
}

function polish(){
  const dialog=document.querySelector("dialog.tdx-detail");
  if(!dialog?.open)return;

  const finished=[...dialog.querySelectorAll(".tdx-status-row .tdx-pill")]
    .some(el=>String(el.textContent||"").trim()==="Ferdig");
  if(!finished)return;

  const playersActive=!!dialog.querySelector('[data-tab="players"].active');
  if(!playersActive)return;

  dialog.querySelectorAll(".tdx-person > small").forEach(el=>el.remove());
}

const observer=new MutationObserver(schedule);
observer.observe(document.body,{subtree:true,childList:true});
document.addEventListener("click",schedule,true);
