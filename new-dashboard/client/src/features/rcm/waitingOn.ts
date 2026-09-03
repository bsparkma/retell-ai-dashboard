/**
 * WHO OR WHAT IS THIS CHECK WAITING ON? — Stage C, §1 and §3.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE PREDICATE, TWO SENTENCES
 * ═════════════════════════════════════════════════════════════════════════════
 * The Checks list has a *Waiting on* column and Today's arrivals table has a
 * *What happens next* column. They are the same question asked from two chairs —
 * "whose move is it" and "what happens to this one now" — and if each screen
 * computed its own answer they would disagree the first time a state was added.
 *
 * So this file decides the STATE once, and two thin renderers put it into the
 * two registers:
 *
 *   waitingOn(row, ctx)       →  "You — 4 claims to check over"
 *   whatHappensNext(row, ctx) →  "4 claims still to check over"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT READS THE SERVER'S VOCABULARY AND ADDS NONE OF ITS OWN
 * ─────────────────────────────────────────────────────────────────────────────
 * `attentionReasons` (what a human owes) and `attentionObservations` (what is
 * merely true) are computed server-side over the whole claim set. Nothing here
 * re-derives them; this file only decides which one to LEAD with, because a
 * column has room for one sentence and a check is routinely waiting on three
 * things at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF PRECEDENCE, AND WHY IT IS THIS ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * Read top to bottom; the first that holds is what the cell says.
 *
 *   1. SET ASIDE      a person has said nobody is coming back. Nothing else
 *                     about the row matters after that.
 *   2. ANOTHER OFFICE the row is not this biller's to work at all. "Nobody" is
 *                     the honest subject, and it is not a problem.
 *   3. A TAKEBACK     money moving backwards outranks every ordinary state,
 *                     because it is the one a person must not skim past.
 *   4. STUCK          something needs a human before anything else can happen.
 *   5. SHADOW MODE    approved and switched off. It is waiting on an ADMIN, and
 *                     saying "you" would send her to fix something she cannot.
 *   6. POSTED         finished, with the instant it was confirmed.
 *   7. HER WORK       match, check over, approve — in the order she does them.
 *   8. NOTHING        no outstanding action anybody can name.
 *
 * Shadow mode sits BELOW stuck deliberately: a stuck check is stuck whether or
 * not posting is switched on, and a banner explaining the switch over a row that
 * needs a person would be the wrong remedy shown first.
 */
import type { Remittance, RcmOfficeId } from "@/features/rcm/api";
import { officeStamp } from "@/features/rcm/time";

/**
 * What the screen knows that the ROW does not.
 *
 * Both are optional and both default to the reading that adds no claim: an
 * absent `shadowMode` is not "posting is on", it is "this screen did not ask",
 * and the cell simply does not mention it.
 */
export interface WaitingContext {
  /** Which practice the reader is looking at. Absent = do not judge ownership. */
  office?: RcmOfficeId;
  /** The posting switch, carried from the posting queue read. */
  shadowMode?: boolean;
  /** When this check's money was confirmed in Open Dental, if it was. */
  confirmedAt?: string | null;
}

/**
 * The state, as a closed set. Every member has a renderer in BOTH registers, and
 * the test asserts that — a state with one sentence and not the other would
 * render an empty cell on one of the two screens.
 */
export const WAITING_STATES = [
  "set_aside",
  "other_office",
  "takeback",
  "stuck",
  "shadow",
  "posted",
  "match",
  "review",
  "approve",
  "nothing",
] as const;
export type WaitingState = (typeof WAITING_STATES)[number];

export interface Waiting {
  state: WaitingState;
  /** "You — 4 claims to check over". The Checks list's column. */
  waitingOn: string;
  /** "4 claims still to check over". Today's arrivals column. */
  next: string;
  /**
   * True when this row wants a person's eye on it. Drives tone, never content —
   * a cell that was coloured but said nothing would be a colour nobody can act
   * on.
   */
  urgent: boolean;
}

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);
const claimWord = (n: number) => `${n} ${plural(n, "claim")}`;

/**
 * Is this check a takeback?
 *
 * Read from the check's own flags — the same list the detail screen renders. A
 * NEGATIVE total is the other signal and is deliberately included: an 835 that
 * reclaims money arrives as a check for less than nothing, and a biller must be
 * told that before she opens it rather than after.
 */
