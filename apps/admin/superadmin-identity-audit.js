const API_ROOT = "../api/v1";
let auditBusy = false;
let auditLastLoaded = 0;

function auditToken() { return window.BlindleiaApp?.session?.token?.() || localStorage.getItem("bd:token") || ""; }
function auditEsc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function auditDate(value) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function auditApi(path) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: auditToken() ? { Authorization: `Bearer ${auditToken()}` } : {},
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureAuditPanel() {
  const host = document.getElementById("superadminIdentityAuditHost");
  if (!host || document.getElementById("superadminIdentityAuditPanel")) return false;
  const panel = document.createElement("section");
  panel.id = "superadminIdentityAuditPanel";
  panel.className = "claim-admin-card";
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="eyebrow">Revisjonsspor</p>
        <h3>Sammenslåtte identiteter</h3>
        <p class="muted">Viser hva som er slått sammen i canonical registeret. Spiller-ID, medlemskoblinger, brukerkontoer og flyttede relasjoner beholdes som revisjonsspor.</p>
      </div>
      <button id="refreshIdentityAudit" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="identityAuditSummary" class="health-summary neutral"><div><strong>Laster …</strong><p>Henter sammenslåinger og uavklarte dubletter.</p></div><span class="health-overall">…</span></div>
    <div id="identityAuditUnresolved" class="list"></div>
    <div class="subsection-head"><h3>Historikk</h3><span id="identityAuditCount" class="pill">0</span></div>
    <div id="identityAuditHistory" class="list"></div>`;
  host.appendChild(panel);
  panel.querySelector("#refreshIdentityAudit")?.addEventListener("click", () => loadAudit(true));
  return true;
}

function relationLabel(key) {
  return String(key || "")
    .replace(/^bd_(?:test|prod)_/, "")
    .replaceAll("_", " ")
    .replace("player id", "spiller")
    .replace("member id", "medlem");
}

function renderAudit(history, health) {
  const summary = document.getElementById("identityAuditSummary");
  const unresolved = document.getElementById("identityAuditUnresolved");
  const count = document.getElementById("identityAuditCount");
  const root = document.getElementById("identityAuditHistory");
  if (!summary || !unresolved || !count || !root) return;

  const duplicateGroups = Number(health?.duplicate_groups || 0);
  summary.className = `health-summary ${duplicateGroups ? "bad" : "good"}`;
  summary.innerHTML = `<div><strong>${duplicateGroups ? `${duplicateGroups} uavklarte identitetsgrupper` : "Canonical register er ryddig"}</strong><p>${duplicateGroups ? "Disse vises også som feil i helsesjekken." : `${Number(health?.merge_count || 0)} sammenslåinger er registrert i revisjonssporet.`}</p></div><span class="health-overall">${duplicateGroups ? "FEIL" : "OK"}</span>`;

  const duplicates = Array.isArray(health?.duplicates) ? health.duplicates : [];
  unresolved.innerHTML = duplicates.length
    ? `<div class="subsection-head"><h3>Uavklarte dubletter</h3></div>${duplicates.map((row) => `<div class="list-row"><div><strong>${auditEsc(row.display_name)}</strong><small>${auditEsc(row.club_name || "Uten klubb")} · spiller-ID ${auditEsc((row.ids || []).join(", "))}</small></div><span class="badge bad">${Number(row.player_ids || 0)} ID-er</span></div>`).join("")}`
    : "";

  const items = Array.isArray(history) ? history : [];
  count.textContent = `${items.length} stk`;
  root.innerHTML = items.length ? items.map((row) => {
    const moved = row.summary?.moved && typeof row.summary.moved === "object" ? row.summary.moved : {};
    const relationRows = Object.entries(moved).filter(([, value]) => Number(value || 0) > 0);
    const actor = row.merged_by_name || row.merged_by_email || (row.merged_by_user_account_id ? `Bruker #${row.merged_by_user_account_id}` : "System/migrering");
    const identityLabel = row.identity_scope === "player_member" ? "Spiller + medlem" : "Spiller";
    return `<article class="list-row" style="align-items:flex-start">
      <div style="min-width:0;flex:1">
        <strong>${auditEsc(row.source_display_name)} <span class="muted">#${Number(row.source_player_id)}</span> → ${auditEsc(row.target_display_name)} <span class="muted">#${Number(row.target_player_id)}</span></strong>
        <small>${auditEsc(identityLabel)} · ${auditEsc(row.club_name || "Uten klubb")} · ${auditEsc(auditDate(row.created_at))} · ${auditEsc(actor)}</small>
        ${row.source_member_id || row.target_member_id ? `<small>Medlemskobling: ${row.source_member_id ? `#${Number(row.source_member_id)}` : "—"} → ${row.target_member_id ? `#${Number(row.target_member_id)}` : "—"}</small>` : ""}
        ${row.reason ? `<small>Årsak: ${auditEsc(row.reason)}</small>` : ""}
        ${relationRows.length ? `<details style="margin-top:8px"><summary>${Number(row.moved_relations || 0)} relasjoner flyttet</summary><div style="display:grid;gap:4px;margin-top:7px">${relationRows.map(([key,value]) => `<small>${auditEsc(relationLabel(key))}: <strong>${Number(value)}</strong></small>`).join("")}</div></details>` : ""}
      </div>
      <span class="badge good">Sammenslått</span>
    </article>`;
  }).join("") : `<div class="empty">Ingen sammenslåinger er registrert ennå.</div>`;
}

async function loadAudit(force = false) {
  if (!ensureAuditPanel() && !document.getElementById("superadminIdentityAuditPanel")) return;
  if (auditBusy || !auditToken()) return;
  if (!force && Date.now() - auditLastLoaded < 15000) return;
  auditBusy = true;
  try {
    const [history, health] = await Promise.all([
      auditApi("/player-identities/history?limit=150"),
      auditApi("/player-identities/health"),
    ]);
    renderAudit(history?.items || [], health || {});
    auditLastLoaded = Date.now();
  } catch (error) {
    const root = document.getElementById("identityAuditHistory");
    if (root) root.innerHTML = `<div class="message error"><strong>Kunne ikke hente revisjonssporet</strong><p>${auditEsc(error.message)}</p></div>`;
  } finally {
    auditBusy = false;
  }
}

window.addEventListener("bd:superadmin-ready", () => {
  ensureAuditPanel();
  if (window.BlindleiaApp?.router?.route?.().view === "superadmin") loadAudit();
});
window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "superadmin") loadAudit();
});
window.addEventListener("bd:player-identity-merged", () => loadAudit(true));
window.setTimeout(() => {
  ensureAuditPanel();
  if (window.BlindleiaApp?.router?.route?.().view === "superadmin") loadAudit();
}, 1000);
