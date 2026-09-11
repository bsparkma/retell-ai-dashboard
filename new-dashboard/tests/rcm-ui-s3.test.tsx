/**
 * RCM UI OVERHAUL, SLICE 3 — the check's own page, and Match it up.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * Every claim here is one a biller would be MISLED by if it broke, and each one
 * pins a sentence rather than a layout:
 *
 *  W-11  A match run reports what it DID and what it LEFT ALONE. The old line
 *        counted the results array — already-confirmed claims, no-candidates and
 *        outright failures included — and called the total "matched".
 *
 *  W-11  Exactly ONE page-level match verb on the check. There were two, reading
 *        "Match it up" and "Match all claims", firing the same act.
 *
 *  W-7   Confirming a match whose CLAIM NUMBER does not agree goes through an
 *        interstitial that names what does not agree and defaults to declining.
 *        Both directions are pinned: an agreeing number must never see it, and a
 *        non-agreeing one must not be confirmable without it.
 *
 *  §2    The agreement sentence names only fields that were COMPARED and
 *        MATCHED. It used to name the birthday and the subscriber id purely
 *        because Open Dental had sent them — neither is on the remittance side,
 *        so neither was ever compared.
 *
 *  §1    The verdict miniature on the check is the gate's own verdict, rendered
 *        verbatim. A green cell beside a red claim must be a shape the code
 *        cannot produce.
 *
 *  §9    A column whose job is a sentence never cuts itself off.
 *
 * NO REAL PATIENT DATA. Every name here is synthetic and every PatNum is a
 * documented fixture (12827 / 12828).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures — synthetic only ───────────────────────────────────────────────

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
    adjustments: [] as unknown[],
    contractualWriteOffCents: 6000,
    patientRemainderCents: 0,
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
    eobPatientCents: 0,
    projectedPatientCents: 0,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 6000,
    decisions: [] as unknown[],
    problems: [] as unknown[],
    sentence: "Will owe $0.00 — matches the EOB.",
    ...over,
  };
}

function identity(over: Record<string, unknown> = {}) {
  return {
    matched: true,
    blocking: false,
    fields: [
      { field: "name", label: "Name", eob: "Test 2, Stedi", od: "Test 2, Stedi", status: "agrees", blocking: false },
    ],
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Test 2, Stedi",
    odPatientId: null,
    odClaimNum: null,
    payer: "SYNTHETIC DENTAL",
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

function remittance(over: Record<string, unknown> = {}) {
  const totalAmountCents = (over.totalAmountCents as number) ?? 15000;
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents,
    postedAmountCents: 0,
    plbTotalCents: 0,
    plbAdjustments: [] as unknown[],
    claimCount: 1,
    patientNames: { shown: ["Test 2, Stedi"], more: 0 },
    status: "ready",
    source: "835",
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
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: ["claims_unmatched"],
    reviewReasonCount: 0,
    unmatchedClaimCount: 1,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    parkedAt: null,
    setAsideAt: null,
    setAsideReason: null,
    setAsideNote: null,
    setAsideBy: null,
    upload: null,
    plans: [] as unknown[],
    comparisonVerdict: null,
    comparisonReason: null,
    comparisonNote: null,
    comparisonAt: null,
    comparisonBy: null,
    comparisonRevision: null,
    ...over,
  };
}

/**
 * A candidate whose CLAIM NUMBER AGREES — the fixture carries the server's own
 * `CLAIM_NUMBER_MATCH` evidence tag, because that tag, and nothing the client
 * computes, is what the screens read.
 */
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
    ],
    blockers: [] as unknown[],
    od: {
      claimStatus: "S",
      dateService: "2026-03-02",
      claimHeaderFeeCents: 21000,
      billedCents: 21000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Test 2, Stedi",
      /* Open Dental HAS both identity facts. The remittance side has neither,
         so neither may appear in the agreement sentence. */
      patientBirthdate: "1990-01-01",
      subscriberId: "ABC123456",
      lines: [] as unknown[],
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

/** The same candidate with NO claim-number evidence — the W-7 case. */
function strangerCandidate(over: Record<string, unknown> = {}) {
  return candidate({ odClaimNum: 990099, evidence: [] as unknown[], ...over });
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
    patientsConsidered: [{ patNum: 12828, name: "Test 2, Stedi" }],
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
  detail: null as unknown,
  claim: null as unknown,
  approval: null as unknown,
  batch: null as unknown,
  confirmed: [] as number[],
  matchedClaims: [] as { claimId: string; force: boolean }[],
  auth: { status: "loading" } as
    | { status: "loading" }
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
    getRemittance: vi.fn(async (office: string) => {
      return (
        state.detail ?? { office, remittance: remittance(), claims: [claim()] }
      );
    }),
    getApprovalPreview: vi.fn(async (office: string, batchId: string) => {
      return (
        state.approval ?? {
          office,
          batchId,
          canApprove: true,
          approveRequires: "rcm.write",
          claims: [{ claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", postable: true, alreadyQueued: false, failed: [], checks: [], verdict: verdict() }],
          postableCount: 1,
          withheldCount: 0,
          queuedCount: 0,
          balanced: true,
          differenceCents: 0,
        }
      );
    }),
    /* The posting switch. Never in shadow mode here — the banner is S4's. */
    listPostingQueue: vi.fn(async () => ({
      office: "roland",
      rows: [],
      postingEnabled: false,
      drainEnabled: false,
    })),
    getRecoupmentChecklist: vi.fn(async () => {
      throw new Error("no takeback on this fixture");
    }),
    unparkRemittance: vi.fn(async () => ({ wasParked: false })),
    matchRemittance: vi.fn(async (office: string, batchId: string) => ({
      office,
      batchId,
      matched: [{ claimId: "c-1", status: "candidates", candidateCount: 1, ambiguous: false }],
      odCalls: 6,
      pacingMs: 1200,
      budgetMs: 90_000,
      outOfTime: false,
      skipped: 0,
      ...((state.batch as Record<string, unknown>) ?? {}),
    })),
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: state.claim ?? claim(),
      writeoffReasons: [{ slug: "xrays_bitewings", label: "X-rays — bitewings" }],
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
    matchClaim: vi.fn(
      async (office: string, claimId: string, opts: { force?: boolean } = {}) => {
        state.matchedClaims.push({ claimId, force: opts.force === true });
        return { office, claimId, status: "candidates", snapshot: snapshot() };
      },
    ),
    confirmClaimMatch: vi.fn(async (_office: string, claimId: string, odClaimNum: number) => {
      state.confirmed.push(odClaimNum);
      return { claimId, odClaimNum, confirmedAt: "2026-03-03T16:00:00.000Z" };
    }),
  };
});

import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string, searchPath = "") {
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
  state.detail = null;
  state.claim = null;
  state.approval = null;
  state.batch = null;
  state.confirmed = [];
  state.matchedClaims = [];
  state.auth = { status: "loading" };
});

