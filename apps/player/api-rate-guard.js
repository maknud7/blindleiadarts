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
