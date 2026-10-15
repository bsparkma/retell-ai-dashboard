/**
 * Rider on queue item 52 (from Beau's staging walk): Pull from Open Dental's
 * EMPTY result (Open Dental returned no procedures).
 *
 *   - Import is disabled and says "Nothing to import" instead of offering an
 *     "Import procedures" that does nothing;
 *   - the plan-replacement warnings still show — including the named
 *     hygiene-visit section (item 50b) — instead of vanishing with the table.
 *
 * NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OdPullDialog } from "@/features/tc/od/OdPullDialog";

const EMPTY_PLAN = {
  patNum: 12827,
  procedures: [],
  plans: [],
  source: null,
  partial: false,
  truncated: false,
  unreadable: [],
  notes: [],
};

function tcCase(phaseNames: string[]): TcCase {
  return {
    caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
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
    doctorName: "",
    diagnosingProvider: null,
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
    phases: phaseNames.map((name, i) => ({
      phaseId: `2b1c2d3e-4f50-4a61-8b72-93849${String(i).padStart(7, "0")}`,
      position: i,
      name,
      description: "",
      items: [],
    })),
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.odTreatmentPlan.mockResolvedValue(EMPTY_PLAN);
});
afterEach(cleanup);

function open(c: TcCase) {
  render(<OdPullDialog office="roland" tcCase={c} open onOpenChange={vi.fn()} onImported={vi.fn()} />);
}

describe("Pull from Open Dental: nothing came back", () => {
  it("Import is disabled and says there is nothing to import", async () => {
    open(tcCase([]));
    expect(await screen.findByText(/returned no billable procedures/)).toBeTruthy();
    const importBtn = screen.getByTestId("tc-od-pull-import") as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(importBtn.textContent).toContain("Nothing to import");
    expect(apiMock.replacePhases).not.toHaveBeenCalled();
  });

  it("the hygiene-section warning still shows when the case has a checkout phase", async () => {
    open(tcCase(["Hygiene visit 2026-09-08"]));
    expect(await screen.findByText(/returned no billable procedures/)).toBeTruthy();
    const warning = screen.getByTestId("tc-od-pull-checkout-warning");
    expect(warning.textContent?.replace(/\s+/g, " ")).toBe(
      "This will remove the 'Hygiene visit 2026-09-08' section added at checkout — that treatment remains on the staff panel.",
    );
    expect(screen.getByText(/Importing replaces every existing phase/)).toBeTruthy();
    expect((screen.getByTestId("tc-od-pull-import") as HTMLButtonElement).disabled).toBe(true);
  });

  it("no checkout phase → no hygiene warning", async () => {
    open(tcCase(["Phase 1 — Restorative"]));
    await screen.findByText(/returned no billable procedures/);
    expect(screen.queryByTestId("tc-od-pull-checkout-warning")).toBeNull();
  });
});
