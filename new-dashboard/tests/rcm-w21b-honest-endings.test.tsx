/**
 * W-21b — HONEST ENDINGS. Two rows the screens used to get wrong, rendered for
 * real so the guards below judge markup a case actually produces.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. BLOCKED AFTER A WRITE CARRIES THE PROOF BLOCK
 * ═════════════════════════════════════════════════════════════════════════════
 * `no_adj_type` refuses a takeback AFTER the plan's check is in the chart. The
 * row is `blocked` — which reads as "nothing was attempted" — over a payment
 * that landed. Such a row carries the check number, and both screens render the
 * SAME proof block (`EarlierCheckProof`): number, do-not-re-enter, no amount,
 * no remediation. A blocked row with no check renders exactly as before.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE UNSETTLEABLE CASE STOPS OFFERING A DEAD PRESS
 * ═════════════════════════════════════════════════════════════════════════════
 * `outcome_unknown` whose claim was deleted in Open Dental: every press reads the
 * same 404, forever. The drain records `read_od_truth_claim_gone`; the screens
 * name the situation and stop presenting Post as the way out. The status itself
 * is unchanged and stays drainable (D-15).
 *
 * NO REAL PATIENT DATA. Synthetic names; PatNum 12827 is the documented fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { ClaimVerdict, PostingQueueDetail } from "@/features/rcm/api";
import { POSTING_STEPS } from "@/features/rcm/api";
import {
  OUTCOME_UNKNOWN_COPY,
  QUEUE_STATE_COPY,
  queueHint,
  STEP_COPY,
  stoppedWhile,
  stuckKind,
} from "@/features/rcm/posting";
import { postStepFor } from "@/features/rcm/flow";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: { status: "loading" } as unknown,
  detail: null as unknown,
  confirmed: {} as Record<string, unknown>,
  queue: null as unknown,
  calls: [] as string[],
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
      return null;
    }),
    recheckPosting: vi.fn(async () => {
      state.calls.push("recheckPosting");
      return null;
    }),
    drainPostingQueue: vi.fn(() => new Promise(() => {})),
    listPostingQueue: vi.fn(async () => state.queue),
  };
});

import { StuckAfterPosting } from "@/components/rcm/PostedOutcome";
import PostThisCheck from "@/components/rcm/PostThisCheck";
import PostingQueue from "@/pages/rcm/PostingQueue";
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

// ─── Fixtures — synthetic only ───────────────────────────────────────────────

/** What a crash leaves in `lastError`: a database message, never a measurement. */
const CRASH_ERROR =
  "FakeRcmDb: injected failure on: UPDATE rcm_claims SET confirmed_verdict = $3";

/** A red verdict ON RECORD — the stopped screen must not go looking for it. */
const STALE_RED: ClaimVerdict = {
  state: "red",
  register: "confirmed",
  eobPatientCents: 3000,
  projectedPatientCents: 3000,
  decidedWriteOffCents: 3000,
  contractualWriteOffCents: 32900,
  decisions: [],
  problems: [{ kind: "chart_disagrees", code: "D0274", lineId: "l-2", detail: "D0274 reads $30.00." }],
  sentence: "Open Dental says the patient owes $30.00 — this check said $0.00.",
};

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
    step: "confirm_patient_interrupted",
    isRecoupment: false,
    documentAttachStatus: null,
    carrierEobDate: "2026-03-01",
    intendedTotalCents: 48000,
    postedTotalCents: 48000,
    odClaimPaymentNum: 21436,
    reconciledAt: null,
    approvedAt: "2026-03-05T18:50:00.000Z",
    approvedBy: "Billing User",
    startedAt: "2026-03-05T18:57:00.000Z",
    finishedAt: "2026-03-05T18:58:00.000Z",
    drainAttemptAt: "2026-03-05T18:57:00.000Z",
    drainedBy: "Billing User",
    attemptCount: 1,
    lastError: CRASH_ERROR,
    checkNumber: "830200001",
    payer: "SYNTHETIC DENTAL",
    ...over,
  };
}

