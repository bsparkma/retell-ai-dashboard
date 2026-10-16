/**
 * W-21 — the two things the screens learned: `outcome_unknown`, and a run that
 * stopped DURING `confirm_patient`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A CRASH AT confirm_patient IS STOPPED, NEVER MEASURED (PM ruling 2026-10-12)
 * ═════════════════════════════════════════════════════════════════════════════
 * The check EXISTS in Open Dental in this case, so the plan is
 * `partially_posted` — and the drain records its step as
 * `confirm_patient_interrupted`, never `confirm_patient`, because the W-16 key
 * (`stuckKind`) reads `confirm_patient` as "the measurement completed". The
 * human outcome asserted here: the check number and "do not enter this payment
 * by hand", with ZERO figures and no promised-vs-measured pair.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * outcome_unknown READS AS ITSELF
 * ═════════════════════════════════════════════════════════════════════════════
 * Not "failed" (nothing moved), not "posted", never "nothing was written", never
 * the run's own error text — and it stays pressable, because the press is what
 * settles it. A guard no case exercises is not a guard, so every surface that
 * shows a posting status renders a row in this state below.
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

/** A dollar figure, as `money()` prints one. */
const FIGURE = /\$\s?\d/;

const NOTHING_WRITTEN = /nothing (was|has been) (written|sent)|no open dental call|no check was created|starts clean/i;

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

// ═════════════════════════════════════════════════════════════════════════════
// 1. A CRASH AT confirm_patient
// ═════════════════════════════════════════════════════════════════════════════

