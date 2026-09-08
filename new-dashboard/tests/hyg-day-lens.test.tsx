/**
 * THE HYGIENE LENS, ON SCREEN — the list, the toggle, and the picker.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE THAT SILENTLY LOSES A PATIENT
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygiene appointment can sit in a DOCTOR's chair on an overflow day. The
 * server decides what is served (the appointment's own `isHygiene`, never the
 * chair's), and this screen must render what it is given — in the doctor's
 * chair, with the chair shown, because it has a hygiene appointment in it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS HIDDEN IS SAID OUT LOUD
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist wondering where the 2pm doctor visit went gets an answer. And the
 * three ways of having nothing on screen stay three different things: nobody
 * booked, nobody booked WITH A HYGIENIST, and the picker filtered it all out.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygAppointment, HygDayResponse } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

function flags(): HygAppointment["flags"] {
  return {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
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

/** What the server answers under each scope. Two payloads, two requests. */
const fixtures = vi.hoisted(() => ({
  hygiene: null as unknown,
  all: null as unknown,
  /** Every fetch, so a test can prove the second request happened. */
  calls: [] as string[],
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchDay: vi.fn(async (office: string, date: string, scope = "hygiene") => {
      fixtures.calls.push(`${office}/${date}/${scope}`);
      return (scope === "all" ? fixtures.all : fixtures.hygiene) as HygDayResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function day(over: Partial<HygDayResponse> = {}): HygDayResponse {
  return {
    success: true,
    office: "roland",
    officeName: "Roland Family Dental",
    date: "2026-09-08",
    operatories: [
      { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
      { opNum: 5, name: "Dr Farmer", abbrev: "DR1", isHygiene: false, itemOrder: 2 },
    ],
    appointments: [],
    warnings: [],
    flagSources: { premed: "od" },
    excludedByStatus: 0,
    scope: "hygiene",
    excludedByScope: 0,
    truncated: false,
    patientNamesTruncated: false,
    stats: {
      odListReads: 4,
      odPatientReads: 2,
      patientsRequested: 2,
      patientCacheHits: 0,
      patientCacheDeduped: 0,
      durationMs: 900,
    },
    ...over,
  };
}

/** The overflow case: a hygiene appointment parked in the doctor's chair. */
const OVERFLOW = appt({
  aptNum: 900002,
  patNum: 12828,
  patientName: "Test, MangoTest",
  start: "2026-09-08 09:00:00",
  opNum: 5,
  opName: "Dr Farmer",
  isHygiene: true,
  opIsHygiene: false,
  providerName: "Casey",
});

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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.calls = [];
  fixtures.hygiene = day({
    appointments: [appt(), OVERFLOW],
    excludedByScope: 2,
  });
  fixtures.all = day({
    scope: "all",
    appointments: [
      appt(),
      OVERFLOW,
      appt({
        aptNum: 900003,
        patNum: 990003,
        patientName: "Doctorpatient, A",
        start: "2026-09-08 10:00:00",
        opNum: 5,
        opName: "Dr Farmer",
        isHygiene: false,
        opIsHygiene: false,
        providerName: "Dr Farmer",
      }),
    ],
    excludedByScope: 0,
  });
});
afterEach(cleanup);

describe("the lens", () => {
  it("RENDERS A HYGIENE APPOINTMENT THAT IS IN A DOCTOR'S CHAIR", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");

    // Both hygiene appointments, and the overflow one shows the chair it is
    // actually in. Hiding non-hygiene CHAIRS instead of non-hygiene
    // APPOINTMENTS would have lost this patient.
    const cards = screen.getAllByTestId("hyg-appointment-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Test, MangoTest")).toBeTruthy();
    expect(screen.getByText("Dr Farmer")).toBeTruthy();
  });

  it("defaults to the hygiene scope, and says how many it is hiding", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");

    // The DATE is whatever today is; what this asserts is the office and the
    // SCOPE, which is the part the lens decides.
    expect(fixtures.calls).toHaveLength(1);
    expect(fixtures.calls[0]).toMatch(/^roland\/\d{4}-\d{2}-\d{2}\/hygiene$/);
    const notices = screen.getByTestId("hyg-day-notices").textContent ?? "";
    expect(notices).toMatch(/2 appointments on this date are not a hygiene visit/);
    expect(notices).toMatch(/Show the full day/);
  });

  it("showing the full day is a SECOND request, and it pays for itself", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");

    fireEvent.click(screen.getByTestId("hyg-scope-toggle"));
    await waitFor(() => expect(fixtures.calls).toHaveLength(2));
    // The doctors' patients were never read the first time — that is the
    // saving — so widening the lens has to go back to the server.
    expect(fixtures.calls[1]).toMatch(/^roland\/\d{4}-\d{2}-\d{2}\/all$/);

    await waitFor(() => expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(3));
    // Nothing hidden, so the notice is gone.
    expect(screen.queryByTestId("hyg-day-notices")).toBeNull();
  });

  it("remembers the view, the lens and the picker in this browser only", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");

    fireEvent.click(screen.getByTestId("hyg-view-grid"));
    await screen.findByTestId("hyg-day-columns");

    const stored: unknown = JSON.parse(localStorage.getItem("hyg.day.prefs.v1") ?? "{}");
    expect(stored).toMatchObject({ view: "grid", scope: "hygiene" });

    cleanup();
    renderDay();
    // The grid comes back, because the preference did.
    await screen.findByTestId("hyg-day-columns");
  });

  it("the chair grid is still there, and shows the doctor's chair when it holds a hygiene visit", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    fireEvent.click(screen.getByTestId("hyg-view-grid"));

    const columns = await screen.findByTestId("hyg-day-columns");
    // Two chairs: the hygiene one, and the doctor's — because a hygiene
    // appointment is sitting in it. A chair with nothing in it gets no column.
    expect(columns.textContent).toContain("Hygiene 1");
    expect(columns.textContent).toContain("Dr Farmer");
  });
});

