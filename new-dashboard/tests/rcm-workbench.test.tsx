/**
 * The RCM review workbench — client side (Slice 6a).
 *
 * The backend is the source of truth for what is allowed
 * (backend/routes/rcm/workbench.test.js, rcmNoOdWrites.test.js). This suite is
 * about what a person is TOLD, and the claims it pins are the ones that would
 * mislead a biller if they broke:
 *
 *  - the list opens on NEEDS ATTENTION, and always says how much it is hiding;
 *  - a batch/claim imbalance shows the DIFFERENCE, not just a red flag;
 *  - Slice 4 and 5 flags render as first-class review reasons — this is the
 *    screen where they finally get seen;
 *  - CARC and RARC codes render with their plain-English meanings, and an
 *    unknown code renders BARE rather than glossed with a guess;
 *  - "no candidate" reads as a finished search with a negative result, not as
 *    an empty screen;
 *  - ambiguity is displayed, never resolved;
 *  - Approve is present and DISABLED, and says why.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic JSX runtime under vitest — same shim the other .tsx suites use.
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures. Synthetic names only — the repo's no-real-patient-data rule ───

function adjustment(over: Record<string, unknown> = {}) {
  return {
    adjustmentId: "adj-1",
    amountCents: 6000,
    quantity: 1,
    groupCode: "CO",
    groupLabel: "Contractual",
    groupDescription:
      "Contractual obligation — the practice writes this off, the patient is not billed",
    reasonCode: "45",
    reasonDescription: "Charge exceeds fee schedule/maximum allowable",
    remarkCode: "N19",
    remarkDescription: "Procedure code incidental to primary procedure",
    ...over,
  };
}

function line(over: Record<string, unknown> = {}) {
  return {
    lineId: "pl-1",
    position: 1,
    billedCode: "D0150",
    paidCode: null,
    code: "D0150",
    description: "Comprehensive oral evaluation",
    billedCents: 21000,
    allowedCents: 15000,
    deductibleCents: 0,
    copayCents: 0,
    paidCents: 15000,
    adjustmentCents: 6000,
    patientRespCents: 0,
    writeOffCents: 6000,
    adjustmentReason: null,
    isDowncoded: false,
    isBundled: false,
    isDenied: false,
    flags: [] as string[],
    odClaimProcNum: null,
    adjustments: [adjustment()],
    /*
     * Stage B1 — the carrier arithmetic the SERVER computes, and the decision.
     *
     * Written out rather than defaulted, because the whole point of shipping
     * them is that the client never derives them: a fixture that omitted these
     * would be testing a screen the server never feeds. Billed 210, allowed 150,
     * paid 150 → W 60.00, R 0.00, so this default line has nothing to decide.
     */
    contractualWriteOffCents: 6000,
    patientRemainderCents: 0,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    odPatientId: null,
    odClaimNum: null,
    payer: "DELTA DENTAL OF ARKANSAS",
    serviceDate: "2026-03-02",
    receivedDate: "2026-03-02",
    status: "pending_review",
    paymentStatus: "unpaid",
    insuranceType: "primary",
    totalBilledCents: 21000,
    totalAllowedCents: 15000,
    totalPaidCents: 15000,
    totalDeductibleCents: 0,
    patientBalanceCents: 0,
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
    // Slice 6b: the approval linkage. Null = no human has approved this claim
    // into a posting plan.
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-03-02T10:00:00.000Z",
    lines: [line()],
    // Stage B1 — assembled server-side from the claim, its lines and the match
    // snapshot. Absent on a stale-shaped snapshot, which is why the types are
    // optional and the screen has an honest state for it.
    patientDob: "1990-01-01",
    subscriberId: "ABC123456",
    verdict: verdict(),
    identity: identity(),
    chart: null,
    ...over,
  };
}

/** The patient-responsibility verdict, exactly as the server ships it. */
function verdict(over: Record<string, unknown> = {}) {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 0,
    projectedPatientCents: 0,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 6000,
    decisions: [] as unknown[],
    problems: [] as unknown[],
    sentence: "Patient will owe $0.00 once posted — matches the EOB.",
    ...over,
  };
}

/** The identity comparison — three fields, each with its own answer. */
function identity(over: Record<string, unknown> = {}) {
  return {
    matched: true,
    blocking: false,
    fields: [
      { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
      { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1990-01-01", status: "agrees", blocking: false },
      { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: "ABC123456", status: "agrees", blocking: false },
    ],
    ...over,
  };
}

/** One claim's pre-flight checklist, as the gate returns it. */
function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Fixture, Synthetic",
    postable: true,
    alreadyQueued: false,
    failed: [] as string[],
    checks: [
      { code: "MATCH_CONFIRMED", label: "Matched to an Open Dental claim", passed: true, detail: "ClaimNum 53648", fix: "Open the claim, run the match, and confirm the right one." },
      { code: "REVIEWED", label: "Reviewed by a person", passed: true, detail: null, fix: "Mark the claim reviewed, with a note." },
    ],
    ...over,
  };
}