function detail(plan: Record<string, unknown> = {}): PostingQueueDetail {
  return {
    office: "roland",
    plan: planRow(plan),
    lines: [
      {
        queueLineId: "ql-1",
        position: 1,
        odClaimNum: 53648,
        odClaimProcNum: 533930,
        status: "paid",
        skipReason: null,
        intendedInsPayAmtCents: 48000,
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
        intendedPatientCents: 0,
        odWriteoffAdjustmentNum: null,
      },
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
  } as unknown as PostingQueueDetail;
}

function queuePage(rows: Record<string, unknown>[], byStatus: Record<string, number>) {
  return {
    office: "roland",
    rows,
    byStatus: {
      approved: 0,
      posting: 0,
      posted: 0,
      failed: 0,
      partially_posted: 0,
      blocked: 0,
      withdrawn: 0,
      outcome_unknown: 0,
      ...byStatus,
    },
    total: rows.length,
    limit: 50,
    offset: 0,
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
  };
}


import fs from "node:fs";
import path from "node:path";
import { blockedCopy, CLAIM_GONE_COPY, CLAIM_GONE_STEP, claimGone } from "@/features/rcm/posting";

/** A dollar figure, as `money()` prints one. */
const FIGURE = /\$\s?\d/;
/** Remediation a proof block must never give — the verbs of the fix path. */
const REMEDIATION = /What the chart says|Check it again|raise the write-off|put back|add a |promised \$|Resolve the extra/i;
const PRESS_AGAIN = /press post/i;
const PROOF_TEXT =
  "An Open Dental check #21436 from an earlier run exists. Do not enter this payment again by hand.";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.auth = ADMIN;
  state.detail = null;
  state.confirmed = {};
  state.queue = null;
  state.calls = [];
});

afterEach(cleanup);

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// ═════════════════════════════════════════════════════════════════════════════
// 1. BLOCKED AFTER A WRITE
// ═════════════════════════════════════════════════════════════════════════════

/** What the drain leaves after `no_adj_type` fires behind a landed check. */
const BLOCKED_AFTER_CHECK = {
  status: "blocked",
  statusLabel: "blocked",
  blockedReason: "no_adj_type",
  step: "recoupment",
  isRecoupment: true,
  odClaimPaymentNum: 21436,
  postedTotalCents: 0,
  lastError: "No recoupment adjustment type. Nothing was sent for this line.",
};

