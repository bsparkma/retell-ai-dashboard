/**
 * Screenshot DUMP for the hygiene Day View.
 *
 * Same shape and same reasons as `rcm-stage-c3b-shots.test.tsx`: renders each
 * screen into jsdom with fixture data that lives in THIS file and writes the
 * markup to `tests/.shots/hyg-*.html`, which `scripts/shoot-hyg.mjs` wraps in
 * the app's real built CSS and photographs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR SHOTS, AT 1180 × 820
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-01-day-populated   a real day: two chairs, three cards, one alert flag,
 *                          one unknown chip, and one card missing everything a
 *                          card can be missing
 *   hyg-02-day-empty       the schedule loaded and nobody is booked
 *   hyg-03-day-error       Open Dental did not answer
 *   hyg-04-visit-placeholder  the slice-2 dead end behind a card tap
 *
 * 02 and 03 are the pair the whole review turns on: an empty day and a failed
 * one must be distinguishable at a glance from across a room, and a picture is
 * the only way to check that claim. They are shot at the same width for exactly
 * that comparison.
 *
 * 1180 × 820 is an iPad in landscape, which is the device this screen is for.
 * Shooting it at a desktop width would review a layout nobody uses.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of
 * fixture data in this file, so a screenshot physically cannot contain a real
 * patient. The names are synthetic AND already in first-name-plus-initial form.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
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

const OUT = resolve(import.meta.dirname, ".shots");

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

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
    patientName: "Kiwi S.",
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
    flags: flags(),
    ...over,
  };
}

const DAY: HygDayResponse = {
  success: true,
  office: "roland",
  officeName: "Roland Family Dental",
  date: "2026-09-08",
  operatories: [
    { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
    { opNum: 3, name: "Hygiene 2", abbrev: "HY2", isHygiene: true, itemOrder: 2 },
    { opNum: 9, name: "Doctor 1", abbrev: "DR1", isHygiene: false, itemOrder: 3 },
  ],
  appointments: [
    appt({ aptNum: 900001, patNum: 12827, patientName: "Kiwi S.", flags: flags({ premed: true }) }),
    appt({
      aptNum: 900004,
      patNum: 800004,
      patientName: "Guava D.",
      start: "2026-09-08 10:30:00",
      lengthMin: 90,
      apptTypeLabel: "New Pt Hyg",
      confirmedStatus: "Unconfirmed",
      flags: flags({ premed: false, medicalAlerts: true }),
    }),
    appt({
      aptNum: 900002,
      patNum: 12828,
      patientName: "Papaya P.",
      opNum: 3,
      start: "2026-09-08 09:00:00",
      lengthMin: 45,
      apptTypeLabel: "Perio Maint",
      confirmedStatus: "In Treatment Room",
      flags: flags({ premed: false, medicalAlerts: false }),
    }),
    appt({
      aptNum: 900003,
      patNum: 800003,
      // Every way a card can be missing something, on one card. Worth a picture:
      // this is the shape a reviewer has to agree reads as honest rather than
      // as broken.
      patientName: null,
      lengthMin: null,
      apptTypeLabel: null,
      providerName: null,
      confirmedStatus: null,
      opNum: 3,
      start: "2026-09-08 11:00:00",
      flags: flags(),
    }),
    appt({
      aptNum: 900005,
      patNum: 800005,
      patientName: "Lychee Q.",
      opNum: 9,
      opIsHygiene: false,
      isHygiene: false,
      start: "2026-09-08 13:30:00",
      lengthMin: 30,
      apptTypeLabel: "Limited Exam",
      providerName: "DR1",
      confirmedStatus: "Confirmed",
      flags: flags({ premed: false, medicalAlerts: false }),
    }),
  ],
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
  excludedByStatus: 1,
  truncated: false,
  patientNamesTruncated: false,
  stats: {
    odListReads: 4,
    odPatientReads: 1,
    patientsRequested: 1,
    patientCacheHits: 0,
    patientCacheDeduped: 0,
    durationMs: 1200,
  },
};

const EMPTY_DAY: HygDayResponse = { ...DAY, appointments: [], excludedByStatus: 0 };

// ─── Mocks ───────────────────────────────────────────────────────────────────

const fixtures = vi.hoisted(() => ({ day: null as unknown, fail: null as unknown }));

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
    fetchDay: vi.fn(async () => {
      if (fixtures.fail) throw fixtures.fail;
      return fixtures.day as HygDayResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import HygVisit from "@/pages/hyg/HygVisit";
import { HygApiError } from "@/features/hyg/api";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
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
  fixtures.fail = null;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hyg screenshot dumps", () => {
  it("01 — a populated day", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");
    expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(5);
    dump("hyg-01-day-populated");
  });

  it("02 — an empty day", async () => {
    fixtures.day = EMPTY_DAY;
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-empty");
    dump("hyg-02-day-empty");
  });

  it("03 — Open Dental did not answer", async () => {
    fixtures.fail = new HygApiError(
      "Could not read the schedule from Open Dental",
      502,
      "OD_READ_FAILED",
    );
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-error");
    dump("hyg-03-day-error");
  });

  it("04 — the office is not switched on for hygiene", async () => {
    fixtures.fail = new HygApiError(
      "The hygiene module is not switched on for Riley Family Dental yet",
      409,
      "OFFICE_NOT_READY",
      { reason: "OFFICE_HYG_NOT_ENABLED" },
    );
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-not-ready");
    dump("hyg-04-day-not-ready");
  });

  it("05 — the slice-2 placeholder behind a card tap", async () => {
    renderAt(<Route path="/hyg/visit/:aptNum" component={HygVisit} />, "/hyg/visit/900001");
    await screen.findByTestId("hyg-visit-placeholder");
    dump("hyg-05-visit-placeholder");
  });
});
