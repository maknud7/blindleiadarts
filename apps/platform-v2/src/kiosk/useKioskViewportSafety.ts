import { useEffect, useRef } from "react";

/**
 * Kiosk is meant to feel like a single-screen tablet scorer, but must never
 * clip essential controls when a different tablet/browser reports less space.
 *
 * Prefer the familiar fitted layout. If available height/width or rendered
 * content cannot fit, switch to a stable, internally scrollable scorer.
 * Do not bounce between layouts after every 1.5s canonical poll.
 */
export function useKioskViewportSafety() {
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    let lastSize = "";

    function inspect() {
      frame = 0;
      const root = shellRef.current;
      if (!root) return;
      const width = root.clientWidth;
      const height = Math.min(root.clientHeight, window.visualViewport?.height ?? root.clientHeight);
      if (!width || !height) return;

      const size = `${Math.round(width)}x${Math.round(height)}`;
      // Re-evaluate the fit only if the actual viewport changes; a changing
      // score or asynchronous status message must not reset scroll position.
      if (size !== lastSize) {
        lastSize = size;
        root.dataset.kioskLayout = "fit";
      }

      const constrained = width < 540 || height < 790 || width > height;
      if (constrained) {
        root.dataset.kioskLayout = "scroll";
        return;
      }
      if (root.dataset.kioskLayout === "scroll") return;

      const check = [
        root.querySelector(".kiosk-card"),
        root.querySelector(".kiosk-card > .match-view"),
        root.querySelector(".score-entry"),
        root.querySelector(".manual-dart-entry"),
        root.querySelector(".keypad"),
        root.querySelector(".number-grid-v2"),
        root.querySelector(".kiosk-hero"),
      ];
      const clipped = check.some((element) => element &&
        element.scrollHeight > element.clientHeight + 3);
      if (clipped) root.dataset.kioskLayout = "scroll";
    }

    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(inspect);
    }

    const resize = typeof ResizeObserver === "function"
      ? new ResizeObserver(schedule)
      : null;
    resize?.observe(shell);

    // React renders new notices, games and score panels without resizing the
    // root. Observe DOM *structure*, not attributes, to avoid self-triggering.
    const changes = typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
        if (records.some((record) => record.addedNodes.length || record.removedNodes.length)) schedule();
      })
      : null;
    changes?.observe(shell, { subtree: true, childList: true });

    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      changes?.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, []);

  return shellRef;
}
