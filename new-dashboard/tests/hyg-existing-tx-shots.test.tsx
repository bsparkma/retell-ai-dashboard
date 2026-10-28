/**
 * Screenshot DUMP for the existing-treatment section (hygiene Slice 2a).
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width — writing `tests/.shots/hyg-existing-tx-*.html`. The visit
 * page is taller than one screen, so the section shots ask for a taller frame
 * (`@1180xN`): same device, scrolled.
 *
 *   hyg-existing-tx-01-answered     every chip-row state on one plan: Already
 *                                   scheduled, Last discussed, Urgent, Wants to
 *                                   wait + timeframe + note, Not discussed, Watch
 *   hyg-existing-tx-02-unavailable  the Open Dental read failed: the sentence
 *                                   and Retry, never an empty list
 *   hyg-existing-tx-03-confirm      Send's confirm with the non-blocking reminder
 *   hyg-existing-tx-04-locked       the visit was sent: every chip locked
 *
 * NO NETWORK, NO BACKEND, NO PHI. The appointment carries no name.
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

import type { HygAppointment, StagedWrite } from "@shared/hyg/contract";
import type { ExistingTxItem } from "@shared/hyg/existingTx";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  items: [] as ExistingTxItem[],
  staged: [] as StagedWrite[],
  frozen: false,
  fail: false,
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  patientName: null,
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
  flags: {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

const by = "hygienist@carein.ai";
const at = "2026-09-08T13:05:00.000Z";

const PLAN: ExistingTxItem[] = [
  {
    procNum: 5002,
    code: "D2740",
    description: "Crown - porcelain/ceramic",
    tooth: "3",
    surface: "",
    dateTp: "2026-06-20",
    priorityName: null,
    watch: false,
    scheduled: true,
    disposition: null,
    lastDiscussed: { visitDate: "2026-06-01", patient: "wants_to_wait", waitTimeframe: "3_months", clinical: null },
  },
  {
    procNum: 5003,
    code: "D2392",
    description: "Resin-based composite - two surfaces, posterior",
    tooth: "30",
    surface: "MO",
    dateTp: "2026-05-01",
    priorityName: null,
    watch: false,
    scheduled: false,
    disposition: {
      clinical: "worse_urgent",
      patient: "wants_to_wait",
      waitTimeframe: "1_month",
      note: "Sensitive to cold since spring",
      updatedBy: by,
      updatedAt: at,
    },
    lastDiscussed: null,
  },
  {
    procNum: 5004,
    code: "D4341",
    description: "Periodontal scaling and root planing - four or more teeth per quadrant",
    tooth: "",
    surface: "UR",
    dateTp: "2026-02-11",
    priorityName: null,
    watch: false,
    scheduled: false,
    disposition: {
      clinical: "no_change",
      patient: "cost_questions",
      waitTimeframe: null,
      note: null,
      updatedBy: by,
      updatedAt: at,
    },
    lastDiscussed: { visitDate: "2026-02-11", patient: "see_plan_again", waitTimeframe: null, clinical: null },
  },
  {
    procNum: 5005,
    code: "D2391",
    description: "Resin-based composite - one surface, posterior",
    tooth: "14",
    surface: "O",
    dateTp: "2025-11-04",
    priorityName: "Watch",
    watch: true,
    scheduled: false,
    disposition: null,
    lastDiscussed: null,
  },
];

function stagedWrite(kind: StagedWrite["kind"], state: StagedWrite["state"]): StagedWrite {
  return {
    id: `staged-${kind}`,
    kind,
    state,
    title: kind === "note" ? "Visit note" : "Routing slip",
    summary: "The slip for 2026-09-08",
    preview: ["Done today: Prophy", "Recare scheduled: yes"],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: state === "Written" ? "GroupNote on 2 procedures" : null,
    stagedBy: by,
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: state === "Written" ? by : null,
    sentAt: state === "Written" ? "2026-09-08T13:20:00.000Z" : null,
    updatedAt: "2026-09-08T13:10:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");
  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: contract.emptySlip(),
    items: [],
    stagedWrites: fixtures.staged,
    createdBy: by,
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  });
  return {
    ...real,
    fetchVisit: vi.fn(async () => ({
      success: true as const,
      office: "roland" as const,
      officeName: "Roland Family Dental",
      date: "2026-09-08",
      appointment: APPOINTMENT,
      flagSources: { premed: "od" as const },
      visit: visit(),
      recordsNeeded: [],
      handoffCategory: "Restorative" as const,
      doctorOptions: ["Beau Sparkman"],
    })),
    fetchExistingTx: vi.fn(async () => {
      if (fixtures.fail) {
        throw new real.HygApiError("Couldn't load existing treatment from Open Dental", 502, "OD_READ_FAILED");
      }
      return {
        success: true as const,
        office: "roland" as const,
        aptNum: 900001,
        frozen: fixtures.frozen,
        readAt: "2026-09-08T13:00:00.000Z",
        items: fixtures.items,
      };
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(__dirname, ".shots");

function renderVisit() {
  const memory = memoryLocation({ path: "/hyg/visit/900001?office=roland&date=2026-09-08", record: true });
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

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.items = PLAN;
  fixtures.staged = [];
  fixtures.frozen = false;
  fixtures.fail = false;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hyg existing-treatment screenshot dumps", () => {
  it("01 — every chip-row state", async () => {
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-watch");
    dump("hyg-existing-tx-01-answered@1180x4300");
  });

  it("02 — the Open Dental read failed", async () => {
    fixtures.fail = true;
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-error");
    dump("hyg-existing-tx-02-unavailable@1180x2400");
  });

  it("03 — Send reminds, and does not gate", async () => {
    fixtures.staged = [stagedWrite("note", "Staged"), stagedWrite("router", "Staged")];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-watch");
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    await screen.findByTestId("hyg-confirm-existing-not-discussed");
    dump("hyg-existing-tx-03-confirm");
  });

  it("04 — the visit was sent: locked", async () => {
    fixtures.staged = [stagedWrite("note", "Written"), stagedWrite("router", "Written")];
    fixtures.frozen = true;
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-frozen");
    dump("hyg-existing-tx-04-locked@1180x4300");
  });
});
