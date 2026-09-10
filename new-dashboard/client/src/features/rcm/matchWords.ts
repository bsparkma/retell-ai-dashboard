/**
 * THE DIFFERENCES BETWEEN TWO CLAIMS, IN WORDS — Stage C, §5.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY WORDS AND NOT WEIGHTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The candidate cards show the evidence that produced a score: chips reading
 * `date near (2d) +15`, `amount near +20`, and line pairs reading
 * `ClaimProc 91422 · $54.00 apart`. That is the right thing to keep — it is the
 * audit trail of a ranking, and a person querying a match needs to see the
 * working.
 *
 * It is the wrong thing to DECIDE from. "date near (2d)" is a fact about the
 * scorer; "six weeks earlier" is a fact about the claim, and only one of them
 * tells a biller she is looking at last spring's crown rather than this one.
 *
 * So this file turns the same stored evidence into the sentence a person would
 * say. It adds no data and reads no endpoint: every figure it renders is already
 * on the match snapshot the card is drawing from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT NEVER RANKS AND NEVER PICKS
 * ─────────────────────────────────────────────────────────────────────────────
 * Match scoring is out of scope for this stage and is untouched. Nothing here
 * decides which candidate is better, reorders them, or hides one. `agreement()`
 * describes the candidate the scorer already put first; `differences()`
 * describes any candidate you hand it. Two candidates the server called
 * ambiguous stay ambiguous, and the screen says so in the scorer's own words.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FIGURE NOBODY RECORDED IS SILENCE, NEVER A ZERO
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental does not send every field on every row. A date it did not send is
 * not "the same date" and a billed amount it did not send is not "$0.00 apart" —
 * both are absences, and an absence rendered as an agreement is the whole
 * failure mode this module writes tests about. Anything unknown produces NO
 * phrase at all, and `agreement()` says which fields it was actually able to
 * compare.
 */
import type { BatchMatchResponse, MatchCandidate } from "@/features/rcm/api";
import { day, money } from "@/features/rcm/format";

/** One difference, as a person would say it. */
export interface Difference {
  /** A machine slug for a test to assert on. Never rendered. */
  kind: "claimNumber" | "date" | "amount" | "name" | "subscriber" | "lines";
  /**
   * "Jul 03, 2026 — six weeks earlier" · "$286.00 — $54.00 less billed".
   * Rendered verbatim.
   *
   * THE VALUE, THEN THE DELTA — and both halves are load-bearing. A card that
   * marks a field in amber and says only "six weeks earlier" has highlighted a
   * row without saying what is in it, so a reader has to go and find the figure
   * the highlight is about before she can judge it. Naming what Open Dental
   * actually holds, and then how far that is from the remittance, is one line
   * that answers both questions.
   */
  phrase: string;
  /**
   * True when this difference is the sort that should stop somebody.
   * Drives weight on the screen; it decides nothing and blocks nothing.
   */
  notable: boolean;
}

const DAY = 86_400_000;

/** "$54.00", the same shape every other figure on these screens takes. */
function dollars(cents: number): string {
  const abs = Math.abs(cents);
  return `$${(abs / 100).toFixed(2)}`;
}

/**
 * A day gap, in the units a person uses.
 *
 * Under a fortnight reads in days, under a quarter in weeks, beyond that in
 * months — because "42 days earlier" is arithmetic a reader has to do and "six
 * weeks earlier" is not.
 */
function span(days: number): string {
  const n = Math.abs(days);
  if (n === 0) return "the same day";
  if (n === 1) return "1 day";
  if (n < 14) return `${n} days`;
  const weeks = Math.round(n / 7);
  if (n < 90) return `${weeks} week${weeks === 1 ? "" : "s"}`;
  const months = Math.round(n / 30);
  return `${months} month${months === 1 ? "" : "s"}`;
}

