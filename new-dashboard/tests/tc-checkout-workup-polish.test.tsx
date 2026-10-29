/**
 * CO-1 polish — Beau's staging rulings of 2026-10-29, in jsdom.
 *
 *  1 MASTER-DETAIL: the workup view keeps the Checkout list beside it as a
 *    rail — the same rows through the same listCheckout (one fetch per office,
 *    not a second pattern), the patient on screen highlighted. Choosing another
 *    patient swaps the workup in place and updates the address; a tick still
 *    saving finishes first. On a narrow screen the rail folds behind a toggle.
 *  2 NOT DISCUSSED COLLAPSED: in the workup only, that group starts folded to
 *    "Not discussed (N)", opens on a tap, and forgets on the next patient. The
 *    same block without the prop (sidebar, case page) is unchanged.
 *
 * With TC_SHOTS=1 it also dumps the "after" screenshots (tccheckout-co1p-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names, roland fixture 12827.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  checkoutCollectKey,
  checkoutItemKey,
  checkoutPresentKey,
  emptyCheckoutWorkup,
  type TcCheckoutHandoff,
} from "@shared/tc/checkout";
import type { ExistingTxHandoffItem } from "@shared/hyg/existingTx";
import type { OfficeId } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, api, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  api: {
    getCheckoutHandoff: vi.fn(),
    setCheckoutWorkup: vi.fn(),
    claimCheckout: vi.fn(),
    recordCheckoutOutcome: vi.fn(),
    listCheckout: vi.fn(),
    dismissCheckout: vi.fn(),
    getCheckoutSummary: vi.fn(),
  },
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(async () => []),
    listReferrals: vi.fn(),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    listReferralAttachments: vi.fn(async () => []),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/checkout/checkoutApi", () => api);
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => ({ listActiveProviders: vi.fn(async () => []) }));

import { CheckoutWorkupLayout } from "@/pages/tc/TcCheckoutWorkup";
import { ExistingTreatmentFromHygiene } from "@/features/tc/checkout/HygieneTreatmentPanel";

const ID_A = "5d2a7e10-0000-4000-8000-0000000000a1";
const ID_B = "5d2a7e10-0000-4000-8000-0000000000b2";
const ID_C = "5d2a7e10-0000-4000-8000-0000000000c3";

function tx(procNum: number, code: string, tooth: string, patient: ExistingTxHandoffItem["patient"]): ExistingTxHandoffItem {
  return {
    procNum, code, description: "Planned treatment", tooth, surface: "", dateTp: "2026-06-01", priorityName: null,
    scheduled: false, clinical: null, patient, waitTimeframe: null, note: null,
  };
}

const EXISTING: ExistingTxHandoffItem[] = [
  tx(900001, "D2391", "30", "ready_to_schedule"),
  tx(900002, "D2740", "19", "cost_questions"),
  tx(900003, "D2150", "14", "not_discussed"),
  tx(900004, "D2160", "15", "not_discussed"),
  tx(900005, "D2330", "8", "not_discussed"),
];

function handoff(id: string, name: string, over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: id,
    officeId: "roland",
    odPatientId: 12827,
    patientName: name,
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-10-29",
    snapshot: {
      procedures: [
        { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "" },
      ],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 months, periodic exam" },
      notesPending: false,
      frontDeskNote: "",
      financialNote: "",
      existingTx: EXISTING,
      collectAtCheckout: ["Fl2"],
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-10-29T14:42:00.000Z",
    updatedAt: "2026-10-29T14:42:00.000Z",
    status: "claimed",
    claimedBy: "tc@carein.ai",
    claimedAt: "2026-10-29T14:45:00.000Z",
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
    ...over,
  };
}

const A = handoff(ID_A, "Kiwi, Sam", { createdAt: "2026-10-29T15:30:00.000Z" });
const B = handoff(ID_B, "Fig, Lee", { status: "open", claimedBy: null, claimedAt: null, createdAt: "2026-10-29T15:05:00.000Z" });
const C = handoff(ID_C, "Plum, Ash", { createdAt: "2026-10-29T14:20:00.000Z", snapshot: { ...A.snapshot, priority: "soon" } });
const BY_ID: Record<string, TcCheckoutHandoff> = { [ID_A]: A, [ID_B]: B, [ID_C]: C };

// Stable, like useTcOfficeScope's memoized roster: a fresh array per render
// would read as a new office scope and refetch the list.
const OFFICES: OfficeId[] = ["roland"];

function mount(id = ID_A) {
  const memory = memoryLocation({ path: `/tc/checkout/${id}?office=roland`, record: true });
  function Routed() {
    // The page reads :id from the path; the test stands in for the route.
    const [path] = memory.hook();
    const current = /\/tc\/checkout\/([^/?]+)/.exec(path)?.[1] ?? id;
    return <CheckoutWorkupLayout offices={OFFICES} office="roland" handoffId={current} showOfficeBadges={false} />;
  }
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <Routed />
    </WouterRouter>,
  );
  return memory;
}

function railRow(id: string): HTMLElement {
  const row = screen.getAllByTestId("workup-rail-row").find((r) => r.getAttribute("data-handoff-id") === id);
  if (!row) throw new Error(`no rail row ${id}`);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listCheckout.mockImplementation(async (_office: string, view: string) => ({
    handoffs: view === "waiting" ? [A, B, C] : [],
  }));
  api.getCheckoutHandoff.mockImplementation(async (_office: string, id: string) => BY_ID[id]);
  ref.getReferralsStatus.mockResolvedValue({ enabled: true });
  ref.listReferrals.mockResolvedValue([]);
});
afterEach(cleanup);

describe("CO-1 polish 1 — master-detail", () => {
  it("the rail lists the Checkout page's rows through the SAME listCheckout, once, with the patient on screen highlighted", async () => {
    mount(ID_A);
    await screen.findByTestId("workup-patient");
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    expect(api.listCheckout).toHaveBeenCalledTimes(1);
    expect(api.listCheckout).toHaveBeenCalledWith("roland", "waiting");
    expect(screen.getAllByTestId("workup-rail-row").map((r) => r.textContent?.split("·")[0]?.trim())).toEqual([
      expect.stringContaining("Kiwi, Sam"),
      expect.stringContaining("Fig, Lee"),
      expect.stringContaining("Plum, Ash"),
    ]);
    expect(railRow(ID_A).getAttribute("aria-current")).toBe("page");
    expect(railRow(ID_B).getAttribute("aria-current")).toBeNull();
    expect(railRow(ID_A).textContent).toMatch(/0 of 4 sections done/);
    expect(screen.getByTestId("workup-back").getAttribute("href")).toBe("/tc/checkout");
  });

  it("choosing another patient swaps the workup in place and updates the address; the list is not fetched again", async () => {
    const memory = mount(ID_A);
    expect((await screen.findByTestId("workup-patient")).textContent).toBe("Kiwi, Sam");
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    fireEvent.click(railRow(ID_B));
    await waitFor(() => expect(memory.history?.at(-1)).toBe(`/tc/checkout/${ID_B}?office=roland`));
    await waitFor(() => expect(screen.getByTestId("workup-patient").textContent).toBe("Fig, Lee"));
    expect(api.getCheckoutHandoff).toHaveBeenLastCalledWith("roland", ID_B);
    expect(railRow(ID_B).getAttribute("aria-current")).toBe("page");
    expect(railRow(ID_A).getAttribute("aria-current")).toBeNull();
    expect(api.listCheckout).toHaveBeenCalledTimes(1);
  });

  it("a tick still saving finishes BEFORE the switch; the rail's card takes the read-back", async () => {
    let resolveSave: (h: TcCheckoutHandoff) => void = () => {};
    api.setCheckoutWorkup.mockImplementation(() => new Promise<TcCheckoutHandoff>((r) => (resolveSave = r)));
    const memory = mount(ID_A);
    await screen.findByTestId("workup-patient");
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));

    fireEvent.click(screen.getByTestId("workup-tick-0"));
    await waitFor(() => expect(api.setCheckoutWorkup).toHaveBeenCalledTimes(1));
    fireEvent.click(railRow(ID_C));
    // Held: the address and the workup stay on the patient being saved.
    expect(memory.history?.at(-1)).toBe(`/tc/checkout/${ID_A}?office=roland`);
    expect(screen.getByTestId("workup-patient").textContent).toBe("Kiwi, Sam");

    const at = "2026-10-29T15:40:00.000Z";
    await act(async () => {
      resolveSave({ ...A, workup: { ...emptyCheckoutWorkup(), workedUp: { "0": { by: "tc@carein.ai", at, key: checkoutItemKey(A.snapshot.procedures[0]) } } } });
    });
    await waitFor(() => expect(memory.history?.at(-1)).toBe(`/tc/checkout/${ID_C}?office=roland`));
    await waitFor(() => expect(screen.getByTestId("workup-patient").textContent).toBe("Plum, Ash"));
    // The saved patient's card kept the server's answer.
    expect(railRow(ID_A).textContent).toMatch(/1 of 4 sections done/);
  });

  it("the rail's Waiting / Done today filters are the Checkout page's, and switching one does not reload the workup", async () => {
    mount(ID_A);
    await screen.findByTestId("workup-patient");
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    expect(api.getCheckoutHandoff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("workup-rail-tab-done"));
    await waitFor(() => expect(api.listCheckout).toHaveBeenCalledWith("roland", "done"));
    expect(await screen.findByTestId("workup-rail-empty")).toBeTruthy();
    expect(screen.getByTestId("workup-patient").textContent).toBe("Kiwi, Sam");
    expect(api.getCheckoutHandoff).toHaveBeenCalledTimes(1);
  });

  it("narrow screens: the rail folds behind a Patients toggle and the workup keeps the screen", async () => {
    mount(ID_A);
    await screen.findByTestId("workup-patient");
    const toggle = screen.getByTestId("workup-rail-toggle");
    const panel = document.getElementById("workup-rail-panel");
    expect(toggle.className).toMatch(/lg:hidden/);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:block"]));
    await waitFor(() => expect(toggle.textContent).toMatch(/Patients \(3\)/));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.className.split(/\s+/)).not.toContain("hidden");
    // Choosing a patient folds it away again.
    fireEvent.click(railRow(ID_B));
    expect(panel?.className.split(/\s+/)).toContain("hidden");
  });
});

describe("CO-1 polish 2 — Not discussed collapsed in the workup", () => {
  it("starts folded to 'Not discussed (3)', opens on a tap, folds again; other groups and the present box are unchanged", async () => {
    mount(ID_A);
    await screen.findByTestId("workup-patient");
    const group = screen.getByTestId("tc-existing-tx-group-not_discussed");
    const toggle = within(group).getByTestId("tc-existing-tx-toggle-not_discussed");
    expect(toggle.textContent).toBe("Not discussed (3)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(group).queryAllByTestId("tc-existing-tx-item")).toHaveLength(0);
    // The group's "Ready to present" box stays reachable while folded.
    expect(within(group).getByTestId("workup-present-not_discussed")).toBeTruthy();
    // Every other group renders open, with no toggle.
    for (const g of ["ready_to_schedule", "cost_questions"]) {
      const other = screen.getByTestId(`tc-existing-tx-group-${g}`);
      expect(within(other).queryByTestId(`tc-existing-tx-toggle-${g}`)).toBeNull();
      expect(within(other).getAllByTestId("tc-existing-tx-item")).toHaveLength(1);
    }

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(group).getAllByTestId("tc-existing-tx-item")).toHaveLength(3);
    fireEvent.click(toggle);
    expect(within(group).queryAllByTestId("tc-existing-tx-item")).toHaveLength(0);
  });

  it("remembers only for the current view: the next patient starts folded again, and nothing is stored", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mount(ID_A);
    await screen.findByTestId("workup-patient");
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    fireEvent.click(screen.getByTestId("tc-existing-tx-toggle-not_discussed"));
    expect(screen.getByTestId("tc-existing-tx-toggle-not_discussed").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(railRow(ID_B));
    await waitFor(() => expect(screen.getByTestId("workup-patient").textContent).toBe("Fig, Lee"));
    expect(screen.getByTestId("tc-existing-tx-toggle-not_discussed").getAttribute("aria-expanded")).toBe("false");
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("the same block WITHOUT the prop (quick-look sidebar, case page) still renders Not discussed open, no toggle", () => {
    render(<ExistingTreatmentFromHygiene items={EXISTING} />);
    const group = screen.getByTestId("tc-existing-tx-group-not_discussed");
    expect(within(group).queryByTestId("tc-existing-tx-toggle-not_discussed")).toBeNull();
    expect(within(group).getAllByTestId("tc-existing-tx-item")).toHaveLength(3);
  });
});

// ── screenshot dumps (the report's "after") ─────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("checkout workup polish screenshot dumps", () => {
  const at = "2026-10-29T15:00:00.000Z";
  const partDone = {
    ...A,
    workup: {
      workedUp: { "0": { by: "tc@carein.ai", at, key: checkoutItemKey(A.snapshot.procedures[0]) } },
      present: {
        ready_to_schedule: { by: "tc@carein.ai", at, key: checkoutPresentKey(EXISTING, "ready_to_schedule") },
      },
      collected: { by: "tc@carein.ai", at, key: checkoutCollectKey(A.snapshot.collectAtCheckout) },
      referrals: null,
    },
  };

  it("co1p-01 — master-detail, Not discussed folded", async () => {
    api.listCheckout.mockResolvedValue({ handoffs: [partDone, B, C] });
    api.getCheckoutHandoff.mockResolvedValue(partDone);
    mount(ID_A);
    await screen.findByText(/No referrals for this patient yet/);
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    dump("tccheckout-co1p-01-master-detail@1440x2000");
  });

  it("co1p-02 — Not discussed opened", async () => {
    api.listCheckout.mockResolvedValue({ handoffs: [partDone, B, C] });
    api.getCheckoutHandoff.mockResolvedValue(partDone);
    mount(ID_A);
    await screen.findByText(/No referrals for this patient yet/);
    await waitFor(() => expect(screen.getAllByTestId("workup-rail-row")).toHaveLength(3));
    fireEvent.click(screen.getByTestId("tc-existing-tx-toggle-not_discussed"));
    dump("tccheckout-co1p-02-not-discussed-open@1440x2000");
  });

  it("co1p-03 — narrow screen, rail folded behind the toggle", async () => {
    api.listCheckout.mockResolvedValue({ handoffs: [partDone, B, C] });
    api.getCheckoutHandoff.mockResolvedValue(partDone);
    mount(ID_A);
    await screen.findByText(/No referrals for this patient yet/);
    await waitFor(() => expect(screen.getByTestId("workup-rail-toggle").textContent).toMatch(/Patients \(3\)/));
    dump("tccheckout-co1p-03-narrow@420x1600");
  });
});
