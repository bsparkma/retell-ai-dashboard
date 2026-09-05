/**
 * ONE TOOTH, SEVERAL PROCEDURES — the common case, not the edge.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE MOST IMPORTANT INTERACTION ON THE SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 * A crown prep nearly always carries a build-up, and often endo under both.
 * Beau hit it on his first real visit: he needed a build-up AND a crown on #30
 * and the picker made him re-select the tooth for each one.
 *
 * So the tooth selection is STICKY across adds — #30 → Build-up → Crown → RC is
 * three items in three taps — and it is only ever cleared explicitly. A
 * selection that vanished on its own would leave the next tap adding a
 * whole-mouth item, or nothing, with no way for her to tell which.
 *
 * They stay THREE ITEMS, not one item with three codes: each carries its own
 * diagnosis, its own priority (the crown can be urgent while a veneer on the
 * same tooth is cosmetic) and its own status. The model was right; the picker
 * was wrong.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { emptySlip, type HygAppointment, type TreatmentItem } from "@shared/hyg/contract";
import { groupByTooth, toothGroupKey, toothGroupLabel } from "@/features/hyg/visit/TreatmentItems";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({ items: [] as TreatmentItem[], seq: 0 }));

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
    })),
    openVisit: vi.fn(async () => mutation()),
    addTreatmentItem: vi.fn(async (_o: string, _a: number, input: Record<string, unknown>) => {
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

beforeEach(() => {
  server.items = [];
  server.seq = 0;
});
afterEach(cleanup);

describe("the sticky tooth selection", () => {
  it("#30 → Build-up → Crown → RC is THREE items on #30, in three taps", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Build-up"));
    await waitFor(() => expect(server.items).toHaveLength(1));
    // NO RE-SELECTION between them. That is the whole change.
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(2));
    fireEvent.click(screen.getByTestId("hyg-add-RC"));
    await waitFor(() => expect(server.items).toHaveLength(3));

    for (const item of server.items) expect(item.teeth).toEqual([30]);
    expect(server.items.map((i) => i.code)).toEqual(["Build-up", "Crown", "RC"]);
    // Three items, each with its own priority/dx/status to fill in — not one
    // item wearing three codes.
    expect(new Set(server.items.map((i) => i.id)).size).toBe(3);
  });

  it("the selection is only ever cleared on purpose", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(1));
    // Still selected, and the copy says so rather than leaving her to find out.
    expect(screen.getByTestId("hyg-add-selection").textContent).toMatch(/#30/);
    expect(screen.getByTestId("hyg-add-selection").textContent).toMatch(/stays selected/i);

    fireEvent.click(screen.getByTestId("hyg-clear-selection"));
    await waitFor(() =>
      expect(screen.getByTestId("hyg-add-selection").textContent).toMatch(/Pick teeth above/),
    );
    // And with nothing selected, a tooth-level code is disabled again.
    expect(screen.getByTestId("hyg-add-Crown").hasAttribute("disabled")).toBe(true);
  });

  it("switching dentition clears it, because the numbers mean something else", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-dentition-primary"));
    expect(screen.getByTestId("hyg-add-selection").textContent).toMatch(/Pick teeth above/);
  });

  it("a whole-mouth code does not need a tooth and does not disturb the selection", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Whitening"));
    await waitFor(() => expect(server.items).toHaveLength(1));
    expect(server.items[0].teeth).toBe("mouth");

    // #30 is still picked, so the next tooth-level tap still lands on it.
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(2));
    expect(server.items[1].teeth).toEqual([30]);
  });
});

describe("adding the same thing twice", () => {
  it("asks, rather than silently duplicating or refusing outright", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(1));

    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    const dialog = await screen.findByTestId("hyg-duplicate-confirm");
    expect(dialog.textContent).toMatch(/Crown is already on the list for #30/);
    // NOT ADDED YET. Asking is not doing.
    expect(server.items).toHaveLength(1);

    fireEvent.click(screen.getByTestId("hyg-duplicate-cancel"));
    await waitFor(() => expect(screen.queryByTestId("hyg-duplicate-confirm")).toBeNull());
    expect(server.items).toHaveLength(1);
  });

  it("but a deliberate second one is possible — retreats exist", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-RC"));
    await waitFor(() => expect(server.items).toHaveLength(1));

    fireEvent.click(screen.getByTestId("hyg-add-RC"));
    fireEvent.click(await screen.findByTestId("hyg-duplicate-accept"));
    await waitFor(() => expect(server.items).toHaveLength(2));
    expect(server.items.every((i) => i.code === "RC")).toBe(true);
  });

  it("the same code on a DIFFERENT tooth is not a duplicate", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(1));

    fireEvent.click(screen.getByTestId("hyg-tooth-30")); // deselect
    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(2));
    expect(screen.queryByTestId("hyg-duplicate-confirm")).toBeNull();
  });
});

describe("the item list", () => {
  it("groups by tooth so one tooth's procedures read as one story", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Build-up"));
    await waitFor(() => expect(server.items).toHaveLength(1));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items).toHaveLength(2));
    fireEvent.click(screen.getByTestId("hyg-clear-selection"));
    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Comp"));
    await waitFor(() => expect(server.items).toHaveLength(3));

    const group30 = await screen.findByTestId("hyg-tooth-group-30");
    expect(group30.textContent).toMatch(/#30/);
    expect(group30.textContent).toMatch(/2 procedures/);
    expect(group30.textContent).toMatch(/Build-up/);
    expect(group30.textContent).toMatch(/Crown/);

    const group3 = screen.getByTestId("hyg-tooth-group-3");
    // The label and the count run together in textContent with no whitespace
    // between them, so this matches the singular without the plural.
    expect(group3.textContent).toMatch(/1 procedure(?!s)/);
    // And #30's two are NOT in #3's group.
    expect(group3.textContent).not.toMatch(/Build-up/);
  });

  it("groups purely, without a component", () => {
    // The grouping is a function, so it can be stated without a render.
    const item = (id: string, teeth: number[] | "mouth", code: string) =>
      ({ id, teeth, code }) as TreatmentItem;
    const groups = groupByTooth([
      item("a", [30], "Build-up"),
      item("b", [3], "Comp"),
      item("c", [30], "Crown"),
      item("d", "mouth", "Whitening"),
      item("e", [14, 3], "Bridge"),
    ]);
    // FIRST-APPEARANCE order: her sequence, not tooth-number order she never
    // chose.
    expect(groups.map((g) => g.label)).toEqual(["#30", "#3", "Whole mouth", "#3, #14"]);
    expect(groups[0].items.map((i) => i.code)).toEqual(["Build-up", "Crown"]);
    // A multi-tooth item is ONE group, not one per tooth.
    expect(groups[3].items).toHaveLength(1);
    expect(toothGroupKey({ teeth: "mouth" })).toBe("mouth");
    expect(toothGroupLabel("3,14")).toBe("#3, #14");
  });
});

describe("the bottom of the form", () => {
  it("points at the tray instead of stopping", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    // Beau, at the bottom of the page: "I do not know where to go or what to do
    // next." The form now ends with somewhere to go.
    const affordance = screen.getByTestId("hyg-review-and-send");
    expect(affordance.textContent).toMatch(/Review & send/i);

    const tray = screen.getByTestId("hyg-staged-tray");
    const scrolled = vi.fn();
    // jsdom has no layout, so scrollIntoView is not implemented; the assertion
    // is that the affordance CALLS it on the tray.
    (tray as unknown as { scrollIntoView: () => void }).scrollIntoView = scrolled;
    const aside = tray.closest("aside");
    if (aside) (aside as unknown as { scrollIntoView: () => void }).scrollIntoView = scrolled;

    fireEvent.click(affordance);
    expect(scrolled).toHaveBeenCalled();
  });
});
