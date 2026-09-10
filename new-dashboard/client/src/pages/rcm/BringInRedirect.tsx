/**
 * `/rcm/bring-in` — A ROUTE THAT OUTLIVED ITS PAGE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE PATH STILL ANSWERS
 * ═════════════════════════════════════════════════════════════════════════════
 * Ruling D-18 moved the two upload panels back onto Today and dropped the four
 * source tiles that could not be pressed, so the page this path used to render
 * no longer exists. The PATH is a different thing from the page: it was
 * first-class in the nav for a whole stage, it is in the practice owner's
 * browser history, and it is very probably in somebody's bookmarks.
 *
 * A path that 404s after being advertised is the worst of the three options. A
 * path that silently renders nothing is the second worst — indistinguishable
 * from a broken deploy. So it redirects, and it redirects to the place the thing
 * it named actually is: Today's *Get work in*.
 *
 * `?add=1` is what Today reads to scroll that section into view (see
 * `RcmToday`), so somebody arriving on this path lands looking at the two drop
 * zones rather than at the top of a screen and left to hunt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `replace`, NOT A PUSH
 * ─────────────────────────────────────────────────────────────────────────────
 * A redirect that pushes leaves the dead path in the history stack, so Back
 * lands on it, which redirects forward again — the browser's Back button stops
 * working, which is a bug a user reports as "the page is stuck".
 */
import { Redirect } from "wouter";

export default function BringInRedirect() {
  return <Redirect to="/rcm?add=1" replace />;
}
