/**
 * STAGE C-3 — the last UI pass before the combined walk.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * Eight changes came out of one cold walkthrough of the reseeded staging data.
 * Every one of them is a claim about what a person is TOLD, so every one of them
 * is checkable here. The ones that would silently regress are the ones pinned:
 *
 *  1. THE CANDIDATE LIST FOLDS. One card open — the leader before a link, the
 *     linked one after — and everything else a line that opens on a click.
 *     Nothing is removed, which is the half a "tidier list" would quietly break.
 *  2. THERE IS NO DEAD APPROVE CONTROL. (Pinned in `rcm-workbench` beside the
 *     assertion it replaced, and in `rcm-disabled-reasons`.)
 *  3. THE BANNER'S TONE COMES FROM THE VERDICT. A red verdict may never render
 *     green with a tick, whatever the HTTP status of the act that produced it.
 *  4. A DECISION ON AN UNLINKED CLAIM IS CAUTIONED, NEVER BLOCKED.
 *  5. A NOT-READY CLAIM LEADS WITH ITS FAILURES, and stands the passing ones
 *     down to one line that still opens.
 *  7. THE DEAD END NAMES THE OFFICE, and answers the wrong-office case.
 *  8a. THE DIAGNOSTICS FOLD — and the two warnings that are not diagnostics
 *     stay outside the fold.
 *  8b. ATTRIBUTION IS A NAME. The signed-in person's own address resolves to
 *     their name; somebody else's is left exactly as it arrived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FOLDS ARE ASSERTED ON PRESENCE, NOT ON PIXELS
 * ─────────────────────────────────────────────────────────────────────────────
 * jsdom computes no layout, so "collapsed" here means the STRUCTURE says so: the
 * open card's testid is present and the folded ones are rows instead, and a
 * `<details>` is closed when it carries no `open` attribute. Those are the same
 * facts the browser renders from, and unlike a pixel they cannot pass on a day
 * the CSS is broken.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, code and figure below is
 * synthetic — "Test 2, Stedi" on PatNum 12827 is the module's own roland
 * fixture, chosen so these renders physically cannot contain a patient.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A line with money left on it, so the decision control renders. */
function line(over: Record<string, unknown> = {}) {
  return {
    lineId: "pl-1",
    position: 1,
    billedCode: "D2740",
    paidCode: null,
    code: "D2740",
    description: "Crown - porcelain/ceramic",
    billedCents: 120000,
    allowedCents: 90000,
    deductibleCents: 0,
    copayCents: 0,
    paidCents: 42000,
    adjustmentCents: 30000,
    patientRespCents: 48000,
    writeOffCents: 30000,
    adjustmentReason: null,
    isDowncoded: false,
    isBundled: false,
    isDenied: false,
    flags: [] as string[],
    odClaimProcNum: null,
    adjustments: [] as unknown[],
    contractualWriteOffCents: 30000,
    patientRemainderCents: 48000,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 48000,
    projectedPatientCents: 48000,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 30000,
    decisions: [] as unknown[],
    problems: [] as unknown[],
    sentence: "Will owe $480.00 once this posts — the same as the EOB says.",
    ...over,
  };
}

/**
 * THE RED VERDICT FROM THE REPRODUCTION — Stage C-3, item 3.
 *
 * The wording is `lineDecisions.verdictSentence`'s balanced-RED branch verbatim,
 * because that is the sentence that was printing in green with a tick on the
 * claim screen after a write-off was recorded. If the server's copy changes, the
 * assertion below is on the TONE, not on these words.
 */
function redVerdict() {
  return verdict({
    state: "red",
    problems: [
      {
        kind: "decision_missing_reason",
        code: "D2740",
        lineId: "pl-1",
        detail: "D2740 is written off with no reason recorded.",
      },
    ],
    sentence:
      "Patient's number can't be trusted yet — a line is written off with nothing recorded about why. Look at D2740.",
  });
}

