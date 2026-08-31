(() => {
  const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
    || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || new URLSearchParams(window.location.search).get("pwa") === "test";

  if (!isTestEnvironment || window.__bdTestPastStartOverrideInstalled) return;
  window.__bdTestPastStartOverrideInstalled = true;

  const originalFetch = window.fetch.bind(window);
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
          const response = await originalFetch(new URL("../api/v1/me/dashboard", window.location.href), {
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
    const response = await originalFetch(...args);
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
