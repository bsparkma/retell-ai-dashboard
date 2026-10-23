/**
 * W-21c — the dead presses W-21b left: a `partially_posted` plan over a deleted
 * claim, and the office-wide Drain count that still called such plans waiting.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. partially_posted AT read_od_truth_claim_gone
 * ═════════════════════════════════════════════════════════════════════════════
 * Money provably landed, then the claim was deleted. Every press reads the same
 * 404. It gets W-21b's treatment: situation named, the chart-check instruction,
 * no Post offered. An ordinary partially_posted row is pinned unchanged.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. THE OFFICE-WIDE COUNT
 * ═════════════════════════════════════════════════════════════════════════════
 * The server counts claim-gone plans apart (`claimGone`). "Waiting to post"
 * leaves them out; they are named on their own. They stay drainable (D-15).
 *
 * NO REAL PATIENT DATA. Synthetic names; PatNum 12827 is the documented fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { ClaimVerdict, PostingQueueDetail } from "@/features/rcm/api";
import { POSTING_STEPS } from "@/features/rcm/api";
import {
  OUTCOME_UNKNOWN_COPY,
  QUEUE_STATE_COPY,
  queueHint,
  STEP_COPY,
  stoppedWhile,
  stuckKind,
} from "@/features/rcm/posting";
import { postStepFor } from "@/features/rcm/flow";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: { status: "loading" } as unknown,
  detail: null as unknown,
  confirmed: {} as Record<string, unknown>,
  queue: null as unknown,
  calls: [] as string[],
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => state.auth };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      { officeId: "roland", officeName: "Roland Family Dental", odConnected: true, odBlockedReason: null, odHealth: null },
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
    getPostingPlan: vi.fn(async () => {
      state.calls.push("getPostingPlan");
      return state.detail;
    }),
    getClaim: vi.fn(async (office: string, claimId: string) => {
      state.calls.push(`getClaim:${claimId}`);
      return {
        office,
        claim: {
          claimId,
          patientName: "Test 2, Stedi",
          odPatientId: 12827,
          odClaimNum: 53648,
          verdict: state.confirmed[claimId],
          confirmedAt: state.confirmed[claimId] ? "2026-03-05T18:58:00.000Z" : null,
        },
        writeoffReasons: [],
        matchRules: {},
      };
    }),
    getRcmOfficeSettings: vi.fn(async () => {
      state.calls.push("getRcmOfficeSettings");
      return null;
    }),
    recheckPosting: vi.fn(async () => {
      state.calls.push("recheckPosting");
      return null;
    }),
    drainPostingQueue: vi.fn(() => new Promise(() => {})),
    listPostingQueue: vi.fn(async () => state.queue),
  };
});

import { StuckAfterPosting } from "@/components/rcm/PostedOutcome";
import PostThisCheck from "@/components/rcm/PostThisCheck";
import PostingQueue from "@/pages/rcm/PostingQueue";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path = "/rcm/remittances/b-1") {
  const memory = memoryLocation({ path, record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const ADMIN = {
  status: "authenticated",
  user: {
    name: "Admin Person",
    email: "admin@example.invalid",
    isSuperAdmin: false,
    permissions: ["rcm.read", "rcm.queue", "rcm.write", "rcm.post", "rcm.settings"],
  },
};

// ─── Fixtures — synthetic only ───────────────────────────────────────────────

/** What a crash leaves in `lastError`: a database message, never a measurement. */
const CRASH_ERROR =
  "FakeRcmDb: injected failure on: UPDATE rcm_claims SET confirmed_verdict = $3";

/** A red verdict ON RECORD — the stopped screen must not go looking for it. */
const STALE_RED: ClaimVerdict = {
  state: "red",
  register: "confirmed",
  eobPatientCents: 3000,
  projectedPatientCents: 3000,
  decidedWriteOffCents: 3000,
  contractualWriteOffCents: 32900,
  decisions: [],
  problems: [{ kind: "chart_disagrees", code: "D0274", lineId: "l-2", detail: "D0274 reads $30.00." }],
  sentence: "Open Dental says the patient owes $30.00 — this check said $0.00.",
};

function planRow(over: Record<string, unknown> = {}) {
  return {
    queueId: "q-1",
    office: "roland",
    batchId: "b-1",
    status: "partially_posted",
    statusLabel: "partially_posted",
    blockedReason: null,
    withdrawnReason: null,
    withdrawnNote: null,
    withdrawnAt: null,
    step: "confirm_patient_interrupted",
    isRecoupment: false,
    documentAttachStatus: null,
    carrierEobDate: "2026-03-01",
    intendedTotalCents: 48000,
    postedTotalCents: 48000,
    odClaimPaymentNum: 21436,
    reconciledAt: null,
    approvedAt: "2026-03-05T18:50:00.000Z",
    approvedBy: "Billing User",
    startedAt: "2026-03-05T18:57:00.000Z",
    finishedAt: "2026-03-05T18:58:00.000Z",
    drainAttemptAt: "2026-03-05T18:57:00.000Z",
    drainedBy: "Billing User",
    attemptCount: 1,
    lastError: CRASH_ERROR,
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL",
    ...over,
  };
}

