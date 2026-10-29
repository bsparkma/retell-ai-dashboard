/**
 * EXISTING TREATMENT (from Open Dental), ON SCREEN — hygiene Slice 2a.
 *
 * What this screen must and must not do:
 *
 *   1. Sit ABOVE "Treatment identified today", list the plan the server read,
 *      and group under Watch ONLY what the server flagged from Open Dental's
 *      priority name.
 *   2. Draw "Not discussed" as the default and never like an answer.
 *   3. Store what she taps through the server, and show the server's read-back.
 *   4. Say "Couldn't load existing treatment from Open Dental" with a Retry when
 *      the read fails — never an empty list that reads as "none".
 *   5. Lock once the visit is sent.
 *   6. Remind, never gate, at Send.
 *
 * NO NETWORK, NO BACKEND, NO PHI: the appointment carries no name at all.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygAppointment, StagedWrite } from "@shared/hyg/contract";
import type {
  ExistingTxDispositionInput,
  ExistingTxItem,
  ExistingTxResponse,
} from "@shared/hyg/existingTx";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  hasVisit: true,
  staged: [] as StagedWrite[],
  items: [] as ExistingTxItem[],
  frozen: false,
  /** Set to make the next N reads fail as Open Dental would. */
  failReads: 0,
  /** Set to make the next save refuse with this code. */
  saveRefusal: null as string | null,
  /** ms each save waits before answering, so a test can tap while one is in flight. */
  saveDelay: 0,
  reads: [] as boolean[],
  saves: [] as Array<{ procNum: number; input: ExistingTxDispositionInput }>,
  opens: 0,
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  patientName: null,
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

function item(over: Partial<ExistingTxItem> = {}): ExistingTxItem {
  return {
    procNum: 5001,
    code: "D2392",
    description: "Resin-based composite - two surfaces, posterior",
    tooth: "30",
    surface: "MO",
    dateTp: "2026-05-01",
    priorityName: null,
    watch: false,
    scheduled: false,
    disposition: null,
    lastDiscussed: null,
    ...over,
  };
}

function stagedWrite(kind: StagedWrite["kind"], state: StagedWrite["state"]): StagedWrite {
  return {
    id: `staged-${kind}`,
    kind,
    state,
    title: kind === "note" ? "Visit note" : "Routing slip",
    summary: "The slip for 2026-09-08",
    preview: ["Done today: Prophy"],
    previewFingerprint: `fp-${kind}`,
    errorMessage: state === "Failed" ? "Open Dental refused the write" : null,
    writtenRef: state === "Written" ? "ref-1" : null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: state === "Written" ? "hygienist@carein.ai" : null,
    sentAt: state === "Written" ? "2026-09-08T13:20:00.000Z" : null,
    updatedAt: "2026-09-08T13:10:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: contract.emptySlip(),
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
    handoffCategory: "Restorative" as const,
    doctorOptions: ["Drew Example"],
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
      visit: server.hasVisit ? visit() : null,
      recordsNeeded: [],
      handoffCategory: "Restorative" as const,
      doctorOptions: ["Drew Example"],
    })),
    openVisit: vi.fn(async () => {
      server.opens += 1;
      server.hasVisit = true;
      return mutation();
    }),
    fetchExistingTx: vi.fn(
      async (_o: string, _a: number, opts: { refresh?: boolean } = {}): Promise<ExistingTxResponse> => {
        server.reads.push(Boolean(opts.refresh));
        if (server.failReads > 0) {
          server.failReads -= 1;
          throw new real.HygApiError(
            "Couldn't load existing treatment from Open Dental",
            502,
            "OD_READ_FAILED",
          );
        }
        return {
          success: true,
          office: "roland",
          aptNum: 900001,
          frozen: server.frozen,
          readAt: "2026-09-08T13:00:00.000Z",
          items: server.items,
        };
      },
    ),
    saveExistingTxDisposition: vi.fn(
      async (_o: string, _a: number, procNum: number, input: ExistingTxDispositionInput) => {
        server.saves.push({ procNum, input });
        if (server.saveDelay > 0) await new Promise((r) => setTimeout(r, server.saveDelay));
        if (server.saveRefusal) {
          throw new real.HygApiError(
            "This visit has been sent, so its existing-treatment answers can no longer be changed",
            409,
            server.saveRefusal,
          );
        }
        return {
          success: true as const,
          office: "roland" as const,
          aptNum: 900001,
          procNum,
          disposition: { ...input, updatedBy: "hygienist@carein.ai", updatedAt: "2026-09-08T13:05:00.000Z" },
          // RULING (compact round): a save answers with the staged writes read back after it.
          stagedWrites: server.staged,
        };
      },
    ),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatPlainDate, lastDiscussedLine } from "@/features/hyg/visit/ExistingTreatment";

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
  server.hasVisit = true;
  server.staged = [];
  server.items = [item()];
  server.frozen = false;
  server.failReads = 0;
  server.saveRefusal = null;
  server.saveDelay = 0;
  server.reads = [];
  server.saves = [];
  server.opens = 0;
});
afterEach(cleanup);

