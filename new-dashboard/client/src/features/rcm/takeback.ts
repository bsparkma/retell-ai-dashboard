/**
 * IS THIS CLAIM THE CARRIER TAKING MONEY BACK?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE CLIENT NEEDS THIS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * The ordinary approve gate refuses every takeback and always will — a takeback
 * is authorised on its own panel, by typing its amount (D-6). W-5 of the
 * combined walk found the cost of the screens not knowing that: the approve page
 * rendered a takeback-only check as a wall of failing conditions with an
 * instruction beside each one, none of which could ever clear, because the whole
 * check belongs on a different control.
 *
 * So this predicate exists to let a screen ROUTE rather than to let it JUDGE.
 * Nothing downstream of it decides anything about money: the server recomputes
 * the total, matches it against the typed string and applies its own gate,
 * whatever any client believed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE PIECES OF EVIDENCE, ANY ONE OF WHICH IS ENOUGH
 * ─────────────────────────────────────────────────────────────────────────────
 * The server's own partition (D-11) puts `reversal_not_postable` and
 * `negative_total_payment` on a takeback claim, and the money moves backwards.
 * Reading all three rather than one is the lesson of #123, where `matchService`
 * was handed half its evidence for the same question and produced a refusal
 * whose own remedy could not clear it.
 *
 * `NO_ACTION_REASONS` in `format.ts` is a DIFFERENT and wider set — it also
 * carries `prior_payer_payment_on_primary_claim`, which is a coordination of
 * benefits case and not a takeback at all. It answers "is there anything to
 * post here", which is why the workbench's dead-end sentence reads it. Routing
 * a COB claim to the takeback panel would be a new wrong turn, so this question
 * gets its own answer.
 */
import type { RemittanceClaim, WorkbenchClaim } from "@/features/rcm/api";

/** The two review reasons the server stamps on a claim the carrier reversed. */
export const TAKEBACK_REASONS = new Set(["reversal_not_postable", "negative_total_payment"]);

export function isTakebackClaim(
  claim: Pick<WorkbenchClaim, "needsReviewReasons" | "totalPaidCents">,
): boolean {
  if (claim.totalPaidCents < 0) return true;
  return claim.needsReviewReasons.some((r) => TAKEBACK_REASONS.has(r));
}

/**
 * Is EVERY claim on this check a takeback?
 *
 * FALSE ON AN EMPTY CHECK, deliberately. `[].every()` is true, and a check the
 * page has no claims for would otherwise route to a takeback panel that has
 * nothing to show — an empty list is "we do not know yet", never "they are all
 * takebacks".
 *
 * A MIXED check is also false, and that is the ruling rather than an oversight:
 * a check carrying one reversal beside nine payments still has nine claims to
 * approve normally, and the failure list is exactly what a biller needs there.
 */
export function isTakebackOnly(claims: readonly RemittanceClaim[]): boolean {
  return claims.length > 0 && claims.every(isTakebackClaim);
}
