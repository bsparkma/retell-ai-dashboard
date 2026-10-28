/**
 * EXISTING TREATMENT — the compact round, on screen.
 *
 *   1. One collapsed row per tooth set, tooth order, whole mouth last; a row's
 *      summary is "Urgent · Wait 3 mo" or a dashed "Not discussed".
 *   2. The default view: the last 24 months, plus Watch, urgent or answered;
 *      older behind "Show N older items (planned before …)"; scheduled behind
 *      "Already scheduled (N)". Collapsed on its own above 8 items.
 *   3. A group's answer applies to every procedure in it (one bulk save);
 *      "Answer separately" splits it; one row open at a time.
 *   4. Select → tick rows → one patient answer (and optional clinical) to all,
 *      through the bulk route; each row keeps its own clinical answer otherwise.
 *   5. "#30 already has planned in Open Dental: …" while #30 is picked — a hint
 *      that never blocks the add.
 *   6. The tray: a staged note the SERVER calls out of date says "Out of date —
 *      answers changed. Stage again", its old words are marked, Send waits; the
 *      flag arrives in the save's own response; staging again clears it.
 *
 * NO NETWORK, NO BACKEND, NO PHI: a synthetic plan, no patient name at all.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygAppointment, StagedWrite } from "@shared/hyg/contract";
import type {
  ExistingTxBatchEntry,
  ExistingTxDisposition,
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
  staged: [] as StagedWrite[],
  items: [] as ExistingTxItem[],
  saves: [] as Array<{ procNum: number; input: ExistingTxDispositionInput }>,
  batches: [] as ExistingTxBatchEntry[][],
  stages: [] as string[],
  /** What the next answer save says about the staged writes afterwards. */
  staleAfterSave: [] as string[],
  adds: 0,
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

function item(procNum: number, over: Partial<ExistingTxItem> = {}): ExistingTxItem {
  return {
    procNum,
    code: "D2391",
    description: "Resin-based composite - one surface, posterior",
    tooth: "30",
    surface: "O",
    dateTp: "2026-05-01",
    priorityName: null,
    watch: false,
    scheduled: false,
    disposition: null,
    lastDiscussed: null,
    ...over,
  };
}

function answered(over: Partial<ExistingTxDisposition>): ExistingTxDisposition {
  return {
    clinical: null,
    patient: "not_discussed",
    waitTimeframe: null,
    note: null,
    updatedBy: "hygienist@carein.ai",
    updatedAt: "2026-09-08T13:05:00.000Z",
    ...over,
  };
}

function stagedWrite(kind: StagedWrite["kind"], over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: `staged-${kind}`,
    kind,
    state: "Staged",
    title: "Visit note",
    summary: "The note for 2026-09-08",
    preview: ["Existing treatment reviewed (1):", "  #30 D2391 Composite -- not discussed with the patient."],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
    existingTxStale: false,
    ...over,
  };
}

