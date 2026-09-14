/**
 * THE PERIO CHART PAGE (H4 slice 10) — what the screen must do, and never do.
 *
 *   1. A full chart is enterable with the KEYBOARD ALONE, in charting order, and
 *      what the server is asked to store is exactly that chart.
 *   2. The last exam is FOUND, NONE, UNAVAILABLE, or NOT READ YET — and a refusal
 *      about the appointment is a fifth. Each is drawn differently; none of them
 *      is a grid of zeros.
 *   3. A partial chart says it is partial, and Stage stores what is on screen
 *      BEFORE it stages, because the stage composes from what is stored.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The one name below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { type HygAppointment, type StagedWrite } from "@shared/hyg/contract";
import {
  chartingOrder,
  countPerioChart,
  emptyPerioChart,
  normalizePerioChart,
  perioSite,
  withPerioSite,
  type HygPerioPriorResponse,
  type PerioChart,
  type PerioPrior,
} from "@shared/hyg/perio";

(globalThis as Record<string, unknown>).React = React;

const server = vi.hoisted(() => ({
  chart: null as unknown,
  visitStarted: false,
  stagedWrite: null as unknown,
  prior: null as unknown,
  /** When set, the prior request never answers — "not read yet". */
  priorPending: false,
  priorRefusal: null as { status: number; message: string; code: string } | null,
  saves: [] as unknown[],
  calls: [] as string[],
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

function staged(state: StagedWrite["state"], summary: string): StagedWrite {
  return {
    id: "staged-perio",
    kind: "perio",
    state,
    title: "Perio chart",
    summary,
    preview: state === "Staged" ? [summary] : [],
    previewFingerprint: "fp",
    errorMessage: null,
    writtenRef: null,
    stagedBy: null,
    stagedAt: null,
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const perio = await import("@shared/hyg/perio");

  const response = () => {
    const chart = (server.chart ?? perio.emptyPerioChart()) as PerioChart;
    return {
      success: true as const,
      office: "roland" as const,
      aptNum: 900001,
      visitStarted: server.visitStarted,
      chart,
      stagedWrite: server.stagedWrite as StagedWrite | null,
      counts: perio.countPerioChart(chart),
    };
  };

  return {
    ...real,
    fetchPerio: vi.fn(async () => {
      server.calls.push("GET");
      return response();
    }),
    fetchPerioPrior: vi.fn(async (): Promise<HygPerioPriorResponse> => {
      server.calls.push("PRIOR");
      if (server.priorPending) return new Promise(() => {});
      if (server.priorRefusal) {
        throw new real.HygApiError(
          server.priorRefusal.message,
          server.priorRefusal.status,
          server.priorRefusal.code,
        );
      }
      return {
        success: true,
        office: "roland",
        aptNum: 900001,
        date: "2026-09-08",
        appointment: APPOINTMENT,
        prior: server.prior as PerioPrior,
      };
    }),
    openVisit: vi.fn(async () => {
      server.calls.push("OPEN");
      server.visitStarted = true;
      return {} as never;
    }),
    savePerio: vi.fn(async (_o: string, _a: number, chart: PerioChart) => {
      server.calls.push("SAVE");
      server.saves.push(chart);
      server.chart = perio.normalizePerioChart(chart);
      const counts = perio.countPerioChart(chart);
      server.stagedWrite = staged("Draft", "Draft - " + perio.perioProgressLabel(counts));
      return response();
    }),
    stageWrite: vi.fn(async () => {
      server.calls.push("STAGE");
      const counts = perio.countPerioChart(server.chart as PerioChart);
      const write = staged("Staged", perio.perioProgressLabel(counts) + ", 2026-09-08");
      server.stagedWrite = write;
      return { success: true, visit: { stagedWrites: [write] } } as never;
    }),
  };
});

import HygPerio from "@/pages/hyg/HygPerio";
import { ThemeProvider } from "@/contexts/ThemeContext";

function renderPerio() {
  const memory = memoryLocation({
    path: "/hyg/visit/900001/perio?office=roland&date=2026-09-08",
    record: true,
  });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <Route path="/hyg/visit/:aptNum/perio" component={HygPerio} />
      </ThemeProvider>
    </WouterRouter>,
  );
}

function digit(n: number) {
  return { key: String(n), code: `Digit${n}` };
}

beforeEach(() => {
  server.chart = null;
  server.visitStarted = false;
  server.stagedWrite = null;
  server.prior = { status: "none" };
  server.priorPending = false;
  server.priorRefusal = null;
  server.saves = [];
  server.calls = [];
});
afterEach(cleanup);

