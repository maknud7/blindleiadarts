(() => {
  if (window.__bdCheckinMutationGuardInstalled || typeof window.MutationObserver !== "function") return;
  window.__bdCheckinMutationGuardInstalled = true;

  const NativeMutationObserver = window.MutationObserver;

  function elementFor(node) {
    if (node instanceof Element) return node;
    return node?.parentElement || null;
  }

  function isCheckinTextOnlyMutation(record) {
    if (record.type !== "childList") return false;
    const target = elementFor(record.target);
    if (!target) return false;
    const checkinTarget = target.closest(
      "button[data-checkin],button[data-px-checkin],button.checkin-window-disabled,#playerNowHint"
    );
    if (!checkinTarget) return false;

    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    return changedNodes.length > 0 && changedNodes.every((node) => node.nodeType === Node.TEXT_NODE);
  }

  function filtered(records) {
    return records.filter((record) => !isCheckinTextOnlyMutation(record));
  }

  class GuardedMutationObserver {
    constructor(callback) {
      this._inner = new NativeMutationObserver((records) => {
        const useful = filtered(records);
        if (useful.length) callback(useful, this);
      });
    }

    observe(target, options) {
      return this._inner.observe(target, options);
    }

    disconnect() {
      return this._inner.disconnect();
    }

    takeRecords() {
      return filtered(this._inner.takeRecords());
    }
  }

  window.MutationObserver = GuardedMutationObserver;
})();