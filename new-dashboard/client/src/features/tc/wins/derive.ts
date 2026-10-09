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
 * shows exactly that, labeled as a current-pipeline count — never "this week".
 *
 * THE RATE (item 42). An acceptance rate needs presented→accepted HISTORY, and
 * case summaries still do not carry it — so this module still never computes
 * one. The server now does: GET /api/tc/reports/funnel derives a windowed
 * presented→accepted rate from recorded status transitions. `acceptedRatePercent`
 * was typed `null` so the compiler itself refused any approximated rate; it is
 * now typed `ServedAcceptanceRate | null`, a BRANDED type that only
 * reports/funnel.ts can mint, and only from a server response that passed the
 * funnel schema. The guard's intent is unchanged — a number computed here from
 * TcCaseSummary rows still cannot be assigned — it just has one legitimate
 * source now. deriveWinStats leaves it null; the provider attaches the served
 * rate (withServedRate) when the funnel request for the case's office answers.
 *
 * Every function is pure: the case snapshot is passed in, never fetched.
 */
import type { OfficeId } from "@shared/tc/contract";
import type { TcCaseSummary } from "../api";
import type { ServedAcceptanceRate } from "../reports/funnel";
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
  /**
   * The persisted case's office. When present, the provider asks that office's
   * funnel for its SERVED acceptance rate; when absent, no rate is shown.
   */
  office?: OfficeId;
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
   * The office's windowed presented→accepted rate AS SERVED by
   * GET /api/tc/reports/funnel, with its numerator, denominator and window —
   * or null (no served rate yet, the request failed, or nothing was presented
   * in the window). Only reports/funnel.ts can mint a ServedAcceptanceRate;
   * nothing in this file can produce one from case summaries, which carry
   * current status, not history.
   */
  acceptedRatePercent: ServedAcceptanceRate | null;
}

/**
 * COMPILER GUARD (kept from the null-typed era, re-aimed): a bare number — the
 * shape any client-side approximation would take — must NOT be assignable to
 * the overlay's rate. If someone widens the field to `number | ...`, this line
 * stops compiling. (Tests are excluded from tsc, so the guard lives here.)
 */
type AssertTrue<T extends true> = T;
type _RateIsNotABareNumber = AssertTrue<
  number extends WinStats["acceptedRatePercent"] ? false : true
>;
type _RateIsNotAPlainObject = AssertTrue<
  { percent: number; acceptedCases: number; presentedCases: number } extends WinStats["acceptedRatePercent"]
    ? false
    : true
>;

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

/**
 * Attach a SERVED acceptance rate to already-derived stats. The rate is passed
 * through untouched — the only way in is a ServedAcceptanceRate, which only a
 * parsed funnel response can produce.
 */
export function withServedRate(stats: WinStats, served: ServedAcceptanceRate | null): WinStats {
  return { ...stats, acceptedRatePercent: served };
}
