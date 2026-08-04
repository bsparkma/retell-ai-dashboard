/**
 * Follow-up escalation + cadence tiering — faithful port of the legacy
 * followUpUtils.ts pure logic, converted to integer cents and made
 * deterministic (today is always passed in; no `new Date()` in the lib).
 */

export type EscalationTier = "normal" | "mild" | "overdue" | "critical";

function atMidnightUtcDays(isoDate: string): number {
  // YYYY-MM-DD → whole days since epoch (date-only, timezone-proof).
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Calendar days today is past dueDate (negative = due in the future). */
export function getDaysOverdue(dueDate: string, todayIsoDate: string): number {
  return atMidnightUtcDays(todayIsoDate) - atMidnightUtcDays(dueDate);
}

/** Legacy thresholds preserved: 14+ critical, 7+ overdue, 1+ mild. */
export function getEscalationTier(dueDate: string, todayIsoDate: string): EscalationTier {
  const days = getDaysOverdue(dueDate, todayIsoDate);
  if (days >= 14) return "critical";
  if (days >= 7) return "overdue";
  if (days >= 1) return "mild";
  return "normal";
}

export function getEscalationClass(tier: EscalationTier): string {
  switch (tier) {
    case "critical":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    case "overdue":
      return "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300";
    case "mild":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300";
    default:
      return "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300";
  }
}

export function getEscalationLabel(tier: EscalationTier, daysOverdue: number): string {
  if (tier === "normal") return daysOverdue === 0 ? "Due today" : "Upcoming";
  return `${daysOverdue}d overdue`;
}

/** Local YYYY-MM-DD for "today" — the one place components get their date. */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Cadence tier from case value in CENTS. Boundary semantics preserved from
 * the legacy dollars version ($999 → light, $5000 → standard, $5001+ → high):
 *   value <  standardMinCents  → light
 *   value <= highTouchMinCents → standard
 *   value >  highTouchMinCents → high_touch
 */
export function getCadenceTier(
  caseValueCents: number,
  thresholds: { standardMinCents: number; highTouchMinCents: number } = {
    standardMinCents: 100_000,
    highTouchMinCents: 500_000,
  },
): "light" | "standard" | "high_touch" {
  if (caseValueCents < thresholds.standardMinCents) return "light";
  if (caseValueCents <= thresholds.highTouchMinCents) return "standard";
  return "high_touch";
}