afterEach(cleanup);

// ─── W-11: say what you skipped ──────────────────────────────────────────────

describe("a match run says what it did AND what it left alone", () => {
  it("never adds the already-confirmed into the matched count", async () => {
    /*
     * THE BUG THIS PINS. The old line printed `matched.length` — the length of
     * the results ARRAY — and called it "Matched N claims against Open Dental".
     * Here the run matched ONE claim and left nine alone because somebody had
     * already confirmed them. The old sentence said ten.
     */
    state.batch = {
      matched: [
        { claimId: "c-1", status: "candidates", candidateCount: 2, ambiguous: false },
        ...Array.from({ length: 9 }, (_, i) => ({
          claimId: `c-${i + 2}`,
          status: "already_confirmed",
        })),
      ],
      skipped: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("rcm-cta"));

    const summary = await screen.findByTestId("batch-match-summary");
    expect(summary.textContent).toContain("Matched 1 claim");
    expect(summary.textContent).toContain("left 9 already confirmed");
    expect(summary.textContent).not.toContain("Matched 10");
  });

  it("names every other reason it left a claim alone, with its own count", async () => {
    state.batch = {
      matched: [
        { claimId: "c-1", status: "candidates", candidateCount: 1, ambiguous: false },
        { claimId: "c-2", status: "already_confirmed" },
        { claimId: "c-3", status: "no_candidate", candidateCount: 0 },
        { claimId: "c-4", status: "no_candidate", candidateCount: 0 },
        { claimId: "c-5", status: "failed", error: "Open Dental did not answer" },
      ],
      skipped: 3,
      outOfTime: true,
      budgetMs: 90_000,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("rcm-cta"));

    const summary = await screen.findByTestId("batch-match-summary");
    expect(summary.textContent).toContain("Matched 1 claim");
    expect(summary.textContent).toContain("left 1 already confirmed");
    expect(summary.textContent).toContain("2 with nothing in Open Dental to match");
    expect(summary.textContent).toContain("1 could not be read");
    expect(summary.textContent).toContain("3 not reached before this run's 90-second limit");
  });

  it("is honest at zero rather than silent", async () => {
    /*
     * A run that matched nothing is the case a bare success sentence hides
     * best. "Matched no claims" is the sentence; a screen that printed only the
     * reasons would leave a reader to infer the headline.
     */
    state.batch = {
      matched: [{ claimId: "c-1", status: "no_candidate", candidateCount: 0 }],
      skipped: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("rcm-cta"));

    const summary = await screen.findByTestId("batch-match-summary");
    expect(summary.textContent).toContain("Matched no claims");
    expect(summary.textContent).toContain("1 with nothing in Open Dental to match");
  });
});

