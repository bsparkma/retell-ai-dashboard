/**
 * STAGE C — the arrangement, and the claims that are about STRUCTURE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * Stage C changed how existing screens are ARRANGED and what they SAY. Most of
 * that is covered where it belongs — the plain-language guard scans every new
 * string, `rcm-next-action` and `rcm-rollup` drive the two new derivations, and
 * `rcm-bring-in` covers the new page. What is left is a handful of claims that
 * are only true of the assembled screen:
 *
 *  · TODAY names the next thing and offers one button that goes to it;
 *  · TODAY's arrivals table says what happens next, in her words;
 *  · the CHECKS list says whose move it is, per row;
 *  · the CHECK's claim table shows the per-claim verdict, from the GATE's own
 *    payload rather than a second summary;
 *  · SAVE FOR TOMORROW and SET ASIDE do not cover the claim list underneath —
 *    asserted on STRUCTURE, never on pixels;
 *  · SHADOW MODE explains itself and carries the worksheet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "DOES NOT COVER" IS A STRUCTURAL CLAIM, AND THAT IS DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────────
 * The design's reason for anchored panels rather than modals is that deciding to
 * set a check aside is deciding ABOUT THE CLAIMS ON IT — "the claims aren't in
 * Open Dental any more" is a claim about rows a modal would have just hidden.
 *
 * jsdom computes no layout, so a pixel assertion here would be meaningless and a
 * pixel assertion in a browser would pass on the day the CSS broke in a browser
 * nobody ran it in. What IS checkable, and is what the rule actually says: the
 * panel carries no out-of-flow positioning, and the claim list is still in the
 * document AFTER it. An element in normal flow cannot cover a later sibling.
 *
 * NO NETWORK, NO PHI. Every payer, patient, check number and figure is synthetic.
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
  odClaimProcNum: 533930,
  adjustments: [] as unknown[],
  contractualWriteOffCents: 30000,
  patientRemainderCents: 45000,
  decision: null,
  decisionReason: null,
  decidedBy: null,
  decidedAt: null,
};

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    odPatientId: 12827,
    odClaimNum: 53648,
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
    odMatchStatus: "confirmed",
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
    source: "835",
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
    lastDecidedAt: null,
    lastDecidedBy: null,
    upload: null,
    ...over,
  };
}

const VERDICT = {
  state: "green" as const,
  register: "projection" as const,
  eobPatientCents: 45000,
  projectedPatientCents: 45000,
  decidedWriteOffCents: 0,
  contractualWriteOffCents: 30000,
  decisions: [],
  problems: [],
  sentence: "Will owe $450.00 — matches the EOB.",
};

function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Fixture, Synthetic",
    postable: true,
    alreadyQueued: false,
    checks: [],
    failed: [] as string[],
    verdict: VERDICT,
    ...over,
  };
}

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

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  approval: null as Record<string, unknown> | null,
  queue: null as Record<string, unknown> | null,
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
      const selected =
        view === "attention" ? live.filter((r) => r.needsAttention) : all;
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
        remittance: { ...row, plbAdjustments: [], plans: [] },
        claims: state.claims,
      };
    }),
    getApprovalPreview: vi.fn(async () => {
      if (!state.approval) throw new real.RcmApiError("no gate", 500, "OOPS");
      return state.approval;
    }),
    listPostingQueue: vi.fn(async () => state.queue ?? QUEUE),
    getRecoupmentPreview: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    getRecoupmentChecklist: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    unparkRemittance: vi.fn(async () => ({ batchId: "b-1", parked: false, wasParked: false })),
    parkRemittance: vi.fn(async () => ({ batchId: "b-1", parked: true })),
    setAsideRemittance: vi.fn(async () => ({ batchId: "b-1", setAside: true, reason: "target_gone" })),
    restoreRemittance: vi.fn(async () => ({ batchId: "b-1", setAside: false, wasSetAside: true })),
    matchRemittance: vi.fn(async () => ({ matched: [] })),
    getPostingPlan: vi.fn(async () => {
      throw new real.RcmApiError("no posting", 404, "QUEUE_NOT_FOUND");
    }),
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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.checks = [];
  state.claims = [];
  state.approval = null;
  state.queue = null;
});

afterEach(cleanup);

// ═══════════════════════════════════════════════════════════════════════════
// §1 — TODAY
// ═══════════════════════════════════════════════════════════════════════════

describe("Today answers in sentences", () => {
  it("names the next claim on an unfinished check and offers ONE button to it", async () => {
    state.checks = [
      check({ parkedAt: "2026-03-04T22:55:00.000Z", parkedBy: "Billing User" }),
    ];
    state.claims = [claim({ claimId: "c-1", patientName: "Second, Synthetic" })];

    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    await screen.findByTestId("rcm-left-off-roland");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-next-action-b-1").textContent).toContain(
        "Second, Synthetic is the last one",
      ),
    );
    // One button, and it goes STRAIGHT to the claim rather than to the check.
    const pick = screen.getByTestId("rcm-pick-up-b-1");
    expect(pick.textContent).toContain("Pick up where you left off");
    expect(pick.getAttribute("href")).toContain("/rcm/claims/c-1");
  });

  it("says what happens next per arrival, in her words", async () => {
    state.checks = [check({ unmatchedClaimCount: 2, claimCount: 5 })];

    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    await waitFor(() =>
      expect(screen.getByTestId("rcm-arrival-next-b-1").textContent).toBe(
        "3 matched already · 2 need you to pick",
      ),
    );
  });

  it("has NO file input anywhere — the door is a card that navigates (D-16)", async () => {
    state.checks = [check()];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    const view = renderAt(<RcmToday />, "/rcm");

    const card = await screen.findByTestId("rcm-get-work-in");
    expect(card.getAttribute("href")).toBe("/rcm/bring-in");
    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it("finishing the evening feels like finishing, with the numbers", async () => {
    /*
     * §11's second empty state. "You are done" without the numbers reads like
     * the screen failed to load; the numbers are what make it a result.
     */
    state.checks = [
      check({ setAsideAt: "2026-03-04T23:00:00.000Z", setAsideBy: "Billing User", needsAttention: false }),
    ];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    const done = await screen.findByTestId("rcm-arrivals-all-done-roland");
    expect(done.textContent).toContain("That's everything for tonight");
    expect(done.textContent).toContain("1 check on file here");
  });

  it("a first evening points at the door rather than saying nothing", async () => {
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    const empty = await screen.findByTestId("rcm-arrivals-none-ever-roland");
    expect(empty.textContent).toContain("Nothing has come in");
    expect(screen.getByTestId("rcm-arrivals-none-ever-add-roland").getAttribute("href")).toBe(
      "/rcm/bring-in",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — THE CHECKS LIST
// ═══════════════════════════════════════════════════════════════════════════

describe("the Checks list says whose move it is", () => {
  it("renders four tabs with whole-office counts, and a footer that says how the list behaves", async () => {
    state.checks = [check()];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    await screen.findByTestId("remittances-roland");
    for (const tab of ["attention", "parked", "set_aside", "all"]) {
      expect(screen.getByTestId(`remittance-filter-${tab}`), `no ${tab} tab`).toBeTruthy();
    }
    // The four work-state filters are NOT tabs any more — a row says which of
    // them it is, in words.
    expect(screen.queryByTestId("remittance-filter-match")).toBeNull();
    expect(screen.queryByTestId("remittance-filter-review")).toBeNull();

    await waitFor(() =>
      expect(screen.getByTestId("remittance-filter-count-all").textContent).toBe("1"),
    );
    expect(screen.getByTestId("remittance-list-footer").textContent).toContain(
      "A check leaves this list only when it is posted or set aside",
    );
  });

  it("a filter arriving by LINK renders as a chip with a way out of it", async () => {
    /*
     * Today's "How it stands" cards link into `?view=blocked` and friends, and
     * somebody may hold an older URL. Silently showing an unfiltered list would
     * be the filter lying about its own population.
     */
    state.checks = [check()];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances?view=blocked");

    const chip = await screen.findByTestId("remittance-filter-blocked");
    expect(chip.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByTestId("remittance-filter-attention").getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
  });

  it("a NEGATIVE check reads as a takeback, whatever else is true about it", async () => {
    state.checks = [check({ totalAmountCents: -5400 })];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    await waitFor(() =>
      expect(screen.getByTestId("remittance-waiting-b-1").textContent).toBe(
        "A takeback — money the carrier is reclaiming",
      ),
    );
  });

  /* ── C-3b item 1 — and WHO is on the check ─────────────────────────────── */

  it("names the patients on a row, and says how many more people there are", async () => {
    /*
     * The question a biller arrives with is "is my patient on this check?".
     * Before this the only way to answer it was to open every row, which costs
     * a full audited claim read each time.
     */
    state.checks = [
      check({
        claimCount: 9,
        patientNames: { shown: ["Fixture, Synthetic", "Sample, Placeholder"], more: 2 },
      }),
    ];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    const names = await screen.findByTestId("remittance-patients-b-1");
    expect(names.textContent).toContain("Fixture, Synthetic");
    expect(names.textContent).toContain("Sample, Placeholder");
    expect(names.textContent).toContain("+2 more");
  });

  it("renders the count the SERVER sent, and never derives one from claimCount", async () => {
    /*
     * `more` counts PEOPLE. Nine claims for four people is "+2 more", not
     * "+7 more" — and a row that did its own arithmetic would say the second
     * thing and be wrong about the check every time a patient had two claims.
     */
    state.checks = [
      check({
        claimCount: 9,
        patientNames: { shown: ["Fixture, Synthetic", "Sample, Placeholder"], more: 2 },
      }),
    ];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    const names = await screen.findByTestId("remittance-patients-b-1");
    expect(names.textContent).not.toContain("+7");
  });

  it("prints no name line at all when the check resolved no claims", async () => {
    // An empty line under every unresolved check is noise, and a row that said
    // "no patients" would be asserting something the data does not support.
    state.checks = [check({ patientNames: { shown: [], more: 0 } })];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    await screen.findByTestId("remittance-row-b-1");
    expect(screen.queryByTestId("remittance-patients-b-1")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 — THE CHECK'S OWN PAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("the check's claim table is a triage screen", () => {
  it("shows the GATE's own verdict per claim, never a second summary", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() =>
      // VERBATIM — the server's own sentence, already formatted.
      expect(screen.getByTestId("claim-stands-c-1").textContent).toBe(VERDICT.sentence),
    );
  });

  it("says 'not judged' rather than a neutral verdict when the gate has nothing", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      // The gate answered; it just had nothing to say about this claim.
      claims: [],
      postableCount: 0,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await waitFor(() =>
      expect(screen.getByTestId("claim-stands-c-1").textContent).toContain("Not judged yet"),
    );
  });

  it("leads with the money sanity line, and names the gap when there is one", async () => {
    state.checks = [
      check({
        totalAmountCents: 50000,
        balance: {
          batchTotalCents: 50000,
          claimTotalCents: 45000,
          differenceCents: 5000,
          plbTotalCents: 0,
          balanced: false,
        },
      }),
    ];
    state.claims = [claim()];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const sanity = await screen.findByTestId("claims-sanity");
    expect(sanity.textContent).toContain("Carrier paid $500.00");
    expect(sanity.textContent).toContain("$50.00 out");
  });

  it("sends approving to its own page rather than growing a second button", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const open = await screen.findByTestId("approve-open-page");
    expect(open.getAttribute("href")).toBe("/rcm/remittances/b-1/approve");
    // And there is no approve BUTTON on this page at all.
    expect(screen.queryByTestId("approve-button")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 — THE ANCHORED PANELS
// ═══════════════════════════════════════════════════════════════════════════

describe("save for tomorrow and set aside are anchored, not modal", () => {
  /**
   * IN NORMAL FLOW, and still ABOVE the claim list in document order.
   *
   * An element that is neither fixed nor absolutely positioned cannot cover a
   * later sibling — so those two facts together ARE the rule, and they are
   * checkable in jsdom where a pixel measurement would be meaningless.
   */
  async function openAndAssert(trigger: string, panel: string) {
    state.checks = [check()];
    state.claims = [claim()];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    const view = renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId(trigger));
    const dialog = await screen.findByTestId(panel);

    // 1. NO out-of-flow positioning, on the panel or on any ancestor up to the
    //    page — an overlay anywhere in that chain would lift it out of flow.
    for (let el: HTMLElement | null = dialog; el; el = el.parentElement) {
      const cls = el.className ?? "";
      expect(typeof cls === "string" ? cls : "", `${el.tagName} is out of flow`).not.toMatch(
        /\b(fixed|absolute|sticky)\b/,
      );
      if (el.dataset.testid === "rcm-remittance-detail") break;
    }

    // 2. It is not a dialog and it is not portalled out of the page.
    expect(dialog.getAttribute("role")).not.toBe("dialog");
    expect(view.container.contains(dialog)).toBe(true);

    // 3. THE CLAIM LIST IS STILL THERE, and it FOLLOWS the panel — so the panel
    //    pushed it down rather than sitting on top of it.
    const claimRow = screen.getByTestId("claim-card-c-1");
    expect(claimRow).toBeTruthy();
    const order = dialog.compareDocumentPosition(claimRow);
    expect(
      Boolean(order & Node.DOCUMENT_POSITION_FOLLOWING),
      "the claim list is not after the panel",
    ).toBe(true);
  }

  it("save for tomorrow does not cover the claim list", async () => {
    await openAndAssert("check-park", "check-park-dialog");
  });

  it("set aside does not cover the claim list", async () => {
    await openAndAssert("check-set-aside", "check-set-aside-dialog");
  });

  it("set aside offers the new reason, and still demands words for 'something else'", async () => {
    state.checks = [check()];
    state.claims = [claim()];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("check-set-aside"));
    // Stage C's ADDITIVE value, and the five that were already there.
    for (const reason of [
      "target_gone",
      "duplicate",
      "posted_by_hand",
      "not_ours",
      "sent_in_error",
      "other",
    ]) {
      expect(
        screen.getByTestId(`check-set-aside-reason-${reason}`),
        `no ${reason} option`,
      ).toBeTruthy();
    }
    // `target_gone` STAYS — it is the case the feature was built for — and its
    // label is the reworded one.
    expect(screen.getByTestId("check-set-aside-dialog").textContent).toContain(
      "The claims aren't in Open Dental any more",
    );
    expect(screen.getByTestId("check-set-aside-dialog").textContent).toContain(
      "The carrier sent it in error",
    );

    // …and the rule about `other` is unchanged.
    fireEvent.click(screen.getByTestId("check-set-aside-reason-other"));
    expect((screen.getByTestId("check-set-aside-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — SHADOW MODE
// ═══════════════════════════════════════════════════════════════════════════

describe("shadow mode explains itself and carries the worksheet", () => {
  it("says what is true, what is safe, what changes, and who can switch it on", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.queue = { ...QUEUE, postingEnabled: true, drainEnabled: false };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const banner = await screen.findByTestId("shadow-mode-banner");
    expect(banner.textContent).toContain("Posting is switched off");
    expect(banner.textContent).toContain("Everything you do here still counts");
    expect(banner.textContent).toContain("the same button posts these checks");
    expect(screen.getByTestId("shadow-who-can").textContent).toContain("Who can switch this on?");
  });

  it("carries the same roll-up the approve page shows, and it is printable", async () => {
    state.checks = [check()];
    state.claims = [claim()];
    state.queue = { ...QUEUE, postingEnabled: true, drainEnabled: false };
    state.approval = {
      office: "roland",
      batchId: "b-1",
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [approvalClaim()],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const table = await screen.findByTestId("shadow-would-have-done");
    expect(table.textContent).toContain("What this app would have done");
    // The SAME figures the verdict carries — not a second calculation.
    expect(screen.getByTestId("shadow-total").textContent).toContain("$450.00");
    // The print stylesheet keys off this class; without it File → Print gives a
    // screenshot of an app rather than the worksheet.
    expect(table.className).toContain("rcm-print-worksheet");
    expect(screen.getByTestId("shadow-print")).toBeTruthy();
  });

  it("does NOT appear when posting is simply not switched on for the practice", async () => {
    /*
     * A practice D-7 has never validated is not "in shadow mode" — it is not set
     * up. Showing both would offer two explanations for one silence, and the
     * biller would have to guess which one an admin can act on.
     */
    state.checks = [check()];
    state.claims = [claim()];
    state.queue = { ...QUEUE, postingEnabled: false, drainEnabled: false };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("claims-sanity")).toBeTruthy());
    expect(screen.queryByTestId("shadow-mode-banner")).toBeNull();
  });
});
