/**
 * CO-4a — the "Scheduled" appointment anchor, in jsdom.
 *
 *  - Scheduled opens the picker: the patient's upcoming appointments (date,
 *    time, provider, type, operatory) plus "Not in Open Dental yet"; picking one
 *    answers Scheduled WITH that AptNum, in one request
 *  - a failed read says "Couldn't load appointments from Open Dental", offers
 *    Retry, and still lets the desk answer "Not in Open Dental yet"
 *  - the answered card shows "Scheduled → <date, time>" from the stored anchor,
 *    or "No appointment linked" with "Link appointment" (same picker, link mode)
 *  - the case's checkout panel shows the same line; it offers the link only when
 *    the server says the case still takes one
 *  - an old card with no anchor field reads as unanchored
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co4a-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names, roland fixture 12827.
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  emptyCheckoutSnapshot,
  emptyCheckoutWorkup,
  type TcCheckoutHandoff,
  type TcCheckoutUpcomingAppointment,
} from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, api } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  api: {
    claimCheckout: vi.fn(),
    recordCheckoutOutcome: vi.fn(),
    listCheckoutAppointments: vi.fn(),
    linkCheckoutAppointment: vi.fn(),
    getCaseHygieneTreatment: vi.fn(),
    markItemEntered: vi.fn(),
    undoItemEntered: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/checkout/checkoutApi", () => api);

import { CheckoutOutcome } from "@/features/tc/checkout/CheckoutOutcome";
import { HygieneTreatmentPanel } from "@/features/tc/checkout/HygieneTreatmentPanel";
import { TcApiError } from "@/features/tc/api";

const ID = "5d2a7e10-0000-4000-8000-0000000004a1";
const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const UPCOMING: TcCheckoutUpcomingAppointment[] = [
  { aptNum: 5001, dateTime: "2026-11-04 09:00:00", provider: "DOC1", appointmentType: "Crown prep", operatory: "Op 4 - Doctor" },
  { aptNum: 5002, dateTime: "2026-11-10 14:30:00", provider: "DOC1", appointmentType: "Comp", operatory: "Op 9" },
];

function card(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: ID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-10-30",
    snapshot: emptyCheckoutSnapshot(),
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-10-30T14:40:00.000Z",
    updatedAt: "2026-10-30T14:40:00.000Z",
    status: "claimed",
    claimedBy: "tc@carein.ai",
    claimedAt: "2026-10-30T14:45:00.000Z",
    dismissedReason: null,
    dismissedBy: null,
    dismissedAt: null,
    outcomeBy: null,
    outcomeAt: null,
    appointmentNote: null,
    caseId: null,
    expiredAt: null,
    expiredBy: null,
    workup: emptyCheckoutWorkup(),
    source: "hygiene",
    hygieneMergedAt: null,
    reopenedFrom: null,
    appointment: null,
    ...over,
  };
}

function scheduled(appointment: TcCheckoutHandoff["appointment"]): TcCheckoutHandoff {
  return card({
    status: "scheduled",
    outcomeBy: "tc@carein.ai",
    outcomeAt: "2026-10-30T15:00:00.000Z",
    caseId: CASE_ID,
    appointment,
  });
}

const ANCHOR = { ...UPCOMING[0], linkedBy: "tc@carein.ai", linkedAt: "2026-10-30T15:00:00.000Z" };

function mount(h: TcCheckoutHandoff, onAdopt = vi.fn()) {
  const memory = memoryLocation({ path: "/tc/checkout" });
  const view = render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <div className="p-6 max-w-xl mx-auto">
        <CheckoutOutcome office="roland" handoff={h} onAdopt={onAdopt} onReload={vi.fn(async () => {})} />
      </div>
    </WouterRouter>,
  );
  return { onAdopt, rerender: (next: TcCheckoutHandoff) =>
    view.rerender(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <div className="p-6 max-w-xl mx-auto">
          <CheckoutOutcome office="roland" handoff={next} onAdopt={onAdopt} onReload={vi.fn(async () => {})} />
        </div>
      </WouterRouter>,
    ) };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listCheckoutAppointments.mockResolvedValue(UPCOMING);
  api.recordCheckoutOutcome.mockImplementation(async (_o: string, _id: string, _outcome: string, _note: string, aptNum: number | null) => ({
    success: true,
    handoff: scheduled(aptNum === 5001 ? ANCHOR : aptNum === 5002 ? { ...UPCOMING[1], linkedBy: "tc@carein.ai", linkedAt: "x" } : null),
    caseId: CASE_ID,
    url: `/tc/cases/${CASE_ID}`,
    attached: false,
  }));
});
afterEach(cleanup);

describe("tapping Scheduled", () => {
  it("opens the picker: the upcoming appointments with date, time, provider, type, operatory — and 'Not in Open Dental yet'", async () => {
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    const options = await screen.findAllByTestId("appointment-picker-option");
    expect(api.listCheckoutAppointments).toHaveBeenCalledWith("roland", ID);
    expect(options.map((o) => o.textContent)).toEqual([
      "Wed, Nov 4, 9:00 AMDOC1 · Crown prep · Op 4 - Doctor",
      "Tue, Nov 10, 2:30 PMDOC1 · Comp · Op 9",
    ]);
    expect(screen.getByTestId("appointment-picker-not-in-od")).toBeTruthy();
    expect(api.recordCheckoutOutcome).not.toHaveBeenCalled();
  });

  it("picking one answers Scheduled WITH that AptNum in one request, and the card shows 'Scheduled → <date, time>'", async () => {
    const { onAdopt, rerender } = mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    fireEvent.click((await screen.findAllByTestId("appointment-picker-option"))[0]);
    await waitFor(() => expect(api.recordCheckoutOutcome).toHaveBeenCalledTimes(1));
    expect(api.recordCheckoutOutcome).toHaveBeenCalledWith("roland", ID, "scheduled", "", 5001);
    const adopted = onAdopt.mock.calls[0][0] as TcCheckoutHandoff;
    rerender(adopted);
    expect(screen.getByTestId("appointment-anchor-when").textContent).toBe("Scheduled → Wed, Nov 4, 9:00 AM · DOC1 · Crown prep · Op 4 - Doctor");
  });

  it("a failed read says so, with Retry — and 'Not in Open Dental yet' still answers Scheduled with no anchor", async () => {
    api.listCheckoutAppointments.mockRejectedValueOnce(new TcApiError("Couldn't load appointments from Open Dental", 502, "OD_APPOINTMENTS_UNAVAILABLE", null, []));
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    const err = await screen.findByTestId("appointment-picker-error");
    expect(err.textContent).toMatch(/Couldn't load appointments from Open Dental/);
    expect(screen.queryByTestId("appointment-picker-none")).toBeNull();
    expect(screen.queryByTestId("appointment-picker-list")).toBeNull();

    // Retry asks again (and this time it answers).
    fireEvent.click(screen.getByTestId("appointment-picker-retry"));
    expect(await screen.findAllByTestId("appointment-picker-option")).toHaveLength(2);
    expect(api.listCheckoutAppointments).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("appointment-picker-not-in-od"));
    await waitFor(() => expect(api.recordCheckoutOutcome).toHaveBeenCalledWith("roland", ID, "scheduled", "", null));
  });

  it("when Open Dental has no upcoming appointment it says so; 'Not in Open Dental yet' is the way through", async () => {
    api.listCheckoutAppointments.mockResolvedValueOnce([]);
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    expect((await screen.findByTestId("appointment-picker-none")).textContent).toMatch(/no upcoming appointment/);
    expect(screen.getByTestId("appointment-picker-not-in-od")).toBeTruthy();
  });

  it("Not scheduled and Nothing needed never open the picker", async () => {
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-not_scheduled"));
    await waitFor(() => expect(api.recordCheckoutOutcome).toHaveBeenCalledTimes(1));
    expect(api.listCheckoutAppointments).not.toHaveBeenCalled();
    expect(screen.queryByTestId("appointment-picker")).toBeNull();
  });
});

describe("an answered Scheduled card", () => {
  it("unanchored: 'No appointment linked' with 'Link appointment', which links one later through the same picker", async () => {
    api.linkCheckoutAppointment.mockResolvedValue(scheduled({ ...UPCOMING[1], linkedBy: "tc@carein.ai", linkedAt: "x" }));
    const { onAdopt } = mount(scheduled(null));
    expect(screen.getByTestId("appointment-anchor-none").textContent).toBe("No appointment linked");
    fireEvent.click(screen.getByTestId("appointment-anchor-link"));
    const picker = await screen.findByTestId("appointment-picker");
    // Link mode: no "Not in Open Dental yet" — the card already is.
    expect(within(picker).queryByTestId("appointment-picker-not-in-od")).toBeNull();
    fireEvent.click((await within(picker).findAllByTestId("appointment-picker-option"))[1]);
    await waitFor(() => expect(api.linkCheckoutAppointment).toHaveBeenCalledWith("roland", ID, 5002));
    expect((onAdopt.mock.calls[0][0] as TcCheckoutHandoff).appointment?.aptNum).toBe(5002);
  });

  it("anchored: shows the appointment; Change offers Unlink, which clears it", async () => {
    api.linkCheckoutAppointment.mockResolvedValue(scheduled(null));
    mount(scheduled(ANCHOR));
    expect(screen.getByTestId("appointment-anchor-when").textContent).toMatch(/^Scheduled → Wed, Nov 4, 9:00 AM/);
    fireEvent.click(screen.getByTestId("appointment-anchor-link"));
    fireEvent.click(await screen.findByTestId("appointment-picker-unlink"));
    await waitFor(() => expect(api.linkCheckoutAppointment).toHaveBeenCalledWith("roland", ID, null));
  });

  it("an old card (no appointment field at all) reads as unanchored", () => {
    const old = scheduled(null) as Partial<TcCheckoutHandoff>;
    delete old.appointment;
    mount(old as TcCheckoutHandoff);
    expect(screen.getByTestId("appointment-anchor-none")).toBeTruthy();
  });
});

describe("the case's checkout panel", () => {
  function panel(canLinkAppointment: boolean, h: TcCheckoutHandoff) {
    api.getCaseHygieneTreatment.mockResolvedValue({ success: true, caseId: CASE_ID, canUnattest: false, visits: [{ handoff: h, items: [], canLinkAppointment }] });
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
  }

  it("shows the anchored appointment on the case", async () => {
    panel(true, scheduled(ANCHOR));
    expect((await screen.findByTestId("appointment-anchor-when")).textContent).toMatch(/^Scheduled → Wed, Nov 4, 9:00 AM/);
    expect(screen.getByTestId("appointment-anchor-link").textContent).toMatch(/Change/);
  });

  it("offers 'Link appointment' only while the server says the case still takes one", async () => {
    panel(false, scheduled(null));
    expect(await screen.findByTestId("appointment-anchor-none")).toBeTruthy();
    expect(screen.queryByTestId("appointment-anchor-link")).toBeNull();
    cleanup();
    panel(true, scheduled(null));
    expect(await screen.findByTestId("appointment-anchor-link")).toBeTruthy();
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-4a screenshot dumps", () => {
  it("co4a-01 — the picker after tapping Scheduled", async () => {
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    await screen.findAllByTestId("appointment-picker-option");
    dump("tccheckout-co4a-01-picker@1280x900");
  });

  it("co4a-02 — the picker when Open Dental could not be read", async () => {
    api.listCheckoutAppointments.mockRejectedValueOnce(new Error("down"));
    mount(card());
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    await screen.findByTestId("appointment-picker-error");
    dump("tccheckout-co4a-02-picker-failed@1280x900");
  });

  it("co4a-03 — answered cards: anchored, and not linked", () => {
    mount(scheduled(ANCHOR));
    mount(scheduled(null));
    dump("tccheckout-co4a-03-answered@1280x900");
  });
});
