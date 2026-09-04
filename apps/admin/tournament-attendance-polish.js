const attendanceHost = document.getElementById("tournaments");

if (attendanceHost) {
  const API_ROOT = "../api/v1";
  const CLUB_LIVE_ENDPOINT = "../api/club-live.php";
  const POLL_INTERVAL_MS = 3500;
  let polishing = false;
  let currentContext = window.__bdTournamentContext || null;
  let pollTimer = null;
  let syncBusy = false;
  let lastRefreshAt = 0;
  let liveRequestKey = "";

  const style = document.createElement("style");
  style.textContent = `
    .tc-leader-utility{display:flex;align-items:center;justify-content:flex-end;gap:6px}
    .tc-leader-utility .button{min-height:40px;padding:8px 10px;white-space:nowrap}
    @media(max-width:760px){
      .tc-leader-utility{grid-column:2;grid-row:2}
      .tc-leader-utility .button{min-height:38px;padding:7px 9px;font-size:11px}
    }
  `;
  document.head.appendChild(style);

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  function clubId() {
    return Number(currentContext?.clubId || document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
  }

  function tournamentId() {
    return Number(currentContext?.id || document.getElementById("tcTournament")?.value || 0);
  }

  function tournamentStatus() {
    return String(currentContext?.status || "");
  }

  function numberText(id) {
    const value = Number(document.getElementById(id)?.textContent || 0);
    return Number.isFinite(value) ? value : 0;
  }

  function setText(node, value) {
    if (node && String(node.textContent || "") !== value) node.textContent = value;
  }

  function localAttendanceSignature() {
    return `${numberText("tcAllCount")}:${numberText("tcCheckedCount")}:${numberText("tcPendingCount")}`;
  }

  function remoteAttendanceSignature(tournament) {
    const registrations = Array.isArray(tournament?.registrations) ? tournament.registrations : [];
    const active = registrations.filter((item) => ["registered", "checked_in", "waitlisted", "paused"].includes(String(item.status)));
    const checked = active.filter((item) => String(item.status) === "checked_in").length;
    const pending = active.filter((item) => String(item.status) === "registered").length;
    return `${active.length}:${checked}:${pending}`;
  }

  function ensureLiveButton() {
    const contextRow = document.querySelector("#tcLeaderV2 .tc-leader-context");
    const refresh = document.getElementById("tcLeaderRefresh");
    if (!contextRow || !refresh) return;

    let utility = contextRow.querySelector(".tc-leader-utility");
    if (!utility) {
      utility = document.createElement("div");
      utility.className = "tc-leader-utility";
      refresh.before(utility);
      utility.appendChild(refresh);
    }

    let live = document.getElementById("tcLeaderLive");
    if (!live) {
      live = document.createElement("a");
      live.id = "tcLeaderLive";
      live.className = "button secondary";
      live.href = "../live/";
      live.target = "_blank";
      live.rel = "noopener";
      live.textContent = "Live ↗";
      live.title = "Åpne klubbens Live-skjerm i ny fane";
      utility.prepend(live);
    }
  }

  async function updateLiveUrl(force = false) {
    ensureLiveButton();
    const live = document.getElementById("tcLeaderLive");
    const id = clubId();
    if (!live || !id) return;
    const key = String(id);
    if (!force && liveRequestKey === key && live.dataset.resolved === "1") return;
    liveRequestKey = key;
    try {
      const endpoint = new URL(CLUB_LIVE_ENDPOINT, window.location.href);
      endpoint.searchParams.set("club_id", key);
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.data?.live_url) throw new Error("Live-lenke mangler");
      live.href = String(payload.data.live_url);
      live.dataset.resolved = "1";
    } catch {
      live.href = "../live/";
      live.dataset.resolved = "0";
      liveRequestKey = "";
    }
  }

  function polishAttendanceCopy() {
    if (polishing) return;
    polishing = true;
    try {
      ensureLiveButton();

      const stageCountLabel = document.querySelector("#tcStageCheckin .tc-stage-count span");
      setText(stageCountLabel, "sjekket inn");

      const next = document.getElementById("tcLeaderNext");
      if (!next) return;
      const total = numberText("tcAllCount");
      const checked = numberText("tcCheckedCount");
      const pending = numberText("tcPendingCount");
      const checkinButton = next.querySelector('[data-leader-action="checkin"]');
      if (checkinButton) {
        const title = next.querySelector(".tc-leader-next-copy strong");
        const text = next.querySelector(".tc-leader-next-copy p");
        setText(title, total > 0 ? `${checked} av ${total} sjekket inn` : `${checked} sjekket inn`);
        if (pending > 0) setText(text, `${pending} påmeldte mangler innsjekk.`);
      }

      [...next.querySelectorAll("*")].forEach((node) => {
        const text = String(node.textContent || "").trim();
        if (!text || node.children.length) return;

        if (text === "Oppmøtet ser klart ut") {
          setText(node, "Klar til å låse startfelt");
          return;
        }
        const readyMatch = text.match(/^(\d+) spillere blir med$/);
        if (readyMatch) {
          setText(node, `${readyMatch[1]} spillere er sjekket inn`);
          return;
        }
        const pendingMatch = text.match(/^(\d+) påmeldte er ikke sjekket inn og blir markert som ikke møtt\.$/);
        if (pendingMatch) {
          setText(node, `${pendingMatch[1]} påmeldte er ikke sjekket inn og blir markert som ikke møtt. Kun sjekket inn går videre til trekning og puljer.`);
          return;
        }
        if (text === "Alle med bekreftet plass er sjekket inn.") {
          setText(node, "Alle med bekreftet plass er sjekket inn. Når startfeltet låses, er dette spillerne som går videre til trekning og puljer.");
        }
      });

      const lockButton = next.querySelector('[data-leader-action="finish-checkin"]');
      if (lockButton) {
        setText(lockButton, "Lås startfelt");
        lockButton.title = "Lås oppmøtet. Bare sjekket inn tas med i trekning og puljer.";
      }
    } finally {
      polishing = false;
    }
  }

  async function checkAttendanceNow() {
    if (syncBusy || document.hidden || tournamentStatus() !== "draft" || !token()) return;
    const id = tournamentId();
    if (!id) return;
    syncBusy = true;
    try {
      const response = await fetch(`${API_ROOT}/tournaments/${id}`, {
        headers: { Authorization: `Bearer ${token()}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) return;
      const tournament = payload.data?.tournament || null;
      if (!tournament || Number(tournament.id || 0) !== id) return;

      if (remoteAttendanceSignature(tournament) !== localAttendanceSignature()) {
        const now = Date.now();
        if (now - lastRefreshAt > 1500) {
          lastRefreshAt = now;
          document.getElementById("tcRefresh")?.click();
        }
      }
    } catch {
      // The normal room loader remains the source of user-facing errors.
    } finally {
      syncBusy = false;
    }
  }

  function restartPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (document.hidden || tournamentStatus() !== "draft" || !tournamentId()) return;
    pollTimer = window.setInterval(() => checkAttendanceNow(), POLL_INTERVAL_MS);
  }

  const observer = new MutationObserver(polishAttendanceCopy);
  observer.observe(attendanceHost, { childList: true, subtree: true });
  polishAttendanceCopy();
  updateLiveUrl(true);
  restartPolling();

  window.addEventListener("bd:tournament-context", (event) => {
    currentContext = event.detail || currentContext;
    polishAttendanceCopy();
    updateLiveUrl();
    restartPolling();
  });

  document.addEventListener("visibilitychange", () => {
    restartPolling();
    if (!document.hidden) checkAttendanceNow();
  });

  document.getElementById("clubSelect")?.addEventListener("change", () => {
    liveRequestKey = "";
    window.setTimeout(() => updateLiveUrl(true), 80);
  });

  attendanceHost.addEventListener("click", (event) => {
    if (!event.target.closest(".tc-checkin,.tc-remove")) return;
    window.setTimeout(() => checkAttendanceNow(), 700);
  });
}
