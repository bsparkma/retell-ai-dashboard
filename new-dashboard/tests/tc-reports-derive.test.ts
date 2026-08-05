import { describe, expect, it } from "vitest";
import {
  deriveChannelResponse,
  deriveKpis,
  deriveMonthlySeries,
  derivePipelineForecast,
  deriveProviderPerformance,
  deriveReferralSources,
  deriveTcPerformance,
  deriveTreatmentTypes,
  deriveWinLoss,
} from "../client/src/features/tc/reports/derive";
import type { ReportCase, ReportFollowup } from "../client/src/features/tc/reports/derive";
import { BOARD_STATUSES } from "../client/src/features/tc/status";

// ── Fixtures ────────────────────────────────────────────────────────────────

function mkCase(overrides: Partial<ReportCase> = {}): ReportCase {
  return {
    status: "diagnosed",
    caseValueCents: 100_000, // $1,000
    category: "single_tooth",
    assignedTc: "sarah",
    doctorName: "Dr. Sparkman",
    referralSource: null,
    lostReason: null,
    createdAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function mkFollowup(overrides: Partial<ReportFollowup> = {}): ReportFollowup {
  return {
    status: "completed",
    channel: "phone_call",
    patientResponded: null,
    ...overrides,
  };
}

const FIXTURE_CASES: ReportCase[] = [
  // $1,000 diagnosed (July)
  mkCase({ status: "diagnosed", caseValueCents: 100_000, createdAt: "2026-07-01T00:00:00.000Z" }),
  // $2,000 accepted, implant, sarah, google (July)
  mkCase({
    status: "accepted",
    caseValueCents: 200_000,
    category: "implant",
    referralSource: "google",
    createdAt: "2026-07-10T00:00:00.000Z",
  }),
  // $3,000 scheduled, implant, mike, Dr. Lee, google (June)
  mkCase({
    status: "scheduled",
    caseValueCents: 300_000,
    category: "implant",
    assignedTc: "mike",
    doctorName: "Dr. Lee",
    referralSource: "google",
    createdAt: "2026-06-20T00:00:00.000Z",
  }),
  // $4,000 completed, walk-in (June)
  mkCase({
    status: "completed",
    caseValueCents: 400_000,
    referralSource: "walk_in",
    createdAt: "2026-06-05T00:00:00.000Z",
  }),
  // $500 lost (unresponsive), unassigned TC, blank doctor (July)
  mkCase({
    status: "lost",
    caseValueCents: 50_000,
    lostReason: "unresponsive",
    assignedTc: "",
    doctorName: "",
    createdAt: "2026-07-20T00:00:00.000Z",
  }),
  // $1,500 lost (no reason recorded — defensive "other" bucket) (June)
  mkCase({
    status: "lost",
    caseValueCents: 150_000,
    lostReason: null,
    createdAt: "2026-06-25T00:00:00.000Z",
  }),
  // $2,500 considering — active pipeline, not won, not lost (July)
  mkCase({
    status: "considering",
    caseValueCents: 250_000,
    createdAt: "2026-07-30T00:00:00.000Z",
  }),
];

// ── KPIs ────────────────────────────────────────────────────────────────────

describe("deriveKpis", () => {
  it("computes all-time totals, accepted set, unscheduled, and average", () => {
    const k = deriveKpis(FIXTURE_CASES);
    expect(k.totalCases).toBe(7);
    expect(k.totalValueCents).toBe(1_450_000);
    // accepted | scheduled | started | completed → 3 cases, $9,000
    expect(k.acceptedCases).toBe(3);
    expect(k.acceptedValueCents).toBe(900_000);
    expect(k.acceptanceRatePct).toBe(43); // 3/7 → 42.86 → 43
    // Unscheduled = status exactly 'accepted'
    expect(k.unscheduledCases).toBe(1);
    expect(k.unscheduledValueCents).toBe(200_000);
    expect(k.avgCaseSizeCents).toBe(Math.round(1_450_000 / 7));
  });

  it("empty input produces zeros, never NaN", () => {
    const k = deriveKpis([]);
    expect(k).toEqual({
      totalCases: 0,
      totalValueCents: 0,
      acceptedCases: 0,
      acceptedValueCents: 0,
      acceptanceRatePct: 0,
      unscheduledCases: 0,
      unscheduledValueCents: 0,
      avgCaseSizeCents: 0,
    });
    expect(Object.values(k).every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ── Monthly series ──────────────────────────────────────────────────────────

describe("deriveMonthlySeries", () => {
  it("groups by createdAt month, ascending, with current-status accepted value", () => {
    const series = deriveMonthlySeries(FIXTURE_CASES);
    expect(series.map((p) => p.month)).toEqual(["2026-06", "2026-07"]);
    const june = series[0];
    const july = series[1];
    // June: $3,000 scheduled + $4,000 completed + $1,500 lost = $8,500 diagnosed
    expect(june?.diagnosedCents).toBe(850_000);
    expect(june?.acceptedCents).toBe(700_000); // scheduled + completed
    expect(june?.label).toBe("Jun 2026");
    // July: $1,000 + $2,000 + $500 + $2,500 = $6,000; accepted = $2,000
    expect(july?.diagnosedCents).toBe(600_000);
    expect(july?.acceptedCents).toBe(200_000);
  });

  it("skips malformed timestamps and returns empty for empty input", () => {
    expect(deriveMonthlySeries([])).toEqual([]);
    expect(deriveMonthlySeries([mkCase({ createdAt: "not-a-date" })])).toEqual([]);
  });
});

// ── Treatment types ─────────────────────────────────────────────────────────

describe("deriveTreatmentTypes", () => {
  it("rolls up diagnosed vs accepted value per category, sorted by value", () => {
    const rows = deriveTreatmentTypes(FIXTURE_CASES);
    // single_tooth: 5 cases $9,500; implant: 2 cases $5,000
    expect(rows.map((r) => r.category)).toEqual(["single_tooth", "implant"]);
    const single = rows[0];
    const implant = rows[1];
    expect(single?.diagnosedCases).toBe(5);
    expect(single?.diagnosedCents).toBe(950_000);
    expect(single?.acceptedCents).toBe(400_000); // only the completed $4,000
    expect(single?.acceptanceRatePct).toBe(42);
    expect(implant?.diagnosedCents).toBe(500_000);
    expect(implant?.acceptedCents).toBe(500_000); // both implants won
    expect(implant?.acceptanceRatePct).toBe(100);
  });

  it("empty input produces an empty list (no NaN rates)", () => {
    expect(deriveTreatmentTypes([])).toEqual([]);
  });
});

// ── Person rollups ──────────────────────────────────────────────────────────

describe("deriveTcPerformance / deriveProviderPerformance", () => {
  it("groups by assignedTc with an Unassigned fallback", () => {
    const rows = deriveTcPerformance(FIXTURE_CASES);
    const names = rows.map((r) => r.name);
    expect(names).toContain("sarah");
    expect(names).toContain("mike");
    expect(names).toContain("Unassigned");
    const sarah = rows.find((r) => r.name === "sarah");
    // sarah: $1,000 diagnosed + $2,000 accepted + $4,000 completed + $1,500 lost + $2,500 considering
    expect(sarah?.diagnosedCents).toBe(1_100_000);
    expect(sarah?.acceptedCents).toBe(600_000);
    const unassigned = rows.find((r) => r.name === "Unassigned");
    expect(unassigned?.diagnosedCases).toBe(1);
    expect(unassigned?.acceptedCents).toBe(0);
  });

  it("groups providers by doctorName with a Not recorded fallback", () => {
    const rows = deriveProviderPerformance(FIXTURE_CASES);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Dr. Sparkman");
    expect(names).toContain("Dr. Lee");
    expect(names).toContain("Not recorded");
    const lee = rows.find((r) => r.name === "Dr. Lee");
    expect(lee?.diagnosedCents).toBe(300_000);
    expect(lee?.acceptanceRatePct).toBe(100);
  });

  it("empty input produces empty lists", () => {
    expect(deriveTcPerformance([])).toEqual([]);
    expect(deriveProviderPerformance([])).toEqual([]);
  });
});

// ── Pipeline forecast ───────────────────────────────────────────────────────

describe("derivePipelineForecast", () => {
  it("buckets cases into the 9 board stages and totals their value", () => {
    const f = derivePipelineForecast(FIXTURE_CASES);
    expect(f.stages.map((s) => s.status)).toEqual(BOARD_STATUSES);
    const byStatus = new Map(f.stages.map((s) => [s.status, s]));
    expect(byStatus.get("diagnosed")?.count).toBe(1);
    expect(byStatus.get("diagnosed")?.valueCents).toBe(100_000);
    expect(byStatus.get("considering")?.valueCents).toBe(250_000);
    expect(byStatus.get("accepted")?.valueCents).toBe(200_000);
    expect(byStatus.get("scheduled")?.valueCents).toBe(300_000);
    // completed + lost are NOT board stages → excluded from the pipeline total.
    expect(f.totalCents).toBe(100_000 + 250_000 + 200_000 + 300_000);
  });

  it("empty input yields all-zero stages and a zero total", () => {
    const f = derivePipelineForecast([]);
    expect(f.totalCents).toBe(0);
    expect(f.stages).toHaveLength(BOARD_STATUSES.length);
    expect(f.stages.every((s) => s.count === 0 && s.valueCents === 0)).toBe(true);
  });
});

// ── Win / loss ──────────────────────────────────────────────────────────────

describe("deriveWinLoss", () => {
  it("counts won vs lost and groups lost reasons (null → Other)", () => {
    const w = deriveWinLoss(FIXTURE_CASES);
    expect(w.won).toBe(3);
    expect(w.lost).toBe(2);
    expect(w.winRatePct).toBe(60); // 3 / 5
    expect(w.lostBreakdown).toHaveLength(2);
    const reasons = new Map(w.lostBreakdown.map((r) => [r.reason, r]));
    expect(reasons.get("unresponsive")?.count).toBe(1);
    expect(reasons.get("unresponsive")?.label).toBe("Unresponsive");
    expect(reasons.get("other")?.count).toBe(1); // null lostReason fallback
    expect(reasons.get("unresponsive")?.pctOfLost).toBe(50);
  });

  it("empty input yields zero win rate (no NaN) and empty breakdown", () => {
    expect(deriveWinLoss([])).toEqual({
      won: 0,
      lost: 0,
      winRatePct: 0,
      lostBreakdown: [],
    });
  });
});

// ── Referral sources ────────────────────────────────────────────────────────

describe("deriveReferralSources", () => {
  it("groups recorded sources and counts unrecorded separately", () => {
    const r = deriveReferralSources(FIXTURE_CASES);
    expect(r.total).toBe(7);
    expect(r.notRecorded).toBe(4);
    expect(r.known).toHaveLength(2);
    expect(r.known[0]?.source).toBe("google"); // 2 cases, sorted first
    expect(r.known[0]?.count).toBe(2);
    expect(r.known[0]?.pctOfAll).toBe(29); // 2/7
    expect(r.known[1]?.source).toBe("walk_in");
    expect(r.known[1]?.label).toBe("Walk-in");
  });

  it("empty input yields empty known list and zero counts", () => {
    expect(deriveReferralSources([])).toEqual({ known: [], notRecorded: 0, total: 0 });
  });
});

// ── Channel response rates ──────────────────────────────────────────────────

describe("deriveChannelResponse", () => {
  it("computes rates only from completed followups with a recorded reply", () => {
    const rows = deriveChannelResponse([
      mkFollowup({ channel: "phone_call", patientResponded: true }),
      mkFollowup({ channel: "phone_call", patientResponded: false }),
      mkFollowup({ channel: "phone_call", patientResponded: null }), // not recorded → excluded
      mkFollowup({ channel: "text", patientResponded: true }),
      mkFollowup({ channel: "text", patientResponded: true }),
      mkFollowup({ channel: "text", patientResponded: false }),
      mkFollowup({ channel: "email", patientResponded: false }),
      // Non-completed rows never count, even with a reply logged.
      mkFollowup({ status: "pending", channel: "email", patientResponded: true }),
      mkFollowup({ status: "skipped", channel: "in_person", patientResponded: true }),
    ]);
    expect(rows.map((r) => r.channel)).toEqual(["phone_call", "text", "email"]);
    const phone = rows[0];
    const text = rows[1];
    const email = rows[2];
    expect(phone?.recorded).toBe(2);
    expect(phone?.responded).toBe(1);
    expect(phone?.ratePct).toBe(50);
    expect(text?.ratePct).toBe(67); // 2/3
    expect(email?.recorded).toBe(1);
    expect(email?.ratePct).toBe(0);
    expect(phone?.label).toBe("Phone");
  });

  it("empty input (or all-null replies) yields an empty list", () => {
    expect(deriveChannelResponse([])).toEqual([]);
    expect(deriveChannelResponse([mkFollowup({ patientResponded: null })])).toEqual([]);
  });
});
