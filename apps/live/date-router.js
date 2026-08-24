(() => {
  const nativeFetch = window.fetch.bind(window);
  const isolatedProd = window.location.hostname === "dart.ingenting.org" && window.location.pathname.startsWith("/live");
  const apiBase = isolatedProd ? "./api" : "../api";
  const CURRENT_URL = `${apiBase}/dartsatlas-public-current.php`;
  const LIVE_PROBE_URL = `${apiBase}/dartsatlas-public-live.php`;
  const SEASON_ELO_URL = `${apiBase}/dartsatlas-public-season-elo.php`;
  let cachedTournamentId = null;
  let cacheExpiresAt = 0;
  let resolverPromise = null;

  function osloDateKey() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Oslo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  async function probeRunningTournament(excludeId = null) {
    try {
      // Use the live API's own ranking here. It prioritises tournaments with
      // actual in-progress matches over merely scheduled/ready tournaments.
      // nativeFetch deliberately bypasses this router to avoid recursion.
      const response = await nativeFetch(`${LIVE_PROBE_URL}?route_probe=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) return null;

      const tournament = payload?.data?.tournament || null;
      const id = Number(tournament?.id || 0);
      if (!Number.isFinite(id) || id <= 0 || id === Number(excludeId || 0)) return null;

      const tournamentStatus = String(tournament?.status || "").toLowerCase();
      const feedStatus = String(payload?.data?.feed?.status || "").toLowerCase();
      const isRunning = tournamentStatus === "in_progress" || feedStatus === "live";
      return isRunning ? id : null;
    } catch (_) {
      return null;
    }
  }

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
        const scheduledDate = String(payload?.data?.scheduled_date || "");
        const today = osloDateKey();
        const scheduledId = Number.isFinite(id) && id > 0 ? id : null;

        // DartsAtlas removes a tournament from the upcoming schedule when it
        // starts. At that exact transition the schedule resolver can already
        // point to next week's event. Before accepting a future tournament,
        // ask the live feed whether another tournament is actually running.
        if (scheduledId && scheduledDate && scheduledDate > today) {
          const runningId = await probeRunningTournament(scheduledId);
          if (runningId) {
            cachedTournamentId = runningId;
            cacheExpiresAt = Date.now() + 5000;
            return cachedTournamentId;
          }
        }

        cachedTournamentId = scheduledId;
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
