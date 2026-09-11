/**
 * RCM UI OVERHAUL, SLICE 4 — the workbench, and "Before you say yes."
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * Every case below pins a SENTENCE a biller would be misled by if it broke, or
 * an identity between two things the screens print in two places:
 *
 *  W-1   The headline under the approve button and the ticks above it come out
 *        of ONE walk of the gate's answer. A check whose every claim is already
 *        approved can no longer read "waiting", and a finished check has a way
 *        forward instead of a dead page.
 *
 *  W-2   A CTA whose note IS its disabled reason does not also print the note a
 *        second line lower.
 *
 *  W-5   A check whose every claim is the carrier taking money back renders one
 *        sentence and one route, not a wall of conditions that can never clear.
 *        A MIXED check keeps the wall, because there it is the thing she needs.
 *
 *  §6    ONE ARITHMETIC, TWO RENDERERS — the check-level totals equal the sum of
 *        the rows the page is displaying, read out of the DOM.
 *
 *  §E/F/G  The bench: paid-in-full says the carrier paid; an amber verdict
 *        carries the stored decision, author and instant; a red one names the
 *        offending code, greys the approve verb with THAT code's reason, and
 *        flags the Open Dental row the money argument is about.
 *
 *  D-6   The takeback's typed field is dead until the takeback is matched — and
 *        NOTHING about the confirmation itself moved.
 *
 * NO REAL PATIENT DATA. Every name is synthetic and every PatNum is a documented
 * fixture (12827 "Stedi Test 2" / 12828 "Test, MangoTest").
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { standing, standingLine } from "@/features/rcm/standing";
import { verdictBlock } from "@/features/rcm/verdictBlock";
import { isTakebackClaim, isTakebackOnly } from "@/features/rcm/takeback";
import { rollUp } from "@/features/rcm/rollup";
import { claimFlow } from "@/features/rcm/flow";
import type { ApprovalClaim, ClaimVerdict } from "@/features/rcm/api";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures — synthetic only ───────────────────────────────────────────────

const check = (code: string, passed: boolean, detail: string | null = null) => ({
  code,
  label: code,
  passed,
  detail,
  fix: "…",
});

/** The conditions the gate sends on an ordinary, entirely healthy claim. */
const ALL_PASS = [
  check("OFFICE_CONSISTENT", true),
  check("MATCH_CONFIRMED", true, "ClaimNum 53784"),
  check("REVIEWED", true),
  check("LINES_PAIRED", true),
  check("CLAIM_TOTALS_AGREE", true),
];

function verdict(over: Partial<ClaimVerdict> = {}): ClaimVerdict {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 45000,
    projectedPatientCents: 45000,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 30000,
    decisions: [],
    problems: [],
    sentence: "Will owe $450.00 — matches the EOB.",
    ...over,
  };
}

