const SAC_API_ROOT = "../api/v1";
const sacState = { user: null, clubs: [], installed: false };

function sacToken(){return localStorage.getItem("bd:token")||"";}
function sacEsc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
async function sacApi(path,{method="GET",body}={}){const headers={Authorization:`Bearer ${sacToken()}`};if(body!==undefined)headers["Content-Type"]="application/json";const response=await fetch(`${SAC_API_ROOT}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});const payload=await response.json().catch(()=>null);if(!response.ok||!payload?.ok)throw new Error(payload?.error?.message||`Forespørselen feilet (${response.status})`);return payload.data;}

function sacStyles(){if(document.getElementById("superadminClubStyles"))return;const style=document.createElement("style");style.id="superadminClubStyles";style.textContent=`
  .superadmin-menu-label{grid-column:1/-1;margin-top:7px;padding:7px 8px 2px;color:#6b8290;font-size:11px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}
  .superadmin-clubs{display:grid;gap:14px}.sac-intro{display:flex;justify-content:space-between;gap:16px;align-items:start}.sac-list{display:grid;gap:12px}.sac-card{display:grid;gap:13px;padding:16px;border:1px solid #cfdee7;border-radius:16px;background:#fff}.sac-head{display:flex;justify-content:space-between;gap:12px}.sac-head h3{margin:0}.sac-fields{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:12px}.sac-card label{display:grid;gap:6px;color:#486578;font-size:12px;font-weight:800}.sac-actions{display:flex;justify-content:space-between;gap:12px;align-items:center}.sac-meta{color:#627b8b;font-size:12px}.sac-message{min-height:18px;font-size:13px}.sac-message.good{color:#276546}.sac-message.bad{color:#9c3030}
  @media(max-width:760px){.sac-intro,.sac-actions{flex-direction:column;align-items:stretch}.sac-fields{grid-template-columns:1fr}.sac-card .button{width:100%}}
`;document.head.appendChild(style);}

function sacInstall(){
  if(sacState.installed)return;sacState.installed=true;sacStyles();
  const nav=document.querySelector(".section-nav.portal-menu");const main=document.querySelector("main.main");if(!nav||!main)return;
  const label=document.createElement("span");label.className="superadmin-menu-label";label.textContent="Superadmin";
  const link=document.createElement("a");link.href="#clubs";link.dataset.portalNav="1";link.textContent="Klubber";
  nav.append(label,link);
  const section=document.createElement("section");section.id="clubs";section.dataset.portalSection="clubs";section.className="panel superadmin-clubs";
  section.innerHTML=`<div class="sac-intro"><div><p class="eyebrow">Superadmin</p><h2>Klubber</h2><p class="muted">Administrer klubbens betalingsmodell for turneringer. Gratis overstyrer betalingskravet helt.</p></div><button id="sacRefresh" type="button" class="button secondary">Oppdater</button></div><div class="mini-card"><strong>Betalingsmodell</strong><p class="muted">Blindleia kan stå på <strong>Gratis</strong> mens plattformen bygges. Når en klubb settes til <strong>Stripe</strong>, tar nye turneringer et snapshot av pris og må være betalt før «Start turnering» tillates. Selve Stripe Checkout-integrasjonen kobles til denne statusen.</p></div><div id="sacList" class="sac-list"></div>`;
  main.appendChild(section);
  document.getElementById("sacRefresh")?.addEventListener("click",()=>sacLoad().catch(sacError));
  sacLoad().catch(sacError);
}

function sacRender(){
  const root=document.getElementById("sacList");if(!root)return;
  root.innerHTML=sacState.clubs.length?sacState.clubs.map((c)=>`<article class="sac-card" data-club-id="${Number(c.id)}"><div class="sac-head"><div><h3>${sacEsc(c.name)}</h3><div class="sac-meta">${sacEsc(c.slug||"")} · ${Number(c.tournament_count||0)} turneringer</div></div>${Number(c.unpaid_tournament_count||0)>0?`<span class="pill">${Number(c.unpaid_tournament_count)} ubetalt</span>`:""}</div><div class="sac-fields"><label><span>Turneringsbetaling</span><select data-field="billing_mode"><option value="free" ${c.billing_mode==="free"?"selected":""}>Gratis</option><option value="stripe" ${c.billing_mode==="stripe"?"selected":""}>Stripe</option></select></label><label><span>Pris per turnering (kr)</span><input data-field="fee_nok" type="number" min="0" step="1" value="${(Number(c.tournament_fee_ore||0)/100).toFixed(0)}" ${c.billing_mode!=="stripe"?"disabled":""}></label><label><span>Stripe Customer ID <small>(valgfritt nå)</small></span><input data-field="stripe_customer_id" value="${sacEsc(c.stripe_customer_id||"")}" placeholder="cus_…" ${c.billing_mode!=="stripe"?"disabled":""}></label></div><div class="sac-actions"><div class="sac-message" data-message></div><button type="button" class="button" data-save>Lagre klubb</button></div></article>`).join(""):`<div class="empty">Ingen klubber.</div>`;
  root.querySelectorAll("[data-club-id]").forEach((card)=>{
    const mode=card.querySelector('[data-field="billing_mode"]');mode?.addEventListener("change",()=>{const stripe=mode.value==="stripe";card.querySelector('[data-field="fee_nok"]').disabled=!stripe;card.querySelector('[data-field="stripe_customer_id"]').disabled=!stripe;});
    card.querySelector("[data-save]")?.addEventListener("click",()=>sacSave(card));
  });
}

async function sacLoad(){const data=await sacApi("/superadmin/clubs");sacState.clubs=data.items||[];sacRender();}
async function sacSave(card){const id=Number(card.dataset.clubId||0);const button=card.querySelector("[data-save]");const msg=card.querySelector("[data-message]");button.disabled=true;msg.textContent="Lagrer …";msg.className="sac-message";try{const mode=card.querySelector('[data-field="billing_mode"]').value;const fee=Math.max(0,Math.round(Number(card.querySelector('[data-field="fee_nok"]').value||0)*100));await sacApi(`/superadmin/clubs/${id}`,{method:"PATCH",body:{billing_mode:mode,tournament_fee_ore:mode==="stripe"?fee:0,stripe_customer_id:card.querySelector('[data-field="stripe_customer_id"]').value.trim()||null}});msg.textContent="Lagret.";msg.className="sac-message good";await sacLoad();}catch(error){msg.textContent=error.message;msg.className="sac-message bad";}finally{button.disabled=false;}}
function sacError(error){const root=document.getElementById("sacList");if(root)root.innerHTML=`<div class="message error">${sacEsc(error.message)}</div>`;}

async function sacBoot(){if(!sacToken())return;try{const me=await sacApi("/auth/me");sacState.user=me.user;if(sacState.user?.role==="super_admin")sacInstall();}catch{/* normal for logged-out/non-admin surfaces */}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",sacBoot,{once:true});else sacBoot();
