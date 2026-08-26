/**
 * Screenshot DUMPS for the RCM UX slice — the before/after pairs for §15.2.
 *
 * Same shape and same reasons as `rcm-workbench-shots.test.tsx`: renders each
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/*.html`, which `scripts/shoot-rcm-ux.mjs` wraps in
 * the app's real built CSS and photographs at 1280 and 1024 wide, light and
 * dark.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic — "Stedi Test 2" on PatNum 12827 is the module's
 * own fixture, chosen so a screenshot of the screens that write to charts
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

const LINE = {
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
};

const baseClaim = {
  claimId: "c-1",
  officeId: "roland",
  claimNumber: "CLM-88120",
  checkNumber: "830200001",
  patientName: "Stedi Test 2",
  odPatientId: 12827,
  odClaimNum: null as number | null,
  payer: "SYNTHETIC DENTAL OF ARKANSAS",
  serviceDate: "2026-03-01",
  receivedDate: "2026-03-05",
  status: "pending_review",
  paymentStatus: "paid",
  insuranceType: "primary",
  totalBilledCents: 120000,
  totalAllowedCents: 90000,
  totalPaidCents: 45000,
  totalDeductibleCents: 0,
  patientBalanceCents: 45000,
  needsReviewReasons: [] as string[],
  extractionConfidence: 1,
  odMatchStatus: "not_run" as string,
  rejectedCandidates: 0,
  odMatchAt: null as string | null,
  odMatchConfirmedAt: null as string | null,
  odMatchedBy: null as string | null,
  reviewedAt: null as string | null,
  reviewedBy: null as string | null,
  reviewNote: null as string | null,
  postingQueueId: null as string | null,
  approvedAt: null as string | null,
  createdAt: "2026-03-05T12:00:00.000Z",
  lines: [LINE],
  provenance: null as unknown,
  matchSnapshotStale: false,
};

const claim = (over: Partial<typeof baseClaim> = {}) => ({ ...baseClaim, ...over });

const baseRemittance = {
  batchId: "b-1",
  officeId: "roland",
  payer: "SYNTHETIC DENTAL OF ARKANSAS",
  checkNumber: "830200001",
  eftNumber: null,
  traceNumber: null,
  paymentMethod: "check",
  depositDate: "2026-03-04",
  totalAmountCents: 45000,
  postedAmountCents: 0,
  plbTotalCents: 0,
  claimCount: 1,
  status: "ready",
  source: "835",
  flags: [] as string[],
  notes: "",
  createdAt: "2026-03-05T12:00:00.000Z",
  createdBy: null,
  balance: {
    batchTotalCents: 45000,
    claimTotalCents: 45000,
    differenceCents: 0,
    plbTotalCents: 0,
    balanced: true,
  },
  needsAttention: true,
  attentionReasons: ["claims_unreviewed"] as string[],
  attentionObservations: ["claims_unmatched"] as string[],
  reviewReasonCount: 0,
  unmatchedClaimCount: 1,
  queuedClaimCount: 0,
  approvalAttemptedAt: null as string | null,
  approvalAttemptedBy: null as string | null,
  upload: null as unknown,
  plbAdjustments: [] as unknown[],
};

const remit = (over: Partial<typeof baseRemittance> = {}) => ({ ...baseRemittance, ...over });

const candidate = (odClaimNum: number, score: number, confidence: string) => ({
  odClaimNum,
  odPatNum: 12827,
  score,
  confidence,
  evidence: [
    { tag: "patient", weight: 40, label: "Same patient", detail: "PatNum 12827", note: undefined },
    { tag: "amount", weight: 30, label: "Amount within tolerance", detail: "$1,200.00 billed" },
  ],
  blockers: [] as unknown[],
  od: {
    patientName: "Stedi Test 2",
    dateService: "2026-03-01",
    claimStatus: "Sent",
    billedCents: 120000,
    unknownDeletedLineCount: 0,
  },
  linePairs: [
    { lineId: "l-1", position: 1, code: "D2740", odClaimProcNum: 533930, odCode: "D2740", billedDeltaCents: 0, reason: null },
  ],
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  version: 3,
  fetchedAt: "2026-03-06T15:00:00.000Z",
  office: "roland",
  officeName: "Roland Family Dental",
  odCalls: 6,
  truncated: false,
  notes: [] as string[],
  patientsConsidered: [{ patNum: 12827, name: "Stedi Test 2" }],
  ambiguous: false,
  margin: 25,
  rejectedCandidates: 0,
  rejectedReasons: { nameMismatch: 0, belowScore: 0 },
  minScore: 40,
  nameRuleApplied: true,
  candidates: [candidate(53784, 92, "HIGH"), candidate(53785, 67, "MEDIUM")],
  confirmed: null as unknown,
  supersededConfirmation: null,
  ...over,
});

const check = (
  code: string,
  label: string,
  passed: boolean,
  detail: string | null,
  fix: string,
) => ({ code, label, passed, detail, fix });

/** The gate's own strings, including the detail it sends on a PASS. */
const CHECKS_FRESH = [
  check("OFFICE_CONSISTENT", "Belongs to this office", true, null, "…"),
  check(
    "MATCH_CONFIRMED",
    "Matched to an Open Dental claim",
    false,
    "match is not_run",
    "Open the claim, run the match, and confirm the right one. Posting needs a ClaimNum, and nothing may choose it but a person.",
  ),
  check(
    "SNAPSHOT_CURRENT",
    "The match record is current and complete",
    false,
    "no match record stored",
    "The stored match was recorded in an older format or against another office. Run the match again and re-confirm it.",
  ),
  check(
    "REVIEWED",
    "Reviewed by a person",
    false,
    "nobody has dispositioned this claim",
    'Mark the claim reviewed, with a note. A biller saying "looked, nothing to do" is the record that the work happened.',
  ),
  check("NOT_REVERSAL", "Not a reversal or takeback", true, null, "…"),
  check("NOT_RECOUPMENT", "Not a recoupment", true, null, "…"),
  check("NOT_PATIENT_RESPONSIBILITY_ONLY", "The carrier actually paid something", true, null, "…"),
  check("NO_BLOCKING_REASON", "No blocking review reason", true, null, "…"),
  check(
    "NO_BLOCKING_PREFLIGHT",
    "Open Dental will accept the write",
    false,
    "cannot be checked without a current match record",
    "The chart claim carries a fact Open Dental refuses to write over. Resolve it in Open Dental and run the match again.",
  ),
  check(
    "LINES_PAIRED",
    "Every line is paired to a chart line",
    false,
    "1 of 1 lines have no ClaimProcNum",
    "At least one procedure line has no ClaimProcNum. Re-run the match; if it still cannot pair, the chart and the remittance disagree about what was done.",
  ),
  check("CLAIMPROC_NOT_ALREADY_PLANNED", "No chart line is already on another posting plan", true, null, "…"),
  check("CLAIM_TOTALS_AGREE", "The amounts reconcile", true, null, "…"),
];

