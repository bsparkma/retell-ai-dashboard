import { useEffect, useRef } from "react";

/**
 * Run a callback on an interval, but only while the tab is actually being looked at.
 *
 * The office keeps eight or so tabs open across the practice. Every one of them was
 * polling on a timer whether or not anyone could see it, and together they exhausted the
 * API rate limit inside the first two minutes of each window — which the dashboard then
 * reported as "backend is offline". A background tab should cost nothing.
 *
 * On becoming visible again the callback fires immediately rather than waiting out a
 * fresh interval, so switching back to a tab shows current data instead of stale data
 * plus a delay.
 *
 * @param fn        what to run; re-reads on every tick without restarting the timer
 * @param intervalMs how often to run while visible; pass null to disable entirely
 */
export function usePolling(fn: () => void, intervalMs: number | null): void {
  // Held in a ref so a caller passing an inline arrow doesn't restart the timer on
  // every render — the interval depends on the CADENCE, not the closure.
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; }, [fn]);

  useEffect(() => {
    if (intervalMs === null) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";

    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => saved.current(), intervalMs);
    };

    const onVisibilityChange = () => {
      if (visible()) {
        // Catch up first, then resume the cadence.
        saved.current();
        start();
      } else {
        stop();
      }
    };

    if (visible()) {
      saved.current();
      start();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
