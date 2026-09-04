(() => {
  if (window.__blindleiaRuntimeDiagnosticsInstalled) return;
  window.__blindleiaRuntimeDiagnosticsInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const ACTIVITY_ENDPOINT = new URL("../../api/v1/activity", import.meta.url).pathname;
  const SLOW_API_MS = 5000;

  function activity() {
    return window.BlindleiaActivity || null;
  }

  function redactText(value, max = 500) {
    let text = String(value ?? "");
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]");
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
    text = text.replace(/([?&](?:token|auth|key|secret|code)=)[^&#\s]+/gi, "$1[redacted]");
    text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
    return text.slice(0, max);
  }

  function cleanUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      if (url.origin === window.location.origin) return url.pathname.slice(0, 180);
      return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 180);
    } catch {
      return redactText(value, 180);
    }
  }

  function cleanStack(error) {
    const stack = String(error?.stack || "");
    if (!stack) return "";
    return redactText(
      stack
        .split("\n")
        .slice(0, 8)
        .map((line) => line.replace(/https?:\/\/[^/\s)]+/g, ""))
        .join("\n"),
      1400,
    );
  }

  function sourceFile(value) {
    return cleanUrl(value || "");
  }

  function networkContext() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    return {
      browser_online: navigator.onLine !== false,
      visibility_state: String(document.visibilityState || "unknown").slice(0, 24),
      connection_type: String(connection?.type || "unknown").slice(0, 24),
      effective_connection_type: String(connection?.effectiveType || "unknown").slice(0, 24),
    };
  }

  function record(eventName, metadata = {}) {
    const tracker = activity();
    if (!tracker?.track) return;
    tracker.track(eventName, {
      source: "runtime-diagnostic",
      ...metadata,
    });
    // Error diagnostics should leave the browser quickly. The activity runtime
    // still rate-limits actual requests, so this cannot create a request storm.
    try { tracker.flush?.(); } catch {}
  }

  function isApiRequest(url) {
    return url.origin === window.location.origin
      && url.pathname.includes("/api/")
      && url.pathname !== ACTIVITY_ENDPOINT;
  }

  window.fetch = async function blindleiaDiagnosticFetch(input, init = {}) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    } catch {
      return originalFetch(input, init);
    }

    if (!isApiRequest(url)) return originalFetch(input, init);

    const method = String(init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const started = performance.now();

    try {
      const response = await originalFetch(input, init);
      const elapsedMs = Math.max(0, Math.round(performance.now() - started));
      if (!response.ok) {
        const clone = response.clone();
        void clone.json().catch(() => null).then((payload) => {
          record("api_error", {
            endpoint: cleanUrl(url.href),
            method: method.slice(0, 12),
            http_status: response.status,
            error_code: redactText(payload?.error?.code || `http_${response.status}`, 120),
            error_message: redactText(payload?.error?.message || response.statusText || "API request failed", 300),
            elapsed_ms: elapsedMs,
            timeout: false,
            phase: "response",
            module: "global-fetch",
            ...networkContext(),
          });
        });
      } else if (elapsedMs >= SLOW_API_MS) {
        record("api_slow", {
          endpoint: cleanUrl(url.href),
          method: method.slice(0, 12),
          http_status: response.status,
          elapsed_ms: elapsedMs,
          timeout: false,
          phase: "response",
          module: "global-fetch",
          ...networkContext(),
        });
      }
      return response;
    } catch (error) {
      const elapsedMs = Math.max(0, Math.round(performance.now() - started));
      const timeout = error?.name === "AbortError";
      const errorCode = timeout
        ? "request_timeout"
        : (error instanceof TypeError ? "network_error" : (error?.name || "network_error"));
      record("api_error", {
        endpoint: cleanUrl(url.href),
        method: method.slice(0, 12),
        http_status: 0,
        error_code: redactText(errorCode, 120),
        error_message: redactText(error?.message || "Network request failed", 300),
        elapsed_ms: elapsedMs,
        timeout,
        phase: "network",
        module: "global-fetch",
        ...networkContext(),
      });
      throw error;
    }
  };

  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      const rawUrl = target.getAttribute?.("src") || target.getAttribute?.("href") || "";
      record("resource_error", {
        endpoint: cleanUrl(rawUrl),
        error_code: "resource_load_failed",
        error_message: `Failed to load ${String(target.tagName || "resource").toLowerCase()}`,
        resource_type: String(target.tagName || "resource").toLowerCase().slice(0, 32),
        phase: "resource",
        module: "browser",
        ...networkContext(),
      });
      return;
    }

    record("js_error", {
      error_code: redactText(event.error?.name || "javascript_error", 120),
      error_message: redactText(event.message || event.error?.message || "JavaScript error", 300),
      source_file: sourceFile(event.filename),
      line: Number(event.lineno || 0),
      column: Number(event.colno || 0),
      stack: cleanStack(event.error),
      phase: "client",
      module: "browser",
      ...networkContext(),
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    record("js_unhandled_rejection", {
      error_code: redactText(reason?.name || reason?.code || "unhandled_rejection", 120),
      error_message: redactText(reason?.message || reason || "Unhandled promise rejection", 300),
      stack: cleanStack(reason),
      phase: "client",
      module: "promise",
      ...networkContext(),
    });
  });
})();
