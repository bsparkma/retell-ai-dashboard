/**
 * Post-consult outcome → mutation-plan mapping (pure planner, no network).
 *
 * Covers all 5 outcomes: status targets, objection payload, follow-up
 * date offsets/channels (library cadence + legacy default fallback, urgency
 * and spouse_family first-touch modifiers), declined reasons including the
 * "other" → nurture track, and validation failures.
 */
import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  cadenceOffsets,
  channelForStep,
  DEFAULT_CADENCE,
  NO_OBJECTION_OFFSETS,
  planConsultOutcome,
  type ConsultCaseInfo,
  type ConsultInput,
  type ConsultStep,
} from "../client/src/features/tc/consult/outcomeActions";

const TODAY = "2026-08-03";

function makeCase(overrides: Partial<ConsultCaseInfo> = {}): ConsultCaseInfo {
  return {
    caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    caseValueCents: 450_000, // standard tier (>= $1k, <= $5k)
    urgency: "medium",
    contactPreference: null,
    phases: [
      { phaseId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phase 1 — Foundation" },
      { phaseId: "aaaaaaaa-0000-0000-0000-000000000002", name: "Phase 2 — Restoration" },
    ],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ConsultInput> = {}): ConsultInput {
  return {
    outcome: "accepted_full",
    tcCase: makeCase(),
    today: TODAY,
    note: "",
    objectionCategory: null,
    objectionWords: "",
    acceptedPhaseIds: [],
    declineReason: null,
    cadence: null,
    ...overrides,
  };
}

function transitions(steps: ConsultStep[]) {
  return steps.filter((s) => s.kind === "transition");
}
function followups(steps: ConsultStep[]) {
  return steps.filter((s) => s.kind === "followup");
}

// ── accepted_full ───────────────────────────────────────────────────────────

describe("accepted_full", () => {
  it("plans a single transition to accepted with no lostReason", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "accepted_full", note: "verbal yes" }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.steps).toHaveLength(1);
    const t = plan.steps[0];
    expect(t).toMatchObject({ kind: "transition", status: "accepted", lostReason: null });
    if (t?.kind === "transition") expect(t.note).toContain("verbal yes");
    expect(plan.firstTouchDays).toBeNull();
  });
});

// ── accepted_phased ─────────────────────────────────────────────────────────

