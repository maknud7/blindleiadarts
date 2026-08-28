const FOCUS_API_ROOT = "../api/v1";
const focusHost = document.getElementById("tournaments");

if (focusHost) {
  const appliedClubs = new Set();
  let userTouchedTournament = false;
  let selectionRequest = 0;

  function clubId() {
    return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
  }

  function timestamp(value) {
    if (!value) return Number.NaN;
    const date = new Date(String(value).replace(" ", "T"));
    return date.getTime();
  }

  function tournamentTime(item) {
    const start = timestamp(item?.start_at);
    if (Number.isFinite(start)) return start;
    const opens = timestamp(item?.registration_opens_at);
    return Number.isFinite(opens) ? opens : Number.POSITIVE_INFINITY;
  }

  function preferredTournament(items) {
    if (!Array.isArray(items) || !items.length) return null;
    const now = Date.now();
    const unfinished = items.filter((item) => !["completed", "archived"].includes(String(item?.status || "")));
    const active = unfinished
      .filter((item) => String(item?.status || "") === "in_progress")
      .sort((a, b) => tournamentTime(b) - tournamentTime(a));
    if (active.length) return active[0];

    const upcoming = unfinished
      .filter((item) => Number.isFinite(tournamentTime(item)) && tournamentTime(item) >= now)
      .sort((a, b) => tournamentTime(a) - tournamentTime(b));
    if (upcoming.length) return upcoming[0];

    const latestUnfinished = unfinished
      .filter((item) => Number.isFinite(tournamentTime(item)))
      .sort((a, b) => tournamentTime(b) - tournamentTime(a));
    if (latestUnfinished.length) return latestUnfinished[0];

    return items.slice().sort((a, b) => {
      const timeA = tournamentTime(a);
      const timeB = tournamentTime(b);
      if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA;
      if (Number.isFinite(timeA) !== Number.isFinite(timeB)) return Number.isFinite(timeA) ? -1 : 1;
      return Number(b?.id || 0) - Number(a?.id || 0);
    })[0] || null;
  }

  async function registrationTournaments(id) {
    const response = await fetch(`${FOCUS_API_ROOT}/clubs/${encodeURIComponent(id)}/registration-tournaments`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) return [];
    return payload.data?.items || [];
  }

  async function waitForTournamentOption(select, tournamentId) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ([...select.options].some((option) => Number(option.value) === tournamentId)) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 75));
    }
    return false;
  }

  async function applyPreferredTournament() {
    const id = clubId();
    const select = document.getElementById("tcTournament");
    if (!id || !select || appliedClubs.has(id) || userTouchedTournament) return;
    const request = ++selectionRequest;
    const items = await registrationTournaments(id).catch(() => []);
    if (request !== selectionRequest || userTouchedTournament || clubId() !== id || !items.length) return;
    const preferred = preferredTournament(items);
    const preferredId = Number(preferred?.id || 0);
    if (!preferredId) return;
    const ready = await waitForTournamentOption(select, preferredId);
    if (!ready || request !== selectionRequest || userTouchedTournament || clubId() !== id) return;
    appliedClubs.add(id);
    if (Number(select.value || 0) === preferredId) return;
    select.value = String(preferredId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function centerCurrentStep() {
    const nav = document.getElementById("tcLeaderSteps");
    if (!nav || window.innerWidth > 1050) return;
    const current = nav.querySelector('[aria-current="step"]') || nav.querySelector('[data-state="current"]');
    if (!current) return;
    const left = Math.max(0, current.offsetLeft - ((nav.clientWidth - current.offsetWidth) / 2));
    nav.scrollTo({ left, behavior: "smooth" });
  }

  function normalizeAutomaticAssignment() {
    const nextButton = focusHost.querySelector('[data-leader-action="reconcile"]');
    if (nextButton) {
      const next = nextButton.closest("#tcLeaderNext");
      const copy = next?.querySelector(".tc-leader-next-copy");
      const text = copy?.querySelector("p");
      if (text) text.textContent = "Kampmotoren fordeler automatisk neste tilgjengelige kamp når en valgt skive er ledig.";
      nextButton.removeAttribute("data-leader-action");
      nextButton.dataset.followGroupPlay = "true";
      nextButton.textContent = "Følg gruppespillet";
    }

    const reconcile = document.getElementById("opsReconcile");
    if (reconcile) reconcile.hidden = true;
  }

  function syncFocus() {
    normalizeAutomaticAssignment();
    window.requestAnimationFrame(centerCurrentStep);
  }

  focusHost.addEventListener("change", (event) => {
    if (event.target?.id === "tcTournament" && event.isTrusted) userTouchedTournament = true;
  }, true);

  focusHost.addEventListener("click", (event) => {
    const follow = event.target.closest('[data-follow-group-play="true"]');
    if (!follow) return;
    event.preventDefault();
    focusHost.querySelector('[data-leader-step="groups"]')?.click();
  });

  document.getElementById("clubSelect")?.addEventListener("change", () => {
    userTouchedTournament = false;
    selectionRequest += 1;
    window.setTimeout(() => applyPreferredTournament().catch(() => undefined), 100);
  });

  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target !== "tournaments") return;
    applyPreferredTournament().catch(() => undefined);
    window.setTimeout(syncFocus, 0);
  });

  window.addEventListener("resize", () => window.requestAnimationFrame(centerCurrentStep));

  const observer = new MutationObserver(() => syncFocus());
  observer.observe(focusHost, { childList: true, subtree: true });

  applyPreferredTournament().catch(() => undefined);
  syncFocus();
}
