/**
 * THE VISIT FORM IS THE CLINIC NOTE — what the screen must and must not do.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. A SUGGESTED VISIT TYPE IS VISIBLE AS A SUGGESTION
 * ═════════════════════════════════════════════════════════════════════════════
 * When the appointment type maps cleanly the row comes up pre-picked and the
 * form says where that came from. When it does not map, NOTHING is picked. A
 * wrong template is a wrong chart note, so an ambiguous appointment label has
 * to be a question rather than a guess — and a guess presented as a decision
 * somebody made would be worse than either.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE ROWS FOLLOW THE VISIT TYPE, AND THEY COME FROM THE TEMPLATE
 * ═════════════════════════════════════════════════════════════════════════════
 * A child's note asks for the behaviour scale and an adult's does not. Perio
 * Maint asks for bone loss and whether the perio chart was updated. None of
 * that is a list in a component: it is walked out of the same template the
 * server prints the note from.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. NOTHING IS AUTO-SAVED BY LOOKING AT A CARD
 * ═════════════════════════════════════════════════════════════════════════════
 * A GET creates no visit row. A suggestion rides in the draft and is stored
 * with her first real edit — otherwise every card somebody glanced at would
 * leave a visit behind for a patient nobody worked on.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name below is synthetic; the clinician
 * names are the practice's own staff.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  emptySlip,
  type HygAppointment,
  type HygSlip,
  type HygVisit as HygVisitRow,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const DOCTORS = ["Beau Sparkman", "Blain VanNice", "Joe Farmer"];

const server = vi.hoisted(() => ({
  visit: null as unknown,
  /** What the appointment type says, which is what the auto-pick reads. */
  apptTypeLabel: "Adult Prophy RC" as string | null,
  isNewPatient: false as boolean | null,
  /** Every slip the page actually stored, in order. */
  saved: [] as unknown[],
  calls: [] as string[],
}));

vi.mock("@/features/hyg/api", async importOriginal => {
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
    apptTypeLabel: server.apptTypeLabel,
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: server.isNewPatient,
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

  const ensure = (): HygVisitRow => {
    if (!server.visit) {
      server.visit = {
        visitId: "visit-0001",
        office: "roland" as const,
        aptNum: 900001,
        patNum: 12827,
        visitDate: "2026-09-08",
        slip: contract.emptySlip(),
        items: [],
        stagedWrites: [],
        createdBy: "hygienist@carein.ai",
        createdAt: "2026-09-08T13:00:00.000Z",
        updatedBy: null,
        updatedAt: "2026-09-08T13:00:00.000Z",
      };
    }
    return server.visit as HygVisitRow;
  };

  const payload = () => ({
    success: true as const,
    visit: ensure(),
    recordsNeeded: [],
    handoffCategory: "Other" as const,
    doctorOptions: DOCTORS,
  });

  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, _a: number, date: string) => {
      server.calls.push("GET");
      return {
        success: true as const,
        office: office as "roland",
        officeName: "Roland Family Dental",
        date,
        appointment: appointment(),
        flagSources: {},
        visit: (server.visit as HygVisitRow | null) ?? null,
        recordsNeeded: [],
        handoffCategory: "Other" as const,
        doctorOptions: DOCTORS,
      };
    }),
    openVisit: vi.fn(async () => {
      server.calls.push("OPEN");
      return payload();
    }),
    saveSlip: vi.fn(async (_o: string, _a: number, slip: HygSlip) => {
      server.calls.push("SAVE");
      server.saved.push(slip);
      server.visit = { ...ensure(), slip };
      return payload();
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

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
    </WouterRouter>
  );
}

/** The last slip the page stored. The SERVER's copy, not the draft's. */
function lastSaved(): HygSlip {
  expect(server.saved.length).toBeGreaterThan(0);
  return server.saved[server.saved.length - 1] as HygSlip;
}

