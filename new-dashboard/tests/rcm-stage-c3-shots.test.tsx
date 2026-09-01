/**
 * Screenshot DUMPS for Stage C-3.
 *
 * Same shape and same reasons as `rcm-stage-c-shots.test.tsx`: renders each
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/*.html`, which `scripts/shoot-stage-c3.mjs` wraps in
 * the app's real built CSS and photographs at 1280 wide, light and dark.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIVE SHOTS, AND WHAT EACH ONE IS EVIDENCE FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *   c3-01-claim-pre-link    the leader open, the rest folded to lines
 *   c3-02-claim-linked      the LINKED one open, the leader folded — the state
 *                           change that used to be invisible
 *   c3-03-banner-red        the fixed banner: a red verdict, in red, above the
 *                           fold, on the check that produced it
 *   c3-04-approve-not-ready one not-ready claim: its failure, and one line for
 *                           the twelve that passed
 *   c3-05-dead-end          the office named loudly, and the wrong-office answer
 *
 * The claim and check numbers below are the reseeded staging fixtures' — 53862
 * on the MetLife check (R2) and 53864 on the Cigna one (R4) — so a picture can
 * be held beside the screen it is a picture of. The PATIENTS are the module's
 * own synthetic fixtures.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of
 * fixture data in this file, so a screenshot physically cannot contain a real
 * patient.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const OUT = resolve(import.meta.dirname, ".shots");

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

/** The $480 line from R2 — contractual write-off taken, remainder to decide. */
const CROWN = {
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
  adjustments: [
    {
      adjustmentId: "adj-1",
      amountCents: 30000,
      quantity: 1,
      groupCode: "CO",
      groupLabel: "Contractual",
      groupDescription: "Contractual obligation — the practice writes this off",
      reasonCode: "45",
      reasonDescription: "Charge exceeds fee schedule/maximum allowable",
      remarkCode: null,
      remarkDescription: null,
    },
  ],
  contractualWriteOffCents: 30000,
  patientRemainderCents: 48000,
  decision: null,
  decisionReason: null,
  decidedBy: null,
  decidedAt: null,
};

/** The contractual-only line beside it: nothing left for the patient. */
const EXAM = {
  ...CROWN,
  lineId: "pl-2",
  position: 2,
  billedCode: "D0150",
  code: "D0150",
  description: "Comprehensive oral evaluation",
  billedCents: 21000,
  allowedCents: 15000,
  paidCents: 15000,
  adjustmentCents: 6000,
  patientRespCents: 0,
  writeOffCents: 6000,
  adjustments: [] as unknown[],
  contractualWriteOffCents: 6000,
  patientRemainderCents: 0,
};

function verdict(over: Record<string, unknown> = {}) {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 48000,
    projectedPatientCents: 48000,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 36000,
    decisions: [] as unknown[],
    problems: [] as unknown[],
    sentence: "Will owe $480.00 once this posts — the same as the EOB says.",
    ...over,
  };
}

/** The RED verdict the banner used to print in green. */
const RED = verdict({
  state: "red",
  problems: [
    {
      kind: "line_not_in_chart",
      code: "D2740",
      lineId: "pl-1",
      detail: "D2740 is not on the Open Dental claim this is linked to.",
    },
  ],
  sentence:
    "Patient's number can't be trusted yet — something on this claim does not line up with Open Dental. Look at D2740.",
});

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
      {
        field: "dob",
        label: "Date of birth",
        eob: "1990-01-01",
        od: "1990-01-01",
        status: "agrees",
        blocking: false,
      },
      {
        field: "subscriber",
        label: "Subscriber ID",
        eob: "ABC123456",
        od: "ABC123456",
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
    checkNumber: "RS-889021",
    patientName: "Test 2, Stedi",
    odPatientId: null,
    odClaimNum: null,
    payer: "METLIFE DENTAL",
    serviceDate: "2026-03-02",
    receivedDate: "2026-03-02",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "primary",
    totalBilledCents: 141000,
    totalAllowedCents: 105000,
    totalPaidCents: 57000,
    totalDeductibleCents: 0,
    patientBalanceCents: 48000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 100,
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
    lines: [CROWN, EXAM],
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
      {
        tag: "DATE_NEAR",
        weight: 20,
        label: "Service date matches",
        detail: "Same date of service.",
      },
      {
        tag: "AMOUNT_NEAR",
        weight: 15,
        label: "Billed total agrees",
        detail: "Within $1.00 of the chart.",
      },
    ],
    blockers: [] as unknown[],
    od: {
      claimStatus: "S",
      dateService: "2026-03-02",
      claimHeaderFeeCents: 141000,
      billedCents: 141000,
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
        odClaimProcNum: 535780,
        odCode: "D2740",
        billedDeltaCents: 0,
        reason: null,
      },
      {
        lineId: "pl-2",
        position: 2,
        code: "D0150",
        odClaimProcNum: 535781,
        odCode: "D0150",
        billedDeltaCents: 0,
        reason: null,
      },
    ],
    ...over,
  };
}

