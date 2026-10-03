/**
 * Screenshot DUMPS for the three flow fixes — the split, the door, archive.
 *
 * Same shape and reasons as the other `*-shots.test.tsx` files: renders each
 * screen into jsdom with fixture data that lives here and writes the markup to
 * `tests/.shots/mla-*.html`, which `scripts/shoot-match-layout-archive.mjs`
 * wraps in the app's real built CSS and photographs.
 *
 * THE SET:
 *   mla-01-doc-beside-figures   item 1 — the EOB open on the claim page. The
 *                               shooter photographs this one at 1440 (side by
 *                               side) AND at 1024 (stacked) — the two widths
 *                               the brief names.
 *   mla-02-door-claim-page      item 2 — the door in the workbench header
 *   mla-03-door-check-rows      item 2 — one door per claim row on the check
 *   mla-04-archive-dialog       item 3 — the confirm, reason typed
 *   mla-05-archive-refused      item 3 — posting history refuses the control
 *   mla-06-archived-banner      item 3 — the archived check, one verb back
 *   mla-07-archived-tab         item 3 — the Archived tab holding the check
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and
 * dollar figure below is synthetic.
 *
 * Skipped unless RCM_SHOTS=1.
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

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

// ─── Fixtures — synthetic, and the only data these screens ever see ──────────

const LINE = {
  lineId: "l-1",
  position: 1,
  billedCode: "D2740",
  paidCode: null,
  code: "D2740",
  description: "Crown — porcelain/ceramic",
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
  odClaimProcNum: null,
  adjustments: [] as unknown[],
  contractualWriteOffCents: 30000,
  patientRemainderCents: 45000,
  decision: null,
  decisionReason: null,
  decidedBy: null,
  decidedAt: null,
  struck: null,
};

const LINE_2 = {
  ...LINE,
  lineId: "l-2",
  position: 2,
  billedCode: "D0120",
  code: "D0120",
  description: "Periodic oral evaluation",
  billedCents: 6500,
  allowedCents: 5200,
  paidCents: 5200,
  adjustmentCents: 1300,
  patientRespCents: 0,
  writeOffCents: 1300,
  contractualWriteOffCents: 1300,
  patientRemainderCents: 0,
};

function workbenchClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    patientDob: null,
    subscriberId: null,
    odPatientId: null,
    odClaimNum: null,
    payer: "MERIDIAN MUTUAL DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 126500,
    totalAllowedCents: 95200,
    totalPaidCents: 50200,
    totalDeductibleCents: 0,
    patientBalanceCents: 45000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 100,
    odMatchStatus: "not_run",
    rejectedCandidates: 0,
    matchSnapshot: null,
    matchSnapshotStale: false,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    postingQueueId: null,
    approvedAt: null,
    verdict: null,
    identity: null,
    chart: null,
    confirmedAt: null,
    provenance: {
      uploadId: "u-1",
      textSource: "ocr",
      ocrPageCount: 2,
      ocrMeanConfidence: 0.98,
    },
    lines: [LINE, LINE_2],
    handEnteredLines: [] as unknown[],
    ...over,
  };
}

const MATCH_RULES = { amountNearCents: 500, dateNearDays: 3, ambiguityMargin: 5, bands: [] };

function check(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "MERIDIAN MUTUAL DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 50200,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    patientNames: { shown: ["Fixture, Synthetic"], more: 0 },
    status: "ready",
    source: "eob",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 50200,
      claimTotalCents: 50200,
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
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    comparisonVerdict: null,
    comparisonReason: null,
    comparisonNote: null,
    comparisonAt: null,
    comparisonBy: null,
    comparisonRevision: 0,
    lastDecidedAt: null,
    lastDecidedBy: null,
    upload: null,
    ...over,
  };
}

function detailClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    odPatientId: null,
    odClaimNum: null,
    payer: "MERIDIAN MUTUAL DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 126500,
    totalAllowedCents: 95200,
    totalPaidCents: 50200,
    totalDeductibleCents: 0,
    patientBalanceCents: 45000,
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
    createdAt: null,
    lines: [LINE, LINE_2],
    ...over,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
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
      const live = all.filter((r) => r.archivedAt == null);
      const view = (opts.view as string) ?? "all";
      const selected =
        view === "archived"
          ? all.filter((r) => r.archivedAt != null)
          : view === "attention"
            ? live.filter((r) => r.needsAttention)
            : live;
      return {
        office,
        view,
        remittances: selected,
        total: live.length,
        needsAttentionCount: live.filter((r) => r.needsAttention).length,
        parkedCount: 0,
        setAsideCount: 0,
        archivedCount: all.filter((r) => r.archivedAt != null).length,
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
        remittance: { ...row, plbAdjustments: [], plans: [] },
        claims: state.claims,
      };
    }),
    getApprovalPreview: vi.fn(async () => {
      throw new real.RcmApiError("no gate", 500, "OOPS");
    }),
    listPostingQueue: vi.fn(async () => ({
      office: "roland",
      rows: [],
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
    })),
    getComparisonTally: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    getRecoupmentPreview: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    getRecoupmentChecklist: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    getPostingPlan: vi.fn(async () => {
      throw new real.RcmApiError("no posting", 404, "QUEUE_NOT_FOUND");
    }),
    unparkRemittance: vi.fn(async () => ({ batchId: "b-1", parked: false, wasParked: false })),
    archiveRemittance: vi.fn(async () => ({ batchId: "b-1", archived: true })),
    unarchiveRemittance: vi.fn(async () => ({ batchId: "b-1", archived: false, wasArchived: true })),
  };
});

import ClaimWorkbench from "@/components/rcm/ClaimWorkbench";
import CheckWorklistActions from "@/components/rcm/CheckWorklistActions";
import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Remittance } from "@/features/rcm/api";

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

function renderWorkbench(fixFigureHref: string | null) {
  const claim = workbenchClaim();
  const data = { claim, writeoffReasons: [], matchRules: MATCH_RULES } as never;
  return renderAt(
    <ClaimWorkbench
      data={data}
      claim={claim as never}
      snapshot={null}
      note=""
      setNote={() => {}}
      busy={null}
      mayRerun
      mayDecide
      decideBlockedBy={null}
      fromBatchId="b-1"
      onRunMatch={() => {}}
      onReview={() => {}}
      onConfirm={() => {}}
      onDecide={() => {}}
      documentHref="/api/rcm/uploads/u-1/document?office=roland"
      fixFigureHref={fixFigureHref}
    />,
    "/rcm/claims/c-1?from=b-1",
  );
}

const maybe = process.env.RCM_SHOTS === "1" ? describe : describe.skip;

maybe("match-layout-archive dumps", () => {
  afterEach(cleanup);
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("carein.office", "roland");
    state.checks = [];
    state.claims = [];
  });

  it("mla-01: the EOB open beside the figures", () => {
    renderWorkbench("/rcm/remittances/b-1/confirm?claim=c-1");
    fireEvent.click(screen.getByTestId("open-source-document"));
    screen.getByTestId("workbench-split");
    dump("mla-01-doc-beside-figures");
  });

  it("mla-02: the door in the workbench header", () => {
    renderWorkbench("/rcm/remittances/b-1/confirm?claim=c-1");
    screen.getByTestId("fix-figure-door");
    dump("mla-02-door-claim-page");
  });

  it("mla-03: one door per claim row on the check", async () => {
    state.checks = [check({ fieldConfirm: { required: true, ok: false, outstanding: 7 } })];
    state.claims = [detailClaim(), detailClaim({ claimId: "c-2", claimNumber: "53649", patientName: "Fixture, Synthetic B" })];
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("fix-figure-c-1");
    dump("mla-03-door-check-rows");
  });

  it("mla-04: the archive dialog, reason typed", () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={check() as never as Remittance}
        onChanged={() => {}}
      />,
      "/rcm/remittances/b-1",
    );
    fireEvent.click(screen.getByTestId("check-archive"));
    fireEvent.change(screen.getByTestId("check-archive-reason"), {
      target: { value: "Test upload — not a real check" },
    });
    dump("mla-04-archive-dialog");
  });

  it("mla-05: posting history refuses the control", () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={check({ queuedClaimCount: 1 }) as never as Remittance}
        onChanged={() => {}}
      />,
      "/rcm/remittances/b-1",
    );
    screen.getByTestId("check-archive-blocked");
    dump("mla-05-archive-refused");
  });

  it("mla-06: the archived banner, one verb back", () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={
          check({
            archivedAt: "2026-03-04T10:00:00.000Z",
            archivedBy: "Billing User",
            archivedReason: "Test upload — not a real check",
          }) as never as Remittance
        }
        onChanged={() => {}}
      />,
      "/rcm/remittances/b-1",
    );
    screen.getByTestId("check-archived-banner");
    dump("mla-06-archived-banner");
  });

  it("mla-07: the Archived tab holding the check", async () => {
    state.checks = [
      check(),
      check({
        batchId: "b-2",
        checkNumber: "830200002",
        traceNumber: "830200002",
        needsAttention: false,
        attentionReasons: [],
        attentionObservations: ["archived"],
        archivedAt: "2026-03-04T10:00:00.000Z",
        archivedBy: "Billing User",
        archivedReason: "Test upload — not a real check",
      }),
    ];
    renderAt(<RemittanceList />, "/rcm/remittances");
    await screen.findByTestId("remittances-roland");
    fireEvent.click(screen.getByTestId("remittance-filter-archived"));
    await screen.findByTestId("remittance-row-b-2");
    await waitFor(() => screen.getByTestId("remittance-filter-count-archived"));
    dump("mla-07-archived-tab");
  });
});
