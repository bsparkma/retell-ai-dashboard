/**
 * Screenshot DUMPS for Stage C — the layout pass.
 *
 * Same shape and same reasons as `rcm-ux-shots.test.tsx` and
 * `rcm-workbench-shots.test.tsx`: renders each screen into jsdom with fixture
 * data that lives in this file and writes the markup to `tests/.shots/*.html`,
 * which `scripts/shoot-stage-c.mjs` wraps in the app's real built CSS and
 * photographs at 1280 and 1024 wide, light and dark.
 *
 * A layout that only holds at 1440 in light mode is not finished, which is the
 * whole reason this stage is reviewed at two widths and in two themes.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic — "Stedi Test 2" on PatNum 12827 is the module's own
 * roland fixture, chosen so a screenshot of the screens that write to charts
 * physically cannot contain a patient.
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

const CROWN = {
  lineId: "l-1",
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
  decision: null,
  decisionReason: null,
  decidedBy: null,
  decidedAt: null,
};

const XRAY = {
  ...CROWN,
  lineId: "l-2",
  position: 2,
  billedCode: "D0274",
  code: "D0274",
  description: "Bitewings - four radiographic images",
  billedCents: 8900,
  allowedCents: 6000,
  paidCents: 3000,
  adjustmentCents: 2900,
  patientRespCents: 3000,
  writeOffCents: 2900,
  odClaimProcNum: 533931,
  contractualWriteOffCents: 2900,
  patientRemainderCents: 3000,
  decision: "office_writeoff",
  decisionReason: "xrays_bitewings",
  decidedBy: "reviewer@carein.ai",
  decidedAt: "2026-03-04T21:00:00.000Z",
};

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Test 2, Stedi",
    odPatientId: 12827,
    odClaimNum: 53648,
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 128900,
    totalAllowedCents: 96000,
    totalPaidCents: 48000,
    totalDeductibleCents: 0,
    patientBalanceCents: 48000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 100,
    odMatchStatus: "confirmed",
    rejectedCandidates: 0,
    odMatchAt: "2026-03-05T15:00:00.000Z",
    odMatchConfirmedAt: "2026-03-05T15:01:00.000Z",
    odMatchedBy: "billing@carein.ai",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-03-05T14:00:00.000Z",
    lines: [CROWN, XRAY],
    ...over,
  };
}

function check(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 48000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 2,
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-05T14:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 48000,
      claimTotalCents: 48000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: [] as string[],
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
  };
}

const GREEN = {
  state: "green" as const,
  register: "projection" as const,
  eobPatientCents: 45000,
  projectedPatientCents: 45000,
  decidedWriteOffCents: 0,
  contractualWriteOffCents: 30000,
  decisions: [] as unknown[],
  problems: [] as unknown[],
  sentence: "Will owe $450.00 once this posts — the same as the EOB says.",
};

const AMBER = {
  state: "amber" as const,
  register: "projection" as const,
  eobPatientCents: 48000,
  projectedPatientCents: 45000,
  decidedWriteOffCents: 3000,
  contractualWriteOffCents: 32900,
  decisions: [
    {
      lineId: "l-2",
      code: "D0274",
      amountCents: 3000,
      reason: "xrays_bitewings",
      reasonLabel: "X-rays — bitewings",
      decidedBy: "reviewer@carein.ai",
      decidedAt: "2026-03-04T21:00:00.000Z",
    },
  ],
  problems: [] as unknown[],
  sentence:
    "Will owe $450.00 once this posts. The EOB says $480.00; this office decided to absorb $30.00.",
};

const RED = {
  state: "red" as const,
  register: "projection" as const,
  eobPatientCents: 45000,
  projectedPatientCents: 45000,
  decidedWriteOffCents: 0,
  contractualWriteOffCents: 30000,
  decisions: [] as unknown[],
  problems: [
    {
      kind: "od_fee_disagrees",
      code: "D2740",
      lineId: "l-1",
      detail: "D2740 was billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
    },
  ],
  sentence: "Open Dental's fee for D2740 doesn't match what the carrier says was billed.",
};

function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Test 2, Stedi",
    postable: true,
    alreadyQueued: false,
    checks: [
      {
        code: "MATCH_CONFIRMED",
        label: "Matched to an Open Dental claim",
        passed: true,
        detail: "ClaimNum 53648",
        fix: "Run the match and confirm one.",
      },
      {
        code: "REVIEWED",
        label: "Reviewed by a person",
        passed: true,
        detail: "reviewed 2026-03-05",
        fix: "Mark the claim reviewed, with a note.",
      },
      {
        code: "PATIENT_RESPONSIBILITY_MATCHES",
        label: "The patient's number matches the EOB",
        passed: true,
        detail: null,
        fix: "Fix the line the verdict names.",
      },
    ],
    failed: [] as string[],
    verdict: AMBER,
    ...over,
  };
}

/** A check whose claims are all approved — for the two posting shots. */
const APPROVED_PREVIEW = {
  office: "roland",
  batchId: "b-1",
  canApprove: true,
  approveRequires: "rcm.write",
  claims: [] as unknown[],
  postableCount: 0,
  withheldCount: 0,
  queuedCount: 1,
  balanced: true,
  differenceCents: 0,
};