describe("entering a chart", () => {
  it(
    "takes a full 32-tooth chart from the keyboard alone, in charting order, and stores exactly that",
    async () => {
      renderPerio();
      const grid = await screen.findByTestId("hyg-perio-grid");
      // Focus is on the grid: the first key is a number, not a click.
      expect(document.activeElement).toBe(grid);

      const order = chartingOrder(emptyPerioChart().sweep);
      order.forEach((_, i) => fireEvent.keyDown(grid, digit((i % 9) + 1)));

      expect(screen.getByTestId("hyg-perio-progress").textContent).toBe(
        "Full chart: 192 of 192 sites charted",
      );

      await waitFor(
        () => {
          const last = server.saves[server.saves.length - 1] as PerioChart | undefined;
          expect(last && countPerioChart(last).complete).toBe(true);
        },
        { timeout: 4000 },
      );
      const saved = server.saves[server.saves.length - 1] as PerioChart;
      order.forEach((c, i) => {
        expect(perioSite(saved, c.tooth, c.surface).depth).toBe((i % 9) + 1);
      });
      // The visit was started once, before the first save — lazily, like the slip.
      expect(server.calls.filter((c) => c === "OPEN")).toHaveLength(1);
      expect(server.calls.indexOf("OPEN")).toBeLessThan(server.calls.indexOf("SAVE"));
      await waitFor(() =>
        expect(screen.getByTestId("hyg-perio-save-state").textContent).toBe("Saved on this visit"),
      );
    },
    30_000,
  );

  it("puts a flag on the reading just typed, and names that site beside the flags", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    fireEvent.keyDown(grid, digit(4));
    fireEvent.keyDown(grid, { key: "b", code: "KeyB" });

    expect(screen.getByTestId("hyg-perio-flag-target").textContent).toMatch(/#1 DB/);
    expect(screen.getByTestId("hyg-perio-flag-bleeding").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(server.saves.length).toBeGreaterThan(0), { timeout: 3000 });
    const saved = server.saves[server.saves.length - 1] as PerioChart;
    expect(perioSite(saved, 1, "DB")).toMatchObject({ depth: 4, bleeding: true });
  });

  it("resumes a stored chart at the next site to call, not at #1", async () => {
    let chart = emptyPerioChart();
    for (const c of chartingOrder(chart.sweep).slice(0, 6)) {
      chart = withPerioSite(chart, c.tooth, c.surface, { depth: 2 });
    }
    server.chart = normalizePerioChart(chart);
    server.visitStarted = true;
    renderPerio();
    expect((await screen.findByTestId("hyg-perio-cursor")).textContent).toMatch(/^#3 DB/);
    expect(screen.getByTestId("hyg-perio-save-state").textContent).toBe("Saved on this visit");
  });
});

describe("staging", () => {
  it("labels a partial chart partial, stores it, and only then stages it", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(grid, digit(3));
    expect(screen.getByTestId("hyg-perio-progress").textContent).toBe(
      "Partial chart: 5 of 192 sites charted",
    );

    fireEvent.click(screen.getByTestId("hyg-perio-stage"));
    await screen.findByTestId("hyg-perio-state-Staged");
    expect(server.calls.lastIndexOf("SAVE")).toBeLessThan(server.calls.indexOf("STAGE"));
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/not built yet/);
  });

  it("offers nothing to stage on an empty chart", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    expect(screen.getByTestId("hyg-perio-stage").hasAttribute("disabled")).toBe(true);
  });
});

describe("the last exam", () => {
  it("says it is reading while it is reading", async () => {
    server.priorPending = true;
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    expect(screen.getByTestId("hyg-perio-prior-loading")).toBeTruthy();
  });

  it("draws NO prior exam as an honest empty — no old numbers anywhere", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-prior-none");
    expect(document.querySelectorAll('[data-testid^="hyg-perio-prior-"][data-testid$="-DB"]')).toHaveLength(0);
    expect(screen.getByTestId("hyg-perio-patient").textContent).toMatch(/Kiwi, Sam/);
  });

  it("draws an Open Dental outage as UNAVAILABLE, with its status line and a retry", async () => {
    server.prior = { status: "unavailable", message: "The last perio exam could not be read from Open Dental.", detail: "timeout" };
    renderPerio();
    const panel = await screen.findByTestId("hyg-perio-prior-unavailable");
    expect(panel.textContent).toMatch(/not the same as no history/);
    expect(panel.textContent).toMatch(/timeout/);
    expect(screen.getByTestId("hyg-perio-prior-retry")).toBeTruthy();
  });

  it("draws a FOUND exam under each site it has a reading for", async () => {
    const chart = withPerioSite(emptyPerioChart(), 3, "MB", { depth: 5 });
    server.prior = {
      status: "found",
      examNum: 5001,
      examDate: "2025-05-12",
      provNum: 7,
      chart: normalizePerioChart(chart),
      counts: countPerioChart(chart),
      truncated: false,
    };
    renderPerio();
    const panel = await screen.findByTestId("hyg-perio-prior-found");
    expect(panel.textContent).toMatch(/Last charted 2025-05-12/);
    expect(screen.getByTestId("hyg-perio-prior-3-MB").textContent).toBe("5");
    expect(screen.queryByTestId("hyg-perio-prior-3-DB")).toBeNull();
  });

  it("draws a refusal about the appointment as its own thing", async () => {
    server.priorRefusal = {
      status: 409,
      code: "PATIENT_CHANGED",
      message: "This appointment now belongs to a different patient in Open Dental",
    };
    renderPerio();
    const panel = await screen.findByTestId("hyg-perio-prior-failed");
    expect(panel.textContent).toMatch(/PATIENT_CHANGED/);
    expect(screen.getByTestId("hyg-perio-patient").textContent).toMatch(/Patient not shown/);
  });
});
