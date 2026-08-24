(() => {
  const nativeFetch = window.fetch.bind(window);
  const CURRENT_URL = "./api/dartsatlas-public-current.php";
  let cachedTournamentId = null;
  let cacheExpiresAt = 0;
  let resolverPromise = null;

  async function resolveTournamentId() {
    if (Date.now() < cacheExpiresAt) return cachedTournamentId;
    if (resolverPromise) return resolverPromise;

    resolverPromise = (async () => {
      try {
        const response = await nativeFetch(`${CURRENT_URL}?_=${Date.now()}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) {
          cachedTournamentId = null;
          cacheExpiresAt = Date.now() + 15000;
          return null;
        }
        const id = Number(payload?.data?.tournament_id || 0);
        cachedTournamentId = Number.isFinite(id) && id > 0 ? id : null;
        cacheExpiresAt = Date.now() + (cachedTournamentId ? 60000 : 15000);
        return cachedTournamentId;
      } catch (_) {
        cachedTournamentId = null;
        cacheExpiresAt = Date.now() + 15000;
        return null;
      } finally {
        resolverPromise = null;
      }
    })();

    return resolverPromise;
  }

  window.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!rawUrl || !rawUrl.includes("dartsatlas-public-live.php") || rawUrl.includes("tournament_id=")) {
      return nativeFetch(input, init);
    }

    const tournamentId = await resolveTournamentId();
    if (!tournamentId) {
      return nativeFetch(input, init);
    }

    const separator = rawUrl.includes("?") ? "&" : "?";
    const routedUrl = `${rawUrl}${separator}tournament_id=${encodeURIComponent(tournamentId)}`;

    if (typeof input === "string") {
      return nativeFetch(routedUrl, init);
    }

    return nativeFetch(new Request(routedUrl, input), init);
  };
})();
