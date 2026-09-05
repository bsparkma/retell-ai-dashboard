/**
 * Screenshot DUMP for the visit workspace (H1 slice 2).
 *
 * Same shape and same reasons as `hyg-shots.test.tsx`: renders the page into
 * jsdom with fixture data that lives in THIS file and writes the markup to
 * `tests/.shots/hyg-visit-*.html`, which `scripts/shoot-hyg.mjs` — the SAME
 * shooter the day view uses, unchanged — wraps in the app's real built CSS and
 * photographs at 1180 × 820, light and dark.
 *
 * One shooter on purpose. The day view and the visit workspace are the same
 * device held the same way, and a second script would eventually disagree with
 * the first about the width, which is the one thing a reviewer is checking.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE SHOTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-visit-01-workspace   the slip and the treatment, populated
 *   hyg-visit-02-item-open   one treatment item mid-edit
 *   hyg-visit-03-staged      the tray, with the server's own preview lines
 *   hyg-visit-04-unknowns    a patient whose flags nobody could read
 *   hyg-visit-05-recare      the unanswered front-desk questions, and Send
 *                            still available beside them
 *
 * Most of these name a taller FRAME (`@1180x2000`) because their subject sits below
 * the fold on a real iPad — the same page, scrolled, at the same width. A
 * screenshot that does not contain the thing it is evidence for is not
 * evidence. The width, which is what decides the layout, is the device's in
 * every shot.
 *
 * 05 is the shot that matters. Beau's ruling is that an unanswered "recare
 * scheduled" must not stop a hygienist sending, and the prototype drew both of
 * those questions in destructive red above a disabled Send. A picture is the
 * only way to check the tone as well as the behaviour.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  emptySlip,
  type HygAppointment,
  type HygSlip,
  type StagedWrite,
  type TreatmentItem,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  allFlagsUnknown: false,
  items: [] as unknown[],
  staged: [] as unknown[],
  slip: null as unknown,
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
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: fixtures.allFlagsUnknown
      ? {
          premed: null,
          medicalAlerts: null,
          allergies: null,
          lastPerioDate: null,
          xraysDue: null,
          examNeeded: null,
          openTcCase: null,
        }
      : {
          premed: true,
          medicalAlerts: true,
          allergies: null,
          lastPerioDate: null,
          xraysDue: true,
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
      items: fixtures.items as TreatmentItem[],
      stagedWrites: fixtures.staged as StagedWrite[],
      createdBy: "hygienist@carein.ai",
      createdAt: "2026-09-08T13:00:00.000Z",
      updatedBy: "hygienist@carein.ai",
      updatedAt: "2026-09-08T13:20:00.000Z",
    },
    recordsNeeded:
      fixtures.items.length > 0
        ? ["Pre-op PA", "Missing teeth note", "New/replacement noted"]
        : [],
    handoffCategory: "Restorative" as const,
  });

  return {
    ...real,
    fetchVisit: vi.fn(async () => page()),
    openVisit: vi.fn(async () => ({
      success: true as const,
      visit: page().visit,
      recordsNeeded: page().recordsNeeded,
      handoffCategory: "Restorative" as const,
    })),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function item(over: Partial<TreatmentItem> = {}): TreatmentItem {
  return {
    id: "item-0001",
    teeth: [3],
    code: "Crown",
    category: "Restorative",
    surfaces: ["O"],
    dx: ["D"],
    priority: "urgent",
    motivation: ["pain"],
    status: "proposed",
    scheduleNext: true,
    photos: [],
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:05:00.000Z",
    ...over,
  };
}

function staged(over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: "staged-router",
    kind: "router",
    state: "Staged",
    title: "Routing slip",
    summary: "The slip for 2026-09-08 — 2 treatment items",
    preview: [
      "Done today: Prophy, Fluoride",
      "X-rays: BW-4",
      "Doctor exam: Completed",
      "Next hygiene visit: 6 months, 60 min",
      "Recare scheduled: not answered",
      "Treatment entered in Open Dental: not answered",
      "Treatment identified today (2):",
      "  #3 · Crown · O · Urgent · Restorative · Dx D · proposed",
      "  Whole mouth · SRP · Preventative · Perio · proposed",
    ],
    errorMessage: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
    ...over,
  };
}

function filledSlip(over: Partial<HygSlip> = {}): HygSlip {
  return {
    ...emptySlip(),
    doneToday: ["prophy", "fluoride"],
    xrayTypes: ["BW-4"],
    examStatus: "completed",
    perioStage: "gingivitis",
    patientConcerns: "Cold sensitivity upper right.",
    hygieneFindings: "Generalised light calculus, bleeding on probing UR.",
    nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: false },
    ...over,
  };
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
  fixtures.allFlagsUnknown = false;
  fixtures.items = [];
  fixtures.staged = [];
  fixtures.slip = null;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("visit workspace screenshot dumps", () => {
  it("01 — the slip and the treatment, populated", async () => {
    fixtures.slip = filledSlip();
    fixtures.items = [
      item(),
      item({ id: "item-0002", teeth: "mouth", code: "SRP", category: "Perio", priority: "preventative", surfaces: [] }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-visit-01-workspace@1180x2000");
  });

  it("02 — one treatment item mid-edit", async () => {
    // An EMPTY slip here on purpose: the subject of this shot is the item card,
    // and a filled slip pushes it a page and a half down for no gain.
    fixtures.items = [item()];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-item-edit-item-0001"));
    await screen.findByTestId("hyg-item-item-0001-priority-urgent");
    dump("hyg-visit-02-item-open@1180x2800");
  });

  it("03 — the staged-writes tray, showing the server's own words", async () => {
    fixtures.slip = filledSlip();
    fixtures.items = [item()];
    fixtures.staged = [
      staged(),
      staged({
        id: "staged-note",
        kind: "note",
        title: "Visit note",
        summary: "An unsigned note for 2026-09-08, with a typed name block",
        preview: [
          "Done today: Prophy, Fluoride",
          "Recare scheduled: not answered",
          "Entered in CareIN by hygienist@carein.ai. Unsigned.",
        ],
      }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-visit-03-staged@1180x1500");
  });

  it("04 — a patient whose flags nobody could read", async () => {
    fixtures.allFlagsUnknown = true;
    fixtures.slip = filledSlip();
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-visit-04-unknowns");
  });

  it("05 — the front-desk questions unanswered, and Send still available", async () => {
    fixtures.slip = filledSlip({ recareScheduled: null, txEnteredInOd: null });
    fixtures.items = [item()];
    fixtures.staged = [staged()];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    // The reminder and the staging controls in one frame — the point being that
    // the first does not disable the second.
    await screen.findByTestId("hyg-slip-recare-reminder");
    dump("hyg-visit-05-recare@1180x1600");
  });
});
