/**
 * BUG 2 REGRESSION: the TC → Checkout sidebar shows the existing treatment the
 * hygiene checkout carried.
 *
 * On staging a checkout alert carried nine existing-treatment items (two "Wants
 * to wait", seven "Not discussed") in its stored snapshot, and the front desk's
 * sheet showed "Treatment staged" and "Next visit needs" and nothing else. The
 * block existed only on the case view's HygieneTreatmentPanel; the sheet the
 * desk actually opens never drew it.
 *
 *   - every carried item shows, "Not discussed" included, in the ratified order;
 *   - Getting worse → urgent is the red Urgent pill; Wait shows its timeframe;
 *   - a snapshot from before Slice 2b (no existingTx) shows no section at all.
 *
 * NO NETWORK, NO PHI. The api module is faked; the name is synthetic and the
 * PatNum is the roland test fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { TcCheckoutHandoff } from "@shared/tc/checkout";
import { TcCheckoutHandoff as TcCheckoutHandoffSchema } from "@shared/tc/checkout";
import type { ExistingTxHandoffItem } from "@shared/hyg/existingTx";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { state } = vi.hoisted(() => ({ state: { row: null as TcCheckoutHandoff | null } }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutHandoff: vi.fn(async () => state.row),
  claimCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(),
}));

import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";

function item(procNum: number, over: Partial<ExistingTxHandoffItem> = {}): ExistingTxHandoffItem {
  return {
    procNum,
    code: "D2740",
    description: "Crown - porcelain/ceramic",
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

function handoff(existingTx: ExistingTxHandoffItem[] | undefined): TcCheckoutHandoff {
  // Through the real schema, so the test fails if the client parse ever drops the field.
  return TcCheckoutHandoffSchema.parse({
    handoffId: "00e65dd8-0000-4000-8000-0000000000c1",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-10-27",
    snapshot: {
      procedures: [
        { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "" },
      ],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo" },
      notesPending: true,
      frontDeskNote: "",
      financialNote: "",
      ...(existingTx ? { existingTx } : {}),
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-10-28T01:11:39.704Z",
    updatedAt: "2026-10-28T01:12:16.210Z",
  });
}

/** The staging shape: 9 items, 2 wants-to-wait, 7 not discussed — plus an urgent one here. */
const STAGING_LIKE: ExistingTxHandoffItem[] = [
  item(5001),
  item(5002, { patient: "wants_to_wait", waitTimeframe: "3_months", clinical: "worse_urgent" }),
  item(5003, { tooth: "14", code: "D2391", description: "Composite" }),
  item(5004, { patient: "wants_to_wait", waitTimeframe: "6_months", tooth: "19" }),
  item(5005, { tooth: "", code: "D4341", description: "Perio scaling" }),
  item(5006, { tooth: "3" }),
  item(5007, { tooth: "4", scheduled: true }),
  item(5008, { tooth: "5" }),
  item(5009, { tooth: "6", patient: "ready_to_schedule" }),
];

async function open(existingTx: ExistingTxHandoffItem[] | undefined) {
  state.row = handoff(existingTx);
  render(<CheckoutSidebar office="roland" handoffId={state.row.handoffId} onClose={() => {}} onChanged={() => {}} />);
  return screen.findByTestId("checkout-next-visit");
}

beforeEach(() => {
  state.row = null;
});
afterEach(() => cleanup());

describe("the checkout sidebar draws the existing treatment the handoff carried", () => {
  it("shows every item, Not discussed included, in the ratified order", async () => {
    await open(STAGING_LIKE);
    const section = screen.getByTestId("checkout-existing-tx");
    expect(within(section).getAllByTestId("tc-existing-tx-item")).toHaveLength(9);
    const order = within(section)
      .getAllByTestId(/^tc-existing-tx-group-/)
      .map((g) => g.getAttribute("data-testid")!.replace("tc-existing-tx-group-", ""));
    expect(order).toEqual(["ready_to_schedule", "wants_to_wait", "not_discussed"]);
    const notDiscussed = within(section).getByTestId("tc-existing-tx-group-not_discussed");
    expect(within(notDiscussed).getAllByTestId("tc-existing-tx-item")).toHaveLength(6);
    expect(within(section).getAllByTestId("tc-existing-tx-urgent")).toHaveLength(1);
    expect(section.textContent).toMatch(/Wait: 3 months/);
    expect(section.textContent).toMatch(/Already scheduled/);
  });

  it("a snapshot from before Slice 2b shows no section — never an empty one", async () => {
    await open(undefined);
    expect(screen.queryByTestId("checkout-existing-tx")).toBeNull();
    expect(screen.getByText("Treatment staged")).toBeTruthy();
  });
});
