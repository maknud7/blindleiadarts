const ENDPOINT = "../api/member-onboarding.php";

const panel = document.getElementById("players");
if (panel) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./member-onboarding-admin.css?v=20260826-1845";
  document.head.appendChild(css);

  const block = document.createElement("div");
  block.className = "member-access-block";
  block.innerHTML = `
    <div class="member-toolbar">
      <label class="member-search"><span class="sr-only">Søk i medlemmer</span><input id="memberSearch" type="search" placeholder="Søk etter medlem …" autocomplete="off"></label>
      <div class="member-filters" role="group" aria-label="Filtrer medlemmer">
        <button type="button" class="active" data-member-filter="all">Alle</button>
        <button type="button" data-member-filter="active">Aktive</button>
        <button type="button" data-member-filter="access">Mangler tilgang</button>
        <button type="button" data-member-filter="disabled">Deaktivert</button>
      </div>
      <button id="memberOpenInvite" type="button" class="button secondary">Ny invitasjonslenke</button>
      <span id="memberAccessCount" class="pill">—</span>
    </div>
    <div id="memberAccessSummary" class="member-access-summary"></div>
    <div id="memberInviteResult" class="member-invite-result hidden"></div>
    <div id="memberPendingRegistrations" class="member-pending hidden"></div>
    <div class="table-wrap member-access-table-wrap">
      <table>
        <thead><tr><th>Medlem</th><th>Kontingent</th><th>Tilgang</th><th></th></tr></thead>
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
    pending: block.querySelector("#memberPendingRegistrations"),
    rows: block.querySelector("#memberAccessRows"),
    search: block.querySelector("#memberSearch"),
    openInvite: block.querySelector("#memberOpenInvite"),
  };

  const state = { token: "", clubId: 0, key: "", items: [], pending: [], loading: false, filter: "all", search: "" };

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

  function statusInfo(status) {
    switch (status) {
      case "active": return ["Aktiv", "good"];
      case "invited": return ["Invitert", "warning"];
      case "disabled": return ["Deaktivert", "bad"];
      case "unclaimed": return ["Ikke aktivert", "neutral"];
      default: return ["Ikke invitert", "neutral"];
    }
  }

  function formatMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(number) : "—";
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  }

  function normalizeName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("nb");
  }

  function duesCell(membership) {
    if (!membership) return `<span class="muted">Ikke registrert</span>`;
    const override = String(membership.status_override || "").trim();
    const latest = membership.latest_payment || null;
    if (override) return `<strong>${escapeHtml(override)}</strong>`;
    if (latest) return `<strong>${escapeHtml(latest.period || formatDate(latest.date))}</strong><small>${formatMoney(latest.amount)}</small>`;
    return `<strong>Ingen betaling registrert</strong>`;
  }

  function matchesFilter(item) {
    const status = String(item.account?.status || "none");
    if (state.filter === "active" && status !== "active") return false;
    if (state.filter === "disabled" && status !== "disabled") return false;
    if (state.filter === "access" && ["active", "disabled"].includes(status)) return false;
    if (!state.search) return true;
    const haystack = `${item.member_name || ""} ${item.player?.display_name || ""} ${item.membership?.member_number || ""}`.toLocaleLowerCase("nb");
    return haystack.includes(state.search);
  }

  function renderRows() {
    const items = state.items.filter(matchesFilter);
    if (!items.length) {
      el.rows.innerHTML = `<tr><td colspan="4"><div class="empty">Ingen medlemmer passer filteret.</div></td></tr>`;
      return;
    }

    el.rows.innerHTML = items.map((item) => {
      const account = item.account || null;
      const status = account?.status || "none";
      const [label, tone] = statusInfo(status);
      const isActive = status === "active";
      const playerName = item.player?.display_name || item.member_name;
      const memberNumber = item.membership?.member_number || item.member_number || null;
      const actionLabel = status === "invited" ? "Ny invitasjon" : status === "disabled" ? "Inviter på nytt" : "Inviter";
      return `<tr data-member-id="${Number(item.member_id)}">
        <td><strong>${escapeHtml(playerName)}</strong>${memberNumber ? `<small>Medlemsnr. ${escapeHtml(memberNumber)}</small>` : ""}</td>
        <td>${duesCell(item.membership)}</td>
        <td><span class="badge ${tone}">${escapeHtml(label)}</span>${account?.invite_expires_at && status === "invited" ? `<small>Gyldig til ${escapeHtml(formatDate(account.invite_expires_at))}</small>` : ""}</td>
        <td class="member-access-actions">${isActive
          ? `<button type="button" class="button quiet member-disable">Deaktiver</button>`
          : `<button type="button" class="button secondary member-invite">${escapeHtml(actionLabel)}</button>`}</td>
      </tr>`;
    }).join("");
  }

  function memberOptions(registration) {
    const exact = normalizeName(registration.display_name);
    return state.items
      .filter((item) => String(item.account?.status || "none") !== "active")
      .map((item) => {
        const selected = normalizeName(item.member_name) === exact ? " selected" : "";
        return `<option value="${Number(item.member_id)}"${selected}>${escapeHtml(item.member_name)}</option>`;
      }).join("");
  }

  function renderPending() {
    if (!state.pending.length) {
      el.pending.classList.add("hidden");
      el.pending.innerHTML = "";
      return;
    }
    el.pending.classList.remove("hidden");
    el.pending.innerHTML = `
      <div class="member-pending-head"><div><p class="eyebrow">Venter på godkjenning</p><h3>Registreringer fra invitasjonslenke</h3></div><span class="pill">${state.pending.length}</span></div>
      <div class="member-pending-list">${state.pending.map((item) => `
        <article class="member-pending-card" data-open-invite-id="${Number(item.id)}">
          <div class="member-pending-person"><strong>${escapeHtml(item.display_name)}</strong><small>${escapeHtml(item.email)}</small></div>
          <label><span>Koble til medlem</span><select class="member-pending-select"><option value="">Velg medlem …</option>${memberOptions(item)}</select></label>
          <button type="button" class="button member-approve-open">Godkjenn</button>
        </article>`).join("")}</div>`;
  }

  function render(data) {
    state.items = data.items || [];
    state.pending = data.pending_registrations || [];
    const summary = data.summary || {};
    el.count.textContent = `${summary.members || state.items.length} medlemmer`;
    const active = Number(summary.active || 0);
    const waiting = Number(summary.invited || 0) + Number(summary.unclaimed || 0) + Number(summary.without_account || 0);
    el.summary.innerHTML = [
      ["Aktive", active],
      ["Mangler tilgang", waiting],
      ["Deaktivert", Number(summary.disabled || 0)],
    ].map(([label, value]) => `<span><strong>${Number(value)}</strong> ${escapeHtml(label)}</span>`).join("");
    renderPending();
    renderRows();
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
      el.rows.innerHTML = `<tr><td colspan="4"><div class="empty">${escapeHtml(error.message)}</div></td></tr>`;
    } finally { state.loading = false; }
  }

  function showInline(message, tone = "info") {
    el.result.className = `member-invite-result ${tone}`;
    el.result.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
  }

  function showInviteLink(title, inviteToken, expiresAt, note) {
    const url = new URL("../onboarding/", window.location.href);
    url.searchParams.set("token", inviteToken);
    el.result.className = "member-invite-result good";
    el.result.innerHTML = `<div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(note)} Lenken er gyldig til ${escapeHtml(formatDate(expiresAt))}.</small></div><div class="member-link-row"><input readonly value="${escapeHtml(url.toString())}"><button type="button" class="button member-copy-link">Kopier lenke</button></div>`;
    el.result.querySelector(".member-copy-link")?.addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(url.toString());
      event.currentTarget.textContent = "Kopiert";
    });
  }

  el.openInvite?.addEventListener("click", async () => {
    el.openInvite.disabled = true;
    try {
      const data = await request("invite-open", { method: "POST", body: {} });
      showInviteLink("Ny invitasjonslenke", data.token, data.expires_at, "Mottakeren fyller selv inn navn, e-post og passord.");
    } catch (error) {
      showInline(error.message, "bad");
    } finally {
      el.openInvite.disabled = false;
    }
  });

  block.addEventListener("click", async (event) => {
    const filterButton = event.target.closest("[data-member-filter]");
    if (filterButton) {
      state.filter = filterButton.dataset.memberFilter || "all";
      block.querySelectorAll("[data-member-filter]").forEach((button) => button.classList.toggle("active", button === filterButton));
      renderRows();
      return;
    }

    const pendingCard = event.target.closest("[data-open-invite-id]");
    const approveButton = event.target.closest(".member-approve-open");
    if (pendingCard && approveButton) {
      const inviteId = Number(pendingCard.dataset.openInviteId || 0);
      const memberId = Number(pendingCard.querySelector(".member-pending-select")?.value || 0);
      if (!memberId) {
        showInline("Velg hvilket medlem registreringen skal kobles til.", "bad");
        return;
      }
      approveButton.disabled = true;
      try {
        const data = await request("approve-open", { method: "POST", body: { invite_id: inviteId, member_id: memberId } });
        showInline(`${data.name} er godkjent og kan logge inn.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally { approveButton.disabled = false; }
      return;
    }

    const row = event.target.closest("tr[data-member-id]");
    if (!row) return;
    const memberId = Number(row.dataset.memberId || 0);
    const item = state.items.find((entry) => Number(entry.member_id) === memberId);
    if (!item) return;

    if (event.target.closest(".member-invite")) {
      const button = event.target.closest(".member-invite");
      button.disabled = true;
      try {
        const data = await request("invite", { method: "POST", body: { member_id: memberId } });
        showInviteLink(`Invitasjon til ${item.member_name}`, data.token, data.expires_at, "Personen velger selv e-post og passord.");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally { button.disabled = false; }
      return;
    }

    const disableButton = event.target.closest(".member-disable");
    if (disableButton) {
      if (disableButton.dataset.confirm !== "1") {
        disableButton.dataset.confirm = "1";
        disableButton.textContent = "Bekreft deaktivering";
        window.setTimeout(() => {
          if (disableButton.isConnected && disableButton.dataset.confirm === "1") {
            disableButton.dataset.confirm = "";
            disableButton.textContent = "Deaktiver";
          }
        }, 5000);
        return;
      }
      disableButton.disabled = true;
      try {
        await request("disable", { method: "POST", body: { member_id: memberId } });
        showInline(`${item.member_name} er deaktivert.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally { disableButton.disabled = false; }
    }
  });

  el.search?.addEventListener("input", () => {
    state.search = String(el.search.value || "").trim().toLocaleLowerCase("nb");
    renderRows();
  });

  document.getElementById("refreshAllButton")?.addEventListener("click", () => { state.key = ""; setTimeout(() => load(true), 50); });
  document.getElementById("clubSelect")?.addEventListener("change", () => { state.key = ""; setTimeout(() => load(true), 100); });
  window.addEventListener("bd:portal-view", (event) => { if (event.detail?.target === "players") load(true); });
  load(true);
}