beforeEach(() => {
  server.visit = null;
  server.apptTypeLabel = "Adult Prophy RC";
  server.isNewPatient = false;
  server.saved = [];
  server.calls = [];
  vi.useRealTimers();
});
afterEach(cleanup);

describe("the visit type", () => {
  it("comes up picked from the appointment type, and says so", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    expect(
      screen
        .getByTestId("hyg-note-type-adult_prophy_recall")
        .getAttribute("aria-pressed")
    ).toBe("true");
    // WHERE it came from, in words. A suggestion presented as a decision
    // somebody made is the thing this line exists to prevent.
    expect(screen.getByTestId("hyg-note-type-auto").textContent ?? "").toMatch(
      /from the appointment type/i
    );
    expect(
      screen
        .getByTestId("hyg-note-type-adult_prophy_np")
        .getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("stores NOTHING just for having been suggested", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");
    // A GET creates no visit row, and a suggestion must not create one either.
    expect(server.calls).toEqual(["GET"]);
    expect(server.saved).toHaveLength(0);
  });

  it("is left unpicked when the appointment type does not map cleanly", async () => {
    // "Prophy 60" is most of a real schedule and says neither adult nor child.
    server.apptTypeLabel = "Prophy 60";
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    for (const type of [
      "adult_prophy_recall",
      "child_prophy_recall",
      "perio_maint",
    ]) {
      expect(
        screen.getByTestId(`hyg-note-type-${type}`).getAttribute("aria-pressed")
      ).toBe("false");
    }
    expect(
      screen.getByTestId("hyg-note-type-unpicked").textContent ?? ""
    ).toMatch(/did not say which note this is/i);
    // And no graded row is offered, because no template has been chosen.
    expect(screen.queryByTestId("hyg-note-row-plaque")).toBeNull();
  });

  it("lets her override it, and records that a person chose", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    fireEvent.click(screen.getByTestId("hyg-note-type-perio_maint"));
    await waitFor(() => expect(server.saved.length).toBeGreaterThan(0), {
      timeout: 3000,
    });

    expect(lastSaved().visitType).toBe("perio_maint");
    expect(lastSaved().visitTypeSource).toBe("manual");
    // The suggestion does not come back and re-take the decision.
    expect(
      screen
        .getByTestId("hyg-note-type-perio_maint")
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.queryByTestId("hyg-note-type-auto")).toBeNull();
  });

  it("never re-derives a type that is already stored", async () => {
    // The stored answer disagrees with the appointment label. Hers wins.
    server.visit = {
      visitId: "visit-0001",
      office: "roland",
      aptNum: 900001,
      patNum: 12827,
      visitDate: "2026-09-08",
      slip: {
        ...emptySlip(),
        visitType: "perio_maint",
        visitTypeSource: "manual",
      },
      items: [],
      stagedWrites: [],
      createdBy: "hygienist@carein.ai",
      createdAt: "2026-09-08T13:00:00.000Z",
      updatedBy: null,
      updatedAt: "2026-09-08T13:00:00.000Z",
    };
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    expect(
      screen
        .getByTestId("hyg-note-type-perio_maint")
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByTestId("hyg-note-type-adult_prophy_recall")
        .getAttribute("aria-pressed")
    ).toBe("false");
  });
});

