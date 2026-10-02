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
  withPerioSkipped,
  type HygPerioPriorResponse,
  type PerioChart,
  type PerioDrift,
  type PerioPreSkip,
  type PerioPrior,
} from "@shared/hyg/perio";
import { planPerioSend, type HygPerioSendResponse, type PerioSendView } from "@shared/hyg/perioSend";

(globalThis as Record<string, unknown>).React = React;

const server = vi.hoisted(() => ({
  chart: null as unknown,
  visitStarted: false,
  stagedWrite: null as unknown,
  prior: null as unknown,
  /**
   * Item 14: whether the exam a `Written` chart claims is still in Open Dental.
   * `not_applicable` is what an unsent chart gets, and is the default here.
   */
  drift: null as unknown,
  /**
   * Item 27: which teeth Open Dental records as Missing, and whether a chart has
   * ever been stored for this visit. `unavailable` + not-stored is the default,
   * so no test gets a pre-skip it did not ask for.
   */
  preSkip: null as unknown,
  chartStored: false,
  /** When set, the prior request never answers — "not read yet". */
  priorPending: false,
  priorRefusal: null as { status: number; message: string; code: string } | null,
  saves: [] as unknown[],
  calls: [] as string[],
  // The send (item 12): what GET answers, what start and each step answer in
  // turn, and what the undo answers.
  send: null as unknown,
  sendScript: [] as unknown[],
  sendRequests: [] as unknown[],
  afterDelete: null as unknown,
  deletes: [] as number[],
  // Item 13: what amend / cancel / remove-replaced answer, in order.
  amendScript: [] as unknown[],
  removed: [] as number[],
  /** Item 14: every exam number a resend was confirmed for. */
  resent: [] as number[],
}));

/** A send answer the server then HOLDS, the way the real one does. */
function applyToServer(res: HygPerioSendResponse): HygPerioSendResponse {
  server.stagedWrite = res.stagedWrite;
  server.send = res;
  return res;
}

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
      chartStored: server.chartStored,
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
        drift: server.drift as PerioDrift,
        preSkip: server.preSkip as PerioPreSkip,
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
      // A stored chart is stored forever after, even if she empties it again.
      server.chartStored = true;
      server.chart = perio.normalizePerioChart(chart);
      const counts = perio.countPerioChart(chart);
      // A correction rests in `Amending`, a first chart in `Draft` — the server's rule.
      const resting = (server.stagedWrite as StagedWrite | null)?.state === "Amending" ? "Amending" : "Draft";
      server.stagedWrite = staged(resting, resting + " - " + perio.perioProgressLabel(counts));
      return response();
    }),
    stageWrite: vi.fn(async () => {
      server.calls.push("STAGE");
      const counts = perio.countPerioChart(server.chart as PerioChart);
      const write = staged("Staged", perio.perioProgressLabel(counts) + ", 2026-09-08");
      server.stagedWrite = write;
      return { success: true, visit: { stagedWrites: [write] } } as never;
    }),
    fetchPerioSend: vi.fn(async (): Promise<HygPerioSendResponse> => {
      server.calls.push("SEND_GET");
      return (
        (server.send as HygPerioSendResponse | null) ?? {
          success: true,
          office: "roland",
          aptNum: 900001,
          stagedWrite: server.stagedWrite as StagedWrite | null,
          send: null,
          live: null,
          paused: null,
        }
      );
    }),
    // Item 13. Each returns the next scripted answer AND leaves the server
    // holding it, because the page reloads the chart afterwards.
    beginPerioAmendment: vi.fn(async () => {
      server.calls.push("AMEND");
      return applyToServer(server.amendScript.shift() as HygPerioSendResponse);
    }),
    cancelPerioAmendment: vi.fn(async () => {
      server.calls.push("AMEND_CANCEL");
      return applyToServer(server.amendScript.shift() as HygPerioSendResponse);
    }),
    removePerioReplacedExam: vi.fn(async (_o: string, _a: number, examNum: number) => {
      server.calls.push("REMOVE_REPLACED");
      server.removed.push(examNum);
      return applyToServer(server.amendScript.shift() as HygPerioSendResponse);
    }),
    // Item 14: the resend. It writes nothing to Open Dental; it hands back a
    // Staged chart, which the ordinary Send then takes from the top.
    resendPerioChart: vi.fn(async (_o: string, _a: number, examNum: number) => {
      server.calls.push("RESEND");
      server.resent.push(examNum);
      const next = server.amendScript.shift();
      if (next instanceof real.HygApiError) throw next;
      // The claim is withdrawn with the chart: no live send any more.
      server.drift = { status: "not_applicable" };
      return applyToServer(next as HygPerioSendResponse);
    }),
    startPerioSend: vi.fn(async (_o: string, _a: number, _d: string, request: unknown) => {
      server.calls.push("SEND_START");
      server.sendRequests.push(request);
      const next = server.sendScript.shift();
      if (next instanceof real.HygApiError) throw next;
      return next as HygPerioSendResponse;
    }),
    stepPerioSend: vi.fn(async () => {
      server.calls.push("SEND_STEP");
      return server.sendScript.shift() as HygPerioSendResponse;
    }),
    deletePerioSendExam: vi.fn(async (_o: string, _a: number, examNum: number) => {
      server.calls.push("DELETE");
      server.deletes.push(examNum);
      return server.afterDelete as HygPerioSendResponse;
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
  server.drift = { status: "not_applicable" };
  server.preSkip = { status: "unavailable" };
  server.chartStored = false;
  server.priorPending = false;
  server.priorRefusal = null;
  server.saves = [];
  server.calls = [];
  server.send = null;
  server.sendScript = [];
  server.sendRequests = [];
  server.afterDelete = null;
  server.deletes = [];
  server.amendScript = [];
  server.resent = [];
  server.removed = [];
});
afterEach(cleanup);

