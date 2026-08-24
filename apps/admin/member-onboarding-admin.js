const ENDPOINT = "../api/member-onboarding.php";

const panel = document.getElementById("members");
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
        <h3>Medlemmer og innlogging</h3>
        <p class="muted">Medlemskapet finnes uavhengig av brukerkonto. Opprett innlogging først når medlemmet skal inviteres.</p>
      </div>
      <span id="memberAccessCount" class="pill">—</span>
    </div>
    <div id="memberAccessSummary" class="member-access-summary"></div>
    <div id="memberInviteResult" class="member-invite-result hidden"></div>
    <div class="table-wrap member-access-table-wrap">
      <table>
        <thead><tr><th>Medlem</th><th>Dartprofil</th><th>Konto</th><th>E-post</th><th></th></tr></thead>
        <tbody id="memberAccessRows"></tbody>
      </table>
    </div>`;

  const registryStatus = panel.querySelector("#memberRegistryStatus");
  panel.insertBefore(block, registryStatus || panel.firstChild);

  const el = {
    count: block.querySelector("#memberAccessCount"),
    summary: block.querySelector("#memberAccessSummary"),
    result: block.querySelector("#memberInviteResult"),
    rows: block.querySelector("#memberAccessRows"),
  };

  const state = { token: "", clubId: 0, key: "", items: [], loading: false };

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
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function statusInfo(status) {
    switch (status) {
      case "active": return ["Aktiv", "good"];
      case "invited": return ["Invitert", "warning"];
      case "disabled": return ["Deaktivert", "bad"];
      case "unclaimed": return ["Ikke aktivert", "neutral"];
      default: return ["Ingen konto", "neutral"];
    }
  }

  function render(data) {
    state.items = data.items || [];
    const summary = data.summary || {};
    el.count.textContent = `${summary.members || state.items.length} medlemmer`;
    el.summary.innerHTML = [
      ["Aktive", summary.active || 0],
      ["Invitert", summary.invited || 0],
      ["Ikke aktivert", (summary.without_account || 0) + (summary.unclaimed || 0)],
      ["Med dartprofil", summary.with_player || 0],
    ].map(([label, value]) => `<span><strong>${Number(value)}</strong> ${escapeHtml(label)}</span>`).join("");

    el.rows.innerHTML = state.items.map((item) => {
      const account = item.account || null;
      const status = account?.status || "none";
      const [label, tone] = statusInfo(status);
      const active = status === "active";
      const email = account?.email || "";
      const actionLabel = status === "invited" ? "Lag ny lenke" : status === "disabled" ? "Inviter på nytt" : "Inviter";
      return `<tr data-member-id="${Number(item.member_id)}">
        <td><strong>${escapeHtml(item.member_name)}</strong><small class="member-id">#${Number(item.member_id)}</small></td>
        <td>${item.player ? `<span>${escapeHtml(item.player.display_name)}</span>` : `<span class="muted">Ikke koblet</span>`}</td>
        <td><span class="badge ${tone}">${escapeHtml(label)}</span>${account?.invite_expires_at ? `<small>Lenke utløper ${escapeHtml(formatDate(account.invite_expires_at))}</small>` : ""}</td>
        <td><input class="member-email-input" type="email" value="${escapeHtml(email)}" placeholder="Kan fylles inn senere" ${active ? "readonly" : ""}></td>
        <td class="member-access-actions">${active
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
      render(await request("list"));
    } catch (error) {
      state.key = "";
      el.rows.innerHTML = `<tr><td colspan="5"><div class="empty">${escapeHtml(error.message)}</div></td></tr>`;
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
      if (!confirm(`Deaktivere innloggingen til ${item.member_name}? Medlemskapet og dartprofilen blir ikke berørt.`)) return;
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
