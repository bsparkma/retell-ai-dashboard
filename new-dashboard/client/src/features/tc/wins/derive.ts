/**
 * Win celebration derivations (PM ruling 2) — REAL NUMBERS OR NONE.
 *
 * The legacy DentaFlow overlay (components/WinCelebration.tsx, fed from
 * App.tsx's WinOverlay) showed two numbers next to the accepted case's value:
 *   - "MTD accepted: $X" — read straight out of the mock PIPELINE_STATS
 *     monthlyTrend[6] seed array
 *   - "Y% rate"          — mock accepted / mock diagnosed
 * Both were invented. On the platform they can't be reproduced honestly:
 * TcCaseSummary carries only the case's CURRENT status plus statusChangedAt,
 * so nothing client-side can reconstruct "how many cases were accepted this
 * week/month" or a presented→accepted acceptance RATE.
 *
 * What IS real and available: the accepted case's own value, and a count of
 * the office's cases sitting in the accepted family right now. So the overlay
 * shows exactly that, labeled as a current-pipeline count — never "this week",
 * never a rate. `acceptedRatePercent` is typed `null` so the compiler itself
 * refuses any future attempt to slip an approximated rate in here.
 *
 * Every function is pure: the case snapshot is passed in, never fetched.
 */
import type { TcCaseSummary } from "../api";
import type { CaseStatusId } from "../status";

/**
 * The "accepted family" — mirrors ACCEPTED_NOW_STATUSES in
 * dashboard/derive.ts so the overlay and the dashboard banner never disagree
 * about what counts as accepted.
 */
const ACCEPTED_STATUSES: ReadonlySet<CaseStatusId> = new Set<CaseStatusId>([
  "accepted",
  "partially_accepted",
]);

export function isAcceptedStatus(status: CaseStatusId): boolean {
  return ACCEPTED_STATUSES.has(status);
}

/** What a page hands the trigger after a CONFIRMED accepted transition. */
export interface WinTrigger {
  caseId: string;
  patientName: string;
  /** Integer cents, straight off the persisted case the server returned. */
  caseValueCents: number;
}

/** Real accepted-family total for the office, at the moment of the win. */
export interface AcceptedNow {
  count: number;
  valueCents: number;
}

export interface WinStats {
  /** First name only, matching the legacy "{first} is moving forward" line. */
  patientFirstName: string;
  /** The accepted case's own value — always real, always shown. */
  caseValueCents: number;
  /**
   * Accepted-family cases in this office right now (INCLUDING the case that
   * just won). Null when no case snapshot was supplied — the overlay then
   * shows the congratulatory message and the case value only, rather than a
   * guess.
   */
  acceptedNow: AcceptedNow | null;
  /**
   * Always null, by type. An acceptance rate needs presented→accepted history
   * that case summaries do not carry; approximating it was the legacy bug.
   */
  acceptedRatePercent: null;
}

/** First word of a display name; falls back to the whole (trimmed) string. */
export function firstNameOf(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return "This patient";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/**
 * Build the overlay's numbers from the winning case plus (optionally) the
 * office's case snapshot.
 *
 * The snapshot is usually one render behind the transition that just
 * succeeded — the winning case may still be listed under its pre-accept
 * status. That is handled explicitly: the winning case is counted from the
 * trigger (which carries the server-confirmed value), and its snapshot row is
 * excluded so it can never be double counted. No other case is adjusted.
 *
 * Pass `cases = null` when the caller has no snapshot; the result omits the
 * accepted-now line entirely instead of showing a partial total.
 */
export function deriveWinStats(
  win: WinTrigger,
  cases: TcCaseSummary[] | null,
): WinStats {
  const base: WinStats = {
    patientFirstName: firstNameOf(win.patientName),
    caseValueCents: win.caseValueCents,
    acceptedNow: null,
    acceptedRatePercent: null,
  };
  if (cases === null) return base;

  let count = 1;
  let valueCents = win.caseValueCents;
  for (const c of cases) {
    if (c.caseId === win.caseId) continue; // counted from the trigger above
    if (!isAcceptedStatus(c.status)) continue;
    count += 1;
    valueCents += c.caseValueCents;
  }
  return { ...base, acceptedNow: { count, valueCents } };
}
