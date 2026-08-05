/**
 * TC Dashboard derivations — every number the Morning Command Screen shows.
 *
 * HONESTY RULE: the legacy Dashboard mixed real derivations with mock
 * PIPELINE_STATS (MTD banner, objection counts, 7-month trend, TC tiles).
 * This module computes ONLY from real API rows (TcCaseSummary /
 * TcDueFollowup / TcQueueFollowup) and is deliberately labeled
 * "pipeline now" — current-state counts — because summaries carry only the
 * current status + statusChangedAt, which cannot honestly reconstruct a
 * month-to-date or a monthly trend. All functions are pure: "today" and the
 * clock hour are always passed in, never read from `new Date()` here.
 */
import type { TcCaseSummary, TcDueFollowup, TcQueueFollowup } from "../api";
import type { CaseStatusId, UrgencyId } from "../status";
import { formatCents } from "../money";
import { getDaysOverdue } from "../lib/followups";

// ── Status vocabularies ─────────────────────────────────────────────────────

/** Statuses that count as "still being worked" for health checks + rollups. */
const CLOSED_STATUSES: ReadonlySet<CaseStatusId> = new Set<CaseStatusId>([
  "scheduled",
  "started",
  "completed",
  "lost",
]);

export function isOpenStatus(status: CaseStatusId): boolean {
  return !CLOSED_STATUSES.has(status);
}

/** The legacy "Active Cases" card set — the decision-stage middle of the pipeline. */
export const ACTIVE_PIPELINE_STATUSES: readonly CaseStatusId[] = [
  "presented",
  "considering",
  "financing_pending",
  "pending_tc",
];

const ACCEPTED_NOW_STATUSES: ReadonlySet<CaseStatusId> = new Set<CaseStatusId>([
  "accepted",
  "partially_accepted",
]);

// ── Greeting / date helpers ─────────────────────────────────────────────────

/** Time-of-day greeting bucket. hour is 0–23 (pass new Date().getHours()). */
export function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** First word of a display name, or "there" when unknown/blank. */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first ? first : "there";
}

/** Date-only add in whole days (timezone-proof; YYYY-MM-DD in and out). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Follow-up queue split ───────────────────────────────────────────────────

const URGENCY_ORDER: Record<UrgencyId, number> = {
  high: 0,
  medium: 1,
  low: 2,
  elective: 3,
};

function byDueDateThenUrgency(a: TcDueFollowup, b: TcDueFollowup): number {
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    URGENCY_ORDER[a.caseUrgency] - URGENCY_ORDER[b.caseUrgency]
  );
}

export interface DueSplit {
  overdue: TcDueFollowup[];
  dueToday: TcDueFollowup[];
  upcoming: TcDueFollowup[];
}

/** Overdue / due-today / future buckets, each sorted by due date then urgency. */
export function splitDueFollowups(rows: TcDueFollowup[], todayIso: string): DueSplit {
  const overdue: TcDueFollowup[] = [];
  const dueToday: TcDueFollowup[] = [];
  const upcoming: TcDueFollowup[] = [];
  for (const row of rows) {
    const days = getDaysOverdue(row.dueDate, todayIso);
    if (days > 0) overdue.push(row);
    else if (days === 0) dueToday.push(row);
    else upcoming.push(row);
  }
  overdue.sort(byDueDateThenUrgency);
  dueToday.sort(byDueDateThenUrgency);
  upcoming.sort(byDueDateThenUrgency);
  return { overdue, dueToday, upcoming };
}

/** "You have N actions today" — overdue + due-today only (never future rows). */
export function countActionsToday(split: DueSplit): number {
  return split.overdue.length + split.dueToday.length;
}

// ── Pipeline-now stats (honest replacement for the fake MTD banner) ─────────

export interface PipelineNowStats {
  presentedCount: number;
  presentedValueCents: number;
  acceptedCount: number;
  acceptedValueCents: number;
  openCount: number;
  openValueCents: number;
}

/**
 * Current-state counts by status. NOT month-to-date: summaries only carry the
 * case's current status, so a case presented earlier and since accepted no
 * longer counts as "presented" — label these "now", never "MTD".
 */
export function pipelineNowStats(cases: TcCaseSummary[]): PipelineNowStats {
  const stats: PipelineNowStats = {
    presentedCount: 0,
    presentedValueCents: 0,
    acceptedCount: 0,
    acceptedValueCents: 0,
    openCount: 0,
    openValueCents: 0,
  };
  for (const c of cases) {
    if (c.status === "presented") {
      stats.presentedCount += 1;
      stats.presentedValueCents += c.caseValueCents;
    }
    if (ACCEPTED_NOW_STATUSES.has(c.status)) {
      stats.acceptedCount += 1;
      stats.acceptedValueCents += c.caseValueCents;
    }
    if (isOpenStatus(c.status)) {
      stats.openCount += 1;
      stats.openValueCents += c.caseValueCents;
    }
  }
  return stats;
}

// ── Health checks ───────────────────────────────────────────────────────────

/**
 * Days since the case entered its current status (statusChangedAt, falling
 * back to createdAt). Null when neither timestamp is present — such a case is
 * never counted as aging (we don't guess).
 */
export function caseAgeDays(c: TcCaseSummary, todayIso: string): number | null {
  const anchor = c.statusChangedAt ?? c.createdAt;
  if (!anchor) return null;
  const date = anchor.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return getDaysOverdue(date, todayIso);
}

