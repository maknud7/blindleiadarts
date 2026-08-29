(() => {
  const originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const match = window.location.pathname.match(/\/live\/(\d{4})\/?$/i);
  const liveCode = match?.[1] || "";

  function appBasePath() {
    const lower = window.location.pathname.toLowerCase();
    const index = lower.lastIndexOf("/live/");
    return index >= 0 ? window.location.pathname.slice(0, index + 1) : "/";
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

  function showInvalidLink(message) {
    document.body.classList.remove("phase-loading");
    document.body.classList.add("phase-standby");
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
    const endpoint = `${appBasePath()}api/club-live.php?code=${encodeURIComponent(liveCode)}`;
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.data?.club?.slug) {
      throw new Error(payload?.error?.message || "Ugyldig Live-lenke.");
    }
    return payload.data.club;
  }

  async function boot() {
    let cleanRoute = false;
    try {
      const club = await resolveClub();
      if (club) {
        const runtimeUrl = new URL(window.location.href);
        runtimeUrl.searchParams.set("club", String(club.slug));
        window.history.replaceState(null, "", runtimeUrl);
        cleanRoute = true;
      }

      await loadScript("./app.js?v=20260829-0945");

      if (cleanRoute) {
        window.history.replaceState(null, "", originalUrl);
      }

      await loadScript("./live-v2.js?v=20260828-02");
    } catch (error) {
      if (cleanRoute) {
        window.history.replaceState(null, "", originalUrl);
      }
      showInvalidLink(error?.message || "Kunne ikke åpne Live-lenken.");
    }
  }

  boot();
})();