/** The runner-up: same patient, an earlier visit, less money. */
const RUNNER_UP = candidate({
  odClaimNum: 53712,
  score: 62,
  confidence: "MEDIUM",
  evidence: [
    {
      tag: "PATIENT_MATCH",
      weight: 30,
      label: "Same patient",
      detail: "Name and birthday agree.",
    },
    {
      tag: "DATE_FAR",
      weight: -12,
      label: "Service date differs",
      detail: "Six weeks earlier than the remittance.",
      note: "42d",
    },
  ],
  od: {
    ...candidate().od,
    dateService: "2026-01-19",
    billedCents: 86000,
    claimHeaderFeeCents: 86000,
  },
});

function snapshot(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    fetchedAt: "2026-09-01T20:15:00.000Z",
    office: "roland",
    officeName: "Valley — Fort Smith",
    odCalls: 9,
    truncated: false,
    notes: [] as string[],
    patientsConsidered: [{ patNum: 12827, name: "Test 2, Stedi" }],
    ambiguous: false,
    margin: 33,
    rejectedCandidates: 0,
    rejectedReasons: { nameMismatch: 0, belowScore: 0 },
    minScore: 15,
    nameRuleApplied: true,
    candidates: [candidate(), RUNNER_UP],
    confirmed: null,
    supersededConfirmation: null,
    ...over,
  };
}

/** The thirteen gate conditions, `failing` of them not passed. */
function checks(failing: number) {
  const rows: { code: string; label: string; fix: string }[] = [
    {
      code: "MATCH_CONFIRMED",
      label: "Matched to an Open Dental claim",
      fix: "Open the claim, run the match, and confirm the right one.",
    },
    { code: "REVIEWED", label: "Checked over by a person", fix: "Mark the claim checked over." },
    {
      code: "PATIENT_RESPONSIBILITY_MATCHES",
      label: "The patient's number matches the EOB",
      fix: "Fix the line the verdict names.",
    },
    { code: "NOT_REVERSAL", label: "Not a takeback", fix: "Follow the takeback procedure." },
    { code: "NOT_RECOUPMENT", label: "Not a recovery", fix: "Follow the takeback procedure." },
    { code: "CLAIM_IN_CHART", label: "The claim is still in the chart", fix: "Run the match again." },
    { code: "FEES_AGREE", label: "The fees agree with Open Dental", fix: "Fix the fee in the chart." },
    { code: "NO_BLOCKING_FLAGS", label: "Nothing on the check is held", fix: "Clear the flag." },
    { code: "OFFICE_ENABLED", label: "This office can post", fix: "Ask an administrator." },
    { code: "BALANCED", label: "The check balances", fix: "Find the missing money." },
    { code: "NOT_ALREADY_POSTED", label: "Not already posted", fix: "Nothing to do." },
    { code: "IDENTITY_AGREES", label: "It is the same person", fix: "Run the match again." },
    {
      code: "WRITEOFF_TYPE_RESOLVES",
      label: "The write-off type exists in this office",
      fix: "Ask an administrator to set the name.",
    },
  ];
  return rows.map((r, i) => ({
    code: r.code,
    label: r.label,
    passed: i >= failing,
    detail: i >= failing ? "as expected" : null,
    fix: r.fix,
  }));
}

function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53862",
    patientName: "Test 2, Stedi",
    postable: true,
    alreadyQueued: false,
    failed: [] as string[],
    checks: checks(0),
    verdict: verdict(),
    ...over,
  };
}

function remittance(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "METLIFE DENTAL",
    checkNumber: "RS-889021",
    eftNumber: null,
    traceNumber: "RS-889021",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 57000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 2,
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 57000,
      claimTotalCents: 57000,
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
  decisionVerdict: null as unknown,
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => ({ status: "loading" }) };
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
    confirmClaimMatch: vi.fn(async (_o: string, claimId: string, odClaimNum: number) => ({
      claimId,
      odClaimNum,
      confirmedAt: "2026-09-01T20:16:00.000Z",
    })),
    reviewClaim: vi.fn(async (_o: string, claimId: string) => ({ claimId })),
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
        lines: [CROWN, EXAM],
      }),
    ),
  };
});

