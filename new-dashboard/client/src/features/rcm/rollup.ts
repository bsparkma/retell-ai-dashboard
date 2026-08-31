/**
 * THE CHECK-LEVEL ROLL-UP — Stage C, §6.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT SUMS THE PER-CLAIM VERDICTS. IT NEVER RECOMPUTES FROM LINES.
 * ═════════════════════════════════════════════════════════════════════════════
 * The approve page prints one row per claim — patient, paid, office write-off,
 * EOB says, patient will owe — and then a totals row underneath. There are two
 * ways to produce that totals row and only one of them is safe:
 *
 *   ✗ walk the check's lines and add up B, A and P again;
 *   ✓ add up the numbers the per-claim verdicts already carry.
 *
 * The first is a SECOND implementation of the module's money. It would agree
 * with the claim rows on the day it was written and diverge the first time
 * `verdictFor` learned something — a partial write-off, a line excluded from a
 * projection, a register that measures rather than derives. A totals row that
 * disagrees with the rows above it, on the last screen before an irreversible
 * press, is the worst place in this product for a number to be wrong.
 *
 * So: `verdictFor()` on the server is the only place the arithmetic happens
 * (`services/rcm/lineDecisions.js`), the gate carries its result out per claim
 * (`routes/rcm/approvalGate.js` — `verdict` on each preview claim), and this
 * file adds those results up. `tests/rcm-rollup.test.ts` asserts the identity
 * directly: the roll-up equals the sum of the claim verdicts, for every field.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A CLAIM WITH NO VERDICT IS COUNTED AS A CLAIM WITH NO VERDICT
 * ─────────────────────────────────────────────────────────────────────────────
 * `verdict` is optional on the wire — a snapshot in an older shape carries none,
 * exactly as `matchSnapshot` can be absent. Such a claim contributes NOTHING to
 * the totals and is counted in `unjudged`, which the page prints. Treating it as
 * zero silently would let a totals row understate what is about to post, which
 * is the same lie by a quieter route.
 */
import type { ApprovalClaim, ClaimVerdict, VerdictState } from "@/features/rcm/api";

export interface RollUpRow {
  claimId: string;
  claimNumber: string;
  /** PHI. The page that renders it is audited; this file only carries it. */
  patientName: string;
  /** Null when this claim carries no verdict — see the header. */
  verdict: ClaimVerdict | null;
}

export interface RollUp {
  rows: RollUpRow[];
  /** Σ over the claims that HAVE a verdict. Never over the ones that do not. */
  eobPatientCents: number;
  projectedPatientCents: number;
  decidedWriteOffCents: number;
  contractualWriteOffCents: number;
  /** Every office write-off across the check, with its reason and its author. */
  decisions: ClaimVerdict["decisions"];
  /** How many claims contributed. */
  judged: number;
  /** How many could not, because they carry no verdict. Printed, never hidden. */
  unjudged: number;
  /**
   * The worst state any contributing claim is in — red beats amber beats green.
   *
   * `null` when nothing contributed. Not "green": a roll-up over no verdicts has
   * not established that anything is fine.
   */
  worst: VerdictState | null;
}

/** red > amber > green. Used only to pick the roll-up's own tone. */
const SEVERITY: Record<VerdictState, number> = { green: 0, amber: 1, red: 2 };

/**
 * Add the per-claim verdicts up.
 *
 * @param claims the approval preview's claims, in the check's own order.
 */
export function rollUp(claims: readonly ApprovalClaim[]): RollUp {
  const rows: RollUpRow[] = claims.map((c) => ({
    claimId: c.claimId,
    claimNumber: c.claimNumber,
    patientName: c.patientName,
    verdict: c.verdict ?? null,
  }));

  let eobPatientCents = 0;
  let projectedPatientCents = 0;
  let decidedWriteOffCents = 0;
  let contractualWriteOffCents = 0;
  let judged = 0;
  let worst: VerdictState | null = null;
  const decisions: ClaimVerdict["decisions"] = [];

  for (const row of rows) {
    const v = row.verdict;
    if (!v) continue;
    judged += 1;
    eobPatientCents += v.eobPatientCents;
    projectedPatientCents += v.projectedPatientCents;
    decidedWriteOffCents += v.decidedWriteOffCents;
    contractualWriteOffCents += v.contractualWriteOffCents;
    for (const d of v.decisions) decisions.push(d);
    if (worst === null || SEVERITY[v.state] > SEVERITY[worst]) worst = v.state;
  }

  return {
    rows,
    eobPatientCents,
    projectedPatientCents,
    decidedWriteOffCents,
    contractualWriteOffCents,
    decisions,
    judged,
    unjudged: rows.length - judged,
    worst,
  };
}