/** Parse a date the way the rest of these screens do: unparseable is absent. */
function at(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * How this candidate differs from what the carrier sent.
 *
 * @param candidate one candidate off the match snapshot.
 * @param eob what the remittance itself says — the service date and the billed
 *   total. Both optional: a field the remittance did not carry produces no
 *   phrase rather than a comparison against nothing.
 */
export function differences(
  candidate: MatchCandidate,
  eob: { serviceDate?: string | null; billedCents?: number | null; patientName?: string | null },
): Difference[] {
  const out: Difference[] = [];

  const odDate = at(candidate.od.dateService);
  const eobDate = at(eob.serviceDate);
  if (odDate !== null && eobDate !== null && odDate !== eobDate) {
    const days = Math.round((odDate - eobDate) / DAY);
    out.push({
      kind: "date",
      phrase: `${day(candidate.od.dateService)} — ${span(days)} ${days < 0 ? "earlier" : "later"}`,
      // A fortnight is the width of a normal claim-entry lag. Beyond it, two
      // claims a month apart are usually two different visits.
      notable: Math.abs(days) > 14,
    });
  }

  if (typeof eob.billedCents === "number" && typeof candidate.od.billedCents === "number") {
    const delta = candidate.od.billedCents - eob.billedCents;
    if (delta !== 0) {
      out.push({
        kind: "amount",
        phrase: `${money(candidate.od.billedCents)} — ${dollars(delta)} ${
          delta < 0 ? "less" : "more"
        } billed`,
        notable: true,
      });
    }
  }

  if (eob.patientName && candidate.od.patientName && !sameName(eob.patientName, candidate.od.patientName)) {
    out.push({
      kind: "name",
      // The two names are NOT quoted into one phrase: the screen shows them
      // side by side already, and repeating a patient's name twice in a
      // sentence is PHI printed for no gain.
      phrase: "a different patient's name",
      notable: true,
    });
  }

  const unpaired = candidate.linePairs.filter((p) => p.odClaimProcNum === null).length;
  if (unpaired > 0) {
    out.push({
      kind: "lines",
      phrase: `${unpaired} line${unpaired === 1 ? "" : "s"} with nothing to match in the chart`,
      notable: true,
    });
  }

  return out;
}

/**
 * Loose name equality — the same shape the module's matcher already tolerates.
 *
 * Case and punctuation only. It is deliberately NOT the scorer's own comparison:
 * this is a sentence about what a reader would notice, and the scorer's answer
 * is already on the card as evidence and as a blocker.
 */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(" ");
  return norm(a) === norm(b);
}

/**
 * DOES THE CARRIER'S CLAIM NUMBER NAME *THIS* OPEN DENTAL CLAIM?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SERVER'S ANSWER, NEVER A SECOND COMPARISON
 * ═════════════════════════════════════════════════════════════════════════════
 * `CLAIM_NUMBER_MATCH` is set by the scorer (`claimMatch.js`) when the claim id
 * the carrier echoed in CLP01 squashes down to this candidate's ClaimNum. It is
 * worth 35 of 100 there, and it is the single strongest thing this module knows
 * about whether two claims are the same claim.
 *
 * Reading the TAG rather than re-comparing the two strings here is the point.
 * The scorer normalises both sides (`squash`) before it compares them, and a
 * client that did its own `String(a) === String(b)` would disagree with the
 * score sitting next to it the first time a payer padded a number with a zero —
 * and it would disagree in the direction that shows a scary warning over a match
 * the server is confident about.
 *
 * ABSENT IS NOT "DIFFERENT", AND BOTH ARE "DOES NOT AGREE". The tag is also
 * absent when the remittance carried no claim number at all, which is a
 * different fact and the same consequence: nothing here confirms these are the
 * same claim. `claimNumberDifference()` says which of the two it is; every
 * caller that only needs the yes/no reads this.
 */
export function claimNumberAgrees(candidate: MatchCandidate): boolean {
  return candidate.evidence.some((e) => e.tag === "CLAIM_NUMBER_MATCH");
}

/**
 * The claim-number line for the confirm interstitial, or null when it agrees.
 *
 * TWO SENTENCES FOR TWO FACTS, because "the carrier's number is a different
 * claim" and "the carrier never gave one" are different things to know while
 * deciding to link a payment to a chart, and collapsing them would make the
 * second read as the first.
 */
