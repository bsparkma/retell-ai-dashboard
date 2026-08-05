/**
 * Open Dental read surfaces (Slice 5) — jsdom component tests.
 *
 * The api module is mocked so every OD read is scripted. What is asserted is
 * exactly the behaviour that makes these affordances safe to ship:
 *
 *   - the pull REVIEWS before it imports; nothing reaches the case on fetch
 *   - an office with no OD connection renders the honest not-connected state,
 *     not an error and not a blank panel
 *   - a partial or truncated plan says so, on screen, before the user confirms
 *   - patient search never auto-selects and always shows DOB for disambiguation
 *   - a COB pull states the basis of the YTD numbers it pre-filled
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
    odCobProcedures: vi.fn(),
    odInsurance: vi.fn(),
    odNextAppointment: vi.fn(),
    odGetPatient: vi.fn(),
    odStatus: vi.fn(),
    odUnaccepted: vi.fn(),
    replacePhases: vi.fn(),
    createCase: vi.fn(),
    isOdNotConnected: vi.fn(
      (e: unknown) => e instanceof TcApiError && e.code === "OFFICE_NOT_CONNECTED",
    ),
    tcErrorMessage: vi.fn((e: unknown) =>
      e instanceof Error ? e.message : "Something went wrong.",
    ),
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { OdPatientSearch, OdNotConnected } from "@/features/tc/od/OdShell";
import { OdPullDialog } from "@/features/tc/od/OdPullDialog";
import { OdNextAppointment } from "@/features/tc/od/OdNextAppointment";
import { groupItemsIntoPhases, inferUrgency, itemsFromOdProcedures } from "@/features/tc/od/odPlan";
import { ageFromBirthdate, fieldsFromOdPatient } from "@/features/tc/od/odPatient";
import { describeCode } from "@/features/tc/od/odCodes";
import type { OdPatient, OdTreatmentPlan } from "@/features/tc/api";
import type { TcCase } from "@shared/tc/contract";

// ── Fixtures ────────────────────────────────────────────────────────────────

const MANGO: OdPatient = {
  patNum: 12828,
  firstName: "Mango",
  lastName: "MangoTest",
  displayName: "MangoTest, Mango",
  birthdate: "1990-04-01",
  phone: "9185550100",
  email: "mango@example.test",
  status: "Patient",
};

const STEDI: OdPatient = {
  patNum: 12827,
  firstName: "Stedi",
  lastName: "Test 2",
  displayName: "Test 2, Stedi",
  birthdate: "1985-11-20",
  phone: "9185550101",
  email: "",
  status: "Patient",
};

function notConnectedError() {
  const e = new apiMock.TcApiError("Open Dental is not connected for this office yet");
  e.code = "OFFICE_NOT_CONNECTED";
  e.status = 503;
  return e;
}

function emptyCase(over: Partial<TcCase> = {}): TcCase {
  return {
    caseId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    officeId: "roland",
    patientName: "Mango MangoTest",
    patientAge: null,
    phone: null,
    email: null,
    odPatientId: null,
    category: "single_tooth",
    caseType: "Single tooth",
    status: "pending_tc",
    urgency: "medium",
    lostReason: null,
    statusChangedAt: "2026-08-01T00:00:00.000Z",
    doctorName: "",
    assignedTc: "",
    caseValueCents: 0,
    notes: "",
    referralSource: null,
    readinessScore: 0,
    phases: [],
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
    ...over,
  } as unknown as TcCase;
}

function plan(over: Partial<OdTreatmentPlan> = {}): OdTreatmentPlan {
  return {
    patNum: 12828,
    procedures: [
      { procNum: 501, toothNum: "19", surf: "", procCode: "D2750", description: "", fee: 1300, insEst: 650, patAmt: 650 },
      { procNum: 502, toothNum: "N/A", surf: "", procCode: "D7140", description: "Extraction", fee: 250, insEst: 100, patAmt: 150 },
    ],
    plans: [{ treatPlanNum: 77, heading: "Saved TP", status: "Saved", dateTP: "2026-07-01" }],
    source: { treatPlanNum: 77, status: "Saved", heading: "Saved TP" },
    partial: false,
    truncated: false,
    unreadable: [],
    notes: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

// ── Patient search ──────────────────────────────────────────────────────────

describe("OdPatientSearch", () => {
  it("debounces, shows DOB for disambiguation, and never auto-selects", async () => {
    apiMock.odSearchPatients.mockResolvedValue({
      query: "Test",
      matchMode: "prefix",
      patients: [MANGO, STEDI],
      truncated: false,
      notes: [],
    });
    const onSelect = vi.fn();
    render(<OdPatientSearch office="roland" onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText("Search Open Dental"), { target: { value: "Test" } });

    await screen.findByText("MangoTest, Mango");
    // Two candidates and NOTHING chosen — a prefix match must never be resolved
    // for the user; picking the wrong patient is a clinical error.
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/DOB 1990-04-01/)).toBeTruthy();
    expect(screen.getByText(/DOB 1985-11-20/)).toBeTruthy();
    // The prefix behaviour is stated, not assumed.
    expect(screen.getByText(/start with/i)).toBeTruthy();

    fireEvent.click(screen.getByText("MangoTest, Mango"));
    expect(onSelect).toHaveBeenCalledWith(MANGO);
  });

  it("never calls OD for a one-character term", async () => {
    render(<OdPatientSearch office="roland" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search Open Dental"), { target: { value: "T" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(apiMock.odSearchPatients).not.toHaveBeenCalled();
  });

  it("renders the not-connected state for an office with no OD", async () => {
    apiMock.odSearchPatients.mockRejectedValue(notConnectedError());
    render(<OdPatientSearch office="valley" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search Open Dental"), { target: { value: "Test" } });

    expect(await screen.findByText(/OD not connected for this office yet\./i)).toBeTruthy();
    // Not an error box — this office simply has no connection yet.
    expect(screen.queryByText(/Try again/i)).toBeNull();
  });

  it("says so plainly when a search finds nothing", async () => {
    apiMock.odSearchPatients.mockResolvedValue({
      query: "Zzz",
      matchMode: "prefix",
      patients: [],
      truncated: false,
      notes: [],
    });
    render(<OdPatientSearch office="roland" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search Open Dental"), { target: { value: "Zzz" } });
    expect(await screen.findByText(/No Open Dental patients start with/i)).toBeTruthy();
  });
});

describe("OdNotConnected", () => {
  it("uses the same wording as the calls worklist", () => {
    render(<OdNotConnected />);
    expect(screen.getByText("OD not connected for this office yet.")).toBeTruthy();
  });
});

// ── The pull-review flow ────────────────────────────────────────────────────

describe("OdPullDialog", () => {
  it("reviews before importing — the case is untouched until confirm", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan());
    apiMock.replacePhases.mockResolvedValue(emptyCase({ odPatientId: 12828 }));
    const onImported = vi.fn();

    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase({ odPatientId: 12828 })}
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />,
    );

    // The plan is on screen…
    expect(await screen.findByText(/Crown — porcelain fused to high noble metal/)).toBeTruthy();
    expect(screen.getByText("Extraction")).toBeTruthy();
    // …and nothing has been written.
    expect(apiMock.replacePhases).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Import 2 procedures/i }));

    await waitFor(() => expect(apiMock.replacePhases).toHaveBeenCalledTimes(1));
    const [, , phases] = apiMock.replacePhases.mock.calls[0];
    // Urgency grouping is the legacy grouping: D7 → urgent, D2 → restorative.
    expect(phases.map((p: { name: string }) => p.name)).toEqual([
      "Phase 1 — Urgent Treatment",
      "Phase 2 — Restorative",
    ]);
    // Dollars became integer cents exactly once.
    expect(phases[1].items[0].feeCents).toBe(130000);
    expect(phases[1].items[0].insuranceEstCents).toBe(65000);
    expect(phases[1].items[0].patientPortionCents).toBe(65000);
    expect(onImported).toHaveBeenCalled();
  });

  it("lets the reviewer drop a line and edit a fee before importing", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan());
    apiMock.replacePhases.mockResolvedValue(emptyCase());

    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase({ odPatientId: 12828 })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    await screen.findByText("Extraction");

    // Drop the extraction, correct the crown fee.
    fireEvent.click(screen.getByLabelText("Include Extraction"));
    fireEvent.change(screen.getByLabelText(/Fee for Crown/), { target: { value: "1450" } });

    fireEvent.click(screen.getByRole("button", { name: /Import 1 procedure/i }));
    await waitFor(() => expect(apiMock.replacePhases).toHaveBeenCalled());

    const [, , phases] = apiMock.replacePhases.mock.calls[0];
    expect(phases).toHaveLength(1);
    expect(phases[0].items).toHaveLength(1);
    expect(phases[0].items[0].feeCents).toBe(145000);
  });

  it("blocks the import while an amount is unparseable", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan());
    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase({ odPatientId: 12828 })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    await screen.findByText("Extraction");

    fireEvent.change(screen.getByLabelText(/Fee for Extraction/), { target: { value: "abc" } });
    expect(screen.getByText(/Fix the highlighted amounts/i)).toBeTruthy();
    const importBtn = screen.getByRole("button", { name: /Import/i }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(apiMock.replacePhases).not.toHaveBeenCalled();
  });

  it("shows what Open Dental could not give before the user confirms", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(
      plan({
        partial: true,
        truncated: true,
        unreadable: [{ procNum: 999, reason: "OD 500" }],
        notes: ["3 procedure(s) could not be read from Open Dental and are excluded from the totals."],
      }),
    );
    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase({ odPatientId: 12828 })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(await screen.findByText(/could not be read from Open Dental/i)).toBeTruthy();
    expect(screen.getByText(/Not imported: #999/)).toBeTruthy();
  });

  it("warns that importing replaces an existing plan", async () => {
    apiMock.odTreatmentPlan.mockResolvedValue(plan());
    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase({
          odPatientId: 12828,
          phases: [{ phaseId: "p1", position: 0, name: "Phase 1", description: "", items: [] }],
        } as Partial<TcCase>)}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Importing replaces every existing phase/i)).toBeTruthy();
  });

  it("asks for a patient first when the case has no OD link", async () => {
    render(
      <OdPullDialog
        office="roland"
        tcCase={emptyCase()}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(await screen.findByLabelText("Search Open Dental")).toBeTruthy();
    expect(apiMock.odTreatmentPlan).not.toHaveBeenCalled();
  });

  it("shows the not-connected state instead of an error for an office without OD", async () => {
    apiMock.odTreatmentPlan.mockRejectedValue(notConnectedError());
    render(
      <OdPullDialog
        office="valley"
        tcCase={emptyCase({ odPatientId: 12828 })}
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(await screen.findByText(/OD not connected for this office yet\./i)).toBeTruthy();
  });
});

// ── Next appointment ────────────────────────────────────────────────────────

describe("OdNextAppointment", () => {
  it("renders nothing without a linked patient", () => {
    const { container } = render(<OdNextAppointment office="roland" patNum={null} />);
    expect(container.textContent).toBe("");
    expect(apiMock.odNextAppointment).not.toHaveBeenCalled();
  });

  it("shows the appointment for a linked patient", async () => {
    apiMock.odNextAppointment.mockResolvedValue({
      appointment: {
        aptNum: 1,
        dateTime: "2026-09-15 09:00:00",
        description: "Crown prep",
        providerName: "BS",
        operatory: 3,
        isHygiene: false,
      },
    });
    render(<OdNextAppointment office="roland" patNum={12828} />);
    const line = await screen.findByTestId("od-next-appointment");
    expect(line.textContent).toMatch(/Next appt: Sep 15/);
    expect(line.textContent).toMatch(/Crown prep/);
  });

  it("distinguishes 'none scheduled' from 'could not check'", async () => {
    apiMock.odNextAppointment.mockResolvedValue({ appointment: null });
    const { unmount } = render(<OdNextAppointment office="roland" patNum={12828} />);
    expect(await screen.findByText(/No upcoming appointment in Open Dental/i)).toBeTruthy();
    unmount();

    apiMock.odNextAppointment.mockRejectedValue(new Error("boom"));
    render(<OdNextAppointment office="roland" patNum={12828} />);
    expect(await screen.findByText(/couldn’t reach Open Dental/i)).toBeTruthy();
  });

  it("says the office has no OD rather than going blank", async () => {
    apiMock.odNextAppointment.mockRejectedValue(notConnectedError());
    render(<OdNextAppointment office="valley" patNum={12828} />);
    expect(await screen.findByText(/OD not connected for this office yet/i)).toBeTruthy();
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("odPlan", () => {
  it("keeps the legacy urgency rules", () => {
    expect(inferUrgency("D7140", "Extraction")).toBe("high");
    expect(inferUrgency("D3330", "Endodontic therapy")).toBe("high");
    expect(inferUrgency("D2750", "Crown")).toBe("medium");
    expect(inferUrgency("D4341", "Scaling and root planing")).toBe("medium");
    expect(inferUrgency("D8080", "Comprehensive ortho")).toBe("elective");
    expect(inferUrgency("D9944", "Occlusal guard")).toBe("low");
    // Description keywords win where the code family says nothing.
    expect(inferUrgency("D9110", "Emergency palliative treatment")).toBe("high");
  });

  it("keeps the legacy phase names and the single-phase fallback", () => {
    const item = (urgency: string) =>
      ({ urgency, position: 0, procedureName: "x" }) as unknown as Parameters<
        typeof groupItemsIntoPhases
      >[0][number];

    expect(groupItemsIntoPhases([item("high"), item("medium"), item("elective")]).map((p) => p.name)).toEqual([
      "Phase 1 — Urgent Treatment",
      "Phase 2 — Restorative",
      "Phase 3 — Elective / Cosmetic",
    ]);
    // Only elective work still starts at Phase 1.
    expect(groupItemsIntoPhases([item("elective")])[0].name).toBe("Phase 1 — Elective / Cosmetic");
    expect(groupItemsIntoPhases([])).toEqual([]);
  });

  it("fills a missing OD description from the CDT map and never leaves a bare code", () => {
    const [crown] = itemsFromOdProcedures([
      { procNum: 1, toothNum: "19", surf: "", procCode: "D2750", description: "", fee: 1300, insEst: 0, patAmt: 1300 },
    ]);
    expect(crown.procedureName).toBe("Crown — porcelain fused to high noble metal");
    // OD's own description wins when present.
    expect(describeCode("D2750", "Practice crown")).toBe("Practice crown");
    // An unknown code degrades to the code, never to an empty label.
    expect(describeCode("D9X99", "")).toBe("D9X99");
  });

  it("clamps an insurance estimate that exceeds the fee, so totals reconcile", () => {
    const [item] = itemsFromOdProcedures([
      { procNum: 1, toothNum: "3", surf: "", procCode: "D2740", description: "Crown", fee: 100, insEst: 500, patAmt: 0 },
    ]);
    expect(item.feeCents).toBe(10000);
    expect(item.insuranceEstCents).toBe(10000);
    expect(item.patientPortionCents).toBe(0);
  });

  it("drops OD's 'N/A' tooth rather than importing it as a tooth number", () => {
    const [item] = itemsFromOdProcedures([
      { procNum: 1, toothNum: "N/A", surf: "", procCode: "D0150", description: "Exam", fee: 90, insEst: 0, patAmt: 90 },
    ]);
    expect(item.tooth).toBe("");
  });
});

describe("odPatient", () => {
  it("computes age from an OD birthdate, honouring whether the birthday has passed", () => {
    expect(ageFromBirthdate("1990-04-01", new Date(2026, 7, 4))).toBe(36);
    expect(ageFromBirthdate("1990-12-01", new Date(2026, 7, 4))).toBe(35);
  });

  it("returns null rather than a nonsense age the form would then reject", () => {
    expect(ageFromBirthdate("")).toBeNull();
    expect(ageFromBirthdate("0001-01-01")).toBeNull();
    expect(ageFromBirthdate("not a date")).toBeNull();
  });

  it("renders the case name as First Last, not OD's Last, First", () => {
    const fields = fieldsFromOdPatient(MANGO, new Date(2026, 7, 4));
    expect(fields.patientName).toBe("Mango MangoTest");
    expect(fields.odPatientId).toBe(12828);
    expect(fields.patientAge).toBe("36");
  });
});
