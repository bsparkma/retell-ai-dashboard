/**
 * Nurture campaign pure logic — port of the legacy lib/nurtureUtils.ts onto
 * the platform case shape (nurtureEnrolledAt / nurturePhase1DaysOverride /
 * nurturePhase2DaysOverride scalars on TcCase; touchpoints are real
 * tc_followups rows with kind='nurture', NOT client-generated).
 *
 * Deliberately NOT ported from legacy (see the page for the API-backed
 * equivalents): generateInitialTouchpoints / generateNextCheckIn /
 * getSeasonalDates / getNextBirthdayDate — the platform queue shows the rows
 * that exist; nothing is auto-scheduled client-side.
 *
 * Deterministic like lib/followups: every date computation takes `today`
 * (YYYY-MM-DD) — no `new Date()` in this module.
 */
import { formatCents } from "../money";

/** Default cadence intervals in days (legacy values preserved). */
export const NURTURE_PHASE1_DEFAULT_DAYS = 14;
export const NURTURE_PHASE2_DEFAULT_DAYS = 30;
/** Days after enrollment when a case moves from Phase 1 to Phase 2. */
export const NURTURE_PHASE2_THRESHOLD_DAYS = 60;

/** The nurture scalars this module reads — TcCase and TcCaseSummary satisfy it. */
export interface NurtureCaseScalars {
  nurtureEnrolledAt: string | null;
  nurturePhase1DaysOverride: number | null;
  nurturePhase2DaysOverride: number | null;
}

function utcDays(isoDate: string): number {
  // Date part of an ISO date/timestamp → whole days since epoch (timezone-proof).
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * Whole calendar days from `iso` (date or timestamp) to `today` (YYYY-MM-DD).
 * Positive = past, 0 = same day, negative = future.
 */
export function daysSince(iso: string, today: string): number {
  return utcDays(today) - utcDays(iso);
}

/** YYYY-MM-DD `days` calendar days after `isoDate` (negative to go back). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return t.toISOString().slice(0, 10);
}

/** Days enrolled in nurture as of `today`; 0 when not enrolled (legacy display). */
export function getDaysEnrolled(c: NurtureCaseScalars, today: string): number {
  if (!c.nurtureEnrolledAt) return 0;
  return Math.max(0, daysSince(c.nurtureEnrolledAt, today));
}

/**
 * Current nurture phase derived from enrollment date.
 * Phase 1: 0–59 days since enrollment; Phase 2: 60+ days.
 * Returns null when the case has never been enrolled.
 */
export function getNurturePhase(c: NurtureCaseScalars, today: string): 1 | 2 | null {
  if (!c.nurtureEnrolledAt) return null;
  return daysSince(c.nurtureEnrolledAt, today) >= NURTURE_PHASE2_THRESHOLD_DAYS ? 2 : 1;
}

/**
 * Effective cadence interval in days for the case's current phase.
 * Respects the per-phase override scalars; falls back to phase defaults.
 */
export function getCadenceDays(c: NurtureCaseScalars, today: string): number {
  if (getNurturePhase(c, today) === 2) {
    return c.nurturePhase2DaysOverride ?? NURTURE_PHASE2_DEFAULT_DAYS;
  }
  return c.nurturePhase1DaysOverride ?? NURTURE_PHASE1_DEFAULT_DAYS;
}

/** True when either phase interval has been overridden. */
export function hasCadenceOverride(c: NurtureCaseScalars): boolean {
  return c.nurturePhase1DaysOverride !== null || c.nurturePhase2DaysOverride !== null;
}

/** Cadence table cell, e.g. "14d (default)" or "21d (override)". */
export function formatCadence(c: NurtureCaseScalars, today: string): string {
  return `${getCadenceDays(c, today)}d ${hasCadenceOverride(c) ? "(override)" : "(default)"}`;
}

/**
 * Ballpark monthly financing figure in integer CENTS: case value spread over
 * 48 months (legacy heuristic — not a quote). Render with formatCents so the
 * patient-facing copy shows whole dollars, never fake precision.
 */
export function financingMonthlyCents(caseValueCents: number): number {
  return Math.round(caseValueCents / 48);
}

/** Talking point for a manually-added financing touchpoint. */
export function buildFinancingTalkingPoint(
  patientName: string,
  caseValueCents: number,
): string {
  const firstName = patientName.split(" ")[0] ?? patientName;
  const monthly = formatCents(financingMonthlyCents(caseValueCents));
  return (
    `Hi ${firstName}, I wanted to reach out because we have some new financing ` +
    `options that might make your treatment much more affordable. We can get you ` +
    `started for as low as ${monthly}/month. Would you like to hear more?`
  );
}

/** Display labels for TcFollowup.nurtureType (null → generic "nurture"). */
export const NURTURE_TYPE_LABELS: Record<string, string> = {
  check_in: "check in",
  seasonal: "seasonal",
  life_event: "life event",
  financing: "financing",
};

export function nurtureTypeLabel(nurtureType: string | null): string {
  return (nurtureType && NURTURE_TYPE_LABELS[nurtureType]) || "nurture";
}
