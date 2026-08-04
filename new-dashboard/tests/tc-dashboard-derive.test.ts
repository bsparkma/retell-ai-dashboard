/**
 * TC Dashboard derivations — pure-function tests over synthetic fixtures.
 * Guards the HONESTY RULE: every number the Morning Command Screen shows must
 * trace back to real case/followup rows; the huddle text must contain the
 * fixture counts and none of the legacy mock (PIPELINE_STATS) numbers.
 */
import { describe, expect, it } from "vitest";
import type { TcCaseSummary, TcDueFollowup } from "../client/src/features/tc/api";
import {
  addDaysIso,
  buildHuddleText,
  caseAgeDays,
  countActionsToday,
  findAgingCases,
  findCasesWithNoNextStep,
  firstNameOf,
  getGreeting,
  isOpenStatus,
  perTcRollup,
  pipelineNowStats,
  splitDueFollowups,
  topActiveCases,
} from "../client/src/features/tc/dashboard/derive";

const TODAY = "2026-08-03";

// ── Fixtures ────────────────────────────────────────────────────────────────

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

function makeDue(
  overrides: Partial<TcDueFollowup> & { followupId: string; dueDate: string },
): TcDueFollowup {
  return {
    caseId: "case-1",
    officeId: "roland",
    kind: "followup",
    channel: "phone_call",
    status: "pending",
    talkingPoint: "",
    outcomeNote: "",
    completedAt: null,
    completedBy: null,
    source: "manual",
    patientResponded: null,
    nurtureType: null,
    legacyId: null,
    patientName: "Pat Fixture",
    casePhone: null,
    caseStatus: "presented",
    assignedTc: "Alex Fixture",
    caseValueCents: 250_000,
    caseUrgency: "medium",
    ...overrides,
  };
}

// ── Greeting / names / dates ────────────────────────────────────────────────

describe("getGreeting", () => {
  it("buckets by hour", () => {
    expect(getGreeting(0)).toBe("Good morning");
    expect(getGreeting(11)).toBe("Good morning");
    expect(getGreeting(12)).toBe("Good afternoon");
    expect(getGreeting(16)).toBe("Good afternoon");
    expect(getGreeting(17)).toBe("Good evening");
    expect(getGreeting(23)).toBe("Good evening");
  });
});

describe("firstNameOf", () => {
  it("takes the first word and falls back to 'there'", () => {
    expect(firstNameOf("Beau Sparkman")).toBe("Beau");
    expect(firstNameOf("  Cher ")).toBe("Cher");
    expect(firstNameOf("")).toBe("there");
    expect(firstNameOf(undefined)).toBe("there");
  });
});