/**
 * What the office decided to absorb on this check, one line per decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS LOAD-BEARING FOR A PERMISSION DECISION, NOT DECORATION
 * ─────────────────────────────────────────────────────────────────────────────
 * A line decision runs on `rcm.queue`; approving runs on `rcm.write`. A reviewer
 * PROPOSES a write-off and somebody with write authority ACCEPTS it — a split
 * that is only honest while the accepting screen shows WHOSE decision it is and
 * WHY. Collapse this into a total and the two tiers become one: a write-off
 * somebody else recorded would pass under a press that never saw it.
 *
 * (PM ruling, 2026-08-30; RCM_APPROVAL_GATE §3.5.) So this function exists to be
 * rendered as rows, and `rollUp().decidedWriteOffCents` exists to be rendered
 * BESIDE them — never instead of them.
 */
export function decisionsWithClaim(
  claims: readonly ApprovalClaim[],
): { patientName: string; claimNumber: string; decision: ClaimVerdict["decisions"][number] }[] {
  const out: {
    patientName: string;
    claimNumber: string;
    decision: ClaimVerdict["decisions"][number];
  }[] = [];
  for (const c of claims) {
    for (const d of c.verdict?.decisions ?? []) {
      out.push({ patientName: c.patientName, claimNumber: c.claimNumber, decision: d });
    }
  }
  return out;
}

/**
 * THE WHOLE-CHECK SENTENCE, in the PROJECTION register and no other.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ALLOWED TO EXIST WHEN `verdictFor` IS THE ONLY ARITHMETIC
 * ═════════════════════════════════════════════════════════════════════════════
 * `verdictFor()` produces a sentence PER CLAIM, already formatted, on the
 * server. There is no per-CHECK verdict function and there deliberately is not:
 * a check is not a unit the gate judges — it approves claim by claim, and a
 * partial approve is a feature (RCM_APPROVAL_GATE §"Partial success is real
 * success").
 *
 * So this function computes NO money. Every figure in the sentence it returns is
 * one `rollUp()` already summed out of the per-claim verdicts and the page has
 * already printed in its totals row. It is a reading of that row, not a second
 * opinion about it — which is exactly the line the module draws: one place adds
 * the numbers up, and anything else may only re-state them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REGISTER IS FIXED, AND IT IS THE PROJECTION
 * ─────────────────────────────────────────────────────────────────────────────
 * This sentence is only ever read on the approve page, which by construction is
 * BEFORE the post. It says *"will owe … once posted"* and it may never say
 * *"owes"* or *"confirmed"*. A projection worded as a confirmation is the
 * honest-states rule failing in the most expensive place there is, so the
 * register is not a parameter here at all — there is no caller who could hold
 * the other one.
 *
 * After a post the CONFIRMED sentence comes from the server, per claim, out of
 * `verdictFor`'s confirmed register. Nothing in this file can produce one.
 *
 * @param money formats cents the way every other RCM screen does — passed in
 *   rather than imported so this stays a pure function a test can drive.
 */
export function rollUpSentence(
  roll: RollUp,
  money: (cents: number) => string,
): { register: "projection"; sentence: string; canApprove: boolean } {
  if (roll.judged === 0) {
    return {
      register: "projection",
      sentence:
        "Nothing on this check has been judged yet — no claim here carries a patient-responsibility verdict, so there is no total to state.",
      canApprove: false,
    };
  }

  const owe = money(roll.projectedPatientCents);
  const eob = money(roll.eobPatientCents);
  const absorbed = money(roll.decidedWriteOffCents);

  if (roll.worst === "red") {
    return {
      register: "projection",
      sentence:
        "One or more claims on this check cannot be approved. Each one says which line is the problem in the list above — fix it, and this sentence changes.",
      canApprove: false,
    };
  }

  if (roll.worst === "amber") {
    return {
      register: "projection",
      sentence: `These patients will owe ${owe} once this posts. The EOB says ${eob}; the difference is the ${absorbed} this office decided to absorb, on the lines listed above.`,
      canApprove: true,
    };
  }

  return {
    register: "projection",
    sentence: `These patients will owe ${owe} once this posts, which is exactly what the EOB says they owe. Nothing is being written off by the office.`,
    canApprove: true,
  };
}