const pressed = (id: string) => screen.getByTestId(id).getAttribute("aria-pressed");

/**
 * RULING (compact round): rows start COLLAPSED, one per tooth; a tap opens the
 * editor. This opens the row a procedure is on and returns its editor.
 */
async function openRow(procNum: number) {
  const proc = await screen.findByTestId(`hyg-existing-tx-proc-${procNum}`);
  const toggle = proc.closest("button");
  if (!toggle) throw new Error("no row toggle");
  fireEvent.click(toggle);
  return screen.findByTestId(`hyg-existing-tx-row-${procNum}`);
}

/** RULING (compact round): the note sits behind "+ note". */
function openNote(procNum: number) {
  fireEvent.click(screen.getByTestId(`hyg-existing-tx-add-note-${procNum}`));
  return screen.getByTestId(`hyg-existing-tx-note-${procNum}`) as HTMLInputElement;
}

describe("the list", () => {
  it("sits above Treatment identified today, and reads once on open", async () => {
    renderVisit();
    const section = await screen.findByTestId("hyg-existing-tx");
    await screen.findByTestId("hyg-existing-tx-proc-5001");
    const today = screen.getByTestId("hyg-treatment");
    // DOCUMENT_POSITION_FOLLOWING: the treatment section comes after this one.
    expect(section.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // RULING (compact round): the heading counts what is there and what was said.
    expect(screen.getByTestId("hyg-existing-tx-heading").textContent).toBe(
      "Existing treatment (1) · 0 answered · 0 urgent",
    );
    expect(section.textContent).toContain("from Open Dental");
    expect(server.reads).toEqual([false]);
  });

  it("shows code, tooth/surface, planned date, Already scheduled and Last discussed", async () => {
    server.items = [
      item({
        procNum: 5002,
        code: "D2740",
        description: "Crown",
        tooth: "3",
        surface: "",
        dateTp: "2026-06-20",
        scheduled: true,
        lastDiscussed: {
          visitDate: "2026-06-01",
          patient: "wants_to_wait",
          waitTimeframe: "6_months",
          clinical: null,
        },
      }),
      item({ procNum: 5001, dateTp: null }),
    ];
    renderVisit();
    // RULING (compact round): an item already on a scheduled appointment sits in
    // the collapsed "Already scheduled (N)" subsection, one tap away.
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-show-scheduled"));
    const group = screen.getByTestId("hyg-existing-tx-group-scheduled-3");
    expect(group.textContent).toContain("D2740");
    expect(group.textContent).toContain("#3");
    expect(group.textContent).toContain("Planned 20 Jun 2026");
    expect(within(group).getByTestId("hyg-existing-tx-gscheduled-scheduled-3").textContent).toBe("Already scheduled");
    const row = await openRow(5002);
    expect(within(row).getByTestId("hyg-existing-tx-scheduled-5002").textContent).toBe("Already scheduled");
    expect(within(row).getByTestId("hyg-existing-tx-last-5002").textContent).toBe(
      "Last discussed 1 Jun 2026: Wants to wait (6 months)",
    );
    const other = screen.getByTestId("hyg-existing-tx-group-30");
    expect(other.textContent).toContain("#30");
    expect(other.textContent).toContain("D2392");
    expect(other.textContent).toContain("MO");
    expect(other.textContent).toContain("Planned date not recorded");
    const otherRow = await openRow(5001);
    expect(within(otherRow).queryByTestId("hyg-existing-tx-scheduled-5001")).toBeNull();
    expect(within(otherRow).queryByTestId("hyg-existing-tx-last-5001")).toBeNull();
  });

  // RULING (compact round): Watch is a BADGE on the row, not a separate list,
  // and rows are in tooth order. Still only what the server flagged.
  it("badges Watch only what the server flagged; rows in tooth order", async () => {
    server.items = [
      item({ procNum: 5003, tooth: "30", dateTp: "2026-07-01" }),
      item({ procNum: 5004, tooth: "14", dateTp: "2026-06-01", watch: true, priorityName: "Watch" }),
      item({ procNum: 5001, tooth: "3", dateTp: "2026-05-01" }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-proc-5004");
    expect(screen.getByTestId("hyg-existing-tx-gwatch-14").textContent).toBe("Watch");
    expect(screen.queryByTestId("hyg-existing-tx-gwatch-30")).toBeNull();
    expect(screen.queryByTestId("hyg-existing-tx-gwatch-3")).toBeNull();
    const rows = screen.getAllByTestId(/^hyg-existing-tx-group-/).map((r) => r.dataset.testid);
    expect(rows).toEqual(["hyg-existing-tx-group-3", "hyg-existing-tx-group-14", "hyg-existing-tx-group-30"]);
  });

  it("no Watch badge at all when nothing is flagged", async () => {
    server.items = [item({ procNum: 5001, priorityName: "Urgent" })];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-proc-5001");
    expect(screen.queryByTestId(/^hyg-existing-tx-gwatch-/)).toBeNull();
  });

  it("an empty plan says so in words", async () => {
    server.items = [];
    renderVisit();
    expect((await screen.findByTestId("hyg-existing-tx-none")).textContent).toBe(
      "Open Dental has no treatment planned for this patient.",
    );
  });

  it("rows are divs, and no button sits inside a button", async () => {
    renderVisit();
    // RULING (compact round): the row is the tooth group, opened.
    await openRow(5001);
    const row = screen.getByTestId("hyg-existing-tx-group-30");
    expect(row.tagName).toBe("DIV");
    for (const button of within(row).getAllByRole("button")) {
      expect(button.querySelector("button, a, input, textarea, select")).toBeNull();
      expect(button.className).toContain("min-h-11");
    }
  });
});

describe("the failure", () => {
  it("is an honest error with Retry, never an empty list — and Retry asks again", async () => {
    server.failReads = 1;
    renderVisit();
    const error = await screen.findByTestId("hyg-existing-tx-error");
    expect(error.textContent).toContain("Couldn't load existing treatment from Open Dental");
    expect(screen.queryByTestId("hyg-existing-tx-none")).toBeNull();
    expect(screen.queryByTestId(/^hyg-existing-tx-row-/)).toBeNull();

    fireEvent.click(screen.getByTestId("hyg-existing-tx-retry"));
    await screen.findByTestId("hyg-existing-tx-proc-5001"); // RULING (compact round): rows start collapsed
    expect(server.reads).toEqual([false, true]);
  });
});

describe("before the visit exists", () => {
  it("asks to start it, and only then reads", async () => {
    server.hasVisit = false;
    renderVisit();
    const start = await screen.findByTestId("hyg-existing-tx-start");
    expect(server.reads).toEqual([]);
    fireEvent.click(start);
    await screen.findByTestId("hyg-existing-tx-proc-5001"); // RULING (compact round): rows start collapsed
    expect(server.opens).toBe(1);
    expect(server.reads).toEqual([false]);
  });
});

describe("the chips", () => {
  it("Not discussed is the default, and is drawn dashed — never like an answer", async () => {
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    expect(pressed("hyg-existing-tx-patient-5001-not_discussed")).toBe("true");
    expect(screen.getByTestId("hyg-existing-tx-patient-5001-not_discussed").className).toContain("border-dashed");
    expect(screen.getByTestId("hyg-existing-tx-patient-5001-not_discussed").className).not.toContain("border-primary");
    for (const v of ["ready_to_schedule", "wants_to_wait", "see_plan_again", "cost_questions", "declined"]) {
      expect(pressed(`hyg-existing-tx-patient-5001-${v}`)).toBe("false");
    }
    for (const v of ["no_change", "worse_urgent", "re_evaluate", "no_longer_needed"]) {
      expect(pressed(`hyg-existing-tx-clinical-5001-${v}`)).toBe("false");
    }
    expect(screen.queryByTestId("hyg-existing-tx-wait-5001-1_month")).toBeNull();
    // Each question is written above its chips.
    const row = screen.getByTestId("hyg-existing-tx-row-5001");
    expect(row.textContent).toContain("Anything changed clinically?");
    expect(row.textContent).toContain("What did the patient say?");
  });

  it("a picked answer is the SERVER's read-back, drawn as an answer", async () => {
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-5001-ready_to_schedule"));
    await waitFor(() => expect(pressed("hyg-existing-tx-patient-5001-ready_to_schedule")).toBe("true"));
    expect(server.saves).toEqual([
      { procNum: 5001, input: { clinical: null, patient: "ready_to_schedule", waitTimeframe: null, note: null } },
    ]);
    expect(screen.getByTestId("hyg-existing-tx-patient-5001-ready_to_schedule").className).toContain("border-primary");
    expect(pressed("hyg-existing-tx-patient-5001-not_discussed")).toBe("false");
  });

  it("Wants to wait reveals the timeframe; another answer clears it", async () => {
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-5001-wants_to_wait"));
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-wait-5001-6_months"));
    await waitFor(() => expect(pressed("hyg-existing-tx-wait-5001-6_months")).toBe("true"));
    expect(server.saves[1].input).toEqual({
      clinical: null,
      patient: "wants_to_wait",
      waitTimeframe: "6_months",
      note: null,
    });

    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-5001-declined"));
    await waitFor(() => expect(screen.queryByTestId("hyg-existing-tx-wait-5001-6_months")).toBeNull());
    expect(server.saves[2].input).toEqual({
      clinical: null,
      patient: "declined",
      waitTimeframe: null,
      note: null,
    });
  });

  it("Getting worse → urgent shows a red Urgent pill and says it is CareIN only", async () => {
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    expect(screen.queryByTestId("hyg-existing-tx-urgent-5001")).toBeNull();
    fireEvent.click(screen.getByTestId("hyg-existing-tx-clinical-5001-worse_urgent"));
    const pill = await screen.findByTestId("hyg-existing-tx-urgent-5001");
    expect(pill.textContent).toBe("Urgent");
    expect(pill.className).toContain("bg-red-600");
    expect(screen.getByTestId("hyg-existing-tx-row-5001").textContent).toContain(
      "Changes the priority here, not in Open Dental.",
    );

    // Tapping the picked answer again takes it back.
    fireEvent.click(screen.getByTestId("hyg-existing-tx-clinical-5001-worse_urgent"));
    await waitFor(() => expect(screen.queryByTestId("hyg-existing-tx-urgent-5001")).toBeNull());
    expect(server.saves[1].input.clinical).toBeNull();
  });

  it("a note then a chip, tapped while the note is still saving, keeps BOTH — in order", async () => {
    server.saveDelay = 150;
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    const note = openNote(5001);
    fireEvent.change(note, { target: { value: "sensitive to cold" } });
    fireEvent.blur(note);
    // The note's save is in flight: the chip is still there to tap, and a
    // re-read waits until it lands.
    expect((screen.getByTestId("hyg-existing-tx-refresh") as HTMLButtonElement).disabled).toBe(true);
    const chip = screen.getByTestId("hyg-existing-tx-patient-5001-declined") as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    await waitFor(() => expect(pressed("hyg-existing-tx-patient-5001-declined")).toBe("true"));
    expect(server.saves.map((s) => s.input)).toEqual([
      { clinical: null, patient: "not_discussed", waitTimeframe: null, note: "sensitive to cold" },
      { clinical: null, patient: "declined", waitTimeframe: null, note: "sensitive to cold" },
    ]);
    expect((screen.getByTestId("hyg-existing-tx-note-5001") as HTMLInputElement).value).toBe("sensitive to cold");
  });

  it("the note saves on blur, trimmed, and only when it changed", async () => {
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    const note = openNote(5001);
    expect(note.maxLength).toBe(500);
    fireEvent.change(note, { target: { value: "  sensitive to cold  " } });
    fireEvent.blur(note);
    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0].input.note).toBe("sensitive to cold");
    fireEvent.blur(note);
    expect(server.saves).toHaveLength(1);
  });
});

describe("once the visit is sent", () => {
  it("the server's frozen answer locks every chip", async () => {
    server.frozen = true;
    server.items = [
      item({
        disposition: {
          clinical: "no_change",
          patient: "declined",
          waitTimeframe: null,
          note: null,
          updatedBy: "hygienist@carein.ai",
          updatedAt: "2026-09-08T13:05:00.000Z",
        },
      }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-frozen");
    // RULING (compact round): a locked row still opens, to read; nothing in it is live.
    const row = await openRow(5001);
    for (const button of within(row).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(pressed("hyg-existing-tx-patient-5001-declined")).toBe("true");
    // RULING (compact round): the note is behind "+ note", which is locked too.
    expect((screen.getByTestId("hyg-existing-tx-add-note-5001") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("hyg-existing-tx-select-mode")).toBeNull();
  });

  it("a sent note on this page locks them without a re-read", async () => {
    server.staged = [stagedWrite("note", "Written")];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-frozen");
    await openRow(5001); // RULING (compact round): rows start collapsed
    expect((screen.getByTestId("hyg-existing-tx-patient-5001-declined") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Slice 2b: a sent TC handoff locks them too, and so does an amendment", async () => {
    for (const staged of [stagedWrite("tc-handoff", "Written"), stagedWrite("note", "Amending")]) {
      server.staged = [staged];
      renderVisit();
      await screen.findByTestId("hyg-existing-tx-frozen");
      await openRow(5001); // RULING (compact round): rows start collapsed
      expect((screen.getByTestId("hyg-existing-tx-patient-5001-declined") as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
  });

  it("a save the server refuses as frozen says why, and locks the section", async () => {
    server.saveRefusal = "EXISTING_TX_FROZEN";
    renderVisit();
    await openRow(5001); // RULING (compact round): rows start collapsed
    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-5001-declined"));
    const err = await screen.findByTestId("hyg-existing-tx-error-5001");
    expect(err.textContent).toContain("can no longer be changed");
    await screen.findByTestId("hyg-existing-tx-frozen");
    // Not shown as picked: the server never stored it.
    expect(pressed("hyg-existing-tx-patient-5001-declined")).toBe("false");
  });
});

describe("at Send", () => {
  it("reminds about items not discussed, and Send stays available", async () => {
    server.staged = [stagedWrite("note", "Staged")];
    server.items = [
      item({ procNum: 5001 }),
      item({ procNum: 5002 }),
      item({
        procNum: 5003,
        disposition: {
          clinical: null,
          patient: "ready_to_schedule",
          waitTimeframe: null,
          note: null,
          updatedBy: "hygienist@carein.ai",
          updatedAt: "2026-09-08T13:05:00.000Z",
        },
      }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-proc-5001"); // RULING (compact round): rows start collapsed
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    const reminder = await screen.findByTestId("hyg-confirm-existing-not-discussed");
    expect(reminder.textContent).toContain("2 existing items not discussed");
    expect((screen.getByTestId("hyg-confirm-send-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing when every item was discussed", async () => {
    server.staged = [stagedWrite("note", "Staged")];
    server.items = [];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-none");
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    await screen.findByTestId("hyg-confirm-send-body");
    expect(screen.queryByTestId("hyg-confirm-existing-not-discussed")).toBeNull();
  });
});

describe("the words", () => {
  it("dates are read from the digits, not a device zone", () => {
    expect(formatPlainDate("2026-01-05")).toBe("5 Jan 2026");
    expect(formatPlainDate("not a date")).toBe("not a date");
  });
  it("a last-discussed line without a timeframe has no brackets", () => {
    expect(
      lastDiscussedLine({ visitDate: "2026-03-02", patient: "cost_questions", waitTimeframe: null, clinical: null }),
    ).toBe("Last discussed 2 Mar 2026: Cost questions");
  });
});
