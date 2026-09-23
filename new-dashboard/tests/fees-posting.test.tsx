/**
 * The posting surface: decisions, the confirm, progress, and rollback.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS DEFEND
 * ═════════════════════════════════════════════════════════════════════════════
 * Three things this screen must never say wrongly, because each one leads
 * somebody to act on a false belief about a live practice's database:
 *
 *  1. `post_failed` SHOWS HOW MANY FEES WERE ALREADY WRITTEN. A run that died
 *     at row 300 of 500 put 299 fees in. A screen that says only "failed" is
 *     how somebody concludes nothing happened and posts again.
 *  2. THE PREVIEW-ONLY BANNER DISAPPEARS ONCE ANYTHING HAS BEEN POSTED —
 *     including after a partial failure. Slice 2 promised this banner would be
 *     the first thing to change when posting landed.
 *  3. ROLLING BACK A NEW SCHEDULE CANNOT DELETE IT, and the confirm says so
 *     BEFORE the click. Open Dental has no DELETE for /feescheds.
 *
 * Plus the gate: a disabled Post button states its reason, and the reason comes
 * from the server's own counts rather than from anything this page invented.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Fee schedules carry procedure codes and money
 * and never a patient.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

type Warning = { code: string; message: string };

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

function batch(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "northstar-2027.pdf",
    fileSha256: "a".repeat(64),
    fileSizeBytes: 240_000,
    sourceType: "pdf",
    status: "parsed",
    rowCount: 2,
    warningCount: 1,
    warnings: [] as Warning[],
    failureReason: null,
    failureCode: null,
    createdBy: "manager@carein.ai",
    createdAt: "2026-09-20T14:30:00.000Z",
    updatedAt: "2026-09-20T14:30:00.000Z",
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    rowId: "aaaaaaaa-0000-4000-8000-000000000001",
    procCode: "D1110",
    feeCents: 9200,
    rawLine: "D1110   Prophylaxis - adult    92.00",
    warnings: [] as Warning[],
    rowOrder: 0,
    decision: "pending",
    decidedBy: null,
    decidedAt: null,
    odFeeNum: null,
    ...over,
  };
}

/** The multi-column row: three tier columns, first taken, flagged. */
const WARNED_ROW = row({
  rowId: "aaaaaaaa-0000-4000-8000-000000000002",
  procCode: "D2740",
  feeCents: 115000,
  rawLine: "D2740   Crown - porcelain/ceramic    1,150.00   920.00     805.00",
  rowOrder: 1,
  warnings: [
    {
      code: "ambiguous_amount",
      message: "Line 4 carries 3 amounts (1,150.00, 920.00, 805.00). The first was read as D2740's fee.",
    },
  ],
});

function progress(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "northstar-2027.pdf",
    status: "parsed",
    rowCount: 2,
    rowsWritten: 0,
    writableCount: 2,
    excludedCount: 0,
    blockingCount: 1,
    totalCents: 124200,
    target: null,
    postError: null,
    postingStartedAt: null,
    postedAt: null,
    postedBy: null,
    rolledBackAt: null,
    rolledBackBy: null,
    backup: null,
    running: false,
    ...over,
  };
}