/** Every site 0–9 except one 12 on #3 DB — the upper jaw goes row by row. */
function chartWithDeepPocket(): PerioChart {
  let chart = emptyPerioChart();
  chartingOrder(chart.sweep).forEach((c, i) => {
    chart = withPerioSite(chart, c.tooth, c.surface, { depth: (i % 4) + 2 });
  });
  return normalizePerioChart(withPerioSite(chart, 3, "DB", { depth: 12 }));
}

function view(chart: PerioChart, over: Partial<PerioSendView>): PerioSendView {
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
    requestsRemaining: 20,
    startedBy: "hygienist@carein.ai",
    startedAt: "2026-09-08T13:20:00.000Z",
    finishedAt: null,
    deletedBy: null,
    deletedAt: null,
    canDelete: false,
    // Item 13: a first send replaces nothing and changes nothing.
    supersedesExamNum: null,
    supersedesDeletedAt: null,
    amendDiff: [],
    writtenChart: null,
    ...over,
  };
}

function sendResponse(
  stagedState: StagedWrite["state"],
  send: PerioSendView,
  paused: string | null = null,
  live: PerioSendView | null | undefined = undefined,
): HygPerioSendResponse {
  return {
    success: true,
    office: "roland",
    aptNum: 900001,
    stagedWrite: { ...staged(stagedState, "Full chart: 192 of 192 sites charted"), preview: ["Full chart"] },
    send,
    // The exam in Open Dental now: by default the send itself, once it verified.
    live: live === undefined ? (send.state === "written" ? send : null) : live,
    paused,
  };
}

describe("entering a chart", () => {
  it(
    "takes a full 32-tooth chart from the keyboard alone, in charting order, and stores exactly that",
    async () => {
      // Focus is on the grid THE MOMENT it is on screen: the first key is a number,
      // not a click. Checked when the grid enters the DOM, not after findBy — a focus
      // that lands a frame later (a passive effect) drops the keys typed in between,
      // and whether findBy happens to resolve after it is a matter of machine speed.
      const focusedOnArrival: boolean[] = [];
      const observer = new MutationObserver(() => {
        const arrived = document.querySelector('[data-testid="hyg-perio-grid"]');
        if (arrived && focusedOnArrival.length === 0) {
          focusedOnArrival.push(document.activeElement === arrived);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      renderPerio();
      const grid = await screen.findByTestId("hyg-perio-grid");
      observer.disconnect();
      expect(focusedOnArrival).toEqual([true]);
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
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/every site is read back/);
  });

  it("ITEM 15: once staged, says the chart rides the visit's Send and offers the way back there", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(grid, digit(3));
    // Not before it is staged: there is nothing yet for the visit to send.
    expect(screen.queryByTestId("hyg-perio-to-visit")).toBeNull();

    fireEvent.click(screen.getByTestId("hyg-perio-stage"));
    await screen.findByTestId("hyg-perio-state-Staged");
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(
      /will go with the visit's Send, alongside the note, the slip and the handoff/,
    );
    const back = screen.getByTestId("hyg-perio-to-visit");
    expect(back.getAttribute("href")).toBe("/hyg/visit/900001?office=roland&date=2026-09-08");
    expect(back.className).toMatch(/min-h-11/);
    // The chart's own Send stays: it is the same send, surfaced in two places.
    expect(screen.getByTestId("hyg-perio-send-open")).toBeTruthy();
  });

  it("offers nothing to stage on an empty chart", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    expect(screen.getByTestId("hyg-perio-stage").hasAttribute("disabled")).toBe(true);
  });
});