describe("accepted_phased", () => {
  it("requires at least one phase", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "accepted_phased" }));
    expect(plan.ok).toBe(false);
  });

  it("all phases selected → accepted", () => {
    const c = makeCase();
    const plan = planConsultOutcome(
      makeInput({
        outcome: "accepted_phased",
        tcCase: c,
        acceptedPhaseIds: c.phases.map((p) => p.phaseId),
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(transitions(plan.steps)[0]?.status).toBe("accepted");
  });

  it("subset → partially_accepted and records kept + deferred phase names in the note", () => {
    const c = makeCase();
    const first = c.phases[0];
    if (!first) throw new Error("fixture missing phase");
    const plan = planConsultOutcome(
      makeInput({
        outcome: "accepted_phased",
        tcCase: c,
        acceptedPhaseIds: [first.phaseId],
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    const t = transitions(plan.steps)[0];
    expect(t?.status).toBe("partially_accepted");
    expect(t?.lostReason).toBeNull();
    expect(t?.note).toContain("Phase 1 — Foundation");
    expect(t?.note).toContain("Deferred: Phase 2 — Restoration");
  });
});

// ── thinking_objection ──────────────────────────────────────────────────────

describe("thinking_objection", () => {
  it("requires a category", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "thinking_objection" }));
    expect(plan.ok).toBe(false);
  });

  it("plans objection → considering transition → cadence followups, in that order", () => {
    const plan = planConsultOutcome(
      makeInput({
        outcome: "thinking_objection",
        objectionCategory: "cost",
        objectionWords: "That's more than my car payment",
      }),
    );
    if (!plan.ok) throw new Error(plan.message);

    expect(plan.steps[0]).toMatchObject({
      kind: "objection",
      category: "cost",
      patientWords: "That's more than my car payment",
      // No quick note → objection note falls back to the patient's words.
      note: "That's more than my car payment",
    });
    expect(plan.steps[1]).toMatchObject({
      kind: "transition",
      status: "considering",
      lostReason: null,
    });

    // Standard tier ($4,500 case) default intervals: [2, 7, 14, 28, 42].
    const f = followups(plan.steps);
    expect(f.map((s) => s.dueDate)).toEqual([
      "2026-08-05",
      "2026-08-10",
      "2026-08-17",
      "2026-08-31",
      "2026-09-14",
    ]);
    // First touch is always a call; unknown preference alternates call/text.
    expect(f.map((s) => s.channel)).toEqual([
      "phone_call",
      "text",
      "phone_call",
      "text",
      "phone_call",
    ]);
    expect(plan.firstTouchDays).toBe(2);
  });

  it("quick note wins over patient words for the objection note", () => {
    const plan = planConsultOutcome(
      makeInput({
        outcome: "thinking_objection",
        objectionCategory: "fear",
        objectionWords: "I hate needles",
        note: "Very anxious — offer sedation next call",
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.steps[0]).toMatchObject({
      kind: "objection",
      note: "Very anxious — offer sedation next call",
      patientWords: "I hate needles",
    });
  });

  it("high urgency compresses the first touch to 1 day", () => {
    const plan = planConsultOutcome(
      makeInput({
        outcome: "thinking_objection",
        tcCase: makeCase({ urgency: "high" }),
        objectionCategory: "cost",
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.firstTouchDays).toBe(1);
    expect(followups(plan.steps)[0]?.dueDate).toBe("2026-08-04");
  });

  it("spouse_family stretches the first touch to 4 days", () => {
    const plan = planConsultOutcome(
      makeInput({ outcome: "thinking_objection", objectionCategory: "spouse_family" }),
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.firstTouchDays).toBe(4);
    expect(followups(plan.steps)[0]?.dueDate).toBe("2026-08-07");
  });

  it("uses the library cadence config when provided", () => {
    const plan = planConsultOutcome(
      makeInput({
        outcome: "thinking_objection",
        objectionCategory: "timing",
        cadence: {
          tiers: [
            { key: "light", label: "L", intervals: [3] },
            { key: "standard", label: "S", intervals: [1, 9] },
            { key: "high_touch", label: "H", intervals: [1, 2, 3] },
          ],
          thresholds: { standardMinCents: 100_000, highTouchMinCents: 500_000 },
          highUrgencyFirstDay: 1,
          spouseFamilyMinFirstDay: 4,
        },
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(followups(plan.steps).map((s) => s.dueDate)).toEqual(["2026-08-04", "2026-08-12"]);
  });

  it("respects contact preference for later touches", () => {
    const plan = planConsultOutcome(
      makeInput({
        outcome: "thinking_objection",
        tcCase: makeCase({ contactPreference: "email" }),
        objectionCategory: "cost",
      }),
    );
    if (!plan.ok) throw new Error(plan.message);
    const channels = followups(plan.steps).map((s) => s.channel);
    expect(channels[0]).toBe("phone_call");
    expect(channels.slice(1).every((c) => c === "email")).toBe(true);
  });
});

// ── thinking_no_objection ───────────────────────────────────────────────────

describe("thinking_no_objection", () => {
  it("plans considering + check-ins at 5/12/21 days", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "thinking_no_objection" }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.steps[0]).toMatchObject({
      kind: "transition",
      status: "considering",
      lostReason: null,
    });
    expect(NO_OBJECTION_OFFSETS).toEqual([5, 12, 21]);
    expect(followups(plan.steps).map((s) => s.dueDate)).toEqual([
      "2026-08-08",
      "2026-08-15",
      "2026-08-24",
    ]);
    expect(plan.firstTouchDays).toBe(5);
  });
});

// ── declined ────────────────────────────────────────────────────────────────

describe("declined", () => {
  it("requires a reason", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "declined" }));
    expect(plan.ok).toBe(false);
  });

  it.each(["chose_another_provider", "declined_permanently", "unresponsive"] as const)(
    "%s → lost with that lostReason",
    (reason) => {
      const plan = planConsultOutcome(makeInput({ outcome: "declined", declineReason: reason }));
      if (!plan.ok) throw new Error(plan.message);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({
        kind: "transition",
        status: "lost",
        lostReason: reason,
      });
    },
  );

  it("'other' (not now — may return) → nurture, NOT lost, with no lostReason", () => {
    const plan = planConsultOutcome(makeInput({ outcome: "declined", declineReason: "other" }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      kind: "transition",
      status: "nurture",
      lostReason: null,
    });
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

describe("cadence helpers", () => {
  it("addDaysIso is date-only and month-safe", () => {
    expect(addDaysIso("2026-08-30", 2)).toBe("2026-09-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("cadenceOffsets picks tier by case value (default thresholds in cents)", () => {
    // < $1k → light [2,10,21]; > $5k → high_touch (8 touches).
    expect(cadenceOffsets(50_000, "medium", null, null)).toEqual([2, 10, 21]);
    expect(cadenceOffsets(900_000, "medium", null, null)).toEqual(
      DEFAULT_CADENCE.tiers[2]?.intervals,
    );
  });

  it("channelForStep alternates call/text when preference is unknown", () => {
    expect(channelForStep(null, 0)).toBe("phone_call");
    expect(channelForStep(null, 1)).toBe("text");
    expect(channelForStep(null, 2)).toBe("phone_call");
    expect(channelForStep("phone", 3)).toBe("phone_call");
  });
});