function detail(plan: Record<string, unknown> = {}): PostingQueueDetail {
  return {
    office: "roland",
    plan: planRow(plan),
    lines: [
      {
        queueLineId: "ql-1",
        position: 1,
        odClaimNum: 53648,
        odClaimProcNum: 533930,
        status: "paid",
        skipReason: null,
        intendedInsPayAmtCents: 48000,
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
        intendedPatientCents: 0,
        odWriteoffAdjustmentNum: null,
      },
    ],
    claims: [{ claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", odClaimNum: 53648 }],
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
    documentAttach: {
      implemented: true,
      status: null,
      error: null,
      at: null,
      documents: [],
      canRetry: true,
      retryRequires: "rcm.post",
    },
  } as unknown as PostingQueueDetail;
}

function queuePage(rows: Record<string, unknown>[], byStatus: Record<string, number>) {
  return {
    office: "roland",
    rows,
    byStatus: {
      approved: 0,
      posting: 0,
      posted: 0,
      failed: 0,
      partially_posted: 0,
      blocked: 0,
      withdrawn: 0,
      outcome_unknown: 0,
      ...byStatus,
    },
    total: rows.length,
    limit: 50,
    offset: 0,
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
  };
}



import {
  CLAIM_GONE_COPY,
  CLAIM_GONE_STATUSES,
  CLAIM_GONE_STEP,
  POST_AGAIN_SAFE,
  claimGone,
} from "@/features/rcm/posting";

/** A dollar figure, as `money()` prints one. */
const FIGURE = /\$\s?\d/;
const PRESS_AGAIN = /press post/i;

/** The measured screen, every piece of it. None may appear on a stopped check. */
const MEASURED_IDS = [
  "stuck-measured",
  "stuck-money-landed",
  "stuck-numbers",
  "stuck-promised",
  "stuck-measured-figure",
  "stuck-consequence",
  "stuck-steps",
  "stuck-recheck",
  "stuck-resolved",
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.auth = ADMIN;
  state.detail = null;
  state.confirmed = {};
  state.queue = null;
  state.calls = [];
});

afterEach(cleanup);

/** What the drain leaves when a claim is deleted under a plan that provably posted. */
const PARTLY_GONE = {
  status: "partially_posted",
  statusLabel: "partially_posted",
  step: "read_od_truth_claim_gone",
  lastError:
    "Open Dental has no claim 53648 in this office, but this plan has already written to a chart on a previous attempt.",
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. partially_posted OVER A DELETED CLAIM
// ═════════════════════════════════════════════════════════════════════════════

describe("W-21c · partially_posted over a deleted claim gets the claim-gone treatment", () => {
  it("the predicate, hint and rail all name it — never a press", () => {
    expect([...CLAIM_GONE_STATUSES]).toEqual(["outcome_unknown", "partially_posted"]);
    const row = planRow(PARTLY_GONE) as never;
    expect(claimGone(row)).toBe(true);
    expect(stuckKind(row)).toBe("stopped");
    expect(queueHint(row)).toBe(CLAIM_GONE_COPY);
    const step = postStepFor(row);
    expect(step.state).toBe("blocked");
    expect(step.detail).toBe(CLAIM_GONE_COPY);
  });

  it("on the check's own page: no Post button, the situation named, the chart-check instruction, no tomorrow card", async () => {
    state.confirmed = { "c-1": STALE_RED }; // a red verdict on record must still not surface
    state.detail = detail(PARTLY_GONE);
    const { container } = renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("stuck-stopped");

    expect(screen.queryByTestId("post-this-check-button"), "a dead press is not offered").toBeNull();
    expect(screen.getByTestId("post-this-check-not-postable").textContent).toBe(CLAIM_GONE_COPY);

    const next = screen.getByTestId("stuck-claim-gone-next").textContent ?? "";
    expect(next).toMatch(/deleted from Open Dental/);
    expect(next).toMatch(/Look at the patient.s chart in Open Dental/);
    expect(next).toMatch(/only if the money isn.t there/);
    expect(screen.getByTestId("stuck-stopped-no-reentry").textContent).toContain("#21436");
    expect(screen.getByTestId("stuck-stopped-step").textContent).toContain(
      "while reading Open Dental and finding the claim no longer there",
    );

    // The ordinary stopped promises are gone: resume, don't-touch-the-chart, finishes-tomorrow.
    expect(screen.queryByTestId("stuck-stopped-next")).toBeNull();
    expect(screen.queryByTestId("stuck-stopped-nothing-measured")).toBeNull();
    expect(screen.queryByTestId("stuck-tomorrow")).toBeNull();
    for (const id of MEASURED_IDS) expect(screen.queryByTestId(id), id).toBeNull();

    const stuck = screen.getByTestId("stuck-stopped").textContent ?? "";
    expect(stuck, "no figure").not.toMatch(FIGURE);
    expect(container.textContent).not.toMatch(PRESS_AGAIN);
    expect(container.textContent, "never the run's own text").not.toContain("already written to a chart");
  });

  it("with no check on record it does not say 'do not enter it by hand' — the instruction is conditional", async () => {
    state.detail = detail({ ...PARTLY_GONE, odClaimPaymentNum: null });
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("stuck-stopped");
    expect(screen.getByTestId("stuck-stopped-no-reentry").textContent).toBe(
      "Part of it may already be in Open Dental.",
    );
  });

  it("on the Posting history: the claim-gone panel, not the stopped one, and no press-again", async () => {
    state.queue = queuePage([planRow(PARTLY_GONE)], { partially_posted: 1 });
    renderAt(<PostingQueue />, "/rcm/posting");
    const card = await screen.findByTestId("posting-plan-q-1");

    expect(screen.getByTestId("posting-state-q-1").textContent).toBe("Partly posted");
    expect(screen.getByTestId("posting-hint-q-1").textContent).toBe(CLAIM_GONE_COPY);
    expect(screen.getByTestId("posting-claim-gone-q-1").textContent).toContain("#21436");
    expect(screen.queryByTestId("posting-stopped-q-1")).toBeNull();
    expect(screen.queryByTestId("posting-measured-q-1")).toBeNull();
    expect(card.textContent).not.toMatch(PRESS_AGAIN);
  });
});

describe("W-21c · an ORDINARY partially_posted row is unchanged", () => {
  const ORDINARY = { ...PARTLY_GONE, step: "confirm_patient_interrupted" };

  it("predicate, hint and rail", () => {
    const row = planRow(ORDINARY) as never;
    expect(claimGone(row)).toBe(false);
    expect(queueHint(row)).toBe(QUEUE_STATE_COPY.partially_posted.hint);
    expect(postStepFor(row).detail).toBe(
      "Money reached the chart and the posting stopped part-way. The lines below say exactly where.",
    );
  });

  it("the check page still offers Post, and the stopped screen keeps its own three promises", async () => {
    state.detail = detail(ORDINARY);
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("stuck-stopped");
    expect((screen.getByTestId("post-this-check-button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("stuck-stopped-next").textContent).toMatch(/Post to Open Dental/);
    expect(screen.getByTestId("stuck-stopped-nothing-measured")).toBeTruthy();
    expect(screen.getByTestId("stuck-tomorrow")).toBeTruthy();
    expect(screen.queryByTestId("stuck-claim-gone-next")).toBeNull();
  });

  it("the history still shows the stopped panel with its press-again sentence", async () => {
    state.queue = queuePage([planRow(ORDINARY)], { partially_posted: 1 });
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");
    expect(screen.getByTestId("posting-stopped-q-1").textContent).toMatch(/Press Post to Open Dental again/);
    expect(screen.queryByTestId("posting-claim-gone-q-1")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE OFFICE-WIDE COUNT
// ═════════════════════════════════════════════════════════════════════════════

describe("W-21c · the office-wide Drain count leaves claim-gone plans out", () => {
  it("only claim-gone plans: nothing waiting, the button greyed with its reason, the plan named apart", async () => {
    const gone = planRow({ ...PARTLY_GONE, status: "outcome_unknown", statusLabel: "outcome_unknown" });
    state.queue = { ...queuePage([gone], { outcome_unknown: 1 }), claimGone: 1 };
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");

    const drain = screen.getByTestId("posting-drain-roland") as HTMLButtonElement;
    expect(drain.disabled, "a press would settle nothing").toBe(true);
    expect(drain.textContent).not.toMatch(/Post 1 to Open Dental/);
    expect(screen.getByTestId("posting-counts-roland").textContent).toMatch(/^All time: 0 waiting/);
    expect(screen.getByTestId("posting-claim-gone-count-roland").textContent).toBe(
      " · 1 whose claim is no longer in Open Dental",
    );
    expect(screen.getByText("Nothing waiting to post.")).toBeTruthy();
  });

  it("beside a real waiting plan, the count is the real one", async () => {
    const gone = planRow({ ...PARTLY_GONE, queueId: "q-gone" });
    const ready = planRow({
      queueId: "q-ready",
      status: "approved",
      statusLabel: "queued",
      step: null,
      attemptCount: 0,
      odClaimPaymentNum: null,
      lastError: null,
    });
    state.queue = { ...queuePage([gone, ready], { partially_posted: 1, approved: 1 }), claimGone: 1 };
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-ready");

    const drain = screen.getByTestId("posting-drain-roland") as HTMLButtonElement;
    expect(drain.disabled).toBe(false);
    expect(drain.textContent).toMatch(/Post 1 to Open Dental/);
    expect(screen.getByTestId("posting-counts-roland").textContent).toMatch(/^All time: 1 waiting/);
  });

  it("with no claim-gone plan (or an older server that omits the field) the header is unchanged", async () => {
    const unknown = planRow({ ...PARTLY_GONE, status: "outcome_unknown", statusLabel: "outcome_unknown", step: "check" });
    state.queue = queuePage([unknown], { outcome_unknown: 1 }); // no `claimGone` key at all
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");
    expect(screen.queryByTestId("posting-claim-gone-count-roland")).toBeNull();
    expect(screen.getByTestId("posting-counts-roland").textContent).toBe(
      "All time: 1 waiting · 0 posted · 0 stuck · 1 total",
    );
    expect((screen.getByTestId("posting-drain-roland") as HTMLButtonElement).disabled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE MIRRORED NEGATIVES (PM ruling 2026-10-23)
// ═════════════════════════════════════════════════════════════════════════════
//
// The W-16 suites now except exactly CLAIM_GONE_STEP from their press-again
// assertions. These are the other half of that carve-out: the claim-gone screen,
// in BOTH statuses, must never offer the press; every OTHER stopped step must
// still render the ordinary screen. Neither half may silently widen.

/** Every way a screen offers the next posting pass. */
const PRESS_SENTENCES = ["resumes from what the chart shows", POST_AGAIN_SAFE];

function assertNoPress(text: string, label: string) {
  for (const s of PRESS_SENTENCES) expect(text, `${label}: "${s}"`).not.toContain(s);
  expect(text, label).not.toMatch(PRESS_AGAIN);
}

describe("W-21c · NEGATIVE: the claim-gone screen never offers the press — both statuses", () => {
  for (const status of CLAIM_GONE_STATUSES) {
    const row = { ...PARTLY_GONE, status, statusLabel: status, step: CLAIM_GONE_STEP };

    it(`${status}: the check page has no Post button and no press-again sentence`, async () => {
      state.detail = detail(row);
      const { container } = renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
      await screen.findByTestId("post-this-check");
      expect(screen.queryByTestId("post-this-check-button"), status).toBeNull();
      expect(screen.queryByTestId("stuck-stopped-next"), status).toBeNull();
      expect(screen.getByTestId("post-this-check-not-postable").textContent).toBe(CLAIM_GONE_COPY);
      assertNoPress(container.textContent ?? "", status);
    });

    it(`${status}: the history row and the rail offer no press either`, async () => {
      state.queue = { ...queuePage([planRow(row)], { [status]: 1 }), claimGone: 1 };
      renderAt(<PostingQueue />, "/rcm/posting");
      const card = await screen.findByTestId("posting-plan-q-1");
      assertNoPress(card.textContent ?? "", status);
      expect(postStepFor(planRow(row) as never).detail).toBe(CLAIM_GONE_COPY);
    });
  }
});

describe("W-21c · POSITIVE: every OTHER stopped step still renders the ordinary screen", () => {
  // Enumerated in full: every step the W-16 loop covers, minus ONLY the excepted one.
  const ordinary = [null, ...POSTING_STEPS.filter((s) => s !== "confirm_patient" && s !== CLAIM_GONE_STEP)];

  it("the carve-out removes exactly one step", () => {
    expect(ordinary.length).toBe(POSTING_STEPS.length - 2 + 1);
    expect(ordinary).not.toContain(CLAIM_GONE_STEP);
  });

  for (const step of ordinary) {
    it(`partially_posted at ${String(step)}: the press is offered, the ordinary stopped screen renders`, async () => {
      const row = { ...PARTLY_GONE, step };
      expect(claimGone(planRow(row) as never)).toBe(false);
      state.detail = detail(row);
      renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
      await screen.findByTestId("stuck-stopped");
      expect((screen.getByTestId("post-this-check-button") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByTestId("stuck-stopped-next").textContent).toContain(
        "resumes from what the chart shows",
      );
      expect(screen.getByTestId("stuck-tomorrow")).toBeTruthy();
      expect(screen.queryByTestId("stuck-claim-gone-next")).toBeNull();
    });
  }

  it("outcome_unknown at an ordinary step still offers the press (W-21)", async () => {
    const row = { ...PARTLY_GONE, status: "outcome_unknown", statusLabel: "outcome_unknown", step: "check" };
    state.detail = detail(row);
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("post-this-check");
    expect((screen.getByTestId("post-this-check-button") as HTMLButtonElement).disabled).toBe(false);
  });
});
