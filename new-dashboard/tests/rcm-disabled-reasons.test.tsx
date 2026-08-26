/**
 * EVERY DISABLED CONTROL ON AN RCM SCREEN SAYS WHY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TEST IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * §15.2, finding 4: the Drain button is greyed at `0 waiting` with nothing on
 * screen saying so, and it cost real time on the §10.4 walk — a disabled
 * control with no reason is indistinguishable from a broken one, so a step that
 * was already guaranteed read as untestable.
 *
 * The rule that fixes it is easy to write once and easy to forget on the next
 * control. So it is scanned rather than remembered: each screen below is
 * rendered in the states where something is greyed, and every `[disabled]`
 * element in the tree must have a `[data-disabled-reason]` beside it —
 * `DisabledReason`'s marker, which is the whole reason that component exists
 * instead of a `<span>` copied eleven times.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "BESIDE IT" MEANS WITHIN TWO ANCESTORS
 * ─────────────────────────────────────────────────────────────────────────────
 * A reason is a sibling of the button, or a sibling of the small wrapper the
 * button sits in — which is what the layouts on these pages actually do. Any
 * looser and a reason at the top of the page would "cover" a button at the
 * bottom, which is precisely the thing being prevented.
 *
 * A `title` attribute does NOT count. The practice reads these screens on a
 * tablet at the front desk and there is no hover on a tablet.
 *
 * NO NETWORK, NO PHI. Every payer, patient and figure is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

const CLAIM = {
  claimId: "c-1",
  officeId: "roland",
  claimNumber: "CLM-1",
  checkNumber: "830200001",
  patientName: "Stedi Test 2",
  odPatientId: 12827,
  odClaimNum: 53784,
  payer: "SYNTHETIC DENTAL",
  serviceDate: "2026-03-01",
  receivedDate: "2026-03-05",
  status: "pending_review",
  paymentStatus: "paid",
  insuranceType: "primary",
  totalBilledCents: 20000,
  totalAllowedCents: 15000,
  totalPaidCents: 12000,
  totalDeductibleCents: 0,
  patientBalanceCents: 3000,
  needsReviewReasons: [] as string[],
  extractionConfidence: 1,
  odMatchStatus: "confirmed",
  rejectedCandidates: 0,
  odMatchAt: "2026-03-06T15:00:00.000Z",
  odMatchConfirmedAt: "2026-03-06T15:05:00.000Z",
  odMatchedBy: "biller@example.invalid",
  reviewedAt: null as string | null,
  reviewedBy: null as string | null,
  reviewNote: null as string | null,
  postingQueueId: null as string | null,
  approvedAt: null as string | null,
  createdAt: "2026-03-05T12:00:00.000Z",
  lines: [] as unknown[],
  provenance: null as unknown,
  matchSnapshotStale: false,
};

/** Two candidates, one confirmed — the state that greys the other's Confirm. */
const SNAPSHOT = {
  version: 3,
  fetchedAt: "2026-03-06T15:00:00.000Z",
  office: "roland",
  officeName: "Roland Family Dental",
  odCalls: 4,
  truncated: false,
  notes: [] as string[],
  patientsConsidered: [{ patNum: 12827, name: "Stedi Test 2" }],
  ambiguous: false,
  margin: 20,
  rejectedCandidates: 0,
  rejectedReasons: { nameMismatch: 0, belowScore: 0 },
  minScore: 40,
  nameRuleApplied: true,
  candidates: [53784, 53785].map((odClaimNum, i) => ({
    odClaimNum,
    odPatNum: 12827,
    score: 90 - i * 20,
    confidence: i === 0 ? "HIGH" : "MEDIUM",
    evidence: [],
    blockers: [],
    od: {
      patientName: "Stedi Test 2",
      dateService: "2026-03-01",
      claimStatus: "Sent",
      billedCents: 20000,
      unknownDeletedLineCount: 0,
    },
    linePairs: [],
  })),
  confirmed: {
    odClaimNum: 53784,
    odPatNum: 12827,
    confirmedAt: "2026-03-06T15:05:00.000Z",
    confirmedBy: "biller@example.invalid",
    linePairs: [],
    odAmountsAsRead: {},
  },
  supersededConfirmation: null,
};