describe("addDaysIso", () => {
  it("adds calendar days across month boundaries", () => {
    expect(addDaysIso("2026-08-03", 7)).toBe("2026-08-10");
    expect(addDaysIso("2026-08-30", 7)).toBe("2026-09-06");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

// ── Queue split + action count ──────────────────────────────────────────────

describe("splitDueFollowups / countActionsToday", () => {
  const rows = [
    makeDue({ followupId: "f-upcoming", dueDate: "2026-08-05" }),
    makeDue({ followupId: "f-today-high", dueDate: TODAY, caseUrgency: "high" }),
    makeDue({ followupId: "f-overdue", dueDate: "2026-07-30" }),
    makeDue({ followupId: "f-today-low", dueDate: TODAY, caseUrgency: "low" }),
  ];

  it("splits into overdue / today / upcoming, sorted by date then urgency", () => {
    const split = splitDueFollowups(rows, TODAY);
    expect(split.overdue.map((f) => f.followupId)).toEqual(["f-overdue"]);
    expect(split.dueToday.map((f) => f.followupId)).toEqual(["f-today-high", "f-today-low"]);
    expect(split.upcoming.map((f) => f.followupId)).toEqual(["f-upcoming"]);
  });

  it("counts today's actions as overdue + due-today only (never future rows)", () => {
    expect(countActionsToday(splitDueFollowups(rows, TODAY))).toBe(3);
    expect(countActionsToday(splitDueFollowups([], TODAY))).toBe(0);
  });
});

// ── Pipeline-now stats (the honest MTD-banner replacement) ──────────────────

describe("pipelineNowStats", () => {
  it("counts current-state presented/accepted/open with cent-exact values", () => {
    const stats = pipelineNowStats([
      makeCase({ caseId: "c1", status: "presented", caseValueCents: 120_000 }),
      makeCase({ caseId: "c2", status: "presented", caseValueCents: 80_000 }),
      makeCase({ caseId: "c3", status: "accepted", caseValueCents: 500_000 }),
      makeCase({ caseId: "c4", status: "partially_accepted", caseValueCents: 50_000 }),
      makeCase({ caseId: "c5", status: "completed", caseValueCents: 999_999 }),
      makeCase({ caseId: "c6", status: "considering", caseValueCents: 30_000 }),
    ]);
    expect(stats.presentedCount).toBe(2);
    expect(stats.presentedValueCents).toBe(200_000);
    expect(stats.acceptedCount).toBe(2);
    expect(stats.acceptedValueCents).toBe(550_000);
    // Open = everything except scheduled/started/completed/lost.
    expect(stats.openCount).toBe(5);
    expect(stats.openValueCents).toBe(780_000);
  });
});

// ── Aging detection ─────────────────────────────────────────────────────────

describe("caseAgeDays / findAgingCases", () => {
  it("anchors on statusChangedAt, falls back to createdAt, never guesses", () => {
    expect(
      caseAgeDays(makeCase({ caseId: "c1", statusChangedAt: "2026-07-01T00:00:00.000Z" }), TODAY),
    ).toBe(33);
    expect(
      caseAgeDays(
        makeCase({ caseId: "c2", statusChangedAt: null, createdAt: "2026-08-01T00:00:00.000Z" }),
        TODAY,
      ),
    ).toBe(2);
  });

  it("flags only open cases older than the threshold", () => {
    const fresh = makeCase({ caseId: "fresh", statusChangedAt: "2026-07-20T00:00:00.000Z" });
    const stale = makeCase({ caseId: "stale", statusChangedAt: "2026-06-01T00:00:00.000Z" });
    const staleButClosed = makeCase({
      caseId: "closed",
      status: "completed",
      statusChangedAt: "2026-01-01T00:00:00.000Z",
    });
    const aging = findAgingCases([fresh, stale, staleButClosed], TODAY);
    expect(aging.map((c) => c.caseId)).toEqual(["stale"]);
  });

  it("exactly 30 days old is not yet aging (strict > threshold)", () => {
    const boundary = makeCase({ caseId: "b", statusChangedAt: "2026-07-04T00:00:00.000Z" });
    expect(caseAgeDays(boundary, TODAY)).toBe(30);
    expect(findAgingCases([boundary], TODAY)).toEqual([]);
  });
});

// ── No-next-step detection ──────────────────────────────────────────────────

describe("findCasesWithNoNextStep", () => {
  it("flags open cases without any pending followup", () => {
    const covered = makeCase({ caseId: "covered" });
    const orphan = makeCase({ caseId: "orphan" });
    const closedOrphan = makeCase({ caseId: "closed", status: "lost" });
    const result = findCasesWithNoNextStep(
      [covered, orphan, closedOrphan],
      [
        { caseId: "covered", status: "pending" },
        { caseId: "orphan", status: "completed" }, // completed ≠ next step
      ],
    );
    expect(result.map((c) => c.caseId)).toEqual(["orphan"]);
  });
});

// ── Active cases card ───────────────────────────────────────────────────────

describe("topActiveCases", () => {
  it("keeps only decision-stage statuses, sorted by value, capped", () => {
    const cases = [
      makeCase({ caseId: "small", status: "considering", caseValueCents: 10_000 }),
      makeCase({ caseId: "big", status: "presented", caseValueCents: 900_000 }),
      makeCase({ caseId: "accepted", status: "accepted", caseValueCents: 999_999 }),
      makeCase({ caseId: "mid", status: "financing_pending", caseValueCents: 500_000 }),
      makeCase({ caseId: "ptc", status: "pending_tc", caseValueCents: 700_000 }),
      makeCase({ caseId: "ppt", status: "pending_pt", caseValueCents: 800_000 }),
    ];
    const top = topActiveCases(cases, 3);
    expect(top.map((c) => c.caseId)).toEqual(["big", "ptc", "mid"]);
  });
});

// ── Per-TC rollup ───────────────────────────────────────────────────────────

describe("perTcRollup", () => {
  it("groups open + accepted-now per assigned TC, skipping blank assignees", () => {
    const rollups = perTcRollup([
      makeCase({ caseId: "a1", assignedTc: "Alex", status: "presented", caseValueCents: 100_000 }),
      makeCase({ caseId: "a2", assignedTc: "Alex", status: "accepted", caseValueCents: 300_000 }),
      makeCase({ caseId: "b1", assignedTc: "Blair", status: "considering", caseValueCents: 450_000 }),
      makeCase({ caseId: "b2", assignedTc: "Blair", status: "completed", caseValueCents: 999_999 }),
      makeCase({ caseId: "x1", assignedTc: "  ", status: "presented", caseValueCents: 50_000 }),
    ]);
    expect(rollups).toHaveLength(2);
    const [first, second] = rollups;
    // Sorted by open pipeline value desc: Blair (450k) before Alex (100k + 300k —
    // accepted counts as open too since it's not a closed status).
    expect(first?.assignedTc).toBe("Blair");
    expect(first?.openCount).toBe(1);
    expect(first?.openValueCents).toBe(450_000);
    expect(first?.acceptedNowCount).toBe(0);
    expect(second?.assignedTc).toBe("Alex");
    expect(second?.openCount).toBe(2); // presented + accepted (accepted is still open)
    expect(second?.openValueCents).toBe(400_000);
    expect(second?.acceptedNowCount).toBe(1);
    expect(second?.acceptedNowValueCents).toBe(300_000);
  });

  it("returns empty (honest empty state) when no case has an assignee", () => {
    expect(perTcRollup([makeCase({ caseId: "c", assignedTc: "" })])).toEqual([]);
  });
});

// ── Huddle text ─────────────────────────────────────────────────────────────

describe("buildHuddleText", () => {
  it("contains real counts, names, and values — and no fabricated numbers", () => {
    const overdue = [
      makeDue({
        followupId: "f1",
        dueDate: "2026-07-28",
        patientName: "Maria Santos",
        caseValueCents: 425_000,
        channel: "phone_call",
      }),
    ];
    const dueToday = [
      makeDue({
        followupId: "f2",
        dueDate: TODAY,
        patientName: "James Wilson",
        caseValueCents: 180_000,
        channel: "text",
      }),
    ];
    const stats = pipelineNowStats([
      makeCase({ caseId: "c1", status: "presented", caseValueCents: 605_000 }),
      makeCase({ caseId: "c2", status: "accepted", caseValueCents: 250_000 }),
    ]);
    const text = buildHuddleText({
      dateLabel: "Monday, August 3, 2026",
      tcName: "Beau Sparkman",
      overdue,
      dueToday,
      stats,
      agingCount: 2,
      noNextStepCount: 1,
    });

    expect(text).toContain("Morning Huddle — Monday, August 3, 2026");
    expect(text).toContain("TC: Beau Sparkman");
    expect(text).toContain("OVERDUE (1):");
    expect(text).toContain("Maria Santos ($4,250) — call, due 2026-07-28");
    expect(text).toContain("TODAY'S FOLLOW-UPS (1):");
    expect(text).toContain("James Wilson ($1,800) — text, due 2026-08-03");
    expect(text).toContain(
      "PIPELINE NOW: 2 open cases worth $8,550 · presented now: 1 ($6,050) · accepted now: 1 ($2,500)",
    );
    expect(text).toContain("HEALTH: 1 case with no next step · 2 cases aging 30+ days");
    // Honesty guard: nothing MTD, no consults, none of the legacy seed numbers.
    expect(text).not.toMatch(/MTD/i);
    expect(text).not.toMatch(/CONSULT/i);
    expect(text).not.toContain("$48,200"); // legacy PIPELINE_STATS-style figures
  });

  it("says all-caught-up (not fake rows) when nothing is due, and omits HEALTH at zero", () => {
    const text = buildHuddleText({
      dateLabel: "Monday, August 3, 2026",
      tcName: "",
      overdue: [],
      dueToday: [],
      stats: pipelineNowStats([]),
      agingCount: 0,
      noNextStepCount: 0,
    });
    expect(text).toContain("TC: —");
    expect(text).toContain("No follow-ups due today — all caught up.");
    expect(text).toContain("PIPELINE NOW: 0 open cases worth $0");
    expect(text).not.toContain("HEALTH:");
    expect(text).not.toContain("OVERDUE");
  });
});

// ── Status helper sanity ────────────────────────────────────────────────────

describe("isOpenStatus", () => {
  it("closes scheduled/started/completed/lost only", () => {
    expect(isOpenStatus("scheduled")).toBe(false);
    expect(isOpenStatus("started")).toBe(false);
    expect(isOpenStatus("completed")).toBe(false);
    expect(isOpenStatus("lost")).toBe(false);
    expect(isOpenStatus("presented")).toBe(true);
    expect(isOpenStatus("hygiene_review")).toBe(true);
    expect(isOpenStatus("accepted")).toBe(true);
  });
});
