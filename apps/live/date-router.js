(() => {
  const nativeFetch = window.fetch.bind(window);
  const isolatedProd = window.location.hostname === "dart.ingenting.org" && window.location.pathname.startsWith("/live");
  const apiBase = isolatedProd ? "./api" : "../api";
  const CURRENT_URL = `${apiBase}/dartsatlas-public-current.php`;
  const SEASON_ELO_URL = `${apiBase}/dartsatlas-public-season-elo.php`;
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

  async function noCurrentTournamentResponse() {
    let club = null;
    let liveElo = { baseline: 1000, table: [], changes: [] };

    try {
      const response = await nativeFetch(`${SEASON_ELO_URL}?_=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload?.ok) {
        club = payload?.data?.club || null;
        liveElo = payload?.data?.live_elo || liveElo;
      }
    } catch (_) {
      // The public page can still wait for the next tournament even if the
      // optional season-ELO enrichment is temporarily unavailable.
    }

    const body = {
      ok: true,
      generated_at: new Date().toISOString(),
      data: {
        club,
        tournament: null,
        feed: {
          provider: "dartsatlas",
          status: "idle",
          selection: "scheduled_today_or_future",
          reason: "no_current_or_future_tournament_resolved",
        },
        next_matches: [],
        standings: [],
        stats: {
          highlights: {},
          best_match_averages: [],
          top_visits: [],
          live_elo: liveElo,
        },
      },
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  window.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!rawUrl || !rawUrl.includes("dartsatlas-public-live.php") || rawUrl.includes("tournament_id=")) {
      return nativeFetch(input, init);
    }

    const tournamentId = await resolveTournamentId();
    if (!tournamentId) {
      // Never fall back to the API's historical "latest tournament" heuristic.
      // Keep the season ELO visible, but wait for a tournament scheduled today
      // or in the future before showing tournament-specific data.
      return noCurrentTournamentResponse();
    }

    const separator = rawUrl.includes("?") ? "&" : "?";
    const routedUrl = `${rawUrl}${separator}tournament_id=${encodeURIComponent(tournamentId)}`;

    if (typeof input === "string") {
      return nativeFetch(routedUrl, init);
    }

    return nativeFetch(new Request(routedUrl, input), init);
  };
})();