function remittance(over: Record<string, unknown> = {}) {
  const totalAmountCents = (over.totalAmountCents as number) ?? 15000;
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "DELTA DENTAL OF ARKANSAS",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    patientNames: { shown: ["Fixture, Synthetic"], more: 0 },
    status: "ready",
    source: "835",
    // Slice 5.5's structured remittance flags, which Slice 6b finally renders.
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: totalAmountCents,
      claimTotalCents: 15000,
      differenceCents: totalAmountCents - 15000,
      plbTotalCents: 0,
      balanced: totalAmountCents - 15000 === 0,
    },
    needsAttention: true,
    // OBLIGATIONS drive the queue; OBSERVATIONS are facts about the file.
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: ["claims_unmatched"],
    reviewReasonCount: 0,
    unmatchedClaimCount: 1,
    queuedClaimCount: 0,
    // Slice 6b: null = nobody has pressed Approve on this remittance yet.
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    upload: {
      uploadId: "u-1",
      filename: "delta_fixture_multiclaim.edi",
      uploadedAt: "2026-03-02T10:00:00.000Z",
      uploadedBy: "Billing User",
      documentUrl: "/api/rcm/uploads/u-1/document?office=roland",
    },
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    odClaimNum: 53648,
    odPatNum: 12828,
    score: 95,
    confidence: "HIGH",
    evidence: [
      {
        tag: "CLAIM_NUMBER_MATCH",
        weight: 35,
        label: "Claim number matches",
        detail: "The carrier's claim number is this Open Dental ClaimNum.",
      },
      {
        tag: "BILLED_AMOUNT_MISMATCH",
        weight: -10,
        label: "Billed total differs",
        detail: "The remittance and the chart disagree on what was billed.",
        note: "250¢ apart",
      },
    ],
    blockers: [] as unknown[],
    od: {
      claimStatus: "S",
      dateService: "2026-03-02",
      // The header total and the live-lines total, which are allowed to differ:
      // `ClaimFee` still counts soft-deleted procedures (G12).
      claimHeaderFeeCents: 21000,
      billedCents: 21000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Fixture, Synthetic",
      // Stage A projected these two out of the patient row the match already
      // fetched; Stage B renders them as an identity check.
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
        code: "D0150",
        odClaimProcNum: 99001,
        odCode: "D0150",
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
    officeName: "Roland Family Dental",
    odCalls: 6,
    truncated: false,
    notes: [] as string[],
    patientsConsidered: [{ patNum: 12828, name: "Fixture, Synthetic" }],
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

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  remittances: [] as unknown[],
  needsAttentionCount: 0,
  /** Slice 6b — what the approval gate says, and what a press did. */
  approval: null as unknown,
  approvalError: null as Error | null,
  approveResult: null as unknown,
  approveError: null as Error | null,
  approved: [] as string[],
  detail: null as unknown,
  claim: null as unknown,
  listError: null as Error | null,
  detailError: null as Error | null,
  matchResult: null as unknown,
  confirmed: [] as number[],
  reviews: [] as string[],
  batchMatched: 0,
  /** Overrides folded into the batch-match response, for the bounded run. */
  batchOverrides: {} as Record<string, unknown>,
  /**
   * The signed-in identity, so the D-9 tier can be varied.
   *
   * `loading` is the default and the UI treats it as permissive on purpose:
   * hiding a button because /auth/me has not answered yet would flicker, and
   * the server refuses regardless — UI hiding is never the boundary.
   */
  auth: { status: "loading" } as
    | { status: "loading" }
    | { status: "anonymous" }
    | { status: "authenticated"; user: { isSuperAdmin: boolean; permissions: string[] } },
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
    /*
     * THE FILTER IS THE SERVER'S (Slice 6b), so the mock has to apply it.
     *
     * The page used to fetch everything and filter in the browser, which is why
     * this mock could ignore the tab. It now sends `view` and renders whatever
     * comes back — so a mock that returned the whole list on the attention tab
     * would test a component the server never feeds.
     */
    listRemittances: vi.fn(
      async (office: string, opts: { view?: string; limit?: number; offset?: number } = {}) => {
        if (state.listError) throw state.listError;
        const view = opts.view === "attention" ? "attention" : "all";
        const all = state.remittances as { needsAttention?: boolean }[];
        const selected = view === "attention" ? all.filter((r) => r.needsAttention) : all;
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 50;
        return {
          office,
          view,
          remittances: selected.slice(offset, offset + limit),
          total: all.length,
          needsAttentionCount: state.needsAttentionCount,
          matchingCount: selected.length,
          limit,
          offset,
        };
      },
    ),
    /*
     * The approval checklist, which RemittanceDetail now loads on mount.
     *
     * `state.approval` lets a test choose what the gate says; the default is a
     * postable claim with an approver signed in, because that is the shape most
     * of the detail tests want in the background while they assert something
     * else entirely.
     */
    getApprovalPreview: vi.fn(async (office: string, batchId: string) => {
      if (state.approvalError) throw state.approvalError;
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
      if (state.approveError) throw state.approveError;
      state.approved.push(batchId);
      return (
        state.approveResult ?? {
          office,
          batchId,
          queueId: "q-1",
          approvedBy: "Billing User",
          queued: [
            {
              claimId: "c-1",
              claimNumber: "53648",
              patientName: "Fixture, Synthetic",
              odClaimNum: 53648,
              lines: 1,
              totalCents: 15000,
            },
          ],
          withheld: [],
          alreadyQueued: [],
          intendedTotalCents: 15000,
          note: "Queued for posting — nothing has been written to Open Dental yet.",
        }
      );
    }),
    getRemittance: vi.fn(async (office: string) => {
      if (state.detailError) throw state.detailError;
      return state.detail ?? { office, remittance: { ...remittance(), plbAdjustments: [] }, claims: [claim()] };
    }),
    getClaim: vi.fn(async (office: string) => {
      if (state.detailError) throw state.detailError;
      return {
        office,
        claim: state.claim ?? claim(),
        // Stage B1 — the canned reasons come FROM THE SERVER, so the screen
        // renders whatever governs rather than a constant of its own.
        writeoffReasons: [
          { slug: "xrays_bitewings", label: "X-rays — bitewings" },
          { slug: "xrays_panoramic", label: "X-rays — panoramic" },
          { slug: "xrays_other", label: "X-rays — other films/images (OFIs)" },
          { slug: "not_chargeable", label: "Not chargeable for this procedure" },
          { slug: "build_up", label: "Build-up" },
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
      };
    }),
    matchClaim: vi.fn(async (office: string, claimId: string) => {
      const snap = (state.matchResult as Record<string, unknown>) ?? snapshot();
      const candidates = snap.candidates as unknown[];
      return {
        office,
        claimId,
        status: candidates.length > 0 ? "candidates" : "no_candidate",
        snapshot: snap,
      };
    }),
    confirmClaimMatch: vi.fn(async (_office: string, claimId: string, odClaimNum: number) => {
      state.confirmed.push(odClaimNum);
      return { claimId, odClaimNum, confirmedAt: "2026-03-03T16:00:00.000Z" };
    }),
    reviewClaim: vi.fn(async (_office: string, claimId: string, note: string) => {
      state.reviews.push(note);
      return { claimId };
    }),
    matchRemittance: vi.fn(async (office: string, batchId: string) => {
      state.batchMatched += 1;
      return {
        office,
        batchId,
        matched: [{ claimId: "c-1", status: "candidates", candidateCount: 1, ambiguous: false }],
        odCalls: 6,
        pacingMs: 1200,
        budgetMs: 90_000,
        outOfTime: false,
        skipped: 0,
        ...(state.batchOverrides as Record<string, unknown>),
      };
    }),
  };
});

