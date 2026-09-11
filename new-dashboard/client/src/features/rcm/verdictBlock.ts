/**
 * A RED VERDICT, TURNED INTO THE THREE THINGS THE BENCH HAS TO SAY.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FUNCTION AND NOT THREE STRINGS IN A COMPONENT
 * ═════════════════════════════════════════════════════════════════════════════
 * A red verdict is the workbench's one blocking state, and the design asks the
 * screen to answer it in three places at once: the banner names the offending
 * code, the approve control is greyed with THAT code's reason beside it, and the
 * row in the Open Dental rail that the money argument is about is flagged with
 * the explanation. Three renderers, one fact — so the fact is computed once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT COMPUTES NOTHING. IT ONLY READS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every number in every sentence below comes out of `problem.detail`, which the
 * SERVER wrote in `services/rcm/lineDecisions.js` — including the two dollar
 * figures in an `od_fee_disagrees`. Nothing here re-derives a delta, formats a
 * cent or decides whether a verdict is red. `verdictFor()` is still the only
 * arithmetic; this file turns its answer into copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIRST PROBLEM IS THE ONE NAMED, AND THE REST ARE STILL LISTED
 * ─────────────────────────────────────────────────────────────────────────────
 * The banner already prints every problem. What a greyed control needs is ONE
 * sentence, and the first problem in the gate's own evaluation order is the one
 * a biller reaches first on the claim. The others do not disappear — they are
 * the list under the sentence, exactly as before.
 */
import type { ClaimVerdict } from "@/features/rcm/api";

export type VerdictProblem = ClaimVerdict["problems"][number];

export interface VerdictBlock {
  /** The procedure code the refusal is about. Empty string when the gate sent none. */
  code: string;
  kind: string;
  /** One sentence for the greyed approve control. Starts with the refusal. */
  reason: string;
  /**
   * The line under it, when the refusal is two numbers disagreeing.
   *
   * Null for the kinds that are not a disagreement — a missing write-off reason
   * is one number nobody explained, not two that differ, and printing "until the
   * two agree" over it would be describing a different defect.
   */
  copyBar: string | null;
  /** Every problem, keyed by the line it names, for the Open Dental rail. */
  byLineId: Map<string, VerdictProblem>;
}

/** The kinds where the refusal really is "these two numbers disagree". */
const DISAGREEMENTS = new Set(["od_fee_disagrees", "chart_differs_from_decision"]);

/**
 * The sentence for one problem, in the biller's words, naming its code.
 *
 * Every branch is verb-first about the REMEDY after the refusal, because a
 * greyed control that only says "no" is the thing `DisabledReason` exists to
 * delete. The default carries the gate's own `detail` rather than a generic
 * apology, so a problem kind added next slice reads as the server wrote it.
 */
function reasonFor(problem: VerdictProblem): string {
  const code = problem.code || "this line";
  switch (problem.kind) {
    case "od_fee_disagrees":
      return `Can't say yes while the ${code} fee disagrees. Settle it in Open Dental and read the claim again.`;
    case "line_not_in_chart":
      return `Can't say yes while ${code} has no matching line in Open Dental. Match this claim up again — if it still will not pair, the chart and the EOB disagree about what was done.`;
    case "decision_missing_reason":
      return `Can't say yes while ${code} is written off with nothing recorded about why. Pick a reason on the line.`;
    case "line_not_confirmed":
      return `Can't say yes while Open Dental has not confirmed what ${code} left the patient owing.`;
    case "chart_differs_from_decision":
      return `Can't say yes while ${code} left the patient owing something other than this check promised. Settle it in Open Dental and read the claim again.`;
    default:
      return `Can't say yes while ${code} does not line up — ${problem.detail}.`;
  }
}

/**
 * What a red verdict means for the controls on this screen.
 *
 * Returns null for anything that is not red with a named problem — a green or
 * amber verdict blocks nothing, and a red one whose `problems` array is empty
 * (the imbalance backstop) has no code to name, so the banner's own sentence
 * stands alone rather than being wrapped in an invented one.
 */
export function verdictBlock(verdict: ClaimVerdict | null): VerdictBlock | null {
  if (!verdict || verdict.state !== "red" || verdict.problems.length === 0) return null;

  const first = verdict.problems[0];
  const byLineId = new Map<string, VerdictProblem>();
  for (const p of verdict.problems) {
    if (p.lineId && !byLineId.has(p.lineId)) byLineId.set(p.lineId, p);
  }

  return {
    code: first.code || "",
    kind: first.kind,
    reason: reasonFor(first),
    copyBar: DISAGREEMENTS.has(first.kind)
      ? "Until the two agree, anything this app promises about the patient's balance would be a guess."
      : null,
    byLineId,
  };
}
