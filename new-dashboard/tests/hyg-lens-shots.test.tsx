/**
 * Screenshot DUMP for the hygiene lens.
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width — writing `tests/.shots/hyg-lens-*.html`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR SHOTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-lens-01-list      the default: a time-ordered list, hygiene only, with
 *                         the hidden-count line AND the overflow appointment
 *                         sitting in the doctor's chair
 *   hyg-lens-02-full-day  the toggle on — the doctors' appointments are back
 *   hyg-lens-03-picker    filtered to one hygienist
 *   hyg-lens-04-grid      the chair grid, still one tap away
 *
 * 01 is the one that matters. It has to show BOTH that the lens is hiding
 * something (and says how much) and that the hygiene appointment parked in Dr
 * Farmer's chair is still on screen — the case the lazy filter loses.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HygAppointment, HygDayResponse } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({ hygiene: null as unknown, all: null as unknown }));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchDay: vi.fn(async (_o: string, _d: string, scope = "hygiene") =>
      (scope === "all" ? fixtures.all : fixtures.hygiene) as HygDayResponse,
    ),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function flags(over: Partial<HygAppointment["flags"]> = {}): HygAppointment["flags"] {
  return {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
    ...over,
  };
}

function appt(over: Partial<HygAppointment> = {}): HygAppointment {
  return {
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
    providerName: "Raegan",
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: flags(),
    ...over,
  };
}

const HYGIENE: HygAppointment[] = [
  appt({ flags: flags({ premed: true }) }),
  appt({
    aptNum: 900002,
    patNum: 12828,
    patientName: "Papaya, Jo",
    start: "2026-09-08 09:00:00",
    providerName: "Raegan",
    apptTypeLabel: "Perio maintenance",
    flags: flags({ xraysDue: true }),
  }),
  // THE OVERFLOW CASE: a hygiene appointment in the doctor's chair.
  appt({
    aptNum: 900003,
    patNum: 990010,
    patientName: "Mango, Lee",
    start: "2026-09-08 10:30:00",
    opNum: 5,
    opName: "Dr Farmer",
    isHygiene: true,
    opIsHygiene: false,
    providerName: "Casey",
    apptTypeLabel: "Prophy Child",
  }),
  appt({
    aptNum: 900004,
    patNum: 990011,
    patientName: "Lychee, Sam",
    start: "2026-09-08 13:00:00",
    providerName: "Casey",
    lengthMin: null,
    flags: flags({ medicalAlerts: true }),
  }),
];

const DOCTORS: HygAppointment[] = [
  appt({
    aptNum: 900005,
    patNum: 990020,
    patientName: "Guava, Alex",
    start: "2026-09-08 11:00:00",
    opNum: 5,
    opName: "Dr Farmer",
    isHygiene: false,
    opIsHygiene: false,
    providerName: "Dr Farmer",
    apptTypeLabel: "Crown seat",
  }),
  appt({
    aptNum: 900006,
    patNum: 990021,
    patientName: "Melon, Ash",
    start: "2026-09-08 14:00:00",
    opNum: 6,
    opName: "Dr Reed",
    isHygiene: false,
    opIsHygiene: false,
    providerName: "Dr Reed",
    apptTypeLabel: "Limited exam",
  }),
];

function day(over: Partial<HygDayResponse> = {}): HygDayResponse {
  return {
    success: true,
    office: "roland",
    officeName: "Roland Family Dental",
    date: "2026-09-08",
    operatories: [
      { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
      { opNum: 5, name: "Dr Farmer", abbrev: "DR1", isHygiene: false, itemOrder: 2 },
      { opNum: 6, name: "Dr Reed", abbrev: "DR2", isHygiene: false, itemOrder: 3 },
    ],
    appointments: HYGIENE,
    warnings: [],
    flagSources: {
      premed: "od",
      medicalAlerts: "od",
      allergies: "not_read",
      lastPerioDate: "not_read",
      xraysDue: "not_read",
      examNeeded: "not_read",
      openTcCase: "not_read",
    },
    excludedByStatus: 0,
    scope: "hygiene",
    excludedByScope: 2,
    truncated: false,
    patientNamesTruncated: false,
    stats: {
      odListReads: 4,
      odPatientReads: 4,
      patientsRequested: 4,
      patientCacheHits: 0,
      patientCacheDeduped: 0,
      durationMs: 4200,
    },
    ...over,
  };
}

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderDay() {
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

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.hygiene = day();
  fixtures.all = day({
    scope: "all",
    appointments: [...HYGIENE, ...DOCTORS],
    excludedByScope: 0,
    stats: {
      odListReads: 4,
      odPatientReads: 6,
      patientsRequested: 6,
      patientCacheHits: 0,
      patientCacheDeduped: 0,
      durationMs: 6400,
    },
  });
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hygiene lens screenshot dumps", () => {
  it("01 — the list default, with what the lens is hiding said out loud", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    dump("hyg-lens-01-list");
  });

  it("02 — the full day, doctors and all", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    fireEvent.click(screen.getByTestId("hyg-scope-toggle"));
    await screen.findByText("Guava, Alex");
    dump("hyg-lens-02-full-day");
  });

  it("03 — filtered to one hygienist", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    fireEvent.change(screen.getByTestId("hyg-provider-picker"), { target: { value: "Casey" } });
    await screen.findByText("Mango, Lee");
    dump("hyg-lens-03-picker");
  });

  it("04 — the chair grid, still one tap away", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    fireEvent.click(screen.getByTestId("hyg-view-grid"));
    await screen.findByTestId("hyg-day-columns");
    dump("hyg-lens-04-grid");
  });
});