// ─── W-11: one match verb ────────────────────────────────────────────────────

describe("the check's page offers exactly one match verb", () => {
  /**
   * PAGE LEVEL means "not inside the claims table".
   *
   * The per-claim *Match this claim again* is the placement half of W-11 and is
   * expected to exist — what may not exist twice is a control that re-matches
   * THE CHECK. The check's own header and its rail used to carry one each.
   */
  function pageLevelMatchButtons() {
    const page = screen.getByTestId("rcm-remittance-detail");
    return [...page.querySelectorAll("button, a")].filter((el) => {
      if (el.closest('[data-testid^="claim-card-"]')) return false;
      return /\bmatch/i.test(el.textContent ?? "");
    });
  }

  it("has one, and it is the flow's own CTA", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-cta");

    const buttons = pageLevelMatchButtons();
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Match it up"]);
    expect(buttons[0].getAttribute("data-testid")).toBe("rcm-cta");
  });

  it("does not let the rail draw a second copy of it", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const rail = await screen.findByTestId("rcm-stepper");
    expect(within(rail).queryByTestId("rcm-cta")).toBeNull();
    // The five steps themselves are untouched.
    expect(within(rail).getByTestId("step-match")).toBeTruthy();
    expect(within(rail).getByTestId("step-deposit")).toBeTruthy();
  });

  it("moves re-matching to the row that names the claim, same endpoint", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("rematch-claim-c-1"));

    await waitFor(() => expect(state.matchedClaims).toHaveLength(1));
    // An UNCONFIRMED claim is re-searched, never force-released.
    expect(state.matchedClaims[0]).toEqual({ claimId: "c-1", force: false });
  });

  it("forces only on a claim somebody already confirmed", async () => {
    state.detail = {
      office: "roland",
      remittance: remittance(),
      claims: [claim({ odMatchStatus: "confirmed", odClaimNum: 53648 })],
    };
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.write", "rcm.queue"] },
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("rematch-claim-c-1"));

    await waitFor(() => expect(state.matchedClaims).toHaveLength(1));
    expect(state.matchedClaims[0]).toEqual({ claimId: "c-1", force: true });
  });

  it("refuses the release to a reviewer, and says why (D-9)", async () => {
    state.detail = {
      office: "roland",
      remittance: remittance(),
      claims: [claim({ odMatchStatus: "confirmed", odClaimNum: 53648 })],
    };
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.queue"] },
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const button = await screen.findByTestId("rematch-claim-c-1");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("rematch-reason-c-1").textContent).toContain("posting permission");
  });
});

