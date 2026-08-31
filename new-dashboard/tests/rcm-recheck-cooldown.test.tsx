/**
 * THE RE-CHECK BUTTON RESTS BETWEEN PRESSES.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS WORTH A SUITE OF ITS OWN
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /posting/:id/recheck` is a READ — it asks Open Dental two questions and
 * writes nothing. That is what makes it safe to offer to a biller staring at a
 * check that is stuck. It is not what makes it free.
 *
 * Every press is two Open Dental calls, and RCM shares ONE Open Dental
 * credential with the voice side, paced at 1200ms per key (D-8). A stuck check
 * and an impatient person is a realistic pairing, and the honest failure mode is
 * not an outage — it is a drain queued behind somebody's fourth click.
 *
 * So the button rests for a few seconds after a press. The two claims here are
 * the ones that make that rest honest rather than merely present:
 *
 *  1. after a press the button REFUSES, and the refusal SAYS WHY it is resting
 *     rather than going quietly grey — a disabled control with no reason is the
 *     "contact your administrator" of buttons;
 *  2. the rest ENDS. A cooldown that never lifts is a dead end wearing a
 *     timer, and it would strand the one person who genuinely needs to look
 *     again.
 *
 * Both are asserted on the assembled component with the clock under our control,
 * because the interesting moment is between the two states and a real clock
 * would make this suite slow AND flaky at once.
 *
 * NO NETWORK, NO PHI. Every payer, patient, check number and figure is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

/** Resolved by the fake `recheckPosting`, one press at a time. */
const recheckCalls: string[] = [];

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    recheckPosting: vi.fn(async (_office: string, queueId: string) => {
      recheckCalls.push(queueId);
      return {
        office: "roland" as const,
        queueId,
        agreed: true,
        checkedAt: "2026-03-05T19:10:00.000Z",
        claims: [],
      };
    }),
  };
});

import { StuckAfterPosting } from "@/components/rcm/PostedOutcome";
import type { PostingQueueDetail } from "@/features/rcm/api";

// ─── Fixture ─────────────────────────────────────────────────────────────────
// A check whose payment landed and whose patient portion did not, which is the
// only state this screen is ever shown in.

const DETAIL = {
  office: "roland",
  plan: {
    queueId: "q-1",
    office: "roland",
    batchId: "b-1",
    status: "partially_posted",
    statusLabel: "partially_posted",
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
    reconciledAt: null,
    approvedAt: "2026-03-05T18:50:00.000Z",
    approvedBy: "Billing User",
    startedAt: "2026-03-05T18:57:00.000Z",
    finishedAt: "2026-03-05T18:58:00.000Z",
    drainAttemptAt: "2026-03-05T18:57:00.000Z",
    drainedBy: "Billing User",
    attemptCount: 1,
    lastError: "Open Dental says the patient owes $60.00 on D0274 — this check said $0.00.",
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL",
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
      decidedWriteOffCents: 3000,
      decidedReason: "X-rays — bitewings",
      decidedBy: "reviewer@carein.ai",
      intendedPatientCents: 45000,
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
} as unknown as PostingQueueDetail;

function renderStuck() {
  const { hook } = memoryLocation({ path: "/rcm/remittances/b-1", static: false });
  return render(
    <WouterRouter hook={hook}>
      <StuckAfterPosting detail={DETAIL} office="roland" batchId="b-1" />
    </WouterRouter>,
  );
}

function button(): HTMLButtonElement {
  return screen.getByTestId("stuck-recheck") as HTMLButtonElement;
}

describe("the re-check button rests between presses", () => {
  beforeEach(() => {
    recheckCalls.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("refuses a second press straight away, and says why rather than going grey", async () => {
    renderStuck();

    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("stuck-recheck-result")).toBeTruthy());

    // The press landed exactly once, and the button is now resting.
    expect(recheckCalls).toEqual(["q-1"]);
    expect(button().disabled).toBe(true);

    // A DISABLED CONTROL WITH NO REASON IS THE RULE THIS PROJECT KEEPS: the
    // label itself has to name the rule, not the wall.
    expect(button().textContent).toMatch(/Asked just now/);
    expect(button().textContent).toMatch(/ready again in \d+s/);

    // And a second click while it rests spends nothing.
    fireEvent.click(button());
    expect(recheckCalls).toEqual(["q-1"]);
  });

  it("lifts the rest, so the one person who needs to look again can", async () => {
    renderStuck();

    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("stuck-recheck-result")).toBeTruthy());
    expect(button().disabled).toBe(true);

    // Past the rest. The exact length is a constant in the component; this
    // walks well beyond it deliberately, because the claim is that the rest
    // ENDS, not that it ends on a particular second.
    //
    // ONE SECOND AT A TIME, because the countdown is a CHAIN of timers: each
    // tick re-renders, and the re-render is what schedules the next one. A
    // single 30s jump fires the one timer that exists at that instant and then
    // has nothing left to fire.
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(button().disabled).toBe(false);
    expect(button().textContent).toMatch(/Check it again/);

    fireEvent.click(button());
    await waitFor(() => expect(recheckCalls).toEqual(["q-1", "q-1"]));
  });
});
