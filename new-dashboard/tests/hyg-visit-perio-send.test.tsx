/**
 * A STAGED PERIO CHART RIDES THE VISIT SEND (item 15) — on screen.
 *
 * The flow a hygienist wants: chart → Stage → back to the visit → ONE Send that
 * carries the note, the slip, the handoff AND the chart. What this screen must
 * hold to while doing it:
 *
 *   1. The tray says the staged chart rides Send, and the old "Send below leaves
 *      it here" copy is gone.
 *   2. ONE dialog lists the chart beside the other kinds — sites charted, exam
 *      date, provider — and the confirmation carries the date and provider.
 *   3. A refusal of the whole send (a drifted fingerprint) says so, and no step
 *      of the chart is asked for.
 *   4. Note Written + perio Failed: each row says its own truth.
 *   7. Retry on an interrupted chart RESUMES the same send (its step route), never
 *      a second send and never a restage.
 *   8. A correction, an in-flight send, and a chart with no provider stay out of
 *      Send, each in words.
 *   9. A send in flight from the chart page shows here, and Send does not start
 *      a second.
 *  10. Pressing Send twice sends once.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The one name below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { emptySlip, type HygAppointment, type SendOutcome, type StagedWrite } from "@shared/hyg/contract";
import { countPerioChart, emptyPerioChart, type PerioCounts } from "@shared/hyg/perio";
import type { HygPerioSendResponse, PerioSendView } from "@shared/hyg/perioSend";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  staged: [] as StagedWrite[],
  /** What GET /perio/send answers: the latest send, and the one live in Open Dental. */
  perioSend: null as unknown,
  perioLive: null as unknown,
  counts: null as unknown,
  /** Every call, in order, so a test can prove what the page asked for. */
  calls: [] as string[],
  /** Every visit-send body, verbatim. */
  sends: [] as unknown[],
  /** The next visit send's answer, or a refusal. */
  sendOutcomes: [] as unknown[],
  sendRefusal: null as { status: number; code: string; message: string } | null,
  /** Each step's answer in turn. */
  steps: [] as unknown[],
  /** Holds the visit send open until released — for the double-press test. */
  holdSend: null as Promise<void> | null,
  noProvider: false,
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

let stamp = 0;
function write(kind: StagedWrite["kind"], state: StagedWrite["state"], over: Partial<StagedWrite> = {}): StagedWrite {
  stamp += 1;
  const perio = kind === "perio";
  return {
    id: `staged-${kind}`,
    kind,
    state,
    title: perio ? "Perio chart" : "Visit note",
    summary: perio ? "Partial chart: 84 of 192 sites charted, 2026-09-08" : "Unsigned note for 2026-09-08",
    preview: perio ? ["Partial chart: 84 of 192 sites charted", "#3 B: 3 2 3"] : ["Entered in CareIN. Unsigned."],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: `2026-09-08T13:10:${String(stamp % 60).padStart(2, "0")}.000Z`,
    ...over,
  };
}

function sendView(over: Partial<PerioSendView> = {}): PerioSendView {
  return {
    sendId: "send-0001",
    state: "posting",
    examNum: null,
    examDate: "2026-09-08",
    provNum: 7,
    arches: [],
    rowsPlanned: 0,
    rowsWritten: 0,
    deepSites: 0,
    mismatches: [],
    errorMessage: null,
    requestsRemaining: 4,
    startedBy: "hygienist@carein.ai",
    startedAt: "2026-09-08T13:20:00.000Z",
    finishedAt: null,
    deletedBy: null,
    deletedAt: null,
    canDelete: false,
    supersedesExamNum: null,
    supersedesDeletedAt: null,
    amendDiff: [],
    writtenChart: null,
    ...over,
  };
}