/** Everything green — and SNAPSHOT_CURRENT still carrying its stale sentence. */
const CHECKS_READY = CHECKS_FRESH.map((c) => {
  if (c.code === "MATCH_CONFIRMED") return { ...c, passed: true, detail: "ClaimNum 53784" };
  if (c.code === "SNAPSHOT_CURRENT")
    return {
      ...c,
      passed: true,
      // THE §15.2 COPY BUG, exactly as the gate sends it: this string arrives
      // on a PASSING check because the ternary that builds it has no branch
      // for success.
      detail: "the confirmed claim is not among the candidates the match recorded",
    };
  return { ...c, passed: true, detail: null };
});

const PLANS = [
  {
    queueId: "q-1",
    office: "roland",
    batchId: "b-1",
    status: "posted",
    statusLabel: "posted",
    blockedReason: null,
    step: null,
    isRecoupment: false,
    carrierEobDate: "2026-03-01",
    intendedTotalCents: 45000,
    postedTotalCents: 45000,
    odClaimPaymentNum: 4471,
    // 01:10Z on the 26th — the EVENING OF THE 25th in Roland. §15.2's timezone
    // finding, in the fixture that proves it.
    reconciledAt: "2026-08-26T01:12:00.000Z",
    approvedAt: "2026-08-26T01:10:00.000Z",
    approvedBy: "biller@example.invalid",
    startedAt: "2026-08-26T01:11:00.000Z",
    finishedAt: "2026-08-26T01:12:00.000Z",
    drainAttemptAt: "2026-08-26T01:11:00.000Z",
    drainedBy: "biller@example.invalid",
    attemptCount: 1,
    lastError: null,
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL OF ARKANSAS",
  },
  {
    queueId: "q-2",
    office: "roland",
    batchId: "b-2",
    status: "blocked",
    statusLabel: "blocked",
    blockedReason: "valley_not_enabled",
    step: null,
    isRecoupment: false,
    carrierEobDate: "2026-03-02",
    intendedTotalCents: 21800,
    postedTotalCents: 0,
    odClaimPaymentNum: null,
    reconciledAt: null,
    approvedAt: "2026-08-26T01:14:00.000Z",
    approvedBy: "biller@example.invalid",
    startedAt: null,
    finishedAt: null,
    drainAttemptAt: "2026-08-26T01:15:00.000Z",
    drainedBy: "biller@example.invalid",
    attemptCount: 1,
    lastError: null,
    checkNumber: "830200002",
    payer: "SYNTHETIC DENTAL OF ARKANSAS",
  },
];

