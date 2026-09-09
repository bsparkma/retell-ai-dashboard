/**
 * Screenshot DUMP for the multi-treatment picker.
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs` at the
 * iPad's 1180 width, with an optional `@WxH` suffix for a subject below the
 * fold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE SHOTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-multi-01-sticky     mid-flow: #30 still selected, two items already on
 *   hyg-multi-02-duplicate  the "already on the list for #30" confirm
 *   hyg-multi-03-grouped    the item list, grouped by tooth
 *   hyg-multi-04-end        the end of the form, pointing at the tray
 *   hyg-multi-05-no-items   the zero-item handoff card, stating its condition
 *
 * 01 is the one that matters: the selection chip has to still say #30 AFTER two
 * adds, because the whole change is that she does not re-pick it.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HygAppointment, TreatmentItem } from "@shared/hyg/contract";

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
  patientName: "Mango, Lee",
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
  flags: {
    premed: true,
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
    recordsNeeded: server.items.length > 0 ? ["Pre-op PA", "Missing teeth note"] : [],
    handoffCategory: "Restorative" as const,
    doctorOptions: ["Beau Sparkman", "Blain VanNice", "Joe Farmer"],
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
      recordsNeeded: server.items.length > 0 ? ["Pre-op PA", "Missing teeth note"] : [],
      handoffCategory: "Restorative" as const,
      doctorOptions: ["Beau Sparkman", "Blain VanNice", "Joe Farmer"],
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
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

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

/** #30, then a build-up and a crown on it — the compound entry. */
async function buildUpAndCrownOn30() {
  fireEvent.click(screen.getByTestId("hyg-tooth-30"));
  fireEvent.click(screen.getByTestId("hyg-add-Build-up"));
  await waitFor(() => expect(server.items.length).toBe(1));
  fireEvent.click(screen.getByTestId("hyg-add-Crown"));
  await waitFor(() => expect(server.items.length).toBe(2));
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  server.items = [];
  server.seq = 0;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("multi-treatment screenshot dumps", () => {
  it("01 — #30 still selected after two adds", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    await buildUpAndCrownOn30();
    dump("hyg-multi-01-sticky@1180x2800");
  });

  it("02 — the duplicate confirm", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    await buildUpAndCrownOn30();
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await screen.findByTestId("hyg-duplicate-confirm");
    dump("hyg-multi-02-duplicate@1180x1400");
  });

  it("03 — the item list, grouped by tooth", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    await buildUpAndCrownOn30();
    fireEvent.click(screen.getByTestId("hyg-clear-selection"));
    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Comp"));
    await waitFor(() => expect(server.items.length).toBe(3));
    dump("hyg-multi-03-grouped@1180x3400");
  });

  it("04 — the end of the form, pointing at the tray", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    await buildUpAndCrownOn30();
    dump("hyg-multi-04-end@1180x3400");
  });

  it("05 — the zero-item handoff card", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    await screen.findByTestId("hyg-handoff-no-items");
    dump("hyg-multi-05-no-items@1180x1200");
  });
});
