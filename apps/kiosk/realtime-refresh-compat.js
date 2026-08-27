(() => {
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
