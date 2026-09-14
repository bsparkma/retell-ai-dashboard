/**
 * Screenshot DUMPS for the perio send (H4 slice 11).
 *
 * Same machinery as `hyg-perio-shots.test.tsx`; `scripts/shoot-hyg.mjs` shoots
 * them unchanged at 1180 wide, light and dark.
 *
 *   hyg-perio-send-01-confirm   exactly what will be written: date, provider, rows, preview
 *   hyg-perio-send-02-writing   mid-send: rows read back, time left, safe to leave
 *   hyg-perio-send-03-stopped   a refused row, in Open Dental's words, beside its tooth
 *   hyg-perio-send-04-written   every row read back
 *   hyg-perio-send-05-tray      the visit's tray while the chart is being written
 *
 * NO NETWORK, NO BACKEND, NO PHI. Synthetic name; 12827 is the roland fixture.
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type HygAppointment, type StagedWrite } from "@shared/hyg/contract";
import {
  chartingOrder,
  countPerioChart,
  emptyPerioChart,
  normalizePerioChart,
  perioMeasureRows,
  perioPreviewLines,
  perioProgressLabel,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
} from "@shared/hyg/perio";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  chart: null as unknown,
  stagedWrite: null as unknown,
  send: null as unknown,
  start: null as unknown,
  stepNeverAnswers: false,
  visitStaged: [] as unknown[],
}));

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
  apptTypeLabel: "Perio Maint",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: null, medicalAlerts: null, allergies: null, lastPerioDate: null,
    xraysDue: null, examNeeded: null, openTcCase: null,
  },
};

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const perio = await import("@shared/hyg/perio");
  const contract = await import("@shared/hyg/contract");
  return {
    ...real,
    fetchPerio: vi.fn(async () => {
      const chart = (fixtures.chart ?? perio.emptyPerioChart()) as PerioChart;
      return {
        success: true as const, office: "roland" as const, aptNum: 900001, visitStarted: true,
        chart, stagedWrite: fixtures.stagedWrite as StagedWrite | null, counts: perio.countPerioChart(chart),
      };
    }),
    fetchPerioPrior: vi.fn(async () => ({
      success: true as const, office: "roland" as const, aptNum: 900001, date: "2026-09-08",
      appointment: APPOINTMENT, prior: { status: "none" as const },
    })),
    fetchPerioSend: vi.fn(async () =>
      fixtures.send ?? { success: true, office: "roland", aptNum: 900001, stagedWrite: null, progress: null, rows: [], paused: null },
    ),
    startPerioSend: vi.fn(async () => fixtures.start as never),
    stepPerioSend: vi.fn(() => (fixtures.stepNeverAnswers ? new Promise(() => {}) : Promise.resolve(fixtures.start as never))),
    fetchVisit: vi.fn(async () => ({
      success: true as const, office: "roland" as const, officeName: "Roland Family Dental", date: "2026-09-08",
      appointment: APPOINTMENT, flagSources: { premed: "od" as const },
      visit: {
        visitId: "visit-0001", office: "roland" as const, aptNum: 900001, patNum: 12827, visitDate: "2026-09-08",
        slip: contract.emptySlip(), items: [], stagedWrites: fixtures.visitStaged as StagedWrite[],
        createdBy: "hygienist@carein.ai", createdAt: "2026-09-08T13:00:00.000Z", updatedBy: null,
        updatedAt: "2026-09-08T13:20:00.000Z",
      },
      recordsNeeded: [], handoffCategory: "Other" as const, doctorOptions: ["Beau Sparkman"],
    })),
  };
});

import HygPerio from "@/pages/hyg/HygPerio";
import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

/** Upper right quadrant: #1 skipped, #2–#8 probed, a few pockets and bleeding. */
function quadrant(): PerioChart {
  let chart = withPerioSkipped(emptyPerioChart(), 1, true);
  const depths = [3, 2, 3, 4, 3, 3, 5, 4, 3, 2, 3, 3];
  let i = 0;
  for (const c of chartingOrder(chart.sweep)) {
    if (c.tooth < 2 || c.tooth > 8) continue;
    const depth = depths[i++ % depths.length];
    chart = withPerioSite(chart, c.tooth, c.surface, { depth, bleeding: depth >= 4 });
  }
  return normalizePerioChart(chart);
}

function stagedWrite(state: StagedWrite["state"], chart: PerioChart, over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: "staged-perio", kind: "perio", state, title: "Perio chart",
    summary: `${perioProgressLabel(countPerioChart(chart))}, 2026-09-08`,
    preview: perioPreviewLines(chart), previewFingerprint: "fp-perio",
    errorMessage: null, writtenRef: null, stagedBy: "hygienist@carein.ai", stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null, sentAt: null, updatedAt: "2026-09-08T13:10:00.000Z", ...over,
  };
}

