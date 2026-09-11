/**
 * RCM UI OVERHAUL, SLICE 6 — THE SMOKE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS
 * ═════════════════════════════════════════════════════════════════════════════
 * The September combined walk (`docs/RCM_COMBINED_WALK.md`), re-run as tests on
 * the screens S1–S5 built. The other RCM suites each pin ONE screen in ONE
 * state. This one WALKS: a biller's day, screen after screen, where every press
 * goes through the real page, reaches a fake server, changes what that server
 * holds, and the NEXT screen is rendered from the changed state. Nothing on a
 * later screen is a fixture somebody hand-set to look right — it is what the
 * earlier press made.
 *
 *   1  ENTER A CHECK     Today → add it → Checks → the check → Match (confident,
 *                        unsure, no claim number) → the bench (green, amber, red)
 *                        → Before you say yes → the post step, held by shadow.
 *   2  THE TAKEBACK      routes to the panel, never the failure list; the typed
 *                        field is dead until matched; the adjustment is the
 *                        default; the permanent path asks; the amount must be
 *                        exact; "already approved" routes to Posting.
 *   3  POSTING TRUTH     every posting state the drain can leave, on the check's
 *                        own page and on the Posting history.
 *   4  SHADOW            the header pill, the worksheet only after approving,
 *                        and the one-click comparison.
 *   5  SWEEPS            run at EVERY screen visit above, via `sweep()`:
 *                          a. one state sentence per card (W-8's class)
 *                          b. every match run names what it skipped
 *                          c. no banned word · no greyed control without a reason
 *                          d. sentences wrap, identifiers truncate
 *                          e. no machine office key in rendered text
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FAKE SERVER, AND WHAT IT IS ALLOWED TO KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * `@/features/rcm/api` is replaced by a small in-memory server (`srv`). It
 * derives each check's row the way `routes/rcm/remittances.js` does — attention
 * reasons from the claims, counts from the claims, balance from the claims —
 * and the gate's preview from the claims' own state. A mock that returned
 * whatever the next assertion wanted would let a screen pass a walk the real
 * server would fail; this one can only answer from what the screens have done.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * W-8, AND WHERE ITS DEFINITION CAME FROM
 * ─────────────────────────────────────────────────────────────────────────────
 * W-8 has no section of its own in the walk report. Its class is the brief's:
 * a card or banner that carries TWO state sentences — W-1 was the instance the
 * walk wrote up ("already approved" beside "waiting for"). So sweep (a) builds
 * each card family's state vocabulary FROM THE PRODUCT'S OWN FUNCTIONS
 * (`queueHint`, `standingLine`, `waitingFor`, …) and asserts exactly one
 * member per card.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE PRODUCT CHANGE THIS SLICE MADE, AND WHY IT IS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * Flow 3 found that a `failed` run — the drain crashes to `failed` at
 * `office_writeoffs` and `confirm_patient` AFTER the check exists, keeping
 * `od_claim_payment_num` and zeroing `posted_total_cents` — printed "Open
 * Dental check #N $0.00" on the stopped card. A swept run did the same. PM
 * ruling 2026-09-10: the check number is the do-not-re-enter evidence and
 * stays; the amount goes. `PostThisCheck.tsx` now renders the number and an
 * explicit sentence, no amount. Flow 3 asserts both halves.
 *
 * PR #171 round 1 added three more, each pinned here: the same ruling for a
 * `blocked` re-press (3.9), the practice's name in the Post reason rather than
 * its key (1.17 and sweep e), and the matching miniature in the verdict's green
 * (1.14).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN A FLOW WHOLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Flows 1, 2 and 4 are walks: their steps share one world (built in the flow's
 * `beforeAll`) and run in order, each starting from what the last one left.
 * Filtering to a single step with `-t` runs it against a world nobody walked.
 * Flow 3 and the sweeps build their own world per case.
 *
 * NO REAL PATIENT DATA. Every id is in the fictional 900xxx range; the only
 * patients are the designated test patients — Stedi Test 2 (PatNum 12827) and
 * Test, MangoTest (12828) — at Roland.
 */
import * as React from "react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  POSTING_STEPS,
  RCM_OFFICE_IDS,
  RCM_OFFICE_LABELS,
  type BatchMatchResponse,
} from "@/features/rcm/api";
import {
  POST_AGAIN_SAFE,
  QUEUE_STATE_COPY,
  SHADOW_MODE_COPY,
  queueHint,
  stoppedWhile,
} from "@/features/rcm/posting";
import { matchRunSummary } from "@/features/rcm/matchWords";
import { standingLine } from "@/features/rcm/standing";
import { WAITING_STATES, waitingFor, type WaitingContext } from "@/features/rcm/waitingOn";
import { claimHref, remittanceHref } from "@/features/rcm/flow";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ═════════════════════════════════════════════════════════════════════════════
// THE FAKE SERVER'S STATE
// ═════════════════════════════════════════════════════════════════════════════

/** What a claim's server-side fixture knows that the screens have to earn. */
interface ClaimFixture {
  /** The match run's answer for this claim. */
  snapshot: Record<string, unknown> | null;
  /** What the gate's verdict reads once the claim is confirmed. */
  verdict?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  chart?: Record<string, unknown> | null;
  /** The recomputed verdict after a line decision, keyed `${lineId}:${decision}`. */
  decided?: Record<string, Record<string, unknown>>;
  /** The carrier is taking money back on this claim. */
  takeback?: boolean;
}

type WorldClaim = Record<string, unknown> & {
  claimId: string;
  claimNumber: string;
  patientName: string;
  totalPaidCents: number;
  odMatchStatus: string;
  odClaimNum: number | null;
  reviewedAt: string | null;
  postingQueueId: string | null;
  lines: Record<string, unknown>[];
  verdict?: Record<string, unknown>;
  fixture: ClaimFixture;
};

interface WorldCheck {
  row: Record<string, unknown> & { batchId: string; totalAmountCents: number };
  claimIds: string[];
  queueId: string | null;
  /** Not yet uploaded — the fake server answers 404 until an upload lands it. */
  hidden: boolean;
}