import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
// Stage C: approving is a page of its own (§6). See the note above the approve
// group — the act is unchanged, the room it happens in is not.
import ApproveCheck from "@/pages/rcm/ApproveCheck";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string, searchPath = "") {
  /*
   * `searchHook` as well as `hook`: `?from=` is read through wouter's search
   * hook, and a memory router that supplies only `hook` leaves it reading the
   * jsdom URL — where the claim screen finds no batch id and falls back.
   * `searchPath` takes NO leading "?".
   */
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
  state.remittances = [];
  state.needsAttentionCount = 0;
  state.approval = null;
  state.approvalError = null;
  state.approveResult = null;
  state.approveError = null;
  state.approved = [];
  state.detail = null;
  state.claim = null;
  state.listError = null;
  state.detailError = null;
  state.matchResult = null;
  state.auth = { status: "loading" };
  state.confirmed = [];
  state.reviews = [];
  state.batchMatched = 0;
  state.batchOverrides = {};
});

afterEach(cleanup);

// ─── The list ────────────────────────────────────────────────────────────────

describe("the remittance list", () => {
  it("opens on Needs attention, not on everything", async () => {
    state.remittances = [
      remittance(),
      remittance({
        batchId: "b-2",
        payer: "CIGNA",
        needsAttention: false,
        attentionReasons: [],
      }),
    ];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");

    await waitFor(() => expect(screen.getByTestId("remittance-row-b-1")).toBeTruthy());
    // The finished one is hidden by the DEFAULT filter, not missing.
    expect(screen.queryByTestId("remittance-row-b-2")).toBeNull();
    expect(screen.getByTestId("remittance-filter-attention").getAttribute("aria-selected")).toBe("true");
  });

  it("always says how much the filter is hiding", async () => {
    // A filter that does not state its own scope is one people forget is on.
    state.remittances = [remittance(), remittance({ batchId: "b-2", needsAttention: false })];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");

    await waitFor(() =>
      expect(screen.getByTestId("remittance-counts-roland").textContent).toContain(
        "1 needing attention · 2 total",
      ),
    );
  });

  it("shows everything when All is chosen", async () => {
    state.remittances = [remittance(), remittance({ batchId: "b-2", needsAttention: false })];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");
    await waitFor(() => expect(screen.getByTestId("remittance-row-b-1")).toBeTruthy());

    // The tab is a `view` parameter now, so switching it re-fetches rather
    // than re-filtering an array already in the browser.
    fireEvent.click(screen.getByTestId("remittance-filter-all"));
    await waitFor(() => expect(screen.getByTestId("remittance-row-b-2")).toBeTruthy());
  });

  it("a fully reviewed remittance LEAVES the queue but keeps its chips", async () => {
    /*
     * The staging bug. A biller ran the match on both claims (honest
     * `no_candidate`), read the flags, marked both reviewed — and the batch
     * stayed in the needs-attention view, because three of the four reasons
     * were permanent facts about the file that no action in this slice can
     * change. Leaving the queue must not mean the facts disappear: the grey
     * chips are how the next person knows this remittance was worth reading.
     */
    state.remittances = [
      remittance({
        needsAttention: false,
        attentionReasons: [],
        attentionObservations: ["batch_open", "claims_flagged", "claims_unmatched"],
        reviewReasonCount: 2,
        unmatchedClaimCount: 2,
      }),
    ];
    state.needsAttentionCount = 0;

    renderAt(<RemittanceList />, "/rcm/remittances");

    // Gone from the default view…
    await waitFor(() =>
      expect(screen.getByTestId("remittances-empty-roland")).toBeTruthy(),
    );
    expect(screen.getByTestId("remittance-counts-roland").textContent).toContain(
      "0 needing attention · 1 total",
    );

    // …and everything it showed is still there under All.
    fireEvent.click(screen.getByTestId("remittance-filter-all"));
    await waitFor(() => expect(screen.getByTestId("remittance-row-b-1")).toBeTruthy());
    /*
     * CHANGED BY STAGE C — the CHIPS became a SENTENCE (§3).
     *
     * The row used to carry a strip of chips naming the server's predicates in
     * a shorter form of the server's own vocabulary: `2 unmatched`, `Held`,
     * `Claims not yet reviewed`. A biller reading them still had to work out
     * whose move it was, which is the question she actually had.
     *
     * The *Waiting on* cell answers it (`features/rcm/waitingOn.ts`), and the
     * SUBSTANCE of this assertion is unchanged: a check that owes nobody an
     * action must not read as work. It said that by the absence of an amber
     * chip; it says it now by the sentence itself and by its weight.
     */
    const waiting = screen.getByTestId("remittance-waiting-b-1");
    expect(waiting.textContent).toContain("You — 2 claims to match up");
    // Still nothing rendered as an outstanding OBLIGATION on the check itself:
    // matching is an observation, and the row says so by naming the work
    // rather than by flagging the file.
    expect(waiting.textContent).not.toContain("check over");
  });

  it("tells an outstanding action apart from a fact about the file", async () => {
    state.remittances = [
      remittance({
        needsAttention: true,
        attentionReasons: ["claims_unreviewed"],
        attentionObservations: ["batch_open"],
      }),
    ];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");

    /*
     * CHANGED BY STAGE C — the DISTINCTION SURVIVED, the chips did not (§3).
     *
     * Two chips told an obligation apart from a fact by weight. One sentence
     * does it by leading with the obligation and carrying the weight itself:
     * `waitingFor` reads `attentionReasons` before `attentionObservations`, so
     * a check that owes a review says so and does not lead with a fact about
     * the file. That ordering IS the old amber/grey rule, one level up.
     */
    const waiting = await screen.findByTestId("remittance-waiting-b-1");
    expect(waiting.textContent).toContain("You — 1 claim to check over");
    // Amber is still what "somebody owes this" looks like.
    expect(waiting.className).toContain("amber");
  });

  it("shows the DIFFERENCE on an unbalanced remittance, not just a flag", async () => {
    // The number a biller chases, in the row where they first see the problem.
    state.remittances = [remittance({ totalAmountCents: 20000 })];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");

    await waitFor(() =>
      expect(screen.getByTestId("remittance-imbalance-b-1").textContent).toContain("$50.00 off"),
    );
  });

  it("labels the source, because an 835 and a model-read PDF are different evidence", async () => {
    state.remittances = [remittance()];
    state.needsAttentionCount = 1;

    renderAt(<RemittanceList />, "/rcm/remittances");

    const chip = await screen.findByTestId("remittance-source-b-1");
    expect(chip.textContent).toBe("835");
    expect(chip.getAttribute("title")).toContain("cannot be misread");
  });

  it("distinguishes an empty office from a filtered-out one", async () => {
    state.remittances = [remittance({ needsAttention: false, attentionReasons: [] })];
    state.needsAttentionCount = 0;

    renderAt(<RemittanceList />, "/rcm/remittances");

    // A CLEAR QUEUE, not an empty practice. That distinction is the point of
    // the test: the office holds a remittance, this tab does not show it, and
    // the copy has to say both — "no remittances yet" over a practice holding
    // 600 of them reads as a broken screen.
    await waitFor(() =>
      expect(screen.getByTestId("remittances-empty-roland").textContent).toContain(
        "Nothing needs attention here.",
      ),
    );
    /*
     * CHANGED BY STAGE C — the sentence became a sentence AND A BUTTON (§11).
     *
     * "switch to All to see them" is an instruction, and an instruction on an
     * empty screen at 6pm is one more thing to do rather than a way out. The
     * copy still says how much the practice holds; the way out is now a control
     * beside it.
     */
    expect(screen.getByTestId("remittances-empty-roland").textContent).toContain(
      "1 check in this practice.",
    );
    expect(screen.getByTestId("remittances-empty-see-all-roland")).toBeTruthy();
    // And it does NOT offer the upload: that is the other empty.
    expect(screen.queryByTestId("remittances-empty-upload-roland")).toBeNull();
  });

  it("offers the upload from a practice that holds nothing at all", async () => {
    /*
     * The OTHER empty, and §15.2 finding 6 in its settled form.
     *
     * Uploading used to be on Today AND inline here, which is how the practice
     * owner got lost going round the loop live. There is now exactly ONE upload
     * surface, so this empty state OFFERS THE WAY THERE rather than opening a
     * second drawer of its own. That the link goes to the one surface and not to
     * a local panel is the assertion; the one-surface invariant itself is
     * pinned in `rcm-shell.test.tsx`.
     *
     * CHANGED BY STAGE C: that surface is `/rcm/bring-in`, a page of its own
     * (ruling D-16), rather than a section on Today reached by `?add=1`.
     */
    state.remittances = [];
    state.needsAttentionCount = 0;

    renderAt(<RemittanceList />, "/rcm/remittances");

    const empty = await screen.findByTestId("remittances-empty-roland");
    expect(empty.textContent).toContain("Nothing has come in for Roland yet");

    const cta = screen.getByTestId("remittances-empty-upload-roland");
    expect(cta.getAttribute("href")).toBe("/rcm/bring-in");
    // And nothing on this page uploads anything itself.
    expect(screen.queryByTestId("remittance-upload-panels")).toBeNull();
  });

  it("reports MODULE_NOT_ENTITLED in the server's own words", async () => {
    const { RcmApiError } = await import("@/features/rcm/api");
    state.listError = new RcmApiError("MODULE_NOT_ENTITLED", 403, "MODULE_NOT_ENTITLED");

    renderAt(<RemittanceList />, "/rcm/remittances");

    await waitFor(() =>
      expect(screen.getByTestId("remittances-error-roland").textContent).toContain(
        "not set up for the RCM module",
      ),
    );
  });
});

