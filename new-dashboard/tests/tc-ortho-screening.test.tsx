/**
 * THE ORTHO SCREENING ON THE TC SIDE (queue item 33, acceptance 8).
 *
 *   - The case detail renders the screening: the shared summary line, every
 *     ANSWERED field as label → value (unanswered omitted), and the note.
 *   - A case WITHOUT a screening renders exactly as before: no section, the
 *     same tabs in the same order.
 *   - The board card carries "Ortho · needs work-up" for a hygiene_review case
 *     with a screening, and nothing otherwise.
 *
 * NO NETWORK, NO PHI — synthetic names; the roland test fixture PatNum.
 */
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase, TcHygieneIntake } from "../shared/tc/contract";
import { emptyOrthoScreening, orthoScreeningSummary, type OrthoScreening } from "../shared/hyg/orthoScreening";

const store = vi.hoisted(() => ({ tcCase: null as unknown }));

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, getCase: vi.fn(async () => store.tcCase) };
});

vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/components/TcShell")>();
  return { ...actual, useTcOffice: () => "roland" };
});

import TcCaseView from "../client/src/pages/tc/TcCaseView";
import { CaseCardBody } from "../client/src/features/tc/cases/CaseCard";
import { OrthoScreeningSection } from "../client/src/features/tc/caseview/OrthoScreeningSection";
import type { TcCaseSummary } from "../client/src/features/tc/api";
import { ThemeProvider } from "../client/src/contexts/ThemeContext";
import { TooltipProvider } from "../client/src/components/ui/tooltip";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
});

const SCREENING: OrthoScreening = {
  ...emptyOrthoScreening(),
  interest: "yes",
  decider: "parent",
  concerns: ["crowding", "overbite"],
  months: [18, 24],
  modality: "aligners",
  noteForTc: "Parent asked about cost before school starts.",
};

function intake(orthoScreening: OrthoScreening | null): TcHygieneIntake {
  return {
    submittedBy: "hygienist@carein.ai",
    submittedByName: "Hyg User",
    hygienistName: "Raegan",
    submittedAt: "2026-09-08T14:42:00.000Z",
    operatory: "Hygiene 1",
    visitDate: "2026-09-08",
    providerSeen: "HYG1",
    chiefConcern: "Crowding, Overbite",
    perioStatus: "unknown",
    recallType: "none",
    radiographs: ["none"],
    intraoralPhotosTaken: false,
    areasOfConcern: "",
    suspectedTreatment: orthoScreening ? orthoScreeningSummary(orthoScreening) : "",
    hygienistRecommendation: "",
    insuranceNoted: "",
    patientInterestLevel: "hot",
    flagUrgent: false,
    orthoScreening,
  };
}

function makeCase(overrides: Partial<TcCase> = {}): TcCase {
  return {
    caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    legacyId: null,
    officeId: "roland",
    patientName: "Kiwi, Sam",
    patientAge: 12,
    phone: "479-555-0100",
    email: null,
    odPatientId: 12827,
    caseType: "Ortho screening",
    category: "ortho",
    status: "hygiene_review",
    urgency: "elective",
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
    statusChangedAt: "2026-09-08T14:42:00.000Z",
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
    hygieneIntake: intake(SCREENING),
    ...overrides,
  };
}

function renderCaseView(tcCase: TcCase) {
  store.tcCase = tcCase;
  const memory = memoryLocation({ path: `/tc/cases/${tcCase.caseId}` });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path="/tc/cases/:id" component={TcCaseView} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const TABS = ["Treatment", "Financing", "Objections", "Follow-Ups", "Notes", "Activity"];

describe("8: the TC case detail", () => {
  it("renders the screening: summary, answered rows only, and the hygienist's note", async () => {
    renderCaseView(makeCase());
    const section = await screen.findByTestId("tc-ortho-screening");
    expect(within(section).getByTestId("tc-ortho-summary").textContent).toBe(
      "Interested: Yes · Parent decides · Crowding, Overbite · Clear aligners · 18–24 mo",
    );
    const rows = within(section)
      .getAllByTestId("tc-ortho-row")
      .map((r) => [r.querySelector("dt")?.textContent, r.querySelector("dd")?.textContent]);
    expect(rows).toEqual([
      ["Interested?", "Yes"],
      ["Who decides?", "Parent decides"],
      ["Concerns", "Crowding, Overbite"],
      ["Aligners or braces?", "Clear aligners"],
      ["Estimated months", "18–24 mo"],
    ]);
    // Unanswered fields are not shown blank.
    expect(within(section).queryByText("Which arches?")).toBeNull();
    expect(within(section).getByTestId("tc-ortho-note").textContent).toMatch(
      /Parent asked about cost before school starts\./,
    );
    expect(section.textContent).toMatch(/From hygiene · Raegan/);
    // The working tabs are untouched.
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TABS);
  });

  it("a case WITHOUT a screening renders exactly as before — no section, same tabs", async () => {
    renderCaseView(makeCase({ hygieneIntake: intake(null), category: "single_tooth" }));
    await screen.findByText("Treatment");
    expect(screen.queryByTestId("tc-ortho-screening")).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TABS);
  });

  it("a case with no hygiene intake at all renders exactly as before", async () => {
    renderCaseView(makeCase({ hygieneIntake: null, referralSource: null, status: "presented" }));
    await screen.findByText("Treatment");
    expect(screen.queryByTestId("tc-ortho-screening")).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TABS);
  });

  it("the section alone renders nothing for a case without a screening", () => {
    const { container } = render(
      <OrthoScreeningSection tcCase={makeCase({ hygieneIntake: intake(null) })} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("the board card", () => {
  function summary(over: Partial<TcCaseSummary>): TcCaseSummary {
    const {
      phases: _p,
      objections: _o,
      followups: _f,
      events: _e,
      hygieneIntake: _h,
      ...scalars
    } = makeCase();
    return {
      ...scalars,
      createdAt: "2026-09-08T14:42:00.000Z",
      updatedAt: "2026-09-08T14:42:00.000Z",
      ...over,
    };
  }

  it("a hygiene_review case with a screening carries “Ortho · needs work-up”", () => {
    render(<CaseCardBody caseRow={summary({ hasOrthoScreening: true })} onMove={() => {}} />);
    expect(screen.getByTestId("tc-ortho-workup-chip").textContent).toBe("Ortho · needs work-up");
  });

  it("no chip without a screening, or once the case has left hygiene_review", () => {
    render(<CaseCardBody caseRow={summary({ hasOrthoScreening: false })} onMove={() => {}} />);
    expect(screen.queryByTestId("tc-ortho-workup-chip")).toBeNull();
    cleanup();
    render(<CaseCardBody caseRow={summary({})} onMove={() => {}} />);
    expect(screen.queryByTestId("tc-ortho-workup-chip")).toBeNull();
    cleanup();
    render(
      <CaseCardBody
        caseRow={summary({ hasOrthoScreening: true, status: "pending_tc" })}
        onMove={() => {}}
      />,
    );
    expect(screen.queryByTestId("tc-ortho-workup-chip")).toBeNull();
  });
});