describe("W-21b · a blocked plan whose check landed carries the proof block", () => {
  it("on the Posting history: the proof block, ahead of the reason — no amount, no remediation, no retire", async () => {
    state.queue = queuePage([planRow(BLOCKED_AFTER_CHECK)], { blocked: 1 });
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");

    const proof = screen.getByTestId("posting-earlier-check-q-1");
    expect(squash(proof.textContent)).toBe(PROOF_TEXT);
    expect(proof.textContent, "never an amount").not.toMatch(FIGURE);
    expect(proof.textContent, "never remediation").not.toMatch(REMEDIATION);

    // The warning is read FIRST: the proof precedes the blocking reason.
    const reason = screen.getByTestId("posting-blocked-q-1");
    expect(proof.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const copy = blockedCopy("no_adj_type")!;
    expect(squash(reason.textContent)).toBe(squash(copy.label + copy.fix));

    // Retiring would say "this will never post" over money in the chart.
    expect(screen.queryByTestId("posting-withdraw-open-q-1")).toBeNull();
    expect(screen.queryByTestId("posting-withdraw-panel-q-1")).toBeNull();
  });

  it("on the check's own page: the SAME proof block, never the green one with an amount", async () => {
    state.detail = detail(BLOCKED_AFTER_CHECK);
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("post-this-check");

    const proof = screen.getByTestId("post-this-check-earlier-check");
    expect(squash(proof.textContent)).toBe(PROOF_TEXT);
    expect(proof.textContent).not.toMatch(FIGURE);
    expect(screen.queryByTestId("post-this-check-proof")).toBeNull();
    expect(screen.queryByTestId("post-this-check-last-error")).toBeNull();
  });

  it("the two screens render one presentation — same markup, different test id", async () => {
    state.queue = queuePage([planRow(BLOCKED_AFTER_CHECK)], { blocked: 1 });
    renderAt(<PostingQueue />, "/rcm/posting");
    const history = await screen.findByTestId("posting-earlier-check-q-1");
    const historyHtml = history.outerHTML.replace(/ data-testid="[^"]*"/, "");
    cleanup();

    state.detail = detail(BLOCKED_AFTER_CHECK);
    renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    const page = await screen.findByTestId("post-this-check-earlier-check");
    expect(page.outerHTML.replace(/ data-testid="[^"]*"/, "")).toBe(historyHtml);
  });

  it("a blocked plan with NO check is unchanged: no proof block, the reason, and retire is still offered", async () => {
    state.queue = queuePage([planRow({ ...BLOCKED_AFTER_CHECK, odClaimPaymentNum: null })], {
      blocked: 1,
    });
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");

    expect(screen.queryByTestId("posting-earlier-check-q-1")).toBeNull();
    expect(screen.getByTestId("posting-blocked-q-1")).toBeTruthy();
    expect(screen.getByTestId("posting-withdraw-open-q-1")).toBeTruthy();
    expect(screen.getByTestId("posting-hint-q-1").textContent).toBe(QUEUE_STATE_COPY.blocked.hint);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE CLAIM IS GONE
// ═════════════════════════════════════════════════════════════════════════════

const CLAIM_GONE = {
  status: "outcome_unknown",
  statusLabel: "outcome_unknown",
  step: "read_od_truth_claim_gone",
  postedTotalCents: 0,
  lastError:
    "Open Dental has no claim 53648 in this office, but this plan has already written to a chart on a previous attempt.",
};

describe("W-21b · the claim-gone vocabulary", () => {
  it("is one slug, mirrored from the drain, with its own step copy", () => {
    expect(CLAIM_GONE_STEP).toBe("read_od_truth_claim_gone");
    expect(POSTING_STEPS).toContain(CLAIM_GONE_STEP);
    const drain = fs.readFileSync(
      path.join(__dirname, "..", "..", "backend", "services", "rcm", "postingDrain.js"),
      "utf8",
    );
    expect(drain).toContain(`const CLAIM_GONE_STEP = '${CLAIM_GONE_STEP}';`);
    expect(STEP_COPY.read_od_truth_claim_gone).toBe(
      "Reading Open Dental and finding the claim no longer there",
    );
    // A partly-posted plan over a deleted claim is still the W-16 STOPPED branch.
    expect(stuckKind({ status: "partially_posted", step: CLAIM_GONE_STEP })).toBe("stopped");
    expect(stoppedWhile(CLAIM_GONE_STEP)).toBe(
      "while reading Open Dental and finding the claim no longer there",
    );
  });

  it("names the situation, and never offers Post as the way out — hint and rail alike", () => {
    const row = planRow(CLAIM_GONE) as never;
    expect(claimGone(row)).toBe(true);
    expect(queueHint(row)).toBe(CLAIM_GONE_COPY);
    expect(CLAIM_GONE_COPY).toMatch(/no longer in Open Dental/);
    expect(CLAIM_GONE_COPY).toMatch(/Check the patient's chart/);
    expect(CLAIM_GONE_COPY).toMatch(/by hand only if the money isn't there/);
    expect(CLAIM_GONE_COPY).not.toMatch(FIGURE);
    const step = postStepFor(row);
    expect(step.state).toBe("blocked");
    expect(step.detail).toBe(CLAIM_GONE_COPY);
  });

  it("an ordinary outcome_unknown is untouched: still the press-again copy", () => {
    const row = planRow({ ...CLAIM_GONE, step: "check" }) as never;
    expect(claimGone(row)).toBe(false);
    expect(queueHint(row)).toBe(OUTCOME_UNKNOWN_COPY);
    expect(postStepFor(row).detail).toBe(OUTCOME_UNKNOWN_COPY);
  });
});

describe("W-21b · an outcome_unknown plan whose claim is gone, rendered", () => {
  it("on the check's own page: no Post button, the situation named, the check proof kept", async () => {
    state.detail = detail(CLAIM_GONE);
    const { container } = renderAt(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);
    await screen.findByTestId("post-this-check");

    expect(screen.queryByTestId("post-this-check-button"), "a dead press is not offered").toBeNull();
    expect(screen.getByTestId("post-this-check-not-postable").textContent).toBe(CLAIM_GONE_COPY);
    expect(screen.getByTestId("post-this-check-hint").textContent).toBe(CLAIM_GONE_COPY);
    expect(squash(screen.getByTestId("post-this-check-earlier-check").textContent)).toBe(PROOF_TEXT);
    expect(screen.getByTestId("post-this-check-state").textContent).toContain("Not confirmed yet");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(PRESS_AGAIN);
    expect(text).not.toContain(OUTCOME_UNKNOWN_COPY);
    expect(text, "never the run's own text").not.toContain("already written to a chart");
  });

  it("on the Posting history: its own panel, no press-again sentence, and the hint names it", async () => {
    state.queue = queuePage([planRow(CLAIM_GONE)], { outcome_unknown: 1 });
    renderAt(<PostingQueue />, "/rcm/posting");
    const card = await screen.findByTestId("posting-plan-q-1");

    expect(screen.getByTestId("posting-state-q-1").textContent).toBe("Not confirmed yet");
    expect(screen.getByTestId("posting-hint-q-1").textContent).toBe(CLAIM_GONE_COPY);
    expect(screen.getByTestId("posting-claim-gone-q-1").textContent).toContain("#21436");
    expect(screen.queryByTestId("posting-unknown-q-1")).toBeNull();
    expect(card.textContent).not.toMatch(PRESS_AGAIN);
    expect(card.textContent).not.toContain("already written to a chart");
  });

  it("with no check on record it does not also say 'do not enter it by hand' — the instruction is conditional", async () => {
    state.queue = queuePage([planRow({ ...CLAIM_GONE, odClaimPaymentNum: null })], {
      outcome_unknown: 1,
    });
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-1");
    expect(screen.getByTestId("posting-claim-gone-q-1").textContent).toBe(
      "Part of this payment may already be in Open Dental.",
    );
  });
});
