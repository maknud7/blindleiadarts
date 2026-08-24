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

  function noCurrentTournamentResponse() {
    const body = {
      ok: true,
      generated_at: new Date().toISOString(),
      data: {
        club: null,
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
          live_elo: { baseline: 1000, table: [], changes: [] },
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
      // If the DartsAtlas calendar cannot resolve today or a future event, the
      // public page waits instead of showing an old completed Monday.
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
