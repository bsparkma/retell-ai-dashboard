/**
 * STAGE C-2 — "did the app get this check right?", on the screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * The server side of this slice is proven in `backend/routes/rcm/
 * shadowComparison.test.js`, including the one claim everything rests on — that
 * a recorded answer cannot change what posts. What is left is the part only the
 * assembled screen can be wrong about:
 *
 *  · the QUESTION appears on an approved check in shadow mode, and nowhere else;
 *  · YES is one click and no dialog;
 *  · NO opens an INLINE form that does not cover the check underneath it;
 *  · the form will not submit without both the reason and the sentence;
 *  · an answer already given is shown, and can be changed;
 *  · a check that has posted shows the answer and no way to change it;
 *  · the TALLY says what it counts, and never grades the person.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "DOES NOT COVER" IS A STRUCTURAL CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 * Same rule Stage C's suite states: jsdom computes no layout, so the checkable
 * form of "the form is inline, not a modal" is that it carries no out-of-flow
 * positioning and the claim list is still in the document after it. An element
 * in normal flow cannot cover a later sibling.
 *
 * NO NETWORK, NO PHI. Every payer, check number and figure is synthetic.
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { tallySentence, comparisonReasonLabel } from "@/features/rcm/comparison";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function check(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 45000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 45000,
      claimTotalCents: 45000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: false,
    attentionReasons: [] as string[],
    attentionObservations: [] as string[],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
    queuedClaimCount: 1,
    approvalAttemptedAt: "2026-03-02T11:00:00.000Z",
    approvalAttemptedBy: "Billing User",
    parkedAt: null,
    parkedBy: null,
    parkedNote: null,
    setAsideAt: null,
    setAsideBy: null,
    setAsideReason: null,
    setAsideNote: null,
    comparisonVerdict: null,
    comparisonReason: null,
    comparisonNote: null,
    comparisonAt: null,
    comparisonBy: null,
    comparisonRevision: 0,
    lastDecidedAt: null,
    lastDecidedBy: null,
    upload: null,
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Fixture, Synthetic",
    payer: "SYNTHETIC DENTAL",
    serviceDate: "2026-03-02",
    status: "pending_review",
    paymentStatus: "unpaid",
    insuranceType: "primary",
    totalBilledCents: 45000,
    totalAllowedCents: 45000,
    totalPaidCents: 45000,
    totalDeductibleCents: 0,
    patientBalanceCents: 0,
    needsReviewReasons: [] as string[],
    confidence: 95,
    odMatchStatus: "confirmed",
    odClaimNum: 53648,
    odPatientId: null,
    reviewedAt: "2026-03-02T11:00:00.000Z",
    reviewedBy: "Billing User",
    reviewNote: null,
    postingQueueId: "q-1",
    lines: [],
    adjustments: [],
    ...over,
  };
}

const QUEUE = {
  office: "roland",
  plans: [],
  total: 0,
  limit: 50,
  offset: 0,
  postingEnabled: true,
  drainEnabled: false,
  canPost: false,
  offices: ["roland"],
};

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  plans: [] as Record<string, unknown>[],
  approval: null as Record<string, unknown> | null,
  queue: null as Record<string, unknown> | null,
  tally: null as Record<string, unknown> | null,
  recorded: [] as unknown[],
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => ({ status: "loading" }) };
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

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listRemittances: vi.fn(async (office: string) => ({
      office,
      view: "all",
      remittances: state.checks,
      total: state.checks.length,
      needsAttentionCount: 0,
      parkedCount: 0,
      setAsideCount: 0,
      matchingCount: state.checks.length,
      limit: 50,
      offset: 0,
    })),
    getRemittance: vi.fn(async (office: string, batchId: string) => {
      const row = state.checks.find((r) => r.batchId === batchId);
      if (!row) throw new real.RcmApiError("no such check", 404, "REMITTANCE_NOT_FOUND");
      return {
        office,
        remittance: { ...row, plbAdjustments: [], plans: state.plans },
        claims: state.claims,
      };
    }),
    getApprovalPreview: vi.fn(async () => {
      if (!state.approval) throw new real.RcmApiError("no gate", 500, "OOPS");
      return state.approval;
    }),
    listPostingQueue: vi.fn(async () => state.queue ?? QUEUE),
    getComparisonTally: vi.fn(async () => {
      if (!state.tally) throw new real.RcmApiError("no tally", 500, "OOPS");
      return state.tally;
    }),
    recordComparison: vi.fn(async (_office: string, _batchId: string, answer: unknown) => {
      state.recorded.push(answer);
      return { batchId: "b-1", verdict: "same", reason: null, revision: 1, recorded: true };
    }),
    getRecoupmentPreview: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    getRecoupmentChecklist: vi.fn(async () => {
      throw new real.RcmApiError("none", 404, "NOT_FOUND");
    }),
    unparkRemittance: vi.fn(async () => ({ batchId: "b-1", parked: false, wasParked: false })),
    matchRemittance: vi.fn(async () => ({ matched: [], skipped: 0, outOfTime: false, budgetMs: 0, note: "" })),
  };
});

function renderAt(node: React.ReactElement, path: string) {
  const [pathname, search = ""] = path.split("?");
  const memory = memoryLocation({ path: pathname, searchPath: search, record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{node}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

/** An approved check at a practice with posting switched off — the live case. */
function inShadowWithApprovedCheck(over: Record<string, unknown> = {}) {
  state.checks = [check(over)];
  state.claims = [claim()];
  state.plans = [{ queueId: "q-1", status: "approved" }];
  state.queue = { ...QUEUE, postingEnabled: true, drainEnabled: false };
  state.approval = {
    office: "roland",
    batchId: "b-1",
    canApprove: true,
    approveRequires: "rcm.write",
    claims: [],
    postableCount: 0,
    withheldCount: 0,
    queuedCount: 1,
    balanced: true,
    differenceCents: 0,
  };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.checks = [];
  state.claims = [];
  state.plans = [];
  state.approval = null;
  state.queue = null;
  state.tally = null;
  state.recorded = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// WHEN THE QUESTION IS ASKED
// ═══════════════════════════════════════════════════════════════════════════

describe("the question appears exactly where there is a hand posting to compare against", () => {
  it("asks on an approved check while posting is switched off", async () => {
    inShadowWithApprovedCheck();
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const panel = await screen.findByTestId("check-comparison");
    expect(panel.textContent).toContain("Did the app get this check right?");
    expect(screen.getByTestId("comparison-ask").textContent).toContain(
      "You’re the check on the app right now",
    );
    expect(screen.getByTestId("comparison-same")).toBeTruthy();
    expect(screen.getByTestId("comparison-differed")).toBeTruthy();
  });

  it("does NOT ask on a check nobody has approved — there is nothing to compare", async () => {
    /*
     * Until somebody approves, the app has not said what it would do. The server
     * refuses with COMPARISON_NOT_APPROVED; the screen must not offer a control
     * whose press is a refusal.
     */
    inShadowWithApprovedCheck();
    state.plans = [];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("shadow-mode-banner")).toBeTruthy());
    expect(screen.queryByTestId("check-comparison")).toBeNull();
  });

  it("does NOT ask when posting is switched ON — the chart answers that question itself", async () => {
    /*
     * With posting on, the confirmation after a post compares against the chart.
     * Asking a person to repeat a read the app already did would be asking for a
     * worse answer to a question already answered.
     */
    inShadowWithApprovedCheck();
    state.queue = { ...QUEUE, postingEnabled: true, drainEnabled: true };

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("rcm-remittance-detail");
    await waitFor(() => expect(screen.getByTestId("claims-sanity")).toBeTruthy());
    expect(screen.queryByTestId("check-comparison")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ANSWERING
// ═══════════════════════════════════════════════════════════════════════════

describe("answering", () => {
  it("YES is one click and no dialog", async () => {
    inShadowWithApprovedCheck();
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("comparison-same"));

    await waitFor(() => expect(state.recorded).toEqual([{ verdict: "same" }]));
    // No form was opened on the way — the whole promise of the yes half.
    expect(screen.queryByTestId("comparison-form")).toBeNull();
  });

  it("NO opens an INLINE form that does not cover the check underneath it", async () => {
    inShadowWithApprovedCheck();
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("comparison-differed"));

    const form = await screen.findByTestId("comparison-form");
    // Structural, never pixels — see the header.
    expect(form.className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(form.closest("[role='dialog']")).toBeNull();
    // …and the check is still there, after it, in normal flow.
    expect(screen.getByTestId("claims-sanity")).toBeTruthy();
    expect(
      form.compareDocumentPosition(screen.getByTestId("claims-sanity")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("will not submit without BOTH the reason and the sentence", async () => {
    /*
     * The server refuses either way (400 COMPARISON_REASON_REQUIRED /
     * COMPARISON_NOTE_REQUIRED). The form demands them here so she does not
     * discover the rule by being refused — and the note is required for EVERY
     * reason, not only for "something else": "the payment amount" without the
     * two figures is a report nobody can act on in three weeks.
     */
    inShadowWithApprovedCheck();
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("comparison-differed"));
    await screen.findByTestId("comparison-form");

    const submit = () => screen.getByTestId("comparison-submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    // A reason alone is not enough.
    fireEvent.click(screen.getByTestId("comparison-reason-payment_amount"));
    expect(submit().disabled).toBe(true);

    // Neither is a sentence alone — proven by clearing the reason is impossible
    // once set, so the other direction is asserted on a blank note instead.
    fireEvent.change(screen.getByTestId("comparison-note-input"), {
      target: { value: "   " },
    });
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("comparison-note-input"), {
      target: { value: "App had $150.00, the carrier paid $142.30." },
    });
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    await waitFor(() =>
      expect(state.recorded).toEqual([
        {
          verdict: "differed",
          reason: "payment_amount",
          note: "App had $150.00, the carrier paid $142.30.",
        },
      ]),
    );
  });

  it("offers the five reasons and nothing else", async () => {
    inShadowWithApprovedCheck();
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("comparison-differed"));
    const form = await screen.findByTestId("comparison-form");
    expect(form.querySelectorAll("input[type='radio']").length).toBe(5);
    expect(form.textContent).toContain("The payment amount");
    expect(form.textContent).toContain("The wrong claim or the wrong patient");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AN ANSWER ALREADY GIVEN
// ═══════════════════════════════════════════════════════════════════════════

describe("an answer already given", () => {
  it("is shown back, with the sentence and who gave it, and can be changed", async () => {
    inShadowWithApprovedCheck({
      comparisonVerdict: "differed",
      comparisonReason: "write_off",
      comparisonNote: "The office absorbed $60.00; the app had nothing.",
      comparisonAt: "2026-03-03T02:10:00.000Z",
      comparisonBy: "Billing User",
      comparisonRevision: 1,
    });
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const answered = await screen.findByTestId("comparison-answered");
    expect(answered.textContent).toContain("You marked this off — a write-off.");
    expect(screen.getByTestId("comparison-note").textContent).toContain("absorbed $60.00");
    expect(screen.getByTestId("comparison-stamp").textContent).toContain("Billing User");
    expect(screen.getByTestId("comparison-change")).toBeTruthy();
  });

  it("opens the form PRE-FILLED, so changing the sentence is not retyping the reason", async () => {
    inShadowWithApprovedCheck({
      comparisonVerdict: "differed",
      comparisonReason: "write_off",
      comparisonNote: "The office absorbed $60.00.",
      comparisonAt: "2026-03-03T02:10:00.000Z",
      comparisonBy: "Billing User",
      comparisonRevision: 1,
    });
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("comparison-change"));
    await screen.findByTestId("comparison-form");
    expect((screen.getByTestId("comparison-reason-write_off") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("comparison-note-input") as HTMLTextAreaElement).value).toContain(
      "absorbed $60.00",
    );
  });

  it("says out loud that it was CHANGED rather than presenting the newest as the only one", async () => {
    inShadowWithApprovedCheck({
      comparisonVerdict: "same",
      comparisonAt: "2026-03-03T02:10:00.000Z",
      comparisonBy: "Billing User",
      comparisonRevision: 2,
    });
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const stamp = await screen.findByTestId("comparison-stamp");
    expect(stamp.textContent).toContain("changed once");
  });

  it("a check that has POSTED shows the answer and no way to change it, and says why", async () => {
    /*
     * A control that silently disappears reads as a bug. The money is on the
     * chart now, so there is no hand posting left to compare against — the
     * answer given while there was one is the true one.
     */
    inShadowWithApprovedCheck({
      comparisonVerdict: "same",
      comparisonAt: "2026-03-03T02:10:00.000Z",
      comparisonBy: "Billing User",
      comparisonRevision: 1,
    });
    state.plans = [{ queueId: "q-1", status: "posted" }];

    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await screen.findByTestId("comparison-answered");
    expect(screen.getByTestId("comparison-closed").textContent).toContain(
      "This check has posted",
    );
    expect(screen.queryByTestId("comparison-change")).toBeNull();
    expect(screen.queryByTestId("comparison-same")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE TALLY
// ═══════════════════════════════════════════════════════════════════════════

describe("the tally counts what it says it counts", () => {
  it("names the single difference, with its reason and its day", () => {
    expect(
      tallySentence({
        compared: 18,
        same: 17,
        differed: 1,
        latestDifference: { reason: "payment_amount", at: "2026-08-22T18:00:00.000Z" },
      }),
    ).toBe("So far: 18 checks compared, you marked 17 the same and 1 off (the payment amount, Aug 22).");
  });

  it("counts them once there is more than one — a sentence does not grow a clause per difference", () => {
    expect(
      tallySentence({
        compared: 18,
        same: 15,
        differed: 3,
        latestDifference: { reason: "write_off", at: "2026-08-22T18:00:00.000Z" },
      }),
    ).toBe("So far: 18 checks compared, you marked 15 the same and 3 off.");
  });

  it("says so plainly when every one so far came out the same", () => {
    expect(tallySentence({ compared: 4, same: 4, differed: 0, latestDifference: null })).toBe(
      "So far: 4 checks compared, and you marked them all the same.",
    );
    expect(tallySentence({ compared: 1, same: 1, differed: 0, latestDifference: null })).toBe(
      "So far: 1 check compared, and you marked it the same.",
    );
  });

  it("says NOTHING at all before the first answer", () => {
    // A line reading zero would be the screen making a point of an absence she
    // is about to fix.
    expect(tallySentence({ compared: 0, same: 0, differed: 0, latestDifference: null })).toBe(null);
  });

  it("never scores, rates, grades or averages — she is checking the software", () => {
    /*
     * THE RULE THIS WHOLE SLICE TURNS ON. If the copy ever reads as though she
     * is the one being measured, she stops answering honestly — and an honest
     * answer is the entire product of the shadow period.
     *
     * The banned-word guard covers the source; this covers the one string that
     * is ASSEMBLED at runtime and so appears in no source file.
     */
    const sentences = [
      tallySentence({ compared: 18, same: 17, differed: 1, latestDifference: { reason: "other", at: null } }),
      tallySentence({ compared: 9, same: 9, differed: 0, latestDifference: null }),
      tallySentence({ compared: 5, same: 0, differed: 5, latestDifference: null }),
    ].join(" ");
    for (const word of [/\bscor/i, /\baccura/i, /\bgrade/i, /\bcorrect/i, /\brate\b/i, /%/, /\bstreak/i, /\bin a row\b/i]) {
      expect(sentences).not.toMatch(word);
    }
  });

  it("falls back to the raw slug rather than to nothing when the server widens the list", () => {
    expect(comparisonReasonLabel("something_new_server_side")).toBe("something_new_server_side");
    expect(comparisonReasonLabel(null)).toBe("something else");
  });

  it("renders on the check, and a tally that could not be read never blocks the ask", async () => {
    inShadowWithApprovedCheck();
    state.tally = {
      office: "roland",
      compared: 18,
      same: 17,
      differed: 1,
      matchedRun: 0,
      latestDifference: { reason: "payment_amount", at: "2026-08-22T18:00:00.000Z" },
    };
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    const tally = await screen.findByTestId("comparison-tally");
    expect(tally.textContent).toContain("18 checks compared");
    // The RUN is not shown to her at all — it is the admin's number, and a run
    // on her screen is a streak, which is a thing people protect.
    expect(tally.textContent).not.toContain("in a row");

    cleanup();
    state.tally = null;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");
    await screen.findByTestId("comparison-same");
    expect(screen.queryByTestId("comparison-tally")).toBeNull();
  });
});
