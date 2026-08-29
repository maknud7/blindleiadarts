const ENDPOINT = "../api/member-onboarding.php";
const LINKS_ENDPOINT = "../api/onboarding-links.php";
const REACTIVATE_ENDPOINT = "../api/member-account-reactivate.php";

const panel = document.getElementById("players");
if (panel && !panel.querySelector(".member-access-block")) {
  const MEMBER_UI_VERSION = "20260829-1025";

  const style = document.createElement("style");
  style.textContent = `
    .member-account-intro{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin:8px 0 18px;padding:18px;border:1px solid var(--border,#d9dee7);border-radius:16px;background:var(--surface,#fff)}
    .member-account-intro h3{margin:2px 0 6px}.member-account-intro p{margin:0}.member-account-note{max-width:520px;font-size:.9rem}
    .member-access-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 16px}
    .member-access-summary button{appearance:none;text-align:left;border:1px solid var(--border,#d9dee7);background:var(--surface,#fff);border-radius:14px;padding:14px;cursor:pointer;color:inherit}
    .member-access-summary button:hover{border-color:var(--accent,#2563eb)}.member-access-summary strong{display:block;font-size:1.5rem}.member-access-summary span{font-size:.86rem;color:var(--muted,#667085)}
    .member-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.member-search{flex:1;min-width:220px}.member-search input{width:100%}
    .member-filters{display:flex;gap:6px;flex-wrap:wrap}.member-filters button{border:1px solid var(--border,#d9dee7);background:var(--surface,#fff);border-radius:999px;padding:8px 12px;color:inherit;cursor:pointer}.member-filters button.active{background:var(--text,#111827);color:#fff;border-color:var(--text,#111827)}
    .member-access-table-wrap table{width:100%;border-collapse:collapse}.member-access-table-wrap th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#667085);text-align:left}.member-access-table-wrap td,.member-access-table-wrap th{padding:12px 10px;vertical-align:middle}.member-access-table-wrap tbody tr{border-top:1px solid var(--border,#e5e7eb)}
    .member-person{display:flex;flex-direction:column;gap:2px}.member-person small,.member-account-compact small{color:var(--muted,#667085)}
    .member-status-stack,.member-account-compact{display:flex;flex-direction:column;gap:5px;align-items:flex-start}.member-payment-overview{display:flex;align-items:center;gap:7px}.member-payment-overview small{color:var(--muted,#667085)}
    .member-access-actions{white-space:nowrap}.member-access-level{display:flex;gap:8px;align-items:end;margin-top:4px}.member-access-level label{display:flex;flex-direction:column;gap:3px}.member-access-level label span,.member-access-level.readonly span{font-size:.72rem;color:var(--muted,#667085)}
    .member-access-level.readonly{display:flex;flex-direction:column;align-items:flex-start;gap:1px}.member-access-select{min-width:130px}.member-access-save{padding:7px 9px!important}
    .member-pending{margin:0 0 18px;border:1px solid #f0c36a;border-radius:14px;background:#fff9e8;padding:14px}.member-pending-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.member-pending-head h3{margin:2px 0 4px}.member-pending-list{display:grid;gap:10px;margin-top:10px}.member-pending-card{display:grid;grid-template-columns:minmax(160px,1fr) minmax(220px,1.4fr) auto;gap:10px;align-items:end;background:#fff;border-radius:12px;padding:12px}.member-pending-person{display:flex;flex-direction:column;gap:3px}.member-pending-card label{display:flex;flex-direction:column;gap:4px}
    .member-invite-result{margin:0 0 14px;padding:12px;border-radius:12px}.member-invite-result.good{background:#ecfdf3}.member-invite-result.bad{background:#fef2f2}.member-link-row{display:flex;gap:8px;margin-top:8px}.member-link-row input{flex:1}.member-new-person{margin-top:16px}.member-row-inactive{opacity:.68}
    @media(max-width:760px){.member-account-intro{display:block}.member-account-note{margin-top:8px}.member-access-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.member-access-table-wrap thead{display:none}.member-access-table-wrap table,.member-access-table-wrap tbody,.member-access-table-wrap tr,.member-access-table-wrap td{display:block;width:100%}.member-access-table-wrap tr{padding:12px 0}.member-access-table-wrap td{display:flex;justify-content:space-between;gap:14px;padding:6px 4px}.member-access-table-wrap td:before{content:attr(data-label);font-size:.72rem;text-transform:uppercase;color:var(--muted,#667085);padding-top:2px}.member-access-table-wrap td>*{max-width:72%;text-align:right;align-items:flex-end}.member-access-actions{text-align:right}.member-pending-card{grid-template-columns:1fr}.member-link-row{flex-direction:column}}
  `;
  document.head.appendChild(style);

  const block = document.createElement("div");
  block.className = "member-access-block";
  block.dataset.memberUiVersion = MEMBER_UI_VERSION;
  block.innerHTML = `
    <section class="member-account-intro">
      <div>
        <p class="eyebrow">Medlemsregister</p>
        <h3>Medlemmer, registrering og tilgang</h3>
        <p>Her følger du med på at medlemmer er riktig registrert og har riktig brukerkonto og tilgang.</p>
      </div>
      <p class="member-account-note muted">Betaling vises kun som overordnet status. Detaljert betalingsoppfølging håndteres fortsatt i Blindleia-admin.</p>
    </section>

    <div id="memberAccessSummary" class="member-access-summary"></div>
    <div id="memberInviteResult" class="member-invite-result hidden"></div>
    <div id="memberPendingRegistrations" class="member-pending hidden"></div>

    <div class="member-toolbar">
      <label class="member-search"><span class="sr-only">Søk i medlemmer</span><input id="memberSearch" type="search" placeholder="Søk navn, medlemsnr. eller e-post …" autocomplete="off"></label>
      <div class="member-filters" role="group" aria-label="Filtrer medlemmer">
        <button type="button" data-member-filter="all" class="active">Alle</button>
        <button type="button" data-member-filter="needs">Krever handling</button>
        <button type="button" data-member-filter="inactive">Inaktive</button>
      </div>
      <span id="memberAccessCount" class="pill">—</span>
    </div>

    <div class="table-wrap member-access-table-wrap">
      <table>
        <thead><tr><th>Medlem</th><th>Medlemsstatus</th><th>Betaling</th><th>Konto og tilgang</th><th>Handling</th></tr></thead>
        <tbody id="memberAccessRows"></tbody>
      </table>
    </div>

    <details class="member-new-person">
      <summary>Ny person som ikke finnes i medlemslisten</summary>
      <div>
        <p>Bruk generell registreringslenke bare når personen ikke allerede finnes som medlem/spiller. Har personen spilt tidligere, aktiver riktig medlem i listen over slik at spiller-ID og historikk beholdes.</p>
        <button id="memberOpenInvite" type="button" class="button secondary">Lag registreringslenke for ny person</button>
      </div>
    </details>`;

  const registryStatus = panel.querySelector("#memberRegistryStatus");
  panel.insertBefore(block, registryStatus || panel.firstChild);
  if (registryStatus) registryStatus.classList.add("hidden");

  const el = {
    count: block.querySelector("#memberAccessCount"),
    summary: block.querySelector("#memberAccessSummary"),
    result: block.querySelector("#memberInviteResult"),
    pending: block.querySelector("#memberPendingRegistrations"),
    rows: block.querySelector("#memberAccessRows"),
    search: block.querySelector("#memberSearch"),
    openInvite: block.querySelector("#memberOpenInvite"),
  };

  const state = { token:"", clubId:0, key:"", items:[], pending:[], permissions:{}, loading:false, filter:"all", search:"", linkConfig:null };
  const collator = new Intl.Collator("nb-NO", { sensitivity: "base" });
  const escapeHtml = (value) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

  async function request(action, { method="GET", body } = {}) {
    const url = new URL(ENDPOINT, window.location.href);
    url.searchParams.set("action", action);
    if (method === "GET") url.searchParams.set("club_id", String(state.clubId));
    const response = await fetch(url, { method, headers:{ ...(body !== undefined ? {"Content-Type":"application/json"}:{}), Authorization:`Bearer ${state.token}` }, body:body !== undefined ? JSON.stringify({club_id:state.clubId,...body}) : undefined, cache:"no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function reactivateAccount(memberId) {
    const response = await fetch(new URL(REACTIVATE_ENDPOINT, window.location.href), { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${state.token}`}, body:JSON.stringify({club_id:state.clubId,member_id:memberId}), cache:"no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadLinkConfig() {
    if (state.linkConfig) return state.linkConfig;
    const response = await fetch(new URL(LINKS_ENDPOINT, window.location.href), { cache:"no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Kunne ikke hente adressen for invitasjonslenken.");
    state.linkConfig = payload.data;
    return state.linkConfig;
  }

  function onboardingUrl(baseUrl, token) {
    const base = String(baseUrl || "").trim();
    if (!base) throw new Error("Invitasjonsadressen er ikke konfigurert.");
    const url = new URL("onboarding/", base.endsWith("/") ? base : `${base}/`);
    url.searchParams.set("token", token);
    return url;
  }

  function parseDate(value) { if (!value) return null; const date = new Date(String(value).replace(" ","T")); return Number.isNaN(date.getTime()) ? null : date; }
  function formatDate(value, includeTime=false) { const date=parseDate(value); if(!date)return value?String(value):"—"; return new Intl.DateTimeFormat("nb-NO",includeTime?{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}:{day:"2-digit",month:"2-digit",year:"numeric"}).format(date); }
  function normalizeName(value) { return String(value || "").trim().replace(/\s+/g," ").toLocaleLowerCase("nb"); }

  function accountStage(item) {
    const account = item.account || null;
    if (!account) return "none";
    const status = String(account.status || "unclaimed");
    if (status === "active") return "active";
    if (status === "disabled") return "disabled";
    if (status === "invited") { const expires=parseDate(account.invite_expires_at); if(expires && expires.getTime()>Date.now()) return "invited"; }
    return "needs";
  }

  function stageInfo(stage) {
    switch(stage){case"active":return["Aktiv konto","good"];case"invited":return["Invitasjon sendt","warning"];case"disabled":return["Deaktivert","bad"];case"needs":return["Må aktiveres","warning"];default:return["Ingen konto","neutral"];}
  }

  function isInactiveMember(item) { return item.membership?.is_active_member === false || String(item.membership?.code || "") === "inaktiv"; }

  // Denne arbeidskøen gjelder kun oppgaver Blindleia Darts faktisk skal håndtere.
  // Betalingsoppfølging hører hjemme i Blindleia-admin og påvirker derfor ikke "Krever handling" her.
  function requiresAction(item) { return !isInactiveMember(item) && accountStage(item) !== "active"; }

  function membershipStatus(item) {
    if (isInactiveMember(item)) return {label:"Inaktiv",tone:"neutral"};
    return {label:"Aktiv",tone:"good"};
  }

  function paymentOverview(item) {
    if (isInactiveMember(item)) return {label:"—",tone:"neutral",detail:"Ikke fulgt opp her"};
    const membership = item.membership || {};
    const stripeProblem = Boolean(membership.stripe?.problem);
    const needsFollowUp = Boolean(membership.needs_follow_up);
    const arrears = Number(membership.arrears || 0) > 0.001;
    if (stripeProblem || needsFollowUp || arrears) return {label:"Oppfølging",tone:"warning",detail:"Se Blindleia-admin"};
    if (Boolean(membership.paid_current) || Boolean(membership.stripe?.active)) return {label:"OK",tone:"good",detail:"Ingen handling her"};
    if (!membership.code) return {label:"Uavklart",tone:"neutral",detail:"Se Blindleia-admin"};
    return {label:"Uavklart",tone:"neutral",detail:"Se Blindleia-admin"};
  }

  function accessLabel(level) { switch(String(level||"player")){case"super_admin":return"Superadmin";case"club_admin":return"Klubbadmin";default:return"Medlem";} }

  function accessControlHtml(item, stage) {
    const account=item.account||null;
    if(!account || stage!=="active") return "";
    const level=String(account.access_level||"player");
    const accountId=Number(account.id||0);
    const currentAccountId=Number(state.permissions.current_user_account_id||0);
    const canGrantSuper=Boolean(state.permissions.can_grant_super_admin);
    const canEdit=Boolean(state.permissions.can_manage_roles) && account.can_manage_access!==false && accountId>0 && accountId!==currentAccountId && (level!=="super_admin"||canGrantSuper);
    if(!canEdit){const own=accountId===currentAccountId?" · deg":"";return `<div class="member-access-level readonly"><span>Tilgang</span><strong>${escapeHtml(accessLabel(level))}${own}</strong></div>`;}
    const options=[["player","Medlem"],["club_admin","Klubbadmin"],...(canGrantSuper?[["super_admin","Superadmin"]]:[])];
    return `<div class="member-access-level"><label><span>Tilgang</span><select class="member-access-select" aria-label="Tilgangsnivå for ${escapeHtml(item.member_name)}">${options.map(([value,label])=>`<option value="${value}"${value===level?" selected":""}>${label}</option>`).join("")}</select></label><button type="button" class="button secondary member-access-save" data-account-id="${accountId}">Lagre</button></div>`;
  }

  function accountCell(item, stage) {
    const [label,tone]=stageInfo(stage); const account=item.account||null;
    const email=account?.email ? `<small>${escapeHtml(account.email)}</small>` : "";
    return `<div class="member-account-compact"><span class="badge ${tone}">${escapeHtml(label)}</span>${email}${accessControlHtml(item,stage)}</div>`;
  }

  function actionHtml(item, stage) {
    const account=item.account||null;
    const isOwn=Number(account?.id||0)===Number(state.permissions.current_user_account_id||0);
    const isSuper=String(account?.access_level||"")==="super_admin";
    if(stage==="active"){if(isOwn)return`<small class="muted">Din konto</small>`;if(isSuper)return`<small class="muted">Superadmin</small>`;return`<button type="button" class="button quiet member-disable">Deaktiver konto</button>`;}
    if(stage==="disabled"&&account?.claimed_at&&account?.email)return`<button type="button" class="button secondary member-reactivate">Aktiver igjen</button>`;
    if(stage==="invited")return`<button type="button" class="button secondary member-invite">Ny aktiveringslenke</button>`;
    return`<button type="button" class="button member-invite">Aktiver medlem</button>`;
  }

  function matchesFilter(item) {
    if(state.filter==="inactive"&&!isInactiveMember(item))return false;
    if(state.filter==="needs"&&!requiresAction(item))return false;
    if(!state.search)return true;
    const haystack=`${item.member_name||""} ${item.player?.display_name||""} ${item.membership?.member_number||""} ${item.account?.email||""}`.toLocaleLowerCase("nb");
    return haystack.includes(state.search);
  }

  function sortedVisibleItems() {
    return state.items.filter(matchesFilter).sort((a,b)=>{const action=Number(requiresAction(b))-Number(requiresAction(a));if(action!==0)return action;return collator.compare(a.player?.display_name||a.member_name||"",b.player?.display_name||b.member_name||"");});
  }

  function renderRows() {
    const items=sortedVisibleItems();
    el.count.textContent=`${items.length} av ${state.items.length}`;
    if(!items.length){el.rows.innerHTML=`<tr><td colspan="5"><div class="empty">Ingen medlemmer passer filteret.</div></td></tr>`;return;}
    el.rows.innerHTML=items.map(item=>{
      const stage=accountStage(item); const playerName=item.player?.display_name||item.member_name; const memberNumber=item.membership?.member_number||item.member_number||null; const ms=membershipStatus(item); const pay=paymentOverview(item);
      return `<tr class="${isInactiveMember(item)?"member-row-inactive":""}" data-member-id="${Number(item.member_id)}">
        <td data-label="Medlem"><div class="member-person"><strong>${escapeHtml(playerName)}</strong>${memberNumber?`<small>Medlemsnr. ${escapeHtml(memberNumber)}</small>`:""}</div></td>
        <td data-label="Medlemsstatus"><div class="member-status-stack"><span class="badge ${ms.tone}">${ms.label}</span></div></td>
        <td data-label="Betaling"><div class="member-payment-overview"><span class="badge ${pay.tone}">${pay.label}</span><small>${pay.detail}</small></div></td>
        <td data-label="Konto og tilgang">${accountCell(item,stage)}</td>
        <td data-label="Handling" class="member-access-actions">${actionHtml(item,stage)}</td>
      </tr>`;
    }).join("");
  }

  function memberOptions(registration) {
    const exact=normalizeName(registration.display_name);
    return state.items.filter(item=>accountStage(item)!=="active").map(item=>{const selected=normalizeName(item.member_name)===exact?" selected":"";const [accountLabel]=stageInfo(accountStage(item));return`<option value="${Number(item.member_id)}"${selected}>${escapeHtml(item.member_name)} · ${escapeHtml(accountLabel)}</option>`;}).join("");
  }

  function renderPending() {
    if(!state.pending.length){el.pending.classList.add("hidden");el.pending.innerHTML="";return;}
    el.pending.classList.remove("hidden");
    el.pending.innerHTML=`<div class="member-pending-head"><div><p class="eyebrow">Krever handling</p><h3>Nye registreringer</h3><p>Koble registreringen til riktig eksisterende medlem når personen har spilt før. Da beholdes spiller-ID, ELO og historikk.</p></div><span class="pill">${state.pending.length}</span></div><div class="member-pending-list">${state.pending.map(item=>`<article class="member-pending-card" data-open-invite-id="${Number(item.id)}"><div class="member-pending-person"><span class="badge warning">Ny registrering</span><strong>${escapeHtml(item.display_name)}</strong><small>${escapeHtml(item.email)}</small></div><label><span>Koble til eksisterende medlem</span><select class="member-pending-select"><option value="">Velg medlem …</option>${memberOptions(item)}</select></label><button type="button" class="button member-approve-open">Koble og aktiver</button></article>`).join("")}</div>`;
  }

  function renderSummary() {
    const active=state.items.filter(item=>!isInactiveMember(item)).length;
    const needs=state.items.filter(requiresAction).length;
    const inactive=state.items.filter(isInactiveMember).length;
    const cards=[["all","Aktive medlemmer",active],["needs","Krever handling",needs],["pending","Nye registreringer",state.pending.length],["inactive","Inaktive",inactive]];
    el.summary.innerHTML=cards.map(([filter,label,value])=>`<button type="button" data-summary-filter="${filter}"><strong>${value}</strong><span>${escapeHtml(label)}</span></button>`).join("");
  }

  function dedupeMembers(items){const seen=new Set();return(items||[]).filter(item=>{const id=Number(item?.member_id||0);if(!id||seen.has(id))return false;seen.add(id);return true;});}
  function render(data){state.items=dedupeMembers(data.items);state.pending=data.pending_registrations||[];state.permissions=data.permissions||{};renderSummary();renderPending();renderRows();}

  async function load(force=false){const token=localStorage.getItem("bd:token")||"";const clubId=Number(localStorage.getItem("bd:selectedClubId")||0);const key=`${token}:${clubId}`;if(!token||!clubId||state.loading||(!force&&key===state.key))return;state.token=token;state.clubId=clubId;state.key=key;state.loading=true;try{render(await request("list"));}catch(error){state.key="";el.rows.innerHTML=`<tr><td colspan="5"><div class="empty">${escapeHtml(error.message)}</div></td></tr>`;}finally{state.loading=false;}}
  function showInline(message,tone="info"){el.result.className=`member-invite-result ${tone}`;el.result.innerHTML=`<strong>${escapeHtml(message)}</strong>`;}

  async function showInviteLink(title,inviteToken,expiresAt,note,target="runtime"){
    const config=await loadLinkConfig();const isMemberInvite=target==="member";const baseUrl=isMemberInvite?config.member_onboarding_base_url:config.runtime_base_url;const url=onboardingUrl(baseUrl,inviteToken);const productionLink=isMemberInvite||String(config.app_env||"")==="prod";const environmentLabel=productionLink?"Produksjonslenke":"Testlenke";const environmentTone=productionLink?"good":"warning";const environmentNote=!productionLink?"Dette er en testlenke og skal ikke sendes til medlemmer.":"";
    el.result.className="member-invite-result good";el.result.innerHTML=`<div><strong>${escapeHtml(title)}</strong><small><span class="badge ${environmentTone}">${environmentLabel}</span> ${escapeHtml(note)} ${escapeHtml(environmentNote)} Lenken er gyldig til ${escapeHtml(formatDate(expiresAt,true))}.</small></div><div class="member-link-row"><input readonly value="${escapeHtml(url.toString())}"><button type="button" class="button member-copy-link">Kopier lenke</button></div>`;
    el.result.querySelector(".member-copy-link")?.addEventListener("click",async(event)=>{await navigator.clipboard.writeText(url.toString());event.currentTarget.textContent="Kopiert";});el.result.scrollIntoView({behavior:"smooth",block:"nearest"});
  }

  function setFilter(filter){state.filter=filter==="pending"?"all":filter||"all";block.querySelectorAll("[data-member-filter]").forEach(button=>button.classList.toggle("active",button.dataset.memberFilter===state.filter));renderRows();if(filter==="pending"&&state.pending.length)el.pending.scrollIntoView({behavior:"smooth",block:"start"});}

  el.openInvite?.addEventListener("click",async()=>{el.openInvite.disabled=true;try{const data=await request("invite-open",{method:"POST",body:{}});await showInviteLink("Registreringslenke for ny person",data.token,data.expires_at,"Mottakeren fyller selv inn navn, e-post og passord. Klubben kobler deretter registreringen til riktig medlem.","runtime");}catch(error){showInline(error.message,"bad");}finally{el.openInvite.disabled=false;}});

  block.addEventListener("click",async(event)=>{
    const filterButton=event.target.closest("[data-member-filter]");if(filterButton){setFilter(filterButton.dataset.memberFilter||"all");return;}
    const summaryButton=event.target.closest("[data-summary-filter]");if(summaryButton){setFilter(summaryButton.dataset.summaryFilter||"all");return;}
    const pendingCard=event.target.closest("[data-open-invite-id]");const approveButton=event.target.closest(".member-approve-open");
    if(pendingCard&&approveButton){const inviteId=Number(pendingCard.dataset.openInviteId||0);const memberId=Number(pendingCard.querySelector(".member-pending-select")?.value||0);if(!memberId){showInline("Velg hvilket eksisterende medlem registreringen skal kobles til.","bad");return;}approveButton.disabled=true;try{const data=await request("approve-open",{method:"POST",body:{invite_id:inviteId,member_id:memberId}});showInline(`${data.name} er koblet til eksisterende medlem og kontoen er aktiv.`,"good");state.key="";await load(true);}catch(error){showInline(error.message,"bad");}finally{approveButton.disabled=false;}return;}
    const row=event.target.closest("tr[data-member-id]");if(!row)return;const memberId=Number(row.dataset.memberId||0);const item=state.items.find(entry=>Number(entry.member_id)===memberId);if(!item)return;
    const accessButton=event.target.closest(".member-access-save");
    if(accessButton){const accountId=Number(accessButton.dataset.accountId||0);const select=row.querySelector(".member-access-select");const accessLevel=String(select?.value||"");const oldLevel=String(item.account?.access_level||"player");const touchesSuper=accessLevel==="super_admin"||oldLevel==="super_admin";if(touchesSuper&&accessButton.dataset.confirm!=="1"){accessButton.dataset.confirm="1";accessButton.textContent="Bekreft";window.setTimeout(()=>{if(accessButton.isConnected&&accessButton.dataset.confirm==="1"){accessButton.dataset.confirm="";accessButton.textContent="Lagre";}},5000);return;}accessButton.disabled=true;try{await request("set-access-level",{method:"POST",body:{account_id:accountId,access_level:accessLevel}});showInline(`${item.member_name} har nå tilgangsnivå ${accessLabel(accessLevel)}.`,"good");state.key="";await load(true);}catch(error){showInline(error.message,"bad");}finally{accessButton.disabled=false;}return;}
    const inviteButton=event.target.closest(".member-invite");if(inviteButton){inviteButton.disabled=true;try{const data=await request("invite",{method:"POST",body:{member_id:memberId}});await showInviteLink(`Aktiveringslenke til ${item.member_name}`,data.token,data.expires_at,"Lenken er koblet direkte til dette medlemmet og beholder eksisterende spillerprofil.","member");state.key="";await load(true);}catch(error){showInline(error.message,"bad");}finally{inviteButton.disabled=false;}return;}
    const reactivateButton=event.target.closest(".member-reactivate");if(reactivateButton){reactivateButton.disabled=true;try{await reactivateAccount(memberId);showInline(`${item.member_name} kan logge inn igjen med samme e-post og passord.`,"good");state.key="";await load(true);}catch(error){showInline(error.message,"bad");}finally{reactivateButton.disabled=false;}return;}
    const disableButton=event.target.closest(".member-disable");if(disableButton){if(disableButton.dataset.confirm!=="1"){disableButton.dataset.confirm="1";disableButton.textContent="Bekreft deaktivering";window.setTimeout(()=>{if(disableButton.isConnected&&disableButton.dataset.confirm==="1"){disableButton.dataset.confirm="";disableButton.textContent="Deaktiver konto";}},5000);return;}disableButton.disabled=true;try{await request("disable",{method:"POST",body:{member_id:memberId}});showInline(`${item.member_name} er deaktivert. Spillerhistorikken er ikke endret.`,"good");state.key="";await load(true);}catch(error){showInline(error.message,"bad");}finally{disableButton.disabled=false;}}
  });

  el.search?.addEventListener("input",()=>{state.search=String(el.search.value||"").trim().toLocaleLowerCase("nb");renderRows();});
  document.getElementById("refreshAllButton")?.addEventListener("click",()=>{state.key="";setTimeout(()=>load(true),50);});
  document.getElementById("clubSelect")?.addEventListener("change",()=>{state.key="";setTimeout(()=>load(true),100);});
  window.addEventListener("bd:portal-view",event=>{if(event.detail?.target==="players")load(true);});
  loadLinkConfig().catch(()=>null);load(true);
}
