/**
 * WHAT OPEN DENTAL HOLDS FOR THIS CLAIM, IN WORDS — S8 flow-speed, item 2.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO NEW READ, AND NOTHING THIS FILE KNOWS THAT THE MATCH DID NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * Every figure here is already on `MatchCandidate.od` — the snapshot the
 * candidate cards are drawn from. The match fetched the chart claim's header and
 * its claimprocs to score the candidate; the screen then printed four summary
 * rows and threw the lines away. This turns what was already in hand into the
 * region a biller actually asks for: which procedures are on the chart claim,
 * what each was billed, and what the chart has been paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE CLAIM STATUS THIS REPO CAN PROVE, AND THE HONEST REST
 * ─────────────────────────────────────────────────────────────────────────────
 * `ClaimStatus` is a one-letter Open Dental code and this codebase knows exactly
 * one of its values for certain, from two places that agree:
 *
 *   `services/rcm/claimMatch.js`   raises `CLAIM_ALREADY_RECEIVED` when
 *                                  `ClaimStatus === 'R'`, on the reasoning that
 *                                  posting again would be a supplemental.
 *   `services/rcm/odPostingWrites.js`  the posting write itself is
 *                                  `PUT /claims/{n} {ClaimStatus:"R", DateReceived}`.
 *
 * So `R` means RECEIVED, and — the useful half — every other value provably does
 * not, whatever else it may mean. That is the split this function makes, and it
 * refuses to invent wording for `S`, `W`, `H` or anything else: the code is
 * printed beside the sentence for whoever needs it, and a complete
 * ClaimStatus-to-English map is a data want in the S8 flow-speed report rather
 * than a guess rendered into a screen a person checks a payment against.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PENDING IS NOT A PROBLEM — THE COLOUR RULING
 * ─────────────────────────────────────────────────────────────────────────────
 * A chart claim that has not been received yet is the NORMAL state of a claim
 * this check is about to pay. Red and amber on these screens mean the carrier
 * and the chart DISAGREE; spending either of them on "not received yet" would
 * teach a reader to discount the one colour that is supposed to stop her. So
 * `pending` is a fact with a neutral face, and the only thing that colours in
 * this region is a line whose money differs from the EOB's.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import type { MatchCandidate, OdLineFacts } from "./api";

export interface OdClaimStanding {
  /** "Received" / "Pending in Open Dental" — the face. */
  label: string;
  /** The sentence under it. Never more than the two facts above can carry. */
  detail: string;
  /** True only for `R`, which is the one value this repo can prove. */
  received: boolean;
  /** The raw code, printed beside the words. Null when the read carried none. */
  code: string | null;
}

export function odClaimStanding(raw: string | null | undefined): OdClaimStanding {
  const code = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (code === "R") {
    return {
      label: "Received",
      detail: "Open Dental has this claim marked received, so a payment on it would be a second one.",
      received: true,
      code,
    };
  }
  return {
    label: "Pending in Open Dental",
    /* Honest at both ends: what is true of every non-R code, and nothing about
       which non-R code it is. */
    detail: code
      ? "Not marked received yet, which is the usual state of a claim this check is about to pay."
      : "Open Dental did not send a status for this claim.",
    received: false,
    code,
  };
}

/** One chart line as the fold prints it, with the one thing that may colour. */
export interface OdAccountLine {
  claimProcNum: number;
  code: string;
  /** The claimproc's own status letter, verbatim. Never reworded. */
  status: string;
  feeBilledCents: number;
  insPayAmtCents: number;
  writeOffCents: number;
  /** `null` is NOT zero — Open Dental writes -1 for "not calculated". */
  insEstCents: number | null;
  /**
   * HOW FAR THIS LINE'S BILLED FEE IS FROM THE CARRIER'S, or null when the two
   * were never paired. THE ONLY THING IN THIS REGION THAT COLOURS.
   *
   * Straight off `linePairs[].billedDeltaCents`, which the match computed and
   * `differences()` already reads. Nothing here re-derives a difference: a
   * second opinion about whether two amounts agree is exactly what would put an
   * amber row next to a green verdict.
   */
  billedDeltaCents: number | null;
  /** A check is already attached, so Open Dental will not move InsPayAmt. */
  paymentAttached: boolean;
  /** The procedure row could not be read, so this line is out of every total. */
  unreadable: boolean;
}

/**
 * The chart claim's lines, paired against the carrier's where the match paired
 * them.
 *
 * DELETED LINES ARE OUT, and `deleted: 'unknown'` is IN but marked. Open Dental's
 * delete is a soft one, so a line whose procedure row could not be read is
 * indistinguishable from a live one — the match already excludes those from
 * every total, and printing one silently among the rest would put a figure on
 * screen that the totals beside it do not contain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SNAPSHOT THAT CARRIES NO LINES AT ALL IS A REAL SHAPE, NOT A BUG
 * ─────────────────────────────────────────────────────────────────────────────
 * `od.lines` and `linePairs` are typed as required and the OLDER snapshots
 * already in the database predate them — `linesPaired()` in `MatchGuidance` has
 * guarded the same thing since S8 ("a snapshot that did not carry the chart's
 * lines"), and a first draft of this function did not, which took the claim
 * screen down to a blank page on exactly those records.
 *
 * So both are read through `?? []` and the empty result is an ANSWER: the fold
 * says this match did not record the procedures, which is true, rather than
 * drawing an empty table that reads as a claim with nothing on it.
 */
export function odAccountLines(candidate: MatchCandidate): OdAccountLine[] {
  const deltaByProc = new Map<number, number | null>();
  for (const pair of candidate.linePairs ?? []) {
    if (pair.odClaimProcNum !== null) deltaByProc.set(pair.odClaimProcNum, pair.billedDeltaCents);
  }
  return (candidate.od.lines ?? [])
    .filter((l: OdLineFacts) => l.deleted !== true)
    .map((l: OdLineFacts) => ({
      claimProcNum: l.claimProcNum,
      code: l.code,
      status: l.status,
      feeBilledCents: l.feeBilledCents,
      insPayAmtCents: l.insPayAmtCents,
      writeOffCents: l.writeOffCents,
      insEstCents: l.insEstCents,
      billedDeltaCents: deltaByProc.has(l.claimProcNum)
        ? (deltaByProc.get(l.claimProcNum) ?? null)
        : null,
      paymentAttached: l.claimPaymentNum !== null,
      unreadable: l.deleted === "unknown",
    }));
}

/**
 * The one sentence about what the chart claim has ALREADY been paid.
 *
 * Null when it has been paid nothing, which is the ordinary case and does not
 * need saying. When it is not nothing, it is the single most important thing in
 * this region: a chart claim carrying money already is a claim a second payment
 * would double.
 */
export function alreadyOnTheClaim(candidate: MatchCandidate): string | null {
  const paid = candidate.od.insPaidCents;
  const written = candidate.od.writeOffCents;
  if (paid === 0 && written === 0) return null;
  const parts: string[] = [];
  if (paid !== 0) parts.push("insurance payment");
  if (written !== 0) parts.push("a write-off");
  return `This chart claim already carries ${parts.join(" and ")}.`;
}
