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
import type { MatchCandidate } from "@/features/rcm/api";

/** One difference, as a person would say it. */
export interface Difference {
  /** A machine slug for a test to assert on. Never rendered. */
  kind: "date" | "amount" | "name" | "subscriber" | "lines";
  /** "six weeks earlier" · "$54.00 less". Rendered verbatim. */
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
      phrase: `${span(days)} ${days < 0 ? "earlier" : "later"}`,
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
        phrase: `${dollars(delta)} ${delta < 0 ? "less" : "more"} billed`,
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
 * What AGREES about this candidate, stated in one sentence.
 *
 * Only fields it could actually compare are named — the whole value of this
 * sentence is that a reader can trust each clause in it, and a clause about a
 * field nobody sent would spend that trust immediately.
 *
 * Returns `null` when nothing could be compared, which the screen renders as
 * "there is not enough here to say" rather than as agreement.
 */
export function agreement(
  candidate: MatchCandidate,
  eob: { serviceDate?: string | null; billedCents?: number | null; patientName?: string | null },
): string | null {
  const diffs = differences(candidate, eob);
  if (diffs.length > 0) return null;

  const compared: string[] = [];
  if (eob.patientName && candidate.od.patientName) compared.push("Name");
  if (candidate.od.patientBirthdate) compared.push("birthday");
  if (candidate.od.subscriberId) compared.push("subscriber");
  if (at(eob.serviceDate) !== null && at(candidate.od.dateService) !== null) compared.push("date");
  const paired = candidate.linePairs.filter((p) => p.odClaimProcNum !== null).length;
  if (candidate.linePairs.length > 0 && paired === candidate.linePairs.length) {
    compared.push("every line");
  }

  if (compared.length === 0) return null;
  if (compared.length === 1) return `${compared[0]} agrees.`;
  const last = compared[compared.length - 1];
  return `${compared.slice(0, -1).join(", ")} and ${last} agree.`;
}
