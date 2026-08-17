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
    attentionReasons: ["batch_open", "claims_flagged", "claims_unmatched"],
    reviewReasonCount: 2,
    unmatchedClaimCount: 2,
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
      claimFeeCents: 146840,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Fixture, Synthetic",
      lines: [],
      deletedLineCount: 1,
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
      { tag: "BILLED_AMOUNT_MISMATCH", weight: -10, label: "Billed total differs", detail: "", note: "98400¢ apart" },
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
      claimFeeCents: 48440,
      insPaidCents: 31200,
      writeOffCents: 17240,
      patientName: "Fixture, Synthetic",
      lines: [],
      deletedLineCount: 0,
    },
    linePairs: [
      { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 98801, odCode: "D0150", billedDeltaCents: 0, reason: null },
      { lineId: "pl-2", position: 2, code: "D2791", odClaimProcNum: null, odCode: null, billedDeltaCents: null, reason: "no line on this claim carries this code" },
    ],
  },
];

const SNAPSHOT = {
  version: 1,
  fetchedAt: "2026-03-03T15:04:00.000Z",
  office: "roland",
  officeName: "Roland Family Dental",
  odCalls: 9,
  truncated: false,
  notes: [] as string[],
  patientsConsidered: [{ patNum: 12828, name: "Fixture, Synthetic" }],
  ambiguous: false,
  margin: 47,
  candidates: CANDIDATES,
  confirmed: null,
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

const shotState = vi.hoisted(() => ({
  remittances: [] as unknown[],
  needsAttentionCount: 0,
  detail: null as unknown,
  claim: null as unknown,
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
      remittances: shotState.remittances,
      total: shotState.remittances.length,
      limit: 100,
      offset: 0,
      needsAttentionCount: shotState.needsAttentionCount,
    })),
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
        attentionReasons: ["batch_open", "claims_unmatched"],
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
      matchSnapshot: { ...SNAPSHOT, candidates: [], patientsConsidered: [], notes: [] },
    };

    renderAt(<ClaimMatch />, "/rcm/claims/c-1");
    await waitFor(() => screen.getByTestId("no-candidate"));
    dump("04-no-candidate");
  });
});
