/**
 * Screenshot DUMPS for the posting queue (Slice 6c).
 *
 * Same shape and same reasons as `rcm-workbench-shots.test.tsx`: renders the
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/*.html`, which `scripts/shoot-rcm-workbench.mjs` then
 * wraps in the app's real built CSS and photographs.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, check number and dollar figure
 * below is synthetic, so a screenshot of the screen that writes to patient
 * charts physically cannot contain a patient.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const OUT = resolve(import.meta.dirname, ".shots");

// ─── Fixture plans — SYNTHETIC ───────────────────────────────────────────────

const BASE_ROW = {
  queueId: "q-1",
  office: "roland" as const,
  batchId: "b-1",
  status: "approved" as const,
  statusLabel: "queued" as const,
  blockedReason: null as string | null,
  step: null as string | null,
  isRecoupment: false,
  carrierEobDate: "2026-03-01",
  intendedTotalCents: 42350,
  postedTotalCents: 0,
  odClaimPaymentNum: null as number | null,
  reconciledAt: null as string | null,
  approvedAt: "2026-03-02T11:10:00.000Z",
  approvedBy: "biller@example.invalid",
  startedAt: null as string | null,
  finishedAt: null as string | null,
  drainAttemptAt: null as string | null,
  drainedBy: null as string | null,
  attemptCount: 0,
  lastError: null as string | null,
  checkNumber: "830200001",
  payer: "DELTA DENTAL OF ARKANSAS",
};

const plan = (over: Partial<typeof BASE_ROW> = {}) => ({ ...BASE_ROW, ...over });

const BASE_LINE = {
  queueLineId: "l-1",
  position: 1,
  odClaimNum: 53648,
  odClaimProcNum: 533930,
  status: "pending" as const,
  skipReason: null as string | null,
  intendedInsPayAmtCents: 15000,
  intendedWriteOffCents: 6000,
  intendedDedAppliedCents: 0,
  isSupplemental: false,
  claimprocWrittenAt: null as string | null,
  claimReceivedAt: null as string | null,
  paidAt: null as string | null,
  odClaimPaymentNum: null as number | null,
  readback: null as unknown,
  readbackAt: null as string | null,
  lastError: null as string | null,
};

const line = (over: Partial<typeof BASE_LINE> = {}) => ({ ...BASE_LINE, ...over });

const VERIFIED = {
  step: "claimproc_write",
  agreed: true,
  sent: { Status: "Received", InsPayAmt: 150, WriteOff: 60, DedApplied: 0 },
  read: { Status: "Received", InsPayAmt: 150, WriteOff: 60, DedApplied: 0 },
  mismatches: [] as { field: string; sent: unknown; read: unknown }[],
};

const shotState = vi.hoisted(() => ({
  page: null as unknown,
  detail: null as unknown,
  /**
   * Which office the roster reports. The D-7 shot is the whole reason this is a
   * variable: a picture captioned "posting is not switched on for Roland" while
   * the copy underneath talks about Riley documents nothing except a fixture
   * that was never looked at.
   */
  offices: [{ officeId: "roland", officeName: "Roland Family Dental" }] as {
    officeId: string;
    officeName: string;
  }[],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => shotState.offices,
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listPostingQueue: vi.fn(async () => shotState.page),
    getPostingPlan: vi.fn(async () => shotState.detail),
    drainPostingQueue: vi.fn(async () => {
      throw new Error("the shots never press it");
    }),
  };
});

