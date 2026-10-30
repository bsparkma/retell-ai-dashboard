/**
 * CO-1 — the checkout WORKUP view, in jsdom.
 *
 *  - every section renders in desk order from the snapshot, including each
 *    one's empty state; today's treatment is copy-friendly (code, tooth, a
 *    primary tooth as its LETTER, surfaces, a priority pill distinct from the
 *    category, the dx in words)
 *  - a box renders the checklist the server READ BACK, never the click; a
 *    stale tick reads as not done; an answered checkout's boxes are read-only
 *  - the referrals block IS the existing ReferralsPanel: it lists and creates
 *    through the very referralsApi functions (and so the routes) the hub, the
 *    case page and the sidebar use, with this checkout as the source
 *  - the exit is the sidebar's own three outcome buttons
 *
 * With TC_SHOTS=1 it also dumps the "after" screenshots (tccheckout-co1-*).
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
  type TcCheckoutProcedure,
} from "@shared/tc/checkout";

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

import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";
import { CheckoutWorkupScreen } from "@/pages/tc/TcCheckoutWorkup";

const HANDOFF_ID = "5d2a7e10-0000-4000-8000-0000000000c1";

const CROWN: TcCheckoutProcedure = {
  teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed",
  surfaces: ["O"], scheduleNext: true, note: "Fractured cusp", dx: ["FX", "D"], dxNote: "Distal marginal ridge",
};
const PRIMARY: TcCheckoutProcedure = {
  teeth: [102], code: "Comp", category: "Restorative", priority: "preventative", status: "proposed",
  surfaces: ["M", "O"], scheduleNext: false, note: "",
};

function handoff(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: HANDOFF_ID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-10-29",
    snapshot: {
      procedures: [CROWN, PRIMARY],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 months, periodic exam" },
      notesPending: false,
      frontDeskNote: "Prefers afternoons.",
      financialNote: "Ask about the crown estimate.",
      existingTx: [
        { procNum: 900001, code: "D2391", description: "Resin, one surface", tooth: "30", surface: "O", dateTp: "2026-06-01", priorityName: null, scheduled: false, clinical: "worse_urgent", patient: "ready_to_schedule", waitTimeframe: null, note: null },
        { procNum: 900002, code: "D2740", description: "Crown, porcelain", tooth: "19", surface: "", dateTp: "2026-06-01", priorityName: null, scheduled: false, clinical: null, patient: "cost_questions", waitTimeframe: null, note: "Wants the estimate first" },
      ],
      collectAtCheckout: ["Fl2", "Mouthwash"],
      records: [{ record: "Pre-op PA", status: "needed" }],
    },
    final: true,
    revision: 2,
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

const EMPTY_SNAPSHOT: TcCheckoutHandoff["snapshot"] = {
  procedures: [],
  priority: null,
  nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
  notesPending: true,
  frontDeskNote: "",
  financialNote: "",
};

function view(h: TcCheckoutHandoff, onChange = vi.fn()) {
  const memory = memoryLocation({ path: `/tc/checkout/${h.handoffId}?office=roland` });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <div className="p-6 max-w-5xl mx-auto">
        <CheckoutWorkup office="roland" handoff={h} onChange={onChange} onReload={vi.fn(async () => {})} />
      </div>
    </WouterRouter>,
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listReferrals.mockResolvedValue([]);
  ref.listDirectory.mockResolvedValue([]);
});
afterEach(cleanup);

describe("the checkout workup view", () => {
  it("renders every section in desk order, then the exit", async () => {
    view(handoff());
    const order = ["workup-section-workup", "workup-section-present", "workup-section-collect", "workup-section-referrals", "workup-exit"];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByTestId("workup-progress").textContent).toBe("0 of 4 sections done");
    // The exit is the sidebar's own buttons.
    for (const o of ["scheduled", "not_scheduled", "nothing_needed"]) expect(screen.getByTestId(`checkout-outcome-${o}`)).toBeTruthy();
    await screen.findByText(/No referrals for this patient yet/);
  });

  it("work up in OD: copy-friendly rows — code, tooth (primary as a LETTER), surfaces, a priority pill apart from the category, dx in words", () => {
    view(handoff());
    const rows = screen.getAllByTestId("workup-row");
    expect(rows).toHaveLength(2);
    const [crown, primary] = rows;
    expect(crown.textContent).toMatch(/#3/);
    expect(crown.textContent).toMatch(/Crown/);
    expect(within(crown).getByTestId("checkout-proc-priority").textContent).toMatch(/Urgent/);
    expect(within(crown).getByTestId("checkout-proc-category").textContent).toBe("Restorative");
    expect(within(crown).getByTestId("workup-dx").textContent).toMatch(/FX \(Fracture\), D \(Decay\)/);
    expect(within(crown).getByTestId("workup-dx").textContent).toMatch(/Distal marginal ridge/);
    // 102 is primary tooth B: printed as its letter, never "#102".
    expect(primary.textContent).toMatch(/\bB\b/);
    expect(primary.textContent).not.toMatch(/#102/);
    expect(primary.textContent).toMatch(/MO/);
    expect(within(primary).getByTestId("workup-dx").textContent).toBe("—");
    expect(screen.getByTestId("workup-records").textContent).toMatch(/Pre-op PA: Still needed/);
  });

  it("existing treatment: the groups in the ratified order, each with its own Ready to present box", () => {
    view(handoff());
    const section = screen.getByTestId("workup-section-present");
    const groups = within(section).getAllByTestId(/^tc-existing-tx-group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual(["tc-existing-tx-group-ready_to_schedule", "tc-existing-tx-group-cost_questions"]);
    expect(within(section).getByTestId("workup-present-ready_to_schedule")).toBeTruthy();
    expect(within(section).getByTestId("workup-present-cost_questions")).toBeTruthy();
  });

  it("empty states: nothing staged, no existing treatment, nothing to collect — each says so, and only referrals counts", async () => {
    view(handoff({ snapshot: EMPTY_SNAPSHOT }));
    expect(screen.getByTestId("workup-empty-workup").textContent).toMatch(/nothing to work up/);
    expect(screen.getByTestId("workup-empty-present").textContent).toMatch(/No existing treatment/);
    expect(screen.getByTestId("workup-empty-collect").textContent).toMatch(/Nothing to collect/);
    expect(screen.queryByTestId("workup-copy")).toBeNull();
    expect(screen.queryByTestId("workup-collected")).toBeNull();
    expect(screen.getByTestId("workup-progress").textContent).toBe("0 of 1 section done");
    expect(screen.getByTestId("workup-section-workup").textContent).toMatch(/Nothing to do/);
    await screen.findByText(/No referrals for this patient yet/);
  });

  it("a tick sends ONE box, and the box shows what the server read back — not the click", async () => {
    // The server answers with nothing ticked (e.g. a concurrent untick won).
    api.setCheckoutWorkup.mockResolvedValueOnce(handoff());
    const onChange = view(handoff());
    fireEvent.click(screen.getByTestId("workup-tick-0"));
    await waitFor(() => expect(api.setCheckoutWorkup).toHaveBeenCalledTimes(1));
    expect(api.setCheckoutWorkup.mock.calls[0]).toEqual(["roland", HANDOFF_ID, { section: "workup", index: 0, done: true }]);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    // The page re-renders from onChange's handoff, which is still unticked.
    expect(onChange.mock.calls[0][0].workup.workedUp).toEqual({});

    for (const [id, body] of [
      ["workup-present-cost_questions", { section: "present", group: "cost_questions", done: true }],
      ["workup-collected", { section: "collect", done: true }],
      ["workup-referrals", { section: "referrals", done: true }],
    ] as const) {
      api.setCheckoutWorkup.mockResolvedValueOnce(handoff());
      fireEvent.click(screen.getByTestId(id));
      await waitFor(() => expect(api.setCheckoutWorkup).toHaveBeenLastCalledWith("roland", HANDOFF_ID, body));
    }
  });

  it("a ticked box renders checked from the stored checklist; a STALE tick renders unchecked and says so", () => {
    const at = "2026-10-29T15:00:00.000Z";
    view(
      handoff({
        workup: {
          workedUp: {
            "0": { by: "tc@carein.ai", at, key: checkoutItemKey(CROWN) },
            "1": { by: "tc@carein.ai", at, key: checkoutItemKey({ ...PRIMARY, teeth: [103] }) },
          },
          present: { ready_to_schedule: { by: "tc@carein.ai", at, key: checkoutPresentKey(handoff().snapshot.existingTx, "ready_to_schedule") } },
          collected: { by: "tc@carein.ai", at, key: checkoutCollectKey(handoff().snapshot.collectAtCheckout) },
          referrals: null,
        },
      }),
    );
    expect(screen.getByTestId("workup-tick-0").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("workup-tick-1").getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("workup-stale")).toBeTruthy();
    expect(screen.getByTestId("workup-present-ready_to_schedule").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("workup-collected").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("workup-section-collect").dataset.done).toBe("true");
    expect(screen.getByTestId("workup-section-workup").dataset.done).toBe("false");
    expect(screen.getByTestId("workup-progress").textContent).toBe("1 of 4 sections done");
  });

  it("review r1: while one save is in flight EVERY box waits, so answers cannot land out of order", async () => {
    let release: (h: TcCheckoutHandoff) => void = () => {};
    api.setCheckoutWorkup.mockImplementationOnce(() => new Promise<TcCheckoutHandoff>((r) => { release = r; }));
    view(handoff());
    fireEvent.click(screen.getByTestId("workup-tick-0"));
    await waitFor(() => expect((screen.getByTestId("workup-collected") as HTMLButtonElement).disabled).toBe(true));
    for (const id of ["workup-tick-1", "workup-referrals", "workup-present-cost_questions"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    release(handoff());
    await waitFor(() => expect((screen.getByTestId("workup-collected") as HTMLButtonElement).disabled).toBe(false));
  });

  it("review r2: two clicks inside ONE render (a double-click) still send only one save", async () => {
    let release: (h: TcCheckoutHandoff) => void = () => {};
    api.setCheckoutWorkup.mockImplementationOnce(() => new Promise<TcCheckoutHandoff>((r) => { release = r; }));
    view(handoff());
    const a = screen.getByTestId("workup-tick-0");
    const b = screen.getByTestId("workup-referrals");
    act(() => {
      a.click();
      b.click();
    });
    await waitFor(() => expect(api.setCheckoutWorkup).toHaveBeenCalledTimes(1));
    release(handoff());
    await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
    expect(api.setCheckoutWorkup).toHaveBeenCalledTimes(1);
  });

  it("review r1: a Ready-to-present or Collected tick made against a since-changed list reads as not done", () => {
    const at = "2026-10-29T15:00:00.000Z";
    view(
      handoff({
        workup: {
          workedUp: {},
          present: { ready_to_schedule: { by: "tc@carein.ai", at, key: "[1]" } },
          collected: { by: "tc@carein.ai", at, key: JSON.stringify(["Fl2"]) },
          referrals: null,
        },
      }),
    );
    expect(screen.getByTestId("workup-present-ready_to_schedule").getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("workup-collected").getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("workup-progress").textContent).toBe("0 of 4 sections done");
  });

  it("an answered checkout is read-only: every box disabled, the answer shown instead of the buttons", () => {
    view(handoff({ status: "scheduled", outcomeBy: "tc@carein.ai", outcomeAt: "2026-10-29T15:10:00.000Z", appointmentNote: "Tue 9:00" }));
    for (const id of ["workup-tick-0", "workup-collected", "workup-referrals", "workup-present-ready_to_schedule"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByTestId("checkout-answered").textContent).toMatch(/Scheduled/);
    expect(screen.queryByTestId("checkout-outcome-scheduled")).toBeNull();
  });

  it("referrals: the embedded panel lists and starts through the SAME referralsApi as the hub, with this checkout as the source", async () => {
    ref.createReferral.mockResolvedValue({
      referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8", officeId: "roland", odPatientId: 12827, patientName: "Kiwi, Sam",
      tcCaseId: null, sourceKind: "checkout", sourceRef: HANDOFF_ID, referringProvider: "DOC1", directoryEntryId: null,
      practiceName: "River Endodontics", specialty: "Endodontics", reason: "Possible cracked tooth", teeth: [3], urgency: "routine",
      narrative: "", status: "draft", statusChangedAt: "2026-10-29T15:00:00.000Z", statusChangedBy: "tc@carein.ai",
      createdBy: "tc@carein.ai", createdAt: "2026-10-29T15:00:00.000Z", updatedAt: "2026-10-29T15:00:00.000Z",
    });
    view(handoff());
    const section = screen.getByTestId("workup-section-referrals");
    await waitFor(() => expect(ref.listReferrals).toHaveBeenCalledWith("roland", { handoffId: HANDOFF_ID }));
    fireEvent.click(await within(section).findByRole("button", { name: /New referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Possible cracked tooth" } });
    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(ref.createReferral).toHaveBeenCalledTimes(1));
    const [office, source, input] = ref.createReferral.mock.calls[0];
    expect(office).toBe("roland");
    expect(source).toEqual({ handoffId: HANDOFF_ID });
    // No patient, office or status from the client: the server derives them.
    for (const k of ["odPatientId", "patientName", "officeId", "status"]) expect(input).not.toHaveProperty(k);
  });

  it("the page loads the handoff for the office in the URL and shows the read-back", async () => {
    api.getCheckoutHandoff.mockResolvedValue(handoff());
    const memory = memoryLocation({ path: `/tc/checkout/${HANDOFF_ID}?office=roland` });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutWorkupScreen office="roland" handoffId={HANDOFF_ID} showOfficeBadge={false} />
      </WouterRouter>,
    );
    expect((await screen.findByTestId("workup-patient")).textContent).toBe("Kiwi, Sam");
    expect(api.getCheckoutHandoff).toHaveBeenCalledWith("roland", HANDOFF_ID);
    expect(screen.getByTestId("workup-back").getAttribute("href")).toBe("/tc/checkout");
  });
});

// ── screenshot dumps (the report's "after") ─────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("checkout workup screenshot dumps", () => {
  it("co1-01 — the workup view, part-done", async () => {
    const at = "2026-10-29T15:00:00.000Z";
    view(
      handoff({
        workup: {
          workedUp: { "0": { by: "tc@carein.ai", at, key: checkoutItemKey(CROWN) } },
          present: {
            ready_to_schedule: { by: "tc@carein.ai", at, key: checkoutPresentKey(handoff().snapshot.existingTx, "ready_to_schedule") },
            cost_questions: { by: "tc@carein.ai", at, key: checkoutPresentKey(handoff().snapshot.existingTx, "cost_questions") },
          },
          collected: { by: "tc@carein.ai", at, key: checkoutCollectKey(handoff().snapshot.collectAtCheckout) },
          referrals: null,
        },
      }),
    );
    await screen.findByText(/No referrals for this patient yet/);
    dump("tccheckout-co1-01-workup@1280x2000");
  });

  it("co1-02 — the workup view, nothing staged", async () => {
    view(handoff({ patientName: "Fig, Lee", status: "open", claimedBy: null, claimedAt: null, snapshot: EMPTY_SNAPSHOT }));
    await screen.findByText(/No referrals for this patient yet/);
    dump("tccheckout-co1-02-empty@1280x1300");
  });
});