function approvalClaim(over: Partial<ApprovalClaim> = {}): ApprovalClaim {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Stedi Test 2",
    postable: true,
    alreadyQueued: false,
    checks: ALL_PASS,
    failed: [],
    verdict: verdict(),
    ...over,
  };
}

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
    paidCents: 45000,
    adjustmentCents: 30000,
    patientRespCents: 45000,
    writeOffCents: 30000,
    adjustmentReason: null,
    isDowncoded: false,
    isBundled: false,
    isDenied: false,
    flags: [] as string[],
    odClaimProcNum: 533930,
    adjustments: [] as unknown[],
    contractualWriteOffCents: 30000,
    patientRemainderCents: 45000,
    decision: null as string | null,
    decisionReason: null as string | null,
    decidedBy: null as string | null,
    decidedAt: null as string | null,
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Stedi Test 2",
    odPatientId: 12827,
    odClaimNum: 53784,
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-02",
    receivedDate: "2026-03-02",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "primary",
    totalBilledCents: 120000,
    totalAllowedCents: 90000,
    totalPaidCents: 45000,
    totalDeductibleCents: 0,
    patientBalanceCents: 45000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 95,
    odMatchStatus: "confirmed",
    rejectedCandidates: 0,
    odMatchAt: "2026-03-03T15:00:00.000Z",
    odMatchConfirmedAt: "2026-03-03T15:00:00.000Z",
    odMatchedBy: "biller@example.invalid",
    reviewedAt: "2026-03-03T16:00:00.000Z",
    reviewedBy: "biller@example.invalid",
    reviewNote: "looked",
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-03-02T10:00:00.000Z",
    lines: [line()],
    matchSnapshot: null,
    matchSnapshotStale: false,
    patientDob: "1990-01-01",
    subscriberId: "ABC123456",
    verdict: verdict(),
    identity: { matched: true, blocking: false, fields: [] },
    chart: {
      odClaimNum: 53784,
      claimStatus: "S",
      fetchedAt: "2026-03-03T15:00:00.000Z",
      billedCents: 120000,
      insPaidCents: 0,
      writeOffCents: 0,
      lines: [
        {
          odClaimProcNum: 533930,
          code: "D2740",
          status: "NotReceived",
          feeBilledCents: 120000,
          insEstCents: 60000,
          insPayAmtCents: 0,
          writeOffCents: 0,
        },
      ],
    },
    provenance: null,
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
    totalAmountCents: 45000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    plbAdjustments: [] as unknown[],
    claimCount: 1,
    patientNames: { shown: ["Stedi Test 2"], more: 0 },
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: null,
    balance: {
      batchTotalCents: 45000,
      claimTotalCents: 45000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: [] as string[],
    attentionObservations: [] as string[],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
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

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  detail: null as unknown,
  claim: null as unknown,
  approval: null as unknown,
  recoupment: null as unknown,
  parked: [] as { batchId: string; note?: string }[],
  parkFails: null as Error | null,
  odHealth: null as unknown,
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    useAuth: () => ({
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read", "rcm.queue", "rcm.write"] },
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      {
        officeId: "roland",
        officeName: "Roland Family Dental",
        odConnected: true,
        odBlockedReason: null,
        odHealth: state.odHealth,
      },
    ],
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
      return state.detail ?? { office, remittance: remittance(), claims: [claim()] };
    }),
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
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: state.claim ?? claim(),
      writeoffReasons: [{ slug: "xrays_bitewings", label: "X-rays — bitewings" }],
      matchRules: {
        amountNearCents: 100,
        dateNearDays: 7,
        ambiguityMargin: 10,
        bands: [{ band: "HIGH", min: 75 }],
      },
    })),
    parkRemittance: vi.fn(async (_office: string, batchId: string, note?: string) => {
      if (state.parkFails) throw state.parkFails;
      state.parked.push({ batchId, note });
      return { batchId, parked: true };
    }),
    getRecoupmentChecklist: vi.fn(async () => {
      if (!state.recoupment) throw new Error("no takeback on this fixture");
      return state.recoupment;
    }),
    listPostingQueue: vi.fn(async () => ({
      office: "roland",
      rows: [],
      postingEnabled: false,
      drainEnabled: false,
    })),
    unparkRemittance: vi.fn(async () => ({ wasParked: false })),
  };
});

import ApproveCheck from "@/pages/rcm/ApproveCheck";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import { RecoupmentPanel } from "@/pages/rcm/RecoupmentPanel";
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
  state.recoupment = null;
  state.parked = [];
  state.parkFails = null;
  state.odHealth = null;
});

afterEach(cleanup);

/** Cents out of a rendered "$1,234.56". */
function cents(text: string | null): number {
  const m = (text ?? "").replace(/[^0-9.-]/g, "");
  return Math.round(Number(m) * 100);
}

// ═════════════════════════════════════════════════════════════════════════════
// W-1 · ONE WALK, TWO RENDERERS
// ═════════════════════════════════════════════════════════════════════════════

