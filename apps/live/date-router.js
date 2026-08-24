(() => {
  const nativeFetch = window.fetch.bind(window);
  const isolatedProd = window.location.hostname === "dart.ingenting.org" && window.location.pathname.startsWith("/live");
  const apiBase = isolatedProd ? "./api" : "../api";
  const CURRENT_URL = `${apiBase}/dartsatlas-public-current.php`;
  const ACTIVE_URL = `${apiBase}/dartsatlas-public-active.php`;
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

  function calendarDayDistance(fromKey, toKey) {
    const from = Date.parse(`${fromKey}T00:00:00Z`);
    const to = Date.parse(`${toKey}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.round((to - from) / 86400000);
  }

  async function resolveActiveTournament(beforeTournamentId = null) {
    try {
      const params = new URLSearchParams({ _: String(Date.now()) });
      if (beforeTournamentId) params.set("before_tournament_id", String(beforeTournamentId));
      const response = await nativeFetch(`${ACTIVE_URL}?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload?.ok || !payload?.data?.active) return null;
      const id = Number(payload?.data?.tournament_id || 0);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch (_) {
      return null;
    }
  }

  async function probeRunningTournament(excludeId = null) {
    try {
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
        const activeId = await resolveActiveTournament();
        if (activeId) {
          cachedTournamentId = activeId;
          cacheExpiresAt = Date.now() + 5000;
          return cachedTournamentId;
        }

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

        if (scheduledId && scheduledDate && scheduledDate > today) {
          const runningId = await probeRunningTournament(scheduledId);
          if (runningId) {
            cachedTournamentId = runningId;
            cacheExpiresAt = Date.now() + 5000;
            return cachedTournamentId;
          }

          // DartsAtlas can move a just-started numbered weekly round out of
          // /schedule before our first live snapshot. If the resolver has
          // jumped exactly seven calendar days ahead (#3 -> #4), ask the
          // backend for the preceding numbered round in the same season.
          if (calendarDayDistance(today, scheduledDate) === 7) {
            const previousRoundId = await resolveActiveTournament(scheduledId);
            if (previousRoundId && previousRoundId !== scheduledId) {
              cachedTournamentId = previousRoundId;
              cacheExpiresAt = Date.now() + 5000;
              return cachedTournamentId;
            }
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
      // Optional enrichment only.
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
