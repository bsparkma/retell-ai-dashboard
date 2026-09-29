/**
 * The target picker: refreshing, searching, and hidden schedules.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG THESE STAND OVER
 * ═════════════════════════════════════════════════════════════════════════════
 * A fee schedule created in Open Dental did not appear in the Post panel's
 * list. The backend was never at fault — `listFeeSchedules` pages through every
 * schedule at Limit 100 and holds no cache. The staleness was this component's
 * own `if (schedules !== null) return` guard, which made the read
 * fetch-once-per-mount; the panel stays mounted across a re-read of the batch,
 * so nothing short of a full page reload could ever refill the list. Nobody had
 * been told to reload, so the schedule simply "was not there".
 *
 * So the first test is the one that matters: a second read returns the new
 * schedule and the list shows it.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Fee schedules carry names and numbers.
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

const BATCH_ID = "55555555-5555-4555-8555-555555555555";

function schedule(over: Record<string, unknown> = {}) {
  return {
    feeSchedNum: 55,
    description: "Northstar PPO 2026",
    feeSchedType: "Normal",
    isHidden: false,
    isGlobal: true,
    ...over,
  };
}

/** Enough schedules to make searching the point rather than a nicety. */
const SCHEDULES = [
  schedule({ feeSchedNum: 55, description: "Northstar PPO 2026" }),
  schedule({ feeSchedNum: 56, description: "Office UCR" }),
  schedule({ feeSchedNum: 57, description: "Meridian Benefit Tier 2" }),
  schedule({ feeSchedNum: 58, description: "Northstar PPO 2025", isHidden: true }),
];

function batch(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "northstar-2027.pdf",
    fileSha256: "c".repeat(64),
    fileSizeBytes: 210_000,
    sourceType: "pdf",
    status: "parsed",
    rowCount: 1,
    warningCount: 0,
    warnings: [],
    failureReason: null,
    failureCode: null,
    createdBy: "manager@carein.ai",
    createdAt: "2026-09-29T12:00:00.000Z",
    updatedAt: "2026-09-29T12:00:00.000Z",
    ...over,
  };
}

const ROW = {
  rowId: "row-1",
  procCode: "D1110",
  feeCents: 9200,
  rawLine: "D1110 Prophylaxis 92.00",
  warnings: [],
  rowOrder: 0,
  decision: "pending",
  decidedBy: null,
  decidedAt: null,
  editedFeeCents: null,
  odFeeNum: null,
};

function progress(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "northstar-2027.pdf",
    status: "parsed",
    rowCount: 1,
    rowsWritten: 0,
    writableCount: 1,
    excludedCount: 0,
    editedCount: 0,
    blockingCount: 0,
    totalCents: 9200,
    target: null,
    postError: null,
    requestedBy: null,
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
  schedules: [] as Array<Record<string, unknown>>,
  scheduleReads: 0,
  refreshFlags: [] as Array<boolean | undefined>,
  progress: null as Record<string, unknown> | null,
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
      permissions: ["fees.read", "fees.write"],
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const targetApi = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(targetApi, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/fees/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/fees/api")>();
  return {
    ...real,
    getImport: vi.fn(async () => ({
      success: true as const,
      batch: batch(),
      rows: [ROW],
    })),
    getProgress: vi.fn(async () => ({
      success: true as const,
      progress: server.progress ?? progress(),
    })),
    listFeeSchedules: vi.fn(
      async (_o: string, _s?: AbortSignal, opts?: { refresh?: boolean }) => {
        server.scheduleReads += 1;
        server.refreshFlags.push(opts?.refresh);
        return { success: true as const, office: "roland", schedules: server.schedules };
      },
    ),
    setTarget: vi.fn(async () => ({
      success: true as const,
      target: { feeSchedNum: 55, description: "Northstar PPO 2026", isNew: false },
    })),
  };
});

import FeesImportDetail from "@/pages/fees/FeesImportDetail";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { filterSchedules, type FeeSchedule } from "@/features/fees/api";

