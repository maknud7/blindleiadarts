const polishStyle = document.createElement("style");
polishStyle.id = "tournamentCalendarPolishStyles";
polishStyle.textContent = `
  .tdx-root .tdx-tabs{background:#edf2f7!important;gap:5px!important;padding:5px!important}
  .tdx-root .tdx-tabs button{background:transparent!important;color:#61758b!important;border:0!important;box-shadow:none!important}
  .tdx-root .tdx-tabs button.active{background:#fff!important;color:#1767d8!important;box-shadow:0 2px 8px rgba(11,43,80,.10)!important}
  .tdx-root .tdx-next{background:linear-gradient(135deg,#eaf4ff,#f7fbff)!important;border:1px solid #bcd5f3!important;color:#0b2b50!important;box-shadow:0 8px 22px rgba(28,93,170,.10)!important}
  .tdx-root .tdx-next .tdx-kicker{color:#1767d8!important}
  .tdx-root .tdx-next h3{color:#0b2b50!important}
  .tdx-root .tdx-next .tdx-meta{color:#5f7893!important}
  .tdx-root .tdx-list{background:transparent!important;border:0!important;border-radius:0!important;overflow:visible!important;display:grid!important;gap:10px!important}
  .tdx-root .tdx-row{background:#fff!important;border:1px solid #dce6ef!important;border-left:4px solid #2f75e8!important;border-radius:16px!important;color:#0b2b50!important;box-shadow:0 4px 14px rgba(11,43,80,.06)!important;min-height:78px!important;padding:14px 14px!important}
  .tdx-root .tdx-row-title{color:#0b2b50!important}
  .tdx-root .tdx-row-sub{color:#667d95!important}
  .tdx-root .tdx-row .tdx-pill,.tdx-root .tdx-next .tdx-pill{background:#eef5ff!important;border:1px solid #c8dcf3!important;color:#174f91!important}
  .tdx-root .tdx-chevron{color:#2f75e8!important}
  @media(max-width:520px){
    .tdx-root{gap:14px!important}
    .tdx-root .tdx-head h2{font-size:29px!important}
    .tdx-root .tdx-tabs button{min-height:46px!important;font-size:14px!important;padding:0 5px!important}
    .tdx-root .tdx-next{padding:15px!important;gap:8px!important}
    .tdx-root .tdx-next h3{font-size:21px!important}
    .tdx-root .tdx-row{min-height:74px!important}
    .tdx-root .tdx-row-title{font-size:17px!important}
    .tdx-root .tdx-row-sub{font-size:13px!important}
    .tdx-root .tdx-pill{padding:6px 9px!important;font-size:12px!important}
  }
`;
document.head.appendChild(polishStyle);

// This is a visual-only enhancement. The personal-vs-club membership filter
// is owned by tournament-discovery-ux.js; do not fetch the entire club calendar
// a second time or infer a player's registrations from public tournament data.
function polishTournamentCalendar(){
  const root=document.querySelector(".tdx-root");
  if(!root) return;
  const period=root.querySelector(".tdx-tabs button.active")?.dataset?.filter||"upcoming";
  const personal=Boolean(root.querySelector('.tdx-scope-tabs [data-calendar-scope="mine"].active'));
  const featured=personal&&period==="upcoming"?root.querySelector(".tdx-next[data-open]"):null;
  const featuredId=featured?Number(featured.dataset.open):0;

  root.querySelectorAll(".tdx-list .tdx-row[data-open]").forEach(row=>{
    const isFeatured=featuredId>0&&Number(row.dataset.open)===featuredId;
    row.hidden=isFeatured;
    row.style.display=isFeatured?"none":"";
  });
}

const calendarRoot=document.querySelector(".tdx-root");
if(calendarRoot){
  // Observe only this component, rather than every mutation on the entire
  // player portal. Rendering replaces root children, so childList is enough.
  const observer=new MutationObserver(polishTournamentCalendar);
  observer.observe(calendarRoot,{childList:true});
}
window.addEventListener("bd:portal-view",event=>{
  if(event.detail?.target==="tournaments") polishTournamentCalendar();
});
window.setTimeout(polishTournamentCalendar,150);
