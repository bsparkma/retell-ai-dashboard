/**
 * Screenshot DUMPS for the RCM review workbench (Slice 6a).
 *
 * Not an assertion suite — it renders each screen into jsdom with the same
 * fixture data the behaviour tests use and writes the markup to
 * `tests/.shots/*.html`. `scripts/shoot-rcm-workbench.mjs` then wraps each dump
 * in the app's real built CSS and photographs it with headless Chrome.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DUMP RATHER THAN DRIVE THE LIVE APP
 * ─────────────────────────────────────────────────────────────────────────────
 * The alternative is a running backend, a signed-in session, an entitled
 * tenant, and a real Open Dental — for a picture. That path also puts REAL
 * PATIENT DATA one wrong environment away from a file committed to this repo.
 * Every name, code and dollar figure below is synthetic and lives in this file,
 * so a screenshot physically cannot contain PHI.
 *
 * Skipped unless RCM_SHOTS=1, so a normal `pnpm run test` neither writes files
 * nor pays for the render.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
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

// ─── Fixture data — SYNTHETIC, and the only data these screens ever see ──────

const LINE_EXAM = {
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
  adjustments: [
    {
      adjustmentId: "adj-1",
      amountCents: 6000,
      quantity: 1,
      groupCode: "CO",
      groupLabel: "Contractual",
      groupDescription:
        "Contractual obligation — the practice writes this off, the patient is not billed",
      reasonCode: "45",
      reasonDescription: "Charge exceeds fee schedule/maximum allowable",
      remarkCode: null,
      remarkDescription: null,
    },
  ],
};

/** A downcoded, partially-paid line carrying a RARC — the interesting one. */
const LINE_CROWN = {
  ...LINE_EXAM,
  lineId: "pl-2",
  position: 2,
  billedCode: "D2791",
  paidCode: "D2740",
  code: "D2791",
  description: "Crown — full cast predominantly base metal",
  billedCents: 125800,
  allowedCents: 48500,
  paidCents: 38800,
  adjustmentCents: 87000,
  patientRespCents: 9700,
  writeOffCents: 77300,
  isDowncoded: true,
  flags: ["downcode", "partial_pay", "unexplained_adj"],
  adjustments: [
    {
      adjustmentId: "adj-2",
      amountCents: 77300,
      quantity: 1,
      groupCode: "CO",
      groupLabel: "Contractual",
      groupDescription:
        "Contractual obligation — the practice writes this off, the patient is not billed",
      reasonCode: "45",
      reasonDescription: "Charge exceeds fee schedule/maximum allowable",
      remarkCode: "N19",
      remarkDescription: "Procedure code incidental to primary procedure",
    },
    {
      adjustmentId: "adj-3",
      amountCents: 9700,
      quantity: 1,
      groupCode: "PR",
      groupLabel: "Patient resp.",
      groupDescription: "Patient responsibility — the patient owes this",
      reasonCode: "2",
      reasonDescription: "Coinsurance amount",
      remarkCode: null,
      remarkDescription: null,
    },
  ],
};

const CLAIM_CLEAN = {
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
  odMatchAt: null,
  odMatchConfirmedAt: null,
  odMatchedBy: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: null,
  createdAt: "2026-03-02T10:00:00.000Z",
  lines: [LINE_EXAM],
};

const CLAIM_FLAGGED = {
  ...CLAIM_CLEAN,
  claimId: "c-2",
  claimNumber: "53701",
  patientName: "Sample, Placeholder",
  totalBilledCents: 125800,
  totalAllowedCents: 48500,
  totalPaidCents: 38800,
  patientBalanceCents: 9700,
  needsReviewReasons: ["procedure_downcoded", "unparseable_cas"],
  lines: [LINE_CROWN],
};

const CLAIM_REVERSAL = {
  ...CLAIM_CLEAN,
  claimId: "c-3",
  claimNumber: "53210",
  patientName: "Example, Testcase",
  totalBilledCents: 8600,
  totalPaidCents: -8600,
  needsReviewReasons: ["reversal_not_postable"],
  lines: [{ ...LINE_EXAM, lineId: "pl-3", paidCents: -8600, billedCents: 8600 }],
};

