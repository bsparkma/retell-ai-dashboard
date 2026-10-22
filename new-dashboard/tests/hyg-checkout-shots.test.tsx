/**
 * Screenshot DUMPS for "Alert checkout" (queue item 49).
 *
 * Same mechanism as hyg-ortho-shots.test.tsx: render into jsdom with fixture
 * data from THIS file, write the markup to `tests/.shots/hyg-*.html`, and
 * `scripts/shoot-hyg.mjs` photographs it in the app's real built CSS at the
 * iPad's 1180 width, light and dark.
 *
 *   hyg-checkout-01-ready        the visit with "Alert checkout" above the tabs
 *   hyg-checkout-02-alerted      once TC answered: alerted, final notes pending
 *   hyg-checkout-03-undelivered  a Send whose handoff update did not land
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic; the PatNum is the
 * roland test fixture 12827.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { emptySlip, type HygAppointment, type HygVisit as HygVisitRow } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({ alerted: false }));

const APPOINTMENT: HygAppointment = {
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
  providerName: "HYG1",
  apptTypeLabel: "Prophy Adult",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: false,
    medicalAlerts: false,
    allergies: false,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

function visit(): HygVisitRow {
  return {
    visitId: "visit-0001",
    office: "roland",
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: emptySlip(),
    items: [
      {
        id: "item-0001",
        teeth: [3],
        code: "Crown",
        category: "Restorative",
        surfaces: ["O"],
        dx: ["D"],
        priority: "urgent",
        motivation: ["pain"],
        status: "proposed",
        scheduleNext: true,
        photos: [],
        createdBy: "hygienist@carein.ai",
        createdAt: "2026-09-08T13:10:00.000Z",
      },
    ],
    stagedWrites: [],
    orthoSend: null,
    checkoutSend: fixtures.alerted
      ? {
          handoffId: "5d2a7e10-0000-4000-8000-0000000000c1",
          sentAt: "2026-09-08T14:42:00.000Z",
          sentBy: "hygienist@carein.ai",
          finalAt: null,
        }
      : null,
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, _a: number, date: string) => ({
      success: true as const,
      office: office as "roland",
      officeName: "Roland Family Dental",
      date,
      appointment: APPOINTMENT,
      flagSources: { premed: "od" as const },
      visit: visit(),
      recordsNeeded: [],
      handoffCategory: "Restorative" as const,
      doctorOptions: ["Beau Sparkman"],
      checkoutEnabled: true,
    })),
    fetchPerioSend: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
    fetchPerio: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { CheckoutAlert } from "@/features/hyg/visit/CheckoutAlert";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderVisit() {
  const memory = memoryLocation({ path: "/hyg/visit/900001?office=roland&date=2026-09-08" });
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

const SHOOT = process.env.HYG_SHOTS === "1";
afterEach(cleanup);

describe.skipIf(!SHOOT)("checkout alert screenshot dumps", () => {
  it("01 — the visit, with Alert checkout above the tabs", async () => {
    fixtures.alerted = false;
    renderVisit();
    await screen.findByTestId("checkout-alert-button");
    dump("hyg-checkout-01-ready@1180x820");
  });

  it("02 — alerted, final notes still to go with Send", async () => {
    fixtures.alerted = true;
    renderVisit();
    await screen.findByTestId("checkout-alerted");
    dump("hyg-checkout-02-alerted@1180x820");
  });

  it("03 — a Send whose handoff update did not land", () => {
    render(
      <div className="p-6">
        <CheckoutAlert
          sent={{
            handoffId: "5d2a7e10-0000-4000-8000-0000000000c1",
            sentAt: "2026-09-08T14:42:00.000Z",
            sentBy: "hygienist@carein.ai",
            finalAt: null,
          }}
          sending={false}
          error={null}
          delivery={{ state: "not_delivered", code: "TC_ERROR", message: "TC responded 500" }}
          onAlert={() => {}}
          onRetryFinal={() => {}}
        />
      </div>,
    );
    dump("hyg-checkout-03-undelivered@1180x400");
  });
});
