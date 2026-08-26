/**
 * THE STEPPER'S MAPPING — one assertion per state, in every vocabulary.
 *
 * `features/rcm/flow.ts` is the only place that answers "where is this one, and
 * what is the next click", and three screens render its answer. A mapping that
 * drifts does not crash: it draws a confident tick over work nobody did, which
 * is the failure mode this module spends its whole design refusing.
 *
 * So the test is exhaustive over the machine vocabularies rather than
 * illustrative:
 *
 *   · every `OdMatchStatus`      → the match and confirm steps
 *   · every `PostingQueueLabel`  → the post step
 *   · every claim shape a remittance can be in → the whole rail
 *
 * The CTA is asserted beside each, because "one primary button, and never two"
 * is the other half of the contract and the half that is easy to break by
 * adding a case.
 *
 * NO REAL PATIENTS. Every name and number below is synthetic — 12827 / 7115 and
 * "Stedi Test 2" are the module's fixtures for exactly this reason.
 */
import { describe, expect, it } from "vitest";
import {
  claimFlow,
  confirmStepFor,
  planFlow,
  postStepFor,
  RCM_STEPS,
  remittanceFlow,
  type RcmFlow,
  type RcmStep,
  type StepState,
} from "../client/src/features/rcm/flow";
import {
  OD_MATCH_STATUSES,
  POSTING_QUEUE_STATUSES,
  type OdMatchStatus,
  type PostingQueueLabel,
  type PostingQueueRow,
  type Remittance,
  type RemittanceClaim,
  type WorkbenchClaim,
} from "../client/src/features/rcm/api";

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

const claim = (over: Partial<RemittanceClaim> = {}): RemittanceClaim =>
  ({
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "CLM-1",
    checkNumber: "830200001",
    patientName: "Stedi Test 2",
    odPatientId: 12827,
    odClaimNum: null,
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "primary",
    totalBilledCents: 20000,
    totalAllowedCents: 15000,
    totalPaidCents: 12000,
    totalDeductibleCents: 0,
    patientBalanceCents: 3000,
    needsReviewReasons: [],
    extractionConfidence: 1,
    odMatchStatus: "not_run",
    rejectedCandidates: 0,
    odMatchAt: null,
    odMatchConfirmedAt: null,
    odMatchedBy: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-03-05T12:00:00.000Z",
    lines: [],
    ...over,
  }) as RemittanceClaim;