// ─── The detail ──────────────────────────────────────────────────────────────

describe("the remittance detail", () => {
  it("renders the balance check as a first-class fact", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await waitFor(() => expect(screen.getByTestId("balance-check")).toBeTruthy());
    expect(screen.getByTestId("stat-check-total").textContent).toBe("$150.00");
    expect(screen.getByTestId("stat-claim-total").textContent).toBe("$150.00");
    expect(screen.getByTestId("balance-check").textContent).toContain("Balances");
  });

  it("names the unaccounted amount when the totals disagree", async () => {
    state.detail = {
      office: "roland",
      remittance: { ...remittance({ totalAmountCents: 20000 }), plbAdjustments: [] },
      claims: [claim()],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await waitFor(() =>
      expect(screen.getByTestId("balance-check").textContent).toContain("$50.00 unaccounted"),
    );
  });

  it("renders CARC and RARC codes with their plain-English meanings", async () => {
    // Open Dental will not take these codes at all (ClaimAdjReasonCodes is
    // read-only over the API), so this rendering IS the product.
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await waitFor(() => expect(screen.getByTestId("toggle-lines-c-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-lines-c-1"));

    const lines = screen.getByTestId("lines-c-1");
    expect(within(lines).getByText("CO-45")).toBeTruthy();
    expect(within(lines).getByText("Charge exceeds fee schedule/maximum allowable")).toBeTruthy();
    expect(lines.textContent).toContain("N19");
    expect(lines.textContent).toContain("Procedure code incidental to primary procedure");
  });

  it("renders an unknown code BARE rather than glossing it with a guess", async () => {
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [
        claim({
          lines: [
            line({
              adjustments: [
                adjustment({ reasonCode: "9999", reasonDescription: null, remarkCode: null, remarkDescription: null }),
              ],
            }),
          ],
        }),
      ],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await waitFor(() => expect(screen.getByTestId("toggle-lines-c-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-lines-c-1"));

    const lines = screen.getByTestId("lines-c-1");
    expect(within(lines).getByText("CO-9999")).toBeTruthy();
    // No invented sentence anywhere near it.
    expect(lines.textContent).not.toContain("Adjustment code");
  });

  it("renders every Slice 4/5 flag as a first-class review reason", async () => {
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [
        claim({
          needsReviewReasons: ["unparseable_cas", "procedure_downcoded", "claim_denied"],
        }),
      ],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const flags = await screen.findByTestId("claim-flags-c-1");
    expect(flags.textContent).toContain("An adjustment could not be read");
    expect(flags.textContent).toContain("The carrier changed a procedure code");
    expect(flags.textContent).toContain("Denied by the carrier");
  });

  it("states plainly that a reversal will not be posted, and points at the manual route", async () => {
    // Detect-and-flag only: a negative supplemental is the single IRREVERSIBLE
    // Open Dental operation, so inventing an action for one would be worse than
    // admitting there is none.
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [claim({ needsReviewReasons: ["reversal_not_postable"] })],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const note = await screen.findByTestId("claim-no-action-c-1");
    expect(note.textContent).toContain("CareIN will not post this");
    expect(note.textContent).toContain("cannot be reversed");
  });

  it("keeps BOTH codes on a downcoded line", async () => {
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [claim({ lines: [line({ billedCode: "D0120", paidCode: "D0150", isDowncoded: true, flags: ["downcode"] })] })],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await waitFor(() => expect(screen.getByTestId("toggle-lines-c-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-lines-c-1"));

    const lines = screen.getByTestId("lines-c-1");
    expect(lines.textContent).toContain("D0120");
    expect(lines.textContent).toContain("submitted as D0150");
    expect(lines.textContent).toContain("Downcoded");
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * CHANGED BY STAGE C — APPROVING IS A PAGE, SO THESE RENDER THE PAGE
   * ═══════════════════════════════════════════════════════════════════════════
   * Every assertion below is unchanged in substance. What changed is WHERE the
   * gate lives: it was a panel on the check's own screen, competing for
   * attention with a balance check, a document link, a match button and thirty
   * claim rows, and it is now `/rcm/remittances/:id/approve` — a page where
   * nothing else is on screen at the moment somebody freezes a set of decisions
   * (§6).
   *
   * The ACT is untouched: same route, same `rcm.write` tier, same gate, same
   * audit row, same partial approve, same idempotency. So these tests render
   * `ApproveCheck` at the approve route instead of `RemittanceDetail`, and the
   * container id they wait on is the page's rather than the panel's.
   */
  it("renders the approval CHECKLIST before anything is pressed (Slice 6b)", async () => {
    /*
     * The whole point of the checklist: a biller can see which claims will be
     * withheld, and why, without pressing the button to find out. Pressing a
     * button to discover a refusal is how people learn to press buttons
     * hopefully.
     */
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim(),
        approvalClaim({
          claimId: "c-2",
          claimNumber: "53712",
          patientName: "Sample, Placeholder",
          postable: false,
          failed: ["REVIEWED"],
          checks: [
            { code: "MATCH_CONFIRMED", label: "Matched to an Open Dental claim", passed: true, detail: "ClaimNum 53712", fix: "Run the match and confirm one." },
            { code: "REVIEWED", label: "Reviewed by a person", passed: false, detail: "nobody has dispositioned this claim", fix: "Mark the claim reviewed, with a note." },
          ],
        }),
      ],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    await screen.findByTestId("rcm-approve-check");
    // CHANGED BY STAGE C: "can be approved" rather than "can be posted".
    // Approving is not posting, and the step names now say the invariant out
    // loud — a count that said "posted" on the approve screen was the one place
    // the copy still blurred it.
    expect(screen.getByTestId("approve-counts").textContent).toContain(
      "1 of 2 claims can be approved",
    );
    expect(screen.getByTestId("approve-counts").textContent).toContain("1 not ready yet");

    // Mixed pass/fail, per claim, with the INSTRUCTION under the failure.
    expect(screen.getByTestId("approval-state-c-1").textContent).toContain("Ready to post");
    expect(screen.getByTestId("approval-state-c-2").textContent).toContain("Not ready yet");
    // CHANGED BY STAGE C: "did not pass" rather than "failed" — the gate
    // refusing is the gate working, and a claim is not a failure.
    expect(screen.getByTestId("approval-state-c-2").textContent).toContain("did not pass");
    // The instruction is verb-first and comes from `features/rcm/checks.ts`;
    // the server's own `detail` survives as the quieter "why" line beneath it.
    expect(screen.getByTestId("check-detail-REVIEWED").textContent).toContain(
      "Add a note and mark this claim reviewed.",
    );
    expect(screen.getByTestId("check-why-REVIEWED").textContent).toContain(
      "nobody has dispositioned this claim",
    );

    // The button is LIVE, and it says what it will do.
    const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    // CHANGED BY STAGE C: the button answers the page's own question
    // ("Before you say yes.") rather than restating the step it is in.
    expect(approve.textContent).toContain("Yes — approve 1 claim");
  });

  it("a reviewer sees the same checklist and a disabled button naming the tier", async () => {
    /*
     * D-9. Seeing why a claim is withheld is not a posting act, and the person
     * who did the reviewing is best placed to fix what she is looking at.
     */
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: false,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    await screen.findByTestId("rcm-approve-check");
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approve-needs-permission").textContent).toContain("rcm.write");
    // The checklist itself is unchanged — the tier decides the button, not the truth.
    expect(screen.getByTestId("approval-state-c-1").textContent).toContain("Ready to post");
  });

  it("says plainly that nothing has reached Open Dental yet", async () => {
    /*
     * HONEST STATES, and the words matter: until Slice 6c ships, "queued for
     * posting" means a person authorised it and the money has not moved. The
     * sentence is the SERVER'S, so it changes on the day it stops being true.
     */
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("rcm-approve-check");

    fireEvent.click(screen.getByTestId("approve-button"));

    const result = await screen.findByTestId("approve-result");
    // CHANGED BY STAGE C: "approved" rather than "queued for posting" on the
    // result line. The SERVER's own honest-state sentence below it is
    // untouched and is still asserted verbatim.
    expect(result.textContent).toContain("1 claim approved");
    expect(screen.getByTestId("approve-honest-state").textContent).toBe(
      "Queued for posting — nothing has been written to Open Dental yet.",
    );
    expect(state.approved).toEqual(["b-1"]);
  });

  it("a partial approve names what was queued AND what was withheld", async () => {
    state.approveResult = {
      office: "roland",
      batchId: "b-1",
      queueId: "q-1",
      approvedBy: "Billing User",
      queued: [
        { claimId: "c-1", claimNumber: "53648", patientName: "Fixture, Synthetic", odClaimNum: 53648, lines: 1, totalCents: 15000 },
      ],
      withheld: [
        {
          claimId: "c-2",
          claimNumber: "53712",
          patientName: "Sample, Placeholder",
          reasons: ["NOT_REVERSAL"],
          checks: [
            { code: "NOT_REVERSAL", label: "Not a reversal or takeback", passed: false, detail: "the carrier reversed this claim", fix: "Handle it in Open Dental directly." },
          ],
        },
      ],
      alreadyQueued: [],
      intendedTotalCents: 15000,
      note: "Queued for posting — nothing has been written to Open Dental yet.",
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("rcm-approve-check");
    fireEvent.click(screen.getByTestId("approve-button"));

    const withheld = await screen.findByTestId("approve-withheld");
    expect(withheld.textContent).toContain("1 claim was left off");
    expect(withheld.textContent).toContain("Sample, Placeholder");
    expect(withheld.textContent).toContain("Not a reversal or takeback");
    // Partial success is REAL success — the queued half is stated too.
    expect(screen.getByTestId("approve-result").textContent).toContain("1 claim approved");
  });

  it("an honest refusal keeps the checklist on screen and lists the reasons", async () => {
    const { RcmApiError } = await import("@/features/rcm/api");
    state.approveError = new RcmApiError(
      "Nothing on this remittance can be posted yet.",
      409,
      "NOTHING_APPROVABLE",
      {
        claims: [
          { claimId: "c-1", claimNumber: "53648", patientName: "Fixture, Synthetic", postable: false, alreadyQueued: false, failed: ["REVIEWED"], checks: [] },
        ],
      },
    );

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("rcm-approve-check");
    fireEvent.click(screen.getByTestId("approve-button"));

    const err = await screen.findByTestId("approve-error");
    expect(err.textContent).toContain("Nothing on this remittance can be posted yet.");
    expect(err.textContent).toContain("REVIEWED");
    // The data stays on screen — a refusal is the gate working, and the
    // checklist is precisely what explains it.
    expect(screen.getByTestId("rcm-approve-check")).toBeTruthy();
  });

  it("renders remittance-level flags, coloured by the D-11 split", async () => {
    state.detail = {
      office: "roland",
      remittance: {
        ...remittance({ flags: ["envelope_incomplete", "plb_adjustments_present"] }),
        plbAdjustments: [],
      },
      claims: [claim()],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const flags = await screen.findByTestId("remittance-flags");
    // Slice 6a said only "Held — something on this remittance was flagged".
    expect(flags.textContent).toContain("missing a closing segment");
    expect(flags.textContent).toContain("Provider-level adjustments");
    // Blocking reads amber; annotating reads grey.
    expect(screen.getByTestId("remittance-flag-envelope_incomplete").className).toContain("amber");
    expect(screen.getByTestId("remittance-flag-plb_adjustments_present").className).toContain("muted");
  });

  it("itemises the PLB rather than showing a bare total", async () => {
    state.detail = {
      office: "roland",
      remittance: {
        ...remittance({ plbTotalCents: -4200, flags: ["plb_adjustments_present"] }),
        plbAdjustments: [
          { reasonCode: "WO", description: "Overpayment recovery", referenceId: "ACCT-1", amountCents: -5000 },
          { reasonCode: "L6", description: "Interest owed", referenceId: null, amountCents: 800 },
          // A code with no published description: rendered BARE, not guessed at.
          { reasonCode: "ZZ", description: "Provider adjustment (ZZ)", referenceId: null, amountCents: 0 },
        ],
      },
      claims: [claim()],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const plb = await screen.findByTestId("plb-detail");
    expect(plb.textContent).toContain("Overpayment recovery");
    expect(plb.textContent).toContain("Interest owed");
    expect(plb.textContent).toContain("ACCT-1");
    expect(plb.textContent).toContain("ZZ");
    expect(plb.textContent).not.toContain("Provider adjustment (ZZ)");
    // The manual route is a real link, not prose. (Slice 6a promised one.)
    expect(screen.getByTestId("plb-sop-link").getAttribute("href")).toBe("/rcm/sop/takeback");
  });

  it("predicts the gate on a claim card whose Confirm is still enabled", async () => {
    /*
     * THE RULING: confirming only LINKS a proposal to a chart claim, so it
     * stays available above a red blocker — but the card has to say that the
     * confirmation cannot be approved, and why. Otherwise the consequence first
     * appears at the gate, after the linkage is already committed.
     */
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [claim({ needsReviewReasons: ["totals_unreconciled", "procedure_downcoded"] })],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("claim-flags-c-1");
    expect(screen.getByTestId("claim-not-approvable-c-1").textContent).toContain(
      "cannot be approved for posting",
    );
    // Blocking amber, annotating grey — the same split the gate uses.
    expect(screen.getByTestId("claim-reason-totals_unreconciled").className).toContain("amber");
    expect(screen.getByTestId("claim-reason-procedure_downcoded").className).toContain("muted");
    // And Match is still offered: linking is not posting.
    expect(screen.getByTestId("open-claim-c-1")).toBeTruthy();
  });

  it("links to the source document and says who uploaded it", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const doc = await screen.findByTestId("source-document");
    expect(doc.textContent).toContain("delta_fixture_multiclaim.edi");
    expect(doc.textContent).toContain("Billing User");
    expect(doc.querySelector("a")?.getAttribute("href")).toContain("/api/rcm/uploads/u-1/document");
  });

  it("says NOT RECORDED for a pre-D-5 upload, never 'the system'", async () => {
    state.detail = {
      office: "roland",
      remittance: {
        ...remittance({ upload: { ...remittance().upload, uploadedBy: null } }),
        plbAdjustments: [],
      },
      claims: [claim()],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const doc = await screen.findByTestId("source-document");
    expect(doc.textContent).toContain("not recorded");
    expect(doc.textContent).not.toContain("System");
  });

  it("reports what a batch match did, per claim", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await waitFor(() => expect(screen.getByTestId("match-all-claims")).toBeTruthy());

    fireEvent.click(screen.getByTestId("match-all-claims"));

    await waitFor(() => expect(state.batchMatched).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId("batch-match-result").textContent).toContain("1 candidate"),
    );
  });

  it("a run stopped by the CLOCK says so in its own words", async () => {
    /*
     * `outOfTime` was typed and never rendered — the screen showed only the
     * server's note, which is the same fragility that let `skipped` go
     * invisible: a boolean the server sends needs a rendering of its own, or a
     * later copy edit silently stops saying it. And an unfinished run is the
     * one a biller must press again.
     */
    state.batchOverrides = {
      outOfTime: true,
      skipped: 7,
      budgetMs: 90_000,
      note: "7 claims were not reached before this run's 90s budget ran out.",
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await waitFor(() => expect(screen.getByTestId("match-all-claims")).toBeTruthy());
    fireEvent.click(screen.getByTestId("match-all-claims"));

    const stopped = await screen.findByTestId("match-out-of-time");
    expect(stopped.textContent).toContain("90-second budget");
    expect(stopped.textContent).toContain("7 claims not yet examined");
    expect(stopped.textContent).toContain("Press Match again");
  });
});

// ─── The match panel ─────────────────────────────────────────────────────────

describe("the claim match panel", () => {
  it("says nobody has looked yet, and that looking writes nothing", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    await waitFor(() => expect(screen.getByTestId("match-not-run")).toBeTruthy());
    expect(screen.getByTestId("match-not-run").textContent).toContain("writes nothing to any chart");
  });

  it("shows candidates with the evidence behind each score", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const evidence = await screen.findByTestId("evidence-53648");
    expect(evidence.textContent).toContain("Claim number matches");
    expect(evidence.textContent).toContain("+35");
    // Negative evidence is evidence too, and is shown as such.
    expect(evidence.textContent).toContain("Billed total differs");
    expect(evidence.textContent).toContain("-10");
    expect(evidence.textContent).toContain("250¢ apart");
  });

  it("DISPLAYS ambiguity rather than resolving it", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        ambiguous: true,
        margin: 0,
        candidates: [candidate(), candidate({ odClaimNum: 53649 })],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const warning = await screen.findByTestId("match-ambiguous");
    expect(warning.textContent).toContain("not a recommendation");
    /*
     * BOTH ARE STILL OFFERED — nothing is dropped for being ambiguous.
     *
     * Stage C-3 folds all but one candidate to a line, so "offered" now means
     * one open card and one row that opens on a click. The claim this test
     * makes is unchanged: neither candidate was removed, and the runner-up is
     * one click from the same card it always was.
     */
    expect(screen.getByTestId("candidate-53648")).toBeTruthy();
    expect(screen.getByTestId("candidate-row-53649")).toBeTruthy();

    fireEvent.click(screen.getByTestId("candidate-row-53649"));
    expect(screen.getByTestId("candidate-53649")).toBeTruthy();
  });

  it("reads 'no candidate' as a finished search, not an empty screen", async () => {
    state.claim = claim({
      odMatchStatus: "no_candidate",
      odMatchAt: "2026-03-03T15:00:00.000Z",
      matchSnapshot: snapshot({ candidates: [] }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const panel = await screen.findByTestId("no-candidate");
    expect(panel.textContent).toContain("No matching claim in Open Dental");
    expect(panel.textContent).toContain("a recorded outcome, not a missing one");
    expect(panel.textContent).toContain("Roland Family Dental");
    // The honest empty search says so explicitly, so it cannot be confused with
    // the one below.
    expect(panel.textContent).toContain("nothing was set aside");
  });

  it("a search that examined claims and offered none of them does NOT read as empty", async () => {
    /*
     * The two have the same empty candidate list. Telling a biller the chart
     * has no such claim when three were found and discarded is the exact
     * failure the four honest states exist to prevent, one layer up.
     */
    state.claim = claim({
      odMatchStatus: "no_candidate",
      odMatchAt: "2026-03-03T15:00:00.000Z",
      matchSnapshot: snapshot({
        candidates: [],
        rejectedCandidates: 3,
        rejectedReasons: { nameMismatch: 2, belowScore: 1 },
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const panel = await screen.findByTestId("no-candidate");
    expect(panel.textContent).toContain("Nothing here is safe to offer");
    expect(panel.textContent).toContain("3 Open Dental claims were examined and set aside");
    expect(panel.textContent).toContain("2 on a different patient's name");
    expect(panel.textContent).toContain("1 scoring below 15");
    // And it must NOT claim the chart has nothing — including in the status
    // chip, or the screen would be arguing with itself.
    expect(panel.textContent).not.toContain("No matching claim in Open Dental");
    expect(screen.getByTestId("claim-match-status").textContent).toContain(
      "Examined — none offered",
    );
  });

  it("the remittance's OWN claim list stops calling an all-rejected search empty", async () => {
    /*
     * The claim panel got this right and the LIST — the screen billers actually
     * triage from — went on rendering the raw status label. Same helper, same
     * data: the list row carries `rejectedCandidates` as a projection of the
     * snapshot, so it can tell the two negatives apart without shipping every
     * Open Dental patient name on the check into a list response.
     */
    state.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [
        claim({ claimId: "c-1", odMatchStatus: "no_candidate", rejectedCandidates: 0 }),
        claim({
          claimId: "c-2",
          patientName: "Sample, Placeholder",
          odMatchStatus: "no_candidate",
          rejectedCandidates: 3,
        }),
      ],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const empty = await screen.findByTestId("claim-match-state-c-1");
    const rejected = screen.getByTestId("claim-match-state-c-2");
    expect(empty.textContent).toContain("No matching claim in Open Dental");
    expect(rejected.textContent).toContain("Examined — none offered");
    expect(rejected.textContent).not.toContain("No matching claim in Open Dental");
  });

  it("a reviewer cannot press Run again on a CONFIRMED claim", async () => {
    /*
     * "Run again" on a confirmed claim sends `force: true`, which NULLs
     * `od_claim_num` — the column Slice 6c reads to pick a chart. A tier that
     * cannot confirm must not be able to un-confirm. UI hiding only; the server
     * answers 403 FORCE_REQUIRES_WRITE whatever the button does.
     */
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read", "rcm.queue"] },
    };
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53648,
      matchSnapshot: snapshot(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const button = (await screen.findByTestId("run-match")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("reconfirm-warning").textContent).toContain("needs posting permission");
  });

  it("an approver still can, and is told what it costs", async () => {
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read", "rcm.queue", "rcm.write"] },
    };
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53648,
      matchSnapshot: snapshot(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const button = (await screen.findByTestId("run-match")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId("reconfirm-warning").textContent).toContain("un-links the claim");
  });

  it("a reviewer CAN still run a match on a claim nobody confirmed", async () => {
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read", "rcm.queue"] },
    };
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const button = (await screen.findByTestId("run-match")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("a snapshot from an earlier version is named, not rendered as never-run", async () => {
    /*
     * `confirmMatch` refuses a v1 snapshot; the GET used to hand it over anyway
     * and the panel then read fields that shape does not have — every legacy
     * claim rendered "this patient is already linked" and a formatted
     * `undefined` for the billed total. "Nobody has looked" would be just as
     * wrong: a match DID run.
     */
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: null,
      matchSnapshotStale: true,
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const panel = await screen.findByTestId("match-stale");
    expect(panel.textContent).toContain("earlier version");
    expect(panel.textContent).toContain("Nothing has been un-linked");
    expect(screen.queryByTestId("match-not-run")).toBeNull();
  });

  it("says how many candidates were set aside even when some were offered", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({ rejectedCandidates: 2, rejectedReasons: { nameMismatch: 2, belowScore: 0 } }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const meta = await screen.findByTestId("match-rejected");
    expect(meta.textContent).toContain("2 Open Dental claims examined and not offered");
    expect(meta.textContent).toContain("2 on a different patient's name");
  });

  it("says when the name rule was off because the patient is already linked", async () => {
    // A married-name change on a correctly linked chart is routine; the panel
    // has to explain why a name disagreement did not disqualify anything.
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({ nameRuleApplied: false }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const note = await screen.findByTestId("match-name-rule-off");
    expect(note.textContent).toContain("already linked");
  });

  it("shows the live-lines billed total, and says when lines could not be read", async () => {
    /*
     * The header total still counts soft-deleted procedures, so the number on
     * screen has to be the one the billed evidence was actually computed from —
     * otherwise a biller reads a figure no comparison on this page was made
     * against.
     */
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        candidates: [
          candidate({
            od: {
              claimStatus: "S",
              dateService: "2026-03-02",
              claimHeaderFeeCents: 41000,
              billedCents: 21000,
              insPaidCents: 0,
              writeOffCents: 0,
              patientName: "Fixture, Synthetic",
              lines: [],
              deletedLineCount: 0,
              unknownDeletedLineCount: 2,
            },
          }),
        ],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const card = await screen.findByTestId("candidate-53648");
    expect(card.textContent).toContain("$210.00");
    expect(card.textContent).not.toContain("$410.00");
    expect(screen.getByTestId("unknown-lines-53648").textContent).toContain("2 lines unread");
  });

  it("surfaces the pre-flight facts Slice 6c will refuse on", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        candidates: [
          candidate({
            blockers: [
              {
                code: "LINE_IS_TRANSFER",
                blocking: true,
                label: "A line is an income transfer",
                detail: "PUT /claimprocs is refused when IsTransfer is true.",
                count: 1,
              },
              {
                code: "DELETED_PROCEDURES_EXCLUDED",
                blocking: false,
                label: "Deleted procedures excluded",
                detail: "DELETE /procedurelogs is a soft delete.",
                count: 2,
              },
            ],
          }),
        ],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const blockers = await screen.findByTestId("blockers-53648");
    expect(blockers.textContent).toContain("A line is an income transfer (1)");
    expect(blockers.textContent).toContain("Deleted procedures excluded (2)");
  });

  it("shows which chart line each of our lines would touch, and where none does", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        candidates: [
          candidate({
            linePairs: [
              { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 99001, odCode: "D0150", billedDeltaCents: 0, reason: null },
              { lineId: "pl-2", position: 2, code: "D1110", odClaimProcNum: null, odCode: null, billedDeltaCents: null, reason: "no line on this claim carries this code" },
            ],
          }),
        ],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const pairs = await screen.findByTestId("pairs-53648");
    expect(pairs.textContent).toContain("ClaimProc 99001");
    expect(pairs.textContent).toContain("no line on this claim carries this code");
  });

  it("confirming is a click a person makes, and reports the linkage", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    fireEvent.click(await screen.findByTestId("confirm-53648"));

    await waitFor(() => expect(state.confirmed).toEqual([53648]));
    await waitFor(() =>
      expect(screen.getByTestId("claim-notice").textContent).toContain("Linked to Open Dental claim 53648"),
    );
  });

  it("warns that re-running un-links, before anyone presses it", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53648,
      matchSnapshot: snapshot(),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const warning = await screen.findByTestId("reconfirm-warning");
    expect(warning.textContent).toContain("un-links the claim");
    expect(warning.textContent).toContain("stays in the audit trail");
  });

  it("marking reviewed is offered without a match, and says it changes nothing in OD", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const box = await screen.findByTestId("review-box");
    expect(box.textContent).toContain("changes nothing in Open Dental");
    expect(box.textContent).toContain("can still be finished work");

    fireEvent.change(screen.getByTestId("review-note"), {
      target: { value: "Carrier owes a corrected EOB." },
    });
    fireEvent.click(screen.getByTestId("mark-reviewed"));

    await waitFor(() => expect(state.reviews).toEqual(["Carrier owes a corrected EOB."]));
  });

  it("states the tolerances the scores were actually produced with", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const meta = await screen.findByTestId("match-meta");
    expect(meta.textContent).toContain("within $1.00");
    expect(meta.textContent).toContain("within 7 days");
    expect(meta.textContent).toContain("6 Open Dental reads");
  });

  it("says out loud when a search hit a limit", async () => {
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot({
        truncated: true,
        notes: ["Patient 12828 has 31 claims; the 8 most recent were examined in detail."],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const meta = await screen.findByTestId("match-meta");
    expect(meta.textContent).toContain("some Open Dental claims were not examined");
    expect(screen.getByTestId("match-notes").textContent).toContain("8 most recent");
  });

  /*
   * STAGE C-3, item 2. There is no Approve control on this screen any more —
   * not an enabled one and not a disabled one. It could never be pressed on any
   * claim, in any state, by anybody, because approving is a whole-check act, and
   * a button that is permanently dead teaches a biller that controls here lie.
   *
   * What replaced it is what she actually needed: a link to the screen that
   * approves. The test now asserts BOTH halves — the dead control is gone, and
   * the way to the live one is present and points at it.
   */
  it("offers the way to where approving happens, not a dead Approve button", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const link = await screen.findByTestId("approve-link");
    expect(link.getAttribute("href")).toBe("/rcm/remittances/b-1/approve");
    expect(screen.getByTestId("approve-lives-elsewhere").textContent).toContain(
      "Approving happens on the check",
    );
    expect(screen.queryByTestId("approve-disabled")).toBeNull();
  });

  it("names where approving happens even with no check to link to", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    const fallback = await screen.findByTestId("approve-link-list");
    expect(fallback.getAttribute("href")).toBe("/rcm/remittances");
    expect(screen.queryByTestId("approve-link")).toBeNull();
  });
});
