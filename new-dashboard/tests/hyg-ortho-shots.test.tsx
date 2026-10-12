/**
 * Screenshot DUMPS for the ortho screening (queue item 33).
 *
 * Same mechanism as hyg-visit-shots.test.tsx: render into jsdom with fixture
 * data from THIS file, write the markup to `tests/.shots/hyg-*.html`, and
 * `scripts/shoot-hyg.mjs` photographs it in the app's real built CSS at the
 * iPad's 1180 width, light and dark.
 *
 *   hyg-ortho-01-tab      the hygiene visit's Ortho screening tab, filled,
 *                         with "What the TC will get" above Send to TC
 *   hyg-ortho-02-sent     the same tab once TC answered: Sent, read-only
 *   hyg-ortho-03-tc-case  the TC case detail rendering the screening
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic; the PatNum is the
 * roland test fixture 12827.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { emptySlip, type HygAppointment, type HygVisit as HygVisitRow } from "@shared/hyg/contract";
import {
  emptyOrthoScreening,
  orthoScreeningSummary,
  type OrthoScreening,
} from "@shared/hyg/orthoScreening";
import type { TcCase } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const SCREENING: OrthoScreening = {
  ...emptyOrthoScreening(),
  interest: "yes",
  decider: "parent",
  concerns: ["crowding", "overbite"],
  arches: "comprehensive",
  modality: "aligners",
  months: [18, 24],
  upperAppliances: ["niti_rpe"],
  myo: "before",
  myoReasons: ["tongue_thrust"],
  afterOrtho: ["anterior_bonding"],
  afterOrthoTeeth: "#7, #10",
  recordsToday: ["photos", "pano"],
  orthoBenefit: "not_sure",
  consult: "phone",
  noteForTc: "Parent asked about cost before school starts.",
};

const fixtures = vi.hoisted(() => ({ sent: false, tcCase: null as unknown }));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  identity: "resolved",
  patientName: "Kiwi, Sam",
  start: "2026-09-08 08:00:00",
  lengthMin: 60,
  opNum: 2,
  opName: "Hygiene 1",
  isHygiene: true,
  opIsHygiene: true,
  provNum: 1,
  provHyg: 7,
  providerName: "HYG1",
  apptTypeLabel: "Prophy Child",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: false,
    medicalAlerts: false,
    allergies: false,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

function visit(): HygVisitRow {
  return {
    visitId: "visit-0001",
    office: "roland",
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: { ...emptySlip(), orthoScreening: SCREENING },
    items: [],
    stagedWrites: [],
    orthoSend: fixtures.sent
      ? { caseId: "8f3c1d20-0000-4000-8000-0000000000aa", sentAt: "2026-09-08T14:42:00.000Z", sentBy: "hygienist@carein.ai" }
      : null,
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, _a: number, date: string) => ({
      success: true as const,
      office: office as "roland",
      officeName: "Roland Family Dental",
      date,
      appointment: APPOINTMENT,
      flagSources: { premed: "od" as const },
      visit: visit(),
      recordsNeeded: [],
      handoffCategory: "Other" as const,
      doctorOptions: ["Beau Sparkman"],
    })),
    fetchPerioSend: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
    fetchPerio: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
  };
});

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, getCase: vi.fn(async () => fixtures.tcCase) };
});
vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/components/TcShell")>();
  return { ...actual, useTcOffice: () => "roland" };
});

import HygVisit from "@/pages/hyg/HygVisit";
import TcCaseView from "@/pages/tc/TcCaseView";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderAt(path: string, pattern: string, component: React.ComponentType) {
  const memory = memoryLocation({ path });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path={pattern} component={component} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

function tcCase(): TcCase {
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
    hygieneIntake: {
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
      radiographs: ["PANO"],
      intraoralPhotosTaken: true,
      areasOfConcern: "",
      suspectedTreatment: orthoScreeningSummary(SCREENING),
      hygienistRecommendation: SCREENING.noteForTc,
      insuranceNoted: "Not sure, TC will verify",
      patientInterestLevel: "hot",
      flagUrgent: false,
      orthoScreening: SCREENING,
    },
  };
}

const SHOOT = process.env.HYG_SHOTS === "1";
afterEach(cleanup);

describe.skipIf(!SHOOT)("ortho screening screenshot dumps", () => {
  it("01 — the hygiene tab, filled, with what the TC will get", async () => {
    fixtures.sent = false;
    renderAt("/hyg/visit/900001?office=roland&date=2026-09-08", "/hyg/visit/:aptNum", HygVisit);
    fireEvent.click(await screen.findByTestId("hyg-visit-tab-ortho"));
    await screen.findByTestId("hyg-ortho-screening");
    dump("hyg-ortho-01-tab@1180x2900");
  });

  it("02 — the same tab once TC answered: Sent, read-only", async () => {
    fixtures.sent = true;
    renderAt("/hyg/visit/900001?office=roland&date=2026-09-08", "/hyg/visit/:aptNum", HygVisit);
    fireEvent.click(await screen.findByTestId("hyg-visit-tab-ortho"));
    await screen.findByTestId("ortho-sent");
    dump("hyg-ortho-02-sent@1180x2900");
  });

  it("03 — the TC case detail renders the screening", async () => {
    fixtures.tcCase = tcCase();
    renderAt("/tc/cases/6f9619ff-8b86-4d01-b42d-00cf4fc964ff", "/tc/cases/:id", TcCaseView);
    await screen.findByTestId("tc-ortho-screening");
    dump("hyg-ortho-03-tc-case@1180x1200");
  });
});
