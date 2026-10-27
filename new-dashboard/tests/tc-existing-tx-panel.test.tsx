/**
 * The checkout panel's "Existing treatment discussed" block (hygiene Slice 2b).
 *
 *   - a snapshot stored BEFORE 2b (no existingTx) renders exactly as before
 *   - items are grouped by the patient's answer in the TC's working order:
 *     Ready to schedule, See plan again, Cost questions, Wants to wait (with
 *     timeframe), Declined, Not discussed
 *   - "Getting worse → urgent" is a red Urgent pill
 *
 * NO NETWORK, NO BACKEND. Fixture names are the staging test patients only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { TcCheckoutCaseTreatment } from "@shared/tc/checkout";
import { TcCheckoutSnapshot } from "@shared/tc/checkout";
import type { ExistingTxHandoffItem } from "@shared/hyg/existingTx";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
  }
  return {
    TcApiError,
    tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "Something went wrong.")),
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const checkoutMock = vi.hoisted(() => ({
  getCaseHygieneTreatment: vi.fn(),
  markItemEntered: vi.fn(),
  undoItemEntered: vi.fn(),
}));
vi.mock("@/features/tc/checkout/checkoutApi", () => checkoutMock);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HygieneTreatmentPanel } from "@/features/tc/checkout/HygieneTreatmentPanel";

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const HANDOFF_ID = "7a1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function tx(procNum: number, over: Partial<ExistingTxHandoffItem> = {}): ExistingTxHandoffItem {
  return {
    procNum,
    code: "D2740",
    description: "Crown",
    tooth: "30",
    surface: "",
    dateTp: "2026-06-20",
    priorityName: null,
    scheduled: false,
    clinical: null,
    patient: "not_discussed",
    waitTimeframe: null,
    note: null,
    ...over,
  };
}

function treatment(existingTx: ExistingTxHandoffItem[] | undefined): TcCheckoutCaseTreatment {
  return {
    success: true,
    caseId: CASE_ID,
    canUnattest: false,
    visits: [
      {
        handoff: {
          handoffId: HANDOFF_ID,
          officeId: "roland",
          odPatientId: 12827,
          patientName: "Test 2, Stedi",
          provider: "DOC1",
          providerSeen: "HYG1",
          operatory: "Hyg 1",
          visitDate: "2026-09-08",
          snapshot: {
            procedures: [],
            priority: null,
            nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
            notesPending: false,
            frontDeskNote: "",
            financialNote: "",
            ...(existingTx ? { existingTx } : {}),
          },
          final: true,
          revision: 1,
          submittedBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T15:00:00.000Z",
          updatedAt: "2026-09-08T15:00:00.000Z",
          status: "open",
          claimedBy: null,
          claimedAt: null,
          dismissedReason: null,
          dismissedBy: null,
          dismissedAt: null,
          outcomeBy: null,
          outcomeAt: null,
          appointmentNote: null,
          caseId: CASE_ID,
          expiredAt: null,
          expiredBy: null,
        },
        items: [],
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("the checkout panel's existing treatment", () => {
  it("a snapshot from before Slice 2b renders exactly as it did — no block", async () => {
    const data = treatment(undefined);
    expect(TcCheckoutSnapshot.safeParse(data.visits[0].handoff.snapshot).success).toBe(true);
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(data);
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    const panel = await screen.findByTestId("tc-hygiene-treatment-panel");
    expect(within(panel).queryByTestId("tc-existing-tx")).toBeNull();
    expect(within(panel).getByText("Nothing was staged at this visit.")).toBeTruthy();
  });

  it("groups by the patient's answer in the TC's order, urgent as a red pill", async () => {
    // Deliberately out of order.
    const items = [
      tx(1),
      tx(2, { patient: "declined" }),
      tx(3, { patient: "wants_to_wait", waitTimeframe: "6_months" }),
      tx(4, { patient: "cost_questions" }),
      tx(5, { patient: "see_plan_again" }),
      tx(6, { patient: "ready_to_schedule", clinical: "worse_urgent", scheduled: true, note: "cold sensitivity" }),
    ];
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(treatment(items));
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    const block = await screen.findByTestId("tc-existing-tx");
    expect(block.textContent).toContain("Existing treatment discussed (6)");

    const groups = within(block)
      .getAllByTestId(/^tc-existing-tx-group-/)
      .map((g) => g.dataset.testid?.replace("tc-existing-tx-group-", ""));
    expect(groups).toEqual([
      "ready_to_schedule",
      "see_plan_again",
      "cost_questions",
      "wants_to_wait",
      "declined",
      "not_discussed",
    ]);

    const ready = within(block).getByTestId("tc-existing-tx-group-ready_to_schedule");
    const pill = within(ready).getByTestId("tc-existing-tx-urgent");
    expect(pill.textContent).toBe("Urgent");
    expect(pill.className).toContain("bg-red-600");
    expect(ready.textContent).toContain("Already scheduled");
    expect(ready.textContent).toContain("Note: cold sensitivity");

    const waiting = within(block).getByTestId("tc-existing-tx-group-wants_to_wait");
    expect(waiting.textContent).toContain("Wait: 6 months");
    // Only the urgent item carries the pill.
    expect(within(block).getAllByTestId("tc-existing-tx-urgent")).toHaveLength(1);
  });

  it("empty groups are not drawn", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(treatment([tx(1, { patient: "declined" })]));
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    const block = await screen.findByTestId("tc-existing-tx");
    expect(within(block).getAllByTestId(/^tc-existing-tx-group-/)).toHaveLength(1);
    expect(within(block).queryByTestId("tc-existing-tx-group-not_discussed")).toBeNull();
  });
});