export function claimNumberDifference(
  candidate: MatchCandidate,
  eob: { claimNumber?: string | null },
): Difference | null {
  if (claimNumberAgrees(candidate)) return null;
  const ours = eob.claimNumber?.trim();
  return {
    kind: "claimNumber",
    phrase: ours
      ? `the carrier's claim number ${ours} is not Open Dental claim ${candidate.odClaimNum}`
      : `the carrier gave no claim number to check against Open Dental claim ${candidate.odClaimNum}`,
    notable: true,
  };
}

/**
 * EVERYTHING THAT DOES NOT AGREE, CLAIM NUMBER FIRST — W-7 / ruling Q2.
 *
 * The order is the ruling's, not a preference: the claim number is the one field
 * that on its own settles whether these are the same claim, so it leads the list
 * a person reads before confirming a match nothing else vouches for.
 *
 * It is `differences()` with that one line in front, so the interstitial and the
 * candidate card cannot end up describing one candidate two ways.
 */
export function disagreements(
  candidate: MatchCandidate,
  eob: {
    claimNumber?: string | null;
    serviceDate?: string | null;
    billedCents?: number | null;
    patientName?: string | null;
  },
): Difference[] {
  const claimNumber = claimNumberDifference(candidate, eob);
  return claimNumber ? [claimNumber, ...differences(candidate, eob)] : differences(candidate, eob);
}

/**
 * HOW STRONGLY THE SCORER RATES THIS ONE, in two words a biller uses.
 *
 * Straight off `candidate.confidence`, which is the server's own band
 * (`CONFIDENCE_BANDS`: HIGH ≥ 75, MEDIUM ≥ 45, LOW below). This function
 * re-ranks nothing, re-scores nothing and introduces no cutoff of its own —
 * a second opinion about the ordering is precisely what this file's header
 * forbids.
 *
 * MEDIUM AND LOW BOTH READ "Possible". A three-word scale where two of the words
 * mean "I am not sure" invites a reader to treat the middle one as a soft yes;
 * the honest split at the desk is between the one worth looking at first and the
 * ones that are merely still in the running.
 */
export function likelihood(candidate: MatchCandidate): "Likely" | "Possible" {
  return candidate.confidence === "HIGH" ? "Likely" : "Possible";
}

/**
 * What AGREES about this candidate, stated in one sentence.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A FIELD IS NAMED ONLY IF IT WAS COMPARED *AND* IT MATCHED
 * ═════════════════════════════════════════════════════════════════════════════
 * This sentence is the whole basis on which somebody presses *Yes, that's the
 * one*, so every clause in it has to be a fact the reader can check. It used to
 * name `birthday` whenever Open Dental had sent a birthdate, and `subscriber`
 * whenever Open Dental had sent a subscriber id — and the remittance side of
 * this screen carries NEITHER. Nothing was ever compared, and the sentence said
 * they agreed.
 *
 * That is the exact failure the file header warns about one paragraph up ("an
 * absence rendered as an agreement"), committed against the two fields a biller
 * would lean on hardest to decide she has the right person.
 *
 * So the rule is now mechanical: a field appears in this sentence only when both
 * sides carried it and `differences()` found nothing between them. Date of birth
 * and subscriber id are absent from the list until the remittance side of the
 * comparison carries them — the two identity columns still PRINT what Open
 * Dental holds, which is a fact, and printing it is not the same as claiming it
 * agrees with something.
 *
 * Returns `null` when nothing could be compared, which the screen renders as
 * "there is not enough here to say" rather than as agreement.
 */
