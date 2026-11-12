/**
 * "Prescriptions needed" + "Pharmacy" (Beau's ruling: IN-APP ONLY) — the
 * dashboard side.
 *
 *   1. The visit screen's editor: loads what is stored, saves both fields
 *      through the visit's own route, shows the read-back; the pharmacy is a
 *      one-line input; a refusal is shown and nothing claims to be saved. It says, in words, that this never goes to Open Dental.
 *   2. The checkout card (sidebar) and the workup show them READ-ONLY, through
 *      the real TcCheckoutHandoff schema (so a client parse that dropped the
 *      field would fail here); nothing renders when neither was filled in.
 *
 * No PHI: the patient is the synthetic Roland fixture (12827).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TcCheckoutHandoff as TcCheckoutHandoffSchema, emptyCheckoutWorkup, type TcCheckoutHandoff } from "@shared/tc/checkout";
import type { HygPrescriptions } from "@shared/hyg/prescriptions";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { state, hyg, ref } = vi.hoisted(() => ({
  state: { row: null as unknown },
  hyg: {
    fetchVisitPrescriptions: vi.fn(),
    saveVisitPrescriptions: vi.fn(),
    HygApiError: class HygApiError extends Error {},
  },
  ref: {
    getReferralsStatus: vi.fn(async () => ({ success: true, office: "roland", enabled: false })),
    listDirectory: vi.fn(async () => []),
    listReferrals: vi.fn(async () => []),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    listReferralAttachments: vi.fn(async () => []),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    getReferralTemplates: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/hyg/api", () => hyg);
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutHandoff: vi.fn(async () => state.row),
  claimCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(),
  setCheckoutWorkup: vi.fn(),
  listCheckout: vi.fn(),
  dismissCheckout: vi.fn(),
  getCheckoutSummary: vi.fn(),
}));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => ({ listActiveProviders: vi.fn(async () => []) }));

import { VisitPrescriptions } from "@/features/hyg/visit/VisitPrescriptions";
import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";
import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";

const RX = "Amoxicillin 2 g premed\none hour before the next visit";
const PHARMACY = "Corner Drug, Main St";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

// ── 1 ───────────────────────────────────────────────────────────────────────

describe("the visit screen: Prescriptions", () => {
  it("loads what is stored, saves both fields, shows the read-back", async () => {
    hyg.fetchVisitPrescriptions.mockResolvedValue({ rxNeeded: "", pharmacy: "" });
    hyg.saveVisitPrescriptions.mockImplementation(async (_o: string, _a: number, p: HygPrescriptions) => ({
      rxNeeded: p.rxNeeded.trim(),
      pharmacy: p.pharmacy.trim(),
    }));
    render(<VisitPrescriptions office="roland" aptNum={900001} />);

    const rx = (await screen.findByTestId("hyg-rx-needed")) as HTMLTextAreaElement;
    expect(hyg.fetchVisitPrescriptions).toHaveBeenCalledWith("roland", 900001);
    expect(screen.getByText(/never sent to Open Dental/)).toBeTruthy();
    const save = screen.getByTestId("hyg-prescriptions-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(rx, { target: { value: RX } });
    // The pharmacy is a single-line input (a multi-line one is refused by the server: hygRxNeverToOd.test.js).
    expect(screen.getByTestId("hyg-pharmacy").tagName).toBe("INPUT");
    fireEvent.change(screen.getByTestId("hyg-pharmacy"), { target: { value: PHARMACY } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(hyg.saveVisitPrescriptions).toHaveBeenCalledWith("roland", 900001, { rxNeeded: RX, pharmacy: PHARMACY }),
    );
    await screen.findByTestId("hyg-prescriptions-saved");
    expect((screen.getByTestId("hyg-prescriptions-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows what was stored, and a refusal keeps the typing without claiming a save", async () => {
    hyg.fetchVisitPrescriptions.mockResolvedValue({ rxNeeded: RX, pharmacy: PHARMACY });
    hyg.saveVisitPrescriptions.mockRejectedValue(new Error("No visit has been started for this appointment yet"));
    render(<VisitPrescriptions office="roland" aptNum={900001} />);

    const rx = (await screen.findByTestId("hyg-rx-needed")) as HTMLTextAreaElement;
    expect(rx.value).toBe(RX);
    expect((screen.getByTestId("hyg-pharmacy") as HTMLInputElement).value).toBe(PHARMACY);

    fireEvent.change(rx, { target: { value: "changed" } });
    fireEvent.click(screen.getByTestId("hyg-prescriptions-save"));
    await screen.findByRole("alert");
    expect(rx.value).toBe("changed");
    expect(screen.queryByTestId("hyg-prescriptions-saved")).toBeNull();
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

function handoff(prescriptions?: HygPrescriptions): TcCheckoutHandoff {
  return TcCheckoutHandoffSchema.parse({
    handoffId: "00e65dd8-0000-4000-8000-0000000000d1",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-11-11",
    snapshot: {
      procedures: [
        { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "" },
      ],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo" },
      notesPending: false,
      frontDeskNote: "",
      financialNote: "",
      ...(prescriptions ? { prescriptions } : {}),
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-11-11T15:00:00.000Z",
    updatedAt: "2026-11-11T15:00:00.000Z",
    workup: emptyCheckoutWorkup(),
  });
}

describe("the checkout card and the workup: read-only", () => {
  it("the sidebar shows the Rx and the pharmacy, as text, with nothing to edit", async () => {
    state.row = handoff({ rxNeeded: RX, pharmacy: PHARMACY });
    render(<CheckoutSidebar office="roland" handoffId="00e65dd8-0000-4000-8000-0000000000d1" onClose={() => {}} onChanged={() => {}} />);
    const block = await screen.findByTestId("checkout-prescriptions");
    expect(within(block).getByTestId("checkout-prescriptions-rx").textContent).toBe(RX);
    expect(within(block).getByTestId("checkout-prescriptions-pharmacy").textContent).toBe(`Pharmacy: ${PHARMACY}`);
    expect(within(block).queryByRole("textbox")).toBeNull();
    expect(within(block).queryByRole("button")).toBeNull();
    expect(block.textContent).toMatch(/not in Open Dental/);
  });

  it("the sidebar shows nothing when neither was filled in", async () => {
    state.row = handoff();
    render(<CheckoutSidebar office="roland" handoffId="00e65dd8-0000-4000-8000-0000000000d1" onClose={() => {}} onChanged={() => {}} />);
    await screen.findByTestId("checkout-next-visit");
    expect(screen.queryByTestId("checkout-prescriptions")).toBeNull();
  });

  it("the workup shows them too; just a pharmacy shows just the pharmacy", () => {
    const memory = memoryLocation({ path: "/tc/checkout/x?office=roland" });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutWorkup office="roland" handoff={handoff({ rxNeeded: "", pharmacy: PHARMACY })} onChange={vi.fn()} onReload={vi.fn(async () => {})} />
      </WouterRouter>,
    );
    const block = screen.getByTestId("workup-prescriptions");
    expect(within(block).queryByTestId("workup-prescriptions-rx")).toBeNull();
    expect(within(block).getByTestId("workup-prescriptions-pharmacy").textContent).toBe(`Pharmacy: ${PHARMACY}`);
  });
});
