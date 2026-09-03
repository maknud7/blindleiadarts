const ENDPOINT = "../api/player-member-links.php";

const state = { loading: false, clubId: 0, players: [], members: [] };

function token() {
  return window.BlindleiaApp?.session?.token?.() || localStorage.getItem("bd:token") || "";
}

function selectedClubId() {
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

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("nb-NO");
}

function ensureUi() {
  const host = document.getElementById("players");
  if (!host || document.getElementById("playerMemberLinkPanel")) return;

  const style = document.createElement("style");
  style.textContent = `
    .player-member-link-panel{margin:16px 0 22px;padding:16px;border:1px solid var(--border,#d9dee7);border-radius:16px;background:var(--surface,#fff)}
    .player-member-link-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:12px}.player-member-link-head h3{margin:2px 0 5px}.player-member-link-head p{margin:0}
    .player-member-link-list{display:grid;gap:10px}.player-member-link-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(240px,1.4fr) auto;gap:10px;align-items:end;padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:12px;background:#fff}
    .player-member-link-player{display:flex;flex-direction:column;gap:3px}.player-member-link-player small{color:var(--muted,#667085)}
    .player-member-link-row label{display:flex;flex-direction:column;gap:4px}.player-member-link-row select{width:100%}
    .player-member-link-message{margin:8px 0 0}.player-member-link-empty{padding:10px 0;color:var(--muted,#667085)}
    @media(max-width:760px){.player-member-link-head{display:block}.player-member-link-head button{margin-top:10px}.player-member-link-row{grid-template-columns:1fr}.player-member-link-row button{width:100%}}
  `;
  document.head.appendChild(style);

  const panel = document.createElement("section");
  panel.id = "playerMemberLinkPanel";
  panel.className = "player-member-link-panel";
  panel.innerHTML = `
    <div class="player-member-link-head">
      <div>
        <p class="eyebrow">Spilleridentitet</p>
        <h3>Ukoblede spillere</h3>
        <p class="muted">Koble eksisterende spillerhistorikk til riktig medlem. Dette oppretter ikke en ny spiller-ID.</p>
      </div>
      <button id="refreshPlayerMemberLinks" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="playerMemberLinkMessage" class="player-member-link-message hidden"></div>
    <div id="playerMemberLinkSummary" class="muted">Laster …</div>
    <div id="playerMemberLinkList" class="player-member-link-list"></div>`;

  const head = host.querySelector(".panel-head");
  if (head?.nextSibling) host.insertBefore(panel, head.nextSibling);
  else host.appendChild(panel);
  document.getElementById("refreshPlayerMemberLinks")?.addEventListener("click", () => load(true));
}

async function request(method, body) {
  const clubId = selectedClubId();
  const url = new URL(ENDPOINT, window.location.href);
  if (method === "GET") url.searchParams.set("club_id", String(clubId));
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify({ club_id: clubId, ...body }) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function exactSuggestedMember(player) {
  const matches = state.members.filter((member) => !member.linked_player_id && normalize(member.name) === normalize(player.display_name));
  return matches.length === 1 ? matches[0].id : 0;
}

function render() {
  ensureUi();
  const summary = document.getElementById("playerMemberLinkSummary");
  const root = document.getElementById("playerMemberLinkList");
  if (!summary || !root) return;

  if (!state.players.length) {
    summary.innerHTML = '<span class="badge good">Alt koblet</span> Ingen aktive spillere mangler medlemskobling.';
    root.innerHTML = "";
    return;
  }

  summary.innerHTML = `<span class="badge warning">${state.players.length} ukoblet${state.players.length === 1 ? " spiller" : "e spillere"}</span> Velg riktig medlem før du kobler.`;
  root.innerHTML = state.players.map((player) => {
    const suggested = exactSuggestedMember(player);
    const options = state.members.map((member) => {
      const linked = Number(member.linked_player_id || 0) > 0;
      const label = `${member.name}${member.member_number ? ` · #${member.member_number}` : ""}${linked ? ` · koblet til ${member.linked_player_name || `spiller #${member.linked_player_id}`}` : ""}`;
      return `<option value="${member.id}"${linked ? " disabled" : ""}${Number(member.id) === Number(suggested) ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    return `
      <div class="player-member-link-row" data-player-id="${player.id}">
        <div class="player-member-link-player">
          <strong>${esc(player.display_name)}</strong>
          <small>${Number(player.completed_matches || 0)} fullførte kamper · ${Number(player.tournament_count || 0)} turneringer · spiller #${player.id}</small>
        </div>
        <label><span>Medlem</span><select data-member-select><option value="">Velg medlem …</option>${options}</select></label>
        <button type="button" class="button" data-link-player>Koble</button>
      </div>`;
  }).join("");

  root.querySelectorAll("[data-link-player]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("[data-player-id]");
      const playerId = Number(row?.dataset.playerId || 0);
      const memberId = Number(row?.querySelector("[data-member-select]")?.value || 0);
      if (!playerId || !memberId) return showMessage("Velg medlem først.", "error");
      const player = state.players.find((item) => Number(item.id) === playerId);
      const member = state.members.find((item) => Number(item.id) === memberId);
      if (!player || !member) return;
      const ok = window.confirm(`Koble ${player.display_name} til medlem ${member.name}?\n\nSpiller-ID og all kamphistorikk beholdes.`);
      if (!ok) return;
      button.disabled = true;
      button.textContent = "Kobler …";
      try {
        const result = await request("POST", { player_id: playerId, member_id: memberId });
        showMessage(`${result.player_name} er koblet til ${result.member_name || member.name}.`, "success");
        await load(true);
        window.dispatchEvent(new CustomEvent("bd:player-member-linked", { detail: result }));
      } catch (error) {
        showMessage(error.message, "error");
        button.disabled = false;
        button.textContent = "Koble";
      }
    });
  });
}

function showMessage(message, tone) {
  const el = document.getElementById("playerMemberLinkMessage");
  if (!el) return;
  el.className = `player-member-link-message message ${tone}`;
  el.textContent = message;
}

async function load(force = false) {
  ensureUi();
  const clubId = selectedClubId();
  if (!clubId || !token() || state.loading) return;
  if (!force && state.clubId === clubId && state.players.length >= 0 && document.getElementById("playerMemberLinkSummary")?.dataset.loaded === "1") return;
  state.loading = true;
  const summary = document.getElementById("playerMemberLinkSummary");
  if (summary) summary.textContent = "Kontrollerer spillerkoblinger …";
  try {
    const data = await request("GET");
    state.clubId = clubId;
    state.players = Array.isArray(data?.players) ? data.players : [];
    state.members = Array.isArray(data?.members) ? data.members : [];
    if (summary) summary.dataset.loaded = "1";
    render();
  } catch (error) {
    if (summary) summary.innerHTML = `<span class="badge bad">Kunne ikke laste</span> ${esc(error.message)}`;
  } finally {
    state.loading = false;
  }
}

function boot() {
  ensureUi();
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    state.clubId = 0;
    const summary = document.getElementById("playerMemberLinkSummary");
    if (summary) delete summary.dataset.loaded;
    window.setTimeout(() => load(true), 80);
  });
  window.addEventListener("bd:portal-view", (event) => {
    if (["players", "members", "playerbase"].includes(String(event.detail?.target || ""))) load();
  });
  window.addEventListener("hashchange", () => {
    if (/players|members/i.test(window.location.hash)) load();
  });
  window.setTimeout(() => load(), 500);
  window.setTimeout(() => load(), 1500);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
