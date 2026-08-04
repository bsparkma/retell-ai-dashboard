/**
 * TC Reports — pure aggregation functions over case summaries + followups.
 *
 * HONESTY RULE: every number on /tc/reports comes out of these functions, and
 * every function here derives strictly from real rows the API returned.
 * The legacy DentaFlow Reports page rendered mock PIPELINE_STATS for its top
 * half; none of that returns. Sections whose source data is not reachable
 * without N+1 fetches (per-case objections) render an honest empty card in the
 * page instead of calling anything here.
 *
 * All functions are total: empty input produces zeros/empty arrays, never NaN.
 * Money stays integer cents; percentage helpers guard divide-by-zero.
 */
import type { z } from "zod";
import type {
  CaseCategory,
  CaseStatus,
  FollowupChannel,
  FollowupStatus,
  LostReason,
  ReferralSource,
} from "@shared/tc/contract";
import { BOARD_STATUSES, CASE_STATUSES, LOST_REASON_LABELS } from "../status";
import type { CaseStatusId, LostReasonId } from "../status";

// ── Input shapes (structural subsets of TcCaseSummary / TcQueueFollowup) ────

export type CaseCategoryId = z.infer<typeof CaseCategory>;
export type ReferralSourceId = z.infer<typeof ReferralSource>;
export type FollowupChannelId = z.infer<typeof FollowupChannel>;

/** The summary fields reports read — TcCaseSummary satisfies this. */
export interface ReportCase {
  status: z.infer<typeof CaseStatus>;
  caseValueCents: number;
  category: CaseCategoryId;
  assignedTc: string;
  doctorName: string;
  referralSource: ReferralSourceId | null;
  lostReason: z.infer<typeof LostReason> | null;
  createdAt: string;
}

/** The followup fields reports read — TcQueueFollowup satisfies this. */
export interface ReportFollowup {
  status: z.infer<typeof FollowupStatus>;
  channel: FollowupChannelId;
  patientResponded: boolean | null;
}

// ── Shared vocabulary ───────────────────────────────────────────────────────

/**
 * "Won" — the case reached acceptance or beyond. partially_accepted is
 * deliberately excluded: it is still an active board stage and counting its
 * full value as accepted would overstate.
 */
export const WON_STATUSES: readonly CaseStatusId[] = [
  "accepted",
  "scheduled",
  "started",
  "completed",
];
const WON_SET: ReadonlySet<CaseStatusId> = new Set(WON_STATUSES);

/** Labels kept in sync (by Record completeness) with the contract enum. */
export const CATEGORY_LABELS: Record<CaseCategoryId, string> = {
  single_tooth: "Single Tooth",
  quadrant: "Quadrant",
  implant: "Implant",
  full_mouth_rehab: "Full Mouth Rehab",
  full_arch: "Full Arch (All-on-X)",
  cosmetic: "Cosmetic",
  ortho: "Orthodontics",
};

export const REFERRAL_SOURCE_LABELS: Record<ReferralSourceId, string> = {
  google: "Google",
  existing_patient: "Existing Patient",
  doctor_referral: "Doctor Referral",
  social_media: "Social Media",
  carein_call: "CareIN Call",
  walk_in: "Walk-in",
  hygiene: "Hygiene Visit",
  other: "Other",
};

export const CHANNEL_LABELS: Record<FollowupChannelId, string> = {
  phone_call: "Phone",
  text: "Text",
  email: "Email",
  in_person: "In Person",
};

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

// ── 1. KPI row ──────────────────────────────────────────────────────────────

export interface ReportKpis {
  /** Every case ever recorded, any status. */
  totalCases: number;
  totalValueCents: number;
  /** Cases currently accepted | scheduled | started | completed. */
  acceptedCases: number;
  acceptedValueCents: number;
  /** acceptedCases / totalCases, whole percent (0 when no cases). */
  acceptanceRatePct: number;
  /** Cases sitting at status 'accepted' — accepted but not yet scheduled. */
  unscheduledCases: number;
  unscheduledValueCents: number;
  /** Mean caseValueCents across all cases (0 when no cases). */
  avgCaseSizeCents: number;
}

