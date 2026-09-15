/**
 * Screenshot DUMPS for the perio chart (H4 slice 10).
 *
 * Same machinery as `hyg-visit-shots.test.tsx`: render into jsdom with fixture
 * data from THIS file, write the markup to `tests/.shots/hyg-perio-*.html`, and
 * let `scripts/shoot-hyg.mjs` — unchanged — photograph it at 1180 wide, light
 * and dark.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ELEVEN SHOTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-perio-01-full-with-prior    a full chart, last exam's numbers under it
 *   hyg-perio-02-partial-staged     a partial chart, staged, and labelled partial
 *   hyg-perio-03-no-prior           no exam on file: an honest empty, not zeros
 *   hyg-perio-04-prior-unavailable  Open Dental did not answer — not "no history"
 *   hyg-perio-05-tray               the visit's tray: perio staged, left out of Send
 *   The send (item 12):
 *   hyg-perio-send-06-confirm       how each arch goes in — a 10 mm pocket named
 *   hyg-perio-send-07-paused        rows going in, Open Dental did not answer, Continue
 *   hyg-perio-send-08-written       every site read back and matching
 *   hyg-perio-send-09-incomplete    loud: the sites named, the teeth marked, the undo
 *   hyg-perio-send-10-delete        the delete dialog, tick not yet given
 *   hyg-perio-send-11-tray-stopped  the visit's tray pointing at the stopped send
 *
 * NO NETWORK, NO BACKEND, NO PHI. The one name is synthetic; 12827 is the
 * designated roland fixture.
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

import { emptySlip, type HygAppointment, type StagedWrite } from "@shared/hyg/contract";
import {
  chartingOrder,
  countPerioChart,
  emptyPerioChart,
  normalizePerioChart,
  perioProgressLabel,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
  type PerioPrior,
} from "@shared/hyg/perio";
import { planPerioSend, type HygPerioSendResponse, type PerioSendView } from "@shared/hyg/perioSend";

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
  prior: null as unknown,
  visitStaged: [] as unknown[],
  send: null as unknown,
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
  const perio = await import("@shared/hyg/perio");
  const contract = await import("@shared/hyg/contract");

  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: contract.emptySlip(),
    items: [],
    stagedWrites: fixtures.visitStaged as StagedWrite[],
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:20:00.000Z",
  });

  return {
    ...real,
    fetchPerio: vi.fn(async () => {
      const chart = (fixtures.chart ?? perio.emptyPerioChart()) as PerioChart;
      return {
        success: true as const,
        office: "roland" as const,
        aptNum: 900001,
        visitStarted: true,
        chart,
        stagedWrite: fixtures.stagedWrite as StagedWrite | null,
        counts: perio.countPerioChart(chart),
      };
    }),
    fetchPerioSend: vi.fn(async () =>
      (fixtures.send as HygPerioSendResponse | null) ?? {
        success: true as const,
        office: "roland" as const,
        aptNum: 900001,
        stagedWrite: fixtures.stagedWrite as StagedWrite | null,
        send: null,
        paused: null,
      },
    ),
    fetchPerioPrior: vi.fn(async () => ({
      success: true as const,
      office: "roland" as const,
      aptNum: 900001,
      date: "2026-09-08",
      appointment: APPOINTMENT,
      prior: fixtures.prior as PerioPrior,
    })),
    fetchVisit: vi.fn(async () => ({
      success: true as const,
      office: "roland" as const,
      officeName: "Roland Family Dental",
      date: "2026-09-08",
      appointment: APPOINTMENT,
      flagSources: { premed: "od" as const },
      visit: visit(),
      recordsNeeded: [],
      handoffCategory: "Other" as const,
      doctorOptions: ["Beau Sparkman"],
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

/** A deterministic, clinically plausible chart: mostly 2–3 mm, a few 4–6 mm pockets. */
function exam(upTo: number, seed: number, skipped: number[]): PerioChart {
  let chart = emptyPerioChart();
  for (const tooth of skipped) chart = withPerioSkipped(chart, tooth, true);
  let n = seed;
  const next = () => {
    n = (n * 9301 + 49297) % 233280;
    return n / 233280;
  };
  chartingOrder(chart.sweep)
    .filter((c) => !skipped.includes(c.tooth))
    .slice(0, upTo)
    .forEach((c) => {
      const roll = next();
      const molar = [2, 3, 14, 15, 18, 19, 30, 31].includes(c.tooth);
      const depth = roll > 0.9 ? (molar ? 6 : 5) : roll > 0.7 ? 4 : roll > 0.3 ? 3 : 2;
      chart = withPerioSite(chart, c.tooth, c.surface, {
        depth,
        bleeding: depth >= 4 && next() > 0.4,
        plaque: next() > 0.8,
        calculus: molar && next() > 0.85,
      });
    });
  return normalizePerioChart(chart);
}

