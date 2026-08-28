/**
 * The approval checklist, in biller language.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE COPY MOVED TO THE CLIENT AND THE SLUGS DID NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * `backend/routes/rcm/approvalGate.js` owns the CHECKS — which conditions exist,
 * what they evaluate, and what stops an approval. That is not changing and must
 * not: a screen inventing a condition the gate does not hold would be worse than
 * an awkward sentence.
 *
 * What moved here is the RENDERING. The gate's own wording is written from the
 * evaluator's side — "The match record is current and complete", "Every line is
 * paired to a chart line" — and the 2026-08-25 walk showed a biller reading five
 * ✗ marks without understanding what any of them wanted. So this file keys copy
 * off the MACHINE SLUG and rewrites the strings:
 *
 *   title — what must be TRUE, in plain words
 *   fail  — what to DO, starting with a verb
 *   pass  — one short confirmation
 *
 * A code with no entry here falls back to the server's own label and fix, so a
 * check added next slice renders the gate's words rather than nothing. The drift
 * test in `rcm-labels.test.ts` reads `approvalGate.js` and fails if any CHECKS
 * key is missing from this map, which is what keeps the fallback theoretical.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PASS DETAIL IS NEVER THE FAILURE TEXT — §15.2's copy bug
 * ─────────────────────────────────────────────────────────────────────────────
 * `add('SNAPSHOT_CURRENT', usable, <a ternary chain>)` in the gate evaluates its
 * chain whether the check passed or not, so its final branch — "the confirmed
 * claim is not among the candidates the match recorded" — was printed as the
 * DETAIL of a check with a green tick beside it. A biller reading a passing row
 * that describes a failure has no way to know which half to believe.
 *
 * The fix is one rule, enforced by a test: a passing check renders `pass` from
 * this file, and the server's `detail` is shown only when the check FAILED,
 * where it adds the specific number or reason behind the instruction. The two
 * strings can never be the same string because they come from different fields.
 */
import type { ApprovalCheck } from "@/features/rcm/api";

export interface CheckCopy {
  /** What must be true. A statement, not an instruction. */
  title: string;
  /** What to do about it. Starts with a verb. */
  fail: string;
  /** One short confirmation. Never the failure text. */
  pass: string;
  /**
   * Whether the server's `detail` is worth appending to `pass`.
   *
   * True for exactly the checks whose passing detail is a FACT a biller wants —
   * `MATCH_CONFIRMED` sends `ClaimNum 53784`. Everything else either sends null
   * on a pass or, in `SNAPSHOT_CURRENT`'s case, sends a failure sentence.
   */
  passUsesDetail?: boolean;
}

export const CHECK_COPY: Record<string, CheckCopy> = {
  OFFICE_CONSISTENT: {
    title: "Belongs to this practice",
    fail: "Check which practice this claim came in under — it is stamped differently from the remittance it sits on. Nothing here can post until that is corrected.",
    pass: "This practice.",
  },
  MATCH_CONFIRMED: {
    title: "Linked to a chart claim",
    fail: "Run the match, then confirm the right claim below.",
    pass: "Linked",
    passUsesDetail: true,
  },
  SNAPSHOT_CURRENT: {
    title: "Match is up to date",
    fail: "Re-run the match and confirm again.",
    pass: "Up to date.",
  },
  REVIEWED: {
    title: "Reviewed",
    fail: "Add a note and mark this claim reviewed.",
    pass: "Reviewed.",
  },
  NOT_REVERSAL: {
    title: "Not a takeback",
    fail: "Handle this one in Open Dental — the carrier reversed it, and a reversal cannot be undone once written.",
    pass: "A payment, not a reversal.",
  },
  NOT_RECOUPMENT: {
    title: "Not a recoupment",
    fail: "Approve this one from the takeback panel instead — the carrier is taking money back, and that needs you to type the amount first.",
    pass: "The carrier is not taking money back.",
  },
  /**
   * 6d. The check that REPLACES the two takeback refusals on the recoupment
   * path — it is never shown beside them, because they are swapped out for it.
   *
   * It can only read as passed because the SERVER matched the approver's typed
   * total against money it computed itself, so the pass line says what was
   * confirmed rather than merely that something was.
   */
  RECOUPMENT_CONFIRMED: {
    title: "A takeback, confirmed by typing its amount",
    fail: "Approve this one normally — it is not a takeback, so it cannot ride on a takeback confirmation.",
    pass: "You typed the amount being taken back.",
  },
  TAKEBACK_ACKNOWLEDGED: {
    title: "The takeback flags are what the typed amount confirmed",
    fail: "Dispose of this one manually — it carries the carrier's reversal flags but its money moves forwards, and the two disagree.",
    pass: "Explained by the amount you typed.",
  },
  NOT_PATIENT_RESPONSIBILITY_ONLY: {
    title: "The carrier actually paid something",
    fail: "Bill the patient in Open Dental — every cent on this claim is theirs, so there is no insurance payment to post.",
    pass: "The carrier paid.",
  },
  NO_BLOCKING_REASON: {
    title: "Nothing on this claim is in doubt",
    fail: "Fix the source document, or dispose of this claim by hand — something on it means the amounts cannot be trusted.",
    pass: "Nothing in doubt.",
  },
  NO_BLOCKING_PREFLIGHT: {
    title: "The chart is ready for this payment",
    fail: "Resolve the claim in Open Dental, then run the match again — the chart claim carries something Open Dental will not let us write over.",
    pass: "Ready.",
  },
  LINES_PAIRED: {
    title: "Every line matched to a chart line",
    fail: "Re-run the match. If a line still will not pair, the chart and the remittance disagree about what was done.",
    pass: "Every line matched.",
  },
  CLAIMPROC_NOT_ALREADY_PLANNED: {
    title: "No chart line is spoken for",
    fail: "Release the other posting plan first — another claim is already lined up to pay money against one of these chart lines.",
    pass: "No chart line is on another plan.",
  },
  CLAIM_TOTALS_AGREE: {
    title: "The amounts add up",
    fail: "Check the remittance against its lines — what this claim was paid does not equal the sum of its procedures, and the difference is money nobody can account for.",
    pass: "The amounts add up.",
  },
};

/**
 * What the checklist prints as this row's heading.
 *
 * Falls back to the SERVER'S label rather than to the slug: an unmapped check is
 * one this file has not caught up with, and the gate's own words are always
 * readable even when they are written from the evaluator's side.
 */
export function checkTitle(check: ApprovalCheck): string {
  return CHECK_COPY[check.code]?.title ?? check.label;
}

/**
 * The one line under the heading.
 *
 * PASSED → the short confirmation, and the server's `detail` only where it is a
 * fact rather than a leftover failure sentence.
 * FAILED → the verb-first instruction. The server's own `fix` is the fallback.
 */
export function checkDetail(check: ApprovalCheck): string {
  const copy = CHECK_COPY[check.code];
  if (check.passed) {
    if (!copy) return "";
    return copy.passUsesDetail && check.detail ? `${copy.pass} — ${check.detail}` : copy.pass;
  }
  return copy?.fail ?? check.fix;
}

/**
 * The specific number or reason behind a failure, when the server sent one.
 *
 * Rendered under the instruction and ONLY on a failure — this is the field that
 * carried the §15.2 copy bug, and the passing path above never reads it except
 * for the one check whose passing detail is genuinely a fact.
 */
export function checkWhy(check: ApprovalCheck): string | null {
  if (check.passed) return null;
  return check.detail;
}