function identity(over: Record<string, unknown> = {}) {
  return {
    matched: true,
    blocking: false,
    fields: [
      {
        field: "name",
        label: "Name",
        eob: "Test 2, Stedi",
        od: "Test 2, Stedi",
        status: "agrees",
        blocking: false,
      },
    ],
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53862",
    checkNumber: "830200001",
    patientName: "Test 2, Stedi",
    odPatientId: null,
    odClaimNum: null,
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-02",
    receivedDate: "2026-03-02",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "primary",
    totalBilledCents: 120000,
    totalAllowedCents: 90000,
    totalPaidCents: 42000,
    totalDeductibleCents: 0,
    patientBalanceCents: 48000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 95,
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
    createdAt: "2026-03-02T10:00:00.000Z",
    lines: [line()],
    patientDob: "1990-01-01",
    subscriberId: "ABC123456",
    verdict: verdict(),
    identity: identity(),
    chart: null,
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    odClaimNum: 53862,
    odPatNum: 12827,
    score: 95,
    confidence: "HIGH",
    evidence: [
      {
        tag: "CLAIM_NUMBER_MATCH",
        weight: 35,
        label: "Claim number matches",
        detail: "The carrier's claim number is this Open Dental ClaimNum.",
      },
    ],
    blockers: [] as unknown[],
    od: {
      claimStatus: "S",
      dateService: "2026-03-02",
      claimHeaderFeeCents: 120000,
      billedCents: 120000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Test 2, Stedi",
      patientBirthdate: "1990-01-01",
      subscriberId: "ABC123456",
      lines: [],
      deletedLineCount: 0,
      unknownDeletedLineCount: 0,
    },
    linePairs: [
      {
        lineId: "pl-1",
        position: 1,
        code: "D2740",
        odClaimProcNum: 99001,
        odCode: "D2740",
        billedDeltaCents: 0,
        reason: null,
      },
    ],
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    fetchedAt: "2026-03-03T15:00:00.000Z",
    office: "roland",
    officeName: "Valley — Fort Smith",
    odCalls: 9,
    truncated: false,
    notes: [] as string[],
    patientsConsidered: [{ patNum: 12827, name: "Test 2, Stedi" }],
    ambiguous: false,
    margin: 40,
    rejectedCandidates: 0,
    rejectedReasons: { nameMismatch: 0, belowScore: 0 },
    minScore: 15,
    nameRuleApplied: true,
    candidates: [candidate()],
    confirmed: null,
    supersededConfirmation: null,
    ...over,
  };
}

/** A gate condition, in the shape the approval preview ships. */
function check(over: Record<string, unknown> = {}) {
  return {
    code: "REVIEWED",
    label: "Reviewed by a person",
    passed: true,
    detail: null,
    fix: "Mark the claim reviewed, with a note.",
    ...over,
  };
}

/** Thirteen conditions, one of which failed — the shape from the walkthrough. */
function thirteenChecks(failing = 1) {
  const codes = [
    "MATCH_CONFIRMED",
    "REVIEWED",
    "PATIENT_RESPONSIBILITY_MATCHES",
    "NOT_REVERSAL",
    "NOT_RECOUPMENT",
    "CLAIM_IN_CHART",
    "FEES_AGREE",
    "NO_BLOCKING_FLAGS",
    "OFFICE_ENABLED",
    "BALANCED",
    "NOT_ALREADY_POSTED",
    "IDENTITY_AGREES",
    "WRITEOFF_TYPE_RESOLVES",
  ];
  return codes.map((code, i) =>
    check({
      code,
      label: `Condition ${i + 1}`,
      passed: i >= failing,
      detail: i < failing ? null : "as expected",
      fix: "Open the claim and fix it.",
    }),
  );
}

function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53862",
    patientName: "Test 2, Stedi",
    postable: true,
    alreadyQueued: false,
    failed: [] as string[],
    checks: thirteenChecks(0),
    verdict: verdict(),
    ...over,
  };
}