/** A step answer the fake server then HOLDS, the way the real one does. */
function step(stagedState: StagedWrite["state"], send: PerioSendView, paused: string | null = null): HygPerioSendResponse {
  return {
    success: true,
    office: "roland",
    aptNum: 900001,
    stagedWrite: write("perio", stagedState, {
      writtenRef: stagedState === "Written" ? "Perio exam 7001: 84 sites read back and match" : null,
    }),
    send,
    live: send.state === "written" ? send : null,
    paused,
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();

  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: emptySlip(),
    items: [],
    stagedWrites: server.staged,
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  });
  const mutation = () => ({
    success: true as const,
    visit: visit(),
    recordsNeeded: [],
    handoffCategory: "Other" as const,
    doctorOptions: ["Beau Sparkman"],
  });
  const replacePerio = (next: StagedWrite | null) => {
    if (!next) return;
    server.staged = server.staged.map((w) => (w.kind === "perio" ? next : w));
  };

  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, _a: number, date: string) => {
      server.calls.push("GET visit");
      return {
        success: true as const,
        office: office as "roland",
        officeName: "Roland Family Dental",
        date,
        appointment: server.noProvider ? { ...APPOINTMENT, provHyg: null, provNum: null } : APPOINTMENT,
        flagSources: {},
        ...mutation(),
      };
    }),
    openVisit: vi.fn(async () => mutation()),
    fetchPerioSend: vi.fn(async (): Promise<HygPerioSendResponse> => {
      server.calls.push("GET perio/send");
      return {
        success: true,
        office: "roland",
        aptNum: 900001,
        stagedWrite: server.staged.find((w) => w.kind === "perio") ?? null,
        send: server.perioSend as PerioSendView | null,
        live: server.perioLive as PerioSendView | null,
        paused: null,
      };
    }),
    fetchPerio: vi.fn(async () => {
      server.calls.push("GET perio");
      return {
        success: true as const,
        office: "roland" as const,
        aptNum: 900001,
        visitStarted: true,
        chart: emptyPerioChart(),
        stagedWrite: server.staged.find((w) => w.kind === "perio") ?? null,
        counts: server.counts as PerioCounts,
      };
    }),
    sendVisit: vi.fn(async (_o: string, _a: number, _d: string, confirm: unknown) => {
      server.calls.push("SEND visit");
      server.sends.push(confirm);
      if (server.holdSend) await server.holdSend;
      if (server.sendRefusal) {
        throw new real.HygApiError(server.sendRefusal.message, server.sendRefusal.status, server.sendRefusal.code);
      }
      const outcomes = server.sendOutcomes as SendOutcome[];
      for (const o of outcomes) {
        server.staged = server.staged.map((w) =>
          w.kind === o.kind
            ? { ...w, state: o.state, writtenRef: o.writtenRef, errorMessage: o.state === "Failed" ? o.errorMessage : null }
            : w,
        );
      }
      return {
        ...mutation(),
        outcomes,
        written: outcomes.filter((o) => o.state === "Written").length,
        failed: outcomes.filter((o) => o.state === "Failed").length,
      };
    }),
    stepPerioSend: vi.fn(async () => {
      server.calls.push("STEP perio");
      const next = server.steps.shift() as HygPerioSendResponse;
      replacePerio(next.stagedWrite);
      server.perioSend = next.send;
      return next;
    }),
    retryStagedWrite: vi.fn(async (_o: string, _a: number, kind: string) => {
      server.calls.push("RETRY " + kind);
      server.staged = server.staged.map((w) => (w.kind === kind ? { ...w, state: "Staged" as const, errorMessage: null } : w));
      return mutation();
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

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

/** The counts of a partial chart: 84 of 192 sites. */
const COUNTS: PerioCounts = { ...countPerioChart(emptyPerioChart()), sitesCharted: 84, empty: false };

beforeEach(() => {
  server.staged = [write("note", "Staged"), write("perio", "Staged")];
  server.perioSend = null;
  server.perioLive = null;
  server.counts = COUNTS;
  server.calls = [];
  server.sends = [];
  server.sendOutcomes = [];
  server.sendRefusal = null;
  server.steps = [];
  server.holdSend = null;
  server.noProvider = false;
});
afterEach(cleanup);

/** Wait until the tray knows whether the chart can ride Send. */
async function trayReady() {
  await screen.findByTestId("hyg-staged-tray");
  await waitFor(() => expect(screen.queryByText(/Checking whether this chart/)).toBeNull());
}

describe("the tray (acceptance 1)", () => {
  it("shows a staged chart riding Send, and the old 'leaves it here' copy is gone", async () => {
    renderVisit();
    await trayReady();
    expect(screen.getByTestId("hyg-perio-rides-send").textContent).toMatch(/goes with Send below/);
    const tray = screen.getByTestId("hyg-staged-tray").textContent ?? "";
    expect(tray).not.toMatch(/leaves it here/);
    expect(tray).not.toMatch(/sent from its own page/i);
    expect(screen.queryByTestId("hyg-perio-not-sent")).toBeNull();
    // The note and the chart: Send counts TWO.
    expect(screen.getByTestId("hyg-send-all").textContent).toMatch(/Send 2 to Open Dental/);
  });
});

describe("the one dialog (acceptance 2)", () => {
  it("lists the chart beside the note with sites, exam date and provider, and the confirm carries them", async () => {
    server.sendOutcomes = [
      { kind: "note", state: "Written", writtenRef: "GroupNote 60001", errorMessage: null, code: null },
      { kind: "perio", state: "Written", writtenRef: "Perio exam 7001: 84 sites read back and match", errorMessage: null, code: null },
    ];
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));

    expect(await screen.findAllByTestId("hyg-confirm-send")).toHaveLength(1);
    expect(screen.getByTestId("hyg-confirm-note")).toBeTruthy();
    expect(screen.getByTestId("hyg-confirm-perio")).toBeTruthy();
    expect(screen.getByTestId("hyg-confirm-perio-sites").textContent).toBe("84 of 192");
    expect(screen.getByTestId("hyg-confirm-perio-date").textContent).toBe("2026-09-08");
    expect(screen.getByTestId("hyg-confirm-perio-provider").textContent).toBe("HYG1 (ProvNum 7)");
    expect(screen.getByTestId("hyg-confirm-send").textContent).toMatch(/Send 2 things to Open Dental\?/);

    fireEvent.click(screen.getByTestId("hyg-confirm-send-accept"));
    await screen.findByTestId("hyg-written-perio");
    expect(server.sends).toEqual([
      [
        { kind: "note", previewFingerprint: "fp-note" },
        { kind: "perio", previewFingerprint: "fp-perio", examDate: "2026-09-08", provNum: 7 },
      ],
    ]);
    // Written in the send's own request: the page asked for no further step.
    expect(server.calls).not.toContain("STEP perio");
    expect(screen.getByTestId("hyg-written-perio").textContent).toMatch(/84 sites read back and match/);
  });
});