describe("W-21 · a crash at confirm_patient renders as STOPPED", () => {
  it("is a stopped step to the W-16 key, and names where it stopped in plain words", () => {
    expect(POSTING_STEPS).toContain("confirm_patient_interrupted");
    expect(stuckKind({ status: "partially_posted", step: "confirm_patient_interrupted" })).toBe("stopped");
    expect(STEP_COPY.confirm_patient_interrupted).toBe("Starting to check what the patient owes now");
    expect(stoppedWhile("confirm_patient_interrupted")).toBe(
      "while starting to check what the patient owes now",
    );
  });

  it("shows the check number and do-not-re-enter, with ZERO figures and no measured pair", async () => {
    state.confirmed = { "c-1": STALE_RED }; // even a red verdict on record must not surface
    const { container } = renderAt(
      <StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />,
    );

    expect(screen.getByTestId("stuck-stopped")).toBeTruthy();
    // THE PROOF: the check exists, and the payment must not be entered again.
    const proof = screen.getByTestId("stuck-stopped-no-reentry").textContent ?? "";
    expect(proof).toContain("#21436");
    expect(proof).toMatch(/do not enter the payment by hand/i);
    expect(screen.getByTestId("stuck-stopped-step").textContent).toContain(
      "while starting to check what the patient owes now",
    );

    for (const id of MEASURED_IDS) expect(screen.queryByTestId(id), id).toBeNull();

    const text = container.textContent ?? "";
    expect(text, "no figure of any kind").not.toMatch(FIGURE);
    // The measured PAIR, by its own two headings. ("…with what this check
    // promised" is the stopped screen saying nothing was compared — allowed.)
    expect(text).not.toMatch(/What this app promised|What the chart says/i);
    expect(text).not.toContain("injected failure");

    // It never went looking for a measurement.
    await act(async () => {});
    expect(state.calls.filter((c) => c.startsWith("getClaim"))).toEqual([]);
    expect(state.calls).not.toContain("recheckPosting");
  });

  it("on the check's own page: the stopped screen, never the green proof with an amount", async () => {
    state.confirmed = { "c-1": STALE_RED };
    state.detail = detail();
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("stuck-stopped");
    expect(screen.getByTestId("stuck-stopped-no-reentry").textContent).toContain("#21436");
    for (const id of MEASURED_IDS) expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.queryByTestId("post-this-check-last-error")).toBeNull();
  });

  it("on the Posting history: the stopped row, not the measured one", async () => {
    state.queue = queuePage([planRow()], { partially_posted: 1 });
    const { container } = renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");
    expect(screen.getByTestId("posting-stopped-q-1")).toBeTruthy();
    expect(screen.queryByTestId("posting-measured-q-1")).toBeNull();
    expect(container.textContent).not.toContain("injected failure");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. outcome_unknown, on every surface
// ═════════════════════════════════════════════════════════════════════════════

const UNKNOWN = {
  status: "outcome_unknown",
  statusLabel: "outcome_unknown",
  step: "check",
  postedTotalCents: 0,
  lastError: "POST /claimpayments: ECONNRESET. NOTHING was written.",
};

describe("W-21 · outcome_unknown reads as itself", () => {
  it("has copy, a hint and a rail step — none of which claims either answer", () => {
    expect(QUEUE_STATE_COPY.outcome_unknown.label).toBe("Not confirmed yet");
    const row = planRow(UNKNOWN) as never;
    expect(queueHint(row)).toBe(OUTCOME_UNKNOWN_COPY);
    expect(queueHint(row)).toMatch(/Do not enter this payment by hand/);
    expect(queueHint(row)).not.toMatch(NOTHING_WRITTEN);
    const step = postStepFor(row);
    expect(step.state).toBe("blocked");
    expect(step.detail).toBe(OUTCOME_UNKNOWN_COPY);
  });

  it("on the check's own page: its chip, its hint, the check number — and it can be pressed", async () => {
    state.detail = detail(UNKNOWN);
    const { container } = renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("post-this-check");

    expect(screen.getByTestId("post-this-check-state").textContent).toContain("Not confirmed yet");
    expect(screen.getByTestId("post-this-check-hint").textContent).toBe(OUTCOME_UNKNOWN_COPY);
    expect(screen.getByTestId("post-this-check-earlier-check").textContent).toContain("#21436");
    const press = screen.getByTestId("post-this-check-button") as HTMLButtonElement;
    expect(press.disabled, "a row with no exit is a trap").toBe(false);

    // Never the green proof with an amount, never a stuck screen, never the run's text.
    expect(screen.queryByTestId("post-this-check-proof")).toBeNull();
    expect(screen.queryByTestId("stuck-stopped")).toBeNull();
    for (const id of MEASURED_IDS) expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.queryByTestId("post-this-check-last-error")).toBeNull();
    expect(container.textContent).not.toMatch(NOTHING_WRITTEN);
    expect(container.textContent).not.toContain("ECONNRESET");
  });

  it("with no check on record, it still says not to enter the payment by hand", async () => {
    state.detail = detail({ ...UNKNOWN, odClaimPaymentNum: null });
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("post-this-check");
    expect(screen.queryByTestId("post-this-check-earlier-check")).toBeNull();
    expect(screen.getByTestId("post-this-check-hint").textContent).toMatch(
      /Do not enter this payment by hand/,
    );
  });

  it("on the Posting history: its own panel, and the Post button stays live with only it waiting", async () => {
    state.queue = queuePage([planRow(UNKNOWN)], { outcome_unknown: 1 });
    const { container } = renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");

    expect(screen.getByTestId("posting-state-q-1").textContent).toBe("Not confirmed yet");
    const panel = screen.getByTestId("posting-unknown-q-1").textContent ?? "";
    expect(panel).toContain("#21436");
    expect(panel).toMatch(/do not enter the payment by hand/i);
    expect(screen.queryByTestId("posting-stopped-q-1")).toBeNull();
    expect(screen.queryByTestId("posting-measured-q-1")).toBeNull();

    const drain = screen.getByTestId("posting-drain-roland") as HTMLButtonElement;
    expect(drain.disabled, "the press that settles it must be offered").toBe(false);
    expect(container.textContent).not.toMatch(NOTHING_WRITTEN);
    expect(container.textContent).not.toContain("ECONNRESET");
  });
});
