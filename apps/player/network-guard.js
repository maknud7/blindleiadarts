(() => {
  // app.js og enkelte UX-moduler bruker fortsatt refreshButton som intern refresh-hook.
  // Den synlige knappen er fjernet fra UI, men hooken må finnes for at bootstrap ikke skal stoppe.
  if (!document.getElementById("refreshButton")) {
    const refreshHook = document.createElement("button");
    refreshHook.id = "refreshButton";
    refreshHook.type = "button";
    refreshHook.hidden = true;
    refreshHook.tabIndex = -1;
    refreshHook.setAttribute("aria-hidden", "true");
    refreshHook.style.display = "none";
    document.body.appendChild(refreshHook);
  }

  const originalFetch = window.fetch.bind(window);
  const MAX_MS = 12000;
  const history = [];

  function apiUrl(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      return url.origin === window.location.origin && url.pathname.includes("/api/") ? url : null;
    } catch {
      return null;
    }
  }

  function record(entry) {
    history.unshift(entry);
    if (history.length > 40) history.length = 40;
  }

  window.BlindleiaClientHealth = {
    snapshot() {
      return {
        generated_at: new Date().toISOString(),
        api_timeout_ms: MAX_MS,
        requests: history.map((entry) => ({ ...entry })),
      };
    },
  };

  window.fetch = async function guardedFetch(input, init = {}) {
    const url = apiUrl(input);
    if (!url) return originalFetch(input, init);

    const started = performance.now();
    const controller = new AbortController();
    const suppliedSignal = init?.signal || (input instanceof Request ? input.signal : null);
    let suppliedAbortHandler = null;

    if (suppliedSignal) {
      if (suppliedSignal.aborted) controller.abort(suppliedSignal.reason);
      else {
        suppliedAbortHandler = () => controller.abort(suppliedSignal.reason);
        suppliedSignal.addEventListener("abort", suppliedAbortHandler, { once: true });
      }
    }

    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("API request timed out", "TimeoutError"));
    }, MAX_MS);

    try {
      const response = await originalFetch(input, { ...init, signal: controller.signal });
      record({
        path: `${url.pathname}${url.search}`,
        status: response.status,
        ok: response.ok,
        ms: Math.round(performance.now() - started),
        outcome: response.ok ? "ok" : "http_error",
        at: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      const outcome = timedOut ? "timeout" : (error?.name === "AbortError" ? "aborted" : "network_error");
      record({
        path: `${url.pathname}${url.search}`,
        status: null,
        ok: false,
        ms: Math.round(performance.now() - started),
        outcome,
        at: new Date().toISOString(),
      });
      if (timedOut) {
        throw new Error(`API-kallet ${url.pathname} brukte mer enn ${MAX_MS / 1000} sekunder og ble avbrutt.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (suppliedSignal && suppliedAbortHandler) suppliedSignal.removeEventListener("abort", suppliedAbortHandler);
    }
  };
})();