describe("refusals and partial outcomes", () => {
  it("ACCEPTANCE 3: a drifted fingerprint refuses the whole send, says so, and asks for no step", async () => {
    server.sendRefusal = {
      status: 409,
      code: "PREVIEW_CHANGED",
      message: "The perio write changed since you read it. Nothing was sent.",
    };
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    expect((await screen.findByTestId("hyg-send-refused")).textContent).toMatch(/Nothing was sent/);
    expect(server.calls).not.toContain("STEP perio");
    expect(screen.getByTestId("hyg-staged-note").textContent).toMatch(/Staged/);
    expect(screen.getByTestId("hyg-staged-perio").textContent).toMatch(/Staged/);
  });

  it("ACCEPTANCE 4: note Written and perio Failed — each row says its own truth, and perio keeps its Retry", async () => {
    server.sendOutcomes = [
      { kind: "note", state: "Written", writtenRef: "GroupNote 60001 on 2 procedures (5001, 5002)", errorMessage: null, code: null },
      {
        kind: "perio",
        state: "Failed",
        writtenRef: null,
        errorMessage: "Open Dental refused this perio exam - ProvNum is not valid. Nothing was created in Open Dental, so there is nothing to undo.",
        code: "PERIO_SEND_STOPPED",
      },
    ];
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    expect((await screen.findByTestId("hyg-written-note")).textContent).toMatch(/GroupNote 60001/);
    expect(screen.getByTestId("hyg-failed-perio").textContent).toMatch(/refused this perio exam/);
    expect(screen.getByTestId("hyg-staged-note").querySelector('[data-testid="hyg-staged-state-Written"]')).toBeTruthy();
    expect(screen.getByTestId("hyg-staged-perio").querySelector('[data-testid="hyg-staged-state-Failed"]')).toBeTruthy();
    expect(screen.queryByTestId("hyg-written-perio")).toBeNull();

    // Failed → Retry puts it back on the list (the server allows that only when
    // nothing it wrote is left in Open Dental).
    fireEvent.click(screen.getByTestId("hyg-retry-perio"));
    await waitFor(() => expect(server.calls).toContain("RETRY perio"));
    expect(server.calls).not.toContain("STEP perio");
  });
});

describe("resuming (acceptance 7)", () => {
  it("an interrupted chart says it paused, and Retry carries on the SAME send through its step route", async () => {
    server.sendOutcomes = [
      { kind: "note", state: "Written", writtenRef: "GroupNote 60001", errorMessage: null, code: null },
      {
        kind: "perio",
        state: "Sending",
        writtenRef: null,
        errorMessage: "Open Dental did not answer for the exam (upstream timeout). CareIN will check whether it landed before sending it again.",
        code: "PERIO_PAUSED",
      },
    ];
    // The exam the interrupted send created is found by reading, and adopted.
    server.steps = [step("Written", sendView({ state: "written", examNum: 7001 }))];
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    expect((await screen.findByTestId("hyg-perio-paused")).textContent).toMatch(/did not answer for the exam/);
    expect(screen.getByTestId("hyg-perio-in-progress").textContent).toMatch(/reads Open Dental before it writes/);
    expect(server.calls).not.toContain("STEP perio");

    fireEvent.click(screen.getByTestId("hyg-retry-perio"));
    expect((await screen.findByTestId("hyg-written-perio")).textContent).toMatch(/Perio exam 7001/);
    // ONE send: the step route, never a second visit send, never a restage.
    expect(server.calls.filter((c) => c === "SEND visit")).toHaveLength(1);
    expect(server.calls.filter((c) => c === "STEP perio")).toHaveLength(1);
    expect(server.calls).not.toContain("RETRY perio");
  });

  it("a chart that needs more than one step is stepped from here until it is Written", async () => {
    server.sendOutcomes = [
      { kind: "note", state: "Written", writtenRef: "GroupNote 60001", errorMessage: null, code: null },
      { kind: "perio", state: "Sending", writtenRef: null, errorMessage: null, code: null },
    ];
    server.steps = [
      step("Sending", sendView({ state: "filling", examNum: 7001, rowsPlanned: 16, rowsWritten: 12 })),
      step("Written", sendView({ state: "written", examNum: 7001, rowsPlanned: 16, rowsWritten: 16 })),
    ];
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    await screen.findByTestId("hyg-written-perio");
    expect(server.calls.filter((c) => c === "STEP perio")).toHaveLength(2);
  });
});