// ─── W-7 / ruling Q2: the named-difference confirm ───────────────────────────

describe("confirming a match whose claim number does not agree", () => {
  const linked = () => ({
    ...claim({ odMatchStatus: "candidates" }),
    matchSnapshot: snapshot({ candidates: [strangerCandidate()] }),
  });

  it("an AGREEING claim number never sees the interstitial", async () => {
    state.claim = { ...claim({ odMatchStatus: "candidates" }), matchSnapshot: snapshot() };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    await waitFor(() => expect(state.confirmed).toEqual([53648]));
    expect(screen.queryByTestId("match-anyway")).toBeNull();
  });

  it("a NON-agreeing one cannot be confirmed without it", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    await screen.findByTestId("match-anyway");
    // The press did NOT reach the server.
    expect(state.confirmed).toEqual([]);
  });

  it("lists the claim number FIRST among what does not agree", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    const list = await screen.findByTestId("match-anyway-differences");
    const first = list.querySelector("li");
    expect(first?.getAttribute("data-testid")).toBe("match-anyway-diff-claimNumber");
    expect(first?.textContent).toContain("53648");
    expect(first?.textContent).toContain("990099");
  });

  it("labels the affirmative with the consequence, not with OK", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    const affirm = await screen.findByTestId("match-anyway-confirm");
    expect(affirm.textContent).toContain("Match anyway — no claim number agrees");
  });

  it("defaults to declining — the focus, and Escape", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    const panel = await screen.findByTestId("match-anyway");
    // The DECLINE button holds the focus, so Enter — the reflex — backs out.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("match-anyway-cancel")),
    );

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("match-anyway")).toBeNull());
    expect(state.confirmed).toEqual([]);
  });

  it("confirms only once somebody presses the affirmative", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));
    fireEvent.click(await screen.findByTestId("match-anyway-confirm"));

    await waitFor(() => expect(state.confirmed).toEqual([990099]));
  });

  it("no typed phrase — that gesture stays reserved for the takeback", async () => {
    state.claim = linked();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));

    const panel = await screen.findByTestId("match-anyway");
    expect(panel.querySelectorAll("input, textarea")).toHaveLength(0);
  });
});

// ─── §2: the agreement sentence ──────────────────────────────────────────────

describe("the agreement sentence names only fields that were compared", () => {
  it("never claims the birthday or the subscriber id agree", async () => {
    /*
     * THE BUG THIS PINS. Both were named whenever OPEN DENTAL had sent them —
     * and the remittance side of this comparison carries neither, so nothing was
     * ever compared. A biller deciding she has the right person was reading two
     * clauses with no facts behind them.
     *
     * The fixture's Open Dental candidate HAS both, so the only thing keeping
     * them out of the sentence is the rule.
     */
    state.claim = { ...claim({ odMatchStatus: "candidates" }), matchSnapshot: snapshot() };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const sentence = await screen.findByTestId("match-guidance-agreement");

    // Case-insensitive: the sentence capitalises its own first word, and which
    // field leads it is the agreement rule's business, not this test's.
    expect(sentence.textContent).toMatch(/claim number/i);
    expect(sentence.textContent).toMatch(/(^|[ ,])name[ ,]/i);
    expect(sentence.textContent).toMatch(/service date/i);
    expect(sentence.textContent).toMatch(/every line/i);
    expect(sentence.textContent).not.toMatch(/birthday/i);
    expect(sentence.textContent).not.toMatch(/subscriber/i);
  });

  it("still PRINTS what Open Dental holds — printing is not claiming", async () => {
    /*
     * The other half of the rule. Dropping the two facts from the identity
     * column would be a different and worse fix: what Open Dental holds is a
     * fact, and a biller comparing it by eye is exactly what the column is for.
     */
    state.claim = { ...claim({ odMatchStatus: "candidates" }), matchSnapshot: snapshot() };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const od = await screen.findByTestId("match-guidance-od");
    expect(od.textContent).toContain("Born");
    expect(od.textContent).toContain("Subscriber");
  });

  it("says nothing rather than agreement when a field is only on one side", async () => {
    state.claim = {
      ...claim({ odMatchStatus: "candidates", serviceDate: null }),
      matchSnapshot: snapshot({
        candidates: [candidate({ od: { ...candidate().od, dateService: null } })],
      }),
    };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const sentence = await screen.findByTestId("match-guidance-agreement");
    expect(sentence.textContent).not.toMatch(/service date/i);
  });
});

