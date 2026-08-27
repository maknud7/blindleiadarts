const API_ROOT = "../api/v1";

const state = {
  items: [],
  preview: null,
  loading: false,
};

function token() {
  return window.BlindleiaApp?.session?.token?.() || localStorage.getItem("bd:token") || "";
}

function clubId() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, {
    method: options.method || "GET",
    headers,
    cache: "no-store",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  }
  return payload.data;
}

function groupCandidates(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = String(item.display_name || "").trim().toLocaleLowerCase("nb-NO");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function identityBadges(player) {
  const badges = [];
  if (player.has_account) badges.push('<span class="badge good">Brukerkonto</span>');
  if (player.member_id) badges.push('<span class="badge good">Medlem</span>');
  if (!player.is_active) badges.push('<span class="badge neutral">Inaktiv</span>');
  return badges.join("");
}

function ensureUi() {
  const host = document.getElementById("playerbase");
  if (!host || document.getElementById("playerIdentityPanel")) return;

  const panel = document.createElement("section");
  panel.id = "playerIdentityPanel";
  panel.className = "player-identity-panel";
  panel.innerHTML = `
    <div class="player-identity-head">
      <div>
        <p class="eyebrow">Canonical spillerregister</p>
        <h3>Duplikater og spilleridentitet</h3>
        <p class="muted">Samler kampdata, ELO, turneringer og medlemskobling på én spiller-ID. Original-ID-en beholdes som revisjonsspor.</p>
      </div>
      <button id="refreshPlayerIdentities" type="button" class="button secondary">Sjekk duplikater</button>
    </div>
    <div id="playerIdentitySummary" class="player-identity-summary muted">Ikke kontrollert ennå.</div>
    <div id="playerIdentityGroups" class="player-identity-groups"></div>`;
  host.appendChild(panel);

  const dialog = document.createElement("dialog");
  dialog.id = "playerIdentityDialog";
  dialog.className = "player-identity-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="player-identity-dialog-card">
      <div class="player-identity-dialog-head">
        <div><p class="eyebrow">Sammenslå spillere</p><h3 id="playerIdentityDialogTitle">Kontrollerer …</h3></div>
        <button type="submit" class="button quiet">Lukk</button>
      </div>
      <div id="playerIdentityDialogBody"></div>
      <div class="player-identity-dialog-actions">
        <button id="confirmPlayerIdentityMerge" type="button" class="button" disabled>Slå sammen</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);

  document.getElementById("refreshPlayerIdentities")?.addEventListener("click", () => loadDuplicates(true));
  document.getElementById("confirmPlayerIdentityMerge")?.addEventListener("click", mergePreviewed);
}

function render() {
  ensureUi();
  const summary = document.getElementById("playerIdentitySummary");
  const root = document.getElementById("playerIdentityGroups");
  if (!summary || !root) return;

  const groups = groupCandidates(state.items);
  if (!groups.length) {
    summary.innerHTML = '<span class="badge good">Ingen navneduplikater</span> Spillerregisteret ser ryddig ut.';
    root.innerHTML = "";
    return;
  }

  summary.innerHTML = `<span class="badge warning">${groups.length} ${groups.length === 1 ? "duplikatgruppe" : "duplikatgrupper"}</span> Kontroller før du slår sammen.`;
  root.innerHTML = groups.map((group) => {
    const sorted = [...group].sort((a, b) => Number(b.canonical_score || 0) - Number(a.canonical_score || 0) || Number(a.id) - Number(b.id));
    const target = sorted[0];
    const sources = sorted.slice(1);
    return `
      <article class="player-identity-group">
        <div class="player-identity-group-head">
          <div><strong>${esc(target.display_name)}</strong><span>${group.length} spiller-ID-er</span></div>
          <span class="badge neutral">Anbefalt canonical: #${target.id}</span>
        </div>
        <div class="player-identity-list">
          ${sorted.map((player, index) => `
            <div class="player-identity-row ${index === 0 ? "canonical" : ""}">
              <div class="player-identity-name">
                <strong>#${player.id} ${esc(player.display_name)}</strong>
                <div class="player-identity-badges">${identityBadges(player)}</div>
              </div>
              <div class="player-identity-meta">
                <span>${Number(player.match_count || 0)} kamper</span>
                <span>${Number(player.visit_count || 0)} visits</span>
                <span>${Number(player.tournament_count || 0)} turneringer</span>
                ${player.top_elo ? `<span>ELO ${Number(player.top_elo).toFixed(1)}</span>` : ""}
              </div>
              <div class="player-identity-action">
                ${index === 0
                  ? '<span class="badge good">Behold</span>'
                  : `<button type="button" class="button secondary" data-identity-source="${player.id}" data-identity-target="${target.id}">Kontroller sammenslåing</button>`}
              </div>
            </div>`).join("")}
        </div>
        ${sources.length > 1 ? '<p class="muted player-identity-note">Slå sammen én ID om gangen. Registeret oppdateres etter hver sammenslåing.</p>' : ""}
      </article>`;
  }).join("");

  root.querySelectorAll("[data-identity-source]").forEach((button) => {
    button.addEventListener("click", () => previewMerge(Number(button.dataset.identitySource), Number(button.dataset.identityTarget)));
  });
}

