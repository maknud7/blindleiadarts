const ENDPOINT = "../api/member-onboarding.php";
const LINKS_ENDPOINT = "../api/onboarding-links.php";
const REACTIVATE_ENDPOINT = "../api/member-account-reactivate.php";

const panel = document.getElementById("players");
if (panel) {
  const MEMBER_UI_VERSION = "20260829-0830";
  if (!document.querySelector('link[data-member-onboarding-css]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.dataset.memberOnboardingCss = "1";
    css.href = `./member-onboarding-admin.css?v=${MEMBER_UI_VERSION}`;
    document.head.appendChild(css);
  }

  const block = document.createElement("div");
  block.className = "member-access-block";
  block.innerHTML = `
    <section class="member-account-intro">
      <div>
        <p class="eyebrow">Medlemsadministrasjon</p>
        <h3>Medlem, kontingent og tilgang på ett sted</h3>
        <p>Standardlisten viser aktive medlemmer. Kontingentstatus bruker samme beregning som påmelding og medlemsoppfølging, mens inaktive medlemmer kan hentes frem med filteret.</p>
      </div>
      <div class="member-account-flow" aria-label="Kontoflyt">
        <div><span>1</span><strong>Medlem</strong><small>Canonical medlemsstatus.</small></div>
        <div><span>2</span><strong>Kontingent</strong><small>Samme betalingslogikk overalt.</small></div>
        <div><span>3</span><strong>Tilgang</strong><small>Klubbadmin styrer klubbtilgang.</small></div>
      </div>
    </section>

    <div class="member-toolbar">
      <label class="member-search"><span class="sr-only">Søk i medlemmer</span><input id="memberSearch" type="search" placeholder="Søk navn, medlemsnr. eller e-post …" autocomplete="off"></label>
      <div class="member-filters" role="group" aria-label="Filtrer medlemmer">
        <button type="button" class="active" data-member-filter="active">Aktive</button>
        <button type="button" data-member-filter="needs">Krever handling</button>
        <button type="button" data-member-filter="all">Alle</button>
        <button type="button" data-member-filter="inactive">Inaktive</button>
      </div>
      <span id="memberAccessCount" class="pill">—</span>
    </div>

    <div id="memberAccessSummary" class="member-access-summary"></div>
    <div id="memberInviteResult" class="member-invite-result hidden"></div>
    <div id="memberPendingRegistrations" class="member-pending hidden"></div>

    <div class="table-wrap member-access-table-wrap">
      <table>
        <thead><tr><th>Medlem</th><th>Kontingent</th><th>Brukerkonto og tilgang</th><th>Handling</th></tr></thead>
        <tbody id="memberAccessRows"></tbody>
      </table>
    </div>

    <details class="member-new-person">
      <summary>Ny person som ikke finnes i medlemslisten</summary>
      <div>
        <p>Bruk generell registreringslenke bare når personen ikke allerede finnes som medlem/spiller. Har personen spilt tidligere, bruk aktiveringsknappen på riktig medlem i listen over.</p>
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

  const state = {
    token: "",
    clubId: 0,
    key: "",
    items: [],
    pending: [],
    permissions: {},
    loading: false,
    filter: "active",
    search: "",
    linkConfig: null,
  };

  const collator = new Intl.Collator("nb-NO", { sensitivity: "base" });
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

  async function reactivateAccount(memberId) {
    const response = await fetch(new URL(REACTIVATE_ENDPOINT, window.location.href), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ club_id: state.clubId, member_id: memberId }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadLinkConfig() {
    if (state.linkConfig) return state.linkConfig;
    const response = await fetch(new URL(LINKS_ENDPOINT, window.location.href), { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Kunne ikke hente adressen for invitasjonslenken.");
    state.linkConfig = payload.data;
    return state.linkConfig;
  }

  function onboardingUrl(baseUrl, token) {
    const base = String(baseUrl || "").trim();
    if (!base) throw new Error("Invitasjonsadressen er ikke konfigurert.");
    const root = base.endsWith("/") ? base : `${base}/`;
    const url = new URL("onboarding/", root);
    url.searchParams.set("token", token);
    return url;
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function accountStage(item) {
    const account = item.account || null;
    if (!account) return "none";
    const status = String(account.status || "unclaimed");
    if (status === "active") return "active";
    if (status === "disabled") return "disabled";
    if (status === "invited") {
      const expires = parseDate(account.invite_expires_at);
      if (expires && expires.getTime() > Date.now()) return "invited";
    }
    return "needs";
  }

  function stageInfo(stage) {
    switch (stage) {
      case "active": return ["Aktiv konto", "good"];
      case "invited": return ["Invitasjon sendt", "warning"];
      case "disabled": return ["Deaktivert", "bad"];
      case "needs": return ["Må aktiveres", "neutral"];
      default: return ["Ingen konto", "neutral"];
    }
  }

  function formatMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("nb-NO", {
      style: "currency", currency: "NOK", maximumFractionDigits: 0,
    }).format(number) : "—";
  }

  function formatDate(value, includeTime = false) {
    const date = parseDate(value);
    if (!date) return value ? String(value) : "—";
    return new Intl.DateTimeFormat("nb-NO", includeTime
      ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "2-digit", year: "numeric" }
    ).format(date);
  }

  function normalizeName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("nb");
  }

  function isInactiveMember(item) {
    return item.membership?.member_active === false
      || String(item.membership?.reason_code || "") === "membership_inactive";
  }

  function requiresAction(item) {
    if (isInactiveMember(item)) return false;
    const duesNeedsAction = Boolean(item.membership?.action_required);
    const accountNeedsAction = accountStage(item) !== "active";
    return duesNeedsAction || accountNeedsAction;
  }

  function duesCell(membership) {
    if (!membership || membership.status === "unavailable") {
      return `<span class="badge neutral">Ukjent</span><small>Kunne ikke beregne kontingentstatus</small>`;
    }

    const reason = String(membership.reason_code || "");
    const currentLabel = membership.current_period_label || "inneværende måned";
    const previousLabel = membership.previous_period_label || "forrige måned";
    const missed = Number(membership.missed_closed_months || 0);
    const remaining = Number(membership.current_remaining || 0);

    switch (reason) {
      case "membership_inactive":
        return `<span class="badge neutral">Inaktivt medlem</span><small>Skjult fra standardlisten</small>`;
      case "payment_not_required":
        return `<span class="badge good">Ikke fast kontingent</span><small>Betaling er ikke påkrevd</small>`;
      case "dues_not_started":
        return `<span class="badge neutral">Ikke startet</span><small>Kontingent starter ${escapeHtml(formatDate(membership.dues_start))}</small>`;
      case "payment_too_far_overdue":
        return `<span class="badge bad">Kontingent mangler</span><small>${missed} avsluttede måneder uten betaling</small>`;
      case "stripe_needs_attention":
        return `<span class="badge warning">Fast betaling feiler</span><small>Stripe trenger oppfølging</small>`;
      case "active_autodebit":
        return `<span class="badge good">Fast betaling aktiv</span><small>Stripe-abonnement</small>`;
      case "previous_period_incomplete":
        return `<span class="badge warning">Kontingent mangler</span><small>${escapeHtml(previousLabel)} er ikke fullt betalt</small>`;
      case "current_period_incomplete":
        return `<span class="badge warning">Denne måneden</span><small>${remaining > 0 ? `${formatMoney(remaining)} mangler · ` : ""}${escapeHtml(currentLabel)}</small>`;
      case "paid":
        return `<span class="badge good">Betalt</span><small>${escapeHtml(currentLabel)}</small>`;
      default:
        return `<span class="badge good">OK</span><small>${escapeHtml(currentLabel)}</small>`;
    }
  }

  function accessLabel(level) {
    switch (String(level || "player")) {
      case "super_admin": return "Superadmin";
      case "club_admin": return "Klubbadmin";
      default: return "Medlem";
    }
  }

  function accessControlHtml(item, stage) {
    const account = item.account || null;
    if (!account || stage !== "active") return "";

    const level = String(account.access_level || "player");
    const accountId = Number(account.id || 0);
    const currentAccountId = Number(state.permissions.current_user_account_id || 0);
    const canGrantSuper = Boolean(state.permissions.can_grant_super_admin);
    const canEdit = Boolean(state.permissions.can_manage_roles)
      && accountId > 0
      && accountId !== currentAccountId
      && (level !== "super_admin" || canGrantSuper);

    if (!canEdit) {
      const own = accountId === currentAccountId ? " · deg" : "";
      return `<div class="member-access-level readonly"><span>Tilgang</span><strong>${escapeHtml(accessLabel(level))}${own}</strong></div>`;
    }

    const options = [
      ["player", "Medlem"],
      ["club_admin", "Klubbadmin"],
      ...(canGrantSuper ? [["super_admin", "Superadmin"]] : []),
    ];

    return `<div class="member-access-level">
      <label><span>Tilgang</span><select class="member-access-select" aria-label="Tilgangsnivå for ${escapeHtml(item.member_name)}">
        ${options.map(([value, label]) => `<option value="${value}"${value === level ? " selected" : ""}>${label}</option>`).join("")}
      </select></label>
      <button type="button" class="button secondary member-access-save" data-account-id="${accountId}">Lagre</button>
    </div>`;
  }

  function accountDetails(item, stage) {
    const account = item.account || null;
    let details = "";
    if (stage === "active") {
      const email = account?.email ? escapeHtml(account.email) : "E-post mangler";
      const login = account?.last_login_at ? `Sist innlogget ${escapeHtml(formatDate(account.last_login_at, true))}` : "Ikke logget inn ennå";
      details = `<small>${email}</small><small>${login}</small>`;
    } else if (stage === "invited") {
      details = `<small>Aktiveringslenke gyldig til ${escapeHtml(formatDate(account?.invite_expires_at, true))}</small>`;
    } else if (stage === "disabled") {
      details = `<small>${account?.email ? escapeHtml(account.email) : "Ingen e-post lagret"}</small><small>Innlogging er sperret</small>`;
    } else if (stage === "needs") {
      details = `<small>Kontoen finnes, men aktiveringen er ikke ferdig</small>`;
    } else {
      details = `<small>Spillerprofilen beholdes når konto opprettes</small>`;
    }
    return `${details}${accessControlHtml(item, stage)}`;
  }

  function actionHtml(item, stage) {
    const account = item.account || null;
    const isOwnAccount = Number(account?.id || 0) === Number(state.permissions.current_user_account_id || 0);
    if (stage === "active") {
      return isOwnAccount
        ? `<small class="muted">Din brukerkonto</small>`
        : `<button type="button" class="button quiet member-disable">Deaktiver konto</button>`;
    }
    if (stage === "disabled" && account?.claimed_at && account?.email) {
      return `<button type="button" class="button secondary member-reactivate">Aktiver igjen</button>`;
    }
    if (stage === "invited") {
      return `<button type="button" class="button secondary member-invite">Ny aktiveringslenke</button>`;
    }
    return `<button type="button" class="button member-invite">Send aktiveringslenke</button>`;
  }

  function matchesFilter(item) {
    const inactive = isInactiveMember(item);
    if (state.filter === "active" && inactive) return false;
    if (state.filter === "inactive" && !inactive) return false;
    if (state.filter === "needs" && !requiresAction(item)) return false;

    if (!state.search) return true;
    const haystack = `${item.member_name || ""} ${item.player?.display_name || ""} ${item.membership?.member_number || ""} ${item.account?.email || ""}`.toLocaleLowerCase("nb");
    return haystack.includes(state.search);
  }

  function sortedVisibleItems() {
    return state.items.filter(matchesFilter).sort((a, b) => {
      const actionOrder = Number(requiresAction(b)) - Number(requiresAction(a));
      if (actionOrder !== 0) return actionOrder;
      return collator.compare(a.player?.display_name || a.member_name || "", b.player?.display_name || b.member_name || "");
    });
  }

  function renderRows() {
    const items = sortedVisibleItems();
    el.count.textContent = state.filter === "all"
      ? `${items.length} medlemmer`
      : `${items.length} av ${state.items.length}`;

    if (!items.length) {
      el.rows.innerHTML = `<tr class="member-empty-row"><td colspan="4"><div class="empty">Ingen medlemmer passer filteret.</div></td></tr>`;
      return;
    }

    el.rows.innerHTML = items.map((item) => {
      const stage = accountStage(item);
      const [label, tone] = stageInfo(stage);
      const playerName = item.player?.display_name || item.member_name;
      const memberNumber = item.membership?.member_number || item.member_number || null;
      const inactiveClass = isInactiveMember(item) ? " member-row-inactive" : "";
      return `<tr class="${inactiveClass.trim()}" data-member-id="${Number(item.member_id)}">
        <td data-label="Medlem"><strong>${escapeHtml(playerName)}</strong>${memberNumber ? `<small>Medlemsnr. ${escapeHtml(memberNumber)}</small>` : ""}</td>
        <td data-label="Kontingent">${duesCell(item.membership)}</td>
        <td data-label="Brukerkonto"><span class="badge ${tone}">${escapeHtml(label)}</span>${accountDetails(item, stage)}</td>
        <td data-label="Handling" class="member-access-actions">${actionHtml(item, stage)}</td>
      </tr>`;
    }).join("");
  }

  function memberOptions(registration) {
    const exact = normalizeName(registration.display_name);
    return state.items
      .filter((item) => !isInactiveMember(item) && accountStage(item) !== "active")
      .map((item) => {
        const selected = normalizeName(item.member_name) === exact ? " selected" : "";
        const [label] = stageInfo(accountStage(item));
        return `<option value="${Number(item.member_id)}"${selected}>${escapeHtml(item.member_name)} · ${escapeHtml(label)}</option>`;
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
      <div class="member-pending-head">
        <div><p class="eyebrow">Krever handling</p><h3>Nye registreringer må kobles til riktig medlem</h3><p>Hvis personen har spilt tidligere, velg eksisterende medlem. Da følger kamper, ELO og statistikk med videre.</p></div>
        <span class="pill">${state.pending.length}</span>
      </div>
      <div class="member-pending-list">${state.pending.map((item) => `
        <article class="member-pending-card" data-open-invite-id="${Number(item.id)}">
          <div class="member-pending-person"><span class="badge warning">Ny registrering</span><strong>${escapeHtml(item.display_name)}</strong><small>${escapeHtml(item.email)}</small></div>
          <div class="member-preserve-note"><strong>Har personen spilt før?</strong><span>Koble til eksisterende medlem for å bevare spiller-ID, ELO og historikk.</span></div>
          <label><span>Eksisterende medlem</span><select class="member-pending-select"><option value="">Velg medlem …</option>${memberOptions(item)}</select></label>
          <button type="button" class="button member-approve-open">Koble og aktiver konto</button>
          <small class="member-pending-foot">Finnes personen ikke i listen, opprett medlemmet først og gå deretter tilbake hit.</small>
        </article>`).join("")}</div>`;
  }

  function renderSummary() {
    const active = state.items.filter((item) => !isInactiveMember(item)).length;
    const needs = state.items.filter(requiresAction).length;
    const inactive = state.items.filter(isInactiveMember).length;
    const cards = [
      ["active", "Aktive", active],
      ["needs", "Krever handling", needs],
      ["inactive", "Inaktive", inactive],
    ];
    el.summary.innerHTML = cards.map(([filter, label, value]) =>
      `<button type="button" data-summary-filter="${filter}"><strong>${value}</strong><span>${escapeHtml(label)}</span></button>`
    ).join("");
  }

  function render(data) {
    state.items = data.items || [];
    state.pending = data.pending_registrations || [];
    state.permissions = data.permissions || {};
    renderSummary();
    renderPending();
    renderRows();
  }

  async function load(force = false) {
    const token = localStorage.getItem("bd:token") || "";
    const clubId = Number(localStorage.getItem("bd:selectedClubId") || 0);
    const key = `${token}:${clubId}`;
    if (!token || !clubId || state.loading || (!force && key === state.key)) return;
    state.token = token;
    state.clubId = clubId;
    state.key = key;
    state.loading = true;
    try {
      render(await request("list"));
    } catch (error) {
      state.key = "";
      el.rows.innerHTML = `<tr><td colspan="4"><div class="empty">${escapeHtml(error.message)}</div></td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  function showInline(message, tone = "info") {
    el.result.className = `member-invite-result ${tone}`;
    el.result.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
  }

  async function showInviteLink(title, inviteToken, expiresAt, note, target = "runtime") {
    const config = await loadLinkConfig();
    const isMemberInvite = target === "member";
    const baseUrl = isMemberInvite ? config.member_onboarding_base_url : config.runtime_base_url;
    const url = onboardingUrl(baseUrl, inviteToken);
    const productionLink = isMemberInvite || String(config.app_env || "") === "prod";
    const environmentLabel = productionLink ? "Produksjonslenke" : "Testlenke";
    const environmentTone = productionLink ? "good" : "warning";
    const environmentNote = !productionLink ? "Dette er en testlenke og skal ikke sendes til medlemmer." : "";

    el.result.className = "member-invite-result good";
    el.result.innerHTML = `<div><strong>${escapeHtml(title)}</strong><small><span class="badge ${environmentTone}">${environmentLabel}</span> ${escapeHtml(note)} ${escapeHtml(environmentNote)} Lenken er gyldig til ${escapeHtml(formatDate(expiresAt, true))}.</small></div><div class="member-link-row"><input readonly value="${escapeHtml(url.toString())}"><button type="button" class="button member-copy-link">Kopier lenke</button></div>`;
    el.result.querySelector(".member-copy-link")?.addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(url.toString());
      event.currentTarget.textContent = "Kopiert";
    });
    el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setFilter(filter) {
    state.filter = filter || "active";
    block.querySelectorAll("[data-member-filter]").forEach((button) =>
      button.classList.toggle("active", button.dataset.memberFilter === state.filter)
    );
    renderRows();
  }

  el.openInvite?.addEventListener("click", async () => {
    el.openInvite.disabled = true;
    try {
      const data = await request("invite-open", { method: "POST", body: {} });
      await showInviteLink("Registreringslenke for ny person", data.token, data.expires_at, "Mottakeren fyller selv inn navn, e-post og passord. Klubben må deretter koble registreringen til et medlem.", "runtime");
    } catch (error) {
      showInline(error.message, "bad");
    } finally {
      el.openInvite.disabled = false;
    }
  });

  block.addEventListener("click", async (event) => {
    const filterButton = event.target.closest("[data-member-filter]");
    if (filterButton) {
      setFilter(filterButton.dataset.memberFilter || "active");
      return;
    }

    const summaryButton = event.target.closest("[data-summary-filter]");
    if (summaryButton) {
      setFilter(summaryButton.dataset.summaryFilter || "active");
      return;
    }

    const pendingCard = event.target.closest("[data-open-invite-id]");
    const approveButton = event.target.closest(".member-approve-open");
    if (pendingCard && approveButton) {
      const inviteId = Number(pendingCard.dataset.openInviteId || 0);
      const memberId = Number(pendingCard.querySelector(".member-pending-select")?.value || 0);
      if (!memberId) {
        showInline("Velg hvilket eksisterende medlem registreringen skal kobles til.", "bad");
        return;
      }
      approveButton.disabled = true;
      try {
        const data = await request("approve-open", { method: "POST", body: { invite_id: inviteId, member_id: memberId } });
        showInline(`${data.name} er koblet til eksisterende medlem og kontoen er aktiv.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally {
        approveButton.disabled = false;
      }
      return;
    }

    const row = event.target.closest("tr[data-member-id]");
    if (!row) return;
    const memberId = Number(row.dataset.memberId || 0);
    const item = state.items.find((entry) => Number(entry.member_id) === memberId);
    if (!item) return;

    const accessButton = event.target.closest(".member-access-save");
    if (accessButton) {
      const accountId = Number(accessButton.dataset.accountId || 0);
      const select = row.querySelector(".member-access-select");
      const accessLevel = String(select?.value || "");
      const oldLevel = String(item.account?.access_level || "player");
      const touchesSuperAdmin = accessLevel === "super_admin" || oldLevel === "super_admin";

      if (touchesSuperAdmin && accessButton.dataset.confirm !== "1") {
        accessButton.dataset.confirm = "1";
        accessButton.textContent = "Bekreft";
        window.setTimeout(() => {
          if (accessButton.isConnected && accessButton.dataset.confirm === "1") {
            accessButton.dataset.confirm = "";
            accessButton.textContent = "Lagre";
          }
        }, 5000);
        return;
      }

      accessButton.disabled = true;
      try {
        await request("set-access-level", {
          method: "POST",
          body: { account_id: accountId, access_level: accessLevel },
        });
        showInline(`${item.member_name} har nå tilgangsnivå ${accessLabel(accessLevel)}.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally {
        accessButton.disabled = false;
      }
      return;
    }

    const inviteButton = event.target.closest(".member-invite");
    if (inviteButton) {
      inviteButton.disabled = true;
      try {
        const data = await request("invite", { method: "POST", body: { member_id: memberId } });
        await showInviteLink(`Aktiveringslenke til ${item.member_name}`, data.token, data.expires_at, "Lenken er koblet direkte til dette medlemmet. Når den fullføres brukes den eksisterende spillerprofilen.", "member");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally {
        inviteButton.disabled = false;
      }
      return;
    }

    const reactivateButton = event.target.closest(".member-reactivate");
    if (reactivateButton) {
      reactivateButton.disabled = true;
      try {
        await reactivateAccount(memberId);
        showInline(`${item.member_name} kan logge inn igjen med samme e-post og passord.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally {
        reactivateButton.disabled = false;
      }
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
            disableButton.textContent = "Deaktiver konto";
          }
        }, 5000);
        return;
      }
      disableButton.disabled = true;
      try {
        await request("disable", { method: "POST", body: { member_id: memberId } });
        showInline(`${item.member_name} er deaktivert. Spillerhistorikken er ikke endret.`, "good");
        state.key = "";
        await load(true);
      } catch (error) {
        showInline(error.message, "bad");
      } finally {
        disableButton.disabled = false;
      }
    }
  });

  el.search?.addEventListener("input", () => {
    state.search = String(el.search.value || "").trim().toLocaleLowerCase("nb");
    renderRows();
  });

  document.getElementById("refreshAllButton")?.addEventListener("click", () => {
    state.key = "";
    setTimeout(() => load(true), 50);
  });
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    state.key = "";
    setTimeout(() => load(true), 100);
  });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "players") load(true);
  });
  loadLinkConfig().catch(() => null);
  load(true);
}
