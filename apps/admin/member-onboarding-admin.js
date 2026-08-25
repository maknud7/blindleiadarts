const ENDPOINT = "../api/member-onboarding.php";
const API_ROOT = "../api/v1";

const panel = document.getElementById("players");
if (panel) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./member-onboarding-admin.css";
  document.head.appendChild(css);

  const block = document.createElement("div");
  block.className = "member-access-block";
  block.innerHTML = `
    <div class="subsection-head member-access-head">
      <div>
        <h3>Spillere og tilgang</h3>
        <p class="muted">Klubbens spillere administreres som én person med medlemskap, dartprofil og innlogging. Gjestespillere fra turneringer ligger ikke i dette registeret.</p>
      </div>
      <span id="memberAccessCount" class="pill">—</span>
    </div>
    <div id="memberAccessSummary" class="member-access-summary"></div>
    <div id="memberInviteResult" class="member-invite-result hidden"></div>
    <div class="table-wrap member-access-table-wrap">
      <table>
        <thead><tr><th>Spiller</th><th>Tilgang</th><th>E-post</th><th>ELO</th><th>Kamper</th><th>Snitt</th><th>180</th><th></th></tr></thead>
        <tbody id="memberAccessRows"></tbody>
      </table>
    </div>`;

  const registryStatus = panel.querySelector("#memberRegistryStatus");
  panel.insertBefore(block, registryStatus || panel.firstChild);
  if (registryStatus) registryStatus.classList.add("hidden");

  const el = {
    count: block.querySelector("#memberAccessCount"),
    summary: block.querySelector("#memberAccessSummary"),
    result: block.querySelector("#memberInviteResult"),
    rows: block.querySelector("#memberAccessRows"),
  };

  const state = { token: "", clubId: 0, key: "", items: [], statsByPlayer: new Map(), loading: false };

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  async function request(action, { method = "GET", body } = {}) {
    const url = new URL(ENDPOINT, window.location.href);
    url.searchParams.set("action", action);
    if (method === "GET") url.searchParams.set("club_id", String(state.clubId));
    const response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${state.token}`,
      },
      body: body !== undefined ? JSON.stringify({ club_id: state.clubId, ...body }) : undefined,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadStats() {
    const response = await fetch(`${API_ROOT}/clubs/${state.clubId}/player-directory`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) return new Map();
    return new Map((payload.data?.items || []).map((item) => [Number(item.id), item]));
  }

  function statusInfo(status) {
    switch (status) {
      case "active": return ["Aktiv", "good"];
      case "invited": return ["Invitert", "warning"];
      case "disabled": return ["Deaktivert", "bad"];
      case "unclaimed": return ["Ikke aktivert", "neutral"];
      default: return ["Ikke invitert", "neutral"];
    }
  }

  function formatNumber(value, digits = 0) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toFixed(digits) : "—";
  }

  function render(data) {
    state.items = data.items || [];
    const summary = data.summary || {};
    el.count.textContent = `${summary.members || state.items.length} spillere`;
    const active = Number(summary.active || 0);
    const waiting = Number(summary.invited || 0) + Number(summary.unclaimed || 0) + Number(summary.without_account || 0);
    el.summary.innerHTML = [
      ["Aktive", active],
      ["Venter på tilgang", waiting],
      ["Deaktivert", Number(summary.disabled || 0)],
    ].map(([label, value]) => `<span><strong>${Number(value)}</strong> ${escapeHtml(label)}</span>`).join("");

    el.rows.innerHTML = state.items.map((item) => {
      const account = item.account || null;
      const status = account?.status || "none";
      const [label, tone] = statusInfo(status);
      const isActive = status === "active";
      const email = account?.email || "";
      const playerId = Number(item.player?.id || 0);
      const stats = state.statsByPlayer.get(playerId) || {};
      const actionLabel = status === "invited" ? "Ny lenke" : status === "disabled" ? "Inviter på nytt" : "Inviter";
      const playerName = item.player?.display_name || item.member_name;
      return `<tr data-member-id="${Number(item.member_id)}">
        <td><strong>${escapeHtml(playerName)}</strong>${playerId ? `<small>ELO ${formatNumber(stats.elo_rating || 1000, 1)}</small>` : `<small>Spillerprofil opprettes automatisk</small>`}</td>
        <td><span class="badge ${tone}">${escapeHtml(label)}</span>${account?.invite_expires_at ? `<small>Lenke utløper ${escapeHtml(formatDate(account.invite_expires_at))}</small>` : ""}</td>
        <td><input class="member-email-input" type="email" value="${escapeHtml(email)}" placeholder="E-post" ${isActive ? "readonly" : ""}></td>
        <td>${playerId ? formatNumber(stats.elo_rating || 1000, 1) : "—"}</td>
        <td>${playerId ? Number(stats.matches_played || 0) : "—"}</td>
        <td>${playerId ? formatNumber(stats.recorded_average || 0, 2) : "—"}</td>
        <td>${playerId ? Number(stats.score_180 || 0) : "—"}</td>
        <td class="member-access-actions">${isActive
          ? `<button type="button" class="button quiet member-disable">Deaktiver</button>`
          : `<button type="button" class="button secondary member-invite">${escapeHtml(actionLabel)}</button>`}</td>
      </tr>`;
    }).join("");
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  async function load(force = false) {
    const token = localStorage.getItem("bd:token") || "";
    const clubId = Number(localStorage.getItem("bd:selectedClubId") || 0);
    const key = `${token}:${clubId}`;
    if (!token || !clubId || state.loading || (!force && key === state.key)) return;
    state.token = token; state.clubId = clubId; state.key = key; state.loading = true;
    try {
      const [members, stats] = await Promise.all([request("list"), loadStats()]);
      state.statsByPlayer = stats;
      render(members);
    } catch (error) {
      state.key = "";
      el.rows.innerHTML = `<tr><td colspan="8"><div class="empty">${escapeHtml(error.message)}</div></td></tr>`;
    } finally { state.loading = false; }
  }

  function showInviteLink(memberName, token, expiresAt) {
    const url = new URL("../onboarding/", window.location.href);
    url.searchParams.set("token", token);
    el.result.classList.remove("hidden");
    el.result.innerHTML = `<div><strong>Invitasjon til ${escapeHtml(memberName)}</strong><small>Gyldig til ${escapeHtml(formatDate(expiresAt))}. Den gamle lenken er nå ugyldig.</small></div><div class="member-link-row"><input readonly value="${escapeHtml(url.toString())}"><button type="button" class="button member-copy-link">Kopier lenke</button></div>`;
    el.result.querySelector(".member-copy-link")?.addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(url.toString());
      event.currentTarget.textContent = "Kopiert";
    });
  }

  block.addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-member-id]");
    if (!row) return;
    const memberId = Number(row.dataset.memberId || 0);
    const item = state.items.find((entry) => Number(entry.member_id) === memberId);
    if (!item) return;

    if (event.target.closest(".member-invite")) {
      const button = event.target.closest(".member-invite");
      const email = row.querySelector(".member-email-input")?.value.trim() || "";
      button.disabled = true;
      try {
        const data = await request("invite", { method: "POST", body: { member_id: memberId, email } });
        showInviteLink(item.member_name, data.token, data.expires_at);
        state.key = "";
        await load(true);
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; }
      return;
    }

    if (event.target.closest(".member-disable")) {
      if (!confirm(`Deaktivere innloggingen til ${item.member_name}? Kamp- og statistikkhistorikken beholdes.`)) return;
      const button = event.target.closest(".member-disable");
      button.disabled = true;
      try {
        await request("disable", { method: "POST", body: { member_id: memberId } });
        state.key = "";
        await load(true);
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; }
    }
  });

  document.getElementById("refreshAllButton")?.addEventListener("click", () => { state.key = ""; setTimeout(() => load(true), 50); });
  document.getElementById("clubSelect")?.addEventListener("change", () => { state.key = ""; setTimeout(() => load(true), 100); });
  window.addEventListener("focus", () => load(true));
  setInterval(() => load(false), 1000);
  load(true);
}