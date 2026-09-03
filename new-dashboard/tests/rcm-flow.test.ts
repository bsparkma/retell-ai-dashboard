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
 *   · every `OdMatchStatus`      → the match step (which CONFIRM folded into)
 *   · every `PostingQueueLabel`  → the post step
 *   · every claim shape a check can be in → the whole rail
 *
 * The two folds are the reason the vocabulary tables below are the whole of the
 * safety here. `confirm` disappearing as a STEP must not make an unconfirmed
 * claim read as matched, and `approve` folding into "Check it over" must not
 * make an unapproved check read as checked over — so each table asserts the
 * state a folded-in status produces, one status at a time.
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
  matchStepFor,
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
    patientNames: { shown: ["Fixture, Synthetic"], more: 0 },
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
  it("is the same five steps, in the same order, on all three screens", () => {
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

  it("lights exactly one step, even when two are genuinely available", () => {
    /*
     * Review does not depend on matching — a claim with no chart match can
     * still be finished work — so a fresh remittance really is available at two
     * steps at once. Two filled dots answer "where am I" with two places,
     * which is not an answer, so the later one reads `todo`.
     */
    const fresh = remittanceFlow(remittance(), [claim()]);
    expect(stateOf(fresh, "match")).toBe("current");
    expect(stateOf(fresh, "review")).toBe("todo");
    // The sentence survives the demotion — it is still true, and the notes
    // under the rail are where a biller reads what each step is waiting for.
    expect(detailOf(fresh, "review")).toContain("note and a Mark checked over");

    for (const rail of [
      fresh,
      remittanceFlow(remittance(), [claim({ odMatchStatus: "candidates" })]),
      claimFlow(workbenchClaim(), "b-1"),
      planFlow(plan()),
    ]) {
      expect(rail.steps.filter((s) => s.state === "current").length).toBeLessThanOrEqual(1);
    }
  });

  it("never demotes a blocked step, because it is work rather than a position", () => {
    /*
     * A no-candidate claim on an unbalanced check is blocked TWICE, and hiding
     * the second would hide a thing somebody has to fix. The two folds do not
     * change that: `match` carries what used to be `confirm`'s block, and
     * `review` carries what used to be `approve`'s.
     *
     * The claim is READ here, deliberately. While any claim is unread, the
     * outstanding action at `review` is the reading — see the test below.
     */
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
      [claim({ odMatchStatus: "no_candidate", reviewedAt: "2026-03-06T15:00:00.000Z" })],
    );
    expect(stateOf(flow, "match")).toBe("blocked");
    expect(stateOf(flow, "review")).toBe("blocked");
  });

  it("names the READING before the imbalance, because that is the next action", () => {
    /*
     * The one precedence the fold had to settle. An unbalanced check whose
     * claims nobody has read is not "blocked at approval" to the person holding
     * it — she has not got there yet, and the next thing she does is read them.
     * Leading with the imbalance would name a wall behind a door she has not
     * opened, which is the crying-wolf failure `attentionFor` was rewritten to
     * stop one level down.
     *
     * The imbalance is not hidden: it is a first-class stat on the check's page
     * (the balance card), the approval gate refuses on it, and this step turns
     * `blocked` the moment the reading is finished — which the test above pins.
     */
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
      [claim({ odMatchStatus: "confirmed", odClaimNum: 53784 })],
    );
    expect(stateOf(flow, "review")).toBe("current");
    expect(detailOf(flow, "review")).toContain("Mark checked over");
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

describe("match — one assertion per OdMatchStatus, now that confirm folded in", () => {
  /*
   * ONLY `confirmed` IS `done`, AND THAT IS THE WHOLE SAFETY OF THE FOLD.
   *
   * Searching and choosing are one step to a biller and two acts to the
   * machinery. If `candidates` read `done` here, a claim Open Dental offered
   * three possibilities for — and nobody chose between — would draw a green tick
   * saying it was tied to a chart. That is the confident tick over work nobody
   * did that this whole file exists to refuse.
   */
  const EXPECTED: Record<OdMatchStatus, StepState> = {
    not_run: "current",
    candidates: "current",
    no_candidate: "blocked",
    confirmed: "done",
  };

  it("covers the whole vocabulary — a status added to the CHECK constraint fails here", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...OD_MATCH_STATUSES].sort());
  });

  for (const status of OD_MATCH_STATUSES) {
    it(`maps ${status} → ${EXPECTED[status]}`, () => {
      const step = matchStepFor(status, status === "confirmed" ? 53784 : null, "/x");
      expect(step.state).toBe(EXPECTED[status]);
      // Every state says something. A dot with no sentence is the finding this
      // whole slice exists to close.
      expect(step.detail).toBeTruthy();
    });
  }

  it("never reads DONE for a claim nobody confirmed", () => {
    for (const status of OD_MATCH_STATUSES) {
      if (status === "confirmed") continue;
      expect(matchStepFor(status, null, "/x").state).not.toBe("done");
    }
  });

  it("names the tied claim rather than saying only 'matched'", () => {
    expect(matchStepFor("confirmed", 53784, "/x").detail).toContain("53784");
  });

  it("does not claim Open Dental is empty when it examined and rejected", () => {
    // `no_candidate` is one status covering two answers. The step says the
    // honest one: nothing can be OFFERED, which is not "nothing exists".
    expect(matchStepFor("no_candidate", null, "/x").detail).toContain("can be offered");
  });

  it("treats an unreadable stored match as work to redo, whatever the status says", () => {
    const step = matchStepFor("confirmed", 53784, "/x", { stale: true });
    expect(step.state).toBe("current");
    expect(step.detail).toContain("older format");
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
    // `unavailable`, not `blocked`. Every other unhappy state here is an
    // instruction; this one is a full stop, and a plan that can never post must
    // not sit on a worklist forever.
    withdrawn: "unavailable",
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
          withdrawnReason: labelName === "withdrawn" ? "target_removed" : null,
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
    expect(stateOf(flow, "review")).toBe("todo");
    expect(stateOf(flow, "post")).toBe("todo");
    expect(flow.cta?.action).toBe("run-match");
    expect(flow.cta?.disabled).toBe(false);
  });

  it("a matched check with candidates is STILL at match, and links to the person", () => {
    const flow = remittanceFlow(remittance(), [
      claim({ odMatchStatus: "candidates", patientName: "Stedi Test 2" }),
    ]);
    // NOT `done`. The search ran; nobody chose. See the fold's safety note above.
    expect(stateOf(flow, "match")).toBe("current");
    expect(flow.cta?.step).toBe("match");
    expect(flow.cta?.label).toContain("Stedi Test 2");
    // It CARRIES THE REMITTANCE with it, which is the only way the claim screen
    // can offer a way back — the claim endpoint has no batch id.
    expect(flow.cta?.href).toContain("from=b-1");
  });

  it("a confirmed, unchecked check is waiting to be checked over", () => {
    const flow = remittanceFlow(remittance(), [
      claim({ odMatchStatus: "confirmed", odClaimNum: 53784 }),
    ]);
    expect(stateOf(flow, "match")).toBe("done");
    expect(stateOf(flow, "review")).toBe("current");
    expect(flow.cta?.label).toContain("Check over");
  });

  it("a confirmed, reviewed check is waiting on approval — on this page", () => {
    const flow = remittanceFlow(remittance(), [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
      }),
    ]);
    /*
     * PM RULING: approving is the SECOND HALF of "Check it over", not the first
     * half of "Post". Read but unapproved is therefore `current` at `review` —
     * the human judgment is not finished — and `post` has not started.
     */
    expect(stateOf(flow, "review")).toBe("current");
    expect(detailOf(flow, "review")).toContain("Nothing has been approved yet");
    expect(stateOf(flow, "post")).toBe("todo");
    expect(flow.cta?.step).toBe("review");
    expect(flow.cta?.label).toBe("Approve 1 claim for posting");
    // A VERB this page owns, not a link: the real Approve button is already on
    // the check's screen and the CTA takes you to it.
    expect(flow.cta?.action).toBe("approve");
    expect(flow.cta?.href).toBeNull();
  });

  it("SHADOW MODE: an approved check finishes four of five steps, honestly", () => {
    /*
     * THE REASON THE FOLD WENT THIS WAY.
     *
     * Roland ships to production with posting switched off, and a biller works
     * real checks for weeks under it. With approving inside `post`, every check
     * she finished would sit mid-step at "Post" and she would never complete the
     * flow once. With approving inside "Check it over", everything a person can
     * do is DONE and the one step that is switched off is the machine's.
     */
    const flow = remittanceFlow(remittance({ attentionObservations: ["claims_queued"] }), [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
    ]);
    for (const step of ["upload", "match", "review"] as const) {
      expect(stateOf(flow, step), `${step} should be done`).toBe("done");
    }
    expect(stateOf(flow, "post")).toBe("current");
    // And `post` says only what it is: waiting, with nothing written.
    expect(detailOf(flow, "post")).toContain("Nothing has been written to Open Dental");
  });

  it("an approved check is READY TO POST, and the CTA is the write itself", () => {
    const flow = remittanceFlow(remittance({ attentionObservations: ["claims_queued"] }), [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
    ]);
    expect(stateOf(flow, "review")).toBe("done");
    expect(stateOf(flow, "post")).toBe("current");
    expect(detailOf(flow, "post")).toContain("Ready to post");
    /*
     * §4: the post happens HERE now, on the check's own page, so this is a verb
     * the page owns rather than a link to the office-wide monitor. It is the
     * SAME server route the monitor calls, narrowed by this check's plan id —
     * see components/rcm/PostThisCheck.tsx.
     *
     * ONE VERB. `post` cannot fire an approve, because there is no state in
     * which it should: everything a person decides happened one step earlier.
     */
    expect(flow.cta?.label).toBe("Post to Open Dental");
    expect(flow.cta?.action).toBe("drain");
    expect(flow.cta?.href).toBeNull();
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
    // An unbalanced check cannot be APPROVED, and approving is part of
    // "Check it over" — so that is the step that blocks.
    expect(stateOf(flow, "review")).toBe("blocked");
    expect(stateOf(flow, "post")).toBe("todo");
    expect(flow.cta?.disabled).toBe(true);
    // §15.2, finding 4, at the model layer: a disabled control always carries
    // its reason, so no screen can render one without.
    expect(flow.cta?.reason).toContain("$50.00");
  });

  it("a check whose claims Open Dental cannot offer is blocked at match", () => {
    const flow = remittanceFlow(remittance(), [claim({ odMatchStatus: "no_candidate" })]);
    expect(stateOf(flow, "match")).toBe("blocked");
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
    // Partly approved is NOT done: the human judgment on this check is
    // unfinished, and the step that carries it says so with the numbers.
    expect(stateOf(flow, "review")).toBe("current");
    expect(detailOf(flow, "review")).toContain("1 approved");
    // The un-approved remainder is named too — "not ready yet", never silence.
    expect(detailOf(flow, "review")).toContain("not ready yet");
    expect(stateOf(flow, "post")).toBe("todo");
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
    expect(detailOf(flow, "post")).toContain("Posting screen says");
  });

  it("sends the approval back to the check, because that is where it happens", () => {
    /*
     * A claim that has been READ on a check nobody has approved. The reading is
     * done and the step is not, because approving is per-CHECK — so the rail
     * says `current` and points back rather than ticking a judgment nobody made.
     */
    const flow = claimFlow(
      workbenchClaim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
      }),
      "b-1",
    );
    expect(stateOf(flow, "review")).toBe("current");
    expect(detailOf(flow, "review")).toContain("Approving happens on the check");
    expect(stateOf(flow, "post")).toBe("todo");
    expect(flow.cta?.step).toBe("review");
    expect(flow.cta?.label).toBe("Approve for posting");
    expect(flow.cta?.href).toBe("/rcm/remittances/b-1");
    // NEVER a verb on this screen: the claim page owns neither button, and a CTA
    // firing an action the page does not handle is a button that does nothing.
    expect(flow.cta?.action).toBeNull();
  });

  it("reads DONE only once the claim is both read AND on an approved check", () => {
    const flow = claimFlow(
      workbenchClaim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-03-06T15:00:00.000Z",
        postingQueueId: "q-1",
      }),
      "b-1",
    );
    expect(stateOf(flow, "review")).toBe("done");
    expect(detailOf(flow, "review")).toContain("approved");
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
    for (const step of ["upload", "match", "review"] as const) {
      expect(stateOf(flow, step)).toBe("done");
    }
  });

  it("stamps the approval in the PRACTICE'S day", () => {
    // 01:10Z on the 26th is the evening of the 25th in Roland. §15.2, finding 2.
    const flow = planFlow(plan({ approvedAt: "2026-08-26T01:10:00.000Z" }));
    // The approval now reads on `review`, which is where `approve` folded to on
    // a posting: everything before `post` on this rail is done by construction.
    expect(detailOf(flow, "review")).toContain("Aug 25, 2026");
  });
});