describe("W-1 · the headline and the ticks come from one function", () => {
  it("calls a check whose every claim is approved 'already approved', never 'waiting'", () => {
    const st = standing([
      approvalClaim({ claimId: "c-1", postable: false, alreadyQueued: true }),
      approvalClaim({ claimId: "c-2", postable: false, alreadyQueued: true }),
      approvalClaim({ claimId: "c-3", postable: false, alreadyQueued: true }),
    ]);

    expect(st.state).toBe("all_approved");
    expect(st.postable).toBe(0);
    expect(st.alreadyApproved).toBe(3);
    // The exact shape the walk found: postableCount 0, every tick green.
    expect(st.allConditionsPassed).toBe(true);
    expect(standingLine(st)).toContain("already approved");
    expect(standingLine(st)).not.toMatch(/waiting/i);
  });

  it("still says 'waiting' for the one state that was ever true of", () => {
    const st = standing([approvalClaim({ postable: false, checks: [check("REVIEWED", false)] })]);
    expect(st.state).toBe("nothing_ready");
    expect(standingLine(st)).toMatch(/waiting for/);
  });

  /**
   * THE PIN. The headline's state and the per-claim tick counts are literally
   * the same object, so a screen cannot print one from `standing()` and the
   * other from a filter of its own — which is how the two came to disagree.
   */
  it("reports the state and the tick counts from the same call", () => {
    const claims = [
      approvalClaim({ claimId: "c-1", postable: false, alreadyQueued: true }),
      approvalClaim({
        claimId: "c-2",
        postable: false,
        checks: [...ALL_PASS.slice(0, 3), check("LINES_PAIRED", false, "1 line unpaired")],
      }),
    ];
    const st = standing(claims);

    expect(st.state).toBe("nothing_ready");
    expect(st.claims.map((c) => c.standing)).toEqual(["approved", "not_ready"]);
    // Per-claim ticks add up to what each claim actually carries.
    for (const [i, row] of st.claims.entries()) {
      expect(row.passed + row.failed).toBe(claims[i].checks.length);
    }
    // And the condition roll-up is a transpose of the same walk.
    const paired = st.conditions.find((c) => c.code === "LINES_PAIRED");
    expect(paired?.passed).toBe(false);
    expect(paired?.failedClaims).toBe(1);
    expect(paired?.failedOn[0].claimId).toBe("c-2");
  });

  it("renders the approved sentence and a way forward, and no dead end", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({ claimId: "c-1", postable: false, alreadyQueued: true }),
        approvalClaim({ claimId: "c-2", postable: false, alreadyQueued: true }),
      ],
      postableCount: 0,
      withheldCount: 0,
      queuedCount: 2,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const line = await screen.findByTestId("approve-already-approved");
    expect(line.textContent).toContain("already approved");
    expect(line.textContent).not.toMatch(/waiting/i);
    expect(screen.queryByTestId("approve-nothing-postable")).toBeNull();
    // The forward path W-1 said was missing.
    expect(screen.getByTestId("approve-onward-post").getAttribute("href")).toBe(
      "/rcm/remittances/b-1",
    );
    /*
     * And no sentence about a moment that has already passed. Approving froze
     * these decisions; "go back and change something" would offer a change the
     * claim screens refuse (D-14).
     */
    expect(screen.queryByTestId("approve-last-moment")).toBeNull();
    expect(screen.queryByTestId("approve-go-back")).toBeNull();
    expect(screen.getByTestId("approve-back-to-check")).toBeTruthy();
  });

  it("keeps the blocked sentence, and no onward route, on a genuinely blocked check", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({ postable: false, checks: [check("REVIEWED", false, "nobody looked")] }),
      ],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const line = await screen.findByTestId("approve-nothing-postable");
    expect(line.textContent).toMatch(/waiting for/);
    expect(screen.queryByTestId("approve-onward-post")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 · ONE ARITHMETIC, TWO RENDERERS
// ═════════════════════════════════════════════════════════════════════════════

describe("the approve page's totals equal the rows it is showing", () => {
  it("sums to exactly what is on screen, read out of the DOM", async () => {
    const claims = [
      approvalClaim({
        claimId: "c-1",
        claimNumber: "53648",
        verdict: verdict({
          state: "amber",
          eobPatientCents: 48000,
          projectedPatientCents: 45000,
          decidedWriteOffCents: 3000,
          decisions: [
            {
              lineId: "pl-2",
              code: "D0274",
              amountCents: 3000,
              reason: "xrays_bitewings",
              reasonLabel: "X-rays — bitewings",
              decidedBy: "Dana Reviewer",
              decidedAt: "2026-03-04T21:00:00.000Z",
            },
          ],
        }),
      }),
      approvalClaim({
        claimId: "c-2",
        claimNumber: "53712",
        patientName: "Test, MangoTest",
        verdict: verdict({ eobPatientCents: 12000, projectedPatientCents: 12000 }),
      }),
    ];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims,
      postableCount: 2,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };
    state.detail = {
      office: "roland",
      remittance: remittance(),
      claims: [claim({ claimId: "c-1" }), claim({ claimId: "c-2" })],
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("approve-rollup-total");

    /*
     * THE ROWS ON SCREEN, not the fixture. If the page ever computed its footer
     * from anything but the rows it drew, this is the assertion that catches it.
     */
    let eob = 0;
    let projected = 0;
    let writeOff = 0;
    for (const c of claims) {
      const row = screen.getByTestId(`approve-rollup-row-${c.claimId}`);
      const tds = row.querySelectorAll("td");
      writeOff += cents(tds[2].textContent === "—" ? "0" : tds[2].textContent);
      eob += cents(tds[3].textContent);
      projected += cents(tds[4].textContent);
    }

    expect(cents(screen.getByTestId("approve-total-eob").textContent)).toBe(eob);
    expect(cents(screen.getByTestId("approve-total-projected").textContent)).toBe(projected);
    expect(cents(screen.getByTestId("approve-total-writeoff").textContent)).toBe(writeOff);

    // …and that IS the feature function's answer, not a coincidence of copy.
    const roll = rollUp(claims);
    expect(roll.eobPatientCents).toBe(eob);
    expect(roll.projectedPatientCents).toBe(projected);
    expect(roll.decidedWriteOffCents).toBe(writeOff);

    // The absorbed card says how many decisions she is about to accept.
    expect(within(screen.getByTestId("approve-decisions")).getByRole("heading").textContent).toBe(
      "The one line the office chose to absorb",
    );
    const row = screen.getByTestId("approve-decision-pl-2");
    expect(row.textContent).toContain("X-rays — bitewings");
    expect(row.textContent).toContain("Dana Reviewer");
  });

  it("lays the money on the left and the gate's conditions on the right (artboard I)", async () => {
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const columns = await screen.findByTestId("approve-columns");
    const [left, right] = Array.from(columns.children) as HTMLElement[];
    expect(within(left).getByTestId("approve-rollup")).toBeTruthy();
    expect(within(left).getByTestId("approve-decisions")).toBeTruthy();
    expect(within(right).getByTestId("approve-checks")).toBeTruthy();
    // The per-claim lists and the press stay full width, below both.
    expect(within(columns).queryByTestId("approve-claims")).toBeNull();
    expect(within(columns).queryByTestId("approve-decide")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// "What the app checked" — the gate's conditions and nothing else
// ═════════════════════════════════════════════════════════════════════════════

describe("the checklist is the gate's own conditions", () => {
  it("renders a row for every code the response carries and for no other", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({
          checks: [check("OFFICE_CONSISTENT", true), check("REVIEWED", false, "nobody looked")],
          postable: false,
        }),
      ],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const list = await screen.findByTestId("approve-conditions");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("approve-condition-OFFICE_CONSISTENT")).toBeTruthy();
    expect(screen.getByTestId("approve-condition-REVIEWED").dataset.passed).toBe("false");
    /*
     * The condition the gate did NOT send. A hardcoded checklist would have
     * asserted it — which on this page reads as a promise that it was checked.
     */
    expect(screen.queryByTestId("approve-condition-LINES_PAIRED")).toBeNull();
  });

  it("names who a failed condition failed on", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({ claimId: "c-1", checks: [check("REVIEWED", true)] }),
        approvalClaim({
          claimId: "c-2",
          claimNumber: "53712",
          patientName: "Test, MangoTest",
          postable: false,
          checks: [check("REVIEWED", false, "nobody looked")],
        }),
      ],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const who = await screen.findByTestId("approve-condition-who-REVIEWED");
    expect(who.textContent).toContain("1 of 2 claims");
    expect(who.textContent).toContain("Test, MangoTest #53712");
  });

  it("says nothing about Open Dental until a probe has actually landed", async () => {
    state.odHealth = null;
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("approve-checks");
    expect(screen.queryByTestId("approve-od-reachable")).toBeNull();
  });

  it("states the reachability it already holds, with when it was answered", async () => {
    state.odHealth = {
      status: "ok",
      lastCheckedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      lastTransitionAt: null,
      lastFailureKind: null,
    };
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const row = await screen.findByTestId("approve-od-reachable");
    expect(row.textContent).toContain("Open Dental is reachable");
    expect(row.textContent).toContain("answered 3m ago");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The primary action
// ═════════════════════════════════════════════════════════════════════════════

describe("the last press, and the way back from it", () => {
  it("asks the page's own question, and offers the other answer beside it", async () => {
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const button = await screen.findByTestId("approve-button");
    expect(button.textContent).toContain("Yes — this check is right");

    const back = screen.getByTestId("approve-go-back");
    expect(back.textContent).toContain("Go back and change something");
    expect(back.getAttribute("href")).toBe("/rcm/remittances/b-1");

    expect(screen.getByTestId("approve-last-moment").textContent).toBe(
      "This is the last moment anything can be changed. After it, the decisions are frozen and the check moves to Post.",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// W-5 · a takeback-only check
// ═════════════════════════════════════════════════════════════════════════════

describe("W-5 · a check whose every claim is a takeback", () => {
  it("knows one when it sees one, and refuses to call a mixed check one", () => {
    const reversal = claim({
      claimId: "c-2",
      totalPaidCents: -2900,
      needsReviewReasons: ["reversal_not_postable"],
    });
    expect(isTakebackClaim(reversal)).toBe(true);
    expect(isTakebackClaim(claim())).toBe(false);
    expect(isTakebackOnly([reversal])).toBe(true);
    expect(isTakebackOnly([reversal, claim()])).toBe(false);
    // An empty list is "we do not know yet", never "they are all takebacks".
    expect(isTakebackOnly([])).toBe(false);
  });

  it("renders one sentence and one route, and not the failure list", async () => {
    state.detail = {
      office: "roland",
      remittance: remittance({ totalAmountCents: -2900 }),
      claims: [
        claim({
          claimId: "c-1",
          totalPaidCents: -2900,
          needsReviewReasons: ["reversal_not_postable"],
        }),
      ],
    };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({
          postable: false,
          failed: ["NOT_RECOUPMENT"],
          checks: [check("NOT_RECOUPMENT", false, "the remittance moves -2900 cents")],
        }),
      ],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    const said = await screen.findByTestId("approve-takeback-line");
    expect(said.textContent).toContain("taking money back");

    expect(screen.getByTestId("approve-takeback-go").getAttribute("href")).toBe(
      "/rcm/remittances/b-1#takeback",
    );

    /* The wall that could never clear, and the button that could never work. */
    expect(screen.queryByTestId("approve-checks")).toBeNull();
    expect(screen.queryByTestId("approve-conditions")).toBeNull();
    expect(screen.queryByTestId("approve-button")).toBeNull();
  });

  it("keeps the failure list on a MIXED check, where it is the thing she needs", async () => {
    state.detail = {
      office: "roland",
      remittance: remittance(),
      claims: [
        claim({
          claimId: "c-1",
          totalPaidCents: -2900,
          needsReviewReasons: ["reversal_not_postable"],
        }),
        claim({ claimId: "c-2" }),
      ],
    };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({
          claimId: "c-1",
          postable: false,
          checks: [check("NOT_RECOUPMENT", false, "the remittance moves -2900 cents")],
        }),
        approvalClaim({ claimId: "c-2" }),
      ],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("approve-checks");
    expect(screen.queryByTestId("approve-takeback-only")).toBeNull();
    expect(screen.getByTestId("approve-button")).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The bench
// ═════════════════════════════════════════════════════════════════════════════

describe("the bench header", () => {
  it("saves the whole check for tomorrow, from the claim she is standing on", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const button = await screen.findByTestId("claim-park");
    expect(button.textContent).toContain("Save for tomorrow");

    fireEvent.click(button);
    await waitFor(() => expect(state.parked).toHaveLength(1));
    // The CHECK's id, not the claim's — parking is a fact about a check.
    expect(state.parked[0].batchId).toBe("b-1");
    await screen.findByTestId("claim-parked");
    expect(screen.queryByTestId("claim-park")).toBeNull();
  });

  it("says the server's own words when the save is refused, and stays offerable", async () => {
    state.parkFails = new Error("Saving a check needs review permission.");
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    fireEvent.click(await screen.findByTestId("claim-park"));
    const problem = await screen.findByTestId("claim-park-error");
    expect(problem.textContent).toContain("needs review permission");
    expect(screen.getByTestId("claim-park")).toBeTruthy();
  });

  it("offers nothing to save when the URL never said which check this is", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await screen.findByTestId("claim-workbench");
    expect(screen.queryByTestId("claim-park")).toBeNull();
  });
});

describe("a line with nothing left for the patient", () => {
  it("says the carrier paid it in full when the carrier paid", async () => {
    state.claim = claim({ lines: [line({ patientRemainderCents: 0, paidCents: 90000 })] });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const said = await screen.findByTestId("decision-none-pl-1");
    expect(said.textContent).toBe("Nothing to decide — the carrier paid it in full.");
  });

  it("does NOT say the carrier paid when the contract took all of it", async () => {
    state.claim = claim({ lines: [line({ patientRemainderCents: 0, paidCents: 0 })] });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const said = await screen.findByTestId("decision-none-pl-1");
    expect(said.textContent).toContain("leaves the patient owing nothing");
    expect(said.textContent).not.toContain("paid it in full");
  });
});

describe("an amber verdict carries the decision, as it was stored", () => {
  it("prints code, amount, reason and who decided it, with the instant", async () => {
    state.claim = claim({
      verdict: verdict({
        state: "amber",
        eobPatientCents: 48000,
        projectedPatientCents: 45000,
        decidedWriteOffCents: 3000,
        sentence: "Will owe $450.00 — $30.00 absorbed.",
        decisions: [
          {
            lineId: "pl-2",
            code: "D0274",
            amountCents: 3000,
            reason: "xrays_bitewings",
            reasonLabel: "X-rays — bitewings",
            decidedBy: "Dana Reviewer",
            decidedAt: "2026-03-04T21:00:00.000Z",
          },
        ],
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const chip = await screen.findByTestId("verdict-decision-pl-2");
    expect(chip.textContent).toContain("D0274");
    expect(chip.textContent).toContain("$30.00");
    expect(chip.textContent).toContain("X-rays — bitewings");
    expect(chip.textContent).toContain("decided by Dana Reviewer");
    // An instant, from the stored stamp — never "just now" or a re-derived one.
    expect(chip.textContent).toMatch(/decided by Dana Reviewer, .+/);
  });
});

describe("a red verdict, on the bench", () => {
  const RED = verdict({
    state: "red",
    sentence: "The patient's number cannot be trusted yet.",
    problems: [
      {
        kind: "od_fee_disagrees",
        code: "D2740",
        lineId: "pl-1",
        detail: "D2740 was billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
      },
    ],
  });

  it("turns the gate's first problem into one sentence naming the code", () => {
    const block = verdictBlock(RED);
    expect(block?.code).toBe("D2740");
    expect(block?.reason).toBe(
      "Can't say yes while the D2740 fee disagrees. Settle it in Open Dental and read the claim again.",
    );
    expect(block?.copyBar).toBe(
      "Until the two agree, anything this app promises about the patient's balance would be a guess.",
    );
    // Green and amber block nothing.
    expect(verdictBlock(verdict())).toBeNull();
    expect(verdictBlock(verdict({ state: "amber" }))).toBeNull();
  });

  it("does not claim 'the two disagree' about a problem that is not a disagreement", () => {
    const block = verdictBlock(
      verdict({
        state: "red",
        problems: [
          {
            kind: "decision_missing_reason",
            code: "D0274",
            lineId: "pl-2",
            detail: "D0274 is written off with nothing recorded about why",
          },
        ],
      }),
    );
    expect(block?.reason).toContain("nothing recorded about why");
    expect(block?.copyBar).toBeNull();
  });

  it("greys the approve verb with THAT code's reason, and only the approve verb", () => {
    const reason = verdictBlock(RED)!.reason;
    const reviewed = claim({ reviewedAt: "2026-03-03T16:00:00.000Z" }) as never;
    const blocked = claimFlow(reviewed, "b-1", reason);
    expect(blocked.cta?.step).toBe("review");
    expect(blocked.cta?.disabled).toBe(true);
    expect(blocked.cta?.reason).toBe(reason);

    /*
     * AN UNREAD CLAIM IS OFFERED "Mark checked over" — a verb a red verdict does
     * not block, and must not be seen to.
     */
    const unread = claim({ reviewedAt: null, reviewedBy: null }) as never;
    const still = claimFlow(unread, "b-1", reason);
    expect(still.cta?.label).toBe("Mark checked over");
    expect(still.cta?.disabled).toBe(false);
  });

  it("names the code on the banner, carries the copy bar, and flags the chart row", async () => {
    state.claim = claim({ verdict: RED });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");

    expect((await screen.findByTestId("verdict-blocking-code")).textContent).toContain("D2740");
    expect((await screen.findByTestId("verdict-copy-bar")).textContent).toBe(
      "Until the two agree, anything this app promises about the patient's balance would be a guess.",
    );

    // The Open Dental row the money argument is about, with the explanation.
    expect(screen.getByTestId("chart-line-533930").dataset.flagged).toBe("true");
    expect(screen.getByTestId("chart-line-why-533930").textContent).toContain(
      "billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
    );

    // And the greyed approve verb, with its reason beside it.
    const cta = screen.getByTestId("rcm-cta") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(screen.getByTestId("rcm-cta-reason").textContent).toContain(
      "Can't say yes while the D2740 fee disagrees",
    );
  });

  it("flags nothing in the rail when the verdict is not red", async () => {
    state.claim = claim();
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    await screen.findByTestId("chart-line-533930");
    expect(screen.getByTestId("chart-line-533930").dataset.flagged).toBeUndefined();
    expect(screen.queryByTestId("chart-line-why-533930")).toBeNull();
    expect(screen.queryByTestId("verdict-copy-bar")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// W-2 · one caption, once
// ═════════════════════════════════════════════════════════════════════════════

describe("W-2 · a CTA never prints its note twice", () => {
  it("does not repeat the note under itself when the note IS the disabled reason", async () => {
    /*
     * The reachable shape: a REVIEWED claim opened without `?from=`. There is no
     * check to link to and the page owns no approve verb, so the CTA falls back
     * to greyed-with-the-note — and used to print the note again one line below.
     */
    state.claim = claim({ reviewedAt: "2026-03-03T16:00:00.000Z" });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1");

    const cta = (await screen.findByTestId("rcm-cta")) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    const reason = screen.getByTestId("rcm-cta-reason").textContent ?? "";
    expect(reason).toContain("Approving happens on the check");
    expect(screen.queryByTestId("rcm-cta-note")).toBeNull();

    /*
     * Counted inside the CTA's own block. The review step's evidence line above
     * it ends with the same clause, deliberately — it is the rail saying where
     * approving happens, in the rail — and that is not the defect: W-2 is a
     * control printing its own caption twice, one line under itself.
     */
    const block = cta.parentElement as HTMLElement;
    const hits = (block.textContent ?? "").split(reason).length - 1;
    expect(hits).toBe(1);
  });

  it("still prints the note beside a CTA that works", async () => {
    state.claim = claim({ odMatchStatus: "not_run", odClaimNum: null, reviewedAt: null });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const note = await screen.findByTestId("rcm-cta-note");
    expect(note.textContent).toContain("Reads Open Dental");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D-6 · the typed field
// ═════════════════════════════════════════════════════════════════════════════

describe("the takeback's typed field", () => {
  const takebackChecklist = (matched: boolean) => ({
    office: "roland",
    batchId: "b-1",
    claims: [
      {
        claimId: "c-1",
        claimNumber: "53863",
        patientName: "Test, MangoTest",
        postable: matched,
        alreadyQueued: false,
        failed: matched ? [] : ["MATCH_CONFIRMED"],
        checks: [
          check("RECOUPMENT_CONFIRMED", true),
          check("MATCH_CONFIRMED", matched, matched ? "ClaimNum 53863" : "match is not_run"),
        ],
      },
    ],
    recoupmentClaims: 1,
    recoupmentTotalCents: -2900,
    typedTotalExpected: "-29.00",
    paths: ["adjustment", "supplemental"],
    defaultPath: "adjustment",
    balanced: true,
    differenceCents: 0,
    canApprove: true,
    approveRequires: "rcm.write",
  });

  function renderPanel() {
    render(
      <WouterRouter hook={memoryLocation({ path: "/rcm/remittances/b-1" }).hook}>
        <ThemeProvider defaultTheme="light" switchable>
          <RecoupmentPanel office="roland" batchId="b-1" claims={[]} />
        </ThemeProvider>
      </WouterRouter>,
    );
  }

  it("is dead, with its reason, until the takeback is matched", async () => {
    state.recoupment = takebackChecklist(false);
    renderPanel();

    const input = (await screen.findByTestId("recoupment-confirm-input")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const why = screen.getByTestId("recoupment-needs-match");
    expect(why.textContent).toContain("not linked to an Open Dental claim yet");
    expect(why.getAttribute("data-disabled-reason")).not.toBeNull();
  });

  it("is live once it is matched, and the confirmation is unchanged", async () => {
    state.recoupment = takebackChecklist(true);
    renderPanel();

    const input = (await screen.findByTestId("recoupment-confirm-input")) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.queryByTestId("recoupment-needs-match")).toBeNull();

    // THE THINGS THAT MUST NOT HAVE MOVED.
    expect(screen.getByTestId("recoupment-expected").textContent).toBe("-29.00");
    expect((screen.getByTestId("recoupment-path-adjustment") as HTMLInputElement).checked).toBe(
      true,
    );
    const button = screen.getByTestId("recoupment-approve-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("recoupment-awaiting-phrase")).toBeTruthy();

    fireEvent.change(input, { target: { value: "-29.00" } });
    await waitFor(() =>
      expect((screen.getByTestId("recoupment-approve-button") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("gates nothing at all when the response carries no takeback verdict to read", async () => {
    /*
     * An older shape, with no `RECOUPMENT_CONFIRMED` on it. A field greyed by a
     * fact we could not establish would be the honest-states rule broken in the
     * friendly direction, which is still broken.
     */
    const older = takebackChecklist(false);
    older.claims[0].checks = [check("MATCH_CONFIRMED", false, "match is not_run")];
    state.recoupment = older;
    renderPanel();

    const input = (await screen.findByTestId("recoupment-confirm-input")) as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §9 · a sentence never cuts itself off
// ═════════════════════════════════════════════════════════════════════════════

describe("sentence cells still wrap", () => {
  it("clips nothing on the verdict's copy bar", async () => {
    state.claim = claim({
      verdict: verdict({
        state: "red",
        problems: [
          {
            kind: "od_fee_disagrees",
            code: "D2740",
            lineId: "pl-1",
            detail: "D2740 was billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
          },
        ],
      }),
    });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const bar = await screen.findByTestId("verdict-copy-bar");

    const CLIPPING = /\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d+)\b/;
    for (let el: HTMLElement | null = bar; el; el = el.parentElement) {
      const cls = typeof el.className === "string" ? el.className : "";
      expect(cls, `${el.tagName}.${cls} clips the sentence`).not.toMatch(CLIPPING);
      if (el.dataset.testid === "claim-workbench") break;
    }
    expect(bar.getAttribute("title")).toBeNull();
    expect(within(bar).queryByRole("button")).toBeNull();
  });

  it("clips nothing on the flagged Open Dental row's explanation", async () => {
    state.claim = claim({
      verdict: verdict({
        state: "red",
        problems: [
          {
            kind: "od_fee_disagrees",
            code: "D2740",
            lineId: "pl-1",
            detail: "D2740 was billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
          },
        ],
      }),
    });
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    const why = await screen.findByTestId("chart-line-why-533930");

    const CLIPPING = /\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d+)\b/;
    for (let el: HTMLElement | null = why; el; el = el.parentElement) {
      const cls = typeof el.className === "string" ? el.className : "";
      expect(cls, `${el.tagName}.${cls} clips the sentence`).not.toMatch(CLIPPING);
      if (el.dataset.testid === "chart-panel") break;
    }
  });
});