const remittance = (over: Partial<Remittance> = {}): Remittance =>
  ({
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: null,
    paymentMethod: "check",
    depositDate: "2026-03-04",
    totalAmountCents: 12000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    status: "ready",
    source: "835",
    flags: [],
    notes: "",
    createdAt: "2026-03-05T12:00:00.000Z",
    createdBy: null,
    balance: {
      batchTotalCents: 12000,
      claimTotalCents: 12000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: [],
    attentionObservations: [],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    upload: null,
    ...over,
  }) as Remittance;

const plan = (over: Partial<PostingQueueRow> = {}): PostingQueueRow =>
  ({
    queueId: "q-1",
    office: "roland",
    batchId: "b-1",
    status: "approved",
    statusLabel: "queued",
    blockedReason: null,
    step: null,
    isRecoupment: false,
    carrierEobDate: "2026-03-01",
    intendedTotalCents: 12000,
    postedTotalCents: 0,
    odClaimPaymentNum: null,
    reconciledAt: null,
    approvedAt: "2026-03-06T15:00:00.000Z",
    approvedBy: "biller@example.invalid",
    startedAt: null,
    finishedAt: null,
    drainAttemptAt: null,
    drainedBy: null,
    attemptCount: 0,
    lastError: null,
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL",
    ...over,
  }) as PostingQueueRow;

const workbenchClaim = (over: Partial<WorkbenchClaim> = {}): WorkbenchClaim =>
  ({ ...claim(), matchSnapshotStale: false, ...over }) as WorkbenchClaim;

/** The state the rail gives one step. */
const stateOf = (flow: RcmFlow, step: RcmStep): StepState =>
  flow.steps.find((s) => s.step === step)!.state;

const detailOf = (flow: RcmFlow, step: RcmStep): string | null =>
  flow.steps.find((s) => s.step === step)!.detail;

// ─── The rail's shape ────────────────────────────────────────────────────────

describe("the rail", () => {
  it("is the same seven steps, in the same order, on all three screens", () => {
    const rails = [
      remittanceFlow(remittance(), [claim()]),
      claimFlow(workbenchClaim(), "b-1"),
      planFlow(plan()),
    ];
    for (const rail of rails) {
      expect(rail.steps.map((s) => s.step)).toEqual([...RCM_STEPS]);
    }
  });

  it("draws Deposit and admits it is not built", () => {
    for (const rail of [
      remittanceFlow(remittance(), [claim()]),
      claimFlow(workbenchClaim(), "b-1"),
      planFlow(plan({ statusLabel: "posted", status: "posted", odClaimPaymentNum: 4471 })),
    ]) {
      const deposit = rail.steps[rail.steps.length - 1];
      expect(deposit.step).toBe("deposit");
      // NOT a failure and NOT a todo. A step that is drawn and does not exist.
      expect(deposit.state).toBe("unavailable");
      expect(deposit.detail).toContain("Coming soon");
    }
  });

  it("never offers more than one call to action", () => {
    const rails = [
      remittanceFlow(remittance(), [claim()]),
      remittanceFlow(remittance(), [claim({ odMatchStatus: "candidates" })]),
      claimFlow(workbenchClaim({ odMatchStatus: "confirmed", odClaimNum: 53784 }), "b-1"),
      planFlow(plan()),
    ];
    for (const rail of rails) {
      // `cta` is one object or null. The type says so; this asserts the
      // function never returns a live step it then fails to describe.
      const live = rail.steps.filter(
        (s) => s.step !== "deposit" && (s.state === "current" || s.state === "blocked"),
      );
      if (live.length > 0) expect(rail.cta?.step).toBe(live[0].step);
      else expect(rail.cta).toBeNull();
    }
  });
});

// ─── Every match status ──────────────────────────────────────────────────────

describe("confirm, one assertion per OdMatchStatus", () => {
  const EXPECTED: Record<OdMatchStatus, StepState> = {
    not_run: "todo",
    candidates: "current",
    no_candidate: "blocked",
    confirmed: "done",
  };

  it("covers the whole vocabulary — a status added to the CHECK constraint fails here", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...OD_MATCH_STATUSES].sort());
  });

  for (const status of OD_MATCH_STATUSES) {
    it(`maps ${status} → ${EXPECTED[status]}`, () => {
      const step = confirmStepFor(status, status === "confirmed" ? 53784 : null, "/x");
      expect(step.state).toBe(EXPECTED[status]);
      // Every state says something. A dot with no sentence is the finding this
      // whole slice exists to close.
      expect(step.detail).toBeTruthy();
    });
  }

  it("names the linked claim rather than saying only 'matched'", () => {
    expect(confirmStepFor("confirmed", 53784, "/x").detail).toContain("53784");
  });

  it("does not claim Open Dental is empty when it examined and rejected", () => {
    // `no_candidate` is one status covering two answers. The step says the
    // honest one: nothing can be OFFERED, which is not "nothing exists".
    expect(confirmStepFor("no_candidate", null, "/x").detail).toContain("can be offered");
  });
});

// ─── Every posting label ─────────────────────────────────────────────────────

describe("post, one assertion per PostingQueueLabel", () => {
  const EXPECTED: Record<PostingQueueLabel, StepState> = {
    queued: "current",
    running: "current",
    posted: "done",
    partially_posted: "blocked",
    failed: "blocked",
    blocked: "blocked",
  };

  it("covers every stored status the server can label", () => {
    // The stored statuses and the screen's labels differ by exactly one word
    // (`approved` → `queued`, `posting` → `running`). If a status is added to
    // the CHECK constraint without a label, this count moves and the test says
    // so before a plan renders as its own slug.
    expect(Object.keys(EXPECTED).length).toBe(POSTING_QUEUE_STATUSES.length);
  });

  for (const [labelName, expected] of Object.entries(EXPECTED) as [
    PostingQueueLabel,
    StepState,
  ][]) {
    it(`maps ${labelName} → ${expected}`, () => {
      const step = postStepFor(
        plan({
          statusLabel: labelName,
          odClaimPaymentNum: labelName === "posted" ? 4471 : null,
          blockedReason: labelName === "blocked" ? "valley_not_enabled" : null,
        }),
      );
      expect(step.state).toBe(expected);
      expect(step.detail).toBeTruthy();
    });
  }

  it("shows the check number as the proof, on the only state that has one", () => {
    expect(postStepFor(plan({ statusLabel: "posted", odClaimPaymentNum: 4471 })).detail).toContain(
      "4471",
    );
  });

  it("does not read partially_posted as 'nothing happened'", () => {
    /*
     * The state that costs the most to get wrong. Money HAS reached the chart;
     * a step reading "failed" would send a biller looking for a payment that is
     * sitting in Open Dental.
     */
    const detail = postStepFor(plan({ statusLabel: "partially_posted" })).detail ?? "";
    expect(detail).toContain("Money reached the chart");
    expect(detail.toLowerCase()).not.toContain("nothing was written");
  });

  it("renders a blocked reason in the drain's own words, not its slug", () => {
    const detail = postStepFor(
      plan({ statusLabel: "blocked", blockedReason: "valley_not_enabled" }),
    ).detail;
    expect(detail).toContain("not switched on for posting yet");
    expect(detail).not.toContain("valley_not_enabled");
  });

  it("stays readable for a reason nobody has written copy for", () => {
    // Fails CLOSED, like `blockedCopy`. An unknown slug must still say
    // something — a blank line on the screen whose job is "go do something".
    const detail = postStepFor(
      plan({ statusLabel: "blocked", blockedReason: "some_future_refusal" }),
    ).detail;
    expect(detail).toBeTruthy();
    expect(detail).toContain("some future refusal");
  });
});