/** Open cases sitting in their current status longer than thresholdDays. */
export function findAgingCases(
  cases: TcCaseSummary[],
  todayIso: string,
  thresholdDays = 30,
): TcCaseSummary[] {
  return cases.filter((c) => {
    if (!isOpenStatus(c.status)) return false;
    const days = caseAgeDays(c, todayIso);
    return days !== null && days > thresholdDays;
  });
}

/**
 * Open cases with no pending follow-up anywhere (not just due ones) — needs
 * the full pending-followup list from listFollowups(office, {status:'pending'}),
 * because the due queue alone can't prove a case has nothing scheduled.
 */
export function findCasesWithNoNextStep(
  cases: TcCaseSummary[],
  pendingFollowups: Pick<TcQueueFollowup, "caseId" | "status">[],
): TcCaseSummary[] {
  const covered = new Set<string>();
  for (const f of pendingFollowups) {
    if (f.status === "pending") covered.add(f.caseId);
  }
  return cases.filter((c) => isOpenStatus(c.status) && !covered.has(c.caseId));
}

// ── Active cases card ───────────────────────────────────────────────────────

/** Top-N decision-stage cases by value (the legacy Active Cases card, real). */
export function topActiveCases(cases: TcCaseSummary[], limit = 5): TcCaseSummary[] {
  return cases
    .filter((c) => ACTIVE_PIPELINE_STATUSES.includes(c.status))
    .sort((a, b) => b.caseValueCents - a.caseValueCents || a.patientName.localeCompare(b.patientName))
    .slice(0, limit);
}

// ── Per-TC rollup (honest replacement for the fake "TC Performance MTD") ────

export interface TcRollup {
  assignedTc: string;
  openCount: number;
  openValueCents: number;
  acceptedNowCount: number;
  acceptedNowValueCents: number;
}

/**
 * Current pipeline state per assigned TC. No acceptance *rate* — a rate needs
 * historical presented→accepted attribution the summaries don't carry.
 * Cases with a blank assignedTc are excluded (no invented names).
 */
export function perTcRollup(cases: TcCaseSummary[]): TcRollup[] {
  const byTc = new Map<string, TcRollup>();
  for (const c of cases) {
    const name = c.assignedTc.trim();
    if (!name) continue;
    const open = isOpenStatus(c.status);
    const accepted = ACCEPTED_NOW_STATUSES.has(c.status);
    if (!open && !accepted) continue;
    let row = byTc.get(name);
    if (!row) {
      row = {
        assignedTc: name,
        openCount: 0,
        openValueCents: 0,
        acceptedNowCount: 0,
        acceptedNowValueCents: 0,
      };
      byTc.set(name, row);
    }
    if (open) {
      row.openCount += 1;
      row.openValueCents += c.caseValueCents;
    }
    if (accepted) {
      row.acceptedNowCount += 1;
      row.acceptedNowValueCents += c.caseValueCents;
    }
  }
  return Array.from(byTc.values()).sort(
    (a, b) => b.openValueCents - a.openValueCents || a.assignedTc.localeCompare(b.assignedTc),
  );
}

// ── Morning huddle text ─────────────────────────────────────────────────────

const CHANNEL_TEXT: Record<TcDueFollowup["channel"], string> = {
  phone_call: "call",
  text: "text",
  email: "email",
  in_person: "in person",
};

export interface HuddleInput {
  /** Human date line, e.g. "Monday, August 3, 2026". */
  dateLabel: string;
  /** Signed-in TC display name (may be empty — rendered as "—"). */
  tcName: string;
  overdue: TcDueFollowup[];
  dueToday: TcDueFollowup[];
  stats: PipelineNowStats;
  agingCount: number;
  noNextStepCount: number;
}

/**
 * Plain-text morning huddle built ONLY from real rows: due/overdue follow-ups
 * with real patient names + case values, plus current pipeline-state counts.
 * No MTD line, no consults, no seeded numbers.
 */
export function buildHuddleText(input: HuddleInput): string {
  const lines: string[] = [];
  lines.push(`Morning Huddle — ${input.dateLabel}`);
  lines.push(`TC: ${input.tcName.trim() || "—"}`);
  lines.push("");

  const pushRows = (label: string, rows: TcDueFollowup[]) => {
    if (rows.length === 0) return;
    lines.push(`${label} (${rows.length}):`);
    for (const f of rows) {
      lines.push(
        `  - ${f.patientName} (${formatCents(f.caseValueCents)}) — ${CHANNEL_TEXT[f.channel]}, due ${f.dueDate}`,
      );
    }
    lines.push("");
  };
  pushRows("OVERDUE", input.overdue);
  pushRows("TODAY'S FOLLOW-UPS", input.dueToday);
  if (input.overdue.length === 0 && input.dueToday.length === 0) {
    lines.push("No follow-ups due today — all caught up.");
    lines.push("");
  }

  const s = input.stats;
  lines.push(
    `PIPELINE NOW: ${s.openCount} open case${s.openCount === 1 ? "" : "s"} worth ${formatCents(s.openValueCents)}` +
      ` · presented now: ${s.presentedCount} (${formatCents(s.presentedValueCents)})` +
      ` · accepted now: ${s.acceptedCount} (${formatCents(s.acceptedValueCents)})`,
  );
  if (input.noNextStepCount > 0 || input.agingCount > 0) {
    const parts: string[] = [];
    if (input.noNextStepCount > 0) {
      parts.push(`${input.noNextStepCount} case${input.noNextStepCount === 1 ? "" : "s"} with no next step`);
    }
    if (input.agingCount > 0) {
      parts.push(`${input.agingCount} case${input.agingCount === 1 ? "" : "s"} aging 30+ days`);
    }
    lines.push(`HEALTH: ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}