function sendOf(chart: PerioChart, write: StagedWrite, progress: Record<string, unknown>, rowsOver: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) {
  const plan = perioMeasureRows(chart);
  const confirmed = Number(progress.rowsConfirmed ?? 0);
  return {
    success: true, office: "roland", aptNum: 900001, stagedWrite: write, paused: null,
    progress: {
      examNum: 7001, examDate: "2026-09-08", provNum: 7, rowsTotal: plan.length, rowsConfirmed: confirmed,
      rowsFailed: 0, rowsRemaining: plan.length - confirmed,
      sitesTotal: plan.reduce((n, r) => n + r.sites, 0),
      sitesConfirmed: plan.slice(0, confirmed).reduce((n, r) => n + r.sites, 0),
      requestsRemaining: 14, secondsRemaining: 14, done: false, halted: false, haltMessage: null,
      startedBy: "hygienist@carein.ai", startedAt: "2026-09-08T13:30:00.000Z", ...progress,
    },
    rows: plan.map((r, i) =>
      rowsOver({
        seq: r.seq, target: "measure", tooth: r.tooth, sequenceType: r.sequenceType,
        state: i < confirmed ? "confirmed" : "pending", odRef: i < confirmed ? 90001 + i : null,
        errorMessage: null, sites: r.sites,
      }),
    ),
  };
}

function renderAt(path: string, pattern: string, component: React.ComponentType) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path={pattern} component={component} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const renderPerio = () =>
  renderAt("/hyg/visit/900001/perio?office=roland&date=2026-09-08", "/hyg/visit/:aptNum/perio", HygPerio);

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.chart = null;
  fixtures.stagedWrite = null;
  fixtures.send = null;
  fixtures.start = null;
  fixtures.stepNeverAnswers = false;
  fixtures.visitStaged = [];
});
afterEach(cleanup);

async function openConfirm() {
  await screen.findByTestId("hyg-perio-prior-none");
  const open = await screen.findByTestId("hyg-perio-send-open");
  await waitFor(() => {
    if (open.hasAttribute("disabled")) throw new Error("send not ready");
  });
  fireEvent.click(open);
  await screen.findByTestId("hyg-perio-confirm");
}

describe.skipIf(!SHOOT)("perio send screenshot dumps", () => {
  it("01 — the confirmation: exactly what will be written", async () => {
    const chart = quadrant();
    fixtures.chart = chart;
    fixtures.stagedWrite = stagedWrite("Staged", chart);
    renderPerio();
    await openConfirm();
    dump("hyg-perio-send-01-confirm@1180x900");
  });

  it("02 — mid-send: rows read back, time left, and safe to leave", async () => {
    const chart = quadrant();
    fixtures.chart = chart;
    fixtures.stagedWrite = stagedWrite("Staged", chart);
    fixtures.start = sendOf(chart, stagedWrite("Sending", chart), { rowsConfirmed: 5, secondsRemaining: 9, requestsRemaining: 9 });
    fixtures.stepNeverAnswers = true;
    renderPerio();
    await openConfirm();
    fireEvent.click(screen.getByTestId("hyg-perio-confirm-accept"));
    await screen.findByText(/Writing to Open Dental/);
    dump("hyg-perio-send-02-writing@1180x900");
  });

  it("03 — stopped: a refused row, in Open Dental's words, beside its tooth", async () => {
    const chart = quadrant();
    const message = '#4 Probing: Open Dental refused it - "IntTooth 4 is not valid for this exam."';
    const write = stagedWrite("Failed", chart, { errorMessage: message });
    fixtures.chart = chart;
    fixtures.stagedWrite = write;
    fixtures.send = sendOf(chart, write, { rowsConfirmed: 3, halted: true, rowsFailed: 1, haltMessage: message }, (r) =>
      r.tooth === 4 && r.sequenceType === "Probing" ? { ...r, state: "failed", errorMessage: message } : r,
    );
    renderPerio();
    await screen.findByTestId("hyg-perio-halt");
    dump("hyg-perio-send-03-stopped@1180x900");
  });

  it("04 — written: every row read back", async () => {
    const chart = quadrant();
    const plan = perioMeasureRows(chart);
    const write = stagedWrite("Written", chart, {
      writtenRef: `Perio exam 7001: ${plan.length} rows read back`,
      sentBy: "hygienist@carein.ai",
      sentAt: "2026-09-08T13:31:00.000Z",
    });
    fixtures.chart = chart;
    fixtures.stagedWrite = write;
    fixtures.send = sendOf(chart, write, { rowsConfirmed: plan.length, done: true, secondsRemaining: 0, requestsRemaining: 0 });
    renderPerio();
    await screen.findByText(/Written to Open Dental: exam 7001/);
    dump("hyg-perio-send-04-written@1180x900");
  });

  it("05 — the visit's tray while the chart is being written", async () => {
    fixtures.visitStaged = [stagedWrite("Sending", quadrant())];
    renderAt("/hyg/visit/900001?office=roland&date=2026-09-08", "/hyg/visit/:aptNum", HygVisit);
    await screen.findByTestId("hyg-perio-in-progress");
    dump("hyg-perio-send-05-tray@1180x1200");
  });
});
