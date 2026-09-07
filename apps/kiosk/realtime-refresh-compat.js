(() => {
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  // The Scolia live surface used to poll every 350 ms. Clamp that legacy timer
  // so one kiosk cannot create nearly three status requests per second when
  // realtime transport falls back to polling.
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function resilientSetInterval(handler, delay, ...args) {
    const requested = Number(delay);
    const effective = requested === 350 ? 1500 : delay;
    return nativeSetInterval(handler, effective, ...args);
  };

  // Apply progressive backoff to the high-frequency kiosk reads that share the
  // same backend/DB capacity. This deliberately delays retries instead of
  // turning a short backend incident into a synchronized request storm.
  const nativeFetch = window.fetch.bind(window);
  const pressure = new Map();
  const pressurePath = (url) => {
    try {
      const parsed = new URL(String(url), window.location.href);
      const path = parsed.pathname;
      if (path.endsWith("/api/kiosk-scolia-ui.php") && parsed.searchParams.get("action") === "status") return "scolia-ui";
      if (/\/api\/v1\/kiosks\/[^/]+\/scolia\/status$/.test(path)) return "scolia-status";
      if (path.endsWith("/api/kiosk-player-preference.php")) return "player-preference";
    } catch {}
    return "";
  };

  function registerPressureResult(key, ok) {
    if (!key) return;
    if (ok) {
      pressure.delete(key);
      return;
    }
    const previous = pressure.get(key) || { failures: 0, nextAt: 0 };
    const failures = Math.min(5, previous.failures + 1);
    const base = Math.min(15000, 1500 * (2 ** (failures - 1)));
    const jitter = Math.floor(Math.random() * 500);
    pressure.set(key, { failures, nextAt: Date.now() + base + jitter });
  }

  window.fetch = async function resilientFetch(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const key = method === "GET" ? pressurePath(url) : "";

    if (key) {
      const current = pressure.get(key);
      if (current?.nextAt > Date.now()) await sleep(current.nextAt - Date.now());
    }

    const isPairingCreate = method === "POST" && (() => {
      try {
        const parsed = new URL(url, window.location.href);
        return parsed.pathname.endsWith("/api/kiosk-pairing.php") && parsed.searchParams.get("action") === "create";
      } catch { return false; }
    })();

    try {
      const response = await nativeFetch(input, init);
      if (key) registerPressureResult(key, response.ok || response.status < 500);
      return response;
    } catch (error) {
      if (key) registerPressureResult(key, false);
      if (!isPairingCreate) throw error;

      // Pairing creation is fingerprint/idempotency protected server-side. A
      // lost network response is therefore safe to retry once with the exact
      // same token/body instead of moving on with uncertain local state.
      await sleep(900 + Math.floor(Math.random() * 300));
      return nativeFetch(input, init);
    }
  };

  // Keep QR image loading same-origin. The server endpoint handles the external
  // QR provider and always returns a usable image/fallback, so a provider or
  // venue-network outage no longer becomes a broken user-facing resource.
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (srcDescriptor?.get && srcDescriptor?.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: srcDescriptor.configurable,
      enumerable: srcDescriptor.enumerable,
      get: srcDescriptor.get,
      set(value) {
        let next = value;
        try {
          const parsed = new URL(String(value), window.location.href);
          if (parsed.hostname === "quickchart.io" && parsed.pathname === "/qr") {
            const text = parsed.searchParams.get("text") || "";
            const local = new URL("../api/kiosk-pairing-qr.php", window.location.href);
            local.searchParams.set("text", text);
            next = local.toString();
          }
        } catch {}
        return srcDescriptor.set.call(this, next);
      },
    });
  }

  if (typeof EventSource !== "function") return;

  const nativeAddEventListener = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (type !== "snapshot" || typeof listener !== "function") {
      return nativeAddEventListener.call(this, type, listener, options);
    }

    const wrapped = function canonicalSnapshotListener(event) {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.refresh === true) {
          if (typeof loadState === "function") {
            loadState().catch(() => undefined);
          }
          return;
        }
      } catch {
        // Let the normal snapshot handler deal with malformed/legacy payloads.
      }
      return listener.call(this, event);
    };

    return nativeAddEventListener.call(this, type, wrapped, options);
  };
})();
