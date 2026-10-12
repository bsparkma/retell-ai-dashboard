/**
 * The conversion funnel as SERVED by GET /api/tc/reports/funnel (item 42).
 *
 * Every number on the Conversion section — and the acceptance rate the win
 * overlay may now show — comes from this module's parse of the server's
 * response. Nothing here computes a rate. The server derives each figure from
 * recorded status transitions (backend/routes/tc/funnel.js documents the
 * evidence base and every counting rule); this file only validates the shape
 * and brands the result, so a hand-built object cannot pass for served data
 * without an explicit, reviewable cast.
 */
import { z } from "zod";
import { CaseStatus, LostReason } from "@shared/tc/contract";
import type { CaseStatusId } from "../status";

const Percent = z.number().finite().nullable();
const Count = z.number().int().nonnegative();
const Cents = z.number().int();

const PersonRow = z.object({
  name: z.string(),
  presentedCases: Count,
  acceptedCases: Count,
  acceptedValueCents: Cents,
  acceptanceRatePercent: Percent,
});

export const FunnelReportSchema = z.object({
  office: z.enum(["roland", "valley"]),
  timeZone: z.string(),
  window: z.object({
    requestedFrom: z.string(),
    to: z.string(),
    fromTs: z.string(),
    toTs: z.string(),
    clampedToCoverage: z.boolean(),
  }),
  coverageStartsAt: z.string().nullable(),
  coverageNote: z.string().nullable(),
  reliableEntries: Count,
  acceptance: z.object({
    presentedCases: Count,
    acceptedCases: Count,
    acceptanceRatePercent: Percent,
    presentedValueCents: Cents,
    acceptedValueCents: Cents,
    valueAcceptanceRatePercent: Percent,
  }),
  stages: z.array(
    z.object({
      status: CaseStatus,
      entered: Count,
      progressed: Count,
      lostAfter: Count,
      conversionPercent: Percent,
      completedStays: Count,
      openStays: Count,
      medianDays: z.number().finite().nullable(),
      p90Days: z.number().finite().nullable(),
    }),
  ),
  acceptedByWeek: z.array(
    z.object({ weekStart: z.string(), wonCases: Count, wonValueCents: Cents }),
  ),
  winLoss: z.object({
    wonCases: Count,
    wonValueCents: Cents,
    lostCases: Count,
    winRatePercent: Percent,
    byLostReason: z.array(z.object({ reason: LostReason.nullable(), lostCases: Count })),
  }),
  byAssignedTc: z.array(PersonRow),
  byDoctor: z.array(PersonRow),
  nurtureReactivations: z.object({ cases: Count, valueCents: Cents }),
});

export type FunnelReportShape = z.infer<typeof FunnelReportSchema>;
export type FunnelStage = FunnelReportShape["stages"][number];
export type FunnelPersonRow = z.infer<typeof PersonRow>;

declare const servedBrand: unique symbol;

/** A funnel report that came off the wire and passed the schema. */
export type ServedFunnel = FunnelReportShape & { readonly [servedBrand]: "served" };

/**
 * The windowed acceptance rate, carried with the facts that make it honest:
 * its numerator, denominator and window. Only {@link servedAcceptanceRate}
 * produces one, and only from a {@link ServedFunnel}.
 */
export interface ServedAcceptanceRate {
  readonly [servedBrand]: "served";
  readonly percent: number;
  readonly acceptedCases: number;
  readonly presentedCases: number;
  /** ISO instant the window actually starts (after any clamp to coverage). */
  readonly windowFromTs: string;
  /** The window's last local calendar day, YYYY-MM-DD. */
  readonly windowTo: string;
  /** True when the requested window began before recorded history did. */
  readonly clampedToCoverage: boolean;
  /** The office time zone the server used for calendar days. */
  readonly timeZone: string;
}

/** Validate a server response body's `funnel`. Throws on a shape mismatch. */
export function parseServedFunnel(body: unknown): ServedFunnel {
  const parsed = FunnelReportSchema.parse(body);
  return parsed as ServedFunnel;
}

/** The served rate, or null when the server served none (no presented cases). */
export function servedAcceptanceRate(funnel: ServedFunnel): ServedAcceptanceRate | null {
  const a = funnel.acceptance;
  if (a.acceptanceRatePercent === null || a.presentedCases === 0) return null;
  return {
    percent: a.acceptanceRatePercent,
    acceptedCases: a.acceptedCases,
    presentedCases: a.presentedCases,
    windowFromTs: funnel.window.fromTs,
    windowTo: funnel.window.to,
    clampedToCoverage: funnel.window.clampedToCoverage,
    timeZone: funnel.timeZone,
  } as ServedAcceptanceRate;
}

// ── Window presets (the client only ever chooses a START DATE) ──────────────

export const FUNNEL_PRESETS = [
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "365d", label: "Last 12 months", days: 365 },
] as const;
export type FunnelPresetId = (typeof FUNNEL_PRESETS)[number]["id"];

/** YYYY-MM-DD for the local calendar day `days - 1` days before `now`. */
export function presetFromDate(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ── Display helpers (formatting only — no arithmetic on served figures) ─────

/** "Aug 20, 2026" for an ISO instant, in the office's time zone. */
export function formatCoverageDate(iso: string, timeZone: string): string {
  const d = new Date(iso);
  try {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
  } catch {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
}

/** "50%" / "82.4%" / "—" (null = the server had no denominator). */
export function formatPercent(p: number | null): string {
  if (p === null) return "—";
  return `${Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)}%`;
}

/** "4 d" / "2.8 d" / "—". */
export function formatDays(d: number | null): string {
  if (d === null) return "—";
  return `${Number.isInteger(d) ? d.toFixed(0) : d.toFixed(1)} d`;
}

/** The caption every rate tile carries: what window, since when. */
export function coverageCaption(funnel: ServedFunnel): string {
  if (funnel.coverageStartsAt === null) {
    return "No recorded status changes yet";
  }
  const since = formatCoverageDate(funnel.coverageStartsAt, funnel.timeZone);
  if (funnel.window.clampedToCoverage) {
    return `Since ${since}, when status history begins · through ${funnel.window.to}`;
  }
  return `${funnel.window.requestedFrom} – ${funnel.window.to} · history recorded since ${since}`;
}

/** Board-order stage list as served (the server always sends all 9). */
export function servedStages(funnel: ServedFunnel): FunnelStage[] {
  return funnel.stages;
}

export type { CaseStatusId };