describe("the hygienist picker", () => {
  it("filters what is drawn, and asks the server for nothing", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    const before = fixtures.calls.length;

    fireEvent.change(screen.getByTestId("hyg-provider-picker"), { target: { value: "Casey" } });
    await waitFor(() => expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(1));
    expect(screen.getByText("Test, MangoTest")).toBeTruthy();

    // DISPLAY-ONLY. Open Dental has no provider filter on /appointments, so
    // there is nothing to push this into and nothing to re-fetch.
    expect(fixtures.calls).toHaveLength(before);
  });

  it("never hides an appointment whose provider Open Dental would not name", async () => {
    fixtures.hygiene = day({
      appointments: [appt({ providerName: "Raegan" }), appt({ aptNum: 900009, providerName: null, patientName: "Unlabelled, Visit" })],
    });
    renderDay();
    await screen.findByTestId("hyg-day-list");

    fireEvent.change(screen.getByTestId("hyg-provider-picker"), { target: { value: "Raegan" } });
    await waitFor(() => expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(2));
    // A patient must not disappear because Open Dental did not label their
    // visit — the same silent loss the lens is careful about one level up.
    expect(screen.getByText("Unlabelled, Visit")).toBeTruthy();
  });

  it("filtered-to-nothing is its own sentence, not the empty day's", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-list");
    fireEvent.change(screen.getByTestId("hyg-provider-picker"), { target: { value: "Casey" } });
    await waitFor(() => expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(1));

    // The day changes under her — tomorrow, or a refresh after the schedule
    // moved — and Casey is no longer on it.
    fixtures.hygiene = day({ appointments: [appt({ providerName: "Raegan" })] });
    fireEvent.click(screen.getByTestId("hyg-day-refresh"));

    const filtered = await screen.findByTestId("hyg-day-filtered-empty");
    expect(screen.queryAllByTestId("hyg-appointment-card")).toHaveLength(0);
    expect(filtered.textContent).toMatch(/No appointments for Casey/);
    // NOT the empty-day panel: "nobody is booked" and "nobody is booked for
    // the person you picked" are different facts.
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
  });
});

describe("an empty hygiene day", () => {
  it("says it loaded, and says the lens is why it is empty", async () => {
    fixtures.hygiene = day({ appointments: [], excludedByScope: 4 });
    renderDay();

    await screen.findByTestId("hyg-day-empty");
    // The empty-vs-error distinction survives the new layout, and the lens
    // count explains an empty screen that has four appointments behind it.
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.getByTestId("hyg-day-notices").textContent).toMatch(
      /4 appointments on this date are not a hygiene visit/,
    );
  });
});