function found(chart: PerioChart): PerioPrior {
  return {
    status: "found",
    examNum: 5001,
    examDate: "2025-05-12",
    provNum: 7,
    chart,
    counts: countPerioChart(chart),
    truncated: false,
  };
}

function perioWrite(state: StagedWrite["state"], chart: PerioChart): StagedWrite {
  const label = perioProgressLabel(countPerioChart(chart));
  return {
    id: "staged-perio",
    kind: "perio",
    state,
    title: "Perio chart",
    summary: `${label}, 2026-09-08`,
    preview: [label, "Bleeding: 9 sites; suppuration: 0; plaque: 6; calculus: 1"],
    previewFingerprint: "fp-perio",
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
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
  fixtures.prior = { status: "none" };
  fixtures.visitStaged = [];
  fixtures.send = null;
});

/** A full chart, #16 skipped, one 10 mm pocket on #30 DB: the upper jaw one request, the lower row by row. */
function sendChart(): PerioChart {
  return normalizePerioChart(withPerioSite(exam(192, 7, [16]), 30, "DB", { depth: 10, bleeding: true }));
}

function sendView(chart: PerioChart, over: Partial<PerioSendView>): PerioSendView {
  const plan = planPerioSend(chart);
  return {
    sendId: "send-0001",
    state: "filling",
    examNum: 7001,
    examDate: "2026-09-08",
    provNum: 7,
    arches: plan.arches,
    rowsPlanned: plan.rows.length,
    rowsWritten: 0,
    deepSites: plan.deepSites.length,
    mismatches: [],
    errorMessage: null,
    requestsRemaining: 0,
    startedBy: "hygienist@carein.ai",
    startedAt: "2026-09-08T13:20:00.000Z",
    finishedAt: null,
    deletedBy: null,
    deletedAt: null,
    canDelete: false,
    ...over,
  };
}

function sendResponse(write: StagedWrite, send: PerioSendView, paused: string | null = null): HygPerioSendResponse {
  return { success: true, office: "roland", aptNum: 900001, stagedWrite: write, send, paused };
}

const INCOMPLETE_MESSAGE =
  "Exam 7001 is in Open Dental but does not match this chart at 2 places: #19 MB: the chart says 3 mm, " +
  "Open Dental holds 4 mm; #19 B: the chart says 2 mm, Open Dental holds 3 mm. An incomplete perio chart " +
  "understates disease. Delete exam 7001 from Open Dental on the perio chart page, or correct it there.";

function incompleteFixtures(chart: PerioChart) {
  const write = { ...perioWrite("Failed", chart), errorMessage: INCOMPLETE_MESSAGE };
  fixtures.chart = chart;
  fixtures.stagedWrite = write;
  fixtures.prior = found(exam(192, 5, [16]));
  fixtures.send = sendResponse(
    write,
    sendView(chart, {
      state: "incomplete",
      rowsWritten: 16,
      canDelete: true,
      finishedAt: "2026-09-08T13:21:30.000Z",
      errorMessage: INCOMPLETE_MESSAGE,
      mismatches: [
        { tooth: 19, surface: "MB", kind: "depth", expected: "3 mm", found: "4 mm" },
        { tooth: 19, surface: "B", kind: "depth", expected: "2 mm", found: "3 mm" },
      ],
    }),
  );
}
afterEach(cleanup);