// ─── A whole remittance ──────────────────────────────────────────────────────

describe("a remittance, state by state", () => {
  it("a fresh check is waiting on the match, and the CTA runs it", () => {
    const flow = remittanceFlow(remittance(), [claim()]);
    expect(stateOf(flow, "upload")).toBe("done");
    expect(stateOf(flow, "match")).toBe("current");
    expect(stateOf(flow, "confirm")).toBe("todo");
    expect(stateOf(flow, "approve")).toBe("todo");
    expect(flow.cta?.action).toBe("run-match");
    expect(flow.cta?.disabled).toBe(false);
  });

  it("a matched check with candidates is waiting on a person, and links to them", () => {
    const flow = remittanceFlow(remittance(), [
      claim({ odMatchStatus: "candidates", patientName: "Stedi Test 2" }),
    ]);
    expect(stateOf(flow, "match")).toBe("done");
    expect(stateOf(flow, "confirm")).toBe("current");
    expect(flow.cta?.label).toContain("Stedi Test 2");
    // It CARRIES THE REMITTANCE with it, which is the only way the claim screen
    // can offer a way back — the claim endpoint has no batch id.
    expect(flow.cta?.href).toContain("from=b-1");
  });

  it("a confirmed, unreviewed check is waiting on review", () => {
    const flow = remittanceFlow(remittance(), [
      claim({ odMatchStatus: "confirmed", odClaimNum: 53784 }),
    ]);
    expect(stateOf(flow, "confirm")).toBe("done");
    expect(stateOf(flow, "review")).toBe("current");
    expect(flow.cta?.label).toContain("Review");
  });

  it("a confirmed, reviewed check is waiting on approval — on this page", () => {
    const flow = remittanceFlow(remittance(), [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
      }),
    ]);
    expect(stateOf(flow, "review")).toBe("done");
    expect(stateOf(flow, "approve")).toBe("current");
    expect(flow.cta?.label).toBe("Approve 1 claim for posting");
    // A VERB this page owns, not a link: the real Approve button is already on
    // the remittance screen and the CTA takes you to it.
    expect(flow.cta?.action).toBe("approve");
    expect(flow.cta?.href).toBeNull();
  });

  it("an approved check is waiting on the drain, and points at Posting", () => {
    const flow = remittanceFlow(remittance({ attentionObservations: ["claims_queued"] }), [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
    ]);
    expect(stateOf(flow, "approve")).toBe("done");
    expect(stateOf(flow, "post")).toBe("current");
    expect(flow.cta?.href).toBe("/rcm/posting");
  });

  it("a posted check has no next click at all", () => {
    const flow = remittanceFlow(
      remittance({
        status: "posted",
        postedAmountCents: 12000,
        attentionObservations: ["claims_posted"],
        needsAttention: false,
      }),
      [
        claim({
          odMatchStatus: "confirmed",
          odClaimNum: 53784,
          reviewedAt: "2026-03-06T15:00:00.000Z",
          postingQueueId: "q-1",
        }),
      ],
    );
    expect(stateOf(flow, "post")).toBe("done");
    // NOT a manufactured button. Sending somebody to a screen with nothing on
    // it is worse than saying the work is finished.
    expect(flow.cta).toBeNull();
  });

  it("an unbalanced check blocks approval, and the CTA is disabled WITH A REASON", () => {
    const flow = remittanceFlow(
      remittance({
        balance: {
          batchTotalCents: 12000,
          claimTotalCents: 7000,
          differenceCents: 5000,
          plbTotalCents: 0,
          balanced: false,
        },
      }),
      [
        claim({
          odMatchStatus: "confirmed",
          odClaimNum: 53784,
          reviewedAt: "2026-03-06T15:00:00.000Z",
        }),
      ],
    );
    expect(stateOf(flow, "approve")).toBe("blocked");
    expect(flow.cta?.disabled).toBe(true);
    // §15.2, finding 4, at the model layer: a disabled control always carries
    // its reason, so no screen can render one without.
    expect(flow.cta?.reason).toContain("$50.00");
  });

  it("a check whose claims Open Dental cannot offer is blocked at confirm", () => {
    const flow = remittanceFlow(remittance(), [claim({ odMatchStatus: "no_candidate" })]);
    expect(stateOf(flow, "match")).toBe("done");
    expect(stateOf(flow, "confirm")).toBe("blocked");
    expect(flow.cta?.disabled).toBe(true);
    expect(flow.cta?.reason).toBeTruthy();
  });

  it("a failed posting run is blocked at post, not silently done", () => {
    const flow = remittanceFlow(
      remittance({ attentionReasons: ["posting_failed"] }),
      [
        claim({
          odMatchStatus: "confirmed",
          odClaimNum: 53784,
          reviewedAt: "2026-03-06T15:00:00.000Z",
          postingQueueId: "q-1",
        }),
      ],
    );
    expect(stateOf(flow, "post")).toBe("blocked");
    expect(detailOf(flow, "post")).toContain("did not finish");
  });

  it("a partially approved check says how many, rather than 'approved'", () => {
    const flow = remittanceFlow(remittance({ claimCount: 2 }), [
      claim({
        claimId: "c-1",
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
      claim({
        claimId: "c-2",
        odMatchStatus: "confirmed",
        odClaimNum: 53785,
        reviewedAt: "2026-03-06T15:00:00.000Z",
      }),
    ]);
    expect(stateOf(flow, "approve")).toBe("current");
    expect(detailOf(flow, "approve")).toContain("1 of 2 approved");
  });

  it("a check with no claims on it is blocked at match rather than looking finished", () => {
    const flow = remittanceFlow(remittance({ claimCount: 0 }), []);
    expect(stateOf(flow, "match")).toBe("blocked");
    expect(detailOf(flow, "match")).toContain("no claims");
  });
});

