/**
 * CO-5a — "Add patient" on the Checkout page, in jsdom.
 *
 *  - the button is tc.full only, and drawn only once /auth/me has answered
 *  - the picker IS the referrals hub's: OdPatientSearch over odAttachSearch,
 *    for the chosen office; picking sends only the PatNum and opens the card
 *    the server answered with — a new one, or the patient's existing one
 *  - more than one office in scope → the person picks which office's Open
 *    Dental to search, and the request goes to that office
 *  - a manual card: an "Added by hand" badge on the list, rail and sheet; in
 *    the workup, ONE "No hygiene visit data" block instead of the hygiene
 *    sections, referrals as the only counted section, the outcome buttons as
 *    usual; once a hygiene visit merges onto it, every section is back
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co5a-*).
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
  emptyCheckoutSnapshot,
  emptyCheckoutWorkup,
  type TcCheckoutHandoff,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, api, ref, od, authState } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  api: {
    getCheckoutHandoff: vi.fn(),
    setCheckoutWorkup: vi.fn(),
    claimCheckout: vi.fn(),
    recordCheckoutOutcome: vi.fn(),
    listCheckout: vi.fn(),
    dismissCheckout: vi.fn(),
    getCheckoutSummary: vi.fn(),
    addCheckoutPatient: vi.fn(),
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
  od: { odAttachSearch: vi.fn(), odSearchPatients: vi.fn() },
  authState: {
    value: { status: "loading" } as
      | { status: "loading" }
      | { status: "authenticated"; user: { isSuperAdmin: boolean; permissions: string[] } },
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/checkout/checkoutApi", () => api);
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => ({ listActiveProviders: vi.fn(async () => []) }));
vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  return { ...real, odAttachSearch: od.odAttachSearch, odSearchPatients: od.odSearchPatients };
});
vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => authState.value };
});

import { CheckoutInbox } from "@/pages/tc/TcCheckout";
import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";
import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";

const MANUAL_ID = "5d2a7e10-0000-4000-8000-0000000005a1";
const HYG_ID = "5d2a7e10-0000-4000-8000-0000000005a2";

function manualCard(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: MANUAL_ID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Plum, Ash",
    provider: "",
    providerSeen: "",
    operatory: "",
    visitDate: "2026-10-30",
    snapshot: emptyCheckoutSnapshot(),
    final: false,
    revision: 1,
    submittedBy: "tc@carein.ai",
    createdAt: "2026-10-30T15:05:00.000Z",
    updatedAt: "2026-10-30T15:05:00.000Z",
    status: "open",
    claimedBy: null,
    claimedAt: null,
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
    source: "manual",
    hygieneMergedAt: null,
    ...over,
  };
}

const VISIT_SNAPSHOT: TcCheckoutHandoff["snapshot"] = {
  procedures: [
    { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: false, note: "" },
  ],
  priority: "urgent",
  nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: false, rtc: "6 mo" },
  notesPending: false,
  frontDeskNote: "",
  financialNote: "",
  collectAtCheckout: ["Fl2"],
};

function hygieneCard(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return manualCard({
    handoffId: HYG_ID,
    patientName: "Kiwi, Sam",
    providerSeen: "HYG1",
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-10-30T14:40:00.000Z",
    snapshot: VISIT_SNAPSHOT,
    final: true,
    source: "hygiene",
    ...over,
  });
}

function signIn(permissions: string[], isSuperAdmin = false) {
  authState.value = { status: "authenticated", user: { isSuperAdmin, permissions } };
}

const ROLAND: OfficeId[] = ["roland"];
const BOTH: OfficeId[] = ["roland", "valley"];

function inbox(offices: OfficeId[] = ROLAND) {
  const memory = memoryLocation({ path: "/tc/checkout", record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <div className="p-6 max-w-4xl mx-auto">
        <CheckoutInbox offices={offices} showOfficeBadges={offices.length > 1} />
      </div>
    </WouterRouter>,
  );
  return memory;
}

function workup(h: TcCheckoutHandoff) {
  const memory = memoryLocation({ path: `/tc/checkout/${h.handoffId}?office=${h.officeId}` });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <div className="p-6 max-w-5xl mx-auto">
        <CheckoutWorkup office={h.officeId} handoff={h} onChange={vi.fn()} onReload={vi.fn(async () => {})} />
      </div>
    </WouterRouter>,
  );
}

/** Type into the dialog's patient search and wait for the (mocked) results. */
async function search(term: string) {
  const dialog = await screen.findByTestId("checkout-add-patient-dialog");
  fireEvent.change(within(dialog).getByLabelText("Patient"), { target: { value: term } });
  return dialog;
}