async function loadDuplicates(force = false) {
  ensureUi();
  const id = clubId();
  if (!id || state.loading) return;
  state.loading = true;
  const summary = document.getElementById("playerIdentitySummary");
  if (summary) summary.textContent = "Kontrollerer spillerregisteret …";
  try {
    if (force && window.BlindleiaApp?.session?.resolve) await window.BlindleiaApp.session.resolve({ force: true });
    const data = await api(`/clubs/${id}/player-identities/duplicates`);
    state.items = Array.isArray(data?.items) ? data.items : [];
    render();
  } catch (error) {
    if (summary) summary.innerHTML = `<span class="badge bad">Kunne ikke kontrollere</span> ${esc(error.message)}`;
  } finally {
    state.loading = false;
  }
}

async function previewMerge(sourceId, targetId) {
  ensureUi();
  const dialog = document.getElementById("playerIdentityDialog");
  const title = document.getElementById("playerIdentityDialogTitle");
  const body = document.getElementById("playerIdentityDialogBody");
  const confirm = document.getElementById("confirmPlayerIdentityMerge");
  if (!dialog || !title || !body || !confirm) return;

  state.preview = null;
  title.textContent = "Kontrollerer …";
  body.innerHTML = '<p class="muted">Validerer alle kjente koblinger før noe kan endres.</p>';
  confirm.disabled = true;
  dialog.showModal();

  try {
    const data = await api(`/clubs/${clubId()}/player-identities/preview`, {
      method: "POST",
      body: { source_player_id: sourceId, target_player_id: targetId },
    });
    state.preview = data;
    const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
    const references = data?.references && typeof data.references === "object" ? data.references : {};
    const refTotal = Object.values(references).reduce((sum, value) => sum + Number(value || 0), 0);
    title.textContent = `${data.source.display_name}: #${sourceId} → #${targetId}`;
    body.innerHTML = `
      <div class="player-identity-merge-summary">
        <div><span>Fra</span><strong>#${sourceId}</strong><small>${esc(data.source.display_name)}</small></div>
        <div class="player-identity-arrow">→</div>
        <div><span>Til canonical</span><strong>#${targetId}</strong><small>${esc(data.target.display_name)}</small></div>
      </div>
      <div class="message ${data.safe_to_merge ? "success" : "error"}">
        <strong>${data.safe_to_merge ? "Klar for sikker sammenslåing" : "Kan ikke slås sammen ennå"}</strong>
        <p>${data.safe_to_merge ? `${refTotal} databaserelasjoner flyttes atomisk. Kilde-ID-en blir inaktiv og beholdes som revisjonsspor.` : "Ingen data endres før konfliktene under er ryddet."}</p>
      </div>
      ${conflicts.length ? `<div class="player-identity-conflicts"><h4>Konflikter</h4>${conflicts.map((item) => `<p>• ${esc(item.message)}</p>`).join("")}</div>` : ""}
      ${Object.keys(references).length ? `<details class="player-identity-references"><summary>Vis relasjoner som flyttes (${refTotal})</summary><div>${Object.entries(references).map(([key,value]) => `<span><code>${esc(key.replace(/^bd_(?:test|prod)_/, ""))}</code><strong>${Number(value)}</strong></span>`).join("")}</div></details>` : ""}`;
    confirm.disabled = !data.safe_to_merge;
  } catch (error) {
    title.textContent = "Kunne ikke kontrollere";
    body.innerHTML = `<div class="message error"><strong>Sammenslåingen ble ikke åpnet</strong><p>${esc(error.message)}</p></div>`;
  }
}

async function mergePreviewed() {
  const preview = state.preview;
  const confirm = document.getElementById("confirmPlayerIdentityMerge");
  const body = document.getElementById("playerIdentityDialogBody");
  if (!preview?.safe_to_merge || !confirm || !body) return;
  confirm.disabled = true;
  confirm.textContent = "Slår sammen …";
  try {
    await api(`/clubs/${clubId()}/player-identities/merge`, {
      method: "POST",
      body: {
        source_player_id: Number(preview.source.id),
        target_player_id: Number(preview.target.id),
        reason: "Canonical spilleropprydding fra admin",
      },
    });
    body.insertAdjacentHTML("afterbegin", '<div class="message success"><strong>Sammenslått</strong><p>Kampdata og koblinger peker nå på canonical spiller-ID.</p></div>');
    confirm.textContent = "Ferdig";
    await loadDuplicates();
    window.dispatchEvent(new CustomEvent("bd:player-identity-merged", { detail: { source: preview.source.id, target: preview.target.id } }));
    window.setTimeout(() => document.getElementById("playerIdentityDialog")?.close(), 700);
  } catch (error) {
    body.insertAdjacentHTML("afterbegin", `<div class="message error"><strong>Ingen data ble endret</strong><p>${esc(error.message)}</p></div>`);
    confirm.disabled = false;
    confirm.textContent = "Prøv igjen";
  }
}

function boot() {
  ensureUi();
  document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(() => loadDuplicates(), 80));
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "playerbase") loadDuplicates();
  });
  if (document.body.dataset.portalActive === "playerbase" || window.location.hash.endsWith("/playerbase")) {
    window.setTimeout(() => loadDuplicates(), 150);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