import ClaimMatch from "@/pages/rcm/ClaimMatch";
import ApproveCheck from "@/pages/rcm/ApproveCheck";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(node: React.ReactElement, path: string) {
  const [pathname, search = ""] = path.split("?");
  const memory = memoryLocation({ path: pathname, searchPath: search, record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{node}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.claim = null;
  state.approval = null;
  state.decisionVerdict = null;
});

afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("Stage C-3 screenshots", () => {
  it("c3-01-claim-pre-link — the leader open, the rest a line", async () => {
    state.claim = claim({ odMatchStatus: "candidates", matchSnapshot: snapshot() });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1?from=b-1");
    await screen.findByTestId("rcm-claim-match");
    await waitFor(() => expect(screen.getByTestId("candidate-row-53712")).toBeTruthy());
    dump("c3-01-claim-pre-link");
  });

  it("c3-02-claim-linked — the linked one open, the leader folded", async () => {
    state.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53712,
      odPatientId: 12827,
      odMatchConfirmedAt: "2026-09-01T20:16:00.000Z",
      odMatchedBy: "Beau Sparkman",
      matchSnapshot: snapshot(),
      chart: {
        odClaimNum: 53712,
        claimStatus: "Sent",
        billedCents: 86000,
        insPaidCents: 0,
        fetchedAt: "2026-09-01T20:15:00.000Z",
        lines: [
          {
            odClaimProcNum: 535780,
            code: "D2740",
            status: "Received",
            feeBilledCents: 120000,
            insEstCents: null,
            insPayAmtCents: 0,
          },
        ],
      },
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1?from=b-1");
    await screen.findByTestId("rcm-claim-match");
    await waitFor(() => expect(screen.getByTestId("candidate-row-53862")).toBeTruthy());
    dump("c3-02-claim-linked");
  });

  it("c3-03-banner-red — a red verdict, in red, above the fold", async () => {
    /*
     * THE FIX, PHOTOGRAPHED. Recording the $480 write-off on this claim returns
     * a RED verdict, and the banner used to print that sentence in green with a
     * tick. The shot also catches the item-4 caution on the line above it: this
     * claim is not linked, and the decision says so without blocking.
     */
    /*
     * The claim's OWN verdict is red too, because the reload the screen does
     * after a decision fetches it back. A fixture that left the stored verdict
     * green would photograph a screen contradicting itself — a red banner over
     * a green verdict line — which is not a state the server can produce.
     */
    state.claim = claim({
      odMatchStatus: "candidates",
      matchSnapshot: snapshot(),
      verdict: RED,
    });
    state.decisionVerdict = RED;

    renderAt(<ClaimMatch />, "/rcm/claims/c-1?from=b-1");
    fireEvent.click(await screen.findByTestId("write-off-pl-1"));
    fireEvent.click(await screen.findByTestId("reason-not_chargeable-pl-1"));
    await waitFor(() =>
      expect(screen.getByTestId("claim-notice").getAttribute("data-tone")).toBe("bad"),
    );
    dump("c3-03-banner-red");
  });

  it("c3-04-approve-not-ready — the failure, and a line for the twelve", async () => {
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim({
          postable: false,
          failed: ["MATCH_CONFIRMED"],
          checks: checks(1),
        }),
        approvalClaim({
          claimId: "c-2",
          claimNumber: "53863",
          patientName: "Test, MangoTest",
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
    await waitFor(() => expect(screen.getByTestId("approval-passed-toggle-c-1")).toBeTruthy());
    dump("c3-04-approve-not-ready");
  });

  it("c3-05-dead-end — R4, with the office named and the wrong-office answer", async () => {
    state.claim = claim({
      claimNumber: "53864",
      payer: "CIGNA DENTAL",
      checkNumber: "RS-330416",
      odMatchStatus: "no_candidate",
      odMatchAt: "2026-09-01T20:15:00.000Z",
      matchSnapshot: snapshot({
        candidates: [],
        patientsConsidered: [] as unknown[],
        odCalls: 2,
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1?from=b-1");
    await screen.findByTestId("match-guidance-dead-end");
    await waitFor(() => expect(screen.getByTestId("match-guidance-wrong-office")).toBeTruthy());
    dump("c3-05-dead-end");
  });
});