function remittance(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 42000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    patientNames: { shown: ["Fixture, Synthetic"], more: 0 },
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 42000,
      claimTotalCents: 42000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: [] as string[],
    reviewReasonCount: 0,
    unmatchedClaimCount: 1,
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
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  claim: null as unknown,
  approval: null as unknown,
  approveResult: null as unknown,
  /** What the next `setLineDecision` hands back. */
  decisionVerdict: null as unknown,
  auth: { status: "loading" } as
    | { status: "loading" }
    | { status: "anonymous" }
    | {
        status: "authenticated";
        user: { name: string; email: string; isSuperAdmin: boolean; permissions: string[] };
      },
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => state.auth };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: state.claim ?? claim(),
      writeoffReasons: [
        { slug: "xrays_bitewings", label: "X-rays — bitewings" },
        { slug: "not_chargeable", label: "Not chargeable for this procedure" },
      ],
      matchRules: {
        amountNearCents: 100,
        dateNearDays: 7,
        ambiguityMargin: 10,
        bands: [
          { band: "HIGH", min: 75 },
          { band: "MEDIUM", min: 45 },
          { band: "LOW", min: 0 },
        ],
      },
    })),
    getRemittance: vi.fn(async (office: string) => ({
      office,
      remittance: { ...remittance(), plbAdjustments: [], plans: [] },
      claims: [claim()],
    })),
    getApprovalPreview: vi.fn(async (office: string, batchId: string) => {
      return (
        state.approval ?? {
          office,
          batchId,
          canApprove: true,
          approveRequires: "rcm.write",
          claims: [approvalClaim()],
          postableCount: 1,
          withheldCount: 0,
          queuedCount: 0,
          balanced: true,
          differenceCents: 0,
        }
      );
    }),
    approveRemittance: vi.fn(async (office: string, batchId: string) => {
      return (
        state.approveResult ?? {
          office,
          batchId,
          queueId: "q-1",
          // C-3b item 2: the SERVER resolves this now, so the mock sends what
          // the server sends. A key here would be testing a wire that no longer
          // exists.
          approvedBy: "Beau Sparkman",
          queued: [
            {
              claimId: "c-1",
              claimNumber: "53862",
              patientName: "Test 2, Stedi",
              odClaimNum: 53862,
              lines: 1,
              totalCents: 42000,
            },
          ],
          withheld: [],
          alreadyQueued: [],
          intendedTotalCents: 42000,
          note: "Lined up to post — nothing has been written to Open Dental yet.",
        }
      );
    }),
    confirmClaimMatch: vi.fn(async (_office: string, claimId: string, odClaimNum: number) => ({
      claimId,
      odClaimNum,
      confirmedAt: "2026-03-03T16:00:00.000Z",
    })),
    reviewClaim: vi.fn(async (_office: string, claimId: string) => ({ claimId })),
    setLineDecision: vi.fn(
      async (
        office: string,
        claimId: string,
        lineId: string,
        decision: string,
        reason: string | null,
      ) => ({
        office,
        claimId,
        lineId,
        decision,
        reason,
        verdict: state.decisionVerdict ?? verdict(),
        lines: [line()],
      }),
    ),
  };
});

import ClaimMatch from "@/pages/rcm/ClaimMatch";
import ApproveCheck from "@/pages/rcm/ApproveCheck";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { personName } from "@/features/rcm/format";
import { claimStateLine } from "@/features/rcm/flow";
import type { WorkbenchClaim } from "@/features/rcm/api";

