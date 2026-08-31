function esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}

const style=document.createElement("style");
style.textContent=`
.tdx-group-matches{display:grid!important;gap:0!important}
.tdx-group-match-row{box-sizing:border-box;display:grid!important;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;width:100%;min-height:46px;padding:7px 2px;border-top:1px solid #e5edf3;background:#fff;color:#0b2b50;cursor:pointer}
.tdx-group-match-row:first-child{border-top:0}.tdx-group-match-row:hover,.tdx-group-match-row:active{background:#f4f8fc}.tdx-group-match-row:focus-visible{outline:3px solid rgba(47,117,232,.25);outline-offset:2px;border-radius:8px}.tdx-group-match-row>strong{font-size:13px}.tdx-group-match-row>small{grid-column:1/-1;color:#7b8da0;font-size:10px;margin-top:-2px}.tdx-group-match-player{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#174f91;font-weight:800}.tdx-group-match-player:last-of-type{text-align:right;justify-self:stretch}
@media(max-width:520px){.tdx-group-match-row{min-height:44px;padding:6px 2px;font-size:12px}.tdx-group-match-row>strong{font-size:12px}}
`;
document.head.appendChild(style);

function compactMatches(root=document){
  root.querySelectorAll?.("button.tdx-group-match[data-match-id]").forEach(button=>{
    const row=document.createElement("div");
    row.className="tdx-group-match-row";
    row.dataset.compactMatchId=button.dataset.matchId||"";
    row.setAttribute("role","button");
    row.setAttribute("aria-label","Åpne kampkort");
    row.tabIndex=0;
    const children=[...button.children];
    const left=children[0]?.textContent?.trim()||"Spiller A";
    const score=children[1]?.textContent?.trim()||"–";
    const right=children[2]?.textContent?.trim()||"Spiller B";
    const meta=children[3]?.textContent?.trim()||"";
    row.innerHTML=`<span class="tdx-group-match-player">${esc(left)}</span><strong>${esc(score)}</strong><span class="tdx-group-match-player">${esc(right)}</span><small>${esc(meta)}</small>`;
    button.replaceWith(row);
  });
}

function enhance(){compactMatches(document);}
const observer=new MutationObserver(()=>window.requestAnimationFrame(enhance));
observer.observe(document.body,{subtree:true,childList:true});
enhance();

document.addEventListener("keydown",event=>{
  if((event.key!=="Enter"&&event.key!==" ")||!(event.target instanceof Element)) return;
  const row=event.target.closest(".tdx-group-match-row[data-compact-match-id]");
  if(!row) return;
  event.preventDefault();
  row.click();
});