const shots = vi.hoisted(() => ({
  remittance: null as unknown,
  claims: [] as unknown[],
  claim: null as unknown,
  preview: null as unknown,
  list: [] as unknown[],
  listTotal: 0,
  queue: null as unknown,
  queueDetail: null as unknown,
}));

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
    listRemittances: vi.fn(async (office: string) => ({
      office,
      view: "all",
      remittances: shots.list,
      total: shots.listTotal,
      needsAttentionCount: shots.list.length,
      matchingCount: shots.list.length,
      limit: 200,
      offset: 0,
    })),
    getRemittance: vi.fn(async (office: string) => ({
      office,
      remittance: shots.remittance,
      claims: shots.claims,
    })),
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: shots.claim,
      matchRules: {
        amountNearCents: 500,
        dateNearDays: 3,
        ambiguityMargin: 10,
        bands: [
          { band: "HIGH", min: 80 },
          { band: "MEDIUM", min: 60 },
          { band: "LOW", min: 40 },
        ],
      },
    })),
    getApprovalPreview: vi.fn(async () => shots.preview),
    listPostingQueue: vi.fn(async () => shots.queue),
    getPostingPlan: vi.fn(async () => shots.queueDetail),
    listEobUploads: vi.fn(() => new Promise(() => {})),
    listEraUploads: vi.fn(() => new Promise(() => {})),
  };
});

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    useAuth: () => ({ user: { permissions: ["rcm.read", "rcm.write"] }, loading: false }),
  };
});

import RcmOverview from "@/pages/rcm/RcmOverview";
import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import PostingQueue from "@/pages/rcm/PostingQueue";
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

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