describe("the number pad (item 17)", () => {
  function padKey(key: string, code: string) {
    return { key, code, location: 3 };
  }

  it("ACCEPTANCE 4: Num Lock off says so, on screen, and charts nothing", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    expect(screen.queryByTestId("hyg-perio-numlock")).toBeNull();

    // "7 4 1" on a pad with Num Lock off.
    fireEvent.keyDown(grid, padKey("Home", "Numpad7"));
    fireEvent.keyDown(grid, padKey("ArrowLeft", "Numpad4"));
    fireEvent.keyDown(grid, padKey("End", "Numpad1"));
    const warning = screen.getByTestId("hyg-perio-numlock");
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toMatch(/Num Lock is off/);
    expect(screen.getByTestId("hyg-perio-progress").textContent).toMatch(/0 of 192/);
    expect(screen.getByTestId("hyg-perio-cursor").textContent).toMatch(/#1 DB/);

    // Num Lock on: the next real digit charts, and the warning goes.
    fireEvent.keyDown(grid, padKey("7", "Numpad7"));
    expect(screen.queryByTestId("hyg-perio-numlock")).toBeNull();
    expect(screen.getByTestId("hyg-perio-site-1-DB").textContent).toMatch(/^7/);
  });

  it("the pad's flag and tooth keys work on the page, through the same grid", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    fireEvent.keyDown(grid, padKey("3", "Numpad3"));
    fireEvent.keyDown(grid, padKey("/", "NumpadDivide"));
    expect(screen.getByTestId("hyg-perio-flag-bleeding").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(grid, padKey(")", "NumpadParenRight"));
    expect(screen.getByTestId("hyg-perio-cursor").textContent).toMatch(/#2 DB/);
  });

  it("ACCEPTANCE 5: touch entry is unchanged — the keypad buttons chart and move as before", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    fireEvent.click(screen.getByTestId("hyg-perio-key-4"));
    fireEvent.click(screen.getByTestId("hyg-perio-key-12"));
    expect(screen.getByTestId("hyg-perio-site-1-DB").textContent).toMatch(/^4/);
    expect(screen.getByTestId("hyg-perio-site-1-B").textContent).toMatch(/^12/);
    fireEvent.click(screen.getByTestId("hyg-perio-flag-plaque"));
    expect(screen.getByTestId("hyg-perio-flag-plaque").getAttribute("aria-pressed")).toBe("true");
  });

  it("ACCEPTANCE 6: the key legend renders, hides, and comes back", async () => {
    window.localStorage.clear();
    renderPerio();
    const legend = await screen.findByTestId("hyg-perio-legend");
    for (const k of ["/", "*", "-", "+", ".", "Backspace", "Delete", "Esc", "(", ")"]) {
      expect(legend.textContent).toContain(k);
    }
    expect(screen.getByTestId("hyg-perio-legend-notes").textContent).toMatch(/Fn/);
    expect(screen.getByTestId("hyg-perio-legend-notes").textContent).toMatch(/Tab and = do nothing/);

    fireEvent.click(screen.getByTestId("hyg-perio-legend-hide"));
    expect(screen.queryByTestId("hyg-perio-legend")).toBeNull();
    // Remembered on this device…
    cleanup();
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    expect(screen.queryByTestId("hyg-perio-legend")).toBeNull();
    // …and one tap brings it back.
    fireEvent.click(screen.getByTestId("hyg-perio-legend-show"));
    expect(screen.getByTestId("hyg-perio-legend")).toBeTruthy();
    window.localStorage.clear();
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

describe("sending (item 12)", () => {
  it("confirms with how each arch goes in, sends the fingerprint, date and provider, and steps to Written", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Staged", "Full chart: 192 of 192 sites charted, 2026-09-08");
    server.sendScript = [
      sendResponse("Sending", view(chart, { state: "filling", rowsWritten: 12 })),
      sendResponse("Written", view(chart, { state: "written", rowsWritten: 16, finishedAt: "2026-09-08T13:21:00.000Z" })),
    ];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    const open = await screen.findByTestId("hyg-perio-send-open");
    expect(open.hasAttribute("disabled")).toBe(false);
    fireEvent.click(open);
    const dialog = await screen.findByTestId("hyg-perio-confirm");
    // The SAME plan the server sends from: the 12 is named, and the jaw that can go in one request says so.
    expect(screen.getByTestId("hyg-perio-confirm-arch-UpperFacial").textContent).toMatch(/#3 DB reads 10 mm or more/);
    expect(screen.getByTestId("hyg-perio-confirm-arch-UpperLingual").textContent).toMatch(/other side of this jaw/);
    expect(screen.getByTestId("hyg-perio-confirm-arch-LowerLingual").textContent).toMatch(/One request with the exam: 48 sites/);
    expect(screen.getByTestId("hyg-perio-confirm-provider").textContent).toMatch(/ProvNum 7/);
    expect(dialog.textContent).toMatch(/NOT marked written/);

    fireEvent.click(screen.getByTestId("hyg-perio-confirm-accept"));
    await waitFor(() =>
      expect(screen.getByTestId("hyg-perio-send-status").textContent).toBe(
        "Written to Open Dental: exam 7001, every site read back and matching",
      ),
    );
    expect(server.sendRequests).toEqual([{ previewFingerprint: "fp", examDate: "2026-09-08", provNum: 7 }]);
    expect(server.calls.filter((c) => c === "SEND_START" || c === "SEND_STEP")).toEqual(["SEND_START", "SEND_STEP"]);
    expect(screen.getByTestId("hyg-perio-state-Written")).toBeTruthy();

    // A written chart takes no more readings.
    const before = screen.getByTestId("hyg-perio-progress").textContent;
    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(7));
    expect(screen.getByTestId("hyg-perio-progress").textContent).toBe(before);
    expect(screen.queryByTestId("hyg-perio-stage")).toBeNull();
  });

  it("an INCOMPLETE send is loud: it names the sites, marks the teeth, locks the chart, and the undo needs a tick", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = { ...staged("Failed", "Perio chart"), errorMessage: "Exam 7001 is in Open Dental but does not match" };
    server.send = sendResponse(
      "Failed",
      view(chart, {
        state: "incomplete",
        canDelete: true,
        errorMessage: "Exam 7001 is in Open Dental but does not match this chart at 1 place.",
        mismatches: [{ tooth: 14, surface: "B", kind: "depth", expected: "3 mm", found: "4 mm" }],
      }),
    );
    server.afterDelete = sendResponse(
      "Staged",
      view(chart, { state: "deleted", deletedBy: "hygienist@carein.ai", deletedAt: "2026-09-08T13:25:00.000Z" }),
    );
    renderPerio();

    const panel = await screen.findByTestId("hyg-perio-incomplete");
    expect(screen.getByTestId("hyg-perio-send-status").textContent).toBe("Exam 7001 is in Open Dental and INCOMPLETE");
    expect(panel.textContent).toMatch(/understates disease/);
    expect(screen.getByTestId("hyg-perio-mismatches").textContent).toBe(
      "#14 B: the chart says 3 mm, Open Dental holds 4 mm",
    );
    expect(screen.getByTestId("hyg-perio-failed-tooth-14").textContent).toBe("14!");

    // Locked: a key changes nothing, and no save goes out.
    const before = screen.getByTestId("hyg-perio-progress").textContent;
    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(5));
    expect(screen.getByTestId("hyg-perio-progress").textContent).toBe(before);
    expect(screen.queryByTestId("hyg-perio-send-open")).toBeNull();

    fireEvent.click(screen.getByTestId("hyg-perio-delete-open"));
    await screen.findByTestId("hyg-perio-delete-dialog");
    const confirm = screen.getByTestId("hyg-perio-delete-confirm");
    expect(confirm.textContent).toMatch(/Delete exam 7001/);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(server.deletes).toEqual([]);

    fireEvent.click(screen.getByTestId("hyg-perio-delete-understood"));
    expect(screen.getByTestId("hyg-perio-delete-confirm").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("hyg-perio-delete-confirm"));

    await screen.findByTestId("hyg-perio-deleted");
    expect(server.deletes).toEqual([7001]);
    expect(screen.getByTestId("hyg-perio-send-status").textContent).toBe("Exam 7001 was deleted from Open Dental");
    expect(screen.getByTestId("hyg-perio-state-Staged")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-failed-tooth-14")).toBeNull();
  });

  it("a paused send that already created its exam offers Continue, or deleting that exam instead", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Sending", "Perio chart");
    server.send = sendResponse("Sending", view(chart, { state: "filling", rowsWritten: 12, canDelete: true }));
    renderPerio();
    expect((await screen.findByTestId("hyg-perio-send-status")).textContent).toBe(
      "Paused here. Nothing is being written from this page right now.",
    );
    expect(screen.getByTestId("hyg-perio-continue")).toBeTruthy();
    expect(screen.getByTestId("hyg-perio-delete-open").textContent).toMatch(/Delete exam 7001 instead/);
  });

  it("a refused send says nothing was created, and offers only the way back to the list", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = { ...staged("Failed", "Perio chart"), errorMessage: "refused" };
    server.send = sendResponse(
      "Failed",
      view(chart, {
        state: "refused",
        examNum: null,
        errorMessage:
          "Open Dental refused this perio exam - ProvNum is not a valid provider. Nothing was created in Open Dental, so there is nothing to undo.",
      }),
    );
    renderPerio();
    expect((await screen.findByTestId("hyg-perio-refused")).textContent).toMatch(/nothing to undo/);
    expect(screen.getByTestId("hyg-perio-restage")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-delete-open")).toBeNull();
  });
});

describe("the test-patient rail (item 20)", () => {
  it("a non-test patient's chart is refused beside Send, in the server's words, and stays Staged", async () => {
    const { HygApiError } = await import("@/features/hyg/api");
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Staged", "Full chart: 192 of 192 sites charted, 2026-09-08");
    server.sendScript = [
      new HygApiError(
        "This environment only writes to the designated test patients (roland 12827, 12828; valley 7115), " +
          "and this patient is not one of them. Nothing was sent to Open Dental.",
        422,
        "HYG_TEST_PATIENTS_ONLY",
      ),
    ];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    fireEvent.click(await screen.findByTestId("hyg-perio-send-open"));
    await screen.findByTestId("hyg-perio-confirm");
    fireEvent.click(screen.getByTestId("hyg-perio-confirm-accept"));

    const error = await screen.findByTestId("hyg-perio-send-error");
    expect(error.textContent).toMatch(/only writes to the designated test patients/);
    expect(error.textContent).toMatch(/Nothing was sent to Open Dental/);
    expect(server.calls.filter((c) => c === "SEND_STEP")).toEqual([]);
    expect(screen.getByTestId("hyg-perio-state-Staged")).toBeTruthy();
  });
});

describe("correcting a sent chart (item 13)", () => {
  function writtenView(chart: PerioChart, over: Partial<PerioSendView> = {}): PerioSendView {
    return view(chart, {
      state: "written",
      examNum: 7001,
      rowsWritten: 0,
      finishedAt: "2026-09-08T13:21:00.000Z",
      writtenChart: chart,
      ...over,
    });
  }

  it("a sent chart is amended, not unlocked: the confirm names every changed site, old → new", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Written", "Perio chart");
    const live = writtenView(chart);
    server.send = sendResponse("Written", live);
    server.amendScript = [sendResponse("Amending", live, null, live)];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    // Before: it says where it is, and offers the correction.
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/In Open Dental as exam 7001/);
    expect(screen.queryByTestId("hyg-perio-stage")).toBeNull();
    fireEvent.click(await screen.findByTestId("hyg-perio-amend"));

    await screen.findByTestId("hyg-perio-state-Amending");
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(
      /NOTHING changes in Open Dental until you send/,
    );
    expect(server.calls.filter((c) => c === "AMEND")).toHaveLength(1);

    // The readings are editable again — the thing slice 12 refused.
    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(7));
    expect(screen.getByTestId("hyg-perio-site-1-DB").textContent).toMatch(/^7/);

    fireEvent.click(screen.getByTestId("hyg-perio-stage"));
    await screen.findByTestId("hyg-perio-state-Staged");
    // Item 15: a CORRECTION does not ride the visit Send, so it is not sent back there.
    expect(screen.queryByTestId("hyg-perio-to-visit")).toBeNull();
    fireEvent.click(screen.getByTestId("hyg-perio-send-open"));

    const dialog = await screen.findByTestId("hyg-perio-confirm");
    expect(dialog.textContent).toMatch(/Correct exam 7001 in Open Dental\?/);
    expect(screen.getByTestId("hyg-perio-confirm-changes").textContent).toMatch(/#1 DB: 2 mm → 7 mm/);
    // And it says, before she confirms, that nothing is deleted unless the new exam verifies.
    expect(dialog.textContent).toMatch(/deleted only after that succeeds/);
    expect(screen.getByTestId("hyg-perio-confirm-accept").textContent).toMatch(/Send correction/);
  });

  it("an abandoned correction puts the chart back, and says the exam never changed", async () => {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Amending", "Correction - Full chart");
    const live = writtenView(chart);
    server.send = sendResponse("Amending", live, null, live);
    server.amendScript = [sendResponse("Written", live)];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    fireEvent.click(await screen.findByTestId("hyg-perio-amend-cancel"));
    await screen.findByTestId("hyg-perio-state-Written");
    expect(server.calls.filter((c) => c === "AMEND_CANCEL")).toHaveLength(1);
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/In Open Dental as exam 7001/);
    expect(screen.queryByTestId("hyg-perio-amend-cancel")).toBeNull();
    expect(screen.getByTestId("hyg-perio-amend")).toBeTruthy();
  });

  it("a swap whose delete did not land says so, and offers to finish it", async () => {
    const chart = chartWithDeepPocket();
    const amended = writtenView(chart, {
      examNum: 7002,
      supersedesExamNum: 7001,
      supersedesDeletedAt: null,
      amendDiff: [{ tooth: 1, surface: "DB", kind: "depth", from: "2 mm", to: "7 mm" }],
      errorMessage:
        "Exam 7002 is correct and was read back in full. The exam it replaces, 7001, is STILL in Open Dental.",
    });
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Written", "Perio chart");
    server.send = sendResponse("Written", amended);
    const finished = { ...amended, supersedesDeletedAt: "2026-09-08T14:00:00.000Z" };
    server.amendScript = [sendResponse("Written", finished)];
    renderPerio();

    const warning = await screen.findByTestId("hyg-perio-replaced-left");
    expect(warning.textContent).toMatch(/7001.*still in Open Dental/);
    expect(screen.getByTestId("hyg-perio-send-status").textContent).toBe(
      "Corrected in Open Dental: exam 7002 replaces exam 7001, every site read back",
    );

    fireEvent.click(screen.getByTestId("hyg-perio-remove-replaced"));
    await waitFor(() => expect(screen.queryByTestId("hyg-perio-replaced-left")).toBeNull());
    expect(server.removed).toEqual([7001]);
    expect(screen.getByTestId("hyg-perio-amended").textContent).toMatch(
      /1 site corrected · #1 DB: 2 mm → 7 mm · exam 7001 deleted/,
    );
  });
});