function remittance(over: Record<string, unknown> = {}) {
  const totalAmountCents = (over.totalAmountCents as number) ?? 53800;
  const claimTotalCents = (over.claimTotalCents as number) ?? 53800;
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
    claimCount: 2,
    status: "open",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: totalAmountCents,
      claimTotalCents,
      differenceCents: totalAmountCents - claimTotalCents,
      plbTotalCents: 0,
      balanced: totalAmountCents === claimTotalCents,
    },
    needsAttention: true,
    // The obligation is the disposition. The rest is what she is looking AT.
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: ["batch_open", "claims_flagged", "claims_unmatched"],
    reviewReasonCount: 2,
    unmatchedClaimCount: 2,
    queuedClaimCount: 0,
    upload: {
      uploadId: "u-1",
      filename: "Test_Delta_Dental_MultiClaim.edi",
      uploadedAt: "2026-03-02T10:00:00.000Z",
      uploadedBy: "Billing User",
      documentUrl: "/api/rcm/uploads/u-1/document?office=roland",
    },
    ...over,
  };
}

const CANDIDATES = [
  {
    odClaimNum: 53648,
    odPatNum: 12828,
    score: 92,
    confidence: "HIGH",
    evidence: [
      { tag: "CLAIM_NUMBER_MATCH", weight: 35, label: "Claim number matches", detail: "" },
      { tag: "PATIENT_NAME_MATCH", weight: 20, label: "Patient name matches", detail: "", note: "FIXTURE SYNTHETIC" },
      { tag: "SERVICE_DATE_MATCH", weight: 15, label: "Service date matches", detail: "" },
      { tag: "CODES_ALL_PRESENT", weight: 20, label: "All procedure codes present", detail: "", note: "2/2" },
      { tag: "BILLED_AMOUNT_NEAR", weight: 5, label: "Billed total within $1.00", detail: "", note: "40¢ apart" },
      { tag: "LINE_COUNT_MATCH", weight: 5, label: "Same number of lines", detail: "" },
    ],
    blockers: [
      {
        code: "DELETED_PROCEDURES_EXCLUDED",
        blocking: false,
        label: "Deleted procedures excluded",
        detail: "DELETE /procedurelogs is a soft delete.",
        count: 1,
      },
    ],
    od: {
      claimStatus: "S",
      dateService: "2026-03-02",
      // The claim header still counts the deleted $200 procedure; the live
      // lines do not. The screen shows the live figure.
      claimHeaderFeeCents: 166840,
      billedCents: 146840,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Fixture, Synthetic",
      lines: [],
      deletedLineCount: 1,
      unknownDeletedLineCount: 0,
    },
    linePairs: [
      { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 99001, odCode: "D0150", billedDeltaCents: 0, reason: null },
      { lineId: "pl-2", position: 2, code: "D2791", odClaimProcNum: 99002, odCode: "D2791", billedDeltaCents: 40, reason: null },
    ],
  },
  {
    odClaimNum: 53712,
    odPatNum: 12828,
    score: 45,
    confidence: "MEDIUM",
    evidence: [
      { tag: "PATIENT_NAME_MATCH", weight: 20, label: "Patient name matches", detail: "", note: "FIXTURE SYNTHETIC" },
      { tag: "SERVICE_DATE_NEAR", weight: 7, label: "Service date within 7 days", detail: "", note: "4 days apart" },
      { tag: "CODES_PARTIAL", weight: 10, label: "Some procedure codes present", detail: "", note: "1/2" },
      { tag: "BILLED_AMOUNT_MISMATCH", weight: -10, label: "Billed total differs", detail: "", note: "$984.00 apart" },
      { tag: "LINE_COUNT_MATCH", weight: 5, label: "Same number of lines", detail: "" },
    ],
    blockers: [
      {
        code: "LINE_HAS_CLAIM_PAYMENT",
        blocking: true,
        label: "A check is already attached to a line",
        detail: "Open Dental refuses to change InsPayAmt once a ClaimPayment is attached.",
        count: 2,
      },
      {
        code: "CLAIM_ALREADY_RECEIVED",
        blocking: false,
        label: "Claim is already Received in Open Dental",
        detail: "ClaimStatus is R.",
      },
    ],
    od: {
      claimStatus: "R",
      dateService: "2026-02-26",
      claimHeaderFeeCents: 48440,
      billedCents: 48440,
      insPaidCents: 31200,
      writeOffCents: 17240,
      patientName: "Fixture, Synthetic",
      lines: [],
      deletedLineCount: 0,
      unknownDeletedLineCount: 0,
    },
    linePairs: [
      { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 98801, odCode: "D0150", billedDeltaCents: 0, reason: null },
      { lineId: "pl-2", position: 2, code: "D2791", odClaimProcNum: null, odCode: null, billedDeltaCents: null, reason: "no line on this claim carries this code" },
    ],
  },
];