export function deriveKpis(cases: ReportCase[]): ReportKpis {
  let totalValueCents = 0;
  let acceptedCases = 0;
  let acceptedValueCents = 0;
  let unscheduledCases = 0;
  let unscheduledValueCents = 0;
  for (const c of cases) {
    totalValueCents += c.caseValueCents;
    if (WON_SET.has(c.status)) {
      acceptedCases += 1;
      acceptedValueCents += c.caseValueCents;
    }
    if (c.status === "accepted") {
      unscheduledCases += 1;
      unscheduledValueCents += c.caseValueCents;
    }
  }
  const totalCases = cases.length;
  return {
    totalCases,
    totalValueCents,
    acceptedCases,
    acceptedValueCents,
    acceptanceRatePct: pct(acceptedCases, totalCases),
    unscheduledCases,
    unscheduledValueCents,
    avgCaseSizeCents: totalCases > 0 ? Math.round(totalValueCents / totalCases) : 0,
  };
}

// ── 2. Monthly series (partial-real, labeled as such in the page) ───────────

export interface MonthlyPoint {
  /** "YYYY-MM" */
  month: string;
  /** "Mar 2026" */
  label: string;
  /** Value of cases recorded (createdAt) in this month. */
  diagnosedCents: number;
  /** Value of those same cases whose CURRENT status is won. */
  acceptedCents: number;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Honest partial series: "diagnosed" = value of cases recorded that month
 * (createdAt); "accepted" = value of that month's cases that are CURRENTLY in
 * a won status. This is NOT "accepted that month" — status history isn't in
 * summaries — and the page labels it accordingly.
 */
export function deriveMonthlySeries(cases: ReportCase[]): MonthlyPoint[] {
  const byMonth = new Map<string, { diagnosedCents: number; acceptedCents: number }>();
  for (const c of cases) {
    const match = /^(\d{4})-(\d{2})/.exec(c.createdAt);
    if (!match) continue;
    const monthNum = Number(match[2]);
    if (monthNum < 1 || monthNum > 12) continue;
    const key = `${match[1]}-${match[2]}`;
    const bucket = byMonth.get(key) ?? { diagnosedCents: 0, acceptedCents: 0 };
    bucket.diagnosedCents += c.caseValueCents;
    if (WON_SET.has(c.status)) bucket.acceptedCents += c.caseValueCents;
    byMonth.set(key, bucket);
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => {
      const monthIdx = Number(month.slice(5, 7)) - 1;
      const name = MONTH_NAMES[monthIdx] ?? month.slice(5, 7);
      return {
        month,
        label: `${name} ${month.slice(0, 4)}`,
        diagnosedCents: v.diagnosedCents,
        acceptedCents: v.acceptedCents,
      };
    });
}

// ── 3. Acceptance by treatment type ─────────────────────────────────────────

export interface TreatmentTypeRow {
  category: CaseCategoryId;
  label: string;
  diagnosedCases: number;
  diagnosedCents: number;
  acceptedCases: number;
  acceptedCents: number;
  /** acceptedCents / diagnosedCents, whole percent (0 when no value). */
  acceptanceRatePct: number;
}

/** Categories with at least one case, ordered by diagnosed value desc. */
export function deriveTreatmentTypes(cases: ReportCase[]): TreatmentTypeRow[] {
  const byCategory = new Map<CaseCategoryId, TreatmentTypeRow>();
  for (const c of cases) {
    const row =
      byCategory.get(c.category) ??
      {
        category: c.category,
        label: CATEGORY_LABELS[c.category],
        diagnosedCases: 0,
        diagnosedCents: 0,
        acceptedCases: 0,
        acceptedCents: 0,
        acceptanceRatePct: 0,
      };
    row.diagnosedCases += 1;
    row.diagnosedCents += c.caseValueCents;
    if (WON_SET.has(c.status)) {
      row.acceptedCases += 1;
      row.acceptedCents += c.caseValueCents;
    }
    byCategory.set(c.category, row);
  }
  return Array.from(byCategory.values())
    .map((row) => ({ ...row, acceptanceRatePct: pct(row.acceptedCents, row.diagnosedCents) }))
    .sort((a, b) => b.diagnosedCents - a.diagnosedCents);
}

// ── 4. Person rollups (TC / provider) ───────────────────────────────────────

export interface PersonRow {
  name: string;
  diagnosedCases: number;
  diagnosedCents: number;
  acceptedCases: number;
  acceptedCents: number;
  /** acceptedCents / diagnosedCents, whole percent. */
  acceptanceRatePct: number;
}

function derivePersonRollup(
  cases: ReportCase[],
  key: (c: ReportCase) => string,
  fallbackName: string,
): PersonRow[] {
  const byPerson = new Map<string, PersonRow>();
  for (const c of cases) {
    const raw = key(c).trim();
    const name = raw === "" ? fallbackName : raw;
    const row =
      byPerson.get(name) ??
      {
        name,
        diagnosedCases: 0,
        diagnosedCents: 0,
        acceptedCases: 0,
        acceptedCents: 0,
        acceptanceRatePct: 0,
      };
    row.diagnosedCases += 1;
    row.diagnosedCents += c.caseValueCents;
    if (WON_SET.has(c.status)) {
      row.acceptedCases += 1;
      row.acceptedCents += c.caseValueCents;
    }
    byPerson.set(name, row);
  }
  return Array.from(byPerson.values())
    .map((row) => ({ ...row, acceptanceRatePct: pct(row.acceptedCents, row.diagnosedCents) }))
    .sort((a, b) => b.diagnosedCents - a.diagnosedCents);
}

/** Per-assignedTc rollup; blank assignee groups under "Unassigned". */
export function deriveTcPerformance(cases: ReportCase[]): PersonRow[] {
  return derivePersonRollup(cases, (c) => c.assignedTc, "Unassigned");
}

/** Per-doctorName rollup; blank doctor groups under "Not recorded". */
export function deriveProviderPerformance(cases: ReportCase[]): PersonRow[] {
  return derivePersonRollup(cases, (c) => c.doctorName, "Not recorded");
}

// ── 6. Pipeline revenue forecast ────────────────────────────────────────────

export interface PipelineStageRow {
  status: CaseStatusId;
  label: string;
  count: number;
  valueCents: number;
}

export interface PipelineForecast {
  /** All 9 board stages in board order (zero rows included for the chart). */
  stages: PipelineStageRow[];
  totalCents: number;
}

/** Current cases bucketed by the platform's 9 pipeline board stages. */
export function derivePipelineForecast(cases: ReportCase[]): PipelineForecast {
  const byStatus = new Map<CaseStatusId, PipelineStageRow>(
    BOARD_STATUSES.map((s) => [
      s,
      { status: s, label: CASE_STATUSES[s].label, count: 0, valueCents: 0 },
    ]),
  );
  for (const c of cases) {
    const row = byStatus.get(c.status);
    if (!row) continue; // non-board statuses (lost, nurture, …) aren't pipeline
    row.count += 1;
    row.valueCents += c.caseValueCents;
  }
  const stages = BOARD_STATUSES.map((s) => {
    const row = byStatus.get(s);
    // Map is seeded from BOARD_STATUSES, so row always exists.
    return row ?? { status: s, label: CASE_STATUSES[s].label, count: 0, valueCents: 0 };
  });
  return { stages, totalCents: stages.reduce((sum, r) => sum + r.valueCents, 0) };
}

// ── 7a. Win / loss ──────────────────────────────────────────────────────────

export interface LostReasonRow {
  reason: LostReasonId;
  label: string;
  count: number;
  /** count / total lost, whole percent. */
  pctOfLost: number;
}

export interface WinLoss {
  won: number;
  lost: number;
  /** won / (won + lost), whole percent (0 when neither). */
  winRatePct: number;
  lostBreakdown: LostReasonRow[];
}

export function deriveWinLoss(cases: ReportCase[]): WinLoss {
  let won = 0;
  let lost = 0;
  const byReason = new Map<LostReasonId, number>();
  for (const c of cases) {
    if (WON_SET.has(c.status)) won += 1;
    if (c.status === "lost") {
      lost += 1;
      // Contract requires lostReason on lost; defensive fallback for legacy rows.
      const reason: LostReasonId = c.lostReason ?? "other";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
  }
  const lostBreakdown = Array.from(byReason.entries())
    .map(([reason, count]) => ({
      reason,
      label: LOST_REASON_LABELS[reason],
      count,
      pctOfLost: pct(count, lost),
    }))
    .sort((a, b) => b.count - a.count);
  return { won, lost, winRatePct: pct(won, won + lost), lostBreakdown };
}

// ── 7b. Referral sources ────────────────────────────────────────────────────

export interface ReferralRow {
  source: ReferralSourceId;
  label: string;
  count: number;
  /** count / total cases, whole percent. */
  pctOfAll: number;
}

export interface ReferralBreakdown {
  known: ReferralRow[];
  /** Cases with no referralSource recorded. */
  notRecorded: number;
  total: number;
}

export function deriveReferralSources(cases: ReportCase[]): ReferralBreakdown {
  const bySource = new Map<ReferralSourceId, number>();
  let notRecorded = 0;
  for (const c of cases) {
    if (c.referralSource === null) {
      notRecorded += 1;
    } else {
      bySource.set(c.referralSource, (bySource.get(c.referralSource) ?? 0) + 1);
    }
  }
  const known = Array.from(bySource.entries())
    .map(([source, count]) => ({
      source,
      label: REFERRAL_SOURCE_LABELS[source],
      count,
      pctOfAll: pct(count, cases.length),
    }))
    .sort((a, b) => b.count - a.count);
  return { known, notRecorded, total: cases.length };
}

// ── 8. Response rate by channel ─────────────────────────────────────────────

export interface ChannelResponseRow {
  channel: FollowupChannelId;
  label: string;
  /** responded / recorded, whole percent. */
  ratePct: number;
  responded: number;
  /** Completed followups on this channel with patientResponded recorded. */
  recorded: number;
}

const CHANNEL_ORDER: readonly FollowupChannelId[] = [
  "phone_call",
  "text",
  "email",
  "in_person",
];

/**
 * Strictly-recorded response rates: only COMPLETED followups whose
 * patientResponded was explicitly logged (true/false) count. The legacy page
 * silently assumed unlogged phone calls were answered — that inflation is
 * gone; null means "not recorded" and is excluded from the denominator.
 */
export function deriveChannelResponse(followups: ReportFollowup[]): ChannelResponseRow[] {
  const byChannel = new Map<FollowupChannelId, { responded: number; recorded: number }>();
  for (const f of followups) {
    if (f.status !== "completed") continue;
    if (f.patientResponded === null) continue;
    const bucket = byChannel.get(f.channel) ?? { responded: 0, recorded: 0 };
    bucket.recorded += 1;
    if (f.patientResponded) bucket.responded += 1;
    byChannel.set(f.channel, bucket);
  }
  return CHANNEL_ORDER.filter((ch) => (byChannel.get(ch)?.recorded ?? 0) > 0).map((ch) => {
    const { responded, recorded } = byChannel.get(ch) ?? { responded: 0, recorded: 0 };
    return {
      channel: ch,
      label: CHANNEL_LABELS[ch],
      ratePct: pct(responded, recorded),
      responded,
      recorded,
    };
  });
}