const REMITTANCE = {
  batchId: "b-1",
  officeId: "roland",
  payer: "SYNTHETIC DENTAL",
  checkNumber: "830200001",
  eftNumber: null,
  traceNumber: null,
  paymentMethod: "check",
  depositDate: "2026-03-04",
  totalAmountCents: 12000,
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
    batchTotalCents: 12000,
    claimTotalCents: 12000,
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
  upload: null,
  plbAdjustments: [] as unknown[],
};

/** A reviewer's preview: the checklist renders, the button cannot be pressed. */
const PREVIEW_READ_ONLY = {
  office: "roland",
  batchId: "b-1",
  canApprove: false,
  approveRequires: "rcm.write",
  claims: [
    {
      claimId: "c-1",
      claimNumber: "CLM-1",
      patientName: "Stedi Test 2",
      postable: false,
      alreadyQueued: false,
      failed: ["REVIEWED"],
      checks: [
        {
          code: "MATCH_CONFIRMED",
          label: "Matched to an Open Dental claim",
          passed: true,
          detail: "ClaimNum 53784",
          fix: "Open the claim, run the match, and confirm the right one.",
        },
        {
          code: "REVIEWED",
          label: "Reviewed by a person",
          passed: false,
          detail: "nobody has dispositioned this claim",
          fix: "Mark the claim reviewed, with a note.",
        },
      ],
    },
  ],
  postableCount: 0,
  withheldCount: 1,
  queuedCount: 0,
  balanced: true,
  differenceCents: 0,
};

const PLAN = {
  queueId: "q-1",
  office: "roland",
  batchId: "b-1",
  status: "posted",
  statusLabel: "posted",
  blockedReason: null,
  step: null,
  isRecoupment: false,
  carrierEobDate: "2026-03-01",
  intendedTotalCents: 12000,
  postedTotalCents: 12000,
  odClaimPaymentNum: 4471,
  reconciledAt: "2026-03-07T15:00:00.000Z",
  approvedAt: "2026-03-06T15:00:00.000Z",
  approvedBy: "biller@example.invalid",
  startedAt: "2026-03-07T14:50:00.000Z",
  finishedAt: "2026-03-07T15:00:00.000Z",
  drainAttemptAt: "2026-03-07T14:50:00.000Z",
  drainedBy: "biller@example.invalid",
  attemptCount: 1,
  lastError: null,
  checkNumber: "830200001",
  payer: "SYNTHETIC DENTAL",
};

/** Nothing waiting, and no permission to drain even if there were. */
const QUEUE_PAGE = {
  office: "roland",
  rows: [PLAN],
  byStatus: {
    approved: 0,
    posting: 0,
    posted: 1,
    partially_posted: 0,
    failed: 0,
    blocked: 0,
  },
  total: 1,
  limit: 50,
  offset: 0,
  canDrain: false,
  drainRequires: "rcm.write",
  postingEnabled: true,
};

const fixtures = vi.hoisted(() => ({
  remittances: [] as unknown[],
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
    listRemittances: vi.fn(async () => ({
      office: "roland",
      view: "all",
      remittances: fixtures.remittances,
      total: fixtures.remittances.length,
      needsAttentionCount: fixtures.remittances.length,
      matchingCount: fixtures.remittances.length,
      limit: 50,
      offset: 0,
    })),
    getRemittance: vi.fn(async () => ({
      office: "roland",
      remittance: REMITTANCE,
      claims: [CLAIM],
    })),
    getClaim: vi.fn(async () => ({
      office: "roland",
      claim: { ...CLAIM, matchSnapshot: SNAPSHOT },
      matchRules: {
        amountNearCents: 100,
        dateNearDays: 3,
        ambiguityMargin: 10,
        bands: [{ band: "HIGH", min: 80 }],
      },
    })),
    getApprovalPreview: vi.fn(async () => PREVIEW_READ_ONLY),
    listPostingQueue: vi.fn(async () => QUEUE_PAGE),
    getPostingPlan: vi.fn(async () => ({
      office: "roland",
      plan: PLAN,
      lines: [],
      claims: [{ claimId: "c-1", claimNumber: "CLM-1", patientName: "Stedi Test 2", odClaimNum: 53784 }],
      canDrain: false,
      drainRequires: "rcm.write",
      postingEnabled: true,
      documentAttach: { implemented: false, note: "The EOB is filed in a later slice." },
    })),
  };
});

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    // A READER. The tier that meets the most disabled controls, which is
    // exactly the tier this scan should walk.
    useAuth: () => ({ user: { permissions: ["rcm.read"] }, loading: false }),
  };
});