const SNAPSHOT = {
  version: 2,
  fetchedAt: "2026-03-03T15:04:00.000Z",
  office: "roland",
  officeName: "Roland Family Dental",
  odCalls: 9,
  truncated: false,
  notes: [] as string[],
  patientsConsidered: [{ patNum: 12828, name: "Fixture, Synthetic" }],
  ambiguous: false,
  margin: 47,
  // One more claim was read and set aside. Shown on the panel, because "2
  // offered" and "2 offered, 1 set aside" are different facts.
  rejectedCandidates: 1,
  rejectedReasons: { nameMismatch: 0, belowScore: 1 },
  minScore: 15,
  nameRuleApplied: true,
  candidates: CANDIDATES,
  confirmed: null,
  supersededConfirmation: null,
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

const shotState = vi.hoisted(() => ({
  remittances: [] as unknown[],
  needsAttentionCount: 0,
  detail: null as unknown,
  claim: null as unknown,
  /** Slice 6b — what the approval gate says, and what a press returns. */
  approval: null as unknown,
  approveResult: null as unknown,
  approveError: null as unknown,
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
    listRemittances: vi.fn(async (office: string, opts: { view?: string } = {}) => {
      const all = shotState.remittances as { needsAttention?: boolean }[];
      const view = opts.view === "attention" ? "attention" : "all";
      const selected = view === "attention" ? all.filter((r) => r.needsAttention) : all;
      return {
        office,
        view,
        remittances: selected,
        total: all.length,
        limit: 50,
        offset: 0,
        needsAttentionCount: shotState.needsAttentionCount,
        matchingCount: selected.length,
      };
    }),
    getApprovalPreview: vi.fn(async () => shotState.approval),
    approveRemittance: vi.fn(async () => {
      if (shotState.approveError) throw shotState.approveError;
      return shotState.approveResult;
    }),
    getRemittance: vi.fn(async () => shotState.detail),
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: shotState.claim,
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
  };
});

import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

/** Write the rendered markup for the shooter to wrap and photograph. */
function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  /*
   * A DEFAULT for the approval gate, because RemittanceDetail loads the
   * checklist on mount now. Without one, every shot of the detail page renders
   * the panel's failure state — which would be a picture of a bug rather than
   * of the screen.
   */
  shotState.approval = {
    office: "roland",
    batchId: "b-1",
    canApprove: true,
    approveRequires: "rcm.write",
    claims: [],
    postableCount: 0,
    withheldCount: 0,
    queuedCount: 0,
    balanced: true,
    differenceCents: 0,
  };
  shotState.approveResult = null;
  shotState.approveError = null;
});
afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("workbench screenshots", () => {
  it("01 — the remittance list, on its needs-attention default", async () => {
    shotState.remittances = [
      remittance(),
      remittance({
        batchId: "b-2",
        payer: "CIGNA DENTAL",
        checkNumber: "0044120",
        depositDate: "2026-03-01",
        totalAmountCents: 24350,
        claimTotalCents: 19100,
        claimCount: 3,
        status: "open",
        source: "eob",
        attentionReasons: ["claims_unreviewed"],
        attentionObservations: ["batch_open", "claims_unmatched"],
        reviewReasonCount: 0,
        unmatchedClaimCount: 3,
      }),
      remittance({
        batchId: "b-3",
        payer: "HEALTHCHOICE OK",
        checkNumber: "778100",
        depositDate: "2026-02-27",
        totalAmountCents: 61200,
        claimTotalCents: 61200,
        claimCount: 4,
        status: "ready",
        attentionReasons: ["claims_unreviewed"],
        attentionObservations: [],
        reviewReasonCount: 0,
        unmatchedClaimCount: 0,
      }),
    ];
    shotState.needsAttentionCount = 3;

    renderAt(<RemittanceList />, "/rcm/remittances");
    await waitFor(() => screen.getByTestId("remittance-row-b-1"));
    dump("01-remittance-list");
  });

  it("02 — a remittance with a flagged claim and CARC/RARC descriptions", async () => {
    shotState.detail = {
      office: "roland",
      remittance: { ...remittance({ totalAmountCents: 53800, claimTotalCents: 45200 }), plbAdjustments: [] },
      claims: [CLAIM_FLAGGED, CLAIM_REVERSAL],
    };
    /*
     * The gate's answer for THESE two claims, so the panel in the shot agrees
     * with the claims under it. Both are unmatched in this fixture and one is a
     * takeback, which is why nothing on this remittance is postable — the same
     * state the staging walk produces.
     */
    shotState.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [],
      postableCount: 0,
      withheldCount: 2,
      queuedCount: 0,
      balanced: false,
      differenceCents: 8600,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await waitFor(() => screen.getByTestId("toggle-lines-c-2"));
    // Expanded, because the CARC/RARC descriptions are the point of the shot.
    fireEvent.click(screen.getByTestId("toggle-lines-c-2"));
    await waitFor(() => screen.getByTestId("lines-c-2"));
    dump("02-remittance-detail");
  });

  it("03 — the match panel, with candidates and their evidence", async () => {
    shotState.claim = { ...CLAIM_FLAGGED, odMatchStatus: "candidates", matchSnapshot: SNAPSHOT };

    renderAt(<ClaimMatch />, "/rcm/claims/c-2");
    await waitFor(() => screen.getByTestId("candidate-53648"));
    dump("03-claim-match");
  });

  it("04 — the honest 'no candidate' outcome", async () => {
    shotState.claim = {
      ...CLAIM_CLEAN,
      odMatchStatus: "no_candidate",
      odMatchAt: "2026-03-03T15:04:00.000Z",
      // A genuinely empty search: nothing found AND nothing set aside. The
      // screenshot has to show the state that says so, not the one that says
      // "we looked at three and discarded them".
      matchSnapshot: {
        ...SNAPSHOT,
        candidates: [],
        patientsConsidered: [],
        notes: [],
        rejectedCandidates: 0,
        rejectedReasons: { nameMismatch: 0, belowScore: 0 },
      },
    };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await waitFor(() => screen.getByTestId("no-candidate"));
    dump("04-no-candidate");
  });

  it("05 — claims were found and NONE of them could be offered", async () => {
    /*
     * The other empty outcome, and the one that used to be indistinguishable
     * from 04. Both have no candidates; only one of them means the chart has
     * nothing. A biller acts differently on each, so they must not read alike.
     */
    shotState.claim = {
      ...CLAIM_CLEAN,
      odMatchStatus: "no_candidate",
      odMatchAt: "2026-03-03T15:04:00.000Z",
      matchSnapshot: {
        ...SNAPSHOT,
        candidates: [],
        notes: [],
        patientsConsidered: [
          { patNum: 12828, name: "Fixture, Synthetic" },
          { patNum: 13901, name: "Fixture, Sample" },
        ],
        rejectedCandidates: 3,
        rejectedReasons: { nameMismatch: 2, belowScore: 1 },
      },
    };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await waitFor(() => screen.getByTestId("no-candidate"));
    dump("05-candidates-all-rejected");
  });
  // ─── Slice 6b — the approval gate ──────────────────────────────────────────

  /**
   * The fixtures below are the SEEDED ones: one confirmed-and-reviewed postable
   * claim and one withheld claim, the same pair `scripts/rcm-seed-fixtures.cjs`
   * plants in a dev or staging tenant. Synthetic throughout — every name, code
   * and dollar figure lives in this file, so a screenshot physically cannot
   * contain a real patient.
   */
  const CHECKS_PASS = [
    { code: "OFFICE_CONSISTENT", label: "Belongs to this office", passed: true, detail: null, fix: "" },
    { code: "MATCH_CONFIRMED", label: "Matched to an Open Dental claim", passed: true, detail: "ClaimNum 9800000001", fix: "" },
    { code: "SNAPSHOT_CURRENT", label: "The match record is current and complete", passed: true, detail: null, fix: "" },
    { code: "REVIEWED", label: "Reviewed by a person", passed: true, detail: null, fix: "" },
    { code: "NOT_REVERSAL", label: "Not a reversal or takeback", passed: true, detail: null, fix: "" },
    { code: "NOT_RECOUPMENT", label: "Not a recoupment", passed: true, detail: null, fix: "" },
    { code: "NOT_PATIENT_RESPONSIBILITY_ONLY", label: "The carrier actually paid something", passed: true, detail: null, fix: "" },
    { code: "NO_BLOCKING_REASON", label: "No blocking review reason", passed: true, detail: null, fix: "" },
    { code: "NO_BLOCKING_PREFLIGHT", label: "Open Dental will accept the write", passed: true, detail: null, fix: "" },
    { code: "LINES_PAIRED", label: "Every line is paired to a chart line", passed: true, detail: null, fix: "" },
    { code: "CLAIM_TOTALS_AGREE", label: "The amounts reconcile", passed: true, detail: null, fix: "" },
  ];

  function failing(code: string, detail: string, fix: string) {
    return CHECKS_PASS.map((c) =>
      c.code === code ? { ...c, passed: false, detail, fix } : c,
    );
  }

  const POSTABLE_CLAIM = {
    claimId: "c-1",
    claimNumber: "FIXCLM-ROL-0001",
    patientName: "Stedi Test 2",
    postable: true,
    alreadyQueued: false,
    failed: [] as string[],
    checks: CHECKS_PASS,
  };

  const WITHHELD_CLAIM = {
    claimId: "c-2",
    claimNumber: "FIXCLM-VAL-0002",
    patientName: "Stedi TestValley",
    postable: false,
    alreadyQueued: false,
    failed: ["NOT_RECOUPMENT"],
    checks: failing(
      "NOT_RECOUPMENT",
      "the remittance moves -4000 cents",
      "The carrier is taking money back on this claim. Recoupments are the one irreversible Open Dental operation and are not approvable here.",
      // Its own ClaimNum: two claims sharing one would be a fixture arguing
      // with itself in a picture people read carefully.
    ).map((c) =>
      c.code === "MATCH_CONFIRMED" ? { ...c, detail: "ClaimNum 9800000102" } : c,
    ),
  };

  it("approve-01 — the checklist, with mixed pass and fail", async () => {
    shotState.detail = {
      office: "roland",
      remittance: {
        ...remittance({ flags: ["plb_adjustments_present"] }),
        plbAdjustments: [],
      },
      claims: [CLAIM_FLAGGED],
    };
    shotState.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [POSTABLE_CLAIM, WITHHELD_CLAIM],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("approval-panel");
    // Open the passing claim too, so the shot shows both states expanded.
    fireEvent.click(screen.getByTestId("approval-toggle-c-1"));
    await waitFor(() => screen.getByTestId("approval-checks-c-1"));
    dump("approve-01-checklist");
  });

  it("approve-02 — an honest refusal: nothing on this remittance is postable", async () => {
    const { RcmApiError } = await import("@/features/rcm/api");
    shotState.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [CLAIM_FLAGGED],
    };
    shotState.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        {
          ...WITHHELD_CLAIM,
          claimId: "c-1",
          claimNumber: "FIXCLM-ROL-0002",
          patientName: "Test, MangoTest",
          failed: ["MATCH_CONFIRMED"],
          checks: failing(
            "MATCH_CONFIRMED",
            "match is no_candidate",
            "Open the claim, run the match, and confirm the right one. Posting needs a ClaimNum, and nothing may choose it but a person.",
          ),
        },
        WITHHELD_CLAIM,
      ],
      postableCount: 0,
      withheldCount: 2,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };
    shotState.approveError = new RcmApiError(
      "Nothing on this remittance can be posted yet.",
      409,
      "NOTHING_APPROVABLE",
      {
        claims: [
          { claimId: "c-1", claimNumber: "FIXCLM-ROL-0002", patientName: "Test, MangoTest", postable: false, alreadyQueued: false, failed: ["MATCH_CONFIRMED"], checks: [] },
          { claimId: "c-2", claimNumber: "FIXCLM-VAL-0002", patientName: "Stedi TestValley", postable: false, alreadyQueued: false, failed: ["NOT_RECOUPMENT"], checks: [] },
        ],
      },
    );

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("approval-panel");
    dump("approve-02-refused");
    shotState.approveError = null;
  });

  it("approve-03 — a partial approve: what was queued, and what was not", async () => {
    shotState.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [CLAIM_FLAGGED],
    };
    shotState.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [POSTABLE_CLAIM, WITHHELD_CLAIM],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };
    shotState.approveResult = {
      office: "roland",
      batchId: "b-1",
      queueId: "43ae34f7-690c-5f10-b264-6211b95fca8a",
      approvedBy: "Fixture Lead",
      queued: [
        {
          claimId: "c-1",
          claimNumber: "FIXCLM-ROL-0001",
          patientName: "Stedi Test 2",
          odClaimNum: 9800000001,
          lines: 2,
          totalCents: 11200,
        },
      ],
      withheld: [
        {
          claimId: "c-2",
          claimNumber: "FIXCLM-VAL-0002",
          patientName: "Stedi TestValley",
          reasons: ["NOT_RECOUPMENT"],
          checks: WITHHELD_CLAIM.checks,
        },
      ],
      alreadyQueued: [],
      intendedTotalCents: 11200,
      note: "Queued for posting — nothing has been written to Open Dental yet.",
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("approval-panel");
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => screen.getByTestId("approve-result"));
    dump("approve-03-partial");
  });

  it("approve-04 — the reviewer's view: same checklist, disabled button", async () => {
    shotState.detail = {
      office: "roland",
      remittance: { ...remittance(), plbAdjustments: [] },
      claims: [CLAIM_FLAGGED],
    };
    shotState.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: false,
      approveRequires: "rcm.write",
      claims: [POSTABLE_CLAIM, WITHHELD_CLAIM],
      postableCount: 1,
      withheldCount: 1,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("approval-panel");
    dump("approve-04-reviewer");
  });
});