export function agreement(
  candidate: MatchCandidate,
  eob: {
    claimNumber?: string | null;
    serviceDate?: string | null;
    billedCents?: number | null;
    patientName?: string | null;
  },
): string | null {
  const diffs = differences(candidate, eob);
  if (diffs.length > 0) return null;

  const compared: string[] = [];
  // First, because it is the strongest and because the interstitial lists it
  // first when it is the thing that does NOT agree.
  if (claimNumberAgrees(candidate)) compared.push("claim number");
  if (eob.patientName && candidate.od.patientName) compared.push("name");
  if (at(eob.serviceDate) !== null && at(candidate.od.dateService) !== null) {
    compared.push("service date");
  }
  if (typeof eob.billedCents === "number" && typeof candidate.od.billedCents === "number") {
    compared.push("billed total");
  }
  const paired = candidate.linePairs.filter((p) => p.odClaimProcNum !== null).length;
  if (candidate.linePairs.length > 0 && paired === candidate.linePairs.length) {
    compared.push("every line");
  }

  if (compared.length === 0) return null;
  const sentence =
    compared.length === 1
      ? `${compared[0]} agrees.`
      : `${compared.slice(0, -1).join(", ")} and ${compared[compared.length - 1]} agree.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/* ─────────────────────────────────────────────────────────────────────────────
   WHAT A MATCH RUN DID, AND WHAT IT LEFT ALONE — W-11
   ─────────────────────────────────────────────────────────────────────────────
   A batch match over a part-worked check is a PARTIAL action by design. It runs
   unmatched claims first, skips the ones somebody already confirmed, gives up on
   the ones Open Dental has nothing for, and stops at a wall-clock budget.

   The screen used to report it as *"Matched 9 claims against Open Dental"* — the
   LENGTH of the results array, which counts the already-confirmed, the
   no-candidates and the outright failures alongside the successes. So a run that
   examined nine claims and matched none of them said it had matched nine. The
   per-claim list underneath was correct; nobody reads nine lines to find out
   whether the headline was true.

   That is a bare success sentence printed over a partial action, and the fix is
   not a softer adjective. It is to say BOTH halves out loud: what the run did,
   and what it deliberately left alone, with the reason attached to each count.

   EVERY NUMBER HERE IS THE SERVER'S. `matched[].status` and `skipped` come off
   the response; this function counts and words them and derives nothing else.
   ────────────────────────────────────────────────────────────────────────────── */

export interface MatchRunSummary {
  /** What the run DID — always present, and honest at zero. */
  did: string;
  /**
   * What it left alone, one clause per reason, each carrying its own count.
   *
   * Empty when a run touched everything on the check, which is the only case in
   * which the old one-sentence report was ever accurate.
   */
  leftAlone: string[];
}

/** "1 claim" / "3 claims" — the same shape `flow.ts` uses. */
function claimsWord(n: number): string {
  return `${n} claim${n === 1 ? "" : "s"}`;
}

export function matchRunSummary(result: BatchMatchResponse): MatchRunSummary {
  const count = (...statuses: string[]) =>
    result.matched.filter((row) => statuses.includes(row.status)).length;

  /*
   * MATCHED = the run asked Open Dental and got an answer it could offer.
   * `confirmed` is in here because a claim the run was able to tie outright was
   * matched by this run; `already_confirmed` is NOT, because that one was tied
   * before the button was pressed and the whole point of this sentence is to
   * stop the two being added together.
   */
  const matched = count("candidates", "confirmed");
  const alreadyConfirmed = count("already_confirmed");
  const nothingToMatch = count("no_candidate");
  const failed = count("failed");

  const leftAlone: string[] = [];
  if (alreadyConfirmed > 0) leftAlone.push(`left ${alreadyConfirmed} already confirmed`);
  if (nothingToMatch > 0) {
    leftAlone.push(`${nothingToMatch} with nothing in Open Dental to match`);
  }
  if (failed > 0) leftAlone.push(`${failed} could not be read`);
  if (result.skipped > 0) {
    /*
     * WHY it stopped, not only THAT it did. The clock and the per-run claim cap
     * are different reasons with the same shape, and the one a biller can do
     * something about — press it again — is the same either way, so the clause
     * says which wall was hit and the panel below repeats the remedy in full.
     */
    leftAlone.push(
      result.outOfTime
        ? `${result.skipped} not reached before this run's ${Math.round(result.budgetMs / 1000)}-second limit`
        : `${result.skipped} not looked at in this run`,
    );
  }

  return {
    did: matched > 0 ? `Matched ${claimsWord(matched)}` : "Matched no claims",
    leftAlone,
  };
}