const queuePage = (rows: unknown[], over: Record<string, unknown> = {}) => {
  const byStatus = {
    approved: 0,
    posting: 0,
    posted: 0,
    partially_posted: 0,
    failed: 0,
    blocked: 0,
  } as Record<string, number>;
  for (const r of rows as { status: string }[]) byStatus[r.status] += 1;
  return {
    office: "roland",
    rows,
    byStatus,
    total: rows.length,
    limit: 50,
    offset: 0,
    canDrain: true,
    drainRequires: "rcm.write",
    postingEnabled: true,
    ...over,
  };
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  shots.remittance = remit();
  shots.claims = [claim()];
  shots.claim = claim();
  shots.preview = null;
  shots.list = [];
  shots.listTotal = 0;
  shots.queue = queuePage([]);
  shots.queueDetail = null;
});
afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("RCM UX screenshots", () => {
  it("ux-01-overview — the landing page is a work queue, not three totals", async () => {
    shots.list = [
      remit({ batchId: "b-1", attentionObservations: ["claims_unmatched"], attentionReasons: [] }),
      remit({ batchId: "b-2", attentionReasons: ["claims_unreviewed"], attentionObservations: [] }),
      remit({
        batchId: "b-3",
        attentionReasons: ["claims_unreviewed"],
        attentionObservations: ["claims_unmatched"],
      }),
      remit({
        batchId: "b-4",
        attentionReasons: ["claims_awaiting_approval"],
        attentionObservations: [],
      }),
    ];
    shots.listTotal = 4;
    shots.queue = queuePage(PLANS);

    renderAt(<RcmOverview />, "/rcm");
    await screen.findByTestId("rcm-queue-count-match-roland");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-blocked-roland").textContent).toContain("not switched on"),
    );
    dump("ux-01-overview");
  });

  it("ux-02-remittance-fresh — the stepper on a check nobody has matched", async () => {
    shots.preview = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        {
          claimId: "c-1",
          claimNumber: "CLM-88120",
          patientName: "Stedi Test 2",
          postable: false,
          alreadyQueued: false,
          failed: ["MATCH_CONFIRMED", "SNAPSHOT_CURRENT", "REVIEWED", "NO_BLOCKING_PREFLIGHT", "LINES_PAIRED"],
          checks: CHECKS_FRESH,
        },
      ],
      postableCount: 0,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-stepper");
    await screen.findByTestId("approval-match-first");
    dump("ux-02-remittance-fresh");
  });

  it("ux-03-remittance-ready — matched, reviewed, one click from approving", async () => {
    shots.remittance = remit({ attentionReasons: [], attentionObservations: [] });
    shots.claims = [
      claim({
        odMatchStatus: "confirmed",
        odClaimNum: 53784,
        reviewedAt: "2026-08-26T01:05:00.000Z",
        reviewedBy: "biller@example.invalid",
        odMatchConfirmedAt: "2026-08-26T01:00:00.000Z",
      }),
    ];
    shots.preview = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        {
          claimId: "c-1",
          claimNumber: "CLM-88120",
          patientName: "Stedi Test 2",
          postable: true,
          alreadyQueued: false,
          failed: [],
          checks: CHECKS_READY,
        },
      ],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("rcm-stepper");
    await screen.findByTestId("approval-panel");
    // Open the checklist so the pass copy is in frame — this is the shot that
    // shows a passing SNAPSHOT_CURRENT no longer printing a failure sentence.
    fireEvent.click(screen.getByTestId("approval-toggle-c-1"));
    await screen.findByTestId("check-detail-SNAPSHOT_CURRENT");
    dump("ux-03-remittance-ready");
  });

  it("ux-04-claim-confirmed — the breadcrumb, and why the other candidate is grey", async () => {
    shots.claim = claim({
      odMatchStatus: "confirmed",
      odClaimNum: 53784,
      odMatchAt: "2026-08-26T01:00:00.000Z",
      odMatchConfirmedAt: "2026-08-26T01:00:00.000Z",
      odMatchedBy: "biller@example.invalid",
      matchSnapshot: snapshot({
        confirmed: {
          odClaimNum: 53784,
          odPatNum: 12827,
          confirmedAt: "2026-08-26T01:00:00.000Z",
          confirmedBy: "biller@example.invalid",
          linePairs: [],
          odAmountsAsRead: {},
        },
      }),
    });

    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "from=b-1");
    await screen.findByTestId("back-to-remittance");
    await screen.findByTestId("confirm-reason-53785");
    dump("ux-04-claim-confirmed");
  });

  it("ux-05-posting — the practice's own day, a copyable check, both counters scoped", async () => {
    shots.queue = queuePage(PLANS);
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-drain-roland");
    await screen.findByTestId("posting-proof-q-1");
    dump("ux-05-posting");
  });

  it("ux-06-posting-idle — nothing waiting, and the button says so", async () => {
    shots.queue = queuePage([PLANS[0]]);
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-drain-reason-roland");
    dump("ux-06-posting-idle");
  });

  it("ux-07-list-filtered — a work-state tab that admits what it read", async () => {
    shots.list = [
      remit({ batchId: "b-1", attentionObservations: ["claims_unmatched"], attentionReasons: [] }),
      remit({
        batchId: "b-2",
        checkNumber: "830200002",
        totalAmountCents: 21800,
        attentionObservations: ["claims_unmatched"],
        attentionReasons: [],
      }),
    ];
    shots.listTotal = 640;

    renderAt(<RemittanceList />, "/rcm/remittances", "view=match");
    await screen.findByTestId("remittance-row-b-1");
    dump("ux-07-list-filtered");
  });

  it("ux-08-list-empty — the upload is here, not on another page", async () => {
    shots.list = [];
    shots.listTotal = 0;
    renderAt(<RemittanceList />, "/rcm/remittances");
    await screen.findByTestId("remittances-empty-upload-roland");
    fireEvent.click(screen.getByTestId("remittance-upload-toggle"));
    await screen.findByTestId("remittance-upload-panels");
    dump("ux-08-list-empty");
  });
});
