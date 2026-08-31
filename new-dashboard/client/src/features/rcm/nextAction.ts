/**
 * WHAT IS THE NEXT CLICK ON THIS CHECK? — Stage C, §1.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FILE AND NOT A SENTENCE ON A CARD
 * ═════════════════════════════════════════════════════════════════════════════
 * Today's *Where you left off* card used to name a check and stop. A biller
 * reading it still had to open the check, scroll the claim list, and work out
 * which row she had not got to — which is the same work the card was supposed to
 * save her. So the card now says the next thing by name and offers one button
 * that goes straight to it.
 *
 * That sentence is a DERIVATION, and a derivation on a card is a derivation that
 * drifts. It lives here, it is pure, and `tests/rcm-next-action.test.ts` drives
 * it directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER, AND IT IS THE WHOLE OF THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. THE FIRST CLAIM NOBODY HAS CHECKED OVER, in the check's own claim order.
 *      Not the oldest, not the largest — the first, because a person working a
 *      list works it top to bottom and a card that sent her to row six would be
 *      answering a question she did not ask.
 *   2. EVERY CLAIM DONE, THE CHECK NOT APPROVED → approving is what is left.
 *   3. NOTHING. The card says so rather than inventing a step: a check whose
 *      claims are all checked over and which somebody has already approved is
 *      waiting on the machine, not on her.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "CHECKED OVER" IS `reviewedAt`, AND NOT A SECOND OPINION ABOUT IT
 * ─────────────────────────────────────────────────────────────────────────────
 * The server already decides what a check still owes — `attentionReasons`
 * carries `claims_unreviewed` and `claims_awaiting_approval`, computed over the
 * whole claim set in `routes/rcm/remittances.js`. This file reads the CLAIM
 * rows' own `reviewedAt` for one purpose the server's summary cannot serve:
 * naming WHICH claim. It never contradicts the summary, and where it has no
 * claims to read it defers to the summary entirely (see `nextActionFromRow`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT WORKS WITH OR WITHOUT THE CLAIMS, AND SAYS WHICH IT HAD
 * ─────────────────────────────────────────────────────────────────────────────
 * `/api/rcm/remittances` returns rows, not claims. Today fetches the claim
 * bundle for the handful of checks on the card and nothing else — so a fetch
 * that fails, or a check whose bundle has not arrived, still gets an honest
 * sentence rather than a spinner or a blank. That is what `claims === null`
 * means here, and it is a different answer from `claims === []`.
 */
import type { Remittance, RemittanceClaim } from "@/features/rcm/api";
import { claimHref, remittanceHref } from "@/features/rcm/flow";

/**
 * The next thing a person does on one check.
 *
 * `kind` is the machine value a test asserts on; `sentence` is what the card
 * prints. `href` is where the button goes and is never null — a card that
 * offered no destination would be a card that told somebody to go and look.
 */
export type NextAction =
  | {
      kind: "review_claim";
      /**
       * Which claim, so the button lands on it rather than on the check.
       *
       * NULL when the claims were not in hand — the row alone can say that a
       * claim is waiting and can never say which. A card that filled this in
       * from a count would be inventing a destination.
       */
      claimId: string | null;
      patientName: string | null;
      /** How many are left, this one included. `null` when only the row was read. */
      remaining: number | null;
      href: string;
      sentence: string;
    }
  | { kind: "approve"; href: string; sentence: string }
  | { kind: "none"; href: string; sentence: string };

/** The label on the one button. Said once, so every card says it the same way. */
export const PICK_UP_LABEL = "Pick up where you left off";

/**
 * A claim nobody has finished with.
 *
 * `reviewedAt` is the only stamp that says a human looked — and "looked, nothing
 * to do" is finished work, which is why a claim with no chart match can still be
 * done. A claim already approved onto a posting is finished by construction and
 * is excluded even if it somehow carries no review stamp.
 */
function unchecked(c: RemittanceClaim): boolean {
  return c.reviewedAt == null && c.postingQueueId == null;
}

/**
 * The next click, given the check and — when they are in hand — its claims.
 *
 * @param claims the check's claims IN THE CHECK'S OWN ORDER, or `null` when they
 *   were not loaded. `null` is not `[]`: an empty array means a check with no
 *   claims on it, which is a real and different thing.
 */
export function nextActionFor(
  remittance: Remittance,
  claims: RemittanceClaim[] | null,
): NextAction {
  const href = remittanceHref(remittance.batchId);

  if (claims === null) return nextActionFromRow(remittance);

  const todo = claims.filter(unchecked);
  if (todo.length > 0) {
    const first = todo[0];
    return {
      kind: "review_claim",
      claimId: first.claimId,
      patientName: first.patientName,
      remaining: todo.length,
      href: claimHref(first.claimId, remittance.batchId),
      sentence:
        todo.length === 1
          ? `Next: keep checking it over — ${first.patientName} is the last one.`
          : `Next: keep checking it over — ${first.patientName} is up, ${todo.length - 1} more after.`,
    };
  }

  /*
   * EVERY CLAIM CHECKED OVER. Approving is what is left — unless the SERVER
   * says it is not, which happens when an earlier press already took every
   * claim onto a posting. `claims_awaiting_approval` is the server's own word
   * for "somebody still owes an approve", and deferring to it is what stops
   * this card offering an approve on a check that has already had one.
   */
  if (remittance.attentionReasons.includes("claims_awaiting_approval")) {
    return {
      kind: "approve",
      href,
      sentence: "Next: every claim is checked over — it needs approving.",
    };
  }

  return {
    kind: "none",
    href,
    sentence: "Nothing is waiting on you here.",
  };
}

/**
 * The same question with only the list row to answer it from.
 *
 * It can never name a patient — the row does not carry one — so it says how many
 * and stops. A sentence that guessed a name off a count would be the card
 * asserting something no endpoint said.
 */
function nextActionFromRow(remittance: Remittance): NextAction {
  const href = remittanceHref(remittance.batchId);

  if (remittance.attentionReasons.includes("claims_unreviewed")) {
    return {
      kind: "review_claim",
      claimId: null,
      patientName: null,
      remaining: null,
      href,
      sentence: "Next: keep checking it over — open the check to see which claim is up.",
    };
  }
  if (remittance.attentionReasons.includes("claims_awaiting_approval")) {
    return {
      kind: "approve",
      href,
      sentence: "Next: every claim is checked over — it needs approving.",
    };
  }
  return { kind: "none", href, sentence: "Nothing is waiting on you here." };
}
