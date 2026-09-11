/**
 * RCM UI OVERHAUL, SLICE 5 — posting truth: Finished, Stuck, Deposit, Shadow.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS MOST: W-16
 * ═════════════════════════════════════════════════════════════════════════════
 * A `partially_posted` check is either MEASURED (the run read every claim back
 * and a patient's number disagreed) or STOPPED (it never got that far). The
 * walk watched a database constraint message rendered under "what the chart
 * says — measured out of Open Dental" over a chart that was right; on real data
 * that ends with somebody hand-editing a correct ledger.
 *
 * The branch is keyed on the drain's STEP (`confirm_patient`), not on
 * `reconciledAt` — which is null on BOTH branches, because the measured exit
 * finalises `reconciled: false`. PM ruling 2026-09-10. Every fixture below
 * carries `reconciledAt: null` for exactly that reason, and the stopped suite
 * walks EVERY other step and asserts that nothing from the fix path — no
 * figures, no steps, no re-check, no run error text — is reachable.
 *
 * Also here: the measured finished banner (item 1), the honest running state
 * (3), already-approved routing (4), the permanent-path confirm (W-4, 5), the
 * deposit card (6), the shadow worksheet (7), admin display names (8) and the
 * takeback procedure page (9).
 *
 * NO REAL PATIENT DATA. Every name is synthetic and every PatNum is a documented
 * fixture (12827 "Test 2, Stedi" / 12828 "Test, MangoTest").
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { ClaimVerdict, PostingQueueDetail } from "@/features/rcm/api";
import { POSTING_STEPS } from "@/features/rcm/api";
import { POSTING_RUNNING_COPY, SHADOW_MODE_COPY, stoppedWhile, stuckKind } from "@/features/rcm/posting";
import { consequenceSentence, disagreementsOf, type ConfirmedRead } from "@/features/rcm/confirmed";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures — synthetic only ───────────────────────────────────────────────

/** A run error that carries a CHART INSTRUCTION — the stopped screen must never show it. */
const REMEDIATION_ERROR =
  "Open Dental's eligible total for these claims is 3000 cents; this check intends 48000. " +
  "Resolve the extra or missing line in the chart, then post again.";
/** W-16's own text, near enough: a crash, not a measurement. */
const CRASH_ERROR =
  'new row for relation "rcm_posting_queue_line" violates check constraint "skip_reason_check"';

const RED_SENTENCE =
  "Open Dental says the patient owes $30.00 — this check said $0.00. This needs you before anything else posts. Look at D0274.";

function planRow(over: Record<string, unknown> = {}) {
  return {
    queueId: "q-1",
    office: "roland",
    batchId: "b-1",
    status: "partially_posted",
    statusLabel: "partially_posted",
    blockedReason: null,
    withdrawnReason: null,
    withdrawnNote: null,
    withdrawnAt: null,
    step: "confirm_patient",
    isRecoupment: false,
    documentAttachStatus: null,
    carrierEobDate: "2026-03-01",
    intendedTotalCents: 48000,
    postedTotalCents: 48000,
    odClaimPaymentNum: 21436,
    // NULL ON BOTH BRANCHES — see the header.
    reconciledAt: null,
    approvedAt: "2026-03-05T18:50:00.000Z",
    approvedBy: "Billing User",
    startedAt: "2026-03-05T18:57:00.000Z",
    finishedAt: "2026-03-05T18:58:00.000Z",
    drainAttemptAt: "2026-03-05T18:57:00.000Z",
    drainedBy: "Billing User",
    attemptCount: 1,
    lastError: RED_SENTENCE,
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL",
    ...over,
  };
}

function postingLine(over: Record<string, unknown> = {}) {
  return {
    queueLineId: "ql-1",
    position: 1,
    odClaimNum: 53648,
    odClaimProcNum: 533930,
    status: "paid",
    skipReason: null,
    intendedInsPayAmtCents: 45000,
    intendedWriteOffCents: 30000,
    intendedDedAppliedCents: 0,
    isSupplemental: false,
    recoupmentPath: null,
    odAdjustmentNum: null,
    odSupplementalClaimProcNum: null,
    claimprocWrittenAt: "2026-03-05T18:57:10.000Z",
    claimReceivedAt: "2026-03-05T18:57:20.000Z",
    paidAt: "2026-03-05T18:57:30.000Z",
    odClaimPaymentNum: 21436,
    readback: null,
    readbackAt: null,
    lastError: null,
    decidedWriteOffCents: null,
    decidedReason: null,
    decidedBy: null,
    intendedPatientCents: 45000,
    odWriteoffAdjustmentNum: null,
    ...over,
  };
}

function detail(
  plan: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
): PostingQueueDetail {
  return {
    office: "roland",
    plan: planRow(plan),
    lines: [
      postingLine(),
      postingLine({
        queueLineId: "ql-2",
        position: 2,
        odClaimProcNum: 533931,
        intendedInsPayAmtCents: 3000,
        intendedWriteOffCents: 2900,
        decidedWriteOffCents: 3000,
        decidedReason: "X-rays — bitewings",
        decidedBy: "Billing User",
        intendedPatientCents: 0,
        odWriteoffAdjustmentNum: 90001,
        paidAt: "2026-03-05T18:57:55.000Z",
      }),
    ],
    claims: [{ claimId: "c-1", claimNumber: "53648", patientName: "Test 2, Stedi", odClaimNum: 53648 }],
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
    documentAttach: {
      implemented: true,
      status: null,
      error: null,
      at: null,
      documents: [],
      canRetry: true,
      retryRequires: "rcm.post",
    },
    ...over,
  } as unknown as PostingQueueDetail;
}

