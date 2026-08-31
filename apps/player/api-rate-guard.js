(() => {
  const baseFetch = window.fetch.bind(window);
  const MAX_CONCURRENT_GETS = 3;
  const DEFAULT_429_BACKOFF_MS = 3000;

  let activeGets = 0;
  let backoffUntil = 0;
  let wakeTimer = 0;
  const queue = [];
  const inFlight = new Map();

  function requestMeta(input, init = {}) {
    try {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.href);
      const method = String(init.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.origin !== window.location.origin || !url.pathname.includes("/api/")) return null;

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      const auth = headers.get("authorization") || "";
      return {
        url,
        method,
        key: `${method}|${url.href}|${auth}`,
      };
    } catch {
      return null;
    }
  }

  function retryAfterMs(response) {
    const raw = response.headers.get("retry-after");
    if (!raw) return DEFAULT_429_BACKOFF_MS;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(500, seconds * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(500, at - Date.now()) : DEFAULT_429_BACKOFF_MS;
  }

  function schedulePump(delay = 0) {
    window.clearTimeout(wakeTimer);
    wakeTimer = window.setTimeout(pump, Math.max(0, delay));
  }

  function pump() {
    window.clearTimeout(wakeTimer);
    wakeTimer = 0;

    const wait = backoffUntil - Date.now();
    if (wait > 0) {
      schedulePump(wait + 25);
      return;
    }

    while (activeGets < MAX_CONCURRENT_GETS && queue.length) {
      const job = queue.shift();
      activeGets += 1;

      baseFetch(job.input, job.init)
        .then((response) => {
          if (response.status === 429) {
            backoffUntil = Math.max(backoffUntil, Date.now() + retryAfterMs(response));
          }
          job.resolve(response);
        })
        .catch(job.reject)
        .finally(() => {
          activeGets = Math.max(0, activeGets - 1);
          inFlight.delete(job.key);
          pump();
        });
    }
  }

  function queuedFetch(input, init, meta) {
    const existing = inFlight.get(meta.key);
    if (existing) return existing.then((response) => response.clone());

    const leader = new Promise((resolve, reject) => {
      queue.push({ input, init, key: meta.key, resolve, reject });
      pump();
    });
    inFlight.set(meta.key, leader);
    return leader.then((response) => response.clone());
  }

  window.fetch = function rateGuardedFetch(input, init = {}) {
    const meta = requestMeta(input, init);
    if (!meta || !["GET", "HEAD"].includes(meta.method)) return baseFetch(input, init);
    return queuedFetch(input, init, meta);
  };

  window.BlindleiaApiRateGuard = {
    snapshot() {
      return {
        max_concurrent_gets: MAX_CONCURRENT_GETS,
        active_gets: activeGets,
        queued_gets: queue.length,
        in_flight_unique_gets: inFlight.size,
        backoff_until: backoffUntil ? new Date(backoffUntil).toISOString() : null,
      };
    },
  };
})();

(() => {
  const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
    || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || new URLSearchParams(window.location.search).get("pwa") === "test";

  if (!isTestEnvironment || window.__bdTestPastStartOverrideInstalled) return;
  window.__bdTestPastStartOverrideInstalled = true;

  const guardedFetch = window.fetch.bind(window);
  let dashboardCache = { token: "", at: 0, promise: null };

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function shouldPretendStarted(tournament, checkedInIds) {
    const id = Number(tournament?.id || 0);
    if (!id || !checkedInIds.has(id)) return false;

    const status = String(tournament?.status || "").toLowerCase();
    if (["ready", "in_progress", "completed", "archived", "cancelled", "canceled"].includes(status)) return false;

    const startsAt = parseDate(tournament?.start_at);
    return !!startsAt && startsAt.getTime() <= Date.now();
  }

  async function checkedInTournamentIds() {
    const currentToken = token();
    if (!currentToken) return new Set();

    if (dashboardCache.promise
      && dashboardCache.token === currentToken
      && Date.now() - dashboardCache.at < 2500) {
      return dashboardCache.promise;
    }

    dashboardCache = {
      token: currentToken,
      at: Date.now(),
      promise: (async () => {
        try {
          const response = await guardedFetch(new URL("../api/v1/me/dashboard", window.location.href), {
            headers: { Authorization: `Bearer ${currentToken}` },
            cache: "no-store",
          });
          const payload = await response.json().catch(() => null);
          const registrations = Array.isArray(payload?.data?.dashboard?.registrations)
            ? payload.data.dashboard.registrations
            : [];
          return new Set(registrations
            .filter((registration) => String(registration?.status || "") === "checked_in")
            .map((registration) => Number(registration?.tournament_id || 0))
            .filter(Boolean));
        } catch (_) {
          return new Set();
        }
      })(),
    };

    return dashboardCache.promise;
  }

  function responseWithJson(response, payload) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  window.fetch = async (...args) => {
    const response = await guardedFetch(...args);
    if (!response.ok || !token()) return response;

    let url;
    try {
      const source = args[0] instanceof Request ? args[0].url : String(args[0] || "");
      url = new URL(source, window.location.href);
    } catch (_) {
      return response;
    }

    const isTournamentList = /\/api\/v1\/clubs\/\d+\/registration-tournaments\/?$/.test(url.pathname);
    const detailMatch = url.pathname.match(/\/api\/v1\/tournaments\/(\d+)\/?$/);
    if (!isTournamentList && !detailMatch) return response;

    const payload = await response.clone().json().catch(() => null);
    if (!payload?.ok || !payload?.data) return response;

    const checkedInIds = await checkedInTournamentIds();
    if (!checkedInIds.size) return response;

    if (isTournamentList && Array.isArray(payload.data.items)) {
      let changed = false;
      payload.data.items = payload.data.items.map((tournament) => {
        if (!shouldPretendStarted(tournament, checkedInIds)) return tournament;
        changed = true;
        return { ...tournament, status: "in_progress", test_status_override: true };
      });
      return changed ? responseWithJson(response, payload) : response;
    }

    const tournament = payload.data.tournament || payload.data;
    if (detailMatch && Number(detailMatch[1]) === Number(tournament?.id || 0)
      && shouldPretendStarted(tournament, checkedInIds)) {
      if (payload.data.tournament) {
        payload.data.tournament = { ...payload.data.tournament, status: "in_progress", test_status_override: true };
      } else {
        payload.data = { ...payload.data, status: "in_progress", test_status_override: true };
      }
      return responseWithJson(response, payload);
    }

    return response;
  };
})();