describe("what stays out of Send (acceptance 8 and 9)", () => {
  it("a staged CORRECTION stays on the chart page, and says so", async () => {
    server.perioLive = sendView({ state: "written", examNum: 7001 });
    server.perioSend = server.perioLive;
    renderVisit();
    await screen.findByTestId("hyg-perio-correction");
    expect(screen.getByTestId("hyg-perio-correction").textContent).toMatch(/correction to exam 7001/);
    expect(screen.queryByTestId("hyg-perio-rides-send")).toBeNull();
    expect(screen.getByTestId("hyg-send-all").textContent).toMatch(/Send 1 to Open Dental/);
  });

  it("Draft, Amending and Written charts are never counted", async () => {
    for (const state of ["Draft", "Amending", "Written"] as const) {
      server.staged = [write("note", "Staged"), write("perio", state)];
      renderVisit();
      await screen.findByTestId("hyg-staged-tray");
      await waitFor(() => expect(server.calls).toContain("GET perio/send"));
      expect(screen.getByTestId("hyg-send-all").textContent).toMatch(/Send 1 to Open Dental/);
      cleanup();
      server.calls = [];
    }
  });

  it("an appointment with no provider keeps the chart out of Send, in words", async () => {
    server.noProvider = true;
    renderVisit();
    await trayReady();
    expect(screen.getByTestId("hyg-perio-blocked").textContent).toMatch(/no provider in Open Dental/);
    expect(screen.getByTestId("hyg-send-all").textContent).toMatch(/Send 1 to Open Dental/);
  });

  it("ACCEPTANCE 9: a send in flight from the chart page shows here, and Send does not start a second", async () => {
    server.staged = [write("note", "Staged"), write("perio", "Sending")];
    server.perioSend = sendView({ state: "posting" });
    server.sendOutcomes = [{ kind: "note", state: "Written", writtenRef: "GroupNote 60001", errorMessage: null, code: null }];
    server.steps = [step("Written", sendView({ state: "written", examNum: 7001 }))];
    renderVisit();
    await trayReady();

    expect(screen.getByTestId("hyg-perio-in-progress").textContent).toMatch(/Being sent, and not from this page/);
    expect(screen.getByTestId("hyg-staged-perio").querySelector('[data-testid="hyg-staged-state-Sending"]')).toBeTruthy();
    // Send offers the note only, and the dialog does not list the chart.
    expect(screen.getByTestId("hyg-send-all").textContent).toMatch(/Send 1 to Open Dental/);
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    await screen.findByTestId("hyg-confirm-send");
    expect(screen.queryByTestId("hyg-confirm-perio")).toBeNull();
    fireEvent.click(screen.getByTestId("hyg-confirm-send-accept"));
    await screen.findByTestId("hyg-written-note");
    expect(server.sends).toEqual([[{ kind: "note", previewFingerprint: "fp-note" }]]);

    // Retry picks the SAME send up here — its step, not a new one.
    fireEvent.click(screen.getByTestId("hyg-retry-perio"));
    await screen.findByTestId("hyg-written-perio");
    expect(server.calls.filter((c) => c === "STEP perio")).toHaveLength(1);
  });
});

describe("pressing twice (acceptance 10)", () => {
  it("a second press while the first send is running sends nothing", async () => {
    let release: () => void = () => undefined;
    server.holdSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.sendOutcomes = [
      { kind: "note", state: "Written", writtenRef: "GroupNote 60001", errorMessage: null, code: null },
      { kind: "perio", state: "Written", writtenRef: "Perio exam 7001: 84 sites read back and match", errorMessage: null, code: null },
    ];
    renderVisit();
    await trayReady();
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    // The send is in flight: the button is disabled, and pressing it does nothing.
    await waitFor(() => expect(screen.getByTestId("hyg-send-all").hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    expect(screen.queryByTestId("hyg-confirm-send-accept")).toBeNull();

    release();
    await screen.findByTestId("hyg-written-perio");
    expect(server.sends).toHaveLength(1);
  });
});