function confirmedVerdict(over: Partial<ClaimVerdict> = {}): ClaimVerdict {
  return {
    state: "red",
    register: "confirmed",
    eobPatientCents: 3000,
    projectedPatientCents: 3000,
    decidedWriteOffCents: 3000,
    contractualWriteOffCents: 32900,
    decisions: [],
    problems: [{ kind: "chart_disagrees", code: "D0274", lineId: "l-2", detail: "D0274 reads $30.00." }],
    sentence: RED_SENTENCE,
    ...over,
  };
}

const AMBER_CONFIRMED = confirmedVerdict({
  state: "amber",
  projectedPatientCents: 0,
  problems: [],
  decisions: [
    {
      lineId: "l-2",
      code: "D0274",
      amountCents: 3000,
      reason: "xrays_bitewings",
      reasonLabel: "X-rays — bitewings",
      decidedBy: "Billing User",
      decidedAt: "2026-03-05T18:40:00.000Z",
    },
  ],
  sentence:
    "Patient owes $0.00 — $30.00 below the EOB because you wrote off D0274. Confirmed in Open Dental.",
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: { status: "loading" } as unknown,
  detail: null as unknown,
  confirmed: {} as Record<string, unknown>,
  claimFails: false,
  settings: null as unknown,
  recheck: null as unknown,
  calls: [] as string[],
  drainResolve: null as null | ((v: unknown) => void),
  queue: null as unknown,
  approveError: null as unknown,
  recoupment: null as unknown,
  recoupError: null as unknown,
  summary: null as unknown,
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => state.auth };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      { officeId: "roland", officeName: "Roland Family Dental", odConnected: true, odBlockedReason: null, odHealth: null },
    ],
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
    getPostingPlan: vi.fn(async () => {
      state.calls.push("getPostingPlan");
      return state.detail;
    }),
    getClaim: vi.fn(async (office: string, claimId: string) => {
      state.calls.push(`getClaim:${claimId}`);
      if (state.claimFails) throw new real.RcmApiError("down", 500, "OOPS");
      return {
        office,
        claim: {
          claimId,
          patientName: "Test 2, Stedi",
          odPatientId: 12827,
          odClaimNum: 53648,
          verdict: state.confirmed[claimId],
          confirmedAt: state.confirmed[claimId] ? "2026-03-05T18:58:00.000Z" : null,
        },
        writeoffReasons: [],
        matchRules: {},
      };
    }),
    getRcmOfficeSettings: vi.fn(async () => {
      state.calls.push("getRcmOfficeSettings");
      return state.settings;
    }),
    recheckPosting: vi.fn(async () => {
      state.calls.push("recheckPosting");
      return state.recheck;
    }),
    drainPostingQueue: vi.fn(
      () =>
        new Promise((resolve) => {
          state.calls.push("drainPostingQueue");
          state.drainResolve = resolve;
        }),
    ),
    listPostingQueue: vi.fn(async () => state.queue),
    getRemittance: vi.fn(async (office: string) => ({
      office,
      remittance: {
        batchId: "b-1",
        payer: "SYNTHETIC DENTAL",
        paymentMethod: "check",
        checkNumber: "830200001",
        eftNumber: null,
        traceNumber: null,
        totalAmountCents: 48000,
        plans: [],
        plbAdjustments: [],
      },
      claims: [
        { claimId: "c-1", totalPaidCents: 48000, odMatchStatus: "confirmed", needsReviewReasons: [] },
      ],
    })),
    getApprovalPreview: vi.fn(async (office: string, batchId: string) => ({
      office,
      batchId,
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [
        {
          claimId: "c-1",
          claimNumber: "53648",
          patientName: "Test 2, Stedi",
          postable: true,
          alreadyQueued: false,
          checks: [{ code: "MATCH_CONFIRMED", label: "MATCH_CONFIRMED", passed: true, detail: null, fix: "…" }],
          failed: [],
        },
      ],
      postableCount: 1,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    })),
    approveRemittance: vi.fn(async () => {
      state.calls.push("approveRemittance");
      throw state.approveError;
    }),
    getRecoupmentChecklist: vi.fn(async () => state.recoupment),
    approveRecoupment: vi.fn(async (_o: string, _b: string, body: { path: string }) => {
      state.calls.push(`approveRecoupment:${body.path}`);
      if (state.recoupError) throw state.recoupError;
      return { note: "Queued.", approvedBy: "k", recoupmentPath: body.path };
    }),
    getComparisonSummary: vi.fn(async () => state.summary),
  };
});