const stagedAfter = () =>
  server.staged.map((w) => ({ ...w, existingTxStale: server.staleAfterSave.includes(w.kind) }));

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
    doctorOptions: ["Beau Sparkman"],
  });
  const disposition = (input: ExistingTxDispositionInput) => ({
    ...input,
    updatedBy: "hygienist@carein.ai",
    updatedAt: "2026-09-08T13:05:00.000Z",
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
      doctorOptions: ["Beau Sparkman"],
    })),
    openVisit: vi.fn(async () => mutation()),
    addTreatmentItem: vi.fn(async () => {
      server.adds += 1;
      return mutation();
    }),
    stageWrite: vi.fn(async (_o: string, _a: number, kind: string) => {
      server.stages.push(kind);
      // A fresh stage is current by construction.
      server.staged = server.staged.map((w) => (w.kind === kind ? { ...w, existingTxStale: false } : w));
      return mutation();
    }),
    fetchExistingTx: vi.fn(
      async (): Promise<ExistingTxResponse> => ({
        success: true,
        office: "roland",
        aptNum: 900001,
        frozen: false,
        readAt: "2026-09-08T13:00:00.000Z",
        items: server.items,
      }),
    ),
    saveExistingTxDisposition: vi.fn(
      async (_o: string, _a: number, procNum: number, input: ExistingTxDispositionInput) => {
        server.saves.push({ procNum, input });
        server.staged = stagedAfter();
        return {
          success: true as const,
          office: "roland" as const,
          aptNum: 900001,
          procNum,
          disposition: disposition(input),
          stagedWrites: server.staged,
        };
      },
    ),
    saveExistingTxBatch: vi.fn(async (_o: string, _a: number, items: ExistingTxBatchEntry[]) => {
      server.batches.push(items);
      server.staged = stagedAfter();
      return {
        success: true as const,
        office: "roland" as const,
        aptNum: 900001,
        items: items.map(({ procNum, ...input }) => ({ procNum, disposition: disposition(input) })),
        stagedWrites: server.staged,
      };
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  answerWords,
  groupExistingTx,
  recentCutoff,
  splitExistingTx,
} from "@/features/hyg/visit/ExistingTreatment";

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

/**
 * THE 30-ITEM SYNTHETIC PLAN the report's screenshots use: 18 recent items on
 * 12 teeth (a crown/build-up/post on #30, quadrant SRP, a whole-mouth item),
 * 2 on Watch, 2 already answered (one urgent), 3 already scheduled, and 7
 * planned more than 24 months before the visit.
 */
export function thirtyItemPlan(): ExistingTxItem[] {
  const out: ExistingTxItem[] = [];
  let n = 7001;
  const add = (over: Partial<ExistingTxItem>) => out.push(item(n++, over));
  add({ tooth: "30", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2026-06-20", disposition: answered({ clinical: "worse_urgent", patient: "wants_to_wait", waitTimeframe: "3_months" }) });
  add({ tooth: "30", code: "D2950", description: "Core buildup, including any pins", surface: "", dateTp: "2026-06-20", disposition: answered({ clinical: "worse_urgent", patient: "wants_to_wait", waitTimeframe: "3_months" }) });
  add({ tooth: "30", code: "D2954", description: "Prefabricated post and core", surface: "", dateTp: "2026-06-20" });
  add({ tooth: "3", code: "D2391", surface: "O", dateTp: "2026-02-11" });
  add({ tooth: "14", code: "D2392", description: "Resin-based composite - two surfaces, posterior", surface: "MO", dateTp: "2025-11-03" });
  add({ tooth: "19", code: "D3330", description: "Endodontic therapy, molar tooth", surface: "", dateTp: "2025-09-14" });
  add({ tooth: "19", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2025-09-14" });
  add({ tooth: "8", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "M", dateTp: "2026-01-20" });
  add({ tooth: "9", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "D", dateTp: "2026-01-20" });
  add({ tooth: "2", code: "D2393", description: "Resin-based composite - three surfaces, posterior", surface: "MOD", dateTp: "2025-04-02" });
  add({ tooth: "31", code: "D2391", surface: "O", dateTp: "2025-12-01", watch: true, priorityName: "Watch" });
  add({ tooth: "18", code: "D2391", surface: "O", dateTp: "2026-03-09", watch: true, priorityName: "Watch" });
  add({ tooth: "", code: "D4341", description: "Periodontal scaling and root planing - four or more teeth per quadrant", surface: "UR", dateTp: "2026-04-18" });
  add({ tooth: "", code: "D4341", description: "Periodontal scaling and root planing - four or more teeth per quadrant", surface: "UL", dateTp: "2026-04-18" });
  add({ tooth: "", code: "D9944", description: "Occlusal guard - hard appliance, full arch", surface: "", dateTp: "2025-10-10" });
  add({ tooth: "12", code: "D2391", surface: "O", dateTp: "2025-07-07" });
  add({ tooth: "13", code: "D2391", surface: "O", dateTp: "2025-07-07" });
  add({ tooth: "20", code: "D2391", surface: "O", dateTp: "2026-08-01" });
  // Already scheduled.
  add({ tooth: "15", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2026-05-05", scheduled: true });
  add({ tooth: "15", code: "D2950", description: "Core buildup, including any pins", surface: "", dateTp: "2026-05-05", scheduled: true });
  add({ tooth: "4", code: "D2391", surface: "O", dateTp: "2026-05-05", scheduled: true });
  // Older than 24 months; one of them answered, so it stays in view.
  add({ tooth: "29", code: "D2391", surface: "O", dateTp: "2023-03-01" });
  add({ tooth: "28", code: "D2391", surface: "O", dateTp: "2022-11-15" });
  add({ tooth: "21", code: "D2391", surface: "O", dateTp: "2021-06-30" });
  add({ tooth: "5", code: "D2391", surface: "O", dateTp: "2023-08-08" });
  add({ tooth: "6", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2020-02-02" });
  add({ tooth: "7", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2020-02-02" });
  add({ tooth: "10", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2023-01-01" });
  add({ tooth: "11", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2022-04-04" });
  add({ tooth: "3", code: "D1354", description: "Interim caries arresting medicament", surface: "", dateTp: "2022-02-02", disposition: answered({ patient: "declined" }) });
  return out;
}

beforeEach(() => {
  server.staged = [];
  server.items = [item(5001)];
  server.saves = [];
  server.batches = [];
  server.stages = [];
  server.staleAfterSave = [];
  server.adds = 0;
});
afterEach(cleanup);

const pressed = (id: string) => screen.getByTestId(id).getAttribute("aria-pressed");

describe("pure: grouping and the default view", () => {
  it("groups by tooth set in tooth order, areas after, the whole mouth last", () => {
    const groups = groupExistingTx([
      item(1, { tooth: "30" }),
      item(2, { tooth: "", surface: "" }),
      item(3, { tooth: "3" }),
      item(4, { tooth: "30" }),
      item(5, { tooth: "", surface: "UR" }),
      item(6, { tooth: "A" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["#3", "#30", "#A", "UR", "Whole mouth"]);
    expect(groups.find((g) => g.label === "#30")?.items.map((i) => i.procNum)).toEqual([1, 4]);
  });

  it("the last 24 months, plus Watch, urgent and answered; scheduled apart; no date is shown", () => {
    expect(recentCutoff("2026-09-08")).toBe("2024-09-08");
    const split = splitExistingTx(
      [
        item(1, { dateTp: "2025-01-01" }),
        item(2, { dateTp: "2023-01-01" }),
        item(3, { dateTp: "2023-01-01", watch: true }),
        item(4, { dateTp: "2023-01-01", disposition: answered({ clinical: "worse_urgent" }) }),
        item(5, { dateTp: "2023-01-01", disposition: answered({ patient: "declined" }) }),
        item(6, { dateTp: "2023-01-01", disposition: answered({}) }),
        item(7, { dateTp: null }),
        item(8, { dateTp: "2026-01-01", scheduled: true }),
      ],
      "2026-09-08",
    );
    expect(split.main.map((i) => i.procNum)).toEqual([1, 3, 4, 5, 7]);
    // "Not discussed" saved is not an answer: it can still wait behind "older".
    expect(split.older.map((i) => i.procNum)).toEqual([2, 6]);
    expect(split.scheduled.map((i) => i.procNum)).toEqual([8]);
  });

  it("a row's words", () => {
    expect(answerWords({ clinical: "worse_urgent", patient: "wants_to_wait", waitTimeframe: "3_months", note: null })).toEqual(["Wait 3 mo"]);
    expect(answerWords({ clinical: "no_change", patient: "declined", waitTimeframe: null, note: null })).toEqual(["No change", "Declined"]);
    expect(answerWords({ clinical: null, patient: "not_discussed", waitTimeframe: null, note: null })).toEqual([]);
  });
});

describe("the 30-item plan", () => {
  it("starts collapsed, counts everything, and opens to the default view", async () => {
    server.items = thirtyItemPlan();
    renderVisit();
    const heading = await screen.findByTestId("hyg-existing-tx-heading");
    expect(heading.textContent).toBe("Existing treatment (30) · 3 answered · 2 urgent");
    expect(screen.getByTestId("hyg-existing-tx-collapse").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("hyg-existing-tx-list")).toBeNull();

    fireEvent.click(screen.getByTestId("hyg-existing-tx-collapse"));
    const list = screen.getByTestId("hyg-existing-tx-list");
    // #30's three procedures are ONE row; its summary is the shared answer.
    const thirty = within(list).getByTestId("hyg-existing-tx-group-30");
    expect(within(thirty).getAllByTestId(/^hyg-existing-tx-proc-/)).toHaveLength(3);
    expect(within(thirty).getByTestId("hyg-existing-tx-summary-30").textContent).toContain("Answers differ");
    // Older than 24 months and unanswered: behind one button, with the date.
    expect(screen.getByTestId("hyg-existing-tx-show-older").textContent).toBe(
      "Show 8 older items (planned before 8 Sep 2024)",
    );
    expect(screen.getByTestId("hyg-existing-tx-show-scheduled").textContent).toContain("Already scheduled (3)");
    // The answered old item stays in view; the whole mouth is the last row.
    const rows = within(list).getAllByTestId(/^hyg-existing-tx-group-/).map((r) => r.dataset.testid);
    expect(rows).toContain("hyg-existing-tx-group-3");
    expect(rows[rows.length - 1]).toBe("hyg-existing-tx-group-mouth");
    expect(rows).not.toContain("hyg-existing-tx-group-29");
    // Watch is a badge.
    expect(screen.getByTestId("hyg-existing-tx-gwatch-31").textContent).toBe("Watch");

    fireEvent.click(screen.getByTestId("hyg-existing-tx-show-older"));
    expect(screen.getByTestId("hyg-existing-tx-group-older-29")).toBeTruthy();
  });

  it("8 items or fewer open by themselves", async () => {
    server.items = [item(1), item(2, { tooth: "3" })];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-list");
    expect(screen.getByTestId("hyg-existing-tx-collapse").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("answering a group", () => {
  beforeEach(() => {
    server.items = [
      item(6001, { code: "D2740", description: "Crown - porcelain/ceramic", surface: "" }),
      item(6002, { code: "D2950", description: "Core buildup", surface: "" }),
      item(6003, { tooth: "3" }),
    ];
  });

  it("one tap answers every procedure on the tooth, through ONE bulk save", async () => {
    renderVisit();
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-toggle-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-gpatient-30-wants_to_wait"));
    await waitFor(() => expect(server.batches).toHaveLength(1));
    expect(server.batches[0].map((e) => e.procNum)).toEqual([6001, 6002]);
    expect(server.batches[0].every((e) => e.patient === "wants_to_wait")).toBe(true);
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-gwait-30-3_months"));
    await waitFor(() => expect(server.batches).toHaveLength(2));
    expect(server.batches[1].every((e) => e.waitTimeframe === "3_months" && e.patient === "wants_to_wait")).toBe(true);
    fireEvent.click(screen.getByTestId("hyg-existing-tx-gclinical-30-worse_urgent"));
    await waitFor(() => expect(screen.getByTestId("hyg-existing-tx-summary-30").textContent).toContain("Wait 3 mo"));
    expect(screen.getByTestId("hyg-existing-tx-summary-30-urgent").textContent).toBe("Urgent");
    expect(server.saves).toEqual([]);
  });

  it("Answer separately splits it per procedure; one row open at a time", async () => {
    renderVisit();
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-toggle-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-separate-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-6002-declined"));
    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual({
      procNum: 6002,
      input: { clinical: null, patient: "declined", waitTimeframe: null, note: null },
    });
    await waitFor(() => expect(screen.getByTestId("hyg-existing-tx-summary-30").textContent).toContain("1 of 2 answered"));

    // Opening #3 closes #30.
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-3"));
    expect(screen.getByTestId("hyg-existing-tx-toggle-30").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("hyg-existing-tx-editor-30")).toBeNull();
    expect(screen.getByTestId("hyg-existing-tx-editor-3")).toBeTruthy();
  });

  it("the patient question comes first; chips are text-sm and 44px", async () => {
    renderVisit();
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-toggle-3"));
    const editor = screen.getByTestId("hyg-existing-tx-editor-3");
    const text = editor.textContent ?? "";
    expect(text.indexOf("What did the patient say?")).toBeLessThan(text.indexOf("Anything changed clinically?"));
    const chip = screen.getByTestId("hyg-existing-tx-patient-6003-declined");
    expect(chip.className).toContain("text-sm");
    expect(chip.className).toContain("min-h-11");
    for (const button of within(screen.getByTestId("hyg-existing-tx-group-3")).getAllByRole("button")) {
      expect(button.querySelector("button, a, input, textarea, select")).toBeNull();
    }
  });
});

describe("Select", () => {
  it("ticks rows and applies one answer to all of them, keeping each row's own clinical answer", async () => {
    server.items = [
      item(6001, { surface: "" }),
      item(6002, { surface: "", disposition: answered({ clinical: "no_change" }) }),
      item(6003, { tooth: "3" }),
      item(6004, { tooth: "14" }),
    ];
    renderVisit();
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-select-mode"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-3"));
    expect(pressed("hyg-existing-tx-toggle-30")).toBe("true");
    expect(pressed("hyg-existing-tx-toggle-14")).toBe("false");
    // Nothing opens while selecting.
    expect(screen.queryByTestId("hyg-existing-tx-editor-30")).toBeNull();
    const apply = screen.getByTestId("hyg-existing-tx-bulk-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true); // no answer picked yet
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-patient-ready_to_schedule"));
    expect(apply.textContent).toBe("Apply to 2 rows");
    fireEvent.click(apply);
    await waitFor(() => expect(server.batches).toHaveLength(1));
    // In the order the rows are drawn (#3 before #30); compared as a set.
    expect([...server.batches[0]].sort((a, b) => a.procNum - b.procNum)).toEqual([
      { procNum: 6001, clinical: null, patient: "ready_to_schedule", waitTimeframe: null, note: null },
      { procNum: 6002, clinical: "no_change", patient: "ready_to_schedule", waitTimeframe: null, note: null },
      { procNum: 6003, clinical: null, patient: "ready_to_schedule", waitTimeframe: null, note: null },
    ]);
    expect(screen.queryByTestId("hyg-existing-tx-bulk")).toBeNull();
  });

  it("an optional clinical answer goes to all of them too", async () => {
    server.items = [item(6001), item(6003, { tooth: "3" })];
    renderVisit();
    fireEvent.click(await screen.findByTestId("hyg-existing-tx-select-mode"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-3"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-patient-wants_to_wait"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-wait-6_months"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-clinical-re_evaluate"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-apply"));
    await waitFor(() => expect(server.batches).toHaveLength(1));
    expect(
      server.batches[0].every(
        (e) => e.clinical === "re_evaluate" && e.patient === "wants_to_wait" && e.waitTimeframe === "6_months",
      ),
    ).toBe(true);
  });
});

describe("Treatment identified today: already planned in Open Dental", () => {
  it("names what #30 already has, and never blocks the add", async () => {
    server.items = [
      item(6001, { code: "D2740", description: "Crown - porcelain/ceramic", surface: "" }),
      item(6002, { code: "D2950", description: "Core buildup, including any pins", surface: "" }),
      item(6003, { tooth: "3" }),
    ];
    renderVisit();
    await screen.findByTestId("hyg-existing-tx-proc-6001");
    expect(screen.queryByTestId("hyg-od-planned-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    expect(screen.getByTestId("hyg-od-planned-hint-30").textContent).toBe(
      "#30 already has planned in Open Dental: Crown (D2740), Core buildup (D2950)",
    );
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.adds).toBe(1));
  });
});

describe("the tray: out of date, by the server's word", () => {
  it("the save's own response marks the note out of date: banner, marked words, Send waits", async () => {
    server.staged = [stagedWrite("note")];
    server.staleAfterSave = ["note"];
    renderVisit();
    await screen.findByTestId("hyg-staged-note");
    expect(screen.queryByTestId("hyg-stale-note")).toBeNull();
    expect((screen.getByTestId("hyg-send-all") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(await screen.findByTestId("hyg-existing-tx-toggle-30"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-patient-5001-wants_to_wait"));

    const banner = await screen.findByTestId("hyg-stale-note");
    expect(banner.textContent).toContain("Out of date — answers changed. Stage again");
    expect(screen.getByTestId("hyg-staged-preview-stale-note").textContent).toBe("Out of date — not what will be sent");
    expect(screen.getByTestId("hyg-staged-preview-note").className).toContain("line-through");
    expect((screen.getByTestId("hyg-send-all") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("hyg-send-all-reason").textContent).toContain("Stage the visit note again first");

    // Staging again clears it.
    fireEvent.click(screen.getByTestId("hyg-restage-note"));
    await waitFor(() => expect(screen.queryByTestId("hyg-stale-note")).toBeNull());
    expect(server.stages).toEqual(["note"]);
    expect(screen.getByTestId("hyg-staged-preview-note").className).not.toContain("line-through");
    expect((screen.getByTestId("hyg-send-all") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a stale flag on the visit GET shows on first paint; a handoff is never marked", async () => {
    server.staged = [stagedWrite("note", { existingTxStale: true }), stagedWrite("tc-handoff")];
    renderVisit();
    expect((await screen.findByTestId("hyg-stale-note")).textContent).toContain("Stage again");
    expect(screen.queryByTestId("hyg-stale-tc-handoff")).toBeNull();
  });

  it("a Failed note out of date says Retry first — it cannot be re-staged from Failed", async () => {
    server.staged = [stagedWrite("note", { state: "Failed", errorMessage: "Open Dental refused it", existingTxStale: true })];
    renderVisit();
    const banner = await screen.findByTestId("hyg-stale-note");
    expect(banner.textContent).toContain("Retry, then stage again");
    expect(screen.queryByTestId("hyg-restage-note")).toBeNull();
    expect(screen.getByTestId("hyg-retry-note")).toBeTruthy();
  });
});
