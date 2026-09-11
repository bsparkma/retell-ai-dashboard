/**
 * Screenshot DUMP for the clinic-note form (H1 slice 8).
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width, light and dark — writing `tests/.shots/hyg-note-*.html`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR SHOTS, AND WHY THESE FOUR
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-note-01-recall     the ordinary case. Adult Prophy Recall, pre-picked
 *                          from the appointment type, every graded row the
 *                          template prints, and the suffix box beside each one.
 *                          This is the shot that answers "is this eight taps?"
 *   hyg-note-02-unpicked   the appointment type did not map. NOTHING is
 *                          picked, no rows are offered, and the form says why.
 *                          The review question is whether that reads as an
 *                          honest question rather than as a broken screen.
 *   hyg-note-03-perio      Perio Maint — sub and supra calculus separately,
 *                          bone loss, and the perio-chart question with its
 *                          "unanswered prints as a blank" line. That line is
 *                          the one to read hardest: their own template asserts
 *                          the chart was updated, and CareIN cannot know it.
 *   hyg-note-04-preview    the tray, showing the composed note as the SERVER
 *                          returned it — the SOAP skeleton, the graded lines
 *                          with their locations, the typed-name block and
 *                          "Unsigned." A picture is the only way to review
 *                          whether it reads like their auto note.
 *
 * Most name a taller FRAME (`@1180x2400`): a form with fourteen graded rows on
 * it is taller than one screen, and a screenshot that does not contain its own
 * subject is not evidence. The WIDTH, which is what decides the layout, is the
 * device's in every shot.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every patient name is synthetic; the
 * clinician names in the signature block are the practice's own staff.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  emptySlip,
  type HygAppointment,
  type HygSlip,
  type StagedWrite,
} from "@shared/hyg/contract";
import type { NoteField } from "@shared/hyg/noteTemplates";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const DOCTORS = ["Beau Sparkman", "Blain VanNice", "Joe Farmer"];

const fixtures = vi.hoisted(() => ({
  apptTypeLabel: "Adult Prophy RC" as string | null,
  slip: null as unknown,
  staged: [] as unknown[],
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const appointment = (): HygAppointment => ({
    aptNum: 900001,
    patNum: 12827,
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
    apptTypeLabel: fixtures.apptTypeLabel,
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: {
      premed: null,
      medicalAlerts: null,
      allergies: null,
      lastPerioDate: null,
      xraysDue: null,
      examNeeded: null,
      openTcCase: null,
    },
  });

  const page = () => ({
    success: true as const,
    office: "roland" as const,
    officeName: "Roland Family Dental",
    date: "2026-09-08",
    appointment: appointment(),
    flagSources: { premed: "od" as const },
    visit: {
      visitId: "visit-0001",
      office: "roland" as const,
      aptNum: 900001,
      patNum: 12827,
      visitDate: "2026-09-08",
      slip: (fixtures.slip ?? contract.emptySlip()) as HygSlip,
      items: [],
      stagedWrites: fixtures.staged as StagedWrite[],
      createdBy: "hygienist@carein.ai",
      createdAt: "2026-09-08T13:00:00.000Z",
      updatedBy: "hygienist@carein.ai",
      updatedAt: "2026-09-08T13:20:00.000Z",
    },
    recordsNeeded: [],
    handoffCategory: "Other" as const,
    doctorOptions: DOCTORS,
  });

  return {
    ...real,
    fetchVisit: vi.fn(async () => page()),
    openVisit: vi.fn(async () => ({
      success: true as const,
      visit: page().visit,
      recordsNeeded: [],
      handoffCategory: "Other" as const,
      doctorOptions: DOCTORS,
    })),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function field(grades: string[], detail = ""): NoteField {
  return { grades, detail };
}

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderVisit() {
  const memory = memoryLocation({
    path: "/hyg/visit/900001?office=roland&date=2026-09-08",
    record: true,
  });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path="/hyg/visit/:aptNum" component={HygVisit} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.apptTypeLabel = "Adult Prophy RC";
  fixtures.slip = null;
  fixtures.staged = [];
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("clinic note screenshot dumps", () => {
  it("01 — Adult Prophy Recall, pre-picked and filled", async () => {
    fixtures.slip = {
      ...emptySlip(),
      visitType: "adult_prophy_recall",
      visitTypeSource: "auto",
      doneToday: ["prophy"],
      xrayTypes: ["BW-4"],
      patientConcerns: "Cold sensitivity upper right.",
      hygieneFindings: "Generalised light calculus, BOP UR.",
      rtc: "6 mo recall",
      nextVisit: { type: null, intervalMonths: 6, lengthMin: 60, withDoctor: false },
      noteFields: {
        ste: field(["WNL"]),
        hte: field(["RD", "XD"], "#14"),
        drs: field(["Beau Sparkman"]),
        perioStatus: field(["Mild"]),
        plaque: field(["Moderate"], "U ant"),
        calculus: field(["Slight"], "Lower ant and U post"),
        bleeding: field(["Minimal"]),
        stain: field(["Slight"]),
        mallampati: field(["Class 2"]),
      },
    } satisfies HygSlip;
    renderVisit();
    await screen.findByTestId("hyg-note-fields");
    dump("hyg-note-01-recall@1180x2400");
  });

  it("02 — the appointment type did not map, so nothing is picked", async () => {
    // "Prophy 60" is most of a real schedule and says neither adult nor child.
    fixtures.apptTypeLabel = "Prophy 60";
    renderVisit();
    await screen.findByTestId("hyg-note-type-unpicked");
    dump("hyg-note-02-unpicked@1180x1400");
  });

  it("03 — Perio Maint, with the perio-chart question", async () => {
    fixtures.apptTypeLabel = "Perio Maintenance";
    fixtures.slip = {
      ...emptySlip(),
      visitType: "perio_maint",
      visitTypeSource: "auto",
      patientConcerns: "None today.",
      hygieneFindings: "4-5mm pockets UR, bleeding on probing.",
      noteFields: {
        ste: field(["Inflammation/bleeding Moderate"]),
        hte: field(["WNL"]),
        perioClass: field(["Moderate"]),
        plaque: field(["Moderate"]),
        subCalculus: field(["Moderate"], "Lower ant"),
        supraCalculus: field(["Slight"]),
        boneLoss: field(["Mild (3-4mm)"]),
      },
    } satisfies HygSlip;
    renderVisit();
    await screen.findByTestId("hyg-note-perio-chart");
    dump("hyg-note-03-perio@1180x2400");
  });

  it("04 — the composed note, as the server returned it", async () => {
    fixtures.slip = {
      ...emptySlip(),
      visitType: "adult_prophy_recall",
      visitTypeSource: "manual",
    } satisfies HygSlip;
    // EXACTLY the lines `autonoteParity.test.js` pins, so the picture and the
    // snapshot are the same note rather than two people's idea of one.
    fixtures.staged = [
      {
        id: "staged-note",
        kind: "note",
        state: "Staged",
        title: "Visit note",
        summary: "An unsigned Adult Prophy Recall note for 2026-09-08",
        preview: [
          "S:  Patient presents for recall appointment.  Chief complaint: Cold sensitivity upper right.",
          "",
          "O:  Reviewed medical history with patient.  Same",
          "    Radiographs taken: BW-4",
          "",
          "A:   STE: WNL  HTE: RD, XD #14  Polished, flossed, scaled as needed.  " +
            "Dr. Beau Sparkman performed periodic exam.  Findings: Generalised light calculus, BOP UR.",
          "",
          "P:  Return for Recall in 6 months",
          "",
          "Perio: Mild",
          "Plaque: Moderate U ant",
          "Calculus: Slight Lower ant and U post",
          "Bleeding: Minimal",
          "Stain: Slight",
          "Mallampati: Class 2",
          "RTC: 6 mo recall",
          "",
          "Raegan McGee RDH #4251",
          "Beau Sparkman DDS #6347",
          "Blain VanNice DDS #7971",
          "Joe Farmer DDS #7571",
          "Entered in CareIN by hygienist@carein.ai. Unsigned.",
        ],
        previewFingerprint: "sha256:fixture",
        errorMessage: null,
        writtenRef: null,
        stagedBy: "hygienist@carein.ai",
        stagedAt: "2026-09-08T13:10:00.000Z",
        sentBy: null,
        sentAt: null,
        updatedAt: "2026-09-08T13:10:00.000Z",
      },
    ];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-note-04-preview@1180x1800");
  });
});