import { RcmApiError } from "@/features/rcm/api";
import { PostedOutcome, StuckAfterPosting } from "@/components/rcm/PostedOutcome";
import PostThisCheck from "@/components/rcm/PostThisCheck";
import PostingQueue from "@/pages/rcm/PostingQueue";
import ApproveCheck from "@/pages/rcm/ApproveCheck";
import { RecoupmentPanel } from "@/pages/rcm/RecoupmentPanel";
import TakebackSop from "@/pages/rcm/TakebackSop";
import ShadowModeBanner from "@/components/rcm/ShadowModeBanner";
import RcmPostingSettingsCard from "@/pages/admin/RcmPostingSettingsCard";
import RcmShadowComparisonCard from "@/pages/admin/RcmShadowComparisonCard";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path = "/rcm/remittances/b-1") {
  const memory = memoryLocation({ path, record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const ADMIN = {
  status: "authenticated",
  user: {
    name: "Admin Person",
    email: "admin@example.invalid",
    isSuperAdmin: false,
    permissions: ["rcm.read", "rcm.queue", "rcm.write", "rcm.post", "rcm.settings"],
  },
};
const BILLER = {
  status: "authenticated",
  user: {
    name: "Billing Person",
    email: "biller@example.invalid",
    isSuperAdmin: false,
    permissions: ["rcm.read", "rcm.queue", "rcm.write"],
  },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.auth = BILLER;
  state.detail = null;
  state.confirmed = {};
  state.claimFails = false;
  state.settings = null;
  state.recheck = null;
  state.calls = [];
  state.drainResolve = null;
  state.queue = null;
  state.approveError = null;
  state.recoupment = null;
  state.recoupError = null;
  state.summary = null;
});

afterEach(cleanup);

// ═════════════════════════════════════════════════════════════════════════════
// W-16 · THE BRANCH
// ═════════════════════════════════════════════════════════════════════════════

describe("W-16 · stuckKind reads the step, never reconciledAt", () => {
  it("is MEASURED only at confirm_patient, and reconciledAt is null either way", () => {
    expect(stuckKind({ status: "partially_posted", step: "confirm_patient" })).toBe("measured");
    // The drain's measured exit leaves reconciledAt null — the rule must not need it.
    expect(planRow().reconciledAt).toBeNull();
    for (const step of [null, ...POSTING_STEPS.filter((s) => s !== "confirm_patient")]) {
      expect(stuckKind({ status: "partially_posted", step }), `step ${step}`).toBe("stopped");
    }
  });

  it("says nothing about a check that is not partly posted", () => {
    for (const status of ["approved", "posting", "posted", "failed", "blocked", "withdrawn"]) {
      expect(stuckKind({ status, step: "confirm_patient" })).toBeNull();
    }
  });

  it("names where a stopped run stopped, in the same words as the step list", () => {
    expect(stoppedWhile("reconcile")).toBe("while reading the check back");
    expect(stoppedWhile("claimproc_writes")).toBe("while writing each line's adjudication");
    expect(stoppedWhile(null)).toBe("before it recorded which step it had reached");
  });
});

describe("W-16 · STOPPED: nothing from the fix path is reachable", () => {
  const stopped = [null, ...POSTING_STEPS.filter((s) => s !== "confirm_patient")];

  for (const step of stopped) {
    for (const lastError of [REMEDIATION_ERROR, CRASH_ERROR]) {
      it(`step ${String(step)} · ${lastError === CRASH_ERROR ? "a crash" : "a chart instruction"}`, async () => {
        state.auth = ADMIN; // the widest permission: nothing may unlock the fix path
        state.confirmed = { "c-1": confirmedVerdict() }; // even a stale red verdict on record
        const { container } = renderAt(
          <StuckAfterPosting detail={detail({ step, lastError })} office="roland" batchId="b-1" />,
        );

        expect(screen.getByTestId("stuck-stopped")).toBeTruthy();
        expect(screen.getByTestId("stuck-stopped-step").textContent).toContain(stoppedWhile(step));

        // NONE of the measured screen — not the figures, the steps, or the read.
        for (const id of [
          "stuck-measured",
          "stuck-money-landed",
          "stuck-numbers",
          "stuck-consequence",
          "stuck-steps",
          "stuck-recheck",
          "stuck-resolved",
        ]) {
          expect(screen.queryByTestId(id), id).toBeNull();
        }

        const text = container.textContent ?? "";
        // The run's own text never reaches the screen — it can carry a chart instruction.
        expect(text).not.toContain("Resolve the extra");
        expect(text).not.toContain("violates check constraint");
        // …and no remediation wording of our own either. ("Correct" is matched
        // as the IMPERATIVE, case-sensitively: the screen's own "nothing here to
        // correct" is the opposite instruction and must not trip this.)
        // (The `office_writeoffs` step's own NAME mentions write-offs — that is
        // where it stopped, a fact — so the fix VERBS are what is banned here.)
        expect(text).not.toMatch(
          /What the chart says|Check it again|adjustment|PatNum|raise the write-off|put back|add a |promised \$/i,
        );
        expect(text).not.toMatch(/\bCorrect\b/);

        // It offers the next posting pass, and says not to change the chart.
        expect(screen.getByTestId("stuck-stopped-next").textContent).toContain(
          "resumes from what the chart shows",
        );
        expect(screen.getByTestId("stuck-stopped-nothing-measured").textContent).toContain(
          "Do not change anything there",
        );
        expect(screen.getByTestId("stuck-stopped-no-reentry").textContent).toContain("#21436");
        expect(screen.getByTestId("stuck-tomorrow")).toBeTruthy();

        // It never went LOOKING for a measurement, either.
        await act(async () => {});
        expect(state.calls.filter((c) => c.startsWith("getClaim"))).toEqual([]);
        expect(state.calls).not.toContain("recheckPosting");
        expect(state.calls).not.toContain("getRcmOfficeSettings");
      });
    }
  }
});

describe("W-16 · MEASURED: green first, then the compare, then the steps", () => {
  it("puts 'the payment did reach Open Dental' first, then promised-vs-chart, then numbered steps", async () => {
    state.confirmed = { "c-1": confirmedVerdict() };
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    const green = screen.getByTestId("stuck-money-landed");
    expect(green.textContent).toContain("The payment did reach Open Dental.");
    expect(green.textContent).toContain("$480.00 was entered against claim #53648 as payment #21436 at");
    expect(green.textContent).toContain("Do not enter it again by hand.");
    expect(green.className).toContain("emerald");

    const numbers = await screen.findByTestId("stuck-compare-c-1");
    const steps = screen.getByTestId("stuck-steps");
    // DOCUMENT ORDER is the argument: green, then the compare, then the steps.
    expect(green.compareDocumentPosition(numbers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(numbers.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const figures = screen.getAllByTestId("stuck-promised").map((n) => n.textContent);
    expect(figures).toEqual(["$0.00"]);
    expect(screen.getByTestId("stuck-measured-figure").textContent).toBe("$30.00");
    expect(numbers.textContent).toContain("What this app promised");
    expect(numbers.textContent).toContain("What the chart says now");
    expect(screen.getByTestId("stuck-consequence").textContent).toBe(
      "Test 2, Stedi would be billed $30.00 more than they should be. The payment is fine; only the write-off is missing.",
    );
  });

  it("names the account, claim, payment, line, amount — and where the adjustment type is", async () => {
    state.confirmed = { "c-1": confirmedVerdict() };
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    const account = await screen.findByTestId("stuck-step-account-c-1");
    expect(account.textContent).toContain("Test 2, Stedi");
    expect(account.textContent).toContain("PatNum 12827");
    const claimStep = screen.getByTestId("stuck-step-claim-c-1").textContent ?? "";
    expect(claimStep).toContain("#53648");
    expect(claimStep).toContain("check #21436");
    expect(claimStep).toContain("leave that payment alone");
    const fix = screen.getByTestId("stuck-step-fix-c-1").textContent ?? "";
    expect(fix).toContain("$30.00");
    expect(fix).toContain("D0274");
    // A biller cannot read the office settings, so the step POINTS at the name.
    expect(fix).toContain("An administrator can see its name under Admin → Office.");
    expect(state.calls).not.toContain("getRcmOfficeSettings");

    expect(screen.getByTestId("stuck-post-again").textContent).toBe(
      "Then press Post to Open Dental for this check again — posting re-reads Open Dental first and resumes from what the chart shows.",
    );
    expect(screen.getByTestId("stuck-tomorrow").textContent).toContain("Nothing you have done is lost.");
  });

  it("names the practice's own adjustment type for somebody who may read it", async () => {
    state.auth = ADMIN;
    state.settings = {
      office: "roland",
      drainEnabled: true,
      writeoffMode: "adjustment_by_name",
      writeoffAdjTypeName: "Synthetic courtesy write-off",
    };
    state.confirmed = { "c-1": confirmedVerdict() };
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("stuck-step-fix-c-1").textContent).toContain(
        "“Synthetic courtesy write-off”",
      ),
    );
  });

  it("claims no cause when the gap is not exactly the office's write-off", async () => {
    state.confirmed = { "c-1": confirmedVerdict({ projectedPatientCents: 2000 }) };
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("stuck-consequence").textContent).toBe(
        "Test 2, Stedi would be billed $20.00 more than they should be. The payment is fine; the difference is on the D0274 line.",
      ),
    );
    expect(screen.getByTestId("stuck-step-fix-c-1").textContent).toContain(
      "Correct the D0274 line so Test 2, Stedi owes $0.00",
    );
  });

  it("falls back to the server's measured sentence when the claim read fails", async () => {
    state.claimFails = true;
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    await waitFor(() => expect(state.calls).toContain("getClaim:c-1"));
    expect(screen.getByTestId("stuck-measured-figure").textContent).toBe(RED_SENTENCE);
    expect(screen.getByTestId("stuck-money-landed")).toBeTruthy();
  });

  it("offers the re-check, labelled as a read — and a clean answer takes the stuck panel down", async () => {
    state.confirmed = { "c-1": confirmedVerdict() };
    state.recheck = {
      office: "roland",
      queueId: "q-1",
      status: "partially_posted",
      agreed: true,
      checkedAt: "2026-03-05T19:10:00.000Z",
      claims: [],
    };
    renderAt(<StuckAfterPosting detail={detail()} office="roland" batchId="b-1" />);

    const button = screen.getByTestId("stuck-recheck");
    expect(button.textContent).toBe("Check it again — reads the chart, writes nothing");
    fireEvent.click(button);

    const resolved = await screen.findByTestId("stuck-resolved");
    expect(state.calls.filter((c) => c === "recheckPosting")).toHaveLength(1);
    // The disagreement is gone, so its screen is gone…
    expect(screen.queryByTestId("stuck-measured")).toBeNull();
    expect(screen.queryByTestId("stuck-steps")).toBeNull();
    // …and it does NOT claim a finish that has not happened.
    expect(resolved.textContent).not.toMatch(/Finished/);
    expect(screen.getByTestId("stuck-resolved-next").textContent).toContain("One press left");
  });
});

describe("the two branches, through the check's own page", () => {
  it("routes a stopped check and a measured one to different screens", async () => {
    state.detail = detail({ step: "reconcile", lastError: CRASH_ERROR });
    const first = renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    expect(await screen.findByTestId("stuck-stopped")).toBeTruthy();
    expect(screen.queryByTestId("stuck-recheck")).toBeNull();
    // PostThisCheck prints `lastError` on no stuck path.
    expect(screen.queryByTestId("post-this-check-last-error")).toBeNull();
    first.unmount();

    state.detail = detail({ step: "confirm_patient" });
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    expect(await screen.findByTestId("stuck-measured")).toBeTruthy();
    expect(screen.getByTestId("stuck-recheck")).toBeTruthy();
  });
});

describe("W-16 on the Posting history screen", () => {
  it("shows a stopped row without its run error, and a measured row with the way to the fix", async () => {
    state.auth = ADMIN;
    state.queue = {
      office: "roland",
      rows: [
        planRow({ queueId: "q-a", batchId: "b-1", step: "reconcile", lastError: REMEDIATION_ERROR }),
        planRow({ queueId: "q-b", batchId: "b-2", step: "confirm_patient" }),
      ],
      byStatus: { approved: 0, posting: 0, posted: 0, failed: 0, partially_posted: 2, blocked: 0, withdrawn: 0 },
      total: 2,
      limit: 50,
      offset: 0,
      canDrain: true,
      drainRequires: "rcm.post",
      postingEnabled: true,
      drainEnabled: true,
    };
    const { container } = renderAt(<PostingQueue />, "/rcm/posting");

    const stopped = await screen.findByTestId("posting-stopped-q-a");
    expect(stopped.textContent).toContain("while reading the check back");
    expect(stopped.textContent).toContain("Nothing on this screen is a reason to change a chart.");
    expect(container.textContent).not.toContain("Resolve the extra");
    expect(screen.queryByTestId("posting-error-q-a")).toBeNull();

    const measured = screen.getByTestId("posting-measured-q-b");
    expect(measured.textContent).toContain("The payment did reach Open Dental as payment #21436");
    expect(screen.getByTestId("posting-measured-sentence-q-b").textContent).toBe(RED_SENTENCE);
    expect(screen.getByTestId("posting-measured-open-q-b").getAttribute("href")).toBe(
      "/rcm/remittances/b-2",
    );
  });
});

describe("the consequence sentence, unit by unit", () => {
  const read = (v: ClaimVerdict): ConfirmedRead => ({
    status: "loaded",
    missing: [],
    claims: [
      { claimId: "c-1", patientName: "Test, MangoTest", odPatientId: 12828, odClaimNum: 1, verdict: v, confirmedAt: null },
    ],
  });

  it("names the direction and the amount, and a cause only when it is proven", () => {
    const [more] = disagreementsOf(read(confirmedVerdict()));
    expect(more.writeOffMissing).toBe(true);
    expect(consequenceSentence(more)).toContain("only the write-off is missing");

    const [less] = disagreementsOf(read(confirmedVerdict({ projectedPatientCents: 0, eobPatientCents: 4000 })));
    expect(consequenceSentence(less)).toBe(
      "Test, MangoTest would be billed $10.00 less than they should be. The payment is fine; the difference is on the D0274 line.",
    );
  });

  it("uses they/them, never a guessed pronoun", () => {
    const [d] = disagreementsOf(read(confirmedVerdict()));
    expect(consequenceSentence(d)).not.toMatch(/\b(she|he|her|his)\b/i);
  });

  it("collects nothing from a green or amber verdict", () => {
    expect(disagreementsOf(read(AMBER_CONFIRMED))).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · FINISHED — only what was measured · 6 · DEPOSIT
// ═════════════════════════════════════════════════════════════════════════════

describe("FINISHED quotes only what Open Dental was measured as holding", () => {
  const posted = (plan: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
    detail(
      {
        status: "posted",
        statusLabel: "posted",
        step: "document_attach",
        reconciledAt: "2026-03-05T18:58:00.000Z",
        lastError: null,
        documentAttachStatus: "attached",
        ...plan,
      },
      {
        documentAttach: {
          implemented: true,
          status: "attached",
          error: null,
          at: "2026-03-05T18:59:00.000Z",
          documents: [
            {
              odPatientId: 12827,
              odDocNum: 5501,
              description: "EOB",
              status: "attached",
              error: null,
              attachedAt: "2026-03-05T18:59:00.000Z",
            },
          ],
          canRetry: true,
          retryRequires: "rcm.post",
        },
        ...over,
      },
    );

  it("leads with the measured sentence and names its register", async () => {
    state.confirmed = { "c-1": AMBER_CONFIRMED };
    renderAt(
      <PostedOutcome detail={posted()} office="roland" batchId="b-1" nextClaimId={null} remaining={0} checkAmountCents={48000} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("posted-verdict").textContent).toBe(AMBER_CONFIRMED.sentence),
    );
    expect(screen.getByTestId("posted-register").textContent).toContain(
      "Read out of Test 2, Stedi's chart after posting, not calculated by this app.",
    );
    expect(screen.getByTestId("posted-balance").textContent).toBe("$0.00");
  });

  it("lists what landed — each line only when the server sent the fact", async () => {
    state.confirmed = { "c-1": AMBER_CONFIRMED };
    renderAt(
      <PostedOutcome detail={posted()} office="roland" batchId="b-1" nextClaimId={null} remaining={0} checkAmountCents={48000} />,
    );

    await screen.findByTestId("posted-balance");
    expect(screen.getByTestId("posted-payment").textContent).toBe("$480.00");
    expect(screen.getByTestId("posted-payment-num").textContent).toBe("#21436");
    expect(screen.getByTestId("posted-contractual").textContent).toBe("$329.00");
    const wo = screen.getByTestId("posted-office-writeoff-0");
    expect(wo.textContent).toContain("D0274");
    expect(wo.textContent).toContain("$30.00");
    expect(screen.getByTestId("posted-landed").textContent).toContain(
      "X-rays — bitewings — decided by Billing User",
    );
    expect(screen.getByTestId("posted-eob").textContent).toContain("filed into each patient's chart");
    expect(screen.getByTestId("posted-landed").textContent).toContain("DocNum 5501 on PatNum 12827");
  });

  it("omits a fact the server did not send, rather than printing 'not recorded'", async () => {
    renderAt(
      <PostedOutcome
        detail={posted({ odClaimPaymentNum: null, documentAttachStatus: null })}
        office="roland"
        batchId="b-1"
        nextClaimId={null}
        remaining={0}
      />,
    );
    await screen.findByTestId("posted-unmeasured");
    expect(screen.queryByTestId("posted-payment-num")).toBeNull();
    expect(screen.queryByTestId("posted-eob")).toBeNull();
    expect(screen.queryByTestId("posted-balance")).toBeNull();
    expect(screen.getByTestId("posted-landed").textContent).not.toContain("not recorded");
  });

  it("goes on to the next claim, or back to Today when the check is done", async () => {
    const view = renderAt(
      <PostedOutcome detail={posted()} office="roland" batchId="b-1" nextClaimId="c-9" remaining={2} />,
    );
    expect(screen.getByTestId("posted-next-claim").getAttribute("href")).toContain("/rcm/claims/c-9");
    view.unmount();
    renderAt(<PostedOutcome detail={posted()} office="roland" batchId="b-1" nextClaimId={null} remaining={0} />);
    expect(screen.getByTestId("posted-back-today").getAttribute("href")).toBe("/rcm");
  });

  it("DEPOSIT: coming soon, this check's amount beside a dash, and no promise", () => {
    renderAt(
      <PostedOutcome detail={posted()} office="roland" batchId="b-1" nextClaimId={null} remaining={0} checkAmountCents={48000} />,
    );
    const card = screen.getByTestId("deposit-coming-soon");
    expect(card.textContent).toContain("Coming soon");
    expect(card.textContent).toContain("Match this check against the bank");
    expect(card.textContent).toContain("Until then, keep reconciling deposits the way you do today.");
    expect(screen.getByTestId("deposit-check-amount").textContent).toBe("$480.00");
    expect(screen.getByTestId("deposit-bank-amount").textContent).toBe("—");
    // No date, no roadmap.
    expect(card.textContent).not.toMatch(/20\d\d|next (week|month)|in \d+ (days|weeks)/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · WHILE IT RUNS
// ═════════════════════════════════════════════════════════════════════════════

describe("while a posting runs, the control says so and cannot be pressed again", () => {
  it("on the check's own page", async () => {
    state.auth = ADMIN;
    state.detail = detail({ status: "approved", statusLabel: "queued", step: null, odClaimPaymentNum: null, lastError: null });
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);

    const button = (await screen.findByTestId("post-this-check-button")) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toBe("Posting is running");
    expect(screen.getByTestId("post-this-check-running").textContent).toBe(POSTING_RUNNING_COPY);
    // No spinner standing in for the answer, and no fake step counter.
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.parentElement?.textContent ?? "").not.toMatch(/step \d|\d+ of \d+|\d+%/i);

    fireEvent.click(button);
    expect(state.calls.filter((c) => c === "drainPostingQueue")).toHaveLength(1);

    await act(async () => {
      state.drainResolve?.({ office: "roland", outcomes: [], ran: 1, outOfTime: false, remaining: 0, config: null, postingEnabled: true });
    });
  });

  it("when the server says a run already owns the check", async () => {
    state.detail = detail({ status: "posting", statusLabel: "running", step: "check", lastError: null });
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);

    const button = (await screen.findByTestId("post-this-check-button")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("post-this-check-running").textContent).toBe(POSTING_RUNNING_COPY);
  });

  it("on the Posting history screen", async () => {
    state.auth = ADMIN;
    state.queue = {
      office: "roland",
      rows: [],
      byStatus: { approved: 1, posting: 0, posted: 0, failed: 0, partially_posted: 0, blocked: 0, withdrawn: 0 },
      total: 1,
      limit: 50,
      offset: 0,
      canDrain: true,
      drainRequires: "rcm.post",
      postingEnabled: true,
      drainEnabled: true,
    };
    renderAt(<PostingQueue />, "/rcm/posting");

    const button = (await screen.findByTestId("posting-drain-roland")) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toBe("Posting is running");
    expect(screen.getByTestId("posting-drain-reason-roland").textContent).toBe(POSTING_RUNNING_COPY);
    fireEvent.click(button);
    expect(state.calls.filter((c) => c === "drainPostingQueue")).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · ALREADY APPROVED
// ═════════════════════════════════════════════════════════════════════════════

const ALREADY = () =>
  new RcmApiError("Everything on this check is already approved.", 409, "NOTHING_APPROVABLE", {
    alreadyApproved: true,
  });

describe("an already-approved answer routes to the Posting screen, never back to the button", () => {
  it("on the approve page", async () => {
    state.approveError = ALREADY();
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    fireEvent.click(await screen.findByTestId("approve-button"));
    const answer = await screen.findByTestId("approve-already-approved");
    expect(answer.textContent).toContain("Already approved — see it on the Posting screen");
    expect(screen.getByTestId("approve-already-approved-link").getAttribute("href")).toBe("/rcm/posting");
    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.queryByTestId("approve-error")).toBeNull();
  });

  it("an ordinary refusal still reads as one", async () => {
    state.approveError = new RcmApiError("Nothing on this remittance can be posted yet.", 409, "NOTHING_APPROVABLE", {
      alreadyApproved: false,
    });
    renderAt(<ApproveCheck />, "/rcm/remittances/b-1/approve");

    fireEvent.click(await screen.findByTestId("approve-button"));
    expect((await screen.findByTestId("approve-error")).textContent).toContain("can be posted yet");
    expect(screen.queryByTestId("approve-already-approved")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · W-4 · THE PERMANENT PATH ASKS FIRST
// ═════════════════════════════════════════════════════════════════════════════

const TAKEBACK = {
  office: "roland",
  batchId: "b-1",
  claims: [
    {
      claimId: "c-1",
      claimNumber: "53863",
      patientName: "Test, MangoTest",
      postable: true,
      alreadyQueued: false,
      failed: [],
      checks: [
        { code: "RECOUPMENT_CONFIRMED", label: "x", passed: true, detail: null, fix: "…" },
        { code: "MATCH_CONFIRMED", label: "x", passed: true, detail: "ClaimNum 53863", fix: "…" },
      ],
    },
  ],
  recoupmentClaims: 1,
  recoupmentTotalCents: -2900,
  typedTotalExpected: "-29.00",
  paths: ["adjustment", "supplemental"],
  defaultPath: "adjustment",
  balanced: true,
  differenceCents: 0,
  canApprove: true,
  approveRequires: "rcm.write",
};

function renderPanel() {
  return render(
    <WouterRouter hook={memoryLocation({ path: "/rcm/remittances/b-1" }).hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <RecoupmentPanel office="roland" batchId="b-1" claims={[]} />
      </ThemeProvider>
    </WouterRouter>,
  );
}

describe("W-4 · the permanent path cannot become selected by a single click", () => {
  const radio = (p: string) => screen.getByTestId(`recoupment-path-${p}`) as HTMLInputElement;

  it("keeps the adjustment selected and asks, with decline focused", async () => {
    state.recoupment = TAKEBACK;
    renderPanel();
    await screen.findByTestId("recoupment-panel");
    expect(radio("adjustment").checked).toBe(true);

    fireEvent.click(radio("supplemental"));

    // ONE CLICK DID NOT SELECT IT.
    expect(radio("supplemental").checked).toBe(false);
    expect(radio("adjustment").checked).toBe(true);
    expect(screen.queryByTestId("recoupment-permanent-warning")).toBeNull();
    // It asks — consequence-labelled, decline first and focused.
    expect(screen.getByTestId("recoupment-permanent-yes").textContent).toBe(
      "Use the permanent one — it can never be undone",
    );
    expect(document.activeElement).toBe(screen.getByTestId("recoupment-permanent-cancel"));
  });

  it("declines back to the adjustment, by button or by Escape", async () => {
    state.recoupment = TAKEBACK;
    renderPanel();
    await screen.findByTestId("recoupment-panel");

    fireEvent.click(radio("supplemental"));
    fireEvent.click(screen.getByTestId("recoupment-permanent-cancel"));
    expect(screen.queryByTestId("recoupment-permanent-confirm")).toBeNull();
    expect(radio("adjustment").checked).toBe(true);

    fireEvent.click(radio("supplemental"));
    fireEvent.keyDown(screen.getByTestId("recoupment-permanent-confirm"), { key: "Escape" });
    expect(screen.queryByTestId("recoupment-permanent-confirm")).toBeNull();
    expect(radio("supplemental").checked).toBe(false);
  });

  it("switches only on the explicit confirm, and back to the adjustment in one click", async () => {
    state.recoupment = TAKEBACK;
    renderPanel();
    await screen.findByTestId("recoupment-panel");

    fireEvent.click(radio("supplemental"));
    fireEvent.click(screen.getByTestId("recoupment-permanent-yes"));
    expect(radio("supplemental").checked).toBe(true);
    expect(screen.getByTestId("recoupment-permanent-warning")).toBeTruthy();

    // The typed confirmation is untouched, and carries the chosen path.
    fireEvent.change(screen.getByTestId("recoupment-confirm-input"), { target: { value: "-29.00" } });
    fireEvent.click(screen.getByTestId("recoupment-approve-button"));
    await waitFor(() => expect(state.calls).toContain("approveRecoupment:supplemental"));
  });

  it("moving away from the permanent path costs one click", async () => {
    state.recoupment = TAKEBACK;
    renderPanel();
    await screen.findByTestId("recoupment-panel");
    fireEvent.click(radio("supplemental"));
    fireEvent.click(screen.getByTestId("recoupment-permanent-yes"));
    fireEvent.click(radio("adjustment"));
    expect(radio("adjustment").checked).toBe(true);
    expect(screen.queryByTestId("recoupment-permanent-confirm")).toBeNull();
  });

  it("an already-approved takeback routes to the Posting screen and retires the button", async () => {
    state.recoupment = TAKEBACK;
    state.recoupError = ALREADY();
    renderPanel();
    await screen.findByTestId("recoupment-panel");
    fireEvent.change(screen.getByTestId("recoupment-confirm-input"), { target: { value: "-29.00" } });
    fireEvent.click(screen.getByTestId("recoupment-approve-button"));

    expect((await screen.findByTestId("recoupment-already-approved")).textContent).toContain(
      "Already approved — see it on the Posting screen",
    );
    expect(screen.queryByTestId("recoupment-approve-button")).toBeNull();
    expect(screen.queryByTestId("recoupment-error")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · SHADOW — the worksheet
// ═════════════════════════════════════════════════════════════════════════════

describe("the shadow worksheet", () => {
  const claims = [
    {
      claimId: "c-1",
      claimNumber: "53648",
      patientName: "Test 2, Stedi",
      postable: true,
      alreadyQueued: true,
      checks: [],
      failed: [],
      verdict: {
        state: "amber",
        register: "projection",
        eobPatientCents: 3000,
        projectedPatientCents: 0,
        decidedWriteOffCents: 3000,
        contractualWriteOffCents: 32900,
        decisions: [],
        problems: [],
        sentence: "x",
      },
    },
  ] as never;

  it("shows payment, office write-off and what the patient would owe, per claim", () => {
    renderAt(
      <ShadowModeBanner office="roland" claims={claims} approved paidByClaim={new Map([["c-1", 48000]])} />,
    );
    const row = screen.getByTestId("shadow-row-c-1");
    expect(screen.getByTestId("shadow-paid-c-1").textContent).toBe("$480.00");
    expect(row.textContent).toContain("$30.00");
    expect(row.textContent).toContain("$0.00");
    expect(screen.getByTestId("shadow-would-have-done").textContent).toContain(
      "What this app would have done, if posting were on",
    );
    expect(screen.getByTestId("shadow-banner-body").textContent).toBe(SHADOW_MODE_COPY.banner);
  });

  it("is not drawn before the approve", () => {
    renderAt(<ShadowModeBanner office="roland" claims={claims} />);
    expect(screen.queryByTestId("shadow-would-have-done")).toBeNull();
    expect(screen.getByTestId("shadow-mode-banner")).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 · ADMIN CARDS SHOW A PERSON'S NAME
// ═════════════════════════════════════════════════════════════════════════════

describe("the RCM admin cards name a person, not an address", () => {
  it("the posting switch: the signed-in admin's own key becomes their name", async () => {
    state.auth = ADMIN;
    state.settings = {
      office: "roland",
      drainEnabled: false,
      updatedAt: "2026-03-05T18:00:00.000Z",
      updatedBy: "admin@example.invalid",
      postingEnabled: true,
      rowMissing: false,
      writeoffMode: "writeoff_field",
      writeoffModes: ["writeoff_field", "adjustment_by_name"],
      writeoffAdjTypeName: null,
    };
    renderAt(<RcmPostingSettingsCard />, "/admin");
    const line = await screen.findByTestId("rcm-posting-changed-roland");
    expect(line.textContent).toContain("by Admin Person.");
    expect(line.textContent).not.toContain("@");
  });

  it("the comparison summary: the same, and a colleague's name stays what the server sent", async () => {
    state.auth = ADMIN;
    state.summary = {
      office: "roland",
      from: null,
      to: null,
      compared: 2,
      same: 0,
      differed: 2,
      matchedRun: 0,
      comparedAllTime: 2,
      differences: [
        { batchId: "b-1", checkNumber: "830200001", payer: "SYNTHETIC DENTAL", depositDate: null, reason: "payment_amount", note: "n", answeredAt: "2026-03-05T18:00:00.000Z", answeredBy: "admin@example.invalid", revision: 1 },
        { batchId: "b-2", checkNumber: "830200002", payer: "SYNTHETIC DENTAL", depositDate: null, reason: "payment_amount", note: "n", answeredAt: "2026-03-05T18:00:00.000Z", answeredBy: "Billing Person", revision: 1 },
      ],
    };
    renderAt(<RcmShadowComparisonCard />, "/admin");
    const mine = await screen.findByTestId("rcm-comparison-row-b-1");
    expect(mine.textContent).toContain("Admin Person");
    expect(mine.textContent).not.toContain("@");
    expect(screen.getByTestId("rcm-comparison-row-b-2").textContent).toContain("Billing Person");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9 · THE TAKEBACK PROCEDURE PAGE
// ═════════════════════════════════════════════════════════════════════════════

describe("the takeback procedure leads with the panel", () => {
  it("puts the panel first, keeps the manual steps for takebacks outside CareIN, and admits what is missing", () => {
    const { container } = renderAt(<TakebackSop />, "/rcm/sop/takeback");
    const panel = screen.getByTestId("takeback-panel-procedure");
    const manual = screen.getByTestId("takeback-manual-procedure");
    expect(panel.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).toContain("use the takeback panel");
    expect(panel.textContent).toContain("The adjustment is the default");
    expect(manual.textContent).toContain("arrives outside CareIN");
    expect(screen.getByTestId("takeback-placeholder").textContent).toContain(
      "written procedure is still to come",
    );
    // The page that said CareIN would never post one is gone.
    expect(container.textContent).not.toContain("CareIN will not post a takeback");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SENTENCES WRAP
// ═════════════════════════════════════════════════════════════════════════════

describe("the new sentence surfaces never clip a sentence", () => {
  it("carries no truncation class", () => {
    const CLIPPING = /\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d+)\b/;
    for (const rel of [
      "client/src/components/rcm/PostedOutcome.tsx",
      "client/src/components/rcm/DepositComingSoon.tsx",
      "client/src/components/rcm/AlreadyApproved.tsx",
      "client/src/components/rcm/PermanentPathConfirm.tsx",
      "client/src/pages/rcm/TakebackSop.tsx",
    ]) {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(CLIPPING.test(src), rel).toBe(false);
    }
  });
});