import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import PostingQueue from "@/pages/rcm/PostingQueue";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string, searchPath = "") {
  // `searchHook` as well as `hook`: `?from=` and `?view=` are read through
  // wouter's search hook, and a memory router that only supplies `hook` leaves
  // those reading the jsdom URL instead.
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

/**
 * Every disabled control with nothing beside it saying why.
 *
 * Returns descriptions rather than elements, so a failure names the button
 * instead of printing the whole DOM.
 */
function unexplainedDisabledControls(): string[] {
  const controls = Array.from(document.querySelectorAll("[disabled]"));
  return controls
    .filter((el) => {
      // A reason may sit beside the control, or beside the small wrapper the
      // control is in. Two ancestors, no further — see the header.
      for (const scope of [el.parentElement, el.parentElement?.parentElement]) {
        if (scope?.querySelector("[data-disabled-reason]")) return false;
      }
      return true;
    })
    .map(
      (el) =>
        `<${el.tagName.toLowerCase()} data-testid="${el.getAttribute("data-testid") ?? "?"}"> ` +
        `"${(el.textContent ?? "").trim().slice(0, 40)}"`,
    );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.remittances = [REMITTANCE];
});
afterEach(cleanup);

describe("no RCM screen greys a control without saying why", () => {
  it("the remittance list — both pager ends", async () => {
    renderAt(<RemittanceList />, "/rcm/remittances");
    await screen.findByTestId("remittances-roland");
    expect(unexplainedDisabledControls()).toEqual([]);
  });

  it("the remittance detail, for somebody who cannot approve", async () => {
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("approval-panel");
    // The gate's own answer, not a role name this test knows.
    const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByTestId("approve-needs-permission").textContent).toContain("rcm.write");
    expect(unexplainedDisabledControls()).toEqual([]);
  });

  it("the claim screen, with one candidate confirmed and the other greyed", async () => {
    renderAt(<ClaimMatch />, "/rcm/claims/c-1", "?from=b-1");
    await screen.findByTestId("rcm-claim-match");

    // THE §15.2 CASE, exactly: confirm one and the other's button goes grey.
    // It used to go grey and say nothing, which reads as a bug to the person
    // who just clicked.
    const other = screen.getByTestId("confirm-53785") as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    expect(screen.getByTestId("confirm-reason-53785").textContent).toContain(
      "One claim per remittance — 53784 is linked",
    );

    // And the dead Approve button now names where approving lives.
    expect(screen.getByTestId("approve-disabled-reason").textContent).toContain(
      "Approving happens on the remittance",
    );

    expect(unexplainedDisabledControls()).toEqual([]);
  });

  it("the posting queue at zero waiting, for a reader", async () => {
    renderAt(<PostingQueue />, "/rcm/posting");
    // Wait for the BUTTON, not the section: the section renders before the
    // queue has loaded, and the button is what this test is about.
    const drain = (await screen.findByTestId("posting-drain-roland")) as HTMLButtonElement;
    expect(drain.disabled).toBe(true);
    // PERMISSION FIRST, ahead of the empty queue: it is the thing that will
    // still be true when a plan arrives.
    expect(screen.getByTestId("posting-drain-reason-roland").textContent).toContain("rcm.write");

    expect(unexplainedDisabledControls()).toEqual([]);
  });

  it("the posting queue at zero waiting, for somebody who CAN drain", async () => {
    const rcm = await import("@/features/rcm/api");
    vi.mocked(rcm.listPostingQueue).mockResolvedValueOnce({
      ...QUEUE_PAGE,
      canDrain: true,
    } as never);

    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-drain-roland");

    // §10.4's lost half hour, in one assertion.
    expect(screen.getByTestId("posting-drain-reason-roland").textContent).toContain(
      "Nothing waiting to drain.",
    );
    expect(unexplainedDisabledControls()).toEqual([]);
  });

  it("finds a control that has no reason — the scan is not vacuous", async () => {
    /*
     * A scan that silently matched nothing would pass forever. This asserts the
     * detector's teeth by rendering a greyed button with no reason beside it.
     */
    render(
      <div>
        <button disabled data-testid="lonely">
          Nope
        </button>
      </div>,
    );
    await waitFor(() => expect(screen.getByTestId("lonely")).toBeTruthy());
    expect(unexplainedDisabledControls().join(" ")).toContain("lonely");
  });
});
