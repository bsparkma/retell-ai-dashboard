/**
 * CO-4b — the Pipeline's Open Dental sync, in jsdom.
 *
 *  - the strip: the last run's time and what it did ("3 completed, 1 moved,
 *    2 flagged"), "N scheduled cases can't be tracked (no appointment linked)",
 *    each standing change with "Moved by Open Dental sync" and Undo, the flags
 *  - Sync now starts a run, the strip polls while it runs, and the board is
 *    re-read when it finishes; a rate-limited office cannot press it
 *  - a failed last run says nothing was changed; an office with the sync off
 *    and nothing standing renders nothing
 *  - the card: the badge with Undo, or "Open Dental no longer matches — check";
 *    an old card with no `odSync` shows neither
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co4b-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, api } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  api: { getOdSyncStatus: vi.fn(), startOdSync: vi.fn(), undoOdSync: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/odSync/odSyncApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/tc/odSync/odSyncApi")>()),
  ...api,
}));

import { OdSyncPanel } from "@/features/tc/odSync/OdSyncPanel";
import { odSyncSummaryText, type OdSyncStatus, type OdSyncSummary } from "@/features/tc/odSync/odSyncApi";
import { CaseCardBody } from "@/features/tc/cases/CaseCard";
import { TcApiError, type TcCaseSummary } from "@/features/tc/api";

const C1 = "6f9619ff-8b86-4d01-b42d-00cf4fc96401";
const C2 = "6f9619ff-8b86-4d01-b42d-00cf4fc96402";
const C3 = "6f9619ff-8b86-4d01-b42d-00cf4fc96403";

function summary(over: Partial<OdSyncSummary> = {}): OdSyncSummary {
  return {
    checked: 12, completed: 3, unscheduled: 1, rescheduled: 0, flagged: 2, unchanged: 6,
    heldByUndo: 0, raced: 0, unanchored: 2, tracked: 12, deferred: 0, ...over,
  };
}

function status(over: Partial<OdSyncStatus> = {}): OdSyncStatus {
  return {
    success: true,
    office: "roland",
    enabled: true,
    running: false,
    lastRun: {
      runId: "r1", trigger: "nightly", requestedBy: null,
      startedAt: "2026-10-30T07:30:00.000Z", finishedAt: "2026-10-30T07:34:10.000Z",
      status: "ok", summary: summary(), errorCode: null,
    },
    nextAllowedAt: null,
    unanchoredCount: 2,
    changes: [
      {
        caseId: C1, patientName: "Kiwi, Sam", status: "completed",
        action: { kind: "completed", at: "2026-10-30T07:31:00.000Z", aptNum: 5001, fromStatus: "scheduled", toStatus: "completed", fromDateTime: "2026-10-29 09:00:00", toDateTime: "2026-10-29 09:00:00" },
      },
      {
        caseId: C2, patientName: "Lime, Pat", status: "pending_pt",
        action: { kind: "unscheduled", at: "2026-10-30T07:32:00.000Z", aptNum: 5002, fromStatus: "scheduled", toStatus: "pending_pt", fromDateTime: "2026-11-02 10:00:00", toDateTime: "2026-11-02 10:00:00" },
      },
    ],
    flagged: [
      { caseId: C3, patientName: "Fig, Alex", status: "scheduled", flag: { reason: "missing", at: "2026-10-30T07:33:00.000Z", aptStatus: null } },
    ],
    ...over,
  };
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mountPanel(onCasesChanged = vi.fn()) {
  render(<OdSyncPanel office="roland" onCasesChanged={onCasesChanged} />);
  return onCasesChanged;
}

describe("the Pipeline's Open Dental sync strip", () => {
  it("shows the last run, the untracked count, the standing changes with Undo, and the flags", async () => {
    api.getOdSyncStatus.mockResolvedValue(status());
    mountPanel();
    const last = await screen.findByTestId("od-sync-last-run-roland");
    expect(last.textContent).toMatch(/\(nightly\): 3 completed, 1 moved, 2 flagged$/);
    expect(screen.getByTestId("od-sync-unanchored-roland").textContent).toBe(
      "2 scheduled cases can't be tracked (no appointment linked)",
    );
    const changes = screen.getByTestId("od-sync-changes-roland");
    expect(changes.textContent).toContain("Moved by Open Dental sync");
    expect(changes.textContent).toContain("Completed in Open Dental");
    expect(changes.textContent).toContain("moved to Pending Patient");
    expect(screen.getAllByTestId("od-sync-undo")).toHaveLength(2);
    expect(screen.getByTestId("od-sync-flagged-roland").textContent).toContain(
      "Open Dental no longer matches — check: the appointment is gone from Open Dental",
    );
  });

  it("Sync now starts a run, polls while it runs, and re-reads the board when it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getOdSyncStatus
      .mockResolvedValueOnce(status({ changes: [], flagged: [] }))
      .mockResolvedValueOnce(status({ running: true, changes: [], flagged: [] }))
      .mockResolvedValue(status());
    api.startOdSync.mockResolvedValue("r2");
    const changed = mountPanel();
    fireEvent.click(await screen.findByTestId("od-sync-now-roland"));
    await waitFor(() => expect(api.startOdSync).toHaveBeenCalledWith("roland"));
    await screen.findByText("Syncing with Open Dental…");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("od-sync-last-run-roland").textContent).toContain("3 completed");
  });

  it("a rate-limited office cannot press Sync now, and a refusal is said", async () => {
    api.getOdSyncStatus.mockResolvedValue(status({ nextAllowedAt: "2026-10-30T15:05:00.000Z" }));
    mountPanel();
    const btn = (await screen.findByTestId("od-sync-now-roland")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    cleanup();

    api.getOdSyncStatus.mockResolvedValue(status());
    api.startOdSync.mockRejectedValue(
      new TcApiError("Sync now can run once every 5 minutes per office", 429, "OD_SYNC_RATE_LIMITED", null, []),
    );
    mountPanel();
    fireEvent.click(await screen.findByTestId("od-sync-now-roland"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Sync now can run once every 5 minutes per office"));
  });

  it("Undo calls the server for that case and re-reads the board", async () => {
    api.getOdSyncStatus.mockResolvedValue(status());
    api.undoOdSync.mockResolvedValue(undefined);
    const changed = mountPanel();
    fireEvent.click((await screen.findAllByTestId("od-sync-undo"))[0]!);
    await waitFor(() => expect(api.undoOdSync).toHaveBeenCalledWith("roland", C1));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("a failed last run says nothing was changed", async () => {
    api.getOdSyncStatus.mockResolvedValue(
      status({
        lastRun: { runId: "r3", trigger: "manual", requestedBy: "tc@carein.ai", startedAt: "2026-10-30T15:00:00.000Z", finishedAt: "2026-10-30T15:00:04.000Z", status: "failed", summary: null, errorCode: "OD_UNAVAILABLE" },
        changes: [],
        flagged: [],
      }),
    );
    mountPanel();
    expect((await screen.findByTestId("od-sync-last-run-roland")).textContent).toMatch(
      /couldn't reach Open Dental — nothing was changed\.$/,
    );
  });

  it("sync off with nothing standing renders nothing; sync off with a standing change still offers Undo", async () => {
    api.getOdSyncStatus.mockResolvedValue(status({ enabled: false, changes: [], flagged: [] }));
    const { container } = render(<OdSyncPanel office="roland" onCasesChanged={vi.fn()} />);
    await waitFor(() => expect(api.getOdSyncStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
    cleanup();

    api.getOdSyncStatus.mockResolvedValue(status({ enabled: false }));
    mountPanel();
    expect(await screen.findAllByTestId("od-sync-undo")).toHaveLength(2);
    expect(screen.queryByTestId("od-sync-now-roland")).toBeNull();
  });

  it("REVIEW: a failed read during a run does not stop the polling, and the failure is said", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getOdSyncStatus
      .mockResolvedValueOnce(status({ running: true, changes: [], flagged: [] }))
      .mockRejectedValueOnce(new TcApiError("Network blip", 0, null, null, []))
      .mockResolvedValue(status());
    const changed = mountPanel();
    await screen.findByText("Syncing with Open Dental…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect((await screen.findByTestId("od-sync-error-roland")).textContent).toContain("Network blip");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(api.getOdSyncStatus).toHaveBeenCalledTimes(3);
    // The later success clears the error.
    expect(screen.queryByTestId("od-sync-error-roland")).toBeNull();
  });

  it("REVIEW: with the sync off, open flags are still shown", async () => {
    api.getOdSyncStatus.mockResolvedValue(status({ enabled: false, changes: [] }));
    mountPanel();
    expect((await screen.findByTestId("od-sync-flagged-roland")).textContent).toContain("Open Dental no longer matches");
  });

  it("summary words", () => {
    expect(odSyncSummaryText(summary())).toBe("3 completed, 1 moved, 2 flagged");
    expect(odSyncSummaryText(summary({ completed: 0, unscheduled: 0, flagged: 0, rescheduled: 2 }))).toBe("2 rescheduled");
    expect(odSyncSummaryText(summary({ completed: 0, unscheduled: 0, flagged: 0 }))).toBe("no changes");
  });
});

// ── the card ────────────────────────────────────────────────────────────────

function caseRow(over: Partial<TcCaseSummary> = {}): TcCaseSummary {
  return {
    caseId: C2, legacyId: null, officeId: "roland", patientName: "Lime, Pat", patientAge: null, odPatientId: 12827,
    phone: null, email: null, caseType: "Checkout", category: "single_tooth", status: "pending_pt", urgency: "medium",
    doctorName: "", diagnosingProvider: null, assignedTc: "desk@carein.ai", caseValueCents: 0, readinessScore: 0,
    financingStatus: "", preferredFinancingProvider: null, decisionMakers: "", financialSituation: [], keyMotivators: [],
    contactPreference: null, bestTimeToReach: "", notes: "", referralSource: "hygiene", lostReason: null,
    diagnosedDate: null, statusChangedAt: "2026-10-30T07:32:00.000Z", nurtureCadence: "standard", inLongTailMode: false,
    nurtureEnrolledAt: null, nurturePhaseChangedAt: null, nurturePhase1DaysOverride: null, nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false, createdAt: "2026-10-29T15:00:00.000Z", updatedAt: "2026-10-30T07:32:00.000Z",
    ...over,
  } as TcCaseSummary;
}

const ACTION = status().changes[1]!.action;

function card(row: TcCaseSummary, onUndone = vi.fn()) {
  render(
    <div className="w-[266px] rounded-xl border border-border bg-card p-3">
      <CaseCardBody caseRow={row} onMove={() => undefined} onOdSyncUndone={onUndone} />
    </div>,
  );
  return onUndone;
}

describe("the pipeline card", () => {
  it("a standing change shows the badge with Undo, and Undo re-reads the board", async () => {
    api.undoOdSync.mockResolvedValue(undefined);
    const undone = card(caseRow({ odSync: { action: ACTION, flag: null } }));
    expect(screen.getByTestId("od-sync-card-badge").textContent).toContain("Moved by Open Dental sync");
    fireEvent.click(screen.getByTestId("od-sync-card-undo"));
    await waitFor(() => expect(api.undoOdSync).toHaveBeenCalledWith("roland", C2));
    await waitFor(() => expect(undone).toHaveBeenCalled());
  });

  it("a flag says Open Dental no longer matches", () => {
    card(caseRow({ status: "scheduled", odSync: { action: null, flag: { reason: "status", at: "2026-10-30T07:33:00.000Z", aptStatus: "Planned" } } }));
    expect(screen.getByTestId("od-sync-card-flag").textContent).toContain("Open Dental no longer matches — check");
    expect(screen.queryByTestId("od-sync-card-undo")).toBeNull();
  });

  it("an old card with no odSync field shows neither", () => {
    card(caseRow({ status: "scheduled" }));
    expect(screen.queryByTestId("od-sync-card-badge")).toBeNull();
    expect(screen.queryByTestId("od-sync-card-flag")).toBeNull();
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-4b screenshot dumps", () => {
  it("co4b-01 — the Pipeline's sync strip after a nightly run", async () => {
    api.getOdSyncStatus.mockResolvedValue(status());
    render(
      <div className="p-6">
        <OdSyncPanel office="roland" onCasesChanged={vi.fn()} />
      </div>,
    );
    await screen.findByTestId("od-sync-changes-roland");
    dump("tccheckout-co4b-01-sync-strip@1280x900");
  });

  it("co4b-02 — cards: moved by the sync (with Undo), flagged, and untouched", () => {
    render(
      <div className="flex gap-4 p-6">
        {[
          caseRow({ odSync: { action: ACTION, flag: null } }),
          caseRow({ caseId: C3, patientName: "Fig, Alex", status: "scheduled", odSync: { action: null, flag: { reason: "missing", at: "2026-10-30T07:33:00.000Z", aptStatus: null } } }),
          caseRow({ caseId: C1, patientName: "Kiwi, Sam", status: "scheduled" }),
        ].map((row) => (
          <div key={row.caseId} className="w-[266px] rounded-xl border border-border bg-card p-3">
            <CaseCardBody caseRow={row} onMove={() => undefined} />
          </div>
        ))}
      </div>,
    );
    dump("tccheckout-co4b-02-cards@1280x900");
  });

  it("co4b-03 — a run that could not reach Open Dental", async () => {
    api.getOdSyncStatus.mockResolvedValue(
      status({
        lastRun: { runId: "r3", trigger: "manual", requestedBy: "tc@carein.ai", startedAt: "2026-10-30T15:00:00.000Z", finishedAt: "2026-10-30T15:00:04.000Z", status: "failed", summary: null, errorCode: "OD_UNAVAILABLE" },
        nextAllowedAt: "2026-10-30T15:05:00.000Z",
        changes: [],
      }),
    );
    render(
      <div className="p-6">
        <OdSyncPanel office="roland" onCasesChanged={vi.fn()} />
      </div>,
    );
    await screen.findByTestId("od-sync-flagged-roland");
    dump("tccheckout-co4b-03-run-failed@1280x900");
  });
});
