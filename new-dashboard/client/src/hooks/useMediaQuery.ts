import { useEffect, useState } from "react";

/**
 * Track a CSS media query from React.
 *
 * The worklist needs this because its column template is an inline `gridTemplateColumns`
 * style, and inline styles can't carry a media query — the layout has to know, in JS,
 * whether it has room for every column.
 *
 * SSR/first-paint safety: starts false and syncs in an effect, so a server render and the
 * first client render agree. Callers should treat false as "assume narrow", which degrades
 * to the more forgiving layout rather than a crushed one.
 *
 * An environment without `matchMedia` (jsdom under test, older SSR shims) gets that same
 * false rather than a thrown TypeError — a layout hint must never be able to take a page
 * down with it.
 *
 * @param query a media query string, e.g. "(min-width: 1100px)"
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
