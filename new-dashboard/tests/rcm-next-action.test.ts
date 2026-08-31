/**
 * THE NEXT CLICK ON A CHECK — `features/rcm/nextAction.ts` (Stage C, §1).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A UNIT TEST AND NOT A RENDER
 * ═════════════════════════════════════════════════════════════════════════════
 * Today's *Where you left off* card names the next thing and offers one button
 * that goes to it. Getting that wrong is not a visual defect — it is sending a
 * biller to the wrong claim, or offering an approve on a check that has already
 * had one, and both are quiet. So the resolver is pure and it is driven here
 * directly, over the three outcomes and the boundary between them.
 *
 * THE RULE, and the order is the whole of it:
 *   1. the FIRST claim nobody has checked over, in the check's own claim order;
 *   2. every claim done and the check not approved → approving;
 *   3. nothing.
 *
 * NO REAL PATIENT DATA. Every name below is synthetic.
 */
import { describe, expect, it } from "vitest";
import { nextActionFor } from "@/features/rcm/nextAction";
import type { Remittance, RemittanceClaim } from "@/features/rcm/api";

function check(over: Partial<Remittance> = {}): Remittance {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 15000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 2,
    status: "ready",
    source: "835",
    flags: [],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 15000,
      claimTotalCents: 15000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: [],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    parkedAt: null,
    parkedBy: null,
    parkedNote: null,
    setAsideAt: null,
    setAsideBy: null,
    setAsideReason: null,
    setAsideNote: null,
    lastDecidedAt: null,
    lastDecidedBy: null,
    upload: null,
    ...over,
  } as unknown as Remittance;
}

function claim(over: Partial<RemittanceClaim> = {}): RemittanceClaim {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    odPatientId: 12827,
    odClaimNum: 53648,
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 20000,
    totalAllowedCents: 18000,
    totalPaidCents: 15000,
    totalDeductibleCents: 0,
    patientBalanceCents: 3000,
    needsReviewReasons: [],
    extractionConfidence: 100,
    odMatchStatus: "confirmed",
    rejectedCandidates: 0,
    odMatchAt: null,
    odMatchConfirmedAt: null,
    odMatchedBy: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    postingQueueId: null,
    approvedAt: null,
    createdAt: null,
    lines: [],
    ...over,
  } as unknown as RemittanceClaim;
}

describe("what is the next click on this check", () => {
  it("names the FIRST claim nobody has checked over, in the check's own order", () => {
    const action = nextActionFor(check(), [
      claim({ claimId: "c-1", patientName: "First, Synthetic", reviewedAt: "2026-03-05T10:00:00Z" }),
      claim({ claimId: "c-2", patientName: "Second, Synthetic" }),
      claim({ claimId: "c-3", patientName: "Third, Synthetic" }),
    ]);

    expect(action.kind).toBe("review_claim");
    if (action.kind !== "review_claim") throw new Error("unreachable");
    // The SECOND row, because the first is done — not the oldest, not the
    // largest. A person works a list top to bottom.
    expect(action.claimId).toBe("c-2");
    expect(action.patientName).toBe("Second, Synthetic");
    expect(action.remaining).toBe(2);
    expect(action.sentence).toContain("Second, Synthetic is up");
    // The button goes to the CLAIM, carrying where it came from, so the claim
    // screen can offer the way back.
    expect(action.href).toContain("/rcm/claims/c-2");
    expect(action.href).toContain("from=b-1");
  });

  it("says 'the last one' rather than counting down to nothing", () => {
    const action = nextActionFor(check(), [
      claim({ claimId: "c-1", reviewedAt: "2026-03-05T10:00:00Z" }),
      claim({ claimId: "c-2", patientName: "Only, Synthetic" }),
    ]);
    expect(action.sentence).toContain("Only, Synthetic is the last one");
  });

  it("counts an APPROVED claim as finished even with no review stamp", () => {
    /*
     * A claim on a posting has been through the gate, and the gate refuses an
     * unreviewed one. Treating it as outstanding would send a biller to a claim
     * she can no longer change (D-14).
     */
    const action = nextActionFor(check({ attentionReasons: ["claims_awaiting_approval"] }), [
      claim({ claimId: "c-1", reviewedAt: null, postingQueueId: "q-1" }),
    ]);
    expect(action.kind).toBe("approve");
  });

  it("offers APPROVING once every claim is checked over", () => {
    const action = nextActionFor(check({ attentionReasons: ["claims_awaiting_approval"] }), [
      claim({ claimId: "c-1", reviewedAt: "2026-03-05T10:00:00Z" }),
      claim({ claimId: "c-2", reviewedAt: "2026-03-05T10:05:00Z" }),
    ]);
    expect(action.kind).toBe("approve");
    expect(action.sentence).toContain("needs approving");
    expect(action.href).toBe("/rcm/remittances/b-1");
  });

  it("offers NOTHING when the server does not say an approve is owed", () => {
    /*
     * The SERVER decides what a check still owes. A check whose claims are all
     * checked over and which somebody has already approved is waiting on the
     * machine, and a card offering a second approve would be inventing work.
     */
    const action = nextActionFor(check({ attentionReasons: [] }), [
      claim({ claimId: "c-1", reviewedAt: "2026-03-05T10:00:00Z", postingQueueId: "q-1" }),
    ]);
    expect(action.kind).toBe("none");
    expect(action.sentence).toContain("Nothing is waiting on you");
  });

  it("with NO claims in hand, says what the row alone can support and names nobody", () => {
    /*
     * `null` is not `[]`. The list endpoint returns rows without claims, so a
     * card whose bundle has not arrived still gets an honest sentence — and it
     * must not fill in a claim id or a patient name it does not have.
     */
    const action = nextActionFor(check({ attentionReasons: ["claims_unreviewed"] }), null);
    expect(action.kind).toBe("review_claim");
    if (action.kind !== "review_claim") throw new Error("unreachable");
    expect(action.claimId).toBeNull();
    expect(action.patientName).toBeNull();
    expect(action.remaining).toBeNull();
    expect(action.sentence).toContain("open the check to see which claim is up");
    // And it goes to the CHECK, which is the most specific place it can name.
    expect(action.href).toBe("/rcm/remittances/b-1");
  });

  it("an EMPTY claim list is a check with no claims, not a missing bundle", () => {
    const action = nextActionFor(check({ attentionReasons: [] }), []);
    expect(action.kind).toBe("none");
  });
});