function renderAt(ui: React.ReactElement, path: string, searchPath = "") {
  // `searchHook` as well as `hook` — `?from=` is read through wouter's search
  // hook, and `searchPath` takes NO leading "?".
  const memory = memoryLocation({ path, searchPath, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.claim = null;
  state.approval = null;
  state.approveResult = null;
  state.decisionVerdict = null;
  state.auth = { status: "loading" };
});

afterEach(cleanup);

/* ══════════════════════════════════════════════════════════════════════════════
   1. ONE PAGE, VISIBLE STATE
   ══════════════════════════════════════════════════════════════════════════════ */

describe("the claim screen folds its candidate list", () => {
  const two = () =>
    snapshot({
      candidates: [candidate(), candidate({ odClaimNum: 53863, score: 70, confidence: "MEDIUM" })],
    });

  it("opens the LEADER and folds the rest, before anything is linked", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: two() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    // The leader is a full card…
    await screen.findByTestId("candidate-53862");
    // …and the runner-up is a line that says which claim, how it scored, and
    // what the chart billed — the three a list is scanned by.
    const folded = screen.getByTestId("candidate-row-53863");
    expect(folded.textContent).toContain("ClaimNum 53863");
    expect(folded.textContent).toContain("MEDIUM");
    expect(screen.queryByTestId("candidate-53863")).toBeNull();
  });

  it("restores a folded candidate whole, on one click", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: two() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    fireEvent.click(await screen.findByTestId("candidate-row-53863"));

    // The card is back WITH its evidence and its confirm button — a fold, not a
    // filter, so nothing about the restored card is a reduced version.
    expect(screen.getByTestId("candidate-53863")).toBeTruthy();
    expect(screen.getByTestId("evidence-53863")).toBeTruthy();
    expect(screen.getByTestId("confirm-53863")).toBeTruthy();
    // And the leader has taken the runner-up's place as a line.
    expect(screen.getByTestId("candidate-row-53862")).toBeTruthy();
  });

  it("opens the LINKED one and folds the rest, once a claim is linked", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53863,
      matchSnapshot: two(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    /*
     * The linked claim is the one being read now, and the leader of a ranking
     * nobody is running any more is not. This is the change Beau could not see:
     * before it, linking altered three lines on a page of two thousand pixels.
     */
    await screen.findByTestId("candidate-53863");
    expect(screen.getByTestId("candidate-row-53862")).toBeTruthy();
    expect(screen.queryByTestId("candidate-53862")).toBeNull();
  });

  it("keeps the record of the choice reachable — nothing is dropped", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53863,
      matchSnapshot: two(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    fireEvent.click(await screen.findByTestId("candidate-row-53862"));

    // "Why did I not pick that one" is answerable from the screen where it was
    // not picked — six weeks later, which is when it is asked.
    expect(screen.getByTestId("evidence-53862")).toBeTruthy();
    expect(screen.getByTestId("pairs-53862")).toBeTruthy();
  });

  it("carries the status chip INSIDE the state line, so the header says it once", async () => {
    /*
     * The chip used to sit in the page header, above the rail, saying the same
     * thing the rail said and the line under it said. It is now one of the three
     * parts of the one status line — same words, same tone, same helper, and in
     * particular the `no_candidate` distinction the chip existed to carry.
     */
    state.claim = claim({
      odMatchStatus: "no_candidate",
      rejectedCandidates: 3,
      matchSnapshot: snapshot({
        candidates: [],
        rejectedCandidates: 3,
        rejectedReasons: { nameMismatch: 2, belowScore: 1 },
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const line = await screen.findByTestId("claim-state-line");
    const chip = screen.getByTestId("claim-match-status");
    expect(chip.textContent).toContain("Examined — none offered");
    // INSIDE the line, not beside it — which is what "one status line" means.
    expect(line.contains(chip)).toBe(true);
  });

  it("names the linked ClaimNum on the chip once a claim is linked", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53862,
      matchSnapshot: snapshot(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    expect((await screen.findByTestId("claim-match-status")).textContent).toContain(
      "ClaimNum 53862",
    );
  });

  it("points the hero comparison at the LINKED claim, not at the leader", async () => {
    /*
     * FOUND BY THE FOLD. The hero read `candidates[0]` unconditionally, so a
     * biller who linked the runner-up — which is the whole reason a list is
     * offered rather than the top one auto-confirmed — got a comparison of her
     * EOB against the claim she had just declined, under a heading saying this
     * was the one it was linked to.
     *
     * It was invisible while every candidate was expanded underneath. With one
     * card open beside the panel, the two disagreeing about which chart claim is
     * in play is the first thing on the screen.
     */
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53863,
      matchSnapshot: snapshot({
        candidates: [
          candidate(),
          candidate({
            odClaimNum: 53863,
            score: 70,
            od: { ...candidate().od, billedCents: 86000, claimHeaderFeeCents: 86000 },
          }),
        ],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const od = await screen.findByTestId("match-guidance-od");
    expect(od.textContent).toContain("$860.00");
    expect(od.textContent).not.toContain("$1,200.00");
  });

  it("never calls a LINKED claim ambiguous — a person settled it", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53863,
      matchSnapshot: snapshot({
        ambiguous: true,
        margin: 0,
        candidates: [candidate(), candidate({ odClaimNum: 53863 })],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    // The comparison, not "more than one of these could be it".
    await screen.findByTestId("match-guidance-confident");
    expect(screen.queryByTestId("match-guidance-unsure")).toBeNull();
  });

  it("says where the claim is in ONE line, and the line changes with the state", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: two() });
    const first = renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    expect((await screen.findByTestId("claim-state-line")).getAttribute("data-stage")).toBe(
      "candidates",
    );
    expect(screen.getByTestId("claim-state-line").textContent).toContain("Not linked");
    first satisfies unknown;
    cleanup();

    state.claim = claim({ odMatchStatus: "confirmed", odClaimNum: 53862, matchSnapshot: two() });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await waitFor(() =>
      expect(screen.getByTestId("claim-state-line").getAttribute("data-stage")).toBe("linked"),
    );
    expect(screen.getByTestId("claim-state-line").textContent).toContain("53862");
    cleanup();

    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53862,
      reviewedAt: "2026-03-04T15:00:00.000Z",
      reviewedBy: "Beau Sparkman",
      matchSnapshot: two(),
    });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await waitFor(() =>
      expect(screen.getByTestId("claim-state-line").getAttribute("data-stage")).toBe(
        "checked_over",
      ),
    );
    expect(screen.getByTestId("claim-state-line").textContent).toContain("Beau Sparkman");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   3. THE TONE COMES FROM THE CONTENT
   ══════════════════════════════════════════════════════════════════════════════ */

describe("the claim screen's banner takes its tone from the verdict", () => {
  /** Record a write-off on the one line that has money left on it. */
  async function decide() {
    fireEvent.click(await screen.findByTestId("write-off-pl-1"));
    fireEvent.click(await screen.findByTestId("reason-not_chargeable-pl-1"));
    return screen.findByTestId("claim-notice");
  }

  it("renders a RED verdict in red — the reproduction from claim 53862", async () => {
    /*
     * THE BUG, EXACTLY. `decide()` set `tone: "ok"` unconditionally because the
     * PUT succeeded, and then printed the server's verdict sentence in it. A
     * refusal rendered as a green tick above the fold:
     *
     *   ✓ Patient's number can't be trusted yet — …
     *
     * The act succeeded; the answer did not. The banner reports the answer.
     */
    state.claim = claim({ odMatchStatus: "confirmed", odClaimNum: 53862, matchSnapshot: snapshot() });
    state.decisionVerdict = redVerdict();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    const notice = await decide();

    expect(notice.getAttribute("data-tone")).toBe("bad");
    expect(notice.textContent).toContain("can't be trusted yet");
    // The specific regression: never green, whatever the HTTP status was.
    expect(notice.className).not.toContain("emerald");
    expect(notice.className).toContain("rose");
  });

  it("renders an AMBER verdict in amber — decided, and diverging on purpose", async () => {
    state.claim = claim({ odMatchStatus: "confirmed", odClaimNum: 53862, matchSnapshot: snapshot() });
    state.decisionVerdict = verdict({
      state: "amber",
      projectedPatientCents: 0,
      decidedWriteOffCents: 48000,
      sentence:
        "Will owe $0.00 once this posts. The EOB says $480.00; this office decided to absorb $480.00.",
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    const notice = await decide();

    expect(notice.getAttribute("data-tone")).toBe("warn");
    expect(notice.className).toContain("amber");
  });

  it("renders a GREEN verdict in green — the only thing that earns a tick", async () => {
    state.claim = claim({ odMatchStatus: "confirmed", odClaimNum: 53862, matchSnapshot: snapshot() });
    state.decisionVerdict = verdict();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    const notice = await decide();

    expect(notice.getAttribute("data-tone")).toBe("ok");
    expect(notice.className).toContain("emerald");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   4. DECIDING BEFORE MATCHING
   ══════════════════════════════════════════════════════════════════════════════ */

describe("a write-off on an unlinked claim", () => {
  it("is cautioned in plain words, and still allowed", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const caution = await screen.findByTestId("decision-unlinked-pl-1");
    expect(caution.textContent).toContain("linked to an Open Dental claim yet");
    expect(caution.textContent).toContain("for the right patient");

    /*
     * AND NOTHING IS DISABLED. Decisions are remittance-side and the approval
     * gate is what refuses to post an unmatched claim — turning this into a lock
     * would stop a biller doing work she is allowed to do, on this screen, in
     * the order she does it.
     */
    expect((screen.getByTestId("write-off-pl-1") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("bill-patient-pl-1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing once the claim IS linked", async () => {
    state.claim = claim({ odMatchStatus: "confirmed", odClaimNum: 53862, matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await screen.findByTestId("decision-pl-1");

    expect(screen.queryByTestId("decision-unlinked-pl-1")).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   7. THE NO-CANDIDATES DEAD END
   ══════════════════════════════════════════════════════════════════════════════ */

describe("the dead end", () => {
  it("names the office that was searched, and answers the wrong-office case", async () => {
    state.claim = claim({
      odMatchStatus: "no_candidate",
      matchSnapshot: snapshot({ candidates: [] }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");

    const office = await screen.findByTestId("match-guidance-office");
    expect(office.textContent).toContain("Valley — Fort Smith");

    const wrong = screen.getByTestId("match-guidance-wrong-office");
    expect(wrong.textContent).toContain("brought in under the wrong office");
    expect(wrong.textContent).toContain("set it aside as sent in error");
    expect(wrong.textContent).toContain("bring it in again under the right one");

    // And the two doors out, both of which exist.
    expect(screen.getByTestId("match-guidance-set-aside").getAttribute("href")).toBe(
      "/rcm/remittances/b-1",
    );
    expect(screen.getByTestId("match-guidance-bring-in").getAttribute("href")).toBe(
      "/rcm/bring-in",
    );
  });

  it("names the act without linking to a check it was not told about", async () => {
    state.claim = claim({
      odMatchStatus: "no_candidate",
      matchSnapshot: snapshot({ candidates: [] }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    await screen.findByTestId("match-guidance-wrong-office");
    // No `?from=`, so there is no batch id — the sentence stands, the link that
    // would have needed a guessed id does not.
    expect(screen.queryByTestId("match-guidance-set-aside")).toBeNull();
    expect(screen.getByTestId("match-guidance-bring-in")).toBeTruthy();
  });

  it("names the office in the lower panel too, where the search reported itself", async () => {
    state.claim = claim({
      odMatchStatus: "no_candidate",
      matchSnapshot: snapshot({ candidates: [] }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const panel = await screen.findByTestId("no-candidate-office");
    expect(panel.textContent).toContain("Valley — Fort Smith");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   8a. HOW THE SEARCH RAN
   ══════════════════════════════════════════════════════════════════════════════ */

describe("the search diagnostics", () => {
  it("are folded away by default, and keep every fact", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        notes: ["Patient 12827 has 31 claims; the 8 most recent were examined in detail."],
        rejectedCandidates: 2,
        rejectedReasons: { nameMismatch: 2, belowScore: 0 },
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const fold = (await screen.findByTestId("match-how-it-ran")) as HTMLDetailsElement;
    // CLOSED — a `<details>` with no `open` attribute.
    expect(fold.open).toBe(false);
    // …and the summary still carries the two facts worth having at a glance.
    expect(fold.textContent).toContain("How the search ran");
    expect(fold.textContent).toContain("Valley — Fort Smith");

    // NOTHING WAS REMOVED. Every diagnostic is inside, in the markup, one click
    // from being read — this is a fold, not a deletion.
    expect(fold.textContent).toContain("9 Open Dental reads");
    expect(fold.textContent).toContain("8 most recent");
    expect(screen.getByTestId("match-rejected").textContent).toContain("different patient's name");
  });

  it("leaves ambiguity OUTSIDE the fold — it changes what to do, not how it ran", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        ambiguous: true,
        margin: 0,
        candidates: [candidate(), candidate({ odClaimNum: 53863 })],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const warning = await screen.findByTestId("match-ambiguous");
    expect(warning.textContent).toContain("not a recommendation");
    expect(warning.closest("details")).toBeNull();
  });

  it("leaves a truncated search OUTSIDE the fold too", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({ truncated: true }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const warning = await screen.findByTestId("match-truncated");
    expect(warning.textContent).toContain("were not examined");
    expect(warning.closest("details")).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   5. BEFORE YOU SAY YES — the failures, and one line for the rest
   ══════════════════════════════════════════════════════════════════════════════ */

describe("the approve page's checklist", () => {
  it("shows a not-ready claim's FAILURES and stands the passing ones down to a line", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim({ postable: false, failed: ["MATCH_CONFIRMED"], checks: thirteenChecks(1) })],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    const list = await screen.findByTestId("approval-checks-c-1");
    // ONE row, not thirteen: the failure is the reason she opened it.
    expect(list.querySelectorAll("li").length).toBe(1);
    expect(screen.getByTestId("check-MATCH_CONFIRMED")).toBeTruthy();
    expect(screen.queryByTestId("check-REVIEWED")).toBeNull();

    // And the rest are a line — a number, not a list.
    const toggle = screen.getByTestId("approval-passed-toggle-c-1");
    expect(toggle.textContent).toContain("12 checks passed");
  });

  it("opens the passing ones on a click — the facts stay reachable", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim({ postable: false, failed: ["MATCH_CONFIRMED"], checks: thirteenChecks(1) })],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    fireEvent.click(await screen.findByTestId("approval-passed-toggle-c-1"));

    const passed = screen.getByTestId("approval-passed-c-1");
    expect(passed.querySelectorAll("li").length).toBe(12);
    expect(screen.getByTestId("check-REVIEWED")).toBeTruthy();
  });

  it("leaves a READY claim exactly as it was — closed, and whole when opened", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    // Closed by default, as it always was.
    await screen.findByTestId("approval-toggle-c-1");
    expect(screen.queryByTestId("approval-checks-c-1")).toBeNull();

    fireEvent.click(screen.getByTestId("approval-toggle-c-1"));
    // …and there is no failure to lead with, so the full list IS the content.
    expect(screen.getByTestId("approval-checks-c-1").querySelectorAll("li").length).toBe(13);
    expect(screen.queryByTestId("approval-passed-toggle-c-1")).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   8b. A PERSON'S NAME
   ══════════════════════════════════════════════════════════════════════════════ */

describe("attribution", () => {
  /*
   * C-3b item 2 moved this fix to the server. The route now runs
   * `describeActors` like every other attributed field in the module, so the
   * screen prints what it was given — for colleagues too, not only for whoever
   * is looking. The client-side patch is gone; `personName` is not called here
   * and the page no longer reads the auth context to render this line.
   */
  it("prints the name the ROUTE sent, without patching it in the browser", async () => {
    state.auth = {
      status: "authenticated",
      user: {
        name: "Beau Sparkman",
        email: "admin@carein.ai",
        isSuperAdmin: true,
        permissions: ["rcm.read", "rcm.write", "rcm.queue"],
      },
    };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    fireEvent.click(await screen.findByTestId("approve-button"));

    const line = await screen.findByTestId("approve-attribution");
    expect(line.textContent).toContain("Approved by Beau Sparkman");
    expect(line.textContent).not.toContain("admin@carein.ai");
  });

  it("prints a colleague's name too — the case the browser could never resolve", async () => {
    /*
     * THE REASON THE FIX MOVED. The client could only ever answer for the
     * signed-in person; anyone else's press came out as an address. A biller
     * looking at a check approved by the office manager now reads her name.
     */
    state.auth = {
      status: "authenticated",
      user: {
        name: "Beau Sparkman",
        email: "admin@carein.ai",
        isSuperAdmin: true,
        permissions: ["rcm.read", "rcm.write", "rcm.queue"],
      },
    };
    state.approveResult = {
      office: "roland",
      batchId: "b-1",
      queueId: "q-1",
      approvedBy: "Billing User",
      queued: [],
      withheld: [],
      alreadyQueued: [],
      intendedTotalCents: 0,
      note: "Lined up to post — nothing has been written to Open Dental yet.",
    };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    fireEvent.click(await screen.findByTestId("approve-button"));

    const line = await screen.findByTestId("approve-attribution");
    expect(line.textContent).toContain("Approved by Billing User");
    expect(line.textContent).not.toContain("@");
  });

  it("leaves somebody ELSE's address alone rather than inventing a name", () => {
    const me = { name: "Beau Sparkman", email: "admin@carein.ai" };
    expect(personName("billing@carein.ai", me)).toBe("billing@carein.ai");
    // Case is not identity: the crosswalk lowercases, the SSO claim may not.
    expect(personName("Admin@CareIN.ai", me)).toBe("Beau Sparkman");
    // A display name that already arrived as one is untouched.
    expect(personName("Billing User", me)).toBe("Billing User");
    // Nobody signed in, nothing to resolve against.
    expect(personName("admin@carein.ai", null)).toBe("admin@carein.ai");
    expect(personName("", me)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   THE STATE LINE, ON ITS OWN — the derivation, without a screen around it
   ══════════════════════════════════════════════════════════════════════════════ */

describe("claimStateLine", () => {
  const base = () => claim() as unknown as WorkbenchClaim;

  it("reads `candidates` until a claim is BOTH confirmed and carries a ClaimNum", () => {
    expect(claimStateLine(base()).stage).toBe("candidates");
    // Confirmed with no number is not linked to anything — a DB CHECK makes the
    // pair inseparable server-side, and this reads them the same way.
    expect(
      claimStateLine({ ...base(), odMatchStatus: "confirmed", odClaimNum: null }).stage,
    ).toBe("candidates");
  });

  it("names the next click at every stage but the last", () => {
    expect(claimStateLine(base()).next).toContain("Pick which Open Dental claim");
    expect(
      claimStateLine({ ...base(), odMatchStatus: "confirmed", odClaimNum: 53862 }).next,
    ).toContain("mark it checked over");
    expect(
      claimStateLine({
        ...base(),
        odMatchStatus: "confirmed",
        odClaimNum: 53862,
        reviewedAt: "2026-03-04T15:00:00.000Z",
      }).next,
    ).toContain("Approving happens on the check");
    // Approved is the one stage with nothing left to do HERE.
    expect(
      claimStateLine({
        ...base(),
        odMatchStatus: "confirmed",
        odClaimNum: 53862,
        reviewedAt: "2026-03-04T15:00:00.000Z",
        postingQueueId: "q-1",
      }).next,
    ).toBeNull();
  });
});
