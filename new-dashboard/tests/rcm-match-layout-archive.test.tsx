/**
 * THREE FLOW FIXES — the split layout, the door to the edits, and archive.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE PINS
 * ═════════════════════════════════════════════════════════════════════════════
 *  1 · SIDE BY SIDE. Opening the EOB on the claim page stops stacking the
 *      viewer above the figures: at ≥1280px the document takes one column,
 *      sticky and full-height, and the work flows down the other. Asserted on
 *      STRUCTURE (the split container's classes and document order), the same
 *      way Stage C pins its anchored panels — jsdom computes no layout, and a
 *      pixel assertion would pass the day the CSS broke in a real browser.
 *  2 · THE DOOR. "Fix a figure on this claim" is a LINK to the confirm screen
 *      anchored at that claim — the one audited place a figure is edited — and
 *      it only exists where a confirm step exists. An 835 gets no door.
 *  3 · ARCHIVE. The dialog demands a reason; the control refuses itself, with
 *      its reason, on a check with posting history; an archived check wears a
 *      banner whose one verb is the way back. The server's own guard is pinned
 *      in backend/routes/rcm/archiveCheck.test.js — this is the screen's half.
 *
 * NO NETWORK, NO PHI. Every payer, patient, number and figure is synthetic.
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

const LINE = {
  lineId: "l-1",
  position: 1,
  billedCode: "D2740",
  paidCode: null,
  code: "D2740",
  description: "Crown",
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
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 120000,
    totalAllowedCents: 90000,
    totalPaidCents: 45000,
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
    provenance: null,
    lines: [LINE],
    handEnteredLines: [] as unknown[],
    ...over,
  };
}

const MATCH_RULES = { amountNearCents: 500, dateNearDays: 3, ambiguityMargin: 5, bands: [] };

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
    totalAmountCents: 45000,
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
      batchTotalCents: 45000,
      claimTotalCents: 45000,
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
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-01",
    receivedDate: "2026-03-05",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "PPO",
    totalBilledCents: 120000,
    totalAllowedCents: 90000,
    totalPaidCents: 45000,
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
    lines: [LINE],
    ...over,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  archiveCalls: [] as unknown[][],
  unarchiveCalls: [] as unknown[][],
  archiveError: null as Error | null,
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
        parkedCount: live.filter((r) => r.parkedAt != null).length,
        setAsideCount: live.filter((r) => r.setAsideAt != null).length,
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
        remittance: { ...row, plbAdjustments: [], plans: (row.plans as unknown[] | undefined) ?? [] },
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
    archiveRemittance: vi.fn(async (...args: unknown[]) => {
      state.archiveCalls.push(args);
      if (state.archiveError) throw state.archiveError;
      return { batchId: "b-1", archived: true };
    }),
    unarchiveRemittance: vi.fn(async (...args: unknown[]) => {
      state.unarchiveCalls.push(args);
      return { batchId: "b-1", archived: false, wasArchived: true };
    }),
  };
});

import ClaimWorkbench from "@/components/rcm/ClaimWorkbench";
import CheckWorklistActions from "@/components/rcm/CheckWorklistActions";
import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import { matchesFilter } from "@/features/rcm/worklist";
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

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.checks = [];
  state.claims = [];
  state.archiveCalls = [];
  state.unarchiveCalls = [];
  state.archiveError = null;
});

function renderWorkbench(over: Record<string, unknown> = {}) {
  const claim = workbenchClaim(over);
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
      fixFigureHref="/rcm/remittances/b-1/confirm?claim=c-1"
    />,
    "/rcm/claims/c-1?from=b-1",
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · SIDE BY SIDE
// ═════════════════════════════════════════════════════════════════════════════

describe("the document opens BESIDE the figures, not above them", () => {
  it("closed, there is no split and the two-column workbench stands", () => {
    renderWorkbench();
    expect(screen.queryByTestId("workbench-split")).toBeNull();
    expect(screen.queryByTestId("eob-panel")).toBeNull();
    expect(screen.getByTestId("open-source-document").textContent).toContain("See the EOB");
  });

  it("open, the viewer and the work are grid SIBLINGS — side by side at ≥1280px, stacked below", () => {
    renderWorkbench();
    fireEvent.click(screen.getByTestId("open-source-document"));

    const split = screen.getByTestId("workbench-split");
    /*
     * THE STRUCTURAL CLAIM. `grid-cols-1` is the stacked default and
     * `xl:grid-cols-2` is the ≥1280px split — the same breakpoint the closed
     * layout already uses. jsdom computes no layout, so the class pair plus
     * the sibling order below IS the testable form of "beside each other".
     */
    expect(split.className).toContain("grid-cols-1");
    expect(split.className).toContain("xl:grid-cols-2");

    const [docColumn, workColumn] = Array.from(split.children) as HTMLElement[];
    expect(docColumn.querySelector('[data-testid="eob-panel"]'), "viewer in column 1").toBeTruthy();
    /* FULL HEIGHT: the document column rides sticky so the page's one scroll
       walks the figures while the page image stays in reach. */
    expect(docColumn.className).toContain("xl:sticky");
    expect(
      workColumn.querySelector('[data-testid="claim-parsed"]'),
      "the carrier table in column 2",
    ).toBeTruthy();
    expect(
      workColumn.querySelector('[data-testid="identity-unknown"]'),
      "the Open Dental panels follow in the same column",
    ).toBeTruthy();

    // And the frame grows to the column at the split width.
    const frame = screen.getByTestId("eob-panel-viewer-frame").parentElement as HTMLElement;
    expect(frame.className).toContain("xl:h-[calc(100vh-11rem)]");
  });

  it("closing the panel returns the two-column layout", () => {
    renderWorkbench();
    fireEvent.click(screen.getByTestId("open-source-document"));
    fireEvent.click(screen.getByTestId("eob-panel-close"));
    expect(screen.queryByTestId("workbench-split")).toBeNull();
    expect(screen.getByTestId("claim-parsed")).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE DOOR
// ═════════════════════════════════════════════════════════════════════════════

describe("Fix a figure on this claim — a door, never an editor", () => {
  it("the claim page offers the door, as a LINK to the confirm screen anchored at the claim", () => {
    renderWorkbench();
    const door = screen.getByTestId("fix-figure-door");
    expect(door.tagName).toBe("A");
    expect(door.getAttribute("href")).toBe("/rcm/remittances/b-1/confirm?claim=c-1");
    expect(door.textContent).toContain("Fix a figure on this claim");
  });

  it("no confirm step, no door — an 835 has no page to fix a figure against", () => {
    const claim = workbenchClaim();
    const data = { claim, writeoffReasons: [], matchRules: MATCH_RULES } as never;
    renderAt(
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
        documentHref={null}
        fixFigureHref={null}
      />,
      "/rcm/claims/c-1?from=b-1",
    );
    expect(screen.queryByTestId("fix-figure-door")).toBeNull();
  });

  it("the check page offers one door per claim when the check has a confirm step", async () => {
    state.checks = [
      check({ fieldConfirm: { required: true, ok: false, outstanding: 7 } }),
    ];
    state.claims = [detailClaim()];
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const door = await screen.findByTestId("fix-figure-c-1");
    expect(door.getAttribute("href")).toBe("/rcm/remittances/b-1/confirm?claim=c-1");
  });

  it("an 835's claim rows carry no door", async () => {
    state.checks = [check({ source: "835" })];
    state.claims = [detailClaim()];
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("claim-card-c-1");
    expect(screen.queryByTestId("fix-figure-c-1")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · ARCHIVE
// ═════════════════════════════════════════════════════════════════════════════

describe("archive a check that never went anywhere", () => {
  const onChanged = () => {};

  it("the dialog demands a reason before it will act", async () => {
    renderAt(
      <CheckWorklistActions office="roland" remittance={check() as never as Remittance} onChanged={onChanged} />,
      "/rcm/remittances/b-1",
    );
    fireEvent.click(screen.getByTestId("check-archive"));
    expect(screen.getByTestId("check-archive-dialog")).toBeTruthy();

    const confirm = screen.getByTestId("check-archive-confirm") as HTMLButtonElement;
    expect(confirm.disabled, "no reason, no press").toBe(true);
    expect(screen.getByTestId("check-archive-needs-reason")).toBeTruthy();

    fireEvent.change(screen.getByTestId("check-archive-reason"), {
      target: { value: "  Test upload — not a real check  " },
    });
    expect((screen.getByTestId("check-archive-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("check-archive-confirm"));

    await waitFor(() => expect(state.archiveCalls).toHaveLength(1));
    // Trimmed — the server stores her line, not her whitespace.
    expect(state.archiveCalls[0]).toEqual(["roland", "b-1", "Test upload — not a real check"]);
  });

  it("posting history refuses the control itself, with the reason and the way that fits", () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={check({ queuedClaimCount: 1 }) as never as Remittance}
        onChanged={onChanged}
      />,
      "/rcm/remittances/b-1",
    );
    const button = screen.getByTestId("check-archive") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("check-archive-blocked").textContent).toContain("Set aside");
    // And pressing it opens nothing.
    fireEvent.click(button);
    expect(screen.queryByTestId("check-archive-dialog")).toBeNull();
  });

  it("a posting that ran and stopped is history too", () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={check({ attentionReasons: ["posting_failed"] }) as never as Remittance}
        onChanged={onChanged}
      />,
      "/rcm/remittances/b-1",
    );
    expect((screen.getByTestId("check-archive") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the server's refusal is shown in its own words", async () => {
    const { RcmApiError } = await import("@/features/rcm/api");
    state.archiveError = new RcmApiError(
      "This check has posting history (posted) — it is part of the record of what reached Open Dental, so it cannot be archived. Use Set aside instead.",
      409,
      "ARCHIVE_POSTING_HISTORY",
    );
    renderAt(
      <CheckWorklistActions office="roland" remittance={check() as never as Remittance} onChanged={onChanged} />,
      "/rcm/remittances/b-1",
    );
    fireEvent.click(screen.getByTestId("check-archive"));
    fireEvent.change(screen.getByTestId("check-archive-reason"), { target: { value: "Tidying" } });
    fireEvent.click(screen.getByTestId("check-archive-confirm"));
    await screen.findByTestId("check-worklist-error");
    expect(screen.getByTestId("check-worklist-error").textContent).toContain("Set aside");
  });

  it("an archived check wears the banner — who, when, why — and one verb: bring it back", async () => {
    renderAt(
      <CheckWorklistActions
        office="roland"
        remittance={
          check({
            archivedAt: "2026-03-04T10:00:00.000Z",
            archivedBy: "Billing User",
            archivedReason: "Test upload",
          }) as never as Remittance
        }
        onChanged={onChanged}
      />,
      "/rcm/remittances/b-1",
    );
    const banner = screen.getByTestId("check-archived-banner");
    expect(banner.textContent).toContain("Archived");
    expect(banner.textContent).toContain("Test upload");
    expect(banner.textContent).toContain("Billing User");
    // The three ordinary actions are gone — an archived check is not worked.
    expect(screen.queryByTestId("check-park")).toBeNull();
    expect(screen.queryByTestId("check-set-aside")).toBeNull();
    expect(screen.queryByTestId("check-archive")).toBeNull();

    fireEvent.click(screen.getByTestId("check-unarchive"));
    await waitFor(() => expect(state.unarchiveCalls).toHaveLength(1));
    expect(state.unarchiveCalls[0]).toEqual(["roland", "b-1"]);
  });

  it("the Archived tab holds the archived checks, counted, and other tabs do not", async () => {
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
        archivedReason: "Test upload",
      }),
    ];
    renderAt(<RemittanceList />, "/rcm/remittances");
    await screen.findByTestId("remittances-roland");

    // The default view holds only the live check…
    await screen.findByTestId("remittance-row-b-1");
    expect(screen.queryByTestId("remittance-row-b-2")).toBeNull();
    // …and the tab's count already says one check is archived.
    await waitFor(() =>
      expect(screen.getByTestId("remittance-filter-count-archived").textContent).toBe("1"),
    );

    fireEvent.click(screen.getByTestId("remittance-filter-archived"));
    const row = await screen.findByTestId("remittance-row-b-2");
    expect(row.textContent).toContain("Archived");
    expect(screen.queryByTestId("remittance-row-b-1")).toBeNull();
  });

  it("matchesFilter treats archived as the one true partition", () => {
    const archived = check({
      archivedAt: "2026-03-04T10:00:00.000Z",
      setAsideAt: "2026-03-03T10:00:00.000Z",
      needsAttention: false,
    }) as never as Remittance;
    expect(matchesFilter(archived, "archived")).toBe(true);
    for (const f of ["all", "attention", "parked", "set_aside", "match", "review"] as const) {
      expect(matchesFilter(archived, f), f).toBe(false);
    }
    const live = check() as never as Remittance;
    expect(matchesFilter(live, "archived")).toBe(false);
    expect(matchesFilter(live, "all")).toBe(true);
  });
});