describe("the graded rows", () => {
  it("shows the rows the chosen template prints, and no others", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    // Adult Prophy Recall: perio, plaque, calculus, bleeding, stain, mallampati
    // — plus STE, HTE and the doctor from its A: line.
    for (const id of [
      "perioStatus",
      "plaque",
      "calculus",
      "bleeding",
      "stain",
      "mallampati",
    ]) {
      expect(screen.getByTestId(`hyg-note-row-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("hyg-note-row-ste")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-row-hte")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-row-drs")).toBeTruthy();

    // The recall note does NOT ask for OH or bone loss. That is the practice's
    // own choice and the form must not add rows to it.
    expect(screen.queryByTestId("hyg-note-row-oh")).toBeNull();
    expect(screen.queryByTestId("hyg-note-row-boneLoss")).toBeNull();
    // Nor the child behaviour scale.
    expect(screen.queryByTestId("hyg-note-row-pedBehavior")).toBeNull();
  });

  it("shows the pediatric behaviour scale on a child visit", async () => {
    server.apptTypeLabel = "Child Prophy Recall";
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    expect(screen.getByTestId("hyg-note-row-pedBehavior")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-row-oh")).toBeTruthy();
    expect(screen.queryByTestId("hyg-note-row-mallampati")).toBeNull();
  });

  it("shows bone loss and the perio chart question on Perio Maint", async () => {
    server.apptTypeLabel = "Perio Maintenance";
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    expect(screen.getByTestId("hyg-note-row-boneLoss")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-row-subCalculus")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-row-supraCalculus")).toBeTruthy();
    expect(screen.getByTestId("hyg-note-perio-chart")).toBeTruthy();
    // Unanswered says what the note will do, rather than looking like a "no".
    expect(
      screen.getByTestId("hyg-note-perio-chart").textContent ?? ""
    ).toMatch(/prints as a blank on the note/i);
  });

  it("stores a grade and its free-text suffix together", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    fireEvent.click(screen.getByTestId("hyg-note-calculus-slight"));
    await waitFor(() => expect(server.saved.length).toBeGreaterThan(0), {
      timeout: 3000,
    });

    const detail = screen.getByTestId("hyg-note-calculus-detail");
    fireEvent.blur(detail, { target: { value: "Lower ant and U post" } });
    await waitFor(
      () =>
        expect(lastSaved().noteFields.calculus?.detail).toBe(
          "Lower ant and U post"
        ),
      { timeout: 3000 }
    );

    // The grade AND the where. Their real notes carry both, and a form that
    // took only the grade would make every note worse than the one it replaced.
    expect(lastSaved().noteFields.calculus).toEqual({
      grades: ["Slight"],
      detail: "Lower ant and U post",
    });
  });

  it("takes more than one answer on a multi-response row, in the template's order", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    // Tapped out of order on purpose: HTE is `RD, XD` in their notes and must
    // not come out `XD, RD` because of the order she happened to tap them.
    fireEvent.click(screen.getByTestId("hyg-note-hte-xd"));
    await waitFor(() => expect(server.saved.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByTestId("hyg-note-hte-rd"));
    await waitFor(
      () => expect(lastSaved().noteFields.hte?.grades).toHaveLength(2),
      {
        timeout: 3000,
      }
    );

    expect(lastSaved().noteFields.hte?.grades).toEqual(["RD", "XD"]);
  });

  it("clears a single-answer row when the picked chip is tapped again", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    fireEvent.click(screen.getByTestId("hyg-note-plaque-minimal"));
    await waitFor(
      () => expect(lastSaved().noteFields.plaque?.grades).toEqual(["Minimal"]),
      {
        timeout: 3000,
      }
    );
    fireEvent.click(screen.getByTestId("hyg-note-plaque-minimal"));
    await waitFor(
      () => expect(lastSaved().noteFields.plaque?.grades).toEqual([]),
      {
        timeout: 3000,
      }
    );
    // An answer given by accident has to be removable. An unanswered row is a
    // legible state on the note; a wrong one is not.
  });

  it("offers this office's own doctors, and none of its own", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");

    const row = screen.getByTestId("hyg-note-row-drs");
    for (const doctor of DOCTORS) {
      expect(row.textContent ?? "").toContain(doctor);
    }
  });
});

describe("what the form does not do", () => {
  it("asks for the chief complaint exactly once", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    // One box, with the note's own word on it. Two boxes asking the same thing
    // — only one of which reached the chart — is the likelier bug.
    expect(screen.getAllByText(/^Chief complaint$/i)).toHaveLength(1);
  });

  it("never claims a signature anywhere on the form", async () => {
    renderVisit();
    const page = await screen.findByTestId("hyg-visit");
    expect(page.textContent ?? "").not.toMatch(/(?<!un)\bsigned\b/i);
  });
});
