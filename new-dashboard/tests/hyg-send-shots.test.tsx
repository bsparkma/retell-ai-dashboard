/**
 * Screenshot DUMP for the send (H1 slice 3).
 *
 * Same shooter as the day view and the workspace — `scripts/shoot-hyg.mjs`, at
 * the iPad's 1180 width — writing `tests/.shots/hyg-send-*.html`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR SHOTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-send-01-confirm    the confirmation, showing the EXACT lines
 *   hyg-send-02-written    both writes landed, each saying where
 *   hyg-send-03-partial    one written, one failed — the normal case
 *   hyg-send-04-not-ready  the office is not switched on, so nothing can be sent
 *
 * 03 is the one that matters. A visit is never "sent": partial success is
 * ordinary, and the screen has to show it as two facts rather than one verdict.
 * A picture is the only way to check that the failed row reads as recoverable
 * and the written one does not read as pending.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HygAppointment, StagedWrite } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  staged: [] as unknown[],
  notReady: false,
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const appointment: HygAppointment = {
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

  return {
    ...real,
    fetchVisit: vi.fn(async () => {
      if (fixtures.notReady) {
        throw new real.HygApiError(
          "The hygiene module is not switched on for Riley Family Dental yet",
          409,
          "OFFICE_NOT_READY",
          { reason: "OFFICE_HYG_NOT_ENABLED" },
        );
      }
      return {
        success: true as const,
        office: "roland" as const,
        officeName: "Roland Family Dental",
        date: "2026-09-08",
        appointment,
        flagSources: { premed: "od" as const },
        visit: {
          visitId: "visit-0001",
          office: "roland" as const,
          aptNum: 900001,
          patNum: 12827,
          visitDate: "2026-09-08",
          slip: contract.emptySlip(),
          items: [],
          stagedWrites: fixtures.staged as StagedWrite[],
          createdBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T13:00:00.000Z",
          updatedBy: "hygienist@carein.ai",
          updatedAt: "2026-09-08T13:20:00.000Z",
        },
        recordsNeeded: [],
        handoffCategory: "Restorative" as const,
      };
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function write(kind: StagedWrite["kind"], over: Partial<StagedWrite> = {}): StagedWrite {
  const titles: Record<string, string> = {
    note: "Visit note",
    router: "Routing slip",
    "tc-handoff": "Treatment handoff",
  };
  return {
    id: `staged-${kind}`,
    kind,
    state: "Staged",
    title: titles[kind] ?? kind,
    summary:
      kind === "note"
        ? "An unsigned note for 2026-09-08, with a typed name block"
        : "The slip for 2026-09-08 — 2 treatment items",
    preview: [
      "Done today: Prophy, Fluoride",
      "X-rays: BW-4",
      "Next hygiene visit: 6 months, 60 min",
      "Recare scheduled: not answered",
      "Treatment identified today (2):",
      "  #3 · Crown · O · Urgent · Restorative · Dx D · proposed",
      "  Whole mouth · SRP · Preventative · Perio · proposed",
      ...(kind === "note" ? ["Entered in CareIN by hygienist@carein.ai. Unsigned."] : []),
    ],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
    ...over,
  };
}

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderVisit(office = "roland") {
  const memory = memoryLocation({
    path: `/hyg/visit/900001?office=${office}&date=2026-09-08`,
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

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.staged = [];
  fixtures.notReady = false;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("send screenshot dumps", () => {
  it("01 — the confirmation, showing exactly what will be written", async () => {
    fixtures.staged = [write("note"), write("router")];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    await screen.findByTestId("hyg-confirm-send-body");
    dump("hyg-send-01-confirm@1180x1200");
  });

  it("02 — both writes landed, each saying where", async () => {
    fixtures.staged = [
      write("note", {
        state: "Written",
        writtenRef: "GroupNote on 2 procedures (5001, 5002)",
        sentBy: "hygienist@carein.ai",
        sentAt: "2026-09-08T13:22:00.000Z",
      }),
      write("router", {
        state: "Written",
        writtenRef: "Document 4711 in Routers",
        sentBy: "hygienist@carein.ai",
        sentAt: "2026-09-08T13:22:04.000Z",
      }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-send-02-written@1180x1200");
  });

  it("03 — one written, one failed: the normal case", async () => {
    fixtures.staged = [
      write("note", {
        state: "Written",
        writtenRef: "GroupNote on 2 procedures (5001, 5002)",
        sentBy: "hygienist@carein.ai",
        sentAt: "2026-09-08T13:22:00.000Z",
      }),
      write("router", {
        state: "Failed",
        errorMessage:
          'This office has no image category called "Routers". Create it in Open Dental, or set ' +
          "HYG_SLIP_DOC_CATEGORY_ROLAND to the name it uses.",
      }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-visit");
    dump("hyg-send-03-partial@1180x1200");
  });

  it("04 — the office is not switched on, so nothing can be sent", async () => {
    fixtures.notReady = true;
    renderVisit("valley");
    await screen.findByTestId("hyg-visit-error");
    dump("hyg-send-04-not-ready");
  });
});