const srv = vi.hoisted(() => {
  const NOW = "2026-09-09T01:15:00.000Z";
  return {
    NOW,
    /** The server's own refusal for a press made while posting is switched off. */
    SHADOW_REFUSAL:
      "Posting is switched off for Roland Family Dental (shadow mode). Approved checks wait here.",
    auth: { status: "loading" } as unknown,
    postingEnabled: true,
    drainEnabled: true,
    checks: {} as Record<string, WorldCheck>,
    claims: {} as Record<string, WorldClaim>,
    plans: {} as Record<string, Record<string, unknown>>,
    /** Per-plan detail the posting read carries beyond the row. */
    planExtras: {} as Record<string, Record<string, unknown>>,
    /** Checks an upload will land, in order. */
    inbox: [] as string[],
    /** A batch match response to return verbatim instead of running one. */
    matchOverride: null as Partial<BatchMatchResponse> | null,
    recoupAlreadyApproved: false,
    /** Every press that reached the server, in order. */
    calls: [] as string[],
    /** One posting row, in the shape `routes/rcm/posting.js` returns. */
    makePlan(over: Record<string, unknown>): Record<string, unknown> {
      return {
        queueId: "q-900000",
        office: "roland",
        batchId: "chk-900000",
        status: "approved",
        statusLabel: "queued",
        blockedReason: null,
        withdrawnReason: null,
        withdrawnNote: null,
        withdrawnAt: null,
        step: null,
        isRecoupment: false,
        documentAttachStatus: null,
        carrierEobDate: "2026-09-08",
        intendedTotalCents: 0,
        postedTotalCents: 0,
        odClaimPaymentNum: null,
        reconciledAt: null,
        approvedAt: NOW,
        approvedBy: "Billing Person",
        startedAt: null,
        finishedAt: null,
        drainAttemptAt: null,
        drainedBy: null,
        attemptCount: 0,
        lastError: null,
        checkNumber: "900700000",
        payer: "SYNTHETIC DENTAL",
        ...over,
      };
    },
  };
});

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => srv.auth };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      {
        officeId: "roland",
        officeName: "Roland Family Dental",
        odConnected: true,
        odBlockedReason: null,
        odHealth: { status: "ok", lastCheckedAt: srv.NOW, lastTransitionAt: null, lastFailureKind: null },
      },
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
  const S = srv;
  const NOW = S.NOW;
  const log = (s: string) => {
    S.calls.push(s);
  };
  const may = (permission: string) => {
    const a = S.auth as { status: string; user?: { permissions: string[] } };
    return a.status === "authenticated" && Boolean(a.user?.permissions.includes(permission));
  };
  const notFound = () => new real.RcmApiError("Not found in this practice.", 404, "NOT_FOUND");
  const live = (batchId: string) => {
    const check = S.checks[batchId];
    if (!check || check.hidden) throw notFound();
    return check;
  };
  const claimsOf = (batchId: string) => S.checks[batchId].claimIds.map((id) => S.claims[id]);

  /** The claim as a response carries it — never the fixture behind it. */
  function publicClaim(c: WorldClaim, detail: boolean) {
    const { fixture: _fixture, ...rest } = c;
    const out: Record<string, unknown> = { ...rest, provenance: null };
    if (!detail) delete out.matchSnapshot;
    return out;
  }

  /** A check's list row, derived from its claims the way the server derives it. */
  function deriveRow(batchId: string) {
    const check = S.checks[batchId];
    const cl = claimsOf(batchId);
    const plan = check.queueId ? S.plans[check.queueId] : null;
    const unmatched = cl.filter((c) => c.odMatchStatus !== "confirmed").length;
    const queued = cl.filter((c) => c.postingQueueId != null).length;
    const unreviewed = cl.filter((c) => c.reviewedAt == null && c.postingQueueId == null).length;
    const claimTotal = cl.reduce((n, c) => n + c.totalPaidCents, 0);
    const total = check.row.totalAmountCents;
    const reasons: string[] = [];
    if (unreviewed > 0) reasons.push("claims_unreviewed");
    else if (cl.length > 0 && queued < cl.length) reasons.push("claims_awaiting_approval");
    if (plan && ["failed", "partially_posted", "blocked"].includes(String(plan.status))) {
      reasons.push("posting_failed");
    }
    const observations: string[] = [];
    if (unmatched > 0) observations.push("claims_unmatched");
    if (plan?.status === "posted") observations.push("claims_posted");
    const setAside = check.row.setAsideAt != null;
    return {
      ...check.row,
      claimCount: cl.length,
      patientNames: { shown: cl.map((c) => c.patientName).slice(0, 3), more: Math.max(0, cl.length - 3) },
      status: plan?.status === "posted" ? "posted" : "needs_review",
      postedAmountCents: plan?.status === "posted" ? Number(plan.postedTotalCents) : 0,
      balance: {
        batchTotalCents: total,
        claimTotalCents: claimTotal,
        differenceCents: total - claimTotal,
        plbTotalCents: 0,
        balanced: total === claimTotal,
      },
      needsAttention: !setAside && reasons.length > 0,
      attentionReasons: reasons,
      attentionObservations: observations,
      reviewReasonCount: 0,
      unmatchedClaimCount: unmatched,
      queuedClaimCount: queued,
    };
  }

  /** The gate's conditions for one claim, from the claim's own state. */
  function gateChecks(c: WorldClaim) {
    const confirmed = c.odMatchStatus === "confirmed";
    const k = (code: string, passed: boolean, detail: string | null = null) => ({
      code,
      label: code,
      passed,
      detail,
      fix: "Open the claim and settle it.",
    });
    if (c.fixture.takeback) {
      return [k("NOT_RECOUPMENT", false, `the remittance moves ${c.totalPaidCents} cents`)];
    }
    return [
      k("OFFICE_CONSISTENT", true),
      k("MATCH_CONFIRMED", confirmed, confirmed ? `ClaimNum ${c.odClaimNum}` : "not matched yet"),
      k("REVIEWED", c.reviewedAt != null),
      k("LINES_PAIRED", confirmed),
      k("CLAIM_TOTALS_AGREE", true),
      k("PATIENT_RESPONSIBILITY_MATCHES", confirmed && c.verdict?.state !== "red"),
    ];
  }

  function preview(batchId: string) {
    const claims = claimsOf(batchId).map((c) => {
      const checks = gateChecks(c);
      const failed = checks.filter((x) => !x.passed).map((x) => x.code);
      const alreadyQueued = c.postingQueueId != null;
      const out: Record<string, unknown> = {
        claimId: c.claimId,
        claimNumber: c.claimNumber,
        patientName: c.patientName,
        postable: !alreadyQueued && failed.length === 0,
        alreadyQueued,
        checks,
        failed,
      };
      if (c.odMatchStatus === "confirmed" && c.verdict) out.verdict = c.verdict;
      return out;
    });
    const row = deriveRow(batchId);
    return {
      office: "roland",
      batchId,
      canApprove: may("rcm.write"),
      approveRequires: "rcm.write",
      claims,
      postableCount: claims.filter((c) => c.postable).length,
      withheldCount: claims.filter((c) => !c.postable && !c.alreadyQueued).length,
      queuedCount: claims.filter((c) => c.alreadyQueued).length,
      balanced: row.balance.balanced,
      differenceCents: row.balance.differenceCents,
    };
  }

  function page(office: string, opts: { view?: string; limit?: number; offset?: number } = {}) {
    const rows = Object.keys(S.checks)
      .filter((id) => !S.checks[id].hidden)
      .map(deriveRow);
    const liveRows = rows.filter((r) => r.setAsideAt == null);
    const view = opts.view ?? "all";
    const selected =
      view === "attention"
        ? liveRows.filter((r) => r.needsAttention)
        : view === "parked"
          ? liveRows.filter((r) => r.parkedAt != null)
          : view === "set_aside"
            ? rows.filter((r) => r.setAsideAt != null)
            : rows;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return {
      office,
      view,
      remittances: selected.slice(offset, offset + limit),
      total: rows.length,
      needsAttentionCount: liveRows.filter((r) => r.needsAttention).length,
      parkedCount: liveRows.filter((r) => r.parkedAt != null).length,
      setAsideCount: rows.filter((r) => r.setAsideAt != null).length,
      matchingCount: selected.length,
      limit,
      offset,
    };
  }

  function queuePage(office: string) {
    const rows = Object.values(S.plans);
    const byStatus: Record<string, number> = {
      approved: 0,
      posting: 0,
      posted: 0,
      failed: 0,
      partially_posted: 0,
      blocked: 0,
      withdrawn: 0,
    };
    for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
    return {
      office,
      rows,
      byStatus,
      total: rows.length,
      limit: 200,
      offset: 0,
      canDrain: may("rcm.post"),
      drainRequires: "rcm.post",
      postingEnabled: S.postingEnabled,
      drainEnabled: S.drainEnabled,
    };
  }

  function runMatch(c: WorldClaim) {
    const snap = c.fixture.snapshot;
    c.matchSnapshot = snap;
    c.odMatchAt = NOW;
    const n = (snap?.candidates as unknown[] | undefined)?.length ?? 0;
    c.odMatchStatus = n === 0 ? "no_candidate" : "candidates";
    return { n, ambiguous: Boolean(snap?.ambiguous) };
  }

  return {
    ...real,

    listRemittances: async (office: string, opts = {}) => page(office, opts),

    getRemittance: async (office: string, batchId: string) => {
      const check = live(batchId);
      const plan = check.queueId ? S.plans[check.queueId] : null;
      return {
        office,
        remittance: {
          ...deriveRow(batchId),
          plbAdjustments: [],
          plans: plan ? [{ queueId: plan.queueId, status: plan.status }] : [],
        },
        claims: claimsOf(batchId).map((c) => publicClaim(c, false)),
      };
    },

    getClaim: async (office: string, claimId: string) => {
      const c = S.claims[claimId];
      if (!c) throw notFound();
      return {
        office,
        claim: publicClaim(c, true),
        writeoffReasons: [
          { slug: "xrays_bitewings", label: "X-rays — bitewings" },
          { slug: "courtesy", label: "Courtesy to the patient" },
        ],
        matchRules: {
          amountNearCents: 100,
          dateNearDays: 7,
          ambiguityMargin: 10,
          bands: [
            { band: "HIGH", min: 75 },
            { band: "MEDIUM", min: 45 },
            { band: "LOW", min: 0 },
          ],
        },
      };
    },

    matchRemittance: async (office: string, batchId: string) => {
      log(`matchRemittance:${batchId}`);
      const matched = claimsOf(batchId).map((c) => {
        if (c.odMatchStatus === "confirmed") return { claimId: c.claimId, status: "already_confirmed" };
        const { n, ambiguous } = runMatch(c);
        return n === 0
          ? { claimId: c.claimId, status: "no_candidate", candidateCount: 0 }
          : { claimId: c.claimId, status: "candidates", candidateCount: n, ambiguous };
      });
      return {
        office,
        batchId,
        matched,
        odCalls: 6,
        pacingMs: 1200,
        budgetMs: 90_000,
        outOfTime: false,
        skipped: 0,
        ...(S.matchOverride ?? {}),
      };
    },

    matchClaim: async (office: string, claimId: string, opts: { force?: boolean } = {}) => {
      log(`matchClaim:${claimId}:${opts.force === true ? "force" : "plain"}`);
      const c = S.claims[claimId];
      runMatch(c);
      return { office, claimId, status: c.odMatchStatus, snapshot: c.matchSnapshot };
    },

    confirmClaimMatch: async (_office: string, claimId: string, odClaimNum: number) => {
      log(`confirmClaimMatch:${claimId}:${odClaimNum}`);
      const c = S.claims[claimId];
      const candidates = ((c.matchSnapshot as Record<string, unknown> | null)?.candidates ?? []) as {
        odClaimNum: number;
        odPatNum: number;
      }[];
      const picked = candidates.find((x) => x.odClaimNum === odClaimNum);
      c.odMatchStatus = "confirmed";
      c.odClaimNum = odClaimNum;
      c.odPatientId = picked?.odPatNum ?? null;
      c.odMatchConfirmedAt = NOW;
      c.odMatchedBy = "Billing Person";
      c.verdict = c.fixture.verdict;
      c.identity = c.fixture.identity;
      c.chart = c.fixture.chart ?? null;
      return { claimId, odClaimNum, confirmedAt: NOW };
    },

    reviewClaim: async (_office: string, claimId: string, note: string) => {
      log(`reviewClaim:${claimId}`);
      const c = S.claims[claimId];
      c.reviewedAt = NOW;
      c.reviewedBy = "Billing Person";
      c.reviewNote = note || null;
      return { claimId, reviewedAt: NOW, reviewedBy: "Billing Person" };
    },

    setLineDecision: async (
      office: string,
      claimId: string,
      lineId: string,
      decision: string,
      reason: string | null,
    ) => {
      log(`setLineDecision:${claimId}:${lineId}:${decision}:${reason}`);
      const c = S.claims[claimId];
      const line = c.lines.find((l) => l.lineId === lineId)!;
      line.decision = decision;
      line.decisionReason = reason;
      line.decidedBy = "Billing Person";
      line.decidedAt = NOW;
      c.verdict = c.fixture.decided?.[`${lineId}:${decision}`] ?? c.verdict;
      for (const check of Object.values(S.checks)) {
        if (check.claimIds.includes(claimId)) {
          check.row.lastDecidedAt = NOW;
          check.row.lastDecidedBy = "Billing Person";
        }
      }
      return { office, claimId, lineId, decision, reason, verdict: c.verdict ?? null, lines: c.lines };
    },

    getApprovalPreview: async (_office: string, batchId: string) => {
      live(batchId);
      return preview(batchId);
    },

    approveRemittance: async (office: string, batchId: string) => {
      log(`approveRemittance:${batchId}`);
      const p = preview(batchId);
      if (p.postableCount === 0) {
        const all = p.claims.length > 0 && p.queuedCount === p.claims.length;
        throw new real.RcmApiError(
          all ? "Everything on this check is already approved." : "Nothing on this check can be posted yet.",
          409,
          "NOTHING_APPROVABLE",
          { alreadyApproved: all },
        );
      }
      const check = S.checks[batchId];
      const queueId = check.queueId ?? `q-${batchId}`;
      const queued = claimsOf(batchId).filter((c) =>
        p.claims.some((x) => x.claimId === c.claimId && x.postable),
      );
      for (const c of queued) {
        c.postingQueueId = queueId;
        c.approvedAt = NOW;
      }
      check.queueId = queueId;
      check.row.approvalAttemptedAt = NOW;
      check.row.approvalAttemptedBy = "Billing Person";
      const intendedTotalCents = queued.reduce((n, c) => n + c.totalPaidCents, 0);
      S.plans[queueId] = S.makePlan({
        queueId,
        batchId,
        intendedTotalCents,
        checkNumber: check.row.checkNumber,
        payer: check.row.payer,
      });
      return {
        office,
        batchId,
        queueId,
        approvedBy: "Billing Person",
        queued: queued.map((c) => ({
          claimId: c.claimId,
          claimNumber: c.claimNumber,
          patientName: c.patientName,
          odClaimNum: c.odClaimNum,
          lines: c.lines.length,
          totalCents: c.totalPaidCents,
        })),
        withheld: [],
        alreadyQueued: [],
        intendedTotalCents,
        note: "Approved. Nothing reaches Open Dental until somebody presses Post to Open Dental on this check.",
      };
    },

    listPostingQueue: async (office: string) => {
      log("listPostingQueue");
      return queuePage(office);
    },

    getPostingPlan: async (office: string, queueId: string) => {
      const plan = S.plans[queueId];
      if (!plan) throw notFound();
      const extra = S.planExtras[queueId] ?? {};
      return {
        office,
        plan,
        lines: extra.lines ?? [],
        claims: claimsOf(String(plan.batchId)).map((c) => ({
          claimId: c.claimId,
          claimNumber: c.claimNumber,
          patientName: c.patientName,
          odClaimNum: c.odClaimNum,
        })),
        canDrain: may("rcm.post"),
        drainRequires: "rcm.post",
        postingEnabled: S.postingEnabled,
        drainEnabled: S.drainEnabled,
        documentAttach: extra.documentAttach ?? {
          implemented: true,
          status: plan.documentAttachStatus,
          error: null,
          at: null,
          documents: [],
          canRetry: may("rcm.post"),
          retryRequires: "rcm.post",
        },
      };
    },

    drainPostingQueue: async (office: string, opts: { queueId?: string } = {}) => {
      log(`drainPostingQueue:${opts.queueId ?? "all"}`);
      if (!S.drainEnabled) {
        throw new real.RcmApiError(S.SHADOW_REFUSAL, 409, "DRAIN_DISABLED_FOR_OFFICE");
      }
      return { office, outcomes: [], ran: 0, outOfTime: false, remaining: 0, config: null, postingEnabled: true };
    },

    recheckPosting: async (office: string, queueId: string) => {
      log(`recheckPosting:${queueId}`);
      return { office, queueId, status: "partially_posted", agreed: false, checkedAt: NOW, claims: [] };
    },

    getRcmOfficeSettings: async (office: string) => ({
      office,
      drainEnabled: S.drainEnabled,
      postingEnabled: S.postingEnabled,
      writeoffMode: "writeoff_field",
      writeoffModes: ["writeoff_field", "adjustment_by_name"],
      writeoffAdjTypeName: null,
    }),

    getRecoupmentChecklist: async (office: string, batchId: string) => {
      live(batchId);
      const claims = claimsOf(batchId);
      const takebacks = claims.filter((c) => c.fixture.takeback);
      const total = takebacks.reduce((n, c) => n + c.totalPaidCents, 0);
      return {
        office,
        batchId,
        claims: claims.map((c) => {
          const confirmed = c.odMatchStatus === "confirmed";
          const checks = [
            { code: "RECOUPMENT_CONFIRMED", label: "x", passed: Boolean(c.fixture.takeback), detail: null, fix: "…" },
            {
              code: "MATCH_CONFIRMED",
              label: "x",
              passed: confirmed,
              detail: confirmed ? `ClaimNum ${c.odClaimNum}` : "not matched yet",
              fix: "…",
            },
          ];
          return {
            claimId: c.claimId,
            claimNumber: c.claimNumber,
            patientName: c.patientName,
            postable: confirmed,
            alreadyQueued: c.postingQueueId != null,
            checks,
            failed: checks.filter((x) => !x.passed).map((x) => x.code),
          };
        }),
        recoupmentClaims: takebacks.length,
        recoupmentTotalCents: total,
        typedTotalExpected: (total / 100).toFixed(2),
        paths: ["adjustment", "supplemental"],
        defaultPath: "adjustment",
        balanced: true,
        differenceCents: 0,
        canApprove: may("rcm.write"),
        approveRequires: "rcm.write",
      };
    },

    approveRecoupment: async (
      office: string,
      batchId: string,
      body: { typedTotal: string; path: string },
    ) => {
      log(`approveRecoupment:${body.path}:${body.typedTotal}`);
      if (S.recoupAlreadyApproved) {
        throw new real.RcmApiError("Everything on this check is already approved.", 409, "NOTHING_APPROVABLE", {
          alreadyApproved: true,
        });
      }
      return { office, batchId, note: "Takeback queued.", approvedBy: "Billing Person", recoupmentPath: body.path };
    },

    recordComparison: async (
      _office: string,
      batchId: string,
      answer: { verdict: string; reason?: string; note?: string },
    ) => {
      log(`recordComparison:${batchId}:${answer.verdict}`);
      const row = S.checks[batchId].row;
      row.comparisonVerdict = answer.verdict;
      row.comparisonReason = answer.reason ?? null;
      row.comparisonNote = answer.note ?? null;
      row.comparisonAt = NOW;
      row.comparisonBy = "Billing Person";
      row.comparisonRevision = Number(row.comparisonRevision ?? 0) + 1;
      return { batchId, verdict: answer.verdict, reason: answer.reason ?? null, revision: row.comparisonRevision, recorded: true };
    },

    getComparisonTally: async (office: string) => ({
      office,
      compared: 3,
      same: 3,
      differed: 0,
      matchedRun: 3,
      latestDifference: null,
    }),

    parkRemittance: async (_office: string, batchId: string, note?: string) => {
      log(`parkRemittance:${batchId}`);
      const row = S.checks[batchId].row;
      row.parkedAt = NOW;
      row.parkedBy = "Billing Person";
      row.parkedNote = note ?? null;
      return { batchId, parked: true };
    },

    unparkRemittance: async (_office: string, batchId: string) => {
      const row = S.checks[batchId]?.row;
      const wasParked = row?.parkedAt != null;
      if (row) {
        row.parkedAt = null;
        row.parkedBy = null;
        row.parkedNote = null;
      }
      return { batchId, parked: false, wasParked };
    },

    listEraUploads: async (office: string) => ({ office, uploads: [], total: 0, limit: 5, offset: 0 }),
    listEobUploads: async (office: string) => ({ office, uploads: [], total: 0, limit: 5, offset: 0 }),

    uploadEra: async (office: string, file: File) => {
      log(`uploadEra:${file.name}`);
      const batchId = S.inbox.shift();
      if (!batchId) throw new real.RcmApiError("Nothing new in that file.", 409, "ALREADY_PROCESSED");
      const check = S.checks[batchId];
      check.hidden = false;
      const cl = claimsOf(batchId);
      return {
        office,
        upload: { uploadId: "up-900001", filename: file.name, fileKey: "k", fileHash: "h", fileSizeBytes: file.size },
        remittances: [
          {
            index: 0,
            batchId,
            status: "needs_review",
            remittanceKey: "rk-900001",
            checkNumber: check.row.checkNumber,
            traceNumber: check.row.checkNumber,
            payer: check.row.payer,
            paymentDate: check.row.depositDate,
            paymentMethod: "check",
            totalAmountCents: check.row.totalAmountCents,
            plbTotalCents: 0,
            flags: [],
            claims: cl.map((c) => ({
              claimId: c.claimId,
              claimNumber: c.claimNumber,
              patientName: c.patientName,
              totalPaidCents: c.totalPaidCents,
              lineCount: c.lines.length,
              needsReviewReasons: [],
            })),
          },
        ],
        counts: { batches: 1, claims: cl.length, lines: cl.reduce((n, c) => n + c.lines.length, 0), adjustments: 0 },
      };
    },
  };
});

// ─── The screens, imported after the mocks ───────────────────────────────────

import RcmToday from "@/pages/rcm/RcmToday";
import RemittanceList from "@/pages/rcm/RemittanceList";
import RemittanceDetail from "@/pages/rcm/RemittanceDetail";
import ClaimMatch from "@/pages/rcm/ClaimMatch";
import ApproveCheck from "@/pages/rcm/ApproveCheck";
import PostingQueue from "@/pages/rcm/PostingQueue";
import DashboardLayout from "@/components/DashboardLayout";
import { RcmShadowProvider } from "@/features/rcm/shadowMode";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURES — fictional 900xxx ids, designated test patients only
// ═════════════════════════════════════════════════════════════════════════════

const NOW = srv.NOW;
const PAYER = "SYNTHETIC DENTAL";
const STEDI = { patNum: 12827, name: "Stedi Test 2" };
const MANGO = { patNum: 12828, name: "Test, MangoTest" };