/**
 * THE CHART IN OPEN DENTAL IS NO LONGER WHAT CAREIN WROTE (item 14), on screen.
 *
 * The server's four answers, and what the page is and is NOT allowed to draw for
 * each. Two of these tests exist to stop an obvious-looking fix:
 *
 *   `changed` MUST NOT offer Send again — a difference is somebody's correction.
 *   `unknown` MUST draw nothing — a failed read is not evidence of anything.
 */
describe("a Written chart whose exam has drifted in Open Dental", () => {
  function writtenChartView(chart: PerioChart, over: Partial<PerioSendView> = {}): PerioSendView {
    return view(chart, {
      state: "written",
      examNum: 7001,
      rowsWritten: 0,
      finishedAt: "2026-09-08T13:21:00.000Z",
      writtenChart: chart,
      ...over,
    });
  }

  /** A chart that is Written in Open Dental — the state every answer starts from. */
  function writtenAndSent(): PerioChart {
    const chart = chartWithDeepPocket();
    server.chart = chart;
    server.visitStarted = true;
    server.stagedWrite = staged("Written", "Perio chart");
    const live = writtenChartView(chart);
    server.send = sendResponse("Written", live);
    return chart;
  }

  it("the exam is GONE: it says so, and Send again asks first, listing every same-date exam", async () => {
    const chart = writtenAndSent();
    server.drift = {
      status: "missing",
      examNum: 7001,
      sameDateExams: [
        { examNum: 7050, examDate: "2026-09-08", provNum: 7, careinWrote: false },
        { examNum: 7051, examDate: "2026-09-08", provNum: 7, careinWrote: true },
      ],
    };
    server.amendScript = [sendResponse("Staged", writtenChartView(chart), null, null)];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    const notice = await screen.findByTestId("hyg-perio-drift-missing");
    expect(notice.textContent).toMatch(/Exam 7001 is no longer in Open Dental/);
    expect(notice.textContent).toMatch(/These readings are not in the chart/);
    // NOT AUTOMATIC. Nothing sent, and nothing asked of the server.
    expect(server.calls.filter((c) => c === "RESEND")).toEqual([]);

    fireEvent.click(screen.getByTestId("hyg-perio-drift-resend"));
    const dialog = await screen.findByTestId("hyg-perio-resend-confirm");
    // EVERY exam the patient has on this date, CareIN's or not, with its number.
    const listed = screen.getByTestId("hyg-perio-resend-samedate").textContent ?? "";
    expect(listed).toMatch(/Exam 7050/);
    expect(listed).toMatch(/not written by CareIN/);
    expect(listed).toMatch(/Exam 7051/);
    expect(dialog.textContent).toMatch(/two exams for the same day/);
    // It says it will be a NEW exam, and that 7001 is not coming back.
    expect(dialog.textContent).toMatch(/7001 is not brought back/);
    // Still nothing sent, because she has not confirmed.
    expect(server.calls.filter((c) => c === "RESEND")).toEqual([]);

    fireEvent.click(screen.getByTestId("hyg-perio-resend-confirm-go"));
    await screen.findByTestId("hyg-perio-state-Staged");
    expect(server.resent).toEqual([7001]);
    // And the chart is back on the list, to be SENT: a second, separate confirm.
    expect(screen.getByTestId("hyg-perio-send-open")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-drift-missing")).toBeNull();
  });

  it("no perio exam at all on that date: the dialog says so rather than showing an empty list", async () => {
    writtenAndSent();
    server.drift = { status: "missing", examNum: 7001, sameDateExams: [] };
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    fireEvent.click(await screen.findByTestId("hyg-perio-drift-resend"));
    await screen.findByTestId("hyg-perio-resend-confirm");
    expect(screen.getByTestId("hyg-perio-resend-none").textContent).toMatch(
      /no perio exam in Open Dental at all/,
    );
    expect(screen.queryByTestId("hyg-perio-resend-samedate")).toBeNull();
  });

  it("the sites DIFFER: it names them, and offers NO Send again anywhere on the page", async () => {
    writtenAndSent();
    server.drift = {
      status: "changed",
      examNum: 7001,
      changes: [
        { tooth: 3, surface: "DB", kind: "depth", from: "12 mm", to: "4 mm" },
        { tooth: 14, surface: "B", kind: "depth", from: "3 mm", to: "5 mm" },
      ],
    };
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    const notice = await screen.findByTestId("hyg-perio-drift-changed");
    expect(notice.textContent).toMatch(/Exam 7001 was changed in Open Dental after CareIN wrote it/);
    // IT NAMES THE SITES.
    expect(notice.textContent).toContain("#3 DB: 12 mm");
    expect(notice.textContent).toContain("#14 B: 3 mm");

    // AND OFFERS NO RESEND. A difference is a person's correction; sending again
    // would post a second exam and bury it.
    expect(screen.queryByTestId("hyg-perio-drift-resend")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-resend-confirm")).toBeNull();
    expect(server.calls.filter((c) => c === "RESEND")).toEqual([]);
    // What it points at instead is the correction path, which starts from what
    // Open Dental holds now.
    expect(notice.textContent).toMatch(/Amend chart/);
    expect(screen.getByTestId("hyg-perio-amend")).toBeTruthy();
  });

  it("Open Dental could not be read: the Written line stands unqualified, and nothing is drawn", async () => {
    writtenAndSent();
    server.drift = { status: "unknown", examNum: 7001 };
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);
    await screen.findByTestId("hyg-perio-state-Written");

    // NOTHING. Not a notice, not a warning, not a "could not check".
    expect(screen.queryByTestId("hyg-perio-drift-missing")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-changed")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-resend")).toBeNull();
    // And the Written line is the one it always was.
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/In Open Dental as exam 7001/);
  });

  it("the exam MATCHES: nothing is drawn either, because the Written line already says it", async () => {
    writtenAndSent();
    server.drift = { status: "matches", examNum: 7001 };
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);
    await screen.findByTestId("hyg-perio-state-Written");

    expect(screen.queryByTestId("hyg-perio-drift-missing")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-changed")).toBeNull();
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(/In Open Dental as exam 7001/);
  });

  it("a refused resend is said in the dialog, and the chart stays Written", async () => {
    writtenAndSent();
    server.drift = { status: "missing", examNum: 7001, sameDateExams: [] };
    const { HygApiError } = await import("@/features/hyg/api");
    server.amendScript = [
      new HygApiError(
        "Exam 7001 IS in Open Dental. Sending this chart again would create a second exam for the " +
          "same visit, so nothing was changed.",
        409,
        "PERIO_EXAM_PRESENT",
      ),
    ];
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);

    fireEvent.click(await screen.findByTestId("hyg-perio-drift-resend"));
    await screen.findByTestId("hyg-perio-resend-confirm");
    fireEvent.click(screen.getByTestId("hyg-perio-resend-confirm-go"));

    const error = await screen.findByTestId("hyg-perio-resend-error");
    expect(error.textContent).toMatch(/IS in Open Dental/);
    expect(error.textContent).toMatch(/nothing was changed/);
    // The chart never left Written, and the notice is still there to try again.
    expect(screen.getByTestId("hyg-perio-state-Written")).toBeTruthy();
    expect(screen.getByTestId("hyg-perio-drift-missing")).toBeTruthy();
  });

  it("a chart that was never sent draws nothing, and the page asks for no drift of its own", async () => {
    server.chart = chartWithDeepPocket();
    server.visitStarted = true;
    server.stagedWrite = staged("Staged", "Perio chart");
    server.drift = { status: "not_applicable" };
    renderPerio();
    await screen.findByText(/Kiwi, Sam/);
    await screen.findByTestId("hyg-perio-state-Staged");

    expect(screen.queryByTestId("hyg-perio-drift-missing")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-changed")).toBeNull();
    // ONE prior read on open, and the drift rides it. No second request for it.
    expect(server.calls.filter((c) => c === "PRIOR")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 27: MISSING TEETH PRE-SKIP THEMSELVES
// ─────────────────────────────────────────────────────────────────────────────
//
// The server states which teeth Open Dental records as Missing. Everything that
// decides whether that becomes a skip lives here, on the client, because this is
// the side that knows what she has done to the chart.
//
// The teeth below are the five the probe measured on the roland fixture:
// "1","16","9","32","17" as STRINGS, which the server parses and sorts.

describe("item 27: a fresh chart opens with Open Dental's missing teeth skipped", () => {
  const MISSING = [1, 9, 16, 17, 32];

  /** Open Dental answered, and named these teeth. */
  function odSaysMissing(teeth: number[] = MISSING) {
    server.preSkip = { status: "ready", teeth };
  }

  it("ACCEPTANCE 1: the named teeth are skipped, and drawn struck through", async () => {
    odSaysMissing();
    renderPerio();

    // The strike-through rendering is #211's, and this is what reaches it.
    for (const tooth of MISSING) {
      const number = await screen.findByTestId(`hyg-perio-skipped-number-${tooth}`);
      expect(number.className).toContain("line-through");
      expect(screen.getByTestId(`hyg-perio-skipped-${tooth}-facial`)).toBeTruthy();
      expect(screen.getByTestId(`hyg-perio-skipped-${tooth}-lingual`)).toBeTruthy();
      // A skipped tooth has no sites to chart into.
      expect(screen.queryByTestId(`hyg-perio-site-${tooth}-MB`)).toBeNull();
    }
    // A tooth Open Dental said nothing about is chartable, as always.
    expect(screen.getByTestId("hyg-perio-site-3-MB")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-skipped-number-3")).toBeNull();
  });

  it("says CareIN did it, names the teeth, and says it can be undone", async () => {
    odSaysMissing([1, 16]);
    renderPerio();
    const line = await screen.findByTestId("hyg-perio-preskipped");
    expect(line.textContent).toMatch(/#1, #16 skipped/);
    expect(line.textContent).toMatch(/Open Dental records them as missing/);
    expect(line.textContent).toMatch(/un-skip/);
    // It is not a warning. A correct default is not a problem to report.
    expect(line.getAttribute("role")).toBeNull();
  });

  it("the notice describes the chart AS IT IS — un-skipping a tooth drops it", async () => {
    odSaysMissing([19, 30]);
    renderPerio();
    const line = await screen.findByTestId("hyg-perio-preskipped");
    expect(line.textContent).toMatch(/#19, #30 skipped/);

    // She un-skips the implant.
    fireEvent.click(screen.getByTestId("hyg-perio-skipped-19-facial"));
    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), { key: "x", code: "KeyX" });
    await waitFor(() =>
      expect(screen.getByTestId("hyg-perio-preskipped").textContent).toMatch(/#30 skipped/),
    );
    // #19 is gone from the sentence, and the singular reads correctly.
    expect(screen.getByTestId("hyg-perio-preskipped").textContent).not.toMatch(/#19/);
    expect(screen.getByTestId("hyg-perio-preskipped").textContent).toMatch(/records it as missing/);

    // And when she has un-skipped them all, the line goes away rather than
    // standing there claiming teeth are skipped when none are.
    fireEvent.click(screen.getByTestId("hyg-perio-skipped-30-facial"));
    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), { key: "x", code: "KeyX" });
    await waitFor(() => expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull());
  });

  it("NOTHING IS SAVED, and no visit is started, by a pre-skip alone", async () => {
    /*
     * The serious one. `save` starts a visit that has not been started, so a
     * pre-skip that persisted itself would open a visit and file a draft chart
     * for every patient whose chart she merely glanced at.
     */
    odSaysMissing();
    renderPerio();
    await screen.findByTestId("hyg-perio-skipped-number-1");

    await waitFor(() => expect(server.calls).toContain("PRIOR"));
    // Give the autosave debounce every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(server.calls).not.toContain("SAVE");
    expect(server.calls).not.toContain("OPEN");
    expect(server.saves).toEqual([]);
    expect(server.visitStarted).toBe(false);
  });

  it("STAGING stores the chart FIRST, pre-skips and all — the stage composes from storage", async () => {
    /*
     * The autosave stands down while the chart is nothing but the pre-skip, and
     * `save()` must NOT stand down with it. An earlier version of item 27 moved
     * `lastSaved` to the pre-skipped chart, which suppressed the autosave as
     * intended AND made `save()` itself a no-op -- so staging asked the server
     * for a chart it had never been sent. A separate baseline now suppresses the
     * autosave only, and this is the test that would catch it coming back.
     *
     * ITEM 28 changed how this test gets to Stage, not what it proves. Stage is
     * now refused on a chart of only skips, so she types one reading first --
     * which is the realistic path anyway.
     */
    odSaysMissing([1, 16]);
    renderPerio();
    await screen.findByTestId("hyg-perio-skipped-number-1");
    // The pre-skip alone saved nothing and cannot be staged.
    expect(server.calls).not.toContain("SAVE");
    expect((screen.getByTestId("hyg-perio-stage") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(4));
    await waitFor(() =>
      expect((screen.getByTestId("hyg-perio-stage") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("hyg-perio-stage"));

    await waitFor(() => expect(server.calls).toContain("STAGE"));
    // The save went first, and it carried the pre-skips with the reading.
    expect(server.calls.indexOf("SAVE")).toBeGreaterThan(-1);
    expect(server.calls.indexOf("SAVE")).toBeLessThan(server.calls.indexOf("STAGE"));
    const stored = server.saves.at(-1) as PerioChart;
    expect(countPerioChart(stored).teethSkipped).toEqual([1, 16]);
    expect(countPerioChart(stored).sitesCharted).toBe(1);
  });

  it("ACCEPTANCE 2: a pre-skipped tooth can be un-skipped and then charted", async () => {
    odSaysMissing([19]);
    renderPerio();

    // An implant is Missing in Open Dental and still gets probed, so the
    // pre-skip has to be reachable. #211 made the blank cell selectable.
    const blank = await screen.findByTestId("hyg-perio-skipped-19-facial");
    expect(blank.getAttribute("aria-label")).toContain("un-skip");
    fireEvent.click(blank);

    const grid = screen.getByTestId("hyg-perio-grid");
    fireEvent.keyDown(grid, { key: "x", code: "KeyX" });
    await waitFor(() => expect(screen.queryByTestId("hyg-perio-skipped-19-facial")).toBeNull());

    // And now it takes a reading like any other tooth.
    fireEvent.keyDown(grid, digit(4));
    await waitFor(() => {
      const chart = server.saves.at(-1) as PerioChart | undefined;
      expect(chart).toBeTruthy();
      expect(countPerioChart(chart as PerioChart).sitesCharted).toBe(1);
    });
    // Her un-skip went with it: #19 is no longer skipped in what was stored.
    const stored = server.saves.at(-1) as PerioChart;
    expect(countPerioChart(stored).teethSkipped).not.toContain(19);
  });

  it("her first reading saves the pre-skips along with it", async () => {
    odSaysMissing();
    renderPerio();
    await screen.findByTestId("hyg-perio-skipped-number-1");

    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(3));
    await waitFor(() => expect(server.saves.length).toBeGreaterThan(0));

    const stored = server.saves.at(-1) as PerioChart;
    // Nothing was lost by not saving the pre-skip on its own.
    expect(countPerioChart(stored).teethSkipped).toEqual(MISSING);
    expect(countPerioChart(stored).sitesCharted).toBe(1);
  });
});

describe("item 27: her state wins, on this open and every later one", () => {
  it("ACCEPTANCE 3: a chart with READINGS is never re-skipped", async () => {
    server.preSkip = { status: "ready", teeth: [1, 16] };
    server.chart = normalizePerioChart(withPerioSite(emptyPerioChart(), 1, "MB", { depth: 4 }));
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-site-1-MB");
    // #1 is charted. Open Dental calling it missing does not overrule a reading.
    expect(screen.queryByTestId("hyg-perio-skipped-number-1")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-skipped-number-16")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
  });

  it("ACCEPTANCE 3: a chart she skipped HERSELF is never re-skipped either", async () => {
    server.preSkip = { status: "ready", teeth: [1, 16] };
    server.chart = normalizePerioChart(withPerioSkipped(emptyPerioChart(), 30, true));
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-skipped-number-30");
    // Her skip stands; CareIN's suggestion is not added to it.
    expect(screen.queryByTestId("hyg-perio-skipped-number-1")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
  });

  it("ACCEPTANCE 3: an EMPTY chart that was nonetheless stored is not re-skipped", async () => {
    /*
     * THE UN-SKIP-THE-LAST-TOOTH CASE, and the reason the gate is `chartStored`
     * and not `counts.empty`. She opened this chart, un-skipped the one tooth
     * CareIN pre-skipped, and left. The chart is empty again — and re-skipping
     * it on this open would be CareIN overruling the only decision she made.
     */
    server.preSkip = { status: "ready", teeth: [1, 16] };
    server.chart = normalizePerioChart(emptyPerioChart());
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-grid");
    expect(countPerioChart(server.chart as PerioChart).empty).toBe(true);
    expect(screen.queryByTestId("hyg-perio-skipped-number-1")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
  });

  it("a reading typed while Open Dental is still answering wins the race", async () => {
    server.preSkip = { status: "ready", teeth: [1, 16] };
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await import("@/features/hyg/api");
    const real = api.fetchPerioPrior as unknown as (...a: unknown[]) => Promise<unknown>;
    const spy = vi
      .spyOn(api, "fetchPerioPrior")
      .mockImplementation(async (...args: unknown[]) => {
        await held;
        return real(...args) as never;
      });
    try {
      renderPerio();
      // She starts probing #1 before the initials land.
      const grid = await screen.findByTestId("hyg-perio-grid");
      fireEvent.keyDown(grid, digit(5));
      await waitFor(() => expect(perioSite(server.saves.at(-1) as PerioChart, 1, "DB").depth).toBe(5));

      release?.();
      await waitFor(() => expect(server.calls).toContain("PRIOR"));

      // Her reading stands and #1 was not skipped out from under it.
      expect(screen.queryByTestId("hyg-perio-skipped-number-1")).toBeNull();
      expect(screen.getByTestId("hyg-perio-site-1-DB").textContent).toContain("5");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("item 27: when Open Dental says nothing, neither does the chart", () => {
  it("ACCEPTANCE 4: `ready` with no teeth pre-skips nothing and shows no message", async () => {
    // The measured absence, 200 + [], arriving as a real answer naming no teeth.
    server.preSkip = { status: "ready", teeth: [] };
    renderPerio();

    await screen.findByTestId("hyg-perio-grid");
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
    expect(countPerioChart(emptyPerioChart()).teethSkipped).toEqual([]);
    // Every tooth is chartable, and nothing anywhere says a read failed.
    expect(screen.getByTestId("hyg-perio-site-1-DB")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-prior-unavailable")).toBeNull();
  });

  it("ACCEPTANCE 4: an UNAVAILABLE read opens the chart exactly as it does today", async () => {
    server.preSkip = { status: "unavailable" };
    renderPerio();

    await screen.findByTestId("hyg-perio-grid");
    // No skips, no notice, NO ERROR THEATER. A failed read is not evidence that
    // this patient has all thirty-two teeth, and it is not worth a banner.
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
    for (const tooth of [1, 9, 16, 17, 32]) {
      expect(screen.queryByTestId(`hyg-perio-skipped-number-${tooth}`)).toBeNull();
      expect(screen.getByTestId(`hyg-perio-site-${tooth}-MB`)).toBeTruthy();
    }
  });

  it("a refusal about the appointment pre-skips nothing and still says its own thing", async () => {
    server.priorRefusal = { status: 409, message: "This appointment moved", code: "PATIENT_CHANGED" };
    renderPerio();
    await screen.findByTestId("hyg-perio-prior-failed");
    expect(screen.queryByTestId("hyg-perio-preskipped")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 28: STAGE NEEDS A READING, AND THE BUTTON SAYS SO
// ─────────────────────────────────────────────────────────────────────────────
//
// The server is the rail (routes/hyg/hygPerio.test.js). These are about the
// button not offering something the server would decline, and both read the one
// shared predicate, `perioHasReading`.
//
// Item 27 is why this matters on a chart she has not typed into: Open Dental's
// missing teeth skip themselves, and the Stage button used to light up.

describe("item 28: a chart of only skips cannot be staged from the screen", () => {
  const stageButton = () => screen.getByTestId("hyg-perio-stage") as HTMLButtonElement;

  it("ACCEPTANCE 4: skips alone leave Stage disabled, and the note says why", async () => {
    server.chart = normalizePerioChart(
      [1, 16, 17, 32].reduce((c, t) => withPerioSkipped(c, t, true), emptyPerioChart()),
    );
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-skipped-number-1");
    // Not empty — that is exactly the case the old predicate let through.
    expect(countPerioChart(server.chart as PerioChart).empty).toBe(false);
    expect(stageButton().disabled).toBe(true);
    expect(screen.getByTestId("hyg-perio-stage-note").textContent).toMatch(
      /Nothing to stage until there is a reading\. Skipped teeth do not count\./,
    );
  });

  it("ACCEPTANCE 4: one reading enables it, with the skips still on the chart", async () => {
    let chart = [1, 16].reduce((c, t) => withPerioSkipped(c, t, true), emptyPerioChart());
    chart = normalizePerioChart(withPerioSite(chart, 3, "DB", { depth: 4 }));
    server.chart = chart;
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-site-3-DB");
    expect(stageButton().disabled).toBe(false);
    expect(countPerioChart(chart).teethSkipped).toEqual([1, 16]);
  });

  it("ACCEPTANCE 4: it enables the moment she types, and nothing had to round-trip", async () => {
    server.chart = normalizePerioChart(withPerioSkipped(emptyPerioChart(), 19, true));
    server.chartStored = true;
    renderPerio();

    await screen.findByTestId("hyg-perio-skipped-number-19");
    expect(stageButton().disabled).toBe(true);

    fireEvent.keyDown(screen.getByTestId("hyg-perio-grid"), digit(4));
    await waitFor(() => expect(stageButton().disabled).toBe(false));
  });

  it("ACCEPTANCE 4: an item-27 pre-skip does not light the button up", async () => {
    // The case that prompted the ruling: she has entered nothing, Open Dental's
    // missing teeth pre-skipped themselves, and Stage used to become pressable.
    server.preSkip = { status: "ready", teeth: [1, 16] };
    renderPerio();

    await screen.findByTestId("hyg-perio-skipped-number-1");
    expect(stageButton().disabled).toBe(true);
    expect(server.calls).not.toContain("STAGE");
  });

  it("an untouched chart is still disabled, exactly as before", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    expect(stageButton().disabled).toBe(true);
  });
});