const server = vi.hoisted(() => ({
  batch: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  progress: null as Record<string, unknown> | null,
  schedules: [] as Array<Record<string, unknown>>,
  decided: [] as Array<{ rowId: string; decision: string }>,
  posted: 0,
  rolledBack: 0,
  rollbackNote: "",
  permissions: ["fees.read", "fees.write"] as string[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Office Manager",
      email: "manager@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["fees"] },
      role: "office" as const,
      isSuperAdmin: false,
      permissions: server.permissions,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/fees/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/fees/api")>();
  return {
    ...real,
    getImport: vi.fn(async () => {
      if (!server.batch) throw new real.FeesApiError("No such import.", 404, "BATCH_NOT_FOUND");
      return { success: true as const, batch: server.batch, rows: server.rows };
    }),
    getProgress: vi.fn(async () => {
      if (!server.progress) throw new real.FeesApiError("No such import.", 404, "BATCH_NOT_FOUND");
      return { success: true as const, progress: server.progress };
    }),
    listFeeSchedules: vi.fn(async () => ({
      success: true as const,
      office: "roland",
      schedules: server.schedules,
    })),
    decideRow: vi.fn(async (_o: string, _b: string, rowId: string, decision: string) => {
      server.decided.push({ rowId, decision });
      return { success: true as const, row: { rowId, decision }, status: "ready" as const };
    }),
    setTarget: vi.fn(async (_o: string, _b: string, t: Record<string, unknown>) => ({
      success: true as const,
      target: {
        feeSchedNum: typeof t.feeSchedNum === "number" ? t.feeSchedNum : null,
        description: typeof t.newScheduleName === "string" ? t.newScheduleName : "Northstar PPO",
        isNew: typeof t.newScheduleName === "string",
      },
    })),
    postImport: vi.fn(async () => {
      server.posted += 1;
      return { success: true as const, accepted: true as const, batchId: BATCH_ID, target: null };
    }),
    rollbackImport: vi.fn(async () => {
      server.rolledBack += 1;
      return {
        success: true as const,
        deleted: 6,
        restored: 0,
        problems: [] as string[],
        note: server.rollbackNote,
      };
    }),
  };
});

import FeesImportDetail from "@/pages/fees/FeesImportDetail";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderDetail() {
  const memory = memoryLocation({ path: `/fees/imports/${BATCH_ID}`, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <OfficeProvider>
              <FeesImportDetail />
            </OfficeProvider>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  server.batch = batch();
  server.rows = [row(), WARNED_ROW];
  server.progress = progress();
  server.schedules = [
    { feeSchedNum: 55, description: "Northstar PPO 2026", feeSchedType: "Normal", isHidden: false, isGlobal: true },
  ];
  server.decided = [];
  server.posted = 0;
  server.rolledBack = 0;
  server.rollbackNote = "";
  server.permissions = ["fees.read", "fees.write"];
});
afterEach(cleanup);

// ════════════════════════════════════════════════════════════════════════════
// The gate
// ════════════════════════════════════════════════════════════════════════════

describe("the posting gate on screen", () => {
  it("THE STAR: the Post button is disabled and SAYS WHY while a row is undecided", async () => {
    renderDetail();
    const button = (await screen.findByTestId("fees-post-button")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // A disabled control with no explanation is the thing people file tickets
    // about. The reason comes from the server's own count.
    const reason = screen.getByTestId("fees-post-blocked-reason");
    expect(reason.textContent).toMatch(/1 row still needs a decision/i);
  });

  it("offers accept and exclude on a WARNED row, and on no other row", async () => {
    renderDetail();
    await screen.findByTestId("fees-posting-panel");

    // Two rows, one warned. Exactly one decision control.
    expect(screen.getAllByTestId("fees-row")).toHaveLength(2);
    expect(screen.getAllByTestId("fees-row-decision")).toHaveLength(1);
    expect(screen.getByTestId("fees-row-accept")).toBeTruthy();
    expect(screen.getByTestId("fees-row-exclude")).toBeTruthy();
  });

  it("records an accept against the row the reader was looking at", async () => {
    renderDetail();
    const accept = await screen.findByTestId("fees-row-accept");
    fireEvent.click(accept);
    await waitFor(() => expect(server.decided).toHaveLength(1));
    expect(server.decided[0]).toEqual({ rowId: WARNED_ROW.rowId, decision: "accepted" });
  });

  it("shows a decided row's verdict and who made it, with an undo", async () => {
    server.rows = [
      row(),
      { ...WARNED_ROW, decision: "accepted", decidedBy: "manager@carein.ai", decidedAt: "2026-09-21T10:00:00Z" },
    ];
    server.progress = progress({ blockingCount: 0, status: "ready" });
    renderDetail();

    const decided = await screen.findByTestId("fees-row-decided");
    expect(decided.textContent).toMatch(/Accepted/);
    expect(decided.textContent).toMatch(/manager@carein\.ai/);
    expect(screen.getByTestId("fees-row-reset")).toBeTruthy();
  });

  it("enables Post once nothing blocks and a target is chosen", async () => {
    server.progress = progress({
      status: "ready",
      blockingCount: 0,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    });
    renderDetail();
    const button = (await screen.findByTestId("fees-post-button")) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.queryByTestId("fees-post-blocked-reason")).toBeNull();
  });

  it("a reader without fees.write is told so, rather than shown a dead button", async () => {
    server.permissions = ["fees.read"];
    server.progress = progress({
      status: "ready",
      blockingCount: 0,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    });
    renderDetail();
    const button = (await screen.findByTestId("fees-post-button")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("fees-post-blocked-reason").textContent).toMatch(
      /do not have permission/i,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The confirm
// ════════════════════════════════════════════════════════════════════════════

describe("the confirm dialog", () => {
  beforeEach(() => {
    server.progress = progress({
      status: "ready",
      blockingCount: 0,
      writableCount: 2,
      excludedCount: 1,
      totalCents: 124200,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    });
  });

  it("states the office, the schedule, the count and the total before anything is written", async () => {
    renderDetail();
    const button = await screen.findByTestId("fees-post-button");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    const dialog = await screen.findByTestId("fees-post-confirm");
    // The four facts somebody would want back if it went to the wrong place.
    expect(dialog.textContent).toMatch(/Roland/);
    expect(dialog.textContent).toMatch(/Northstar PPO 2026/);
    expect(dialog.textContent).toMatch(/2/);
    expect(dialog.textContent).toMatch(/\$1,242\.00/);
    // And it has not posted yet.
    expect(server.posted).toBe(0);
  });

  it("posts only on the confirm, and cancel writes nothing", async () => {
    renderDetail();
    const button = await screen.findByTestId("fees-post-button");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId("fees-post-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("fees-post-confirm")).toBeNull());
    expect(server.posted).toBe(0);

    fireEvent.click(screen.getByTestId("fees-post-button"));
    fireEvent.click(await screen.findByTestId("fees-post-confirm-yes"));
    await waitFor(() => expect(server.posted).toBe(1));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// post_failed, and the banner
// ════════════════════════════════════════════════════════════════════════════

describe("a post that stopped partway", () => {
  beforeEach(() => {
    server.batch = batch({ status: "post_failed", rowCount: 500 });
    server.rows = [row(), WARNED_ROW];
    server.progress = progress({
      status: "post_failed",
      rowCount: 500,
      writableCount: 500,
      rowsWritten: 299,
      blockingCount: 0,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
      postError: "Stopped at D2740: Open Dental refused the fee",
      backup: {
        odFeeSchedNum: 55,
        isNewSchedule: false,
        rowCount: 12,
        takenAt: "2026-09-21T10:00:00Z",
        restoredAt: null,
        restoreNote: null,
      },
    });
  });

  it("THE OTHER STAR: says HOW MANY fees are already in the practice's database", async () => {
    renderDetail();
    const failed = await screen.findByTestId("fees-post-failed");
    const written = screen.getByTestId("fees-rows-written");

    // The number, not just the failure.
    expect(written.textContent).toMatch(/299 of 500/);
    expect(written.textContent).toMatch(/already written to Open Dental/i);
    // And what to do about it.
    expect(written.textContent).toMatch(/continues from where it stopped/i);
    expect(failed.textContent).toMatch(/stopped partway/i);
    expect(screen.getByTestId("fees-post-error").textContent).toMatch(/Stopped at D2740/);
  });

  it("does NOT say the preview is untouched — the banner flips", async () => {
    // Slice 2 promised this banner would be the first thing to change when
    // posting landed. A partial failure is the worst moment to claim nothing
    // has been sent.
    renderDetail();
    await screen.findByTestId("fees-post-failed");
    expect(screen.queryByTestId("fees-preview-banner")).toBeNull();
    const banner = screen.getByTestId("fees-posted-banner");
    expect(banner.textContent).toMatch(/written to Open Dental/i);
  });

  it("offers Continue posting, because the run is resumable", async () => {
    renderDetail();
    const button = await screen.findByTestId("fees-post-button");
    expect(button.textContent).toMatch(/Continue posting/i);
  });
});

describe("the preview-only banner", () => {
  it("is shown while nothing has been posted", async () => {
    renderDetail();
    const banner = await screen.findByTestId("fees-preview-banner");
    expect(banner.textContent).toMatch(/Preview only/i);
    expect(banner.textContent).toMatch(/nothing has been sent to Open Dental/i);
    expect(screen.queryByTestId("fees-posted-banner")).toBeNull();
  });

  it("is GONE once the batch is posted", async () => {
    server.batch = batch({ status: "posted" });
    server.progress = progress({
      status: "posted",
      blockingCount: 0,
      rowsWritten: 2,
      postedBy: "manager@carein.ai",
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    });
    renderDetail();
    await screen.findByTestId("fees-posted");
    expect(screen.queryByTestId("fees-preview-banner")).toBeNull();
    expect(screen.getByTestId("fees-posted-banner")).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Rollback
// ════════════════════════════════════════════════════════════════════════════

describe("rollback", () => {
  it("THE THIRD STAR: the confirm says a NEW schedule cannot be deleted, before the click", async () => {
    // Open Dental has no DELETE for /feescheds. A confirm that implied a clean
    // removal would be the same lie as a failed post claiming nothing was
    // written — and this is the moment somebody is deciding.
    server.batch = batch({ status: "posted" });
    server.progress = progress({
      status: "posted",
      blockingCount: 0,
      rowsWritten: 6,
      target: { feeSchedNum: 501, description: "ZZ CAREIN TEST - DO NOT USE", isNew: true },
      backup: {
        odFeeSchedNum: 501,
        isNewSchedule: true,
        rowCount: 0,
        takenAt: "2026-09-21T10:00:00Z",
        restoredAt: null,
        restoreNote: null,
      },
    });
    renderDetail();

    fireEvent.click(await screen.findByTestId("fees-rollback-button"));
    const dialog = await screen.findByTestId("fees-rollback-confirm");
    expect(dialog.textContent).toMatch(/deletes the 6 fees/i);
    expect(dialog.textContent).toMatch(/hides the schedule it created/i);

    const caveat = screen.getByTestId("fees-rollback-new-caveat");
    expect(caveat.textContent).toMatch(/cannot delete a fee schedule/i);
    expect(caveat.textContent).toMatch(/will remain/i);
    expect(server.rolledBack).toBe(0);
  });

  it("says what it will put back when the schedule already existed", async () => {
    server.batch = batch({ status: "posted" });
    server.progress = progress({
      status: "posted",
      blockingCount: 0,
      rowsWritten: 6,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
      backup: {
        odFeeSchedNum: 55,
        isNewSchedule: false,
        rowCount: 12,
        takenAt: "2026-09-21T10:00:00Z",
        restoredAt: null,
        restoreNote: null,
      },
    });
    renderDetail();

    fireEvent.click(await screen.findByTestId("fees-rollback-button"));
    const dialog = await screen.findByTestId("fees-rollback-confirm");
    expect(dialog.textContent).toMatch(/puts back the 12 fees that were there before/i);
    expect(screen.queryByTestId("fees-rollback-new-caveat")).toBeNull();
  });

  it("renders the server's own note afterwards, caveat and all", async () => {
    server.batch = batch({ status: "posted" });
    server.progress = progress({
      status: "posted",
      blockingCount: 0,
      rowsWritten: 6,
      target: { feeSchedNum: 501, description: "ZZ CAREIN TEST - DO NOT USE", isNew: true },
      backup: {
        odFeeSchedNum: 501,
        isNewSchedule: true,
        rowCount: 0,
        takenAt: "2026-09-21T10:00:00Z",
        restoredAt: null,
        restoreNote: null,
      },
    });
    server.rollbackNote =
      "Deleted 6 fees and hid the schedule. Open Dental cannot delete a fee schedule, so the empty schedule remains.";
    renderDetail();

    fireEvent.click(await screen.findByTestId("fees-rollback-button"));
    fireEvent.click(await screen.findByTestId("fees-rollback-confirm-yes"));
    await waitFor(() => expect(server.rolledBack).toBe(1));

    const result = await screen.findByTestId("fees-rollback-result");
    expect(result.textContent).toMatch(/cannot delete a fee schedule/i);
    expect(result.textContent).toMatch(/remains/i);
  });

  it("is not offered on a batch that was never posted", async () => {
    renderDetail();
    await screen.findByTestId("fees-posting-panel");
    expect(screen.queryByTestId("fees-rollback-button")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Progress
// ════════════════════════════════════════════════════════════════════════════

describe("while a post is running", () => {
  it("shows how far it has got and warns that it takes minutes", async () => {
    server.batch = batch({ status: "posting", rowCount: 500 });
    server.progress = progress({
      status: "posting",
      rowCount: 500,
      writableCount: 500,
      rowsWritten: 120,
      blockingCount: 0,
      running: true,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    });
    renderDetail();

    const live = await screen.findByTestId("fees-post-progress");
    expect(live.textContent).toMatch(/Writing fee 121 of 500/);
    // The throttle is stated, because a screen that looks stuck for ten minutes
    // without saying why gets reloaded, and then posted again.
    expect(live.textContent).toMatch(/one request a second/i);
    expect(screen.getByTestId("fees-status-chip").getAttribute("data-status")).toBe("posting");
  });

  it("offers no Post button while one is already running", async () => {
    server.batch = batch({ status: "posting" });
    server.progress = progress({ status: "posting", blockingCount: 0, running: true });
    renderDetail();
    await screen.findByTestId("fees-post-progress");
    const button = (await screen.findByTestId("fees-post-button")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("fees-post-blocked-reason").textContent).toMatch(
      /already running/i,
    );
  });
});