describe.skipIf(!SHOOT)("perio chart screenshot dumps", () => {
  it("01 — a full chart, with the last exam's numbers under it", async () => {
    const chart = exam(192, 7, [1, 16]);
    fixtures.chart = chart;
    fixtures.stagedWrite = perioWrite("Draft", chart);
    fixtures.prior = found(exam(192, 3, [1, 16]));
    renderPerio();
    await screen.findByTestId("hyg-perio-prior-found");
    dump("hyg-perio-01-full-with-prior@1180x900");
  });

  it("02 — a partial chart, staged, and labelled partial", async () => {
    const chart = exam(84, 11, []);
    fixtures.chart = chart;
    fixtures.stagedWrite = perioWrite("Staged", chart);
    fixtures.prior = found(exam(192, 5, []));
    renderPerio();
    await screen.findByTestId("hyg-perio-state-Staged");
    dump("hyg-perio-02-partial-staged@1180x900");
  });

  it("03 — no exam on file: an honest empty, not a grid of zeros", async () => {
    fixtures.chart = exam(30, 13, []);
    fixtures.prior = { status: "none" };
    renderPerio();
    await screen.findByTestId("hyg-perio-prior-none");
    dump("hyg-perio-03-no-prior@1180x900");
  });

  it("04 — Open Dental did not answer, which is not the same as no history", async () => {
    fixtures.chart = exam(30, 17, []);
    fixtures.prior = {
      status: "unavailable",
      message: "The last perio exam could not be read from Open Dental.",
      detail: "timeout of 30000ms exceeded",
    };
    renderPerio();
    await screen.findByTestId("hyg-perio-prior-unavailable");
    dump("hyg-perio-04-prior-unavailable@1180x900");
  });

  it("05 — the visit's tray: the chart staged, and left out of Send", async () => {
    const chart = exam(84, 11, []);
    fixtures.visitStaged = [
      {
        ...perioWrite("Staged", chart),
      },
      {
        id: "staged-router",
        kind: "router",
        state: "Staged",
        title: "Routing slip",
        summary: "The slip for 2026-09-08 -- no treatment proposed",
        preview: ["Done today: Prophy", "Recare scheduled: not answered"],
        previewFingerprint: "fp-router",
        errorMessage: null,
        writtenRef: null,
        stagedBy: "hygienist@carein.ai",
        stagedAt: "2026-09-08T13:12:00.000Z",
        sentBy: null,
        sentAt: null,
        updatedAt: "2026-09-08T13:12:00.000Z",
      },
    ];
    void emptySlip;
    renderAt("/hyg/visit/900001?office=roland&date=2026-09-08", "/hyg/visit/:aptNum", HygVisit);
    await screen.findByTestId("hyg-perio-not-sent");
    dump("hyg-perio-05-tray@1180x1400");
  });

  it("06 — the confirm: how each arch goes in, with the 10 mm pocket named", async () => {
    const chart = sendChart();
    fixtures.chart = chart;
    fixtures.stagedWrite = perioWrite("Staged", chart);
    fixtures.prior = found(exam(192, 5, [16]));
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);
    fireEvent.click(await screen.findByTestId("hyg-perio-send-open"));
    await screen.findByTestId("hyg-perio-confirm-arches");
    dump("hyg-perio-send-06-confirm@1180x900");
  });

  it("07 — rows going in, Open Dental did not answer, and Continue", async () => {
    const chart = sendChart();
    const write = perioWrite("Sending", chart);
    fixtures.chart = chart;
    fixtures.stagedWrite = write;
    fixtures.prior = found(exam(192, 5, [16]));
    const view = sendView(chart, { state: "filling" });
    fixtures.send = sendResponse(
      write,
      { ...view, rowsWritten: 12, requestsRemaining: 7 },
      "Open Dental did not answer for #29 Probing. CareIN will check whether it landed before sending it again.",
    );
    renderPerio();
    await screen.findByTestId("hyg-perio-continue");
    dump("hyg-perio-send-07-paused@1180x900");
  });

  it("08 — written: every site read back and matching", async () => {
    const chart = sendChart();
    const write = {
      ...perioWrite("Written", chart),
      writtenRef: "Perio exam 7001: 186 sites and 1 skipped tooth read back and match",
      sentBy: "hygienist@carein.ai",
      sentAt: "2026-09-08T13:21:30.000Z",
    };
    fixtures.chart = chart;
    fixtures.stagedWrite = write;
    fixtures.prior = found(exam(192, 5, [16]));
    const view = sendView(chart, { state: "written", finishedAt: "2026-09-08T13:21:30.000Z" });
    fixtures.send = sendResponse(write, { ...view, rowsWritten: view.rowsPlanned });
    renderPerio();
    await screen.findByTestId("hyg-perio-state-Written");
    dump("hyg-perio-send-08-written@1180x900");
  });

  it("09 — incomplete: loud, the sites named, the teeth marked, and the undo", async () => {
    incompleteFixtures(sendChart());
    renderPerio();
    await screen.findByTestId("hyg-perio-incomplete");
    dump("hyg-perio-send-09-incomplete@1180x900");
  });

  it("10 — the delete dialog, before the tick", async () => {
    incompleteFixtures(sendChart());
    renderPerio();
    fireEvent.click(await screen.findByTestId("hyg-perio-delete-open"));
    await screen.findByTestId("hyg-perio-delete-dialog");
    dump("hyg-perio-send-10-delete@1180x900");
  });

  it("11 — the visit's tray, pointing at the stopped send", async () => {
    const chart = sendChart();
    fixtures.visitStaged = [{ ...perioWrite("Failed", chart), errorMessage: INCOMPLETE_MESSAGE }];
    renderAt("/hyg/visit/900001?office=roland&date=2026-09-08", "/hyg/visit/:aptNum", HygVisit);
    await screen.findByTestId("hyg-perio-in-progress");
    dump("hyg-perio-send-11-tray-stopped@1180x1400");
  });
});
