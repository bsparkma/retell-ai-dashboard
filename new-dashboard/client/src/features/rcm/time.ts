/**
 * Every RCM timestamp, in the practice's own day.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-08-25 walk approved a posting plan at 20:10 in Roland and the queue
 * reported "Approved Aug 26" (RCM_POSTING.md §15.2, finding 2). Two different
 * bugs produced the same lie:
 *
 *   1. `format.day()` slices an ISO INSTANT to its first ten characters, which
 *      is its UTC calendar day. 01:10Z is the previous evening in Central.
 *   2. `format.stamp()` used the BROWSER's timezone, so the same plan reported
 *      a different date to a biller on a laptop set to UTC than to one beside
 *      the chair.
 *
 * The drain already reasons this way — it stamps Open Dental's `DateReceived` in
 * `OFFICE_TIMEZONE` (§3.3) precisely so a payment does not land on tomorrow's
 * books. That reasoning had not reached the screen that reports it. It has now:
 * every instant on an RCM page renders through this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INSTANTS ONLY — A DATE-ONLY STRING MUST NOT COME HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * A service date or a deposit date is stored as 'YYYY-MM-DD' and carries no
 * time at all. Converting one into a timezone would be inventing a moment
 * nobody recorded, and could shift it a day in the process. Those keep going
 * through `format.day()`, which parses at noon UTC on purpose so no zone can
 * move them. This file is for the things that really happened at an instant:
 * approved at, reconciled at, read back at, finished at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ZONE IS A CONSTANT, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────────
 * Both practices are in Central, and the backend's `OFFICE_TIMEZONE` defaults to
 * `America/Chicago` for exactly the same reason. When a practice outside Central
 * is onboarded this becomes a per-office value the server sends, and the ONE
 * place that has to change is `zoneFor()` below. Until then, hardcoding it here
 * is honest and hardcoding it in nine components would not be.
 */
import type { RcmOfficeId } from "@/features/rcm/api";

/** The backend's `OFFICE_TIMEZONE` default, mirrored. */
export const OFFICE_TIMEZONE = "America/Chicago";

/**
 * Which zone an office's days are measured in.
 *
 * One answer today. The seam exists so the day a practice is onboarded outside
 * Central, this function starts reading a per-office value and every caller is
 * already correct.
 */
export function zoneFor(_office?: RcmOfficeId): string {
  return OFFICE_TIMEZONE;
}

/** What a screen prints beside a column of times, once per page. */
export const OFFICE_TIME_NOTE = "Times are the practice's own (Central).";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An ISO instant → the calendar day it fell on IN THE PRACTICE'S ZONE.
 *
 * "Aug 25, 2026" for `2026-08-26T01:10:00Z`, because that is the evening a
 * biller in Roland was sitting at the desk.
 */
export function officeDay(iso: string | null | undefined, office?: RcmOfficeId): string {
  const d = parse(iso);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: zoneFor(office),
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** An ISO instant → a short day and time in the practice's zone. */
export function officeStamp(iso: string | null | undefined, office?: RcmOfficeId): string {
  const d = parse(iso);
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    timeZone: zoneFor(office),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * An ISO instant → 'YYYY-MM-DD' in the practice's zone.
 *
 * The sortable, comparable form — what "posted this week" counts over. Built
 * from `formatToParts` rather than by string surgery on a locale string,
 * because the parts are named and a locale change cannot silently re-order
 * them.
 */
export function officeDayKey(iso: string | null | undefined, office?: RcmOfficeId): string | null {
  const d = parse(iso);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneFor(office),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const [y, m, day] = [get("year"), get("month"), get("day")];
  return y && m && day ? `${y}-${m}-${day}` : null;
}

/**
 * Did this instant fall within the last `days` PRACTICE days, counting today?
 *
 * Whole days, not a rolling 168 hours: a biller asking "what posted this week"
 * means calendar days at the practice, and a payment made last Tuesday morning
 * should not drop out of the count at Tuesday lunchtime.
 *
 * `now` is a parameter so the test can state a moment rather than depend on
 * when it runs.
 */
export function withinLastDays(
  iso: string | null | undefined,
  days: number,
  now: Date = new Date(),
  office?: RcmOfficeId,
): boolean {
  const key = officeDayKey(iso, office);
  if (!key) return false;
  const todayKey = officeDayKey(now.toISOString(), office);
  if (!todayKey) return false;
  // Compared as UTC midnights of the two PRACTICE days, so no zone arithmetic
  // happens twice and a DST boundary cannot make a day 23 or 25 hours long.
  const then = Date.parse(`${key}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(today)) return false;
  const elapsed = Math.round((today - then) / 86_400_000);
  return elapsed >= 0 && elapsed < days;
}
