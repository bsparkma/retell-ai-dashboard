/**
 * Nurture pure-logic tests: phase derivation from nurtureEnrolledAt (60-day
 * threshold), days-enrolled math, cadence resolution with per-phase overrides,
 * cadence display strings, date helpers, and the financing talking point
 * (integer-cents monthly figure, whole-dollar rendering).
 */
import { describe, expect, it } from "vitest";
import {
  NURTURE_PHASE1_DEFAULT_DAYS,
  NURTURE_PHASE2_DEFAULT_DAYS,
  NURTURE_PHASE2_THRESHOLD_DAYS,
  addDaysIso,
  buildFinancingTalkingPoint,
  daysSince,
  financingMonthlyCents,
  formatCadence,
  getCadenceDays,
  getDaysEnrolled,
  getNurturePhase,
  hasCadenceOverride,
  nurtureTypeLabel,
  type NurtureCaseScalars,
} from "@/features/tc/nurture/nurtureUtils";

const TODAY = "2026-03-10";

function scalars(overrides: Partial<NurtureCaseScalars> = {}): NurtureCaseScalars {
  return {
    nurtureEnrolledAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    ...overrides,
  };
}

describe("daysSince / addDaysIso", () => {
  it("counts whole calendar days from date-only strings", () => {
    expect(daysSince("2026-03-08", TODAY)).toBe(2);
    expect(daysSince(TODAY, TODAY)).toBe(0);
    expect(daysSince("2026-03-12", TODAY)).toBe(-2);
  });

  it("uses only the date part of a full ISO timestamp", () => {
    expect(daysSince("2026-03-08T23:59:59.000Z", TODAY)).toBe(2);
    expect(daysSince("2026-03-10T00:00:01.000Z", TODAY)).toBe(0);
  });

  it("adds days across month boundaries", () => {
    expect(addDaysIso("2026-03-28", 7)).toBe("2026-04-04");
    expect(addDaysIso("2026-03-10", 0)).toBe("2026-03-10");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("getNurturePhase", () => {
  it("returns null when never enrolled", () => {
    expect(getNurturePhase(scalars(), TODAY)).toBeNull();
  });

  it("is Phase 1 before the 60-day threshold", () => {
    expect(
      getNurturePhase(scalars({ nurtureEnrolledAt: "2026-03-01T12:00:00.000Z" }), TODAY),
    ).toBe(1);
    // Day 59 — still Phase 1.
    const day59 = addDaysIso(TODAY, -(NURTURE_PHASE2_THRESHOLD_DAYS - 1));
    expect(
      getNurturePhase(scalars({ nurtureEnrolledAt: `${day59}T00:00:00.000Z` }), TODAY),
    ).toBe(1);
  });

  it("flips to Phase 2 at exactly 60 days and beyond", () => {
    const day60 = addDaysIso(TODAY, -NURTURE_PHASE2_THRESHOLD_DAYS);
    expect(
      getNurturePhase(scalars({ nurtureEnrolledAt: `${day60}T00:00:00.000Z` }), TODAY),
    ).toBe(2);
    expect(
      getNurturePhase(scalars({ nurtureEnrolledAt: "2025-01-01T00:00:00.000Z" }), TODAY),
    ).toBe(2);
  });
});

describe("getDaysEnrolled", () => {
  it("is 0 when not enrolled", () => {
    expect(getDaysEnrolled(scalars(), TODAY)).toBe(0);
  });

  it("counts days since enrollment", () => {
    expect(
      getDaysEnrolled(scalars({ nurtureEnrolledAt: "2026-02-24T09:00:00.000Z" }), TODAY),
    ).toBe(14);
  });

  it("clamps future enrollment timestamps to 0", () => {
    expect(
      getDaysEnrolled(scalars({ nurtureEnrolledAt: "2026-03-12T00:00:00.000Z" }), TODAY),
    ).toBe(0);
  });
});

describe("getCadenceDays / formatCadence", () => {
  const phase1Enrolled = scalars({ nurtureEnrolledAt: "2026-03-01T00:00:00.000Z" });
  const phase2Enrolled = scalars({ nurtureEnrolledAt: "2025-11-01T00:00:00.000Z" });

  it("uses phase defaults when no override is set", () => {
    expect(getCadenceDays(phase1Enrolled, TODAY)).toBe(NURTURE_PHASE1_DEFAULT_DAYS);
    expect(getCadenceDays(phase2Enrolled, TODAY)).toBe(NURTURE_PHASE2_DEFAULT_DAYS);
    expect(formatCadence(phase1Enrolled, TODAY)).toBe("14d (default)");
    expect(formatCadence(phase2Enrolled, TODAY)).toBe("30d (default)");
  });

  it("respects the override for the current phase", () => {
    const p1 = { ...phase1Enrolled, nurturePhase1DaysOverride: 21 };
    const p2 = { ...phase2Enrolled, nurturePhase2DaysOverride: 45 };
    expect(getCadenceDays(p1, TODAY)).toBe(21);
    expect(getCadenceDays(p2, TODAY)).toBe(45);
    expect(formatCadence(p1, TODAY)).toBe("21d (override)");
    expect(formatCadence(p2, TODAY)).toBe("45d (override)");
  });

  it("phase 2 falls back to its default even when only phase 1 is overridden", () => {
    const c = { ...phase2Enrolled, nurturePhase1DaysOverride: 10 };
    expect(getCadenceDays(c, TODAY)).toBe(NURTURE_PHASE2_DEFAULT_DAYS);
    // Any override still marks the cadence as overridden in the display.
    expect(hasCadenceOverride(c)).toBe(true);
    expect(formatCadence(c, TODAY)).toBe("30d (override)");
  });

  it("unenrolled cases read as Phase 1 cadence", () => {
    expect(getCadenceDays(scalars(), TODAY)).toBe(NURTURE_PHASE1_DEFAULT_DAYS);
  });
});

describe("financing talking point", () => {
  it("computes the 48-month figure in integer cents", () => {
    expect(financingMonthlyCents(480_000)).toBe(10_000); // $4,800 → $100/mo
    expect(financingMonthlyCents(250_000)).toBe(5_208); // rounded cents
  });

  it("renders whole dollars via formatCents — no fake precision", () => {
    const msg = buildFinancingTalkingPoint("Maria Lopez", 250_000);
    expect(msg).toContain("Hi Maria,");
    expect(msg).toContain("as low as $52/month");
    expect(msg).not.toContain("$52.08");
  });
});

describe("nurtureTypeLabel", () => {
  it("maps known types and falls back to 'nurture'", () => {
    expect(nurtureTypeLabel("check_in")).toBe("check in");
    expect(nurtureTypeLabel("life_event")).toBe("life event");
    expect(nurtureTypeLabel(null)).toBe("nurture");
  });
});
