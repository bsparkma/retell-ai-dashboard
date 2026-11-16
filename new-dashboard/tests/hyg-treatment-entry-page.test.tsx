/**
 * FASTER TREATMENT ENTRY, through the real page — the half of the change that
 * lives in HygVisit's wiring.
 *
 * The component's confirmation is only as honest as what the page tells it:
 * `run` now resolves to the server's answer (or null), and the page hands that
 * to TreatmentItems. These tests pin that the confirmation appears only after
 * the create really landed, that a failed create never reads as added, that
 * Undo goes through the SAME create/remove calls, and that the create body is
 * the same shape it always was.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The patient is the synthetic Roland fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygAppointment, TreatmentItem } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  items: [] as TreatmentItem[],
  seq: 0,
  addBodies: [] as Record<string, unknown>[],
  removeIds: [] as string[],
  failAdds: false,
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12828,
  patientName: "Test, MangoTest",
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

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12828,
    visitDate: "2026-09-08",
    slip: contract.emptySlip(),
    items: server.items,
    stagedWrites: [],
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  });

  const mutation = () => ({
    success: true as const,
    visit: visit(),
    recordsNeeded: [],
    handoffCategory: "Restorative" as const,
    doctorOptions: ["Drew Example", "Morgan Example", "Quinn Example"],
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
      doctorOptions: ["Drew Example", "Morgan Example", "Quinn Example"],
    })),
    openVisit: vi.fn(async () => mutation()),
    addTreatmentItem: vi.fn(async (_o: string, _a: number, input: Record<string, unknown>) => {
      server.addBodies.push(input);
      if (server.failAdds) throw new real.HygApiError("The item was not saved.", 500, "HYG_WRITE_FAILED");
      server.seq += 1;
      server.items = [
        ...server.items,
        {
          id: `item-${server.seq}`,
          createdBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T13:05:00.000Z",
          ...input,
        } as TreatmentItem,
      ];
      return mutation();
    }),
    removeTreatmentItem: vi.fn(async (_o: string, _a: number, itemId: string) => {
      server.removeIds.push(itemId);
      server.items = server.items.filter((i) => i.id !== itemId);
      return mutation();
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
    </WouterRouter>,
  );
}

const tap = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const noticeText = () => screen.getByTestId("hyg-treatment-notice-text").textContent;

beforeEach(() => {
  server.items = [];
  server.seq = 0;
  server.addBodies = [];
  server.removeIds = [];
  server.failAdds = false;
});
afterEach(cleanup);

describe("through the page: the confirmation is the server's word", () => {
  it("confirms an add only after it landed, and the create body is today's shape", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");

    await waitFor(() => expect(noticeText()).toBe("Added Crown on #30. Still on #30."));
    expect(server.items).toHaveLength(1);
    // BYTE-FOR-BYTE THE SAME SHAPE as before this change: same keys, same
    // order, same defaults.
    expect(JSON.stringify(server.addBodies[0])).toBe(
      JSON.stringify({
        teeth: [30],
        code: "Crown",
        category: "Restorative",
        surfaces: [],
        dx: [],
        priority: "preventative",
        motivation: [],
        status: "proposed",
        scheduleNext: false,
        photos: [],
      }),
    );
  });

  it("a refused create never reads as added", async () => {
    server.failAdds = true;
    renderVisit();
    await screen.findByTestId("hyg-visit");
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");

    await waitFor(() =>
      expect(noticeText()).toBe("Crown was not added to #30. Nothing changed; still on #30."),
    );
    expect(screen.queryByTestId("hyg-treatment-undo")).toBeNull();
    // The page's own error banner still carries the server's words.
    expect(screen.getByTestId("hyg-visit-inline-error").textContent).toMatch(/not saved/);
  });

  it("Undo of an add calls the existing remove, for exactly the created item", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(noticeText()).toMatch(/^Added Crown/));
    const created = server.items[0].id;

    tap("hyg-treatment-undo");
    await waitFor(() => expect(noticeText()).toBe("Undone. Removed Crown on #30."));
    expect(server.removeIds).toEqual([created]);
    expect(await screen.findByTestId("hyg-treatment-empty")).toBeTruthy();
  });

  it("Undo of a remove calls the existing create with the same fields", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(server.items).toHaveLength(1));
    const id = server.items[0].id;
    await screen.findByTestId(`hyg-item-${id}`);

    tap(`hyg-item-remove-${id}`);
    await waitFor(() => expect(noticeText()).toBe("Removed Crown on #30."));
    tap("hyg-treatment-undo");
    await waitFor(() => expect(noticeText()).toBe("Put back Crown on #30."));
    expect(server.addBodies).toHaveLength(2);
    expect(server.addBodies[1]).toEqual(server.addBodies[0]);
    expect(server.items).toHaveLength(1);
  });

  it("add-to-each through the page: one create per tooth, then the selection clears", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    tap("hyg-select-mode-several");
    tap("hyg-tooth-3");
    tap("hyg-tooth-14");
    tap("hyg-code-tab-Other");
    tap("hyg-add-Sealant");

    await waitFor(() => expect(noticeText()).toBe("Added Sealant to 2 teeth. Selection cleared."));
    expect(server.addBodies.map((b) => b.teeth)).toEqual([[3], [14]]);
    expect(screen.getByTestId("hyg-add-selection").textContent).toBe("No tooth picked");
  });
});