// ─── §2: Likely / Possible, and the honest fallback ──────────────────────────

describe("more than one candidate", () => {
  const unsure = () => ({
    ...claim({ odMatchStatus: "candidates" }),
    matchSnapshot: snapshot({
      ambiguous: true,
      candidates: [
        candidate(),
        candidate({
          odClaimNum: 53649,
          score: 60,
          confidence: "MEDIUM",
          evidence: [] as unknown[],
          od: { ...candidate().od, dateService: "2026-01-20", billedCents: 15600 },
        }),
      ],
    }),
  });

  it("labels each candidate from the server's own band", async () => {
    state.claim = unsure();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    await screen.findByTestId("match-guidance-unsure");

    expect(screen.getByTestId("match-guidance-likelihood-53648").textContent).toBe("Likely");
    expect(screen.getByTestId("match-guidance-likelihood-53649").textContent).toBe("Possible");
  });

  it("spells out the value beside every delta it marks", async () => {
    /*
     * "six weeks earlier" on its own highlights a row without saying what is in
     * it. The value comes first and the distance after it, so one line answers
     * both "what does Open Dental hold" and "how far is that from the EOB".
     */
    state.claim = unsure();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const diffs = await screen.findByTestId("match-guidance-diffs-53649");

    expect(diffs.textContent).toMatch(/Jan 20, 2026 — 6 weeks earlier/);
    expect(diffs.textContent).toMatch(/\$156\.00 — \$54\.00 less billed/);
  });

  it("answers 'neither of these' honestly instead of faking a search", async () => {
    /*
     * `/api/rcm` HAS NO patient or claim search — Stage C §15.1c names it as an
     * open backend ask. A dead search box, or one wired to another module's
     * endpoint behind its own entitlement gate, would both be worse than the
     * sentence that is actually true.
     */
    state.claim = unsure();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const neither = await screen.findByTestId("match-guidance-neither");

    expect(neither.textContent).toContain("Neither of these?");
    expect(neither.textContent).toContain("save the check for tomorrow and enter the claim first");
    expect(neither.querySelectorAll('input[type="search"], input[type="text"]')).toHaveLength(0);
  });

  it("keeps the invariant note on the match stage", async () => {
    state.claim = unsure();

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const footer = await screen.findByTestId("match-guidance-footer");
    expect(footer.textContent).toBe(
      "Nothing is written to Open Dental in this step — matching only tells the app which claim you mean.",
    );
  });
});

// ─── §1: the verdict miniature is the gate's own ─────────────────────────────

