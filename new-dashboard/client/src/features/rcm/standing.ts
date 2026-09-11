/**
 * WHERE A CHECK STANDS BEFORE ANYBODY SAYS YES — one function, two renderers.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * W-1: THE HEADLINE AND THE TICKS HAD TWO DIFFERENT SOURCES
 * ═════════════════════════════════════════════════════════════════════════════
 * On the combined walk (2026-09-09, finding W-1) the approve page showed three
 * claims each reading **Approved**, a count line correctly reading *"0 of 3
 * claims can be approved · 3 already approved"* — and, under the greyed button:
 *
 *     "Nothing on this check can be approved yet — the list above says what
 *      each claim is waiting for."
 *
 * Nothing was waiting. The list above was every condition green, three times
 * over. The sentence was chosen from `postableCount === 0` alone, which is TRUE
 * of a blocked check and equally true of a finished one, and the screen had no
 * other way to tell the two apart.
 *
 * So the two facts are computed HERE, together, from the same walk of the same
 * claims: what state the check is in, and how each of the gate's conditions
 * stands across it. A headline that says "waiting" while every tick is green is
 * no longer a shape this page can render, because both come out of one call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONDITIONS ARE THE GATE'S OWN, AND NOTHING ELSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `conditions` is built by walking the checks the SERVER sent on each claim. A
 * code the response does not carry does not appear; a code it carries that this
 * build has never heard of appears anyway, under the gate's own label. There is
 * no list of conditions written down in the client — a checklist that could
 * assert a condition the gate is not applying would be worse than no checklist,
 * because it would be read as a promise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT COMPUTES NO MONEY
 * ─────────────────────────────────────────────────────────────────────────────
 * Not one cent is added up in this file. The money is `rollup.ts`, which sums
 * the per-claim verdicts the server wrote, and the two are deliberately separate
 * functions over the same array: one answers "what will the patients owe", the
 * other answers "may this be pressed". Folding them together is how a totals row
 * starts depending on a permission.
 */
import type { ApprovalCheck, ApprovalClaim } from "@/features/rcm/api";

/** Which of the three states a claim is in, in the gate's own terms. */
export type ClaimStanding = "approved" | "ready" | "not_ready";

export interface ClaimTicks {
  claimId: string;
  claimNumber: string;
  /** PHI. Carried, never logged — the page that renders it is audited. */
  patientName: string;
  standing: ClaimStanding;
  /** How many of this claim's conditions passed, and how many did not. */
  passed: number;
  failed: number;
}

/** One of the gate's conditions, across every claim that carried it. */
export interface ConditionTick {
  code: string;
  /** A check that carried this code, so the caller can render the gate's copy. */
  sample: ApprovalCheck;
  passedClaims: number;
  failedClaims: number;
  /** True when every claim carrying this condition passed it. */
  passed: boolean;
  /** Who it failed on, with the gate's own detail. Empty when it passed. */
  failedOn: { claimId: string; patientName: string; claimNumber: string; detail: string | null }[];
}

/**
 * The whole-check state.
 *
 *   no_claims     the gate judged nothing. Not "fine".
 *   all_approved  every claim is already on a posting. W-1's missing state.
 *   ready         at least one claim can be approved right now.
 *   nothing_ready claims exist, none can be approved, and not because they are
 *                 already done — this is the ONLY state the old caption was
 *                 ever true of.
 */
export type CheckStanding = "no_claims" | "all_approved" | "ready" | "nothing_ready";

export interface ApprovalStanding {
  total: number;
  postable: number;
  alreadyApproved: number;
  notReady: number;
  state: CheckStanding;
  claims: ClaimTicks[];
  conditions: ConditionTick[];
  /** Every condition passed on every claim that carried one. */
  allConditionsPassed: boolean;
}

/**
 * Walk the gate's answer once and report both halves of it.
 *
 * @param claims the approval preview's claims, in the check's own order.
 */
export function standing(claims: readonly ApprovalClaim[]): ApprovalStanding {
  const perClaim: ClaimTicks[] = [];
  const byCode = new Map<string, ConditionTick>();

  let postable = 0;
  let alreadyApproved = 0;
  let notReady = 0;

  for (const claim of claims) {
    const state: ClaimStanding = claim.alreadyQueued
      ? "approved"
      : claim.postable
        ? "ready"
        : "not_ready";
    if (state === "approved") alreadyApproved += 1;
    else if (state === "ready") postable += 1;
    else notReady += 1;

    let passed = 0;
    let failed = 0;
    for (const check of claim.checks) {
      if (check.passed) passed += 1;
      else failed += 1;

      let tick = byCode.get(check.code);
      if (!tick) {
        tick = {
          code: check.code,
          sample: check,
          passedClaims: 0,
          failedClaims: 0,
          passed: true,
          failedOn: [],
        };
        byCode.set(check.code, tick);
      }
      if (check.passed) {
        tick.passedClaims += 1;
      } else {
        tick.failedClaims += 1;
        tick.passed = false;
        /*
         * THE FAILING CHECK BECOMES THE SAMPLE. `checkDetail` renders a
         * different string for a pass than for a failure, and a roll-up row
         * marked ✗ that carried a passing claim's copy would describe the one
         * claim it is not about.
         */
        tick.sample = check;
        tick.failedOn.push({
          claimId: claim.claimId,
          patientName: claim.patientName,
          claimNumber: claim.claimNumber,
          detail: check.detail,
        });
      }
    }

    perClaim.push({
      claimId: claim.claimId,
      claimNumber: claim.claimNumber,
      patientName: claim.patientName,
      standing: state,
      passed,
      failed,
    });
  }

  // Array.from rather than a spread: this build's tsconfig targets ES5 and a
  // Map iterator cannot be spread there.
  const conditions = Array.from(byCode.values());
  const state: CheckStanding =
    claims.length === 0
      ? "no_claims"
      : postable > 0
        ? "ready"
        : alreadyApproved === claims.length
          ? "all_approved"
          : "nothing_ready";

  return {
    total: claims.length,
    postable,
    alreadyApproved,
    notReady,
    state,
    claims: perClaim,
    conditions,
    allConditionsPassed: conditions.every((c) => c.passed),
  };
}

/**
 * The one sentence under the button, chosen by the state and by nothing else.
 *
 * W-1 IS THIS FUNCTION'S WHOLE REASON. It is a total function over
 * `CheckStanding`, so "already approved" and "waiting on something" cannot
 * collapse into one string again: adding a state to the union without a case
 * here is a compile error.
 *
 * `ready` returns null — there is nothing to explain about a button that works.
 */
export function standingLine(st: ApprovalStanding): string | null {
  switch (st.state) {
    case "no_claims":
      return "There are no claims on this check for the app to judge.";
    case "all_approved":
      return st.total === 1
        ? "The one claim on this check is already approved. Nothing here is left for you to do — the money moves when somebody posts it."
        : `Every claim on this check is already approved — all ${st.total} of them. Nothing here is left for you to do; the money moves when somebody posts it.`;
    case "nothing_ready":
      return "Nothing on this check can be approved yet — the list above says what each claim is waiting for.";
    case "ready":
      return null;
  }
}
