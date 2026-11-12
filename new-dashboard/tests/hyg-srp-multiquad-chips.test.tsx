/**
 * SRP multi-quad + the three new Done-today chips, on screen.
 *
 *   1. The picker offers ONE "SRP (draft)" in place of the four quad entries;
 *      a slip already holding a retired srp_quad_N still shows that one,
 *      picked. Choosing SRP shows four quad toggles; the stored list is unique
 *      and ascending; leaving SRP clears it.
 *   2. On the page, an SRP pick with no quad yet is HELD (not sent to a server
 *      that would 400 it); the first quad tap saves the whole slip.
 *   3. The chips 4346 / FMD / Fine Scale render and toggle on the Router slip.
 *
 * NO NETWORK, NO PHI. Roland 12827 is the designated test patient.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  emptySlip,
  HygSlipSchema,
  type HygAppointment,
  type HygSlip,
  type HygVisit as HygVisitRow,
} from "@shared/hyg/contract";
import { VisitNoteFields } from "@/features/hyg/visit/VisitNoteFields";
import { RouterSlip } from "@/features/hyg/visit/RouterSlip";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const DOCTORS = ["Drew Example"];

const server = vi.hoisted(() => ({
  visit: null as unknown,
  saved: [] as unknown[],
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const appointment = (): HygAppointment => ({
    aptNum: 900001,
    patNum: 12827,
    patientName: "Test 2, Stedi",
    start: "2026-09-08 08:00:00",
    lengthMin: 60,
    opNum: 2,
    opName: "Hygiene 1",
    isHygiene: true,
    opIsHygiene: true,
    provNum: 1,
    provHyg: 7,
    providerName: "HYG1",
    // Maps to nothing, so no type is auto-picked.
    apptTypeLabel: "Prophy 60",
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
    fetchVisit: vi.fn(async (office: string, _a: number, date: string) => ({
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
    })),
    openVisit: vi.fn(async () => payload()),
    saveSlip: vi.fn(async (_o: string, _a: number, slip: HygSlip) => {
      // The server's own rule: what it would 400, this stand-in refuses too.
      if (!contract.HygSlipSchema.safeParse(slip).success) throw new Error("400 from the stand-in");
      server.saved.push(slip);
      server.visit = { ...ensure(), slip };
      return payload();
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);
beforeEach(() => {
  server.visit = null;
  server.saved = [];
});

function fields(slip: HygSlip, onChange: (s: HygSlip) => void = () => {}) {
  return render(<VisitNoteFields slip={slip} doctorOptions={DOCTORS} suggestion={null} onChange={onChange} />);
}

const pressed = (testId: string) => screen.getByTestId(testId).getAttribute("aria-pressed");

describe("the visit-type picker", () => {
  it("offers one SRP (draft) and hides the retired per-quad types on a fresh slip", () => {
    fields(emptySlip());
    expect(screen.getByTestId("hyg-note-type-srp").textContent).toBe("SRP (draft)");
    for (const q of [1, 2, 3, 4]) expect(screen.queryByTestId(`hyg-note-type-srp_quad_${q}`)).toBeNull();
    expect(screen.queryByTestId("hyg-note-srp-quads")).toBeNull();
  });

  it("a slip saved with srp_quad_2 still shows it, picked, and only that one", () => {
    fields({ ...emptySlip(), visitType: "srp_quad_2", visitTypeSource: "manual" });
    expect(pressed("hyg-note-type-srp_quad_2")).toBe("true");
    expect(screen.getByTestId("hyg-note-type-srp_quad_2").textContent).toBe("SRP Quad 2 (draft)");
    expect(screen.queryByTestId("hyg-note-type-srp_quad_1")).toBeNull();
    expect(pressed("hyg-note-type-srp")).toBe("false");
    // Its rows still render, from its own template.
    expect(screen.getByTestId("hyg-note-row-carps")).toBeTruthy();
    expect(screen.queryByTestId("hyg-note-srp-quads")).toBeNull();
  });

  it("choosing SRP shows the four quad toggles and says a quad is needed", () => {
    const onChange = vi.fn();
    const { rerender } = fields(emptySlip(), onChange);
    fireEvent.click(screen.getByTestId("hyg-note-type-srp"));
    const next = onChange.mock.calls[0][0] as HygSlip;
    expect(next).toMatchObject({ visitType: "srp", visitTypeSource: "manual", srpQuads: [] });
    rerender(<VisitNoteFields slip={next} doctorOptions={DOCTORS} suggestion={null} onChange={onChange} />);
    expect([1, 2, 3, 4].map((q) => screen.getByTestId(`hyg-note-srp-quad-${q}`).textContent)).toEqual([
      "Quad 1 (UR)",
      "Quad 2 (UL)",
      "Quad 3 (LL)",
      "Quad 4 (LR)",
    ]);
    expect(screen.getByTestId("hyg-note-srp-quads-needed")).toBeTruthy();
  });

  it("quad taps store a unique, ascending list; un-tapping removes", () => {
    const onChange = vi.fn();
    const { rerender } = fields({ ...emptySlip(), visitType: "srp", visitTypeSource: "manual", srpQuads: [3] }, onChange);
    expect(pressed("hyg-note-srp-quad-3")).toBe("true");
    expect(screen.queryByTestId("hyg-note-srp-quads-needed")).toBeNull();
    fireEvent.click(screen.getByTestId("hyg-note-srp-quad-1"));
    const after = onChange.mock.calls[0][0] as HygSlip;
    expect(after.srpQuads).toEqual([1, 3]);
    expect(HygSlipSchema.safeParse(after).success).toBe(true);
    rerender(<VisitNoteFields slip={after} doctorOptions={DOCTORS} suggestion={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("hyg-note-srp-quad-3"));
    expect((onChange.mock.calls[1][0] as HygSlip).srpQuads).toEqual([1]);
  });

  it("leaving SRP for another type, or un-picking it, clears the quads", () => {
    const onChange = vi.fn();
    const srp: HygSlip = { ...emptySlip(), visitType: "srp", visitTypeSource: "manual", srpQuads: [1, 4] };
    fields(srp, onChange);
    fireEvent.click(screen.getByTestId("hyg-note-type-perio_maint"));
    expect(onChange.mock.calls[0][0]).toMatchObject({ visitType: "perio_maint", srpQuads: [] });
    fireEvent.click(screen.getByTestId("hyg-note-type-srp"));
    expect(onChange.mock.calls[1][0]).toMatchObject({ visitType: null, srpQuads: [] });
  });
});

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

describe("the page autosave", () => {
  it("holds an SRP pick with no quad, then saves the whole slip on the first quad tap", async () => {
    renderVisit();
    await screen.findByTestId("hyg-note-fields");
    fireEvent.click(screen.getByTestId("hyg-note-type-srp"));
    await screen.findByTestId("hyg-note-srp-quads-needed");
    // Longer than the 800 ms debounce: nothing was sent.
    await new Promise((r) => setTimeout(r, 1200));
    expect(server.saved).toHaveLength(0);

    fireEvent.click(screen.getByTestId("hyg-note-srp-quad-2"));
    await waitFor(() => expect(server.saved.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(server.saved[server.saved.length - 1]).toMatchObject({ visitType: "srp", srpQuads: [2] });
  });
});

describe("the three new Done-today chips", () => {
  it("render with their labels, after OFI and on a fresh slip", () => {
    render(<RouterSlip slip={emptySlip()} recordsNeeded={[]} onChange={() => {}} />);
    expect(screen.getByTestId("hyg-slip-done-d4346").textContent).toBe("4346");
    expect(screen.getByTestId("hyg-slip-done-fmd").textContent).toBe("FMD");
    expect(screen.getByTestId("hyg-slip-done-fine-scale").textContent).toBe("Fine Scale");
    const ids = Array.from(screen.getByTestId("hyg-slip-done-today").querySelectorAll("[data-testid^='hyg-slip-done-']")).map(
      (el) => el.getAttribute("data-testid"),
    );
    const at = (id: string) => ids.indexOf(`hyg-slip-done-${id}`);
    expect(at("ofi")).toBeLessThan(at("d4346"));
    expect(at("d4346")).toBeLessThan(at("fmd"));
    expect(at("fmd")).toBeLessThan(at("fine-scale"));
  });

  it("toggle on and off like any chip", () => {
    const onChange = vi.fn();
    const { rerender } = render(<RouterSlip slip={emptySlip()} recordsNeeded={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("hyg-slip-done-fine-scale"));
    const on = onChange.mock.calls[0][0] as HygSlip;
    expect(on.doneToday).toEqual(["fine-scale"]);
    rerender(<RouterSlip slip={on} recordsNeeded={[]} onChange={onChange} />);
    expect(pressed("hyg-slip-done-fine-scale")).toBe("true");
    fireEvent.click(screen.getByTestId("hyg-slip-done-fine-scale"));
    expect((onChange.mock.calls[1][0] as HygSlip).doneToday).toEqual([]);
  });
});