const QUEUE = {
  office: "roland",
  rows: [] as unknown[],
  byStatus: {
    approved: 0,
    posting: 0,
    posted: 0,
    failed: 0,
    partially_posted: 0,
    blocked: 0,
    withdrawn: 0,
  },
  total: 0,
  limit: 200,
  offset: 0,
  canDrain: true,
  drainRequires: "rcm.post",
  postingEnabled: true,
  drainEnabled: true,
};

function plan(over: Record<string, unknown> = {}) {
  return {
    office: "roland",
    plan: {
      queueId: "q-1",
      office: "roland",
      batchId: "b-1",
      status: "posted",
      statusLabel: "posted",
      blockedReason: null,
      withdrawnReason: null,
      withdrawnNote: null,
      withdrawnAt: null,
      step: null,
      isRecoupment: false,
      documentAttachStatus: "none",
      carrierEobDate: "2026-03-01",
      intendedTotalCents: 48000,
      postedTotalCents: 48000,
      odClaimPaymentNum: 21436,
      reconciledAt: "2026-03-05T18:58:00.000Z",
      approvedAt: "2026-03-05T18:50:00.000Z",
      approvedBy: "Billing User",
      startedAt: "2026-03-05T18:57:00.000Z",
      finishedAt: "2026-03-05T18:58:00.000Z",
      drainAttemptAt: "2026-03-05T18:57:00.000Z",
      drainedBy: "Billing User",
      attemptCount: 1,
      lastError: null,
      checkNumber: "830200001",
      payer: "SYNTHETIC DENTAL",
      ...((over.plan as Record<string, unknown>) || {}),
    },
    lines: [
      {
        queueLineId: "ql-1",
        position: 1,
        odClaimNum: 53648,
        odClaimProcNum: 533930,
        status: "paid",
        skipReason: null,
        intendedInsPayAmtCents: 45000,
        intendedWriteOffCents: 30000,
        intendedDedAppliedCents: 0,
        isSupplemental: false,
        recoupmentPath: null,
        odAdjustmentNum: null,
        odSupplementalClaimProcNum: null,
        claimprocWrittenAt: "2026-03-05T18:57:10.000Z",
        claimReceivedAt: "2026-03-05T18:57:20.000Z",
        paidAt: "2026-03-05T18:57:30.000Z",
        odClaimPaymentNum: 21436,
        readback: null,
        readbackAt: null,
        lastError: null,
        decidedWriteOffCents: null,
        decidedReason: null,
        decidedBy: null,
        intendedPatientCents: 45000,
        odWriteoffAdjustmentNum: null,
      },
      {
        queueLineId: "ql-2",
        position: 2,
        odClaimNum: 53648,
        odClaimProcNum: 533931,
        status: "paid",
        skipReason: null,
        intendedInsPayAmtCents: 3000,
        intendedWriteOffCents: 2900,
        intendedDedAppliedCents: 0,
        isSupplemental: false,
        recoupmentPath: null,
        odAdjustmentNum: null,
        odSupplementalClaimProcNum: null,
        claimprocWrittenAt: "2026-03-05T18:57:40.000Z",
        claimReceivedAt: "2026-03-05T18:57:50.000Z",
        paidAt: "2026-03-05T18:57:55.000Z",
        odClaimPaymentNum: 21436,
        readback: null,
        readbackAt: null,
        lastError: null,
        decidedWriteOffCents: 3000,
        decidedReason: "X-rays — bitewings",
        decidedBy: "reviewer@carein.ai",
        intendedPatientCents: 0,
        odWriteoffAdjustmentNum: null,
      },
    ],
    claims: [
      { claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", odClaimNum: 53648 },
    ],
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
    documentAttach: {
      implemented: true,
      status: "none",
      error: null,
      at: null,
      documents: [],
      canRetry: true,
      retryRequires: "rcm.post",
    },
    /*
     * `plan` is MERGED above and must not be re-spread here: `...over` would
     * replace the merged object with the caller's partial one, dropping the
     * payment number and every other default. That is exactly what happened
     * the first time these shots were taken, and the picture said
     * "check #not recorded".
     */
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "plan")),
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  approval: null as Record<string, unknown> | null,
  queue: null as Record<string, unknown> | null,
  plan: null as Record<string, unknown> | null,
  era: [] as Record<string, unknown>[],
  eob: [] as Record<string, unknown>[],
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
    listRemittances: vi.fn(async (office: string, opts: Record<string, unknown> = {}) => {
      const all = state.checks;
      const live = all.filter((r) => r.setAsideAt == null);
      const view = (opts.view as string) ?? "all";
      const selected = view === "attention" ? live.filter((r) => r.needsAttention) : all;
      return {
        office,
        view,
        remittances: selected,
        total: all.length,
        needsAttentionCount: live.filter((r) => r.needsAttention).length,
        parkedCount: live.filter((r) => r.parkedAt != null).length,
        setAsideCount: all.filter((r) => r.setAsideAt != null).length,
        matchingCount: selected.length,
        limit: 50,
        offset: 0,
      };
    }),
    getRemittance: vi.fn(async (office: string, batchId: string) => {
      const row = state.checks.find((r) => r.batchId === batchId);
      if (!row) throw new real.RcmApiError("no such check", 404, "REMITTANCE_NOT_FOUND");
      return {
        office,
        remittance: { ...row, plbAdjustments: [], plans: state.plan ? [{ queueId: "q-1", status: "posted" }] : [] },
        claims: state.claims,
      };
    }),
    getApprovalPreview: vi.fn(async () => {
      if (!state.approval) throw new real.RcmApiError("no gate", 500, "OOPS");
      return state.approval;
    }),
    listPostingQueue: vi.fn(async () => state.queue ?? QUEUE),
    getPostingPlan: vi.fn(async () => {
      if (!state.plan) throw new real.RcmApiError("none", 404, "QUEUE_NOT_FOUND");
      return state.plan;
    }),
    getRecoupmentChecklist: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    unparkRemittance: vi.fn(async () => ({ batchId: "b-1", parked: false, wasParked: false })),
    matchRemittance: vi.fn(async () => ({ matched: [] })),
    listEraUploads: vi.fn(async (office: string) => ({
      office,
      uploads: state.era,
      total: state.era.length,
      limit: 25,
      offset: 0,
    })),
    listEobUploads: vi.fn(async (office: string) => ({
      office,
      uploads: state.eob,
      total: state.eob.length,
      limit: 25,
      offset: 0,
      extraction: {
        paused: false,
        usedCents: 0,
        capCents: 500,
        remainingCents: 500,
        resetsAt: "2026-03-06T06:00:00.000Z",
        timezone: "America/Chicago",
        persisted: true,
      },
    })),
  };
});

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
  state.checks = [];
  state.claims = [];
  state.approval = null;
  state.queue = null;
  state.plan = null;
  state.era = [];
  state.eob = [];
});

afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("Stage C screenshots", () => {
  it("stagec-01-today — the three questions, answered in sentences", async () => {
    state.checks = [
      check({
        parkedAt: "2026-03-05T22:55:00.000Z",
        parkedBy: "Billing User",
        parkedNote: "Waiting on the carrier to resend the missing page",
      }),
      check({
        batchId: "b-2",
        checkNumber: "830200002",
        payer: "SYNTHETIC HEALTH PLAN",
        totalAmountCents: 128460,
        claimCount: 9,
        unmatchedClaimCount: 2,
        createdAt: "2026-03-05T16:00:00.000Z",
      }),
      check({
        batchId: "b-3",
        checkNumber: "830200003",
        payer: "SYNTHETIC DENTAL",
        totalAmountCents: -5408,
        claimCount: 1,
        createdAt: "2026-03-05T15:00:00.000Z",
      }),
    ];
    state.claims = [claim({ claimId: "c-1", patientName: "Test 2, Stedi" })];

    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");
    await screen.findByTestId("rcm-left-off-roland");
    await waitFor(() => expect(screen.getByTestId("rcm-pick-up-b-1")).toBeTruthy());
    dump("stagec-01-today");
  });

  it("stagec-02-bring-in — six sources, three of them not yet", async () => {
    /*
     * The upload stamps are RELATIVE, because "Brought in recently" is a
     * seven-practice-day window and a frozen 2026-03 date would fall out of it
     * whenever these shots are re-taken. Everything else here stays fixed, so
     * the pictures are stable.
     */
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
    state.era = [
      {
        uploadId: "u-1",
        filename: "synthetic-835-2026-03-05.txt",
        fileHash: "abc",
        fileSizeBytes: 4096,
        contentType: "text/plain",
        status: "processed",
        uploadedAt: hoursAgo(3),
        processedAt: hoursAgo(3),
        remittances: [
          {
            batchId: "b-1",
            checkNumber: "830200001",
            eftNumber: null,
            traceNumber: "830200001",
            paymentMethod: "check",
            payer: "SYNTHETIC DENTAL",
            paymentDate: "2026-03-02",
            totalAmountCents: 48000,
            plbTotalCents: 0,
            claimCount: 2,
            status: "ready",
            notes: "",
            remittanceKey: "k-1",
            dedupeStatus: null,
          },
        ],
      },
    ];
    state.eob = [
      {
        uploadId: "u-2",
        officeId: "roland",
        filename: "synthetic-eob-scan.pdf",
        fileSizeBytes: 220000,
        status: "processed",
        message: null,
        resultClaimId: null,
        resultBatchId: "b-2",
        uploadedAt: hoursAgo(26),
        processedAt: hoursAgo(26),
      },
    ];

    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderAt(<BringIn />, "/rcm/bring-in");
    await screen.findByTestId("bring-in-tiles");
    await waitFor(() => expect(screen.getByTestId("bring-in-recent-row-era-u-1-b-1")).toBeTruthy());
    dump("stagec-02-bring-in");
  });

  it("stagec-03-checks-waiting-on — whose move it is, per row", async () => {
    state.checks = [
      check(),
      check({
        batchId: "b-2",
        checkNumber: "830200002",
        payer: "SYNTHETIC HEALTH PLAN",
        totalAmountCents: 128460,
        claimCount: 9,
        unmatchedClaimCount: 2,
      }),
      check({
        batchId: "b-3",
        checkNumber: "830200003",
        totalAmountCents: -5408,
        claimCount: 1,
        attentionReasons: ["claims_withheld"],
      }),
      check({
        batchId: "b-4",
        checkNumber: "830200004",
        payer: "SYNTHETIC PPO",
        attentionReasons: ["claims_awaiting_approval"],
        claimCount: 3,
      }),
    ];

    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");
    await waitFor(() => expect(screen.getByTestId("remittance-waiting-b-1")).toBeTruthy());
    dump("stagec-03-checks-waiting-on");
  });

  it("stagec-04-check-triage — where the patient stands, per claim", async () => {
    state.checks = [check()];
    state.claims = [
      claim(),
      claim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest", reviewedAt: "2026-03-05T16:00:00.000Z" }),
    ];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim(), approvalClaim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest", verdict: RED, postable: false })],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("claim-stands-c-1").textContent).toBe(AMBER.sentence));
    dump("stagec-04-check-triage");
  });

  it("stagec-05-approve — before you say yes", async () => {
    state.checks = [check()];
    state.claims = [claim(), claim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest" })];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim(),
        approvalClaim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest", verdict: GREEN }),
      ],
      postableCount: 2,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const ApproveCheck = (await import("@/pages/rcm/ApproveCheck")).default;
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");
    await screen.findByTestId("rcm-approve-check");
    await waitFor(() => expect(screen.getByTestId("approve-rollup-total")).toBeTruthy());
    dump("stagec-05-approve");
  });

  it("stagec-06-set-aside — the anchored panel over a visible claim list", async () => {
    state.checks = [check()];
    state.claims = [claim(), claim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest" })];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    fireEvent.click(await screen.findByTestId("check-set-aside"));
    await screen.findByTestId("check-set-aside-dialog");
    dump("stagec-06-set-aside");
  });

  it("stagec-07-posted — what landed in Open Dental", async () => {
    state.checks = [check()];
    state.claims = [claim({ reviewedAt: "2026-03-05T16:00:00.000Z", postingQueueId: "q-1" })];
    state.approval = APPROVED_PREVIEW;
    state.plan = plan();

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("posted-landed")).toBeTruthy());
    dump("stagec-07-posted");
  });

  it("stagec-08-stuck — the payment landed, and one figure did not", async () => {
    state.checks = [check()];
    state.claims = [claim({ reviewedAt: "2026-03-05T16:00:00.000Z", postingQueueId: "q-1" })];
    state.approval = APPROVED_PREVIEW;
    state.plan = plan({
      plan: {
        status: "partially_posted",
        statusLabel: "partially_posted",
        reconciledAt: null,
        lastError:
          "Open Dental says the patient owes $60.00 on D0274 — this check said $0.00.",
      },
    });

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("stuck-money-landed")).toBeTruthy());
    dump("stagec-08-stuck");
  });

  it("stagec-09-shadow — what this app would have done", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.queue = { ...QUEUE, postingEnabled: true, drainEnabled: false };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        approvalClaim(),
        approvalClaim({ claimId: "c-2", claimNumber: "53712", patientName: "Test, MangoTest", verdict: GREEN }),
      ],
      postableCount: 2,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("shadow-would-have-done")).toBeTruthy());
    dump("stagec-09-shadow");
  });

  it("stagec-10-today-empty — everything done for tonight", async () => {
    state.checks = [
      check({
        setAsideAt: "2026-03-05T23:00:00.000Z",
        setAsideBy: "Billing User",
        setAsideReason: "sent_in_error",
        needsAttention: false,
      }),
    ];

    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");
    await screen.findByTestId("rcm-arrivals-all-done-roland");
    dump("stagec-10-today-empty");
  });
});
