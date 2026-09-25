/**
 * When a call happened, in the practice's own time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ZONE IS NOT THE VIEWER'S
 * ─────────────────────────────────────────────────────────────────────────────
 * A call stamp rendered in the viewer's zone is wrong for anyone travelling, for
 * a manager working from another state, and for any laptop whose clock zone has
 * drifted — and "7:57 AM" is exactly the kind of detail someone reads back to a
 * patient, or types into a chart note. So every call stamp in the app resolves
 * in `OFFICE_TIME_ZONE` and none of them use the machine's zone.
 *
 * `Intl` carries the zone database, so the CDT/CST boundary follows DST with
 * nobody maintaining an offset table.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY null AND NOT A PLACEHOLDER
 * ─────────────────────────────────────────────────────────────────────────────
 * Both formatters return `null` for anything unparseable rather than a string,
 * so the caller omits the line. `new Date(x).toLocaleString()` on a bad value
 * prints the literal words "Invalid Date" into the UI, which reads as a defect
 * in the record rather than as a missing fact — that was a real bug on the call
 * detail page before these moved here.
 */

/**
 * The practice's zone, mirroring the backend's `OFFICE_TIMEZONE` default — the
 * same constant, for the same reason, as `features/rcm/time.ts`. When a practice
 * outside Central is onboarded this becomes a per-office value and this line is
 * the one that changes.
 */
export const OFFICE_TIME_ZONE = "America/Chicago";

function parse(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function officeTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: OFFICE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The full stamp, always carrying the year: "Sep 22, 2026 · 7:57 AM".
 *
 * Used where the call is the subject of the page and there is room to be
 * unambiguous — the detail page's patient card and Call Details card.
 */
export function formatCallStamp(iso: string | undefined | null): string | null {
  const d = parse(iso);
  if (!d) return null;
  const day = d.toLocaleDateString("en-US", {
    timeZone: OFFICE_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${day} · ${officeTime(d)}`;
}

/**
 * The compact stamp for a list row: "Sep 22, 7:57 AM", or "Sep 22, 2025, 7:57 AM"
 * when the call is not from the current year.
 *
 * A worklist row already carries a duration and a relative age, so the year is
 * noise on the calls people are actually working — but dropping it outright
 * would make a year-old call indistinguishable from last week's. So it appears
 * only when it is the thing that disambiguates.
 *
 * "Current" is resolved IN THE OFFICE'S ZONE, not the viewer's: a call at 11 PM
 * on December 31st in Roland is already the next year in UTC, and comparing
 * against a UTC year would print a year on it for no reason.
 *
 * @param now injectable so tests can pin "this year" instead of drifting each
 *            January.
 */
export function formatCallStampCompact(
  iso: string | undefined | null,
  now: Date = new Date(),
): string | null {
  const d = parse(iso);
  if (!d) return null;
  const sameYear = officeYear(d) === officeYear(now);
  const day = d.toLocaleDateString("en-US", {
    timeZone: OFFICE_TIME_ZONE,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
  return `${day}, ${officeTime(d)}`;
}

/** The calendar year an instant fell in, as the office reckons it. */
function officeYear(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: OFFICE_TIME_ZONE, year: "numeric" });
}