describe("Where the patient stands", () => {
  /** A sentence no client would ever compose — so a second arithmetic shows up. */
  const SENTENCE = "Open Dental's fee for D2740 doesn't match — will owe $131.40, not $44.00.";

  function previewWith(over: Record<string, unknown>) {
    return {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        {
          claimId: "c-1",
          claimNumber: "53648",
          patientName: "Test 2, Stedi",
          postable: false,
          alreadyQueued: false,
          failed: [] as string[],
          checks: [] as unknown[],
          verdict: verdict(over),
        },
      ],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };
  }

  it("renders the gate's sentence verbatim, computing nothing", async () => {
    state.approval = previewWith({ state: "red", sentence: SENTENCE });

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const cell = await screen.findByTestId("claim-stands-c-1");
    await waitFor(() => expect(cell.textContent).toBe(SENTENCE));
  });

  it("cannot render a green cell over a red verdict", async () => {
    /*
     * The tone is read off the SAME object as the sentence, so the pair cannot
     * come apart. This is the shape the column exists to make impossible.
     */
    state.approval = previewWith({ state: "red", sentence: SENTENCE });

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const cell = await screen.findByTestId("claim-stands-c-1");
    await waitFor(() => expect(cell.textContent).toBe(SENTENCE));
    expect(cell.querySelector("span")?.className).toMatch(/rose/);
    expect(cell.querySelector("span")?.className).not.toMatch(/emerald/);
  });

  it("says NOT JUDGED rather than guessing at a claim the gate skipped", async () => {
    state.approval = {
      ...previewWith({}),
      claims: [] as unknown[],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const cell = await screen.findByTestId("claim-stands-c-1");
    await waitFor(() => expect(cell.textContent).toContain("Not judged yet"));
  });

  /**
   * §9 — a column whose job is a sentence never cuts itself off.
   *
   * jsdom applies no CSS, so `textContent` on a clipped cell is still the whole
   * sentence. What clips is the CLASS, so the class is what this checks, on the
   * cell and on every ancestor up to the row.
   */
  it("wraps the sentence in full, and hides no half of it in a title", async () => {
    state.approval = previewWith({ state: "red", sentence: SENTENCE });

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const cell = await screen.findByTestId("claim-stands-c-1");
    await waitFor(() => expect(cell.textContent).toBe(SENTENCE));

    const CLIPPING = /\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d+)\b/;
    for (let el: HTMLElement | null = cell; el; el = el.parentElement) {
      const cls = typeof el.className === "string" ? el.className : "";
      expect(cls, `${el.tagName}.${cls} clips the sentence`).not.toMatch(CLIPPING);
      if (el.dataset.testid === "claim-card-c-1") break;
    }
    expect(cell.getAttribute("title")).toBeNull();
  });
});

// ─── §1: the header ──────────────────────────────────────────────────────────

describe("the check's header", () => {
  it("names where the page sits, and does not link the page to itself", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const crumbs = await screen.findByTestId("check-breadcrumb");

    expect(crumbs.textContent).toContain("Today");
    expect(crumbs.textContent).toContain("Checks");
    expect(crumbs.textContent).toContain("SYNTHETIC DENTAL");
    expect(within(crumbs).getByTestId("check-breadcrumb-checks").getAttribute("href")).toBe(
      "/rcm/remittances",
    );
    // The last crumb is the page you are on, so it is not a link.
    expect(within(crumbs).queryByText("SYNTHETIC DENTAL")?.tagName).toBe("SPAN");
  });

  it("says what it is worth, when it came in, and how big a job it is", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const summary = await screen.findByTestId("check-summary");

    expect(summary.textContent).toContain("$150.00");
    expect(summary.textContent).toContain("received Mar 2, 2026");
    expect(summary.textContent).toContain("1 claim");
  });

  it("drops the date rather than inventing one the carrier never sent", async () => {
    state.detail = {
      office: "roland",
      remittance: remittance({ depositDate: null }),
      claims: [claim()],
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const summary = await screen.findByTestId("check-summary");

    expect(summary.textContent).toContain("$150.00");
    expect(summary.textContent).not.toContain("received");
    expect(summary.textContent).not.toContain("—");
  });

  it("carries Save for tomorrow and Set aside beside the next verb", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    const page = await screen.findByTestId("rcm-remittance-detail");

    const actions = screen.getByTestId("check-worklist-actions");
    expect(within(actions).getByTestId("check-park")).toBeTruthy();
    expect(within(actions).getByTestId("check-set-aside")).toBeTruthy();

    /*
     * ALL THREE ABOVE THE RAIL — the header asks "what happens to this check
     * now", and its three answers belong together rather than one at the top
     * and two below a five-step diagram.
     */
    const rail = screen.getByTestId("rcm-stepper");
    const order = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(page.contains(actions)).toBe(true);
    expect(actions.compareDocumentPosition(rail) & order).toBeTruthy();
    expect(screen.getByTestId("rcm-cta").compareDocumentPosition(rail) & order).toBeTruthy();
  });
});