import PostingQueue from "@/pages/rcm/PostingQueue";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderQueue() {
  const memory = memoryLocation({ path: "/rcm/posting", record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>
            <PostingQueue />
          </OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

/** A whole page response around a set of plans. */
function pageOf(
  rows: ReturnType<typeof plan>[],
  over: { canDrain?: boolean; postingEnabled?: boolean; office?: string } = {},
) {
  const byStatus = {
    approved: 0,
    posting: 0,
    posted: 0,
    partially_posted: 0,
    failed: 0,
    blocked: 0,
  };
  for (const r of rows) byStatus[r.status] += 1;
  return {
    office: over.office ?? "roland",
    rows,
    byStatus,
    total: rows.length,
    limit: 50,
    offset: 0,
    canDrain: over.canDrain ?? true,
    drainRequires: "rcm.write",
    postingEnabled: over.postingEnabled ?? true,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  shotState.detail = null;
  shotState.offices = [{ officeId: "roland", officeName: "Roland Family Dental" }];
});
afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("posting queue screenshots", () => {
  it("posting-01 — queued: approved, waiting, nothing written", async () => {
    shotState.page = pageOf([
      plan(),
      plan({
        queueId: "q-2",
        batchId: "b-2",
        payer: "BCBS OF ARKANSAS",
        checkNumber: "EFT-99120",
        intendedTotalCents: 118400,
      }),
    ]);
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-roland"));
    dump("posting-01-queued");
  });

  it("posting-02 — running: a plan mid-sequence, with the step it is on", async () => {
    shotState.page = pageOf([
      plan({
        status: "posting",
        statusLabel: "running",
        step: "claimproc_writes",
        startedAt: "2026-03-02T12:00:00.000Z",
        drainAttemptAt: "2026-03-02T12:00:00.000Z",
        attemptCount: 1,
      }),
      plan({ queueId: "q-2", batchId: "b-2", payer: "BCBS OF ARKANSAS", checkNumber: "EFT-99120" }),
    ]);
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-roland"));
    dump("posting-02-running");
  });

  it("posting-03 — partially posted, with the exact positions", async () => {
    /*
     * THE §8 WINDOW, on screen. Money reached the chart and the check does not
     * carry what the plan intended — so the row is an OBLIGATION on the
     * remittance list and says exactly where it stopped here.
     */
    shotState.page = pageOf([
      plan({
        status: "partially_posted",
        statusLabel: "partially_posted",
        step: "reconcile",
        odClaimPaymentNum: 21253,
        postedTotalCents: 15000,
        intendedTotalCents: 42350,
        attemptCount: 2,
        startedAt: "2026-03-02T12:00:00.000Z",
        finishedAt: "2026-03-02T12:04:00.000Z",
        lastError:
          "Check 21253 does not carry exactly this plan's lines — missing [533931], " +
          "unexpected [], 0 amount disagreement(s).",
      }),
    ]);
    shotState.detail = {
      office: "roland",
      plan: shotState.page.rows[0],
      lines: [
        line({
          status: "paid",
          paidAt: "2026-03-02T12:03:00.000Z",
          odClaimPaymentNum: 21253,
          readback: VERIFIED,
          readbackAt: "2026-03-02T12:02:00.000Z",
        }),
        line({
          queueLineId: "l-2",
          position: 2,
          odClaimProcNum: 533931,
          intendedInsPayAmtCents: 27350,
          intendedWriteOffCents: 4100,
          status: "failed",
          lastError:
            "Open Dental accepted the write but read back different values: InsPayAmt",
          readback: {
            step: "claimproc_write",
            agreed: false,
            sent: { Status: "Received", InsPayAmt: 273.5, WriteOff: 41, DedApplied: 0 },
            read: { Status: "Received", InsPayAmt: 0, WriteOff: 41, DedApplied: 0 },
            mismatches: [{ field: "InsPayAmt", sent: 273.5, read: 0 }],
          },
          readbackAt: "2026-03-02T12:03:30.000Z",
        }),
      ],
      claims: [
        { claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", odClaimNum: 53648 },
      ],
      canDrain: true,
      drainRequires: "rcm.write",
      postingEnabled: true,
      documentAttach: {
        implemented: false,
        note: "The EOB PDF is not yet filed into the patient images — that is a later slice.",
      },
    };
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-roland"));
    // Open the plan so the per-line positions are in the picture — the whole
    // point of this state is that it says exactly where it stopped.
    (await screen.findByTestId("posting-plan-q-1")).querySelector("button")?.click();
    await waitFor(() => screen.getByTestId("posting-plan-lines"));
    dump("posting-03-partially-posted");
  });

  it("posting-04 — blocked: valley, with no Open Dental call made", async () => {
    // The D-7 picture is about VALLEY, so the roster and the office selection
    // are valley for this one shot.
    shotState.offices = [{ officeId: "valley", officeName: "Riley Family Dental" }];
    localStorage.setItem("carein.office", "valley");
    shotState.page = pageOf(
      [
        plan({
          status: "blocked",
          statusLabel: "blocked",
          blockedReason: "valley_not_enabled",
          step: "resolve_config",
          attemptCount: 1,
          finishedAt: "2026-03-02T12:00:00.000Z",
          lastError:
            "Posting is not enabled for 'valley' yet. This practice's own PayType, AdjType " +
            "and DocCategory DefNums must be read from its own Open Dental, its key's write " +
            "permission groups proven, and a test-patient end-to-end run completed first (D-7).",
        }),
      ],
      { postingEnabled: false, office: "valley" },
    );
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-valley"));
    dump("posting-04-blocked");
  });

  it("posting-05 — posted, with its check number and read-back proof", async () => {
    shotState.page = pageOf([
      plan({
        status: "posted",
        statusLabel: "posted",
        step: "document_attach",
        odClaimPaymentNum: 21253,
        reconciledAt: "2026-03-02T12:04:00.000Z",
        postedTotalCents: 42350,
        attemptCount: 1,
        startedAt: "2026-03-02T12:00:00.000Z",
        finishedAt: "2026-03-02T12:04:00.000Z",
      }),
    ]);
    shotState.detail = {
      office: "roland",
      plan: shotState.page.rows[0],
      lines: [
        line({
          status: "paid",
          claimprocWrittenAt: "2026-03-02T12:01:00.000Z",
          claimReceivedAt: "2026-03-02T12:02:00.000Z",
          paidAt: "2026-03-02T12:04:00.000Z",
          odClaimPaymentNum: 21253,
          readback: VERIFIED,
          readbackAt: "2026-03-02T12:01:00.000Z",
        }),
        line({
          queueLineId: "l-2",
          position: 2,
          odClaimProcNum: 533931,
          intendedInsPayAmtCents: 27350,
          intendedWriteOffCents: 4100,
          status: "paid",
          claimprocWrittenAt: "2026-03-02T12:02:00.000Z",
          claimReceivedAt: "2026-03-02T12:03:00.000Z",
          paidAt: "2026-03-02T12:04:00.000Z",
          odClaimPaymentNum: 21253,
          readback: {
            ...VERIFIED,
            sent: { Status: "Received", InsPayAmt: 273.5, WriteOff: 41, DedApplied: 0 },
            read: { Status: "Received", InsPayAmt: 273.5, WriteOff: 41, DedApplied: 0 },
          },
          readbackAt: "2026-03-02T12:02:30.000Z",
        }),
      ],
      claims: [
        { claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", odClaimNum: 53648 },
      ],
      canDrain: true,
      drainRequires: "rcm.write",
      postingEnabled: true,
      documentAttach: {
        implemented: false,
        note: "The EOB PDF is not yet filed into the patient images — that is a later slice.",
      },
    };
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-roland"));
    (await screen.findByTestId("posting-plan-q-1")).querySelector("button")?.click();
    await waitFor(() => screen.getByTestId("posting-plan-lines"));
    dump("posting-05-posted");
  });

  it("posting-06 — a reviewer: the same queue, a disabled button", async () => {
    shotState.page = pageOf([plan(), plan({ queueId: "q-2", batchId: "b-2", payer: "BCBS OF ARKANSAS" })], {
      canDrain: false,
    });
    renderQueue();
    await waitFor(() => screen.getByTestId("posting-counts-roland"));
    dump("posting-06-reviewer");
  });
});
