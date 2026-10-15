/**
 * Queue item 50b (C2b): the treatment staged at a hygiene visit persists on
 * the TC case. The backend writes it as a "Hygiene visit <date>" phase of the
 * case's own treatment plan; this proves the Treatment tab the coordinator
 * presents from renders that phase, beside a plan the case already had, and
 * that a case with no plan reads exactly as before.
 *
 * With TC_SHOTS=1 it also dumps the tab for the checkout shooter:
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-checkout-case-treatment.test.tsx
 *   node scripts/shoot-tc-checkout.mjs
 *
 *   tccheckout-06-case-treatment   the Treatment tab after a checkout attached
 *
 * NO NETWORK, NO BACKEND, NO PHI (synthetic names; PatNum 12827 fixture).
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TcCase, TcCasePhase } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/api", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/api")>()),
  replacePhases: vi.fn(),
}));

import { TreatmentTab } from "@/features/tc/caseview/TreatmentTab";
import { patientPortionCentsOf } from "@/features/tc/caseview/FinancingTab";
import { casePatientPortionCents } from "@/features/tc/present/slides";

const EXISTING: TcCasePhase = {
  phaseId: "0b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
  position: 0,
  name: "Implant phase",
  description: "",
  items: [
    {
      itemId: "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
      legacyItemId: null,
      odProcNum: null,
      position: 0,
      tooth: "#14",
      procedureName: "Implant",
      patientDescription: "",
      feeCents: 450000,
      insuranceEstCents: 0,
      patientPortionCents: 450000,
      urgency: "medium",
      timeEstimate: "",
      benefits: [],
      risksOfDelay: [],
      expectedOutcome: "",
    },
  ],
};

/** The phase checkout.js writes for a visit that staged a crown and an SRP. */
const FROM_CHECKOUT: TcCasePhase = {
  phaseId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
  position: 1,
  name: "Hygiene visit 2026-09-08",
  description: "",
  items: [
    { ...EXISTING.items[0], itemId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8", position: 0, tooth: "#3 O", procedureName: "Crown", feeCents: 0, patientPortionCents: 0, urgency: "high" },
    { ...EXISTING.items[0], itemId: "4b1c2d3e-4f50-4a61-8b72-938495a6b7c8", position: 1, tooth: "Whole mouth", procedureName: "SRP", feeCents: 0, patientPortionCents: 0, urgency: "medium" },
  ],
};

function tcCase(phases: TcCasePhase[]): TcCase {
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
    status: "scheduled",
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

afterEach(cleanup);

describe("C2b: the checkout's treatment on the case's Treatment tab", () => {
  it("renders the checkout phase after the plan the case already had", () => {
    render(<TreatmentTab office="roland" tcCase={tcCase([FROM_CHECKOUT, EXISTING])} onCaseUpdate={() => {}} />);
    const titles = screen.getAllByText(/^(Implant phase|Hygiene visit 2026-09-08)$/).map((n) => n.textContent);
    expect(titles).toEqual(["Implant phase", "Hygiene visit 2026-09-08"]);

    // Each staged item is a row of the checkout phase's table.
    for (const [tooth, procedure] of [["#3 O", "Crown"], ["Whole mouth", "SRP"]]) {
      const row = screen.getByText(procedure).closest("tr") as HTMLElement;
      expect(within(row).getByText(tooth)).toBeTruthy();
    }
    // The existing plan keeps its fee; the case total is the existing plan's.
    expect(screen.getByText(/^Case total \$4,500(\.00)? /)).toBeTruthy();
  });

  it("a case with no plan reads exactly as before", () => {
    render(<TreatmentTab office="roland" tcCase={tcCase([])} onCaseUpdate={() => {}} />);
    expect(screen.getByText("No treatment plan yet.")).toBeTruthy();
    expect(screen.queryByText(/Hygiene visit/)).toBeNull();
  });
});

describe("C2b: unpriced checkout items never zero out the Financing tab", () => {
  it("falls back to the case value when every item is still $0, like the slides", () => {
    const valued = { ...tcCase([FROM_CHECKOUT]), caseValueCents: 300000 };
    expect(patientPortionCentsOf(valued)).toBe(300000);
    expect(casePatientPortionCents(valued)).toBe(300000);
  });
  it("uses the itemized portion once anything is priced", () => {
    const priced = { ...tcCase([EXISTING, FROM_CHECKOUT]), caseValueCents: 300000 };
    expect(patientPortionCentsOf(priced)).toBe(450000);
    expect(casePatientPortionCents(priced)).toBe(450000);
  });
});

const OUT = resolve(import.meta.dirname, ".shots");
const SHOOT = process.env.TC_SHOTS === "1";

describe.skipIf(!SHOOT)("tc checkout case-treatment screenshot dump", () => {
  it("06 — Treatment tab after a checkout attached", () => {
    render(
      <div className="p-6 max-w-5xl">
        <TreatmentTab office="roland" tcCase={tcCase([EXISTING, FROM_CHECKOUT])} onCaseUpdate={() => {}} />
      </div>,
    );
    mkdirSync(OUT, { recursive: true });
    const file = resolve(OUT, "tccheckout-06-case-treatment@1280x900.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, document.body.innerHTML, "utf8");
  });
});