export function isTakeback(r: Remittance): boolean {
  if (r.totalAmountCents < 0) return true;
  return r.flags.some((f) => /reversal|recoup|takeback/i.test(f));
}

/** The one computation. Both sentences come out of it together. */
export function waitingFor(r: Remittance, ctx: WaitingContext = {}): Waiting {
  const reasons = r.attentionReasons;
  const observations = r.attentionObservations;

  if (r.setAsideAt != null) {
    return {
      state: "set_aside",
      waitingOn: "Nobody — it was set aside",
      next: "Set aside. Put it back and it rejoins the queue.",
      urgent: false,
    };
  }

  if (ctx.office && r.officeId !== ctx.office) {
    return {
      state: "other_office",
      waitingOn: "Nobody — belongs to another office",
      next: "Another office works this one.",
      urgent: false,
    };
  }

  if (isTakeback(r)) {
    return {
      state: "takeback",
      waitingOn: "A takeback — money the carrier is reclaiming",
      next: "The carrier is reclaiming money. It is authorised on its own.",
      urgent: true,
    };
  }

  if (reasons.includes("posting_failed")) {
    return {
      state: "stuck",
      waitingOn: "You — the posting did not finish",
      next: "The posting did not finish. Open it and it says where it stopped.",
      urgent: true,
    };
  }
  if (reasons.includes("claims_withheld")) {
    return {
      state: "stuck",
      waitingOn: "You — a claim was held back",
      next: "One claim doesn't line up with Open Dental.",
      urgent: true,
    };
  }

  /*
   * APPROVED AND SWITCHED OFF. Not "you", because there is nothing she can do —
   * the remedy is an admin flipping one setting, and the sentence says so where
   * §10's banner then explains it in full.
   */
  if (ctx.shadowMode && r.queuedClaimCount > 0 && !reasons.includes("claims_awaiting_approval")) {
    return {
      state: "shadow",
      waitingOn: "Shadow mode — posting is switched off",
      next: "Held while shadow mode is on.",
      urgent: false,
    };
  }

  if (ctx.confirmedAt) {
    return {
      state: "posted",
      waitingOn: "Nobody — it is posted",
      next: `Confirmed in Open Dental at ${officeStamp(ctx.confirmedAt, r.officeId)}`,
      urgent: false,
    };
  }

  /*
   * HER OWN WORK, in the order she does it. `claims_unreviewed` LEADS over
   * matching even though matching comes first in the flow: an unmatched claim
   * still has to be checked over, so "check it over" is the sentence that
   * covers both, and the matching detail rides in the *next* register rather
   * than replacing it.
   */
  if (reasons.includes("claims_unreviewed")) {
    const left = r.claimCount - r.queuedClaimCount;
    const n = left > 0 ? left : r.claimCount;
    const matched = r.claimCount - r.unmatchedClaimCount;
    return {
      state: "review",
      waitingOn: `You — ${claimWord(n)} to check over`,
      next:
        r.unmatchedClaimCount > 0 && matched > 0
          ? `${matched} matched already · ${r.unmatchedClaimCount} need you to pick`
          : `${claimWord(n)} still to check over`,
      urgent: true,
    };
  }

  if (reasons.includes("claims_awaiting_approval")) {
    return {
      state: "approve",
      waitingOn: "You — it is ready to approve",
      next: "Every claim is checked over. It needs approving.",
      urgent: true,
    };
  }

  if (observations.includes("claims_unmatched") && r.unmatchedClaimCount > 0) {
    return {
      state: "match",
      waitingOn: `You — ${claimWord(r.unmatchedClaimCount)} to match up`,
      next: `${claimWord(r.unmatchedClaimCount)} still to match up in Open Dental.`,
      urgent: true,
    };
  }

  return {
    state: "nothing",
    waitingOn: "Nobody — nothing outstanding",
    next: "Nothing outstanding.",
    urgent: false,
  };
}

/** The Checks list's column. */
export function waitingOn(r: Remittance, ctx: WaitingContext = {}): string {
  return waitingFor(r, ctx).waitingOn;
}

/** Today's arrivals column. */
export function whatHappensNext(r: Remittance, ctx: WaitingContext = {}): string {
  return waitingFor(r, ctx).next;
}
