/**
 * Win celebration derivation (PM ruling 2) — real numbers or none.
 *
 * The legacy overlay showed an MTD total and an acceptance rate read out of
 * mock PIPELINE_STATS. These tests pin the replacement: the accepted-now total
 * is a genuine count of the supplied fixtures, it is ABSENT when no snapshot
 * was supplied, and an acceptance rate is never produced at all.
 */
import { describe, expect, it } from "vitest";
import type { TcCaseSummary } from "@/features/tc/api";
import {
  deriveWinStats,
  firstNameOf,
  isAcceptedStatus,
  type WinTrigger,
} from "@/features/tc/wins/derive";

function makeCase(overrides: Partial<TcCaseSummary> & { caseId: string }): TcCaseSummary {
  return {
    legacyId: null,
    officeId: "roland",
    patientName: "Pat Fixture",
    patientAge: null,
    phone: null,
    email: null,
    odPatientId: null,
    caseType: "Crown",
    category: "single_tooth",
    status: "presented",
    urgency: "medium",
    doctorName: "Dr. Fixture",
    diagnosingProvider: null,
    assignedTc: "Alex Fixture",
    caseValueCents: 100_000,
    readinessScore: 50,
    financingStatus: "",
    preferredFinancingProvider: null,
    decisionMakers: "",
    financialSituation: [],
    keyMotivators: [],
    contactPreference: null,
    bestTimeToReach: "",
    notes: "",
    referralSource: null,
    lostReason: null,
    diagnosedDate: null,
    statusChangedAt: "2026-08-01T12:00:00.000Z",
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: null,
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

const WIN: WinTrigger = {
  caseId: "case-win",
  patientName: "Maria Consuelo Rivera",
  caseValueCents: 480_000,
};

describe("isAcceptedStatus", () => {
  it("counts accepted and partially_accepted, nothing else", () => {
    expect(isAcceptedStatus("accepted")).toBe(true);
    expect(isAcceptedStatus("partially_accepted")).toBe(true);
    for (const s of ["presented", "considering", "scheduled", "started", "completed", "lost"] as const) {
      expect(isAcceptedStatus(s)).toBe(false);
    }
  });
});

describe("firstNameOf", () => {
  it("takes the first word and falls back honestly on a blank name", () => {
    expect(firstNameOf("Maria Consuelo Rivera")).toBe("Maria");
    expect(firstNameOf("  Bo  ")).toBe("Bo");
    expect(firstNameOf("   ")).toBe("This patient");
  });
});

describe("deriveWinStats", () => {
  it("counts the real accepted family from the snapshot, including the winner", () => {
    const cases = [
      makeCase({ caseId: "a", status: "accepted", caseValueCents: 120_000 }),
      makeCase({ caseId: "b", status: "partially_accepted", caseValueCents: 90_000 }),
      makeCase({ caseId: "c", status: "presented", caseValueCents: 700_000 }),
      makeCase({ caseId: "d", status: "scheduled", caseValueCents: 500_000 }),
      makeCase({ caseId: "e", status: "lost", caseValueCents: 300_000 }),
    ];

    const stats = deriveWinStats(WIN, cases);

    expect(stats.patientFirstName).toBe("Maria");
    expect(stats.caseValueCents).toBe(480_000);
    // 2 accepted-family fixtures + the winning case.
    expect(stats.acceptedNow).toEqual({ count: 3, valueCents: 120_000 + 90_000 + 480_000 });
  });

  it("never double counts the winning case when the snapshot already has it accepted", () => {
    const cases = [
      makeCase({ caseId: "case-win", status: "accepted", caseValueCents: 480_000 }),
      makeCase({ caseId: "a", status: "accepted", caseValueCents: 20_000 }),
    ];

    expect(deriveWinStats(WIN, cases).acceptedNow).toEqual({
      count: 2,
      valueCents: 500_000,
    });
  });

  it("counts the winner once even when the snapshot is stale (still pre-accept)", () => {
    // The list fetched before the transition still shows the case as presented.
    const cases = [
      makeCase({ caseId: "case-win", status: "presented", caseValueCents: 480_000 }),
      makeCase({ caseId: "a", status: "accepted", caseValueCents: 20_000 }),
    ];

    expect(deriveWinStats(WIN, cases).acceptedNow).toEqual({
      count: 2,
      valueCents: 500_000,
    });
  });

  it("reports zero-extra honestly when the winner is the only accepted case", () => {
    const cases = [makeCase({ caseId: "c", status: "considering", caseValueCents: 999_000 })];
    expect(deriveWinStats(WIN, cases).acceptedNow).toEqual({
      count: 1,
      valueCents: 480_000,
    });
  });

  it("omits the accepted-now total entirely when no snapshot is available", () => {
    const stats = deriveWinStats(WIN, null);
    expect(stats.acceptedNow).toBeNull();
    // The case's own value is still real and still shown.
    expect(stats.caseValueCents).toBe(480_000);
  });

  it("never produces an acceptance rate — it is not derivable from summaries", () => {
    const cases = [
      makeCase({ caseId: "a", status: "accepted" }),
      makeCase({ caseId: "b", status: "presented" }),
      makeCase({ caseId: "c", status: "lost" }),
    ];
    // Even with presented + accepted + lost rows on hand, no rate is emitted:
    // current status is not history, so any rate would be a guess.
    expect(deriveWinStats(WIN, cases).acceptedRatePercent).toBeNull();
    expect(deriveWinStats(WIN, null).acceptedRatePercent).toBeNull();
  });
});
