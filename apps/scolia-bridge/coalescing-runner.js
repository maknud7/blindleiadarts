export function createCoalescingRunner(task) {
  if (typeof task !== "function") {
    throw new TypeError("createCoalescingRunner requires a task function");
  }

  let requested = false;
  let runningPromise = null;

  async function runLoop() {
    while (requested) {
      requested = false;
      await task();
    }
  }

  function trigger() {
    requested = true;
    if (runningPromise) return runningPromise;

    runningPromise = runLoop().finally(() => {
      runningPromise = null;
      // A trigger can arrive after the loop has observed requested=false but
      // before the current promise is released. Make that edge deterministic.
      if (requested) trigger();
    });
    return runningPromise;
  }

  return {
    trigger,
    isRunning: () => runningPromise !== null,
  };
}