const RESULTS = {
  query: "pl",
  matchMode: "prefix",
  truncated: false,
  notes: [],
  patients: [{ patNum: 12827, firstName: "Ash", lastName: "Plum", displayName: "Plum, Ash", birthdate: "1980-01-01", phone: "", email: "", status: "" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { status: "loading" };
  api.listCheckout.mockImplementation(async (office: OfficeId, view: string) => ({
    success: true,
    today: "2026-10-30",
    view,
    handoffs: office === "roland" && view === "waiting" ? [hygieneCard()] : [],
  }));
  od.odAttachSearch.mockResolvedValue(RESULTS);
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listReferrals.mockResolvedValue([]);
  ref.listDirectory.mockResolvedValue([]);
});
afterEach(cleanup);

describe("the Add patient button: tc.full only", () => {
  it("is drawn for a tc.full user once the list has loaded", async () => {
    signIn(["voice.read", "tc.full", "tc.hygiene"]);
    inbox();
    expect(await screen.findByTestId("checkout-add-patient")).toBeTruthy();
  });

  it("is not drawn for a user without tc.full, nor before /auth/me answers", async () => {
    inbox();
    await screen.findByTestId("checkout-list");
    expect(screen.queryByTestId("checkout-add-patient")).toBeNull();
    cleanup();
    signIn(["tc.hygiene", "hyg.read"]);
    inbox();
    await screen.findByTestId("checkout-list");
    expect(screen.queryByTestId("checkout-add-patient")).toBeNull();
  });

  it("a super admin holds it", async () => {
    signIn([], true);
    inbox();
    expect(await screen.findByTestId("checkout-add-patient")).toBeTruthy();
  });
});

describe("adding a patient", () => {
  beforeEach(() => signIn(["tc.full"]));

  it("searches THIS office's Open Dental with the hub's picker, sends only the PatNum, and opens the new card", async () => {
    api.addCheckoutPatient.mockResolvedValue({ success: true, created: true, handoff: manualCard() });
    const memory = inbox();
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    const dialog = await search("Pl");
    fireEvent.click(await within(dialog).findByText("Plum, Ash"));
    await waitFor(() => expect(api.addCheckoutPatient).toHaveBeenCalledTimes(1));
    expect(od.odAttachSearch).toHaveBeenCalledWith("roland", "Pl");
    expect(od.odSearchPatients).not.toHaveBeenCalled();
    expect(api.addCheckoutPatient).toHaveBeenCalledWith("roland", 12827);
    await waitFor(() => expect(memory.history?.at(-1)).toBe(`/tc/checkout/${MANUAL_ID}?office=roland`));
    expect(toastMock.success).toHaveBeenCalledWith("Plum, Ash added to today's Checkout");
  });

  it("a patient already on today's Checkout: the server's existing card opens, and the toast says so", async () => {
    api.addCheckoutPatient.mockResolvedValue({ success: true, created: false, handoff: hygieneCard({ patientName: "Plum, Ash" }) });
    const memory = inbox();
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    const dialog = await search("Pl");
    fireEvent.click(await within(dialog).findByText("Plum, Ash"));
    await waitFor(() => expect(memory.history?.at(-1)).toBe(`/tc/checkout/${HYG_ID}?office=roland`));
    expect(toastMock.info).toHaveBeenCalledWith("Plum, Ash is already on today's Checkout. Opening their card.");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("a refusal stays on the page with the server's words; nothing navigates", async () => {
    const { TcApiError } = await import("@/features/tc/api");
    api.addCheckoutPatient.mockRejectedValue(new TcApiError("That patient is not in this office's Open Dental", 404, "PATIENT_NOT_FOUND", null, []));
    const memory = inbox();
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    const dialog = await search("Pl");
    fireEvent.click(await within(dialog).findByText("Plum, Ash"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(memory.history).toEqual(["/tc/checkout"]);
    expect(screen.getByTestId("checkout-add-patient-dialog")).toBeTruthy();
  });

  it("two offices in scope: the person picks which office's Open Dental, and the add goes there", async () => {
    api.listCheckout.mockImplementation(async (_office: OfficeId, view: string) => ({ success: true, today: "2026-10-30", view, handoffs: [] }));
    api.addCheckoutPatient.mockResolvedValue({ success: true, created: true, handoff: manualCard({ officeId: "valley", odPatientId: 7115 }) });
    od.odAttachSearch.mockResolvedValue({ ...RESULTS, patients: [{ ...RESULTS.patients[0], patNum: 7115 }] });
    inbox(BOTH);
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    await screen.findByTestId("checkout-add-patient-dialog");
    expect(screen.getByTestId("checkout-add-office-roland").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("checkout-add-office-valley"));
    const dialog = await search("Pl");
    fireEvent.click(await within(dialog).findByText("Plum, Ash"));
    await waitFor(() => expect(api.addCheckoutPatient).toHaveBeenCalledWith("valley", 7115));
    expect(od.odAttachSearch).toHaveBeenLastCalledWith("valley", "Pl");
  });

  it("only offices with checkout on are offered", async () => {
    const { TcApiError } = await import("@/features/tc/api");
    api.listCheckout.mockImplementation(async (office: OfficeId, view: string) => {
      if (office === "valley") throw new TcApiError("off", 403, "CHECKOUT_DISABLED", null, []);
      return { success: true, today: "2026-10-30", view, handoffs: [] };
    });
    inbox(BOTH);
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    await screen.findByTestId("checkout-add-patient-dialog");
    expect(screen.queryByTestId("checkout-add-office-valley")).toBeNull();
    expect(screen.queryByTestId("checkout-add-office-roland")).toBeNull();
  });
});

describe("a manual card on the list", () => {
  it("is marked Added by hand and says it has no hygiene visit data", async () => {
    signIn(["tc.full"]);
    api.listCheckout.mockImplementation(async (_o: OfficeId, view: string) => ({
      success: true,
      today: "2026-10-30",
      view,
      handoffs: view === "waiting" ? [manualCard(), hygieneCard()] : [],
    }));
    inbox();
    const rows = await screen.findAllByTestId("checkout-row");
    const manual = rows.find((r) => r.textContent?.includes("Plum, Ash"))!;
    const hyg = rows.find((r) => r.textContent?.includes("Kiwi, Sam"))!;
    expect(within(manual).getByTestId("checkout-row-manual").textContent).toBe("Added by hand");
    // Not "Nothing staged": that is a statement about a hygiene visit this card never had.
    expect(manual.textContent).not.toMatch(/Nothing staged/);
    expect(manual.textContent).toMatch(/no hygiene visit data/);
    expect(within(manual).getByTestId("checkout-row-progress").textContent).toBe("0 of 1 section done");
    expect(within(hyg).queryByTestId("checkout-row-manual")).toBeNull();
    expect(hyg.textContent).toMatch(/1 item staged/);
  });
});

describe("the workup view for a manual card", () => {
  it("one honest 'No hygiene visit data' block; no hygiene sections; referrals is the one section counted; the exit works", async () => {
    workup(manualCard());
    expect(screen.getByTestId("workup-no-hygiene-data").textContent).toMatch(/No hygiene visit data/);
    for (const s of ["workup", "present", "collect"]) expect(screen.queryByTestId(`workup-section-${s}`)).toBeNull();
    for (const s of ["workup-empty-workup", "workup-empty-present", "workup-empty-collect", "workup-next-visit"]) {
      expect(screen.queryByTestId(s), s).toBeNull();
    }
    expect(screen.getByTestId("workup-section-referrals")).toBeTruthy();
    expect(screen.getByTestId("workup-progress").textContent).toBe("0 of 1 section done");
    expect(screen.getByTestId("workup-manual").textContent).toMatch(/Added by hand/);
    expect(screen.getByTestId("workup-origin").textContent).toMatch(/^Added by hand at .* by tc@carein\.ai/);
    expect(screen.queryByText(/Final notes in/)).toBeNull();
    expect(screen.queryByText(/Nothing staged/)).toBeNull();
    expect(screen.queryByText(/Hygiene notes still being finished/)).toBeNull();
    for (const o of ["scheduled", "not_scheduled", "nothing_needed"]) expect(screen.getByTestId(`checkout-outcome-${o}`)).toBeTruthy();
    await screen.findByText(/No referrals for this patient yet/);
    expect(ref.listReferrals).toHaveBeenCalled();
  });

  it("a referrals tick is the whole checklist: 1 of 1", async () => {
    const at = "2026-10-30T15:10:00.000Z";
    workup(manualCard({ workup: { ...emptyCheckoutWorkup(), referrals: { by: "tc@carein.ai", at } } }));
    expect(screen.getByTestId("workup-progress").textContent).toBe("1 of 1 section done");
  });

  it("once a hygiene visit merges onto it, the hygiene sections are back — still marked Added by hand", () => {
    workup(manualCard({ snapshot: VISIT_SNAPSHOT, final: true, hygieneMergedAt: "2026-10-30T15:30:00.000Z" }));
    expect(screen.queryByTestId("workup-no-hygiene-data")).toBeNull();
    for (const s of ["workup", "present", "collect", "referrals"]) expect(screen.getByTestId(`workup-section-${s}`)).toBeTruthy();
    expect(screen.getByTestId("workup-progress").textContent).toBe("0 of 3 sections done");
    expect(screen.getByTestId("workup-manual")).toBeTruthy();
    expect(screen.getByTestId("workup-origin").textContent).toMatch(/hygiene visit arrived at/);
    expect(screen.getAllByTestId("workup-row")).toHaveLength(1);
  });

  it("a hygiene card is unchanged: no manual badge, no empty-state block", () => {
    workup(hygieneCard());
    expect(screen.queryByTestId("workup-no-hygiene-data")).toBeNull();
    expect(screen.queryByTestId("workup-manual")).toBeNull();
    expect(screen.getByTestId("workup-origin").textContent).toMatch(/^Sent by hygiene at/);
  });
});

// RULING (CO-5a fix): a visit that arrives after the card was answered reopens it.
const REOPENED = {
  outcome: "nothing_needed" as const,
  outcomeBy: "tc@carein.ai",
  outcomeAt: "2026-10-30T15:20:00.000Z",
  appointmentNote: null,
  caseId: null,
  reopenedAt: "2026-10-30T15:40:00.000Z",
};
function reopenedCard(): TcCheckoutHandoff {
  return manualCard({ snapshot: VISIT_SNAPSHOT, final: true, hygieneMergedAt: REOPENED.reopenedAt, reopenedFrom: REOPENED });
}

describe("a reopened card (RULING (CO-5a fix))", () => {
  it("the workup says it was updated after the answer, shows the prior answer as history, and is editable again", () => {
    workup(reopenedCard());
    const notice = screen.getByTestId("checkout-reopened-notice");
    expect(within(notice).getByTestId("checkout-reopened").textContent).toMatch(/Updated — hygiene visit arrived after this was answered/);
    expect(screen.getByTestId("checkout-reopened-history").textContent).toMatch(/^Was answered: Nothing needed by tc@carein\.ai at .*\. Reopened at /);
    expect(screen.getByTestId("workup-status").textContent).toMatch(/Waiting/);
    // Editable: the boxes are live and the outcome buttons are there again.
    expect((screen.getByRole("checkbox", { name: "Collected" }) as HTMLButtonElement).disabled).toBe(false);
    for (const o of ["scheduled", "not_scheduled", "nothing_needed"]) expect(screen.getByTestId(`checkout-outcome-${o}`)).toBeTruthy();
  });

  it("the list row carries the badge; a card that was never answered does not", async () => {
    signIn(["tc.full"]);
    api.listCheckout.mockImplementation(async (_o: OfficeId, view: string) => ({
      success: true,
      today: "2026-10-30",
      view,
      handoffs: view === "waiting" ? [reopenedCard(), hygieneCard()] : [],
    }));
    inbox();
    const rows = await screen.findAllByTestId("checkout-row");
    const reopened = rows.find((r) => r.textContent?.includes("Plum, Ash"))!;
    const plain = rows.find((r) => r.textContent?.includes("Kiwi, Sam"))!;
    expect(within(reopened).getByTestId("checkout-reopened")).toBeTruthy();
    expect(within(plain).queryByTestId("checkout-reopened")).toBeNull();
  });

  it("the quick-look sheet shows the same notice and history", async () => {
    api.getCheckoutHandoff.mockResolvedValue(reopenedCard());
    const memory = memoryLocation({ path: "/tc/checkout" });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutSidebar office="roland" handoffId={MANUAL_ID} showOfficeBadge={false} onClose={vi.fn()} />
      </WouterRouter>,
    );
    expect(await screen.findByTestId("checkout-reopened-notice")).toBeTruthy();
    expect(screen.getByTestId("checkout-reopened-history").textContent).toMatch(/Nothing needed/);
  });

  it("a Waiting card merged before any answer shows no reopened notice", () => {
    workup(manualCard({ snapshot: VISIT_SNAPSHOT, final: true, hygieneMergedAt: REOPENED.reopenedAt }));
    expect(screen.queryByTestId("checkout-reopened-notice")).toBeNull();
  });
});

describe("the quick-look sheet for a manual card", () => {
  it("says No hygiene visit data instead of an empty Treatment staged and a blank Next visit", async () => {
    api.getCheckoutHandoff.mockResolvedValue(manualCard());
    const memory = memoryLocation({ path: "/tc/checkout" });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutSidebar office="roland" handoffId={MANUAL_ID} showOfficeBadge={false} onClose={vi.fn()} />
      </WouterRouter>,
    );
    expect(await screen.findByTestId("checkout-no-hygiene-data")).toBeTruthy();
    expect(screen.getByTestId("checkout-manual").textContent).toBe("Added by hand");
    expect(screen.queryByText("Treatment staged")).toBeNull();
    expect(screen.queryByTestId("checkout-next-visit")).toBeNull();
    expect(screen.queryByTestId("checkout-notes-final")).toBeNull();
    expect(screen.queryByTestId("checkout-notes-pending")).toBeNull();
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-5a screenshot dumps", () => {
  it("co5a-01 — the Checkout page with Add patient and a manual card", async () => {
    signIn(["tc.full"]);
    api.listCheckout.mockImplementation(async (_o: OfficeId, view: string) => ({
      success: true,
      today: "2026-10-30",
      view,
      handoffs: view === "waiting" ? [manualCard(), hygieneCard()] : [],
    }));
    inbox();
    await screen.findAllByTestId("checkout-row");
    dump("tccheckout-co5a-01-list@1280x900");
  });

  it("co5a-02 — the Add patient dialog, results shown", async () => {
    signIn(["tc.full"]);
    inbox();
    fireEvent.click(await screen.findByTestId("checkout-add-patient"));
    const dialog = await search("Pl");
    await within(dialog).findByText("Plum, Ash");
    await act(async () => {});
    dump("tccheckout-co5a-02-add-dialog@1280x900");
  });

  it("co5a-04 — a reopened card: answered, then the hygiene visit arrived", async () => {
    workup(reopenedCard());
    await screen.findByText(/No referrals for this patient yet/);
    dump("tccheckout-co5a-04-reopened@1280x1500");
  });

  it("co5a-03 — the workup for a manual card", async () => {
    workup(manualCard());
    await screen.findByText(/No referrals for this patient yet/);
    dump("tccheckout-co5a-03-workup-manual@1280x1300");
  });
});