function renderDetail() {
  const memory = memoryLocation({ path: `/fees/imports/${BATCH_ID}`, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <AuthProvider>
          <OfficeProvider>
            <TooltipProvider>
              <FeesImportDetail />
            </TooltipProvider>
          </OfficeProvider>
        </AuthProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

beforeEach(() => {
  server.schedules = SCHEDULES.map((s) => ({ ...s }));
  server.scheduleReads = 0;
  server.refreshFlags = [];
  server.progress = progress();
});

afterEach(cleanup);

// ════════════════════════════════════════════════════════════════════════════
// The filter, as a pure function
// ════════════════════════════════════════════════════════════════════════════

describe("filterSchedules", () => {
  const list = SCHEDULES as unknown as FeeSchedule[];

  it("matches the name, case-insensitively, anywhere in it", () => {
    expect(filterSchedules(list, "northstar").map((s) => s.feeSchedNum)).toEqual([55, 58]);
    expect(filterSchedules(list, "MERIDIAN").map((s) => s.feeSchedNum)).toEqual([57]);
    expect(filterSchedules(list, "ucr").map((s) => s.feeSchedNum)).toEqual([56]);
  });

  it("matches the FeeSchedNum, because that is what a colleague pastes", () => {
    expect(filterSchedules(list, "57").map((s) => s.feeSchedNum)).toEqual([57]);
  });

  it("an empty or blank search returns everything, in order", () => {
    expect(filterSchedules(list, "").map((s) => s.feeSchedNum)).toEqual([55, 56, 57, 58]);
    expect(filterSchedules(list, "   ").map((s) => s.feeSchedNum)).toEqual([55, 56, 57, 58]);
  });

  it("is substring, not fuzzy", () => {
    // A fuzzy match on a list this consequential would offer "Delta Premier"
    // for a search for "Delta PPO".
    expect(filterSchedules(list, "nrthstar")).toEqual([]);
  });

  it("does not mutate the list it is given", () => {
    const copy = [...list];
    filterSchedules(list, "northstar");
    expect(list).toEqual(copy);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The picker, on screen
// ════════════════════════════════════════════════════════════════════════════

describe("the target picker", () => {
  it("THE BUG: Refresh re-reads, and a newly created schedule appears", async () => {
    renderDetail();
    await screen.findByTestId("fees-target-picker");
    await waitFor(() => expect(screen.getByTestId("fees-target-55")).toBeTruthy());
    expect(screen.queryByTestId("fees-target-99")).toBeNull();

    // Somebody creates it in Open Dental while this page is open.
    server.schedules = [
      ...SCHEDULES.map((s) => ({ ...s })),
      schedule({ feeSchedNum: 99, description: "Payless Dental 2027" }),
    ];

    // Before the fix there was no control to press, and re-rendering the page
    // would not have refilled the list either.
    fireEvent.click(screen.getByTestId("fees-schedules-refresh"));

    await waitFor(() => expect(screen.getByTestId("fees-target-99")).toBeTruthy());
    expect(screen.getByTestId("fees-target-99").textContent).toMatch(/Payless Dental 2027/);
  });

  it("asks the browser NOT to answer a Refresh from cache", async () => {
    renderDetail();
    await screen.findByTestId("fees-target-picker");
    await waitFor(() => expect(server.scheduleReads).toBe(1));
    // The first read may legitimately be cached; a deliberate re-read may not.
    // Express puts an ETag on every JSON response, so without this a Refresh
    // could be answered by the browser with exactly the list the person
    // pressed it because they distrusted.
    expect(server.refreshFlags[0]).toBe(false);

    fireEvent.click(screen.getByTestId("fees-schedules-refresh"));
    await waitFor(() => expect(server.scheduleReads).toBe(2));
    expect(server.refreshFlags[1]).toBe(true);
  });

  it("filters the list as you type, over what was already fetched", async () => {
    renderDetail();
    await screen.findByTestId("fees-schedule-search");
    await waitFor(() => expect(server.scheduleReads).toBe(1));

    fireEvent.change(screen.getByTestId("fees-schedule-search"), {
      target: { value: "meridian" },
    });

    await waitFor(() => expect(screen.queryByTestId("fees-target-55")).toBeNull());
    expect(screen.getByTestId("fees-target-57")).toBeTruthy();
    expect(screen.queryByTestId("fees-target-56")).toBeNull();
    // NO SERVER READ. Every one costs an Open Dental request against a
    // credential paced at one per second and shared with every other module.
    expect(server.scheduleReads).toBe(1);
  });

  it("says so when nothing matches, and points at Refresh", async () => {
    renderDetail();
    await screen.findByTestId("fees-schedule-search");
    fireEvent.change(screen.getByTestId("fees-schedule-search"), {
      target: { value: "payless" },
    });

    const empty = await screen.findByTestId("fees-schedule-no-matches");
    // The likeliest reason a search finds nothing is the bug this slice fixes,
    // so the empty state names the remedy rather than leaving a blank space.
    expect(empty.textContent).toMatch(/Refresh/);
  });

  it("shows hidden schedules, drawn differently", async () => {
    renderDetail();
    await screen.findByTestId("fees-target-picker");

    // Still offered: a rolled-back batch's schedule is hidden, and posting into
    // it again is legitimate.
    const hidden = await screen.findByTestId("fees-target-58");
    expect(hidden.getAttribute("data-hidden")).toBe("true");
    expect(hidden.className).toMatch(/border-dashed/);
    expect(hidden.textContent).toMatch(/hidden/i);

    // And an ordinary one is not.
    const live = screen.getByTestId("fees-target-55");
    expect(live.getAttribute("data-hidden")).toBe("false");
    expect(live.className).not.toMatch(/border-dashed/);
  });

  it("shows the FeeSchedNum on every option", async () => {
    // Two schedules can share a name across years; the number is what
    // disambiguates them, and it is what the confirm dialog will quote back.
    renderDetail();
    const live = await screen.findByTestId("fees-target-55");
    expect(live.textContent).toMatch(/#55/);
  });

  it("offers creating one as a labelled choice, not a trailing text box", async () => {
    renderDetail();
    const block = await screen.findByTestId("fees-new-schedule-block");
    expect(block.textContent).toMatch(/Create a new fee schedule/);
    // The safest option says why it is safe: it reprices nothing until somebody
    // attaches it to a plan.
    expect(block.textContent).toMatch(/reprices nothing/);
    expect(screen.getByTestId("fees-new-schedule-name")).toBeTruthy();
  });

  it("tells an office with no schedules what to do", async () => {
    server.schedules = [];
    renderDetail();
    const none = await screen.findByTestId("fees-schedule-none");
    expect(none.textContent).toMatch(/no fee schedules yet/);
    // And the search box is not offered over an empty list.
    expect(screen.queryByTestId("fees-schedule-search")).toBeNull();
  });
});
