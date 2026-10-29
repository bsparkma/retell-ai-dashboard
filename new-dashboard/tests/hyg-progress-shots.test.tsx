/**
 * Screenshot DUMP for the day-card progress pill.
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width — writing `tests/.shots/hyg-progress-*.html`.
 *
 *   hyg-progress-01-list         every overall state on one day, list view
 *   hyg-progress-02-chairs       the same day in the 288px chair columns —
 *                                the narrowest a pill is ever drawn, and the
 *                                shot that answers "does it truncate"
 *   hyg-progress-03-unavailable  the progress read failed: every card dashed
 *                                "Progress unavailable", the schedule intact
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  HygAppointment,
  HygDayProgressResponse,
  HygDayResponse,
  HygVisitProgress,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  day: null as unknown,
  progress: null as unknown,
  progressFail: null as unknown,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchDay: vi.fn(async () => fixtures.day as HygDayResponse),
    fetchDayIdentities: vi.fn(async () => new Promise(() => {}) as never),
    fetchDayProgress: vi.fn(async () => {
      if (fixtures.progressFail) throw fixtures.progressFail;
      return fixtures.progress as HygDayProgressResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { HygApiError } from "@/features/hyg/api";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function appt(over: Partial<HygAppointment>): HygAppointment {
  return {
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
    providerName: "Avery",
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: {
      premed: false,
      medicalAlerts: false,
      allergies: null,
      lastPerioDate: null,
      xraysDue: null,
      examNeeded: null,
      openTcCase: null,
    },
    ...over,
  };
}

const hyg2 = { opNum: 3, opName: "Hygiene 2", providerName: "Casey" };
const APPOINTMENTS: HygAppointment[] = [
  appt({ aptNum: 900001, patientName: "Kiwi, Sam", start: "2026-09-08 07:00:00" }),
  appt({ aptNum: 900002, patientName: "Papaya, Jo", start: "2026-09-08 08:00:00", ...hyg2 }),
  appt({ aptNum: 900003, patientName: "Mango, Lee", start: "2026-09-08 09:00:00", apptTypeLabel: "Perio maintenance" }),
  appt({ aptNum: 900004, patientName: "Guava, Ana", start: "2026-09-08 10:00:00", ...hyg2 }),
  appt({ aptNum: 900005, patientName: "Lychee, Bo", start: "2026-09-08 13:00:00" }),
  appt({ aptNum: 900006, patientName: "Quince, Ty", start: "2026-09-08 14:00:00", ...hyg2, lengthMin: null }),
];

const DAY: HygDayResponse = {
  success: true,
  office: "roland",
  officeName: "Roland Family Dental",
  date: "2026-09-08",
  operatories: [
    { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
    { opNum: 3, name: "Hygiene 2", abbrev: "HY2", isHygiene: true, itemOrder: 2 },
  ],
  appointments: APPOINTMENTS,
  warnings: [],
  flagSources: { premed: "od", medicalAlerts: "od" },
  excludedByStatus: 0,
  scope: "hygiene",
  excludedByScope: 0,
  truncated: false,
  patientNamesTruncated: false,
  identitiesPending: 0,
  stats: {
    odListReads: 4,
    odPatientReads: 0,
    patientsRequested: 0,
    patientCacheHits: 6,
    patientCacheDeduped: 0,
    durationMs: 900,
    phaseMs: {},
  },
};

function steps(note: string, slip: string, perio: string, tc: string, checkoutAlerted = false) {
  return {
    note: { state: note },
    slip: { state: slip },
    perio: { state: perio },
    tc: { state: tc, checkoutAlerted, checkoutFinal: false },
  } as NonNullable<HygVisitProgress["steps"]>;
}

const PROGRESS: HygDayProgressResponse = {
  success: true,
  office: "roland",
  progress: [
    { aptNum: 900001, overall: "sent", steps: steps("written", "written", "written", "written") },
    { aptNum: 900002, overall: "ready_to_send", steps: steps("ready", "ready", "not_applicable", "not_applicable") },
    { aptNum: 900003, overall: "in_progress", steps: steps("written", "drafting", "sending", "ready", true) },
    { aptNum: 900004, overall: "needs_attention", steps: steps("written", "failed", "not_applicable", "none") },
    { aptNum: 900005, overall: "not_started", steps: null },
    // 900006 left out: its card must read "Progress unavailable".
  ],
};

function renderDay(view: "list" | "grid") {
  localStorage.setItem("hyg.day.prefs.v1", JSON.stringify({ view, scope: "hygiene", provider: null }));
  const memory = memoryLocation({ path: "/hyg/day", record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>
            <HygDay />
          </OfficeProvider>
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
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.day = DAY;
  fixtures.progress = PROGRESS;
  fixtures.progressFail = null;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hyg progress screenshot dumps", () => {
  it("01 — every overall state, list view", async () => {
    renderDay("list");
    await screen.findByTestId("hyg-progress-sent");
    dump("hyg-progress-01-list");
  });

  it("02 — the same day in the chair columns", async () => {
    renderDay("grid");
    await screen.findByTestId("hyg-day-columns");
    await screen.findByTestId("hyg-progress-sent");
    dump("hyg-progress-02-chairs");
  });

  it("03 — the progress read failed", async () => {
    fixtures.progressFail = new HygApiError("Internal error", 500, "INTERNAL_ERROR");
    renderDay("list");
    await waitFor(() => {
      if (screen.queryAllByTestId("hyg-progress-unavailable").length !== 6) throw new Error("wait");
    });
    dump("hyg-progress-03-unavailable");
  });
});
