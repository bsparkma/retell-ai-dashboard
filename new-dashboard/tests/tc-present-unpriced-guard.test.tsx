/**
 * Queue item 50b (C2b, PM revision) acceptance 10: the PRESENT GUARD.
 *
 * A checkout writes the hygienist's staged treatment into the plan at $0. If a
 * case still holds a checkout-origin phase with a $0 item, the presentation
 * opens on a staff warning instead of the first slide, and goes on only after
 * an explicit "Present anyway". A priced plan, or one with no checkout section,
 * goes straight to the deck as before.
 *
 * Also proves the staff panel's data never reaches the deck: the presentation
 * never asks for the checkout panel.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { TcCase, TcCasePhase } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => ({
  getCase: vi.fn(),
  getLibrary: vi.fn(async () => ({})),
  listGallery: vi.fn(async () => []),
  tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "error")),
  tcMediaUrl: vi.fn(() => ""),
}));
vi.mock("@/features/tc/api", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/api")>()),
  ...apiMock,
}));
const checkoutMock = vi.hoisted(() => ({ getCaseHygieneTreatment: vi.fn() }));
vi.mock("@/features/tc/checkout/checkoutApi", () => checkoutMock);
vi.mock("@/features/tc/components/TcShell", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/components/TcShell")>()),
  useTcOffice: () => "roland",
}));
vi.mock("@/contexts/OfficeContext", () => ({ useOffice: () => ({ offices: [] }) }));

import TcPresentation from "@/pages/tc/TcPresentation";

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function phase(name: string, feeCents: number): TcCasePhase {
  return {
    phaseId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    position: 0,
    name,
    description: "",
    items: [
      {
        itemId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
        legacyItemId: null,
        odProcNum: null,
        position: 0,
        tooth: "#3 O",
        procedureName: "Crown",
        patientDescription: "",
        feeCents,
        insuranceEstCents: 0,
        patientPortionCents: feeCents,
        urgency: "high",
        timeEstimate: "",
        benefits: [],
        risksOfDelay: [],
        expectedOutcome: "",
      },
    ],
  };
}

function tcCase(phases: TcCasePhase[]): TcCase {
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
    phases,
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
  };
}

function renderDeck() {
  const { hook } = memoryLocation({ path: `/tc/present/${CASE_ID}` });
  return render(
    <WouterRouter hook={hook}>
      <Route path="/tc/present/:caseId" component={TcPresentation} />
    </WouterRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("10: the Present guard", () => {
  it("unpriced hygiene-visit items stop the deck until the coordinator confirms", async () => {
    apiMock.getCase.mockResolvedValue(tcCase([phase("Hygiene visit 2026-09-08", 0)]));
    renderDeck();
    const guard = await screen.findByTestId("tc-present-unpriced-guard");
    expect(guard.textContent).toContain(
      "This plan has unpriced hygiene-visit items — set fees before presenting.",
    );
    expect(guard.textContent).toContain("Hygiene visit 2026-09-08");
    expect(screen.getByRole("link", { name: /Back to the case to set fees/ }).getAttribute("href")).toBe(
      `/tc/cases/${CASE_ID}`,
    );
    // No slide yet: the slide counter is not on screen.
    expect(screen.queryByText(/^1 \/ \d+$/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Present anyway" }));
    expect(screen.queryByTestId("tc-present-unpriced-guard")).toBeNull();
    expect(await screen.findByText(/^1 \/ \d+$/)).toBeTruthy();
  });

  it("a priced hygiene section goes straight to the deck", async () => {
    apiMock.getCase.mockResolvedValue(tcCase([phase("Hygiene visit 2026-09-08", 120000)]));
    renderDeck();
    expect(await screen.findByText(/^1 \/ \d+$/)).toBeTruthy();
    expect(screen.queryByTestId("tc-present-unpriced-guard")).toBeNull();
  });

  it("a $0 item in an ordinary (non-checkout) phase is not this guard's business", async () => {
    apiMock.getCase.mockResolvedValue(tcCase([phase("Phase 1 — Restorative", 0)]));
    renderDeck();
    expect(await screen.findByText(/^1 \/ \d+$/)).toBeTruthy();
    expect(screen.queryByTestId("tc-present-unpriced-guard")).toBeNull();
  });

  it("the deck never asks for the staff-only hygiene panel", async () => {
    apiMock.getCase.mockResolvedValue(tcCase([phase("Hygiene visit 2026-09-08", 120000)]));
    renderDeck();
    await screen.findByText(/^1 \/ \d+$/);
    expect(checkoutMock.getCaseHygieneTreatment).not.toHaveBeenCalled();
    expect(screen.queryByText("Treatment from hygiene")).toBeNull();
  });
});