function user(name: string, permissions: string[]) {
  return {
    status: "authenticated",
    user: {
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.invalid`,
      isSuperAdmin: false,
      permissions,
      tenant: { slug: "synthetic", displayName: "Synthetic Practice", modules: ["rcm"] },
    },
  };
}
/** An approver — the Roland biller, who may approve and post. */
const APPROVER = user("Billing Person", ["rcm.read", "rcm.queue", "rcm.write", "rcm.post"]);
const ADMIN = user("Admin Person", ["rcm.read", "rcm.queue", "rcm.write", "rcm.post", "rcm.settings"]);

function mkLine(lineId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId,
    position: 1,
    billedCode: "D2740",
    paidCode: null,
    code: "D2740",
    description: "Crown - porcelain/ceramic",
    billedCents: 120000,
    allowedCents: 90000,
    deductibleCents: 0,
    copayCents: 0,
    paidCents: 45000,
    adjustmentCents: 30000,
    patientRespCents: 45000,
    writeOffCents: 30000,
    adjustmentReason: null,
    isDowncoded: false,
    isBundled: false,
    isDenied: false,
    flags: [],
    odClaimProcNum: null,
    adjustments: [],
    contractualWriteOffCents: 30000,
    patientRemainderCents: 45000,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

function mkVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 0,
    projectedPatientCents: 0,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 0,
    decisions: [],
    problems: [],
    sentence: "Will owe $0.00 — matches the EOB.",
    ...over,
  };
}

function mkCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    odClaimNum: 900401,
    odPatNum: STEDI.patNum,
    score: 95,
    confidence: "HIGH",
    evidence: [
      {
        tag: "CLAIM_NUMBER_MATCH",
        weight: 35,
        label: "Claim number matches",
        detail: "The carrier's claim number is this Open Dental ClaimNum.",
      },
    ],
    blockers: [],
    od: {
      claimStatus: "S",
      dateService: "2026-09-01",
      claimHeaderFeeCents: 120000,
      billedCents: 120000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: STEDI.name,
      /* Open Dental holds both; the remittance holds neither — so neither may
         appear in the agreement sentence (S3). */
      patientBirthdate: "1990-01-01",
      subscriberId: "SYN900001",
      lines: [],
      deletedLineCount: 0,
      unknownDeletedLineCount: 0,
    },
    linePairs: [],
    ...over,
  };
}

function mkSnapshot(candidates: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    version: 3,
    fetchedAt: NOW,
    office: "roland",
    officeName: "Roland Family Dental",
    odCalls: 6,
    truncated: false,
    notes: [],
    patientsConsidered: [],
    ambiguous: false,
    margin: 40,
    rejectedCandidates: 0,
    rejectedReasons: { nameMismatch: 0, belowScore: 0 },
    minScore: 15,
    nameRuleApplied: true,
    candidates,
    confirmed: null,
    supersededConfirmation: null,
    ...over,
  };
}

function mkClaim(claimId: string, over: Partial<WorldClaim> & { fixture: ClaimFixture }): WorldClaim {
  return {
    claimId,
    officeId: "roland",
    claimNumber: "900300",
    checkNumber: "900700000",
    patientName: STEDI.name,
    odPatientId: null,
    odClaimNum: null,
    payer: PAYER,
    serviceDate: "2026-09-01",
    receivedDate: "2026-09-08",
    status: "pending_review",
    paymentStatus: "paid",
    insuranceType: "primary",
    totalBilledCents: 120000,
    totalAllowedCents: 90000,
    totalPaidCents: 45000,
    totalDeductibleCents: 0,
    patientBalanceCents: 45000,
    needsReviewReasons: [],
    extractionConfidence: 99,
    odMatchStatus: "not_run",
    rejectedCandidates: 0,
    odMatchAt: null,
    odMatchConfirmedAt: null,
    odMatchedBy: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-09-08T22:00:00.000Z",
    lines: [mkLine(`pl-${claimId}-1`)],
    matchSnapshot: null,
    matchSnapshotStale: false,
    patientDob: "1990-01-01",
    subscriberId: "SYN900001",
    identity: { matched: false, blocking: false, fields: [] },
    chart: null,
    confirmedAt: null,
    ...over,
  } as WorldClaim;
}

function mkCheckRow(batchId: string, over: Record<string, unknown> = {}) {
  return {
    batchId,
    officeId: "roland",
    payer: PAYER,
    checkNumber: "900700000",
    eftNumber: null,
    traceNumber: "900700000",
    paymentMethod: "check",
    depositDate: "2026-09-08",
    totalAmountCents: 0,
    plbTotalCents: 0,
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-09-08T22:00:00.000Z",
    createdBy: "Billing Person",
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
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

function resetWorld() {
  srv.auth = APPROVER;
  srv.postingEnabled = true;
  srv.drainEnabled = true;
  srv.checks = {};
  srv.claims = {};
  srv.plans = {};
  srv.planExtras = {};
  srv.inbox = [];
  srv.matchOverride = null;
  srv.recoupAlreadyApproved = false;
  srv.calls = [];
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
}

function addCheck(
  batchId: string,
  row: Record<string, unknown>,
  claims: WorldClaim[],
  opts: { hidden?: boolean; queueId?: string | null } = {},
) {
  for (const c of claims) srv.claims[c.claimId] = c;
  srv.checks[batchId] = {
    row: mkCheckRow(batchId, row) as WorldCheck["row"],
    claimIds: claims.map((c) => c.claimId),
    queueId: opts.queueId ?? null,
    hidden: opts.hidden ?? false,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderAt(ui: React.ReactElement, path: string) {
  const [pathname, search = ""] = path.split("?");
  lastRenderedPath = path;
  const memory = memoryLocation({ path: pathname, searchPath: search, record: true });
  const view = render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return { ...view, memory };
}

afterEach(cleanup);

/** Cents out of a rendered "$1,234.56". */
function cents(text: string | null | undefined): number {
  return Math.round(Number((text ?? "").replace(/[^0-9.-]/g, "")) * 100);
}

/** A currency amount anywhere in a string. */
const CURRENCY = /-?\$\s?\d/;

// ═════════════════════════════════════════════════════════════════════════════
// 5 · THE SWEEPS — run at every screen visit
// ═════════════════════════════════════════════════════════════════════════════

/**
 * (c) The banned words, MIRRORED from `rcm-plain-language.test.ts`.
 *
 * Mirrored rather than imported: importing a test file registers its tests in
 * this one. The tripwire in §5c asserts every pattern here appears in that file,
 * so the two lists cannot drift apart. That file scans the SOURCE; this scans
 * what actually rendered — the composed sentences a source scan cannot see.
 */
const BANNED: RegExp[] = [
  /\bdrains?\b/i,
  /\bdraining\b/i,
  /\bdrained\b/i,
  /\bread[- ]backs?\b/i,
  /\bposting plans?\b/i,
  /\bwithheld\b/i,
  /\brecoupments?\b/i,
  /\bbatch(es)?\b/i,
  /\bplans?\b/i,
];

function renderedProse(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  // `title` and `aria-label` are prose too — a screen reader reads them.
  for (const el of Array.from(root.querySelectorAll("[title], [aria-label]"))) {
    for (const attr of ["title", "aria-label"]) {
      const v = el.getAttribute(attr);
      if (v) out.push(v);
    }
  }
  return out;
}

function bannedWordHits(root: HTMLElement): string[] {
  return renderedProse(root).filter((t) => BANNED.some((re) => re.test(t)));
}

/**
 * (e) MACHINE KEYS NEVER RENDER. `roland` and `valley` are the frozen office
 * keys; a person reads the practice's name. Case-SENSITIVE on purpose: the
 * label "Roland" is the right answer, the key "roland" is the leak — which is
 * exactly what the check page's Post reason printed until PR #171 round 1.
 */
const OFFICE_KEY = new RegExp(`\\b(${RCM_OFFICE_IDS.join("|")})\\b`);

function officeKeyHits(root: HTMLElement): string[] {
  return renderedProse(root).filter((t) => OFFICE_KEY.test(t));
}

/** (c) The disabled-with-reason scan — `rcm-disabled-reasons.test.tsx`'s rule. */
function unexplainedDisabled(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[disabled]"))
    .filter((el) => {
      for (const scope of [el.parentElement, el.parentElement?.parentElement]) {
        if (scope?.querySelector("[data-disabled-reason]")) return false;
      }
      return true;
    })
    .map(
      (el) =>
        `<${el.tagName.toLowerCase()} data-testid="${el.getAttribute("data-testid") ?? "?"}"> "${(el.textContent ?? "").trim().slice(0, 40)}"`,
    );
}

/**
 * (a) ONE STATE SENTENCE PER CARD — W-8's class.
 *
 * Each family's vocabulary is built from the product's own functions, so a
 * sentence added to `queueHint` or `waitingFor` is in the vocabulary the day it
 * ships. A card carrying two members is a card telling two stories.
 */
const POSTED_CARD_HINT =
  "This check is finished. The money is in Open Dental, and CareIN asked Open Dental for it afterwards and got back exactly these lines.";

const POSTING_VOCAB: string[] = (() => {
  const s = new Set<string>();
  for (const copy of Object.values(QUEUE_STATE_COPY)) s.add(copy.hint);
  for (const step of [null, ...POSTING_STEPS]) {
    s.add(queueHint({ statusLabel: "failed", step, attemptCount: 1 }));
  }
  s.add(queueHint({ statusLabel: "queued", step: null, attemptCount: 0 }));
  s.add(queueHint({ statusLabel: "queued", step: null, attemptCount: 1 }));
  s.add(POSTED_CARD_HINT);
  return [...s];
})();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every sentence `waitingFor` can produce, in both registers, as patterns with
 * the counts left open. Built by driving the real function through every state
 * — and `WAITING_VOCAB.states` is asserted to be all of `WAITING_STATES`.
 */
const WAITING_VOCAB = (() => {
  const base = {
    batchId: "x",
    officeId: "roland",
    totalAmountCents: 100,
    flags: [] as string[],
    attentionReasons: [] as string[],
    attentionObservations: [] as string[],
    setAsideAt: null as string | null,
    claimCount: 4,
    queuedClaimCount: 0,
    unmatchedClaimCount: 0,
  };
  const variants: [Record<string, unknown>, WaitingContext][] = [];
  for (const n of [1, 4]) {
    const b = { ...base, claimCount: n };
    variants.push(
      [{ ...b, setAsideAt: NOW }, {}],
      [{ ...b, officeId: "valley" }, { office: "roland" }],
      [{ ...b, totalAmountCents: -100 }, {}],
      [{ ...b, attentionReasons: ["posting_failed"] }, {}],
      [{ ...b, attentionReasons: ["claims_withheld"] }, {}],
      [{ ...b, queuedClaimCount: 1 }, { shadowMode: true }],
      [{ ...b }, { confirmedAt: NOW }],
      [{ ...b, attentionReasons: ["claims_unreviewed"] }, {}],
      [{ ...b, claimCount: n + 1, attentionReasons: ["claims_unreviewed"], unmatchedClaimCount: n }, {}],
      [{ ...b, attentionReasons: ["claims_awaiting_approval"] }, {}],
      [{ ...b, attentionObservations: ["claims_unmatched"], unmatchedClaimCount: n }, {}],
      [{ ...b }, {}],
    );
  }
  const on: [string, RegExp][] = [];
  const next: [string, RegExp][] = [];
  const states = new Set<string>();
  // Digits and the instant are left open: counts differ per row, and "posted"
  // carries a timestamp. The sentences are otherwise matched whole.
  const pattern = (s: string) =>
    new RegExp(escapeRe(s.replace(/ at .*$/, " at ")).replace(/\d+/g, "\\d+"));
  for (const [row, ctx] of variants) {
    const w = waitingFor(row as never, ctx);
    states.add(w.state);
    on.push([w.state, pattern(w.waitingOn)]);
    next.push([w.state, pattern(w.next)]);
  }
  return { states, on, next };
})();

const APPROVE_VOCAB: [string, RegExp][] = [
  ["all_approved", /already approved — all \d+ of them|The one claim on this check is already approved/],
  ["nothing_ready", /Nothing on this check can be approved yet/],
  ["no_claims", /There are no claims on this check for the app to judge/],
  ["ready", /Lines this check up to post\./],
  ["just_approved", /\d+ claims? approved — \$/],
];

interface Family {
  name: string;
  cards: (root: HTMLElement) => HTMLElement[];
  /** Which state each vocabulary member names — a card may name exactly one. */
  statesIn: (text: string) => string[];
}

const byTestId = (re: RegExp) => (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-testid]")).filter((el) =>
    re.test(el.dataset.testid ?? ""),
  );

const FAMILIES: Family[] = [
  {
    name: "posting card",
    cards: byTestId(/^(post-this-check|posting-plan-q-[\w-]+)$/),
    statesIn: (t) => POSTING_VOCAB.filter((s) => t.includes(s)),
  },
  {
    name: "stuck panel",
    cards: byTestId(/^stuck-(measured|stopped)$/),
    statesIn: (t) =>
      [
        t.includes("The payment did reach Open Dental.") ? "measured" : "",
        t.includes("Posting stopped part-way through this check") ? "stopped" : "",
      ].filter(Boolean),
  },
  {
    name: "approve decision",
    cards: byTestId(/^approve-decide$/),
    statesIn: (t) => APPROVE_VOCAB.filter(([, re]) => re.test(t)).map(([s]) => s),
  },
  {
    name: "Checks row · Waiting on",
    cards: byTestId(/^remittance-row-/),
    statesIn: (t) => [...new Set(WAITING_VOCAB.on.filter(([, re]) => re.test(t)).map(([s]) => s))],
  },
  {
    name: "Today row · What happens next",
    cards: byTestId(/^rcm-arrival-(?!next-)[\w-]+$/),
    statesIn: (t) => [...new Set(WAITING_VOCAB.next.filter(([, re]) => re.test(t)).map(([s]) => s))],
  },
  {
    name: "Today · where you left off",
    cards: byTestId(/^rcm-left-off-row-/),
    statesIn: (t) =>
      [
        /Next: keep checking it over —/.test(t) ? "review" : "",
        t.includes("Next: every claim is checked over — it needs approving.") ? "approve" : "",
        t.includes("Nothing is waiting on you here.") ? "none" : "",
      ].filter(Boolean),
  },
  {
    name: "claim state line",
    cards: byTestId(/^claim-state-line$/),
    statesIn: (t) => (t.match(/Not linked to Open Dental yet\.|Linked to Open Dental claim \d+/g) ?? []),
  },
  {
    name: "shadow banner",
    cards: byTestId(/^shadow-mode-banner$/),
    statesIn: (t) => (t.split(SHADOW_MODE_COPY.banner).length - 1 === 1 ? ["shadow"] : []),
  },
];

function multiStateCards(root: HTMLElement): string[] {
  const problems: string[] = [];
  for (const family of FAMILIES) {
    for (const card of family.cards(root)) {
      const states = family.statesIn(card.textContent ?? "");
      if (states.length !== 1) {
        problems.push(
          `${family.name} [${card.dataset.testid}] carries ${states.length} state sentences: ${JSON.stringify(states)}`,
        );
      }
    }
  }
  return problems;
}

/** Which families found at least one card — so a sweep is never silently vacuous. */
function familiesPresent(root: HTMLElement): string[] {
  return FAMILIES.filter((f) => f.cards(root).length > 0).map((f) => f.name);
}

/** (d) A sentence never clips itself; see `rcm-shell.test.tsx`'s rule. */
const CLIPPING = /\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d+)\b/;
function expectWraps(cell: HTMLElement, rowTestId: string) {
  for (let el: HTMLElement | null = cell; el; el = el.parentElement) {
    const cls = typeof el.className === "string" ? el.className : "";
    expect(cls, `${el.tagName}.${cls} clips "${cell.textContent}"`).not.toMatch(CLIPPING);
    if (el.dataset.testid === rowTestId) break;
  }
  expect(cell.getAttribute("title")).toBeNull();
}

// ═════════════════════════════════════════════════════════════════════════════
// 5f/5g · S7 — THE CLARITY MEASURES
// ═════════════════════════════════════════════════════════════════════════════
//
// S7's acceptance bar is a person, not a state: a new team member, untrained,
// finds and finishes the day's posting work. A person cannot be asserted, so
// the two things standing between them and the work are measured instead — HOW
// MANY WORDS a screen says, and WHETHER exactly one button is the next step.
//
// WHAT "PROSE WORDS" MEANS HERE. Names, amounts, dates, codes and ids are the
// WORK; a screen cannot say fewer of them and still be useful. They are struck
// out, and what is left — the sentences and labels the product chose to write —
// is what the budget governs.
//
// WHAT THIS CANNOT MEASURE. jsdom has no layout, so there is no fold. The count
// is over the WHOLE default render, which is a strict superset of what is above
// the fold: a screen inside its budget here is inside it up there too. The
// budgets below were therefore set from the measured whole-screen figures in
// `docs/rcm-s7-inventory.md`, not from the brief's above-the-fold numbers.

/** Set by `renderAt`, read by the sweep to know which screen it is judging. */
let lastRenderedPath = "";

/** Words that are the WORK, not the product's prose. */
const NOT_PROSE: RegExp[] = [
  /^[$(]?-?[\d,]+(\.\d+)?[%)]?$/, // amounts, counts, percentages
  /^#?\d[\d,.:/-]*$/, // check numbers, claim numbers, times
  /^[a-z]+-\d[\w-]*$/i, // clm-900201, chk-900101, q-900131
  /^D\d{4}$/, // procedure codes
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*$/,
  /^\d{1,2}(:\d{2})?(am|pm)$/i,
  /^(am|pm|AM|PM)$/,
];

/**
 * The proper nouns this world holds. A screen naming the payer, the practice,
 * the patient or the person who decided is doing its job; none of that is prose
 * a word diet could remove.
 */
const PROPER_NOUNS = new Set(
  [
    "Stedi", "Test", "MangoTest", "SYNTHETIC", "DENTAL", "Synthetic", "Dental",
    "Roland", "Family", "Valley", "Billing", "Person", "Administrator", "CareIN",
  ].map((w) => w.toLowerCase()),
);

/** Strip the punctuation a word wears, so "over," and "over" count once. */
const bareWord = (w: string) => w.replace(/^[^\w$#-]+/, "").replace(/[^\w%)]+$/, "");

/**
 * WHAT A PERSON ACTUALLY READS on arrival — visible text nodes only.
 *
 * Narrower than `renderedProse` in two ways, both deliberate:
 *
 *   `title` and `aria-label` are OUT. The banned-word and office-key scans read
 *   them because a screen reader speaks them; a word BUDGET must not, or the
 *   Checks page pays for four tab tooltips nobody sees. Moving a sentence into a
 *   tooltip is not a word diet, and the budget must not reward it.
 *
 *   Anything behind a closed disclosure, a `hidden` attribute or `aria-hidden`
 *   is OUT — that is the whole mechanism Phase 2.4 uses, and if the budget
 *   counted collapsed text, collapsing would buy nothing.
 */
function visibleText(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
          return NodeFilter.FILTER_REJECT;
        }
        const cls = typeof el.className === "string" ? el.className : "";
        if (/(^|\s)hidden(\s|$)/.test(cls)) return NodeFilter.FILTER_REJECT;
        if (el.tagName === "DETAILS" && !el.hasAttribute("open")) {
          // The summary is the face and stays; the body is behind the click.
          if (node.parentElement?.closest("summary") === null) return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  return out;
}

function proseWords(root: HTMLElement): string[] {
  const words: string[] = [];
  for (const chunk of visibleText(root)) {
    for (const raw of chunk.split(/\s+/)) {
      const w = bareWord(raw);
      if (!w) continue;
      if (NOT_PROSE.some((re) => re.test(w))) continue;
      if (PROPER_NOUNS.has(w.toLowerCase())) continue;
      words.push(w);
    }
  }
  return words;
}

/**
 * THE SCREEN'S OWN PROSE — everything except the repeating rows.
 *
 * A list screen's word count grows with the DAY, not with the design: twelve
 * checks say the *Waiting on* sentence twelve times. Budgeting the whole render
 * would therefore fail a quiet screen on a busy Monday and pass a wordy one on a
 * Sunday. So the budget governs the CHROME — the page's own headings, ledes,
 * helper text, legends, empty states and buttons, the words a designer chose
 * once — and the repeating row/card faces are governed separately, by the ≤ 8
 * word face rule in sweep (a).
 *
 * The rows are removed from a CLONE; nothing on the page is touched.
 */
const ROW_TESTID =
  /^(remittance-row-|rcm-arrival-|rcm-left-off-row-|posting-plan-q-|candidate-row-|candidate-|claim-row-|approve-row-)/;

function chromeProse(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const tr of Array.from(clone.querySelectorAll("tbody tr"))) tr.remove();
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>("[data-testid]"))) {
    if (ROW_TESTID.test(el.dataset.testid ?? "")) el.remove();
  }
  return visibleText(clone);
}

function chromeWords(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const tr of Array.from(clone.querySelectorAll("tbody tr"))) tr.remove();
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>("[data-testid]"))) {
    if (ROW_TESTID.test(el.dataset.testid ?? "")) el.remove();
  }
  return proseWords(clone);
}

/** Everything a person can press or follow on this screen. */
function clickables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="tab"], input[type="file"]',
    ),
  );
}

/**
 * The buttons that render PRIMARY — solid, filled, "press this one".
 *
 * This module does NOT use shadcn's `bg-primary` variant. Its solid is
 * `bg-foreground text-background` — 25 of them across the RCM pages — plus the
 * takeback's hand-rolled `bg-amber-700`. Those are the fill a reader's eye
 * picks out of a screen of outlines and ghosts, so those are what "primary"
 * means here.
 *
 * Matched as a whole class TOKEN, never a substring: `bg-primary/5` is a drop
 * zone's tint and `bg-foreground/10` a divider, and neither is a button.
 */
const PRIMARY_TOKEN = /^(dark:)?bg-(foreground|primary|amber-700|amber-800)$/;

function isPrimaryStyled(el: Element): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  return cls.split(/\s+/).some((t) => PRIMARY_TOKEN.test(t));
}

function primaryButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button, a")).filter(
    (el) =>
      isPrimaryStyled(el) &&
      !el.hasAttribute("disabled") &&
      // A selected tab is painted solid to say WHERE YOU ARE, not what to press.
      el.getAttribute("role") !== "tab",
  );
}

/**
 * Which screen is on the page — route first, then the panel that distinguishes
 * one state of the check page from another. A budget is per SCREEN, and the
 * check page in its posted, stuck and shadow states is three screens to a
 * reader even though it is one route.
 */
interface ScreenSpec {
  id: string;
  label: string;
  kind: "list" | "flow" | "terminal";
  /** Prose-word ceiling. `null` while a screen is only being measured. */
  budget: number | null;
  note?: string;
}

const SCREEN_KIND_BUDGET = { list: 80, flow: 130, terminal: 100 } as const;

function screenIdOf(root: HTMLElement): string | null {
  const path = lastRenderedPath;
  const has = (id: string) => Boolean(root.querySelector(`[data-testid="${id}"]`));
  if (path.startsWith("/rcm/posting")) return "activity";
  if (path.startsWith("/rcm/remittances/") && path.includes("/approve")) {
    return has("approve-takeback-only") || has("recoupment-panel") ? "takeback-route" : "approve";
  }
  if (path.startsWith("/rcm/remittances/")) {
    if (has("stuck-measured") || has("stuck-stopped")) return "stuck";
    if (has("posted-outcome")) return "posted";
    if (has("shadow-would-have-done")) return "shadow-worksheet";
    return "check";
  }
  if (path.startsWith("/rcm/remittances")) return "checks";
  if (path.startsWith("/rcm/claims/")) return "claim";
  if (path.startsWith("/rcm/sop/takeback")) return "takeback-sop";
  if (path.startsWith("/rcm")) return path.includes("add=1") ? "bring-in" : "today";
  return null;
}

const SCREENS: Record<string, ScreenSpec> = {
  today: { id: "today", label: "Today", kind: "list", budget: null },
  "bring-in": { id: "bring-in", label: "Bring in (Today's upload section)", kind: "list", budget: null },
  checks: { id: "checks", label: "Checks list", kind: "list", budget: null },
  check: { id: "check", label: "Check page", kind: "flow", budget: null },
  /* MATCH AND WORKBENCH ARE ONE SCREEN, not two. `ClaimMatch` renders
     `MatchGuidance` and `ClaimWorkbench` together, always — see its §5 note.
     The brief counts them separately; the code has only ever had one page. */
  claim: { id: "claim", label: "Claim page (Match + Workbench)", kind: "flow", budget: null },
  approve: { id: "approve", label: "Approve", kind: "flow", budget: null },
  "takeback-route": { id: "takeback-route", label: "Approve → takeback", kind: "flow", budget: null },
  posted: { id: "posted", label: "Posted / Done", kind: "terminal", budget: null },
  stuck: { id: "stuck", label: "Stuck / Failed", kind: "terminal", budget: null },
  "shadow-worksheet": { id: "shadow-worksheet", label: "Shadow worksheet", kind: "terminal", budget: null },
  activity: { id: "activity", label: "Activity / History", kind: "list", budget: null },
  "takeback-sop": { id: "takeback-sop", label: "Takeback how-to", kind: "flow", budget: null },
};

/** The worst case seen per screen across the whole walk — the inventory. */
interface Measure {
  words: number;
  chrome: number;
  actions: number;
  primaries: number;
  primaryLabels: string[];
  seen: number;
}
const INVENTORY: Record<string, Measure> = {};
const CHROME_TEXT: Record<string, string> = {};

function measure(root: HTMLElement): void {
  const id = screenIdOf(root);
  if (!id || !SCREENS[id]) return;
  const prev = INVENTORY[id];
  const primaries = primaryButtons(root);
  const next: Measure = {
    words: Math.max(prev?.words ?? 0, proseWords(root).length),
    chrome: Math.max(prev?.chrome ?? 0, chromeWords(root).length),
    actions: Math.max(prev?.actions ?? 0, clickables(root).length),
    primaries: Math.max(prev?.primaries ?? 0, primaries.length),
    primaryLabels: [
      ...new Set([
        ...(prev?.primaryLabels ?? []),
        ...primaries.map((b) => (b.textContent ?? "").trim().replace(/\s+/g, " ")),
      ]),
    ],
    seen: (prev?.seen ?? 0) + 1,
  };
  INVENTORY[id] = next;
  if (process.env.RCM_INVENTORY_DUMP) {
    const text = chromeProse(root).join(" | ");
    if ((CHROME_TEXT[id] ?? "").length < text.length) CHROME_TEXT[id] = text;
  }
}

/**
 * THE SWEEP — (a), (c) and (e), over whatever screen is on the page right now.
 * Returns the card families it judged, so a caller can say what was covered.
 */
function sweep(root: HTMLElement = document.body): string[] {
  measure(root);
  expect(unexplainedDisabled(root), "a greyed control with no reason beside it").toEqual([]);
  expect(bannedWordHits(root), "a banned word in rendered text").toEqual([]);
  expect(officeKeyHits(root), "a machine office key in rendered text").toEqual([]);
  expect(multiStateCards(root), "a card carrying two state sentences (W-8)").toEqual([]);
  return familiesPresent(root);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · ENTER A CHECK, THE WHOLE ROAD
// ═════════════════════════════════════════════════════════════════════════════

const A = "chk-900101"; // arrives by upload tonight
const B = "chk-900102"; // saved for tomorrow last night; its claim is red
const C1 = "clm-900201"; // Stedi Test 2 — a confident match, a green verdict
const C2 = "clm-900202"; // Test, MangoTest — unsure, no claim number agrees, then amber
const C3 = "clm-900203"; // Stedi Test 2 on B — red: the D2750 fee disagrees
const C2_XRAY = `pl-${C2}-2`;

const AMBER_SENTENCE = "Will owe $0.00 — $30.00 below the EOB because you wrote off D0274.";

function dayWorld() {
  resetWorld();
  // Roland goes live in SHADOW: posting is set up for it, and switched off.
  srv.postingEnabled = true;
  srv.drainEnabled = false;

  // ── B, left off last night ──
  addCheck(
    B,
    {
      checkNumber: "900700102",
      traceNumber: "900700102",
      totalAmountCents: 45000,
      parkedAt: "2026-09-08T02:00:00.000Z",
      parkedBy: "Billing Person",
      parkedNote: "Waiting on the office to fix the D2750 fee",
      createdAt: "2026-09-07T22:00:00.000Z",
    },
    [
      mkClaim(C3, {
        claimNumber: "900303",
        checkNumber: "900700102",
        odMatchStatus: "confirmed",
        odClaimNum: 900404,
        odPatientId: STEDI.patNum,
        reviewedAt: "2026-09-08T01:50:00.000Z",
        reviewedBy: "Billing Person",
        lines: [mkLine(`pl-${C3}-1`, { code: "D2750", billedCode: "D2750", odClaimProcNum: 900503 })],
        verdict: mkVerdict({
          state: "red",
          eobPatientCents: 45000,
          projectedPatientCents: 45000,
          sentence: "The patient's number cannot be trusted yet.",
          problems: [
            {
              kind: "od_fee_disagrees",
              code: "D2750",
              lineId: `pl-${C3}-1`,
              detail: "D2750 was billed $1,200.00 on the remittance and $1,150.00 in Open Dental",
            },
          ],
        }),
        identity: { matched: true, blocking: false, fields: [] },
        chart: {
          odClaimNum: 900404,
          claimStatus: "S",
          fetchedAt: NOW,
          billedCents: 115000,
          insPaidCents: 0,
          writeOffCents: 0,
          lines: [
            {
              odClaimProcNum: 900503,
              code: "D2750",
              status: "NotReceived",
              feeBilledCents: 115000,
              insEstCents: 60000,
              insPayAmtCents: 0,
              writeOffCents: 0,
            },
          ],
        },
        fixture: { snapshot: null },
      }),
    ],
  );

  // ── A, in tonight's 835 ──
  const c1Candidate = mkCandidate({
    linePairs: [
      {
        lineId: `pl-${C1}-1`,
        position: 1,
        code: "D2740",
        odClaimProcNum: 900501,
        odCode: "D2740",
        billedDeltaCents: 0,
        reason: null,
      },
    ],
  });
  const c2Base = {
    odPatNum: MANGO.patNum,
    od: {
      ...(mkCandidate().od as Record<string, unknown>),
      patientName: MANGO.name,
      billedCents: 21000,
      claimHeaderFeeCents: 21000,
    },
  };
  addCheck(
    A,
    { checkNumber: "900700101", traceNumber: "900700101", totalAmountCents: 57000 },
    [
      mkClaim(C1, {
        claimNumber: "900301",
        checkNumber: "900700101",
        lines: [mkLine(`pl-${C1}-1`, { odClaimProcNum: 900501 })],
        fixture: {
          snapshot: mkSnapshot([c1Candidate], { patientsConsidered: [{ patNum: STEDI.patNum, name: STEDI.name }] }),
          verdict: mkVerdict({
            eobPatientCents: 45000,
            projectedPatientCents: 45000,
            contractualWriteOffCents: 30000,
            sentence: "Will owe $450.00 — matches the EOB.",
          }),
          identity: {
            matched: true,
            blocking: false,
            fields: [{ field: "name", label: "Name", eob: STEDI.name, od: STEDI.name, status: "agrees", blocking: false }],
          },
          chart: {
            odClaimNum: 900401,
            claimStatus: "S",
            fetchedAt: NOW,
            billedCents: 120000,
            insPaidCents: 0,
            writeOffCents: 0,
            lines: [
              {
                odClaimProcNum: 900501,
                code: "D2740",
                status: "NotReceived",
                feeBilledCents: 120000,
                insEstCents: 60000,
                insPayAmtCents: 0,
                writeOffCents: 0,
              },
            ],
          },
        },
      }),
      mkClaim(C2, {
        claimNumber: "900302",
        checkNumber: "900700101",
        patientName: MANGO.name,
        totalBilledCents: 21000,
        totalAllowedCents: 15000,
        totalPaidCents: 12000,
        patientBalanceCents: 3000,
        lines: [
          mkLine(`pl-${C2}-1`, {
            code: "D1110",
            billedCode: "D1110",
            description: "Prophylaxis - adult",
            billedCents: 12000,
            allowedCents: 9000,
            paidCents: 9000,
            adjustmentCents: 3000,
            patientRespCents: 0,
            writeOffCents: 3000,
            contractualWriteOffCents: 3000,
            patientRemainderCents: 0,
            odClaimProcNum: 900502,
          }),
          mkLine(C2_XRAY, {
            position: 2,
            code: "D0274",
            billedCode: "D0274",
            description: "Bitewings - four radiographic images",
            billedCents: 9000,
            allowedCents: 6000,
            paidCents: 3000,
            adjustmentCents: 3000,
            patientRespCents: 3000,
            writeOffCents: 3000,
            contractualWriteOffCents: 3000,
            patientRemainderCents: 3000,
            odClaimProcNum: 900504,
          }),
        ],
        fixture: {
          /* UNSURE, AND NO CLAIM NUMBER AGREES: the carrier's "900302" is not
             either candidate's ClaimNum, so neither carries the server's
             CLAIM_NUMBER_MATCH tag. */
          snapshot: mkSnapshot(
            [
              mkCandidate({ ...c2Base, odClaimNum: 900402, score: 80, confidence: "HIGH", evidence: [] }),
              mkCandidate({
                ...c2Base,
                odClaimNum: 900403,
                score: 60,
                confidence: "MEDIUM",
                evidence: [],
                od: { ...c2Base.od, dateService: "2026-07-21", billedCents: 15600, claimHeaderFeeCents: 15600 },
              }),
            ],
            { ambiguous: true, margin: 20, patientsConsidered: [{ patNum: MANGO.patNum, name: MANGO.name }] },
          ),
          verdict: mkVerdict({
            eobPatientCents: 3000,
            projectedPatientCents: 3000,
            contractualWriteOffCents: 6000,
            sentence: "Will owe $30.00 — matches the EOB.",
          }),
          identity: {
            matched: true,
            blocking: false,
            fields: [{ field: "name", label: "Name", eob: MANGO.name, od: MANGO.name, status: "agrees", blocking: false }],
          },
          chart: null,
          decided: {
            [`${C2_XRAY}:office_writeoff`]: mkVerdict({
              state: "amber",
              eobPatientCents: 3000,
              projectedPatientCents: 0,
              decidedWriteOffCents: 3000,
              contractualWriteOffCents: 6000,
              sentence: AMBER_SENTENCE,
              decisions: [
                {
                  lineId: C2_XRAY,
                  code: "D0274",
                  amountCents: 3000,
                  reason: "xrays_bitewings",
                  reasonLabel: "X-rays — bitewings",
                  decidedBy: "Billing Person",
                  decidedAt: NOW,
                },
              ],
            }),
          },
        },
      }),
    ],
    { hidden: true },
  );
  srv.inbox = [A];
}

describe("1 · enter a check, the whole road", () => {
  beforeAll(dayWorld);

  it("1.1 Today: the resume card names the next action on the check left off", async () => {
    const { container } = renderAt(<RcmToday />, "/rcm");
    const card = await screen.findByTestId("rcm-left-off-roland");
    const row = within(card).getByTestId(`rcm-left-off-row-${B}`);
    expect(row.textContent).toContain("Saved");
    expect(screen.getByTestId(`rcm-left-off-note-${B}`).textContent).toBe(
      "“Waiting on the office to fix the D2750 fee”",
    );
    // THE NEXT ACTION, BY NAME — from the check's own claims, which the card read.
    await waitFor(() =>
      expect(screen.getByTestId(`rcm-next-action-${B}`).textContent).toBe(
        "Next: every claim is checked over — it needs approving.",
      ),
    );
    expect(screen.getByTestId(`rcm-pick-up-${B}`).getAttribute("href")).toBe(remittanceHref(B));
    expect(sweep(container)).toContain("Today · where you left off");
  });

  it("1.2 add a check: the one upload surface is on Today, and it opens the check it made", async () => {
    const { container } = renderAt(<RcmToday />, "/rcm");
    const door = await screen.findByTestId("rcm-get-work-in-roland");
    // TWO LANES, ONE SURFACE: the 835 zone and the EOB zone, both here.
    expect(within(door).getByTestId("rcm-drop-era-roland")).toBeTruthy();
    expect(within(door).getByTestId("rcm-drop-eob-roland")).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);

    const file = new File(["ISA*00*SYNTHETIC~"], "synthetic-900101.835", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("rcm-era-input-roland"), { target: { files: [file] } });

    const result = await screen.findByTestId("rcm-era-result-roland");
    expect(result.textContent).toContain("1 remittance, 2 claims, 3 lines");
    expect(screen.getByTestId(`rcm-era-open-${A}`).getAttribute("href")).toBe(`/rcm/remittances/${A}`);
    expect(srv.calls).toContain("uploadEra:synthetic-900101.835");
    sweep(container);
  });

  it("1.3 Checks: four tabs, no upload door, and every Waiting on names WHO", async () => {
    const { container } = renderAt(<RemittanceList />, "/rcm/remittances");
    await screen.findByTestId("remittances-roland");

    expect(screen.getByRole("tablist").querySelectorAll('[role="tab"]')).toHaveLength(4);
    for (const tab of ["attention", "parked", "set_aside", "all"]) {
      expect(screen.getByTestId(`remittance-filter-${tab}`)).toBeTruthy();
    }
    // No second upload surface — the button leaves for Today.
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(screen.getByTestId("remittance-upload-toggle").getAttribute("href")).toBe("/rcm?add=1");

    const WHO = /^(You|Nobody|Shadow mode|A takeback) — /;
    const waitingA = await screen.findByTestId(`remittance-waiting-${A}`);
    expect(waitingA.textContent).toMatch(WHO);
    expect(waitingA.textContent).toBe("You — 2 claims to check over");
    const waitingB = screen.getByTestId(`remittance-waiting-${B}`);
    expect(waitingB.textContent).toBe("You — it is ready to approve");

    // (d) The sentence wraps; the identifier beside it truncates.
    expectWraps(waitingA, `remittance-row-${A}`);
    const payer = [...screen.getByTestId(`remittance-row-${A}`).querySelectorAll("span")].find(
      (el) => el.textContent === PAYER,
    );
    expect(payer?.className).toMatch(/\btruncate\b/);

    expect(sweep(container)).toContain("Checks row · Waiting on");
  });

  it("1.4 the check's page: evidence under every rail step, one match verb, a table not yet judged", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    const rail = await screen.findByTestId("rcm-stepper");
    for (const step of ["upload", "match", "review", "post", "deposit"]) {
      expect(within(rail).getByTestId(`step-${step}`)).toBeTruthy();
    }
    expect(within(rail).getByTestId("step-note-upload").textContent).toContain("The carrier's 835 file read");
    expect(within(rail).getByTestId("step-note-match").textContent).toContain(
      "not been looked for in Open Dental yet",
    );
    expect(within(rail).getByTestId("step-note-deposit").textContent).toContain("Coming soon");
    // ONE page-level verb, and the rail does not draw a second.
    expect(screen.getByTestId("rcm-cta").textContent).toContain("Match it up");
    expect(within(rail).queryByTestId("rcm-cta")).toBeNull();

    // The miniature says NOT JUDGED rather than guessing at an unmatched claim —
    // and an untouched row stays quiet: no verdict, so none of the verdict tones.
    await waitFor(() =>
      expect(screen.getByTestId(`claim-stands-${C1}`).textContent).toContain("Not judged yet"),
    );
    const untouched = screen.getByTestId(`claim-stands-${C1}`).querySelector("span")?.className ?? "";
    expect(untouched).toContain("text-muted-foreground");
    expect(untouched).not.toMatch(/emerald|amber|rose/);
    sweep(container);
  });

  it("1.5 Match it up: the run says what it did — and, having skipped nothing, names nothing skipped", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    fireEvent.click(await screen.findByTestId("rcm-cta"));

    const summary = await screen.findByTestId("batch-match-summary");
    expect(summary.textContent).toBe("Matched 2 claims");
    expect(srv.calls.filter((c) => c === `matchRemittance:${A}`)).toHaveLength(1);
    // The page re-read the check, so the rail moved on from "not looked for".
    await waitFor(() =>
      expect(screen.getByTestId("step-note-match").textContent).toContain("waiting for somebody to pick"),
    );
    sweep(container);
  });

  it("1.6 Match — confident: the agreement sentence names only fields that agreed; confirming asks nothing more", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C1, A));
    await screen.findByTestId("match-guidance-confident");
    const sentence = screen.getByTestId("match-guidance-agreement").textContent ?? "";
    expect(sentence).toMatch(/claim number/i);
    expect(sentence).toMatch(/service date/i);
    expect(sentence).toMatch(/every line/i);
    // Open Dental HOLDS both; the remittance carries neither — nothing compared them.
    expect(sentence).not.toMatch(/birthday|subscriber/i);
    sweep(container);

    fireEvent.click(screen.getByTestId("match-guidance-confirm"));
    await waitFor(() => expect(srv.calls).toContain(`confirmClaimMatch:${C1}:900401`));
    expect(screen.queryByTestId("match-anyway")).toBeNull();
  });

  it("1.7 the bench — green: the verdict passes, and checking it over is one press", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C1, A));
    const verdict = await screen.findByTestId("verdict-line");
    expect(verdict.dataset.verdict).toBe("green");
    expect(screen.getByTestId("verdict-sentence").textContent).toBe("Will owe $450.00 — matches the EOB.");
    expect(screen.getByTestId("claim-state-line").dataset.stage).toBe("linked");
    expect(screen.queryByTestId("verdict-blocking-code")).toBeNull();
    expect(sweep(container)).toContain("claim state line");

    const cta = screen.getByTestId("rcm-cta") as HTMLButtonElement;
    expect(cta.textContent).toContain("Mark checked over");
    expect(cta.disabled).toBe(false);
    fireEvent.click(cta);
    await waitFor(() => expect(srv.calls).toContain(`reviewClaim:${C1}`));
    await waitFor(() => expect(screen.getByTestId("claim-state-line").dataset.stage).toBe("checked_over"));
    sweep(container);
  });

  it("1.8 Match — unsure: Likely / Possible, every delta spelled out, and 'neither' is honest", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C2, A));
    await screen.findByTestId("match-guidance-unsure");
    expect(screen.getByTestId("match-guidance-likelihood-900402").textContent).toBe("Likely");
    expect(screen.getByTestId("match-guidance-likelihood-900403").textContent).toBe("Possible");
    const diffs = screen.getByTestId("match-guidance-diffs-900403").textContent ?? "";
    expect(diffs).toMatch(/Jul 21, 2026 — 6 weeks earlier/);
    expect(diffs).toMatch(/\$156\.00 — \$54\.00 less billed/);
    const neither = screen.getByTestId("match-guidance-neither");
    expect(neither.textContent).toContain("Neither of these?");
    expect(neither.querySelectorAll("input")).toHaveLength(0);
    sweep(container);
  });

  it("1.9 Match — no claim number agrees: no confirm without the named difference; decline holds the focus", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C2, A));
    fireEvent.click(await screen.findByTestId("match-guidance-pick-900402"));

    const panel = await screen.findByTestId("match-anyway");
    // THE PRESS DID NOT REACH THE SERVER.
    expect(srv.calls.filter((c) => c.startsWith(`confirmClaimMatch:${C2}`))).toEqual([]);
    const first = screen.getByTestId("match-anyway-differences").querySelector("li");
    expect(first?.getAttribute("data-testid")).toBe("match-anyway-diff-claimNumber");
    expect(first?.textContent).toContain("900302");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("match-anyway-cancel")));
    expect(screen.getByTestId("match-anyway-confirm").textContent).toContain("no claim number agrees");
    sweep(container);

    // Escape backs out, and still nothing reached the server.
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("match-anyway")).toBeNull());
    expect(srv.calls.filter((c) => c.startsWith(`confirmClaimMatch:${C2}`))).toEqual([]);

    // Only the explicit affirmative links it.
    fireEvent.click(screen.getByTestId("match-guidance-pick-900402"));
    fireEvent.click(await screen.findByTestId("match-anyway-confirm"));
    await waitFor(() => expect(srv.calls).toContain(`confirmClaimMatch:${C2}:900402`));
  });

  it("1.10 the bench — amber: a write-off with its reason carries the decision chip", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C2, A));
    expect((await screen.findByTestId("verdict-line")).dataset.verdict).toBe("green");
    expect(screen.getByTestId(`decision-none-pl-${C2}-1`).textContent).toBe(
      "Nothing to decide — the carrier paid it in full.",
    );

    fireEvent.click(screen.getByTestId(`write-off-${C2_XRAY}`));
    fireEvent.click(await screen.findByTestId(`reason-xrays_bitewings-${C2_XRAY}`));
    await waitFor(() =>
      expect(srv.calls).toContain(`setLineDecision:${C2}:${C2_XRAY}:office_writeoff:xrays_bitewings`),
    );

    await waitFor(() => expect(screen.getByTestId("verdict-line").dataset.verdict).toBe("amber"));
    expect(screen.getByTestId("verdict-sentence").textContent).toBe(AMBER_SENTENCE);
    const chip = screen.getByTestId(`verdict-decision-${C2_XRAY}`);
    expect(chip.textContent).toContain("D0274");
    expect(chip.textContent).toContain("$30.00");
    expect(chip.textContent).toContain("X-rays — bitewings");
    expect(chip.textContent).toContain("decided by Billing Person");
    sweep(container);
  });

  it("1.11 Today, mid-check: the resume card names the next patient", async () => {
    const { container } = renderAt(<RcmToday />, "/rcm");
    // A write-off decision is the touch stamp that makes A "started".
    await waitFor(() =>
      expect(screen.getByTestId(`rcm-next-action-${A}`).textContent).toBe(
        `Next: keep checking it over — ${MANGO.name} is the last one.`,
      ),
    );
    expect(screen.getByTestId(`rcm-pick-up-${A}`).getAttribute("href")).toBe(claimHref(C2, A));
    expectWraps(screen.getByTestId(`rcm-arrival-next-${A}`), `rcm-arrival-${A}`);
    expect(sweep(container)).toEqual(
      expect.arrayContaining(["Today · where you left off", "Today row · What happens next"]),
    );
  });

  it("1.12 the bench: the amber claim is checked over", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C2, A));
    const cta = (await screen.findByTestId("rcm-cta")) as HTMLButtonElement;
    expect(cta.textContent).toContain("Mark checked over");
    fireEvent.click(cta);
    await waitFor(() => expect(srv.calls).toContain(`reviewClaim:${C2}`));
    await waitFor(() => expect(screen.getByTestId("claim-state-line").dataset.stage).toBe("checked_over"));
    sweep(container);
  });

  it("1.13 the bench — red: the approve verb is greyed, and the reason names the line", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(C3, B));
    expect((await screen.findByTestId("verdict-line")).dataset.verdict).toBe("red");
    expect(screen.getByTestId("verdict-blocking-code").textContent).toBe("D2750 is the line to look at.");
    const cta = screen.getByTestId("rcm-cta") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(screen.getByTestId("rcm-cta-reason").textContent).toContain(
      "Can't say yes while the D2750 fee disagrees",
    );
    expect(screen.getByTestId("chart-line-900503").dataset.flagged).toBe("true");
    sweep(container);
  });

  it("1.14 the check's page: every miniature is the gate's own verdict, in the gate's own tone", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    await waitFor(() =>
      expect(screen.getByTestId(`claim-stands-${C1}`).textContent).toBe("Will owe $450.00 — matches the EOB."),
    );
    // The tone is read off the same verdict as the sentence, in the verdict
    // banners' own colours: a matching claim is GREEN (a verdict, not a quiet
    // row — PR #171 round 1), and an amber one is amber.
    const greenTone = screen.getByTestId(`claim-stands-${C1}`).querySelector("span")?.className ?? "";
    expect(greenTone).toContain("text-emerald-700");
    expect(greenTone).not.toMatch(/rose|amber|muted/);
    expect(screen.getByTestId(`claim-stands-${C2}`).textContent).toBe(AMBER_SENTENCE);
    const amberTone = screen.getByTestId(`claim-stands-${C2}`).querySelector("span")?.className ?? "";
    expect(amberTone).toContain("text-amber-800");
    expect(amberTone).not.toMatch(/emerald|rose|muted/);
    expectWraps(screen.getByTestId(`claim-stands-${C2}`), `claim-card-${C2}`);
    expect(screen.getByTestId("step-note-review").textContent).toContain(
      "All 2 claims checked over. Nothing has been approved yet.",
    );
    sweep(container);
  });

  it("1.15 Before you say yes: the checklist is the gate's conditions only, and the totals are the rows", async () => {
    const { container } = renderAt(<ApproveCheck />, `/rcm/remittances/${A}/approve`);
    const list = await screen.findByTestId("approve-conditions");

    // EXACTLY the codes the gate sent — and not one the client knows of but was not sent.
    const sent = [
      "OFFICE_CONSISTENT",
      "MATCH_CONFIRMED",
      "REVIEWED",
      "LINES_PAIRED",
      "CLAIM_TOTALS_AGREE",
      "PATIENT_RESPONSIBILITY_MATCHES",
    ];
    const rendered = [...list.querySelectorAll("li")].map((li) =>
      (li.getAttribute("data-testid") ?? "").replace("approve-condition-", ""),
    );
    expect(rendered.sort()).toEqual([...sent].sort());
    for (const unsent of ["SNAPSHOT_CURRENT", "NO_BLOCKING_REASON", "CLAIMPROC_NOT_ALREADY_PLANNED"]) {
      expect(screen.queryByTestId(`approve-condition-${unsent}`)).toBeNull();
    }

    // THE PAGE TOTAL IS THE SUM OF THE ROWS IT DREW, read out of the DOM.
    let writeOff = 0;
    let eob = 0;
    let projected = 0;
    for (const id of [C1, C2]) {
      const tds = screen.getByTestId(`approve-rollup-row-${id}`).querySelectorAll("td");
      writeOff += cents(tds[2].textContent === "—" ? "0" : tds[2].textContent);
      eob += cents(tds[3].textContent);
      projected += cents(tds[4].textContent);
    }
    expect(cents(screen.getByTestId("approve-total-writeoff").textContent)).toBe(writeOff);
    expect(cents(screen.getByTestId("approve-total-eob").textContent)).toBe(eob);
    expect(cents(screen.getByTestId("approve-total-projected").textContent)).toBe(projected);
    expect([writeOff, eob, projected]).toEqual([3000, 48000, 45000]);
    expect(screen.getByTestId(`approve-decision-${C2_XRAY}`).textContent).toContain("X-rays — bitewings");
    expect(sweep(container)).toContain("approve decision");

    const button = screen.getByTestId("approve-button") as HTMLButtonElement;
    expect(button.textContent).toContain("Yes — this check is right");
    fireEvent.click(button);
    const result = await screen.findByTestId("approve-result");
    expect(result.textContent).toContain("2 claims approved — $570.00");
    expect(srv.calls.filter((c) => c === `approveRemittance:${A}`)).toHaveLength(1);
    sweep(container);
  });

  it("1.16 Before you say yes, afterwards: 'already approved' agrees with every tick, and there is a way on", async () => {
    const { container } = renderAt(<ApproveCheck />, `/rcm/remittances/${A}/approve`);
    const line = await screen.findByTestId("approve-already-approved");
    expect(line.textContent).toContain("already approved — all 2 of them");
    expect(line.textContent).not.toMatch(/waiting/i);
    // THE TICKS SAY THE SAME THING THE HEADLINE SAYS.
    const ticks = [...screen.getByTestId("approve-conditions").querySelectorAll("li")];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((li) => li.getAttribute("data-passed") === "true")).toBe(true);
    expect(screen.getByTestId("approve-onward-post").getAttribute("href")).toBe(remittanceHref(A));
    // The button stays, greyed — and the reason beside it IS the headline above.
    const button = screen.getByTestId("approve-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.querySelector('[data-testid="approve-already-approved"]')).toBe(line);
    expect(screen.queryByTestId("approve-nothing-postable")).toBeNull();
    expect(screen.queryByTestId("approve-go-back")).toBeNull();
    sweep(container);
  });

  it("1.17 the post step: held by shadow mode, with the reason beside the button and nothing pressed", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    const button = (await screen.findByTestId("post-this-check-button")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The practice's NAME, never its key — the same sentence the Posting page prints.
    const reason = screen.getByTestId("post-this-check-reason").textContent ?? "";
    expect(reason).toBe(SHADOW_MODE_COPY.reason(RCM_OFFICE_LABELS.roland));
    expect(reason).toBe("Posting is switched off for Roland (shadow mode). Approved checks wait here.");
    expect(officeKeyHits(screen.getByTestId("post-this-check"))).toEqual([]);
    expect(screen.getByTestId("post-this-check-hint").textContent).toBe(
      "Approved and waiting. Nothing has been written to Open Dental yet.",
    );
    // The rail says the same thing — current, not blocked: nothing is wrong.
    await waitFor(() =>
      expect(screen.getByTestId("step-note-post").textContent).toContain(
        "Switched off while shadow mode is on. Approved checks wait here.",
      ),
    );
    expect(screen.getByTestId("step-post").dataset.state).toBe("current");
    expect(srv.calls.some((c) => c.startsWith("drainPostingQueue"))).toBe(false);
    expect(sweep(container)).toEqual(expect.arrayContaining(["posting card", "shadow banner"]));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE TAKEBACK LANE
// ═════════════════════════════════════════════════════════════════════════════

const T = "chk-900111";
const TC = "clm-900211";

function takebackWorld() {
  resetWorld();
  addCheck(T, { checkNumber: "900700111", traceNumber: "900700111", totalAmountCents: -2900, flags: ["claim_reversal"] }, [
    mkClaim(TC, {
      claimNumber: "900311",
      checkNumber: "900700111",
      patientName: MANGO.name,
      totalBilledCents: 0,
      totalAllowedCents: 0,
      totalPaidCents: -2900,
      patientBalanceCents: 0,
      needsReviewReasons: ["reversal_not_postable"],
      lines: [
        mkLine(`pl-${TC}-1`, {
          code: "D0274",
          billedCode: "D0274",
          billedCents: -6000,
          allowedCents: -2900,
          paidCents: -2900,
          adjustmentCents: 0,
          patientRespCents: 0,
          writeOffCents: 0,
          contractualWriteOffCents: 0,
          patientRemainderCents: 0,
          adjustments: [
            {
              adjustmentId: "adj-900911",
              amountCents: -2900,
              quantity: 1,
              groupCode: "CR",
              groupLabel: "Correction",
              groupDescription: null,
              reasonCode: "129",
              reasonDescription: null,
              remarkCode: null,
              remarkDescription: null,
            },
          ],
        }),
      ],
      fixture: {
        takeback: true,
        snapshot: mkSnapshot([
          mkCandidate({
            odClaimNum: 900411,
            odPatNum: MANGO.patNum,
            od: { ...(mkCandidate().od as Record<string, unknown>), patientName: MANGO.name },
          }),
        ]),
        verdict: mkVerdict(),
        identity: { matched: true, blocking: false, fields: [] },
      },
    }),
  ]);
}

describe("2 · the takeback lane", () => {
  beforeAll(takebackWorld);

  it("2.1 Checks and Today say it is a takeback, whole", async () => {
    const list = renderAt(<RemittanceList />, "/rcm/remittances");
    const waiting = await screen.findByTestId(`remittance-waiting-${T}`);
    expect(waiting.textContent).toBe("A takeback — money the carrier is reclaiming");
    expectWraps(waiting, `remittance-row-${T}`);
    sweep(list.container);
    list.unmount();

    const today = renderAt(<RcmToday />, "/rcm");
    const next = await screen.findByTestId(`rcm-arrival-next-${T}`);
    expect(next.textContent).toBe("The carrier is reclaiming money. It is authorised on its own.");
    expectWraps(next, `rcm-arrival-${T}`);
    sweep(today.container);
  });

  it("2.2 Before you say yes routes it to the takeback panel — never the failure list", async () => {
    const { container } = renderAt(<ApproveCheck />, `/rcm/remittances/${T}/approve`);
    expect((await screen.findByTestId("approve-takeback-line")).textContent).toContain("taking money back");
    expect(screen.getByTestId("approve-takeback-go").getAttribute("href")).toBe(`/rcm/remittances/${T}#takeback`);
    expect(screen.queryByTestId("approve-checks")).toBeNull();
    expect(screen.queryByTestId("approve-conditions")).toBeNull();
    expect(screen.queryByTestId("approve-button")).toBeNull();
    sweep(container);
  });

  it("2.3 the panel: the typed field is dead, with its reason, until the takeback is matched", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${T}`);
    const panel = await screen.findByTestId("recoupment-panel");
    expect(panel.closest("#takeback")).toBeTruthy();
    const input = screen.getByTestId("recoupment-confirm-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId("recoupment-needs-match").textContent).toContain(
      `${MANGO.name}'s claim is not linked to an Open Dental claim yet.`,
    );
    // The reversible adjustment is the default before anybody touches anything.
    expect((screen.getByTestId("recoupment-path-adjustment") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("recoupment-approve-button") as HTMLButtonElement).disabled).toBe(true);
    sweep(container);
  });

  it("2.4 matching the takeback claim: its claim number agrees, so it links in one press", async () => {
    const { container } = renderAt(<ClaimMatch />, claimHref(TC, T));
    fireEvent.click(await screen.findByTestId("rcm-cta"));
    await waitFor(() => expect(srv.calls).toContain(`matchClaim:${TC}:plain`));
    fireEvent.click(await screen.findByTestId("match-guidance-confirm"));
    await waitFor(() => expect(srv.calls).toContain(`confirmClaimMatch:${TC}:900411`));
    expect(screen.queryByTestId("match-anyway")).toBeNull();
    sweep(container);
  });

  it("2.5 the permanent path is never one click away; declining is focused and costs nothing", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${T}`);
    const input = (await screen.findByTestId("recoupment-confirm-input")) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.queryByTestId("recoupment-needs-match")).toBeNull();

    const radio = (p: string) => screen.getByTestId(`recoupment-path-${p}`) as HTMLInputElement;
    fireEvent.click(radio("supplemental"));
    // ONE CLICK DID NOT SELECT IT.
    expect(radio("supplemental").checked).toBe(false);
    expect(radio("adjustment").checked).toBe(true);
    expect(screen.getByTestId("recoupment-permanent-yes").textContent).toBe(
      "Use the permanent one — it can never be undone",
    );
    expect(document.activeElement).toBe(screen.getByTestId("recoupment-permanent-cancel"));
    sweep(container);

    fireEvent.click(screen.getByTestId("recoupment-permanent-cancel"));
    expect(screen.queryByTestId("recoupment-permanent-confirm")).toBeNull();
    expect(radio("adjustment").checked).toBe(true);
  });

  it("2.6 the typed amount must match exactly — minus sign, cents and all", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${T}`);
    const input = (await screen.findByTestId("recoupment-confirm-input")) as HTMLInputElement;
    expect(screen.getByTestId("recoupment-expected").textContent).toBe("-29.00");
    const button = () => screen.getByTestId("recoupment-approve-button") as HTMLButtonElement;

    for (const wrong of ["29.00", "-29", "-29.0", "-$29.00", "−29.00", "-29.01"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(button().disabled, `"${wrong}" must not enable it`).toBe(true);
      expect(screen.getByTestId("recoupment-awaiting-phrase")).toBeTruthy();
      sweep(container);
    }
    fireEvent.change(input, { target: { value: "-29.00" } });
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(srv.calls.some((c) => c.startsWith("approveRecoupment"))).toBe(false);
  });

  it("2.7 'already approved' routes to Posting with a link — never an invitation to press again", async () => {
    srv.recoupAlreadyApproved = true;
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${T}`);
    fireEvent.change(await screen.findByTestId("recoupment-confirm-input"), { target: { value: "-29.00" } });
    fireEvent.click(screen.getByTestId("recoupment-approve-button"));

    const answer = await screen.findByTestId("recoupment-already-approved");
    expect(answer.textContent).toContain("Already approved — see it on the Posting screen");
    expect(screen.getByTestId("recoupment-already-approved-link").getAttribute("href")).toBe("/rcm/posting");
    expect(screen.queryByTestId("recoupment-approve-button")).toBeNull();
    expect(screen.queryByTestId("recoupment-error")).toBeNull();
    // The press carried the default path and the exact phrase.
    expect(srv.calls).toContain("approveRecoupment:adjustment:-29.00");
    sweep(container);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · POSTING TRUTH, EVERY CASE
// ═════════════════════════════════════════════════════════════════════════════

const P = "chk-900131";
const PQ = "q-900131";
const P1 = "clm-900231";
const P2 = "clm-900232";
const CHECK_NO = 900601;

/** The drain's own text — it carries the claims no stopped card may echo. */
const SERVER_CLAIM =
  "NOTHING was written. No check was created. Resolve the extra line in the chart, then post again.";
const NOTHING_WRITTEN = /nothing (was|has been) (written|sent)|no open dental call|no check was created|starts clean/i;
/** Remediation a stopped card must never give — the verbs of the fix path. */
const REMEDIATION = /What the chart says|Check it again|raise the write-off|put back|add a |promised \$|Resolve the extra/i;
const EARLIER_CHECK = (n: number) =>
  `An Open Dental check #${n} from an earlier run exists. Do not enter this payment again by hand.`;
/** A projection's words — a posted check speaks only the measured register. */
const PROJECTION = /will owe|will be billed|projection|what this check says will happen/i;

function confirmedVerdict(over: Record<string, unknown> = {}) {
  return mkVerdict({
    register: "confirmed",
    eobPatientCents: 45000,
    projectedPatientCents: 45000,
    contractualWriteOffCents: 30000,
    sentence: "Patient owes $450.00 — matches the EOB. Confirmed in Open Dental.",
    ...over,
  });
}

function postingWorld(plan: Record<string, unknown>, claimVerdict?: Record<string, unknown>) {
  resetWorld();
  srv.auth = ADMIN;
  const queued = (id: string, name: { patNum: number; name: string }, claimNumber: string, odClaimNum: number) =>
    mkClaim(id, {
      claimNumber,
      checkNumber: "900700131",
      patientName: name.name,
      odMatchStatus: "confirmed",
      odClaimNum,
      odPatientId: name.patNum,
      reviewedAt: "2026-09-08T23:00:00.000Z",
      reviewedBy: "Billing Person",
      postingQueueId: PQ,
      approvedAt: "2026-09-08T23:30:00.000Z",
      verdict: claimVerdict ?? mkVerdict({ eobPatientCents: 45000, projectedPatientCents: 45000 }),
      confirmedAt: claimVerdict?.register === "confirmed" ? "2026-09-09T00:10:00.000Z" : null,
      identity: { matched: true, blocking: false, fields: [] },
      fixture: { snapshot: null },
    });
  addCheck(
    P,
    { checkNumber: "900700131", traceNumber: "900700131", totalAmountCents: 90000 },
    [queued(P1, STEDI, "900331", 900431), queued(P2, MANGO, "900332", 900432)],
    { queueId: PQ },
  );
  srv.plans[PQ] = srv.makePlan({
    queueId: PQ,
    batchId: P,
    intendedTotalCents: 90000,
    checkNumber: "900700131",
    ...plan,
  });
  srv.planExtras[PQ] = {
    lines: [P1, P2].map((claimId, i) => ({
      queueLineId: `ql-90013${i}`,
      position: i + 1,
      odClaimNum: 900431 + i,
      odClaimProcNum: 900531 + i,
      status: plan.status === "posted" ? "paid" : "pending",
      skipReason: null,
      intendedInsPayAmtCents: 45000,
      intendedWriteOffCents: 30000,
      intendedDedAppliedCents: 0,
      isSupplemental: false,
      recoupmentPath: null,
      odAdjustmentNum: null,
      odSupplementalClaimProcNum: null,
      claimprocWrittenAt: null,
      claimReceivedAt: null,
      paidAt: null,
      odClaimPaymentNum: plan.odClaimPaymentNum ?? null,
      readback: null,
      readbackAt: null,
      lastError: null,
      decidedWriteOffCents: null,
      decidedReason: null,
      decidedBy: null,
      intendedPatientCents: 45000,
      odWriteoffAdjustmentNum: null,
    })),
  };
}

/** Render the check's own page and hand back its posting card, loaded. */
async function postCard(): Promise<{ card: HTMLElement; container: HTMLElement }> {
  const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${P}`);
  const card = await screen.findByTestId("post-this-check");
  return { card, container };
}

const FAILED_STEPS = [null, ...POSTING_STEPS];
const STOPPED_STEPS = [null, ...POSTING_STEPS.filter((s) => s !== "confirm_patient")];

describe("3 · posting truth, on the check's own page", () => {
  it("3.1 queued, never tried: the one place 'nothing has been written' is known", async () => {
    postingWorld({ status: "approved", statusLabel: "queued", attemptCount: 0 });
    const { card, container } = await postCard();
    expect(within(card).getByTestId("post-this-check-hint").textContent).toBe(
      "Approved and waiting. Nothing has been written to Open Dental yet.",
    );
    expect(within(card).queryByTestId("post-this-check-earlier-check")).toBeNull();
    expect(card.textContent).not.toMatch(CURRENCY);
    sweep(container);
  });

  it("3.2 queued after an attempt: the safe-to-press-again copy, and no nothing-written claim", async () => {
    postingWorld({ status: "approved", statusLabel: "queued", attemptCount: 2 });
    const { card, container } = await postCard();
    const hint = within(card).getByTestId("post-this-check-hint").textContent ?? "";
    expect(hint).toBe(`Approved and waiting. An earlier posting run did not finish. ${POST_AGAIN_SAFE}`);
    expect(card.textContent).not.toMatch(NOTHING_WRITTEN);
    expect(card.textContent).not.toMatch(CURRENCY);
    sweep(container);
  });

  for (const step of FAILED_STEPS) {
    for (const withCheck of [true, false]) {
      it(`3.3 failed · ${String(step)} · ${withCheck ? "a check exists" : "no check"}: where it stopped, no figure, no fix, no echo`, async () => {
        postingWorld({
          status: "failed",
          statusLabel: "failed",
          step,
          attemptCount: 1,
          // What the drain leaves: the check number KEPT, the posted total ZEROED.
          odClaimPaymentNum: withCheck ? CHECK_NO : null,
          postedTotalCents: 0,
          lastError: SERVER_CLAIM,
        });
        const { card, container } = await postCard();
        expect(within(card).getByTestId("post-this-check-hint").textContent).toBe(
          `The run stopped ${stoppedWhile(step)}. ${POST_AGAIN_SAFE}`,
        );
        const text = card.textContent ?? "";
        // NO FIGURE OF ANY KIND on a stopped card — the $0.00 was nobody's measurement.
        expect(text).not.toMatch(CURRENCY);
        expect(text).not.toMatch(REMEDIATION);
        expect(text).not.toMatch(NOTHING_WRITTEN);
        expect(text).not.toContain("Resolve the extra line");
        // THE CHECK NUMBER, EXACTLY WHEN THERE IS ONE — it is the do-not-re-enter evidence.
        const earlier = within(card).queryByTestId("post-this-check-earlier-check");
        if (withCheck) expect(earlier?.textContent).toBe(EARLIER_CHECK(CHECK_NO));
        else expect(earlier).toBeNull();
        expect(within(card).queryByTestId("post-this-check-proof")).toBeNull();
        sweep(container);
      });
    }
  }

  it("3.4 partly posted at confirm_patient, with a measurement: green 'did reach' FIRST, then the compare, and a re-check", async () => {
    postingWorld(
      {
        status: "partially_posted",
        statusLabel: "partially_posted",
        step: "confirm_patient",
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        postedTotalCents: 90000,
        lastError: "Open Dental says the patient owes $30.00 — this check said $0.00.",
      },
      confirmedVerdict({
        state: "red",
        eobPatientCents: 3000,
        projectedPatientCents: 3000,
        decidedWriteOffCents: 3000,
        sentence: "Open Dental says the patient owes $30.00 — this check said $0.00.",
        problems: [{ kind: "chart_disagrees", code: "D0274", lineId: "l-2", detail: "D0274 reads $30.00." }],
      }),
    );
    const { card, container } = await postCard();
    const measured = within(card).getByTestId("stuck-measured");
    const landed = within(card).getByTestId("stuck-money-landed");
    expect(landed.textContent).toContain("The payment did reach Open Dental.");
    expect(landed.className).toContain("emerald");
    const compare = await within(card).findByTestId(`stuck-compare-${P1}`);
    // DOCUMENT ORDER IS THE ARGUMENT: the green fact, then the compare, then the steps.
    const steps = within(card).getByTestId("stuck-steps");
    expect(landed.compareDocumentPosition(compare) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compare.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and nothing in the panel comes before the green fact.
    expect(measured.firstElementChild?.contains(landed) || measured.firstElementChild === landed).toBe(true);
    expect(within(card).getByTestId("stuck-recheck").textContent).toBe(
      "Check it again — reads the chart, writes nothing",
    );
    expect(measured.textContent).not.toContain("Posting stopped part-way");
    expect(sweep(container)).toContain("stuck panel");
  });

  for (const step of STOPPED_STEPS) {
    it(`3.5 partly posted · ${String(step)}: stopped — no figure, no re-check, no fix`, async () => {
      postingWorld({
        status: "partially_posted",
        statusLabel: "partially_posted",
        step,
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        postedTotalCents: 90000,
        lastError: SERVER_CLAIM,
      });
      const { card, container } = await postCard();
      expect(within(card).getByTestId("stuck-stopped")).toBeTruthy();
      expect(within(card).getByTestId("stuck-stopped-step").textContent).toContain(stoppedWhile(step));
      for (const id of ["stuck-measured", "stuck-recheck", "stuck-numbers", "stuck-steps"]) {
        expect(within(card).queryByTestId(id), id).toBeNull();
      }
      const text = card.textContent ?? "";
      expect(text).not.toMatch(CURRENCY);
      expect(text).not.toMatch(REMEDIATION);
      expect(text).not.toMatch(NOTHING_WRITTEN);
      expect(srv.calls).not.toContain(`recheckPosting:${PQ}`);
      sweep(container);
    });
  }

  it("3.6 posted: the measured register, and only the measured register", async () => {
    postingWorld(
      {
        status: "posted",
        statusLabel: "posted",
        step: "document_attach",
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        postedTotalCents: 90000,
        reconciledAt: "2026-09-09T00:10:00.000Z",
        finishedAt: "2026-09-09T00:10:00.000Z",
        documentAttachStatus: "none",
      },
      confirmedVerdict(),
    );
    const { card, container } = await postCard();
    expect(within(card).getByTestId("post-this-check-state").textContent).toBe("Finished");
    await waitFor(() =>
      expect(within(card).getByTestId("posted-register").textContent).toContain(
        "after posting, not calculated by this app",
      ),
    );
    expect(within(card).queryByTestId("posted-unmeasured")).toBeNull();
    expect(card.textContent).not.toMatch(PROJECTION);
    expect(within(card).queryByTestId("post-this-check-button")).toBeNull();
    sweep(container);
  });

  it("3.7 a swept check: approved again after an interrupted run — no claim, no echo, the number and no figure", async () => {
    postingWorld({
      status: "approved",
      statusLabel: "queued",
      step: "office_writeoffs",
      attemptCount: 1,
      odClaimPaymentNum: CHECK_NO,
      postedTotalCents: 0,
      lastError: SERVER_CLAIM,
    });
    const { card, container } = await postCard();
    const text = card.textContent ?? "";
    expect(within(card).getByTestId("post-this-check-hint").textContent).toBe(
      `Approved and waiting. An earlier posting run did not finish. ${POST_AGAIN_SAFE}`,
    );
    expect(text).not.toMatch(NOTHING_WRITTEN);
    expect(text).not.toContain("Resolve the extra line");
    expect(within(card).queryByTestId("post-this-check-last-error")).toBeNull();
    expect(within(card).getByTestId("post-this-check-earlier-check").textContent).toBe(EARLIER_CHECK(CHECK_NO));
    expect(text).not.toMatch(CURRENCY);
    sweep(container);
  });

  /*
   * A BLOCKED RE-PRESS — the ruling, extended (PR #171 round 1). A refusal
   * touches neither column, so the earlier run's check number AND its recorded
   * total are both still on the row. The total is not a current measurement:
   * the number stays, the figure goes, exactly as on a stopped card. Unlike a
   * stopped card, the blocked reason's own fix copy IS the remediation, so
   * REMEDIATION is not asserted here — its sentences are the product's to say.
   */
  for (const blockedReason of ["office_config_unresolved", "eligible_total_mismatch", "claim_not_confirmed"]) {
    for (const withCheck of [true, false]) {
      it(`3.9 blocked · ${blockedReason} · ${withCheck ? "an earlier check" : "no check"}: the refusal's copy, the number and no figure`, async () => {
        postingWorld({
          status: "blocked",
          statusLabel: "blocked",
          blockedReason,
          step: null,
          attemptCount: 2,
          // What the earlier run left, which the refusal did not touch.
          odClaimPaymentNum: withCheck ? CHECK_NO : null,
          postedTotalCents: withCheck ? 90000 : 0,
          lastError: SERVER_CLAIM,
        });
        const { card, container } = await postCard();
        expect(within(card).getByTestId("post-this-check-state").textContent).toBe(QUEUE_STATE_COPY.blocked.label);
        expect(within(card).getByTestId("post-this-check-hint").textContent).toBe(QUEUE_STATE_COPY.blocked.hint);
        expect(within(card).getByTestId("post-this-check-blocked")).toBeTruthy();
        const text = card.textContent ?? "";
        // NO FIGURE OF ANY KIND — the recorded $900.00 is the earlier run's, not a measurement.
        expect(text).not.toMatch(CURRENCY);
        expect(text).not.toMatch(NOTHING_WRITTEN);
        expect(within(card).queryByTestId("post-this-check-last-error")).toBeNull();
        // THE CHECK NUMBER, EXACTLY WHEN THERE IS ONE.
        const earlier = within(card).queryByTestId("post-this-check-earlier-check");
        if (withCheck) expect(earlier?.textContent).toBe(EARLIER_CHECK(CHECK_NO));
        else expect(earlier).toBeNull();
        expect(within(card).queryByTestId("post-this-check-proof")).toBeNull();
        sweep(container);
      });
    }
  }
});

