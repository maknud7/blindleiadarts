(() => {
  const originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const match = window.location.pathname.match(/\/live\/(\d{4})\/?$/i);
  const liveCode = match?.[1] || "";
  const legacyClub = new URLSearchParams(window.location.search).get("club") || "";
  const allowedProfiles = new Set(["blindleia", "broadcast-dark"]);

  function liveBasePath() {
    const match = window.location.pathname.match(/^(.*\/live)(?:\/|$)/i);
    return match ? `${match[1]}/` : "/live/";
  }

  function siteBasePath() {
    const match = window.location.pathname.match(/^(.*)\/live(?:\/|$)/i);
    const prefix = match?.[1] || "";
    return prefix ? `${prefix}/` : "/";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Kunne ikke laste ${src}`));
      document.body.appendChild(script);
    });
  }

  function applyClubProfile(club) {
    const requested = String(club?.live_display_profile || "blindleia");
    const profile = allowedProfiles.has(requested) ? requested : "blindleia";
    document.body.dataset.liveProfile = profile;
    document.documentElement.dataset.liveProfile = profile;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", profile === "broadcast-dark" ? "#061526" : "#f3f8fb");
    window.__BD_LIVE_CLUB__ = club ? { ...club, live_display_profile: profile } : null;
  }

  function showCodeEntry() {
    document.body.classList.remove("phase-loading", "phase-standby", "phase-live", "phase-checkin");
    document.body.classList.add("phase-code-entry");
    document.getElementById("standbyState")?.classList.add("hidden");
    document.getElementById("activeExperience")?.classList.add("hidden");
    document.getElementById("codeEntryState")?.classList.remove("hidden");

    const form = document.getElementById("liveCodeForm");
    const input = document.getElementById("liveCodeInput");
    const error = document.getElementById("liveCodeError");
    if (!form || !input) return;

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 4);
      if (error) error.textContent = "";
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!/^\d{4}$/.test(code)) {
        if (error) error.textContent = "Skriv inn en firesifret Live-kode.";
        input.focus();
        return;
      }
      window.location.assign(`${liveBasePath()}${code}`);
    });

    window.setTimeout(() => input.focus(), 0);
  }

  function showInvalidLink(message) {
    document.body.classList.remove("phase-loading", "phase-code-entry");
    document.body.classList.add("phase-standby");
    document.getElementById("codeEntryState")?.classList.add("hidden");
    document.getElementById("standbyState")?.classList.remove("hidden");
    const next = document.getElementById("standbyNext");
    next?.classList.remove("hidden");
    const name = document.getElementById("standbyNextName");
    const when = document.getElementById("standbyNextWhen");
    if (name) name.textContent = "Live-lenken finnes ikke";
    if (when) when.textContent = message || "Kontroller adressen og prøv igjen.";
  }

  async function resolveClub() {
    if (!liveCode) return null;
    const endpoint = `${siteBasePath()}api/club-live.php?code=${encodeURIComponent(liveCode)}`;
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.data?.club?.slug) {
      throw new Error(payload?.error?.message || "Ugyldig Live-lenke.");
    }
    return payload.data.club;
  }

  function keepProfileInSync() {
    if (!liveCode) return;
    window.setInterval(async () => {
      try {
        const club = await resolveClub();
        if (club) applyClubProfile(club);
      } catch {
        // A temporary profile lookup error must never interrupt the live board.
      }
    }, 15000);
  }

  async function boot() {
    if (!liveCode && !legacyClub) {
      applyClubProfile(null);
      showCodeEntry();
      return;
    }

    let cleanRoute = false;
    try {
      const club = await resolveClub();
      if (club) {
        applyClubProfile(club);
        const runtimeUrl = new URL(window.location.href);
        runtimeUrl.searchParams.set("club", String(club.slug));
        window.history.replaceState(null, "", runtimeUrl);
        cleanRoute = true;
      } else {
        applyClubProfile(null);
      }

      await loadScript("./app.js?v=20260901-1245");

      if (cleanRoute) window.history.replaceState(null, "", originalUrl);

      await loadScript("./live-v2.js?v=20260901-1245");
      await loadScript("./profile-runtime.js?v=20260901-1245");
      keepProfileInSync();
    } catch (error) {
      if (cleanRoute) window.history.replaceState(null, "", originalUrl);
      showInvalidLink(error?.message || "Kunne ikke åpne Live-lenken.");
    }
  }

  boot();
})();
