/**
 * Queue item 50b (C2b, PM revision): the hygienist's checkout treatment stays
 * visible on the case until a person marks it entered in Open Dental.
 *
 *   7   the staff panel renders the handoff snapshot (items, priority,
 *       urgency, next visit, notes); dark when checkout is off; nothing for a
 *       case without a checkout
 *   8   "Mark entered in OD" shows the mark only once the server returned it;
 *       a refused mark leaves the button; Undo only for an admin
 *   9   the card's "Tx not in OD" chip
 *   11  the OD-pull warning names the hygiene section
 *
 * With TC_SHOTS=1 it also dumps the panel for the checkout shooter
 * (tccheckout-07-hygiene-panel). NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcCheckoutCaseTreatment, TcCheckoutPanelItem } from "@shared/tc/checkout";
import type { TcCase } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
    feature: string | null = null;
    issues: { path: string; code: string; message: string }[] = [];
  }
  return {
    TcApiError,
    odSearchPatients: vi.fn(),
    odTreatmentPlan: vi.fn(),
    odGetPatient: vi.fn(),
    replacePhases: vi.fn(),
    isOdNotConnected: vi.fn(() => false),
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

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { HygieneTreatmentPanel, TxNotInOdChip } from "@/features/tc/checkout/HygieneTreatmentPanel";
import { CaseCardBody } from "@/features/tc/cases/CaseCard";
import { OdPullDialog } from "@/features/tc/od/OdPullDialog";
import type { TcCaseSummary } from "@/features/tc/api";

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const HANDOFF_ID = "7a1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function item(index: number, over: Partial<TcCheckoutPanelItem> = {}): TcCheckoutPanelItem {
  const procedures = [
    { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "Fractured cusp" },
    { teeth: "mouth", code: "SRP", category: "Perio", priority: "preventative", status: "proposed", surfaces: [], scheduleNext: false, note: "" },
  ] as const;
  return {
    index,
    procedure: { ...procedures[index], teeth: procedures[index].teeth === "mouth" ? "mouth" : [3], surfaces: [...procedures[index].surfaces] },
    enteredBy: null,
    enteredAt: null,
    stale: false,
    ...over,
  };
}

function treatment(items: TcCheckoutPanelItem[], canUnattest = false): TcCheckoutCaseTreatment {
  return {
    success: true,
    caseId: CASE_ID,
    canUnattest,
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
            procedures: items.map((i) => i.procedure),
            priority: "urgent",
            nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo" },
            notesPending: false,
            frontDeskNote: "Prefers afternoons.",
            financialNote: "",
          },
          final: true,
          revision: 2,
          submittedBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T15:00:00.000Z",
          updatedAt: "2026-09-08T15:00:00.000Z",
          status: "not_scheduled",
          claimedBy: null,
          claimedAt: null,
          dismissedReason: null,
          dismissedBy: null,
          dismissedAt: null,
          outcomeBy: "tc@carein.ai",
          outcomeAt: "2026-09-08T15:05:00.000Z",
          appointmentNote: null,
          caseId: CASE_ID,
          expiredAt: null,
          expiredBy: null,
        },
        items,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("7: the staff-only “Treatment from hygiene” panel", () => {
  it("renders the snapshot: items, priority, urgency, next visit, notes, and progress", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(
      treatment([item(0, { enteredBy: "tc@carein.ai", enteredAt: "2026-09-08T15:10:00.000Z" }), item(1)]),
    );
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    const panel = await screen.findByTestId("tc-hygiene-treatment-panel");
    expect(checkoutMock.getCaseHygieneTreatment).toHaveBeenCalledWith("roland", CASE_ID);
    expect(within(panel).getByText("Treatment from hygiene")).toBeTruthy();
    expect(within(panel).getByText(/Never shown to the patient/)).toBeTruthy();
    expect(within(panel).getByTestId("tc-hygiene-treatment-progress").textContent).toBe("1 of 2 entered in Open Dental");
    expect(within(panel).getByText(/Prophy · every 6 mo · 60 min · with doctor/)).toBeTruthy();
    expect(within(panel).getByText(/Prefers afternoons\./)).toBeTruthy();

    const rows = within(panel).getAllByTestId("tc-hygiene-item");
    expect(within(rows[0]).getByText("#3 O")).toBeTruthy();
    expect(within(rows[0]).getByText("Urgent")).toBeTruthy();
    expect(within(rows[0]).getByText("Fractured cusp")).toBeTruthy();
    expect(within(rows[0]).getByText("Schedule next visit")).toBeTruthy();
    expect(within(rows[0]).getByText(/Entered · tc@carein\.ai/)).toBeTruthy();
    expect(within(rows[1]).getByText("Whole mouth")).toBeTruthy();
    expect(within(rows[1]).getByText("Preventative")).toBeTruthy();
    expect(within(rows[1]).getByRole("button", { name: /Mark entered in OD/ })).toBeTruthy();
    // Not an admin: no Undo anywhere.
    expect(within(panel).queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("renders nothing when checkout is switched off for the office", async () => {
    const off = new apiMock.TcApiError("off");
    off.code = "CHECKOUT_DISABLED";
    checkoutMock.getCaseHygieneTreatment.mockRejectedValue(off);
    const { container } = render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(checkoutMock.getCaseHygieneTreatment).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a case no checkout landed on", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue({ ...treatment([]), visits: [] });
    const { container } = render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(checkoutMock.getCaseHygieneTreatment).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("says so plainly when it cannot load", async () => {
    checkoutMock.getCaseHygieneTreatment.mockRejectedValue(new Error("Network down"));
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    expect(await screen.findByText(/could not be loaded: Network down/)).toBeTruthy();
  });
});

describe("8: “entered in Open Dental”", () => {
  it("shows the mark only from what the server stored, and then the progress is complete", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(
      treatment([item(0, { enteredBy: "tc@carein.ai", enteredAt: "2026-09-08T15:10:00.000Z" }), item(1)]),
    );
    checkoutMock.markItemEntered.mockResolvedValue({
      success: true,
      handoffId: HANDOFF_ID,
      item: item(1, { enteredBy: "office@carein.ai", enteredAt: "2026-09-08T15:20:00.000Z" }),
    });
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Mark entered in OD/ }));
    await waitFor(() => expect(checkoutMock.markItemEntered).toHaveBeenCalledWith("roland", HANDOFF_ID, 1));
    expect(await screen.findByText(/Entered · office@carein\.ai/)).toBeTruthy();
    expect(screen.getByTestId("tc-hygiene-treatment-progress").textContent).toBe("All entered in Open Dental");
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("a refused mark leaves the item unmarked and says why", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(treatment([item(0)]));
    checkoutMock.markItemEntered.mockRejectedValue(new Error("Not saved"));
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Mark entered in OD/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Not saved"));
    expect(screen.queryByText(/Entered ·/)).toBeNull();
    expect(screen.getByRole("button", { name: /Mark entered in OD/ })).toBeTruthy();
  });

  it("an admin can undo; the item goes back to unmarked", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(
      treatment([item(0, { enteredBy: "tc@carein.ai", enteredAt: "2026-09-08T15:10:00.000Z" })], true),
    );
    checkoutMock.undoItemEntered.mockResolvedValue({ success: true, handoffId: HANDOFF_ID, item: item(0) });
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Undo entered for Crown/ }));
    await waitFor(() => expect(checkoutMock.undoItemEntered).toHaveBeenCalledWith("roland", HANDOFF_ID, 0));
    expect(await screen.findByRole("button", { name: /Mark entered in OD/ })).toBeTruthy();
  });

  it("a stale mark reads as not entered, with a note to check again", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(treatment([item(0, { stale: true })]));
    render(<HygieneTreatmentPanel office="roland" caseId={CASE_ID} />);
    expect(await screen.findByText(/Changed since it was marked/)).toBeTruthy();
    expect(screen.getByTestId("tc-hygiene-treatment-progress").textContent).toBe("0 of 1 entered in Open Dental");
  });
});

function tcCase(over: Partial<TcCase> = {}): TcCase {
  return {
    caseId: CASE_ID,
    legacyId: null,
    officeId: "roland",
    patientName: "Test 2, Stedi",
    patientAge: null,
    phone: null,
    email: null,
    odPatientId: 12827,
    caseType: "Checkout",
    category: "single_tooth",
    status: "pending_pt",
    urgency: "high",
    doctorName: "DOC1",
    diagnosingProvider: "DOC1",
    assignedTc: "",
    caseValueCents: 0,
    readinessScore: 0,
    financingStatus: "",
    preferredFinancingProvider: null,
    decisionMakers: "",
    financialSituation: [],
    keyMotivators: [],
    contactPreference: null,
    bestTimeToReach: "",
    notes: "",
    referralSource: "hygiene",
    lostReason: null,
    diagnosedDate: null,
    statusChangedAt: "2026-09-08T15:00:00.000Z",
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: null,
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    phases: [],
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
    ...over,
  };
}

describe("9: the board card", () => {
  function summary(over: Partial<TcCaseSummary>): TcCaseSummary {
    const { phases: _p, objections: _o, followups: _f, events: _e, hygieneIntake: _h, ...scalars } = tcCase();
    return { ...scalars, createdAt: "2026-09-08T15:00:00.000Z", updatedAt: "2026-09-08T15:00:00.000Z", ...over };
  }

  it("carries “Tx not in OD” while the server says treatment is unentered", () => {
    render(<CaseCardBody caseRow={summary({ txNotInOd: true })} onMove={() => {}} />);
    expect(screen.getByTestId("tc-tx-not-in-od-chip").textContent).toContain("Tx not in OD");
  });

  it("carries nothing once it is all entered, or when the field is absent", () => {
    render(<CaseCardBody caseRow={summary({ txNotInOd: false })} onMove={() => {}} />);
    expect(screen.queryByTestId("tc-tx-not-in-od-chip")).toBeNull();
    cleanup();
    render(<CaseCardBody caseRow={summary({})} onMove={() => {}} />);
    expect(screen.queryByTestId("tc-tx-not-in-od-chip")).toBeNull();
  });

  it("the chip itself", () => {
    render(<TxNotInOdChip />);
    expect(screen.getByText("Tx not in OD")).toBeTruthy();
  });
});

describe("11: Pull from Open Dental names the hygiene section it would remove", () => {
  const plan = {
    patNum: 12827,
    procedures: [{ procNum: 501, toothNum: "19", surf: "", procCode: "D2750", description: "", fee: 1300, insEst: 650, patAmt: 650 }],
    plans: [{ treatPlanNum: 77, heading: "Saved TP", status: "Saved", dateTP: "2026-07-01" }],
    source: { treatPlanNum: 77, status: "Saved", heading: "Saved TP" },
    partial: false,
    truncated: false,
    unreadable: [],
    notes: [],
  };
  const phase = (name: string) => ({ phaseId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8", position: 0, name, description: "", items: [] });

  it("says which checkout section goes, and that the staff panel keeps it", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan);
    render(
      <OdPullDialog
        office="roland"
        tcCase={tcCase({ phases: [phase("Hygiene visit 2026-09-08")] })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const warning = await screen.findByTestId("tc-od-pull-checkout-warning");
    expect(warning.textContent?.replace(/\s+/g, " ")).toBe(
      "This will remove the 'Hygiene visit 2026-09-08' section added at checkout — that treatment remains on the staff panel.",
    );
  });

  it("an ordinary plan gets only the existing replace warning", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan);
    render(
      <OdPullDialog
        office="roland"
        tcCase={tcCase({ phases: [phase("Phase 1 — Restorative")] })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Importing replaces every existing phase/)).toBeTruthy();
    expect(screen.queryByTestId("tc-od-pull-checkout-warning")).toBeNull();
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("tc hygiene panel screenshot dump", () => {
  it("07 — Treatment from hygiene, one entered, one to mark", async () => {
    checkoutMock.getCaseHygieneTreatment.mockResolvedValue(
      treatment([item(0, { enteredBy: "tc@carein.ai", enteredAt: "2026-09-08T15:10:00.000Z" }), item(1)], true),
    );
    render(
      <div className="p-6 max-w-5xl">
        <HygieneTreatmentPanel office="roland" caseId={CASE_ID} />
      </div>,
    );
    await screen.findByTestId("tc-hygiene-treatment-panel");
    const out = resolve(import.meta.dirname, ".shots");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-07-hygiene-panel@1280x700.html"), document.body.innerHTML, "utf8");
  });
});