// ─── One claim ───────────────────────────────────────────────────────────────

describe("one claim", () => {
  it("cannot see whether its plan drained, and says UNKNOWN rather than no", () => {
    /*
     * The honest-states rule at its sharpest. `GET /api/rcm/claims/:id` returns
     * `postingQueueId` and nothing about the plan's outcome. Rendering `todo`
     * would be this screen asserting "not posted" about something it never
     * asked.
     */
    const flow = claimFlow(
      workbenchClaim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
      "b-1",
    );
    expect(stateOf(flow, "post")).toBe("unknown");
    expect(detailOf(flow, "post")).toContain("posting queue says");
  });

  it("sends approving back to the remittance, because that is where it happens", () => {
    const flow = claimFlow(
      workbenchClaim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
      }),
      "b-1",
    );
    expect(stateOf(flow, "approve")).toBe("current");
    expect(flow.cta?.href).toBe("/rcm/remittances/b-1");
    expect(flow.cta?.action).toBeNull();
  });

  it("degrades honestly when it does not know which remittance it came from", () => {
    // A deep link with no `?from=`. The rail still works and points at the list
    // rather than at a guessed batch id.
    const flow = claimFlow(workbenchClaim({ odMatchStatus: "not_run" }), null);
    expect(flow.steps.find((s) => s.step === "upload")!.href).toBe("/rcm/remittances");
    expect(stateOf(flow, "match")).toBe("current");
  });

  it("treats a stale match record as work to redo, not as done", () => {
    const flow = claimFlow(
      workbenchClaim({ odMatchStatus: "candidates", matchSnapshotStale: true }),
      "b-1",
    );
    expect(stateOf(flow, "match")).toBe("current");
    expect(detailOf(flow, "match")).toContain("older format");
    expect(flow.cta?.action).toBe("run-match");
  });
});

// ─── One plan ────────────────────────────────────────────────────────────────

describe("one posting plan", () => {
  it("treats everything before post as done, because a plan cannot exist otherwise", () => {
    const flow = planFlow(plan());
    for (const step of ["upload", "match", "confirm", "review", "approve"] as const) {
      expect(stateOf(flow, step)).toBe("done");
    }
  });

  it("stamps the approval in the PRACTICE'S day", () => {
    // 01:10Z on the 26th is the evening of the 25th in Roland. §15.2, finding 2.
    const flow = planFlow(plan({ approvedAt: "2026-08-26T01:10:00.000Z" }));
    expect(detailOf(flow, "approve")).toContain("Aug 25, 2026");
  });
});