describe("3 · posting truth, on the Posting history — every row at once", () => {
  it("3.8 each row tells its own state once, echoes no run text, and proves only what posted", async () => {
    resetWorld();
    srv.auth = ADMIN;
    const rows: Record<string, unknown>[] = [
      { queueId: "q-fresh", status: "approved", statusLabel: "queued", attemptCount: 0 },
      { queueId: "q-swept", status: "approved", statusLabel: "queued", attemptCount: 1, odClaimPaymentNum: CHECK_NO, lastError: SERVER_CLAIM },
      {
        queueId: "q-blocked",
        status: "blocked",
        statusLabel: "blocked",
        blockedReason: "office_config_unresolved",
        attemptCount: 2,
        odClaimPaymentNum: CHECK_NO,
        postedTotalCents: 90000,
        lastError: SERVER_CLAIM,
      },
      ...FAILED_STEPS.map((step, i) => ({
        queueId: `q-failed-${i}`,
        status: "failed",
        statusLabel: "failed",
        step,
        attemptCount: 1,
        odClaimPaymentNum: i % 2 ? CHECK_NO : null,
        lastError: SERVER_CLAIM,
      })),
      ...STOPPED_STEPS.map((step, i) => ({
        queueId: `q-stopped-${i}`,
        status: "partially_posted",
        statusLabel: "partially_posted",
        step,
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        lastError: SERVER_CLAIM,
      })),
      {
        queueId: "q-measured",
        status: "partially_posted",
        statusLabel: "partially_posted",
        step: "confirm_patient",
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        lastError: "Open Dental says the patient owes $30.00 — this check said $0.00.",
      },
      {
        queueId: "q-posted",
        status: "posted",
        statusLabel: "posted",
        attemptCount: 1,
        odClaimPaymentNum: CHECK_NO,
        reconciledAt: "2026-09-09T00:10:00.000Z",
      },
    ];
    for (const [i, r] of rows.entries()) {
      srv.plans[String(r.queueId)] = srv.makePlan({ batchId: `chk-9002${String(i).padStart(2, "0")}`, intendedTotalCents: 90000, ...r });
    }

    const { container } = renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-plan-q-fresh");

    for (const r of rows) {
      const q = String(r.queueId);
      const row = screen.getByTestId(`posting-plan-${q}`);
      const hint = screen.getByTestId(`posting-hint-${q}`).textContent ?? "";
      expect(hint, q).toBe(queueHint(r as never));
      expect(row.textContent, q).not.toContain("Resolve the extra line");
      // The claim is KNOWN only on a row approved and never tried.
      if (r.attemptCount !== 0) expect(row.textContent, q).not.toMatch(NOTHING_WRITTEN);
      // THE PROOF only where the database says it posted.
      expect(Boolean(within(row).queryByTestId(`posting-proof-${q}`)), q).toBe(r.status === "posted");
    }
    expect(screen.getByTestId("posting-measured-q-measured")).toBeTruthy();
    for (const [i] of STOPPED_STEPS.entries()) {
      expect(screen.getByTestId(`posting-stopped-q-stopped-${i}`).textContent).toContain(
        "Nothing on this screen is a reason to change a chart.",
      );
    }
    expect(sweep(container)).toContain("posting card");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · SHADOW
// ═════════════════════════════════════════════════════════════════════════════

const SH = "chk-900121";
const SHC = "clm-900221";

function shadowWorld() {
  resetWorld();
  srv.postingEnabled = true;
  srv.drainEnabled = false;
  addCheck(SH, { checkNumber: "900700121", traceNumber: "900700121", totalAmountCents: 45000 }, [
    mkClaim(SHC, {
      claimNumber: "900321",
      checkNumber: "900700121",
      odMatchStatus: "confirmed",
      odClaimNum: 900421,
      odPatientId: STEDI.patNum,
      reviewedAt: "2026-09-08T23:00:00.000Z",
      reviewedBy: "Billing Person",
      verdict: mkVerdict({
        eobPatientCents: 45000,
        projectedPatientCents: 45000,
        contractualWriteOffCents: 30000,
        sentence: "Will owe $450.00 — matches the EOB.",
      }),
      identity: { matched: true, blocking: false, fields: [] },
      fixture: { snapshot: null },
    }),
  ]);
}

function renderShell(path: string) {
  const memory = memoryLocation({ path, record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <ModuleProvider>
            <OfficeProvider>
              <RcmShadowProvider>
                <DashboardLayout>
                  <div data-testid="page-body">page</div>
                </DashboardLayout>
              </RcmShadowProvider>
            </OfficeProvider>
          </ModuleProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

describe("4 · shadow", () => {
  beforeAll(shadowWorld);

  it("4.1 the header pill: on every RCM screen while posting is switched off, and gone when it is on", async () => {
    const on = renderShell(`/rcm/remittances/${SH}`);
    expect((await screen.findByTestId("rcm-shadow-pill")).textContent).toBe(
      "Shadow mode — nothing is sent to Open Dental yet",
    );
    on.unmount();

    srv.drainEnabled = true;
    srv.calls = [];
    renderShell(`/rcm/remittances/${SH}`);
    await screen.findByTestId("rcm-header-identity");
    // WAIT FOR THE ANSWER, then look: an absence asserted before the posting
    // read returned would pass whether or not the pill was going to appear.
    await waitFor(() => expect(srv.calls).toContain("listPostingQueue"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("rcm-shadow-pill")).toBeNull();
    srv.drainEnabled = false;
  });

  it("4.2 before approving: the banner says so, and there is no worksheet and no comparison yet", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${SH}`);
    const banner = await screen.findByTestId("shadow-mode-banner");
    expect(within(banner).getByTestId("shadow-banner-body").textContent).toBe(SHADOW_MODE_COPY.banner);
    expect(screen.queryByTestId("shadow-would-have-done")).toBeNull();
    expect(screen.queryByTestId("check-comparison")).toBeNull();
    sweep(container);
  });

  it("4.3 approving the check", async () => {
    const { container } = renderAt(<ApproveCheck />, `/rcm/remittances/${SH}/approve`);
    fireEvent.click(await screen.findByTestId("approve-button"));
    await screen.findByTestId("approve-result");
    expect(srv.calls).toContain(`approveRemittance:${SH}`);
    sweep(container);
  });

  it("4.4 after approving: the would-have-done worksheet, the post held, and the question asked", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${SH}`);
    const sheet = await screen.findByTestId("shadow-would-have-done");
    expect(sheet.textContent).toContain("What this app would have done, if posting were on");
    expect(screen.getByTestId(`shadow-paid-${SHC}`).textContent).toBe("$450.00");
    expect(((await screen.findByTestId("post-this-check-button")) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("comparison-ask")).toBeTruthy();
    expect(screen.getByTestId("comparison-same").textContent).toContain("Yes — same as I did by hand");
    expect(sweep(container)).toContain("shadow banner");
  });

  it("4.5 'Yes — same as I did by hand' is one click: recorded once, nothing asked in between", async () => {
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${SH}`);
    fireEvent.click(await screen.findByTestId("comparison-same"));
    await waitFor(() =>
      expect(srv.calls.filter((c) => c === `recordComparison:${SH}:same`)).toHaveLength(1),
    );
    expect(screen.queryByTestId("comparison-form")).toBeNull();
    await screen.findByTestId("comparison-answered");
    sweep(container);
  });

  it("4.6 'No — something was off' opens the reason form and records nothing until it is filled in", async () => {
    srv.checks[SH].row.comparisonVerdict = null;
    const before = srv.calls.length;
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${SH}`);
    fireEvent.click(await screen.findByTestId("comparison-differed"));
    expect(screen.getByTestId("comparison-form")).toBeTruthy();
    expect(srv.calls.slice(before).some((c) => c.startsWith("recordComparison"))).toBe(false);
    sweep(container);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · THE SWEEPS, ON THEIR OWN
// ═════════════════════════════════════════════════════════════════════════════

describe("5a · one state sentence per card (W-8's class)", () => {
  it("the posting vocabulary covers every label and every step, and no member contains another", () => {
    for (const copy of Object.values(QUEUE_STATE_COPY)) expect(POSTING_VOCAB).toContain(copy.hint);
    for (const step of POSTING_STEPS) {
      expect(POSTING_VOCAB).toContain(queueHint({ statusLabel: "failed", step, attemptCount: 1 }));
    }
    for (const a of POSTING_VOCAB) {
      for (const b of POSTING_VOCAB) if (a !== b) expect(a.includes(b), `"${a}" ⊃ "${b}"`).toBe(false);
    }
  });

  it("the Waiting on vocabulary is every state waitingFor can be in", () => {
    expect([...WAITING_VOCAB.states].sort()).toEqual([...WAITING_STATES].sort());
  });

  it("the approve vocabulary matches what standingLine actually says", () => {
    const all1 = standingLine({ state: "all_approved", total: 1 } as never) ?? "";
    const allN = standingLine({ state: "all_approved", total: 3 } as never) ?? "";
    const nothing = standingLine({ state: "nothing_ready", total: 2 } as never) ?? "";
    const none = standingLine({ state: "no_claims", total: 0 } as never) ?? "";
    const states = (t: string) => APPROVE_VOCAB.filter(([, re]) => re.test(t)).map(([s]) => s);
    expect(states(all1)).toEqual(["all_approved"]);
    expect(states(allN)).toEqual(["all_approved"]);
    expect(states(nothing)).toEqual(["nothing_ready"]);
    expect(states(none)).toEqual(["no_claims"]);
  });

  it("is not vacuous — a card carrying W-1's two sentences is caught", () => {
    const { container } = render(
      <div>
        <section data-testid="approve-decide">
          <p>{standingLine({ state: "all_approved", total: 3 } as never)}</p>
          <p>{standingLine({ state: "nothing_ready", total: 3 } as never)}</p>
        </section>
        <section data-testid="post-this-check">
          <p>{queueHint({ statusLabel: "queued", step: null, attemptCount: 0 })}</p>
          <p>{queueHint({ statusLabel: "failed", step: "check", attemptCount: 1 })}</p>
        </section>
      </div>,
    );
    const problems = multiStateCards(container);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("[post-this-check]");
    expect(problems[1]).toContain("[approve-decide]");
  });
});

describe("5b · every match run names what it skipped", () => {
  /**
   * THE PROPERTY, over every combination: the numbers the summary prints add up
   * to every claim the run was handed. Anything it did not say it matched, it
   * says it left alone — and why.
   */
  it("accounts for every claim, for every mix of outcomes", () => {
    const statuses = ["candidates", "confirmed", "already_confirmed", "no_candidate", "failed"] as const;
    let combos = 0;
    for (let mask = 0; mask < 3 ** statuses.length; mask++) {
      const counts = statuses.map((_, i) => Math.floor(mask / 3 ** i) % 3);
      for (const skipped of [0, 3]) {
        for (const outOfTime of skipped ? [true, false] : [false]) {
          const matched = statuses.flatMap((status, i) =>
            Array.from({ length: counts[i] }, (_, j) => ({ claimId: `c-${status}-${j}`, status, error: "down" })),
          );
          const result = {
            office: "roland",
            batchId: "chk-900199",
            matched,
            odCalls: 1,
            pacingMs: 1200,
            budgetMs: 90_000,
            outOfTime,
            skipped,
          } as unknown as BatchMatchResponse;
          const summary = matchRunSummary(result);
          const printed = [summary.did, ...summary.leftAlone]
            .join(" · ")
            .replace(/(\d+)-second/g, "")
            .match(/\d+/g)
            ?.map(Number)
            .reduce((a, b) => a + b, 0) ?? 0;
          expect(printed, JSON.stringify({ counts, skipped, outOfTime })).toBe(matched.length + skipped);
          if (counts[2]) expect(summary.leftAlone.join()).toContain("already confirmed");
          if (counts[3]) expect(summary.leftAlone.join()).toContain("nothing in Open Dental to match");
          if (counts[4]) expect(summary.leftAlone.join()).toContain("could not be read");
          if (skipped) expect(summary.leftAlone.join()).toMatch(outOfTime ? /second limit/ : /not looked at/);
          combos++;
        }
      }
    }
    // 3^5 mixes × (no skip · skipped by the clock · skipped by the cap).
    expect(combos).toBe(3 ** 5 * 3);
  });

  it("on the check's page, a run the clock stopped names the claims it never reached", async () => {
    dayWorld();
    srv.checks[A].hidden = false;
    srv.matchOverride = { outOfTime: true, skipped: 1, budgetMs: 90_000 };
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    fireEvent.click(await screen.findByTestId("rcm-cta"));
    const summary = await screen.findByTestId("batch-match-summary");
    expect(summary.textContent).toContain("1 not reached before this run's 90-second limit");
    expect(screen.getByTestId("match-out-of-time").textContent).toContain("1 claim not yet examined");
    sweep(container);
  });

  it("a claim matched again from its own row says what it found and that nothing was linked", async () => {
    dayWorld();
    srv.checks[A].hidden = false;
    const { container } = renderAt(<RemittanceDetail />, `/rcm/remittances/${A}`);
    fireEvent.click(await screen.findByTestId(`rematch-claim-${C2}`));
    const note = await screen.findByTestId(`rematch-note-${C2}`);
    expect(note.textContent).toBe(
      "Looked again — 2 possible claims in Open Dental. Nothing is linked; open the claim to pick one.",
    );
    expect(srv.calls).toContain(`matchClaim:${C2}:plain`);
    sweep(container);
  });
});

describe("5c · the banned-words guard and the disabled-with-reason scan", () => {
  const TESTS = join(__dirname);

  it("the rendered-text list here is the source guard's list, pattern for pattern", () => {
    const guard = readFileSync(join(TESTS, "rcm-plain-language.test.ts"), "utf8");
    for (const re of BANNED) {
      expect(guard.includes(re.source), `rcm-plain-language.test.ts no longer bans /${re.source}/`).toBe(true);
    }
    expect(guard).toContain('it("has no banned word in any string a person reads"');
  });

  it("the disabled-with-reason scan still runs over the RCM screens", () => {
    const scan = readFileSync(join(TESTS, "rcm-disabled-reasons.test.tsx"), "utf8");
    expect(scan).toContain("function unexplainedDisabledControls");
    expect(scan).toContain('describe("no RCM screen greys a control without saying why"');
  });

  it("both scans here are not vacuous — they catch what they ban", () => {
    const { container } = render(
      <div>
        <p>Nothing waiting to drain on this posting plan.</p>
        <div>
          <button disabled>Post</button>
        </div>
      </div>,
    );
    expect(bannedWordHits(container)).toHaveLength(1);
    expect(unexplainedDisabled(container)).toHaveLength(1);
  });
});

describe("5d · sentences wrap, identifiers truncate", () => {
  it("the shell's direction tests are still in place, both halves", () => {
    const shell = readFileSync(join(__dirname, "rcm-shell.test.tsx"), "utf8");
    expect(shell).toContain('describe("a column whose job is a sentence never cuts itself off"');
    expect(shell).toContain('it("still truncates the IDENTIFIER cells beside them"');
    expect(existsSync(join(__dirname, "rcm-shell.test.tsx"))).toBe(true);
  });
});

describe("5e · machine office keys never render", () => {
  it("the key scan is not vacuous — it catches a key in text or an attribute, and lets the name through", () => {
    const { container } = render(
      <div>
        <p>Posting is switched off for roland (shadow mode).</p>
        <button aria-label="Refresh valley">↻</button>
        <p>Posting is switched off for {RCM_OFFICE_LABELS.roland} (shadow mode).</p>
        <p>{RCM_OFFICE_LABELS.valley} is unaffected.</p>
      </div>,
    );
    expect(officeKeyHits(container)).toEqual([
      "Posting is switched off for roland (shadow mode).",
      "Refresh valley",
    ]);
    // Every frozen key is covered — a third office is a migration, and this scan follows it.
    for (const key of RCM_OFFICE_IDS) expect(OFFICE_KEY.test(`for ${key}.`), key).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · THE S7 INVENTORY — written, not asserted
// ═════════════════════════════════════════════════════════════════════════════
//
// `RCM_INVENTORY=1 pnpm exec vitest run tests/rcm-smoke.test.tsx` writes
// `docs/rcm-s7-inventory.md` from what the walk above actually rendered. It is
// the before/after evidence for the clarity slice, and it is deliberately a
// SIDE EFFECT of the walk rather than a suite of its own: a screen measured in
// a state nobody walked to is a screen measured in a state that does not exist.

const INVENTORY_ORDER = [
  "today",
  "bring-in",
  "checks",
  "check",
  "claim",
  "approve",
  "takeback-route",
  "posted",
  "stuck",
  "shadow-worksheet",
  "activity",
  "takeback-sop",
];

afterAll(() => {
  if (process.env.RCM_INVENTORY !== "1") return;
  const lines: string[] = [
    "| Screen | Kind | Chrome words | Whole-render words | Clickable actions | Primary buttons | Primary label(s) | Renders |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |",
  ];
  for (const id of INVENTORY_ORDER) {
    const spec = SCREENS[id];
    const m = INVENTORY[id];
    if (!spec) continue;
    if (!m) {
      lines.push(`| ${spec.label} | ${spec.kind} | — | — | — | — | *not reached by the walk* | 0 |`);
      continue;
    }
    const labels = m.primaryLabels.filter(Boolean).map((l) => `“${l}”`).join(" · ") || "—";
    lines.push(
      `| ${spec.label} | ${spec.kind} | ${m.chrome} | ${m.words} | ${m.actions} | ${m.primaries} | ${labels} | ${m.seen} |`,
    );
  }
  const out = join(process.cwd(), "..", "docs", "rcm-s7-inventory-measured.md");
  writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
  if (!process.env.RCM_INVENTORY_DUMP) return;
  writeFileSync(
    join(process.env.RCM_INVENTORY_DUMP, "rcm-s7-chrome-dump.md"),
    INVENTORY_ORDER.filter((id) => CHROME_TEXT[id])
      .map((id) => `## ${SCREENS[id]?.label}\n\n${CHROME_TEXT[id]}\n`)
      .join("\n"),
    "utf8",
  );
});
