/**
 * RCM workbench presentation — one home for money, dates and the vocabularies
 * the three screens share.
 *
 * Money crosses the wire as INTEGER CENTS and is divided by 100 in exactly one
 * place: `money()` below. Nothing else in the RCM feature does arithmetic on a
 * dollar figure, which is what keeps a float out of a number a biller reconciles
 * against a bank statement.
 *
 * Every label map here is EXHAUSTIVE-ISH BY DESIGN: an unmapped key falls back
 * to its own slug rather than rendering as nothing. A new backend reason should
 * appear as an ugly string that prompts a fix, never as a silently missing chip
 * — the same rule the Slice 5 upload panel already follows.
 */
import type { MatchConfidence, OdMatchStatus } from "@/features/rcm/api";
import { LINE_FLAG_LABELS, reasonTone } from "@/features/rcm/labels";

/** Integer cents → "$1,234.56". The ONLY division by 100 in this feature. */
export function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/**
 * A DATE-ONLY value ('YYYY-MM-DD'), rendered without a timezone shift.
 *
 * Parsed at NOON UTC on purpose: `new Date("2026-03-02")` is midnight UTC,
 * which in America/Chicago is the evening of March 1st — so a service date
 * would render one day early for every user in the practice's own timezone.
 *
 * ONLY for values that carry no time. Slicing an ISO INSTANT to ten characters
 * here yields its UTC calendar day, which is what printed "Approved Aug 26"
 * over an approval made at 20:10 on Aug 25 in Roland (§15.2, finding 2). Those
 * go through `officeDay` below.
 */
export function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * An ISO instant → a short date and time IN THE PRACTICE'S OWN ZONE.
 *
 * `stamp` used to render in the BROWSER's zone, so the same approval reported a
 * different date to a biller on a laptop set to UTC than to one beside the
 * chair. Every RCM instant now goes through `time.ts`, where the reasoning
 * lives; these are re-exported from here so the screens already importing
 * `stamp` are fixed without each one changing its import, and so there is one
 * obvious answer to "how do I print a time on an RCM page".
 */
export {
  officeDay,
  officeStamp as stamp,
  officeDayKey,
  withinLastDays,
  OFFICE_TIMEZONE,
  OFFICE_TIME_NOTE,
} from "@/features/rcm/time";

/** A snake_case slug rendered readably when we have no label for it. */
export function humanize(slug: string): string {
  return slug.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ─── Claim-level review reasons, remittance flags, line flags ────────────────

/**
 * ONE VOCABULARY, ONE HOME — `features/rcm/labels.ts`.
 *
 * This file used to keep its own `REVIEW_REASON_LABELS`, and it went stale the
 * moment Slice 5.5 added ten members: it carried `low_confidence_extraction`
 * and `uncertain_line`, neither of which the backend has ever emitted (the real
 * slugs are `low_confidence` and the parameterised `uncertain_line:<N>`), so
 * both entries were dead while the thirteen genuine EOB reasons rendered as raw
 * slugs. Two maps for one vocabulary is how that happens.
 *
 * `labels.ts` is the one the ERA upload panel already used and the one
 * `rcm-labels.test.ts` checks against the backend source. The workbench now
 * reads it too, so a reason added to the backend fails ONE test and is fixed in
 * ONE place.
 */
export { FLAG_LABELS, isBlockingReason, reasonTone } from "@/features/rcm/labels";
export { reviewLabel as reviewReasonLabel } from "@/features/rcm/labels";

/**
 * Which reasons mean "there is nothing to post here", as opposed to "look
 * before you post". Both are held for a human; only the first is a dead end,
 * and the workbench links the manual SOP for those rather than offering an
 * action that does not exist.
 */
export const NO_ACTION_REASONS = new Set([
  "reversal_not_postable",
  "prior_payer_payment_on_primary_claim",
]);

export function lineFlagLabel(flag: string): string {
  return LINE_FLAG_LABELS[flag] ?? humanize(flag);
}

/**
 * Tailwind classes for a line flag chip.
 *
 * Denial and non-coverage stay ROSE: they are not gate failures — a denial is a
 * complete adjudication with nothing to post — but they are the two a biller
 * most needs to spot in a table of numbers. Everything else takes the D-11
 * tone, so a flag that will withhold the claim reads amber here and amber on
 * the approval checklist rather than being one colour in each place.
 */
export function lineFlagTone(flag: string): string {
  if (flag === "denied" || flag === "not_covered") {
    return "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
  }
  return reasonTone(flag);
}

// ─── Batch-level attention (computed server-side) ────────────────────────────

/**
 * Two vocabularies, deliberately separate.
 *
 * REASONS are outstanding actions and are the only thing that puts a remittance
 * in the needs-attention view. OBSERVATIONS are facts about the file — true,
 * worth reading, and never work anybody can discharge in this slice. Merging
 * them is what made a fully-reviewed batch keep saying it needed attention.
 */
export const ATTENTION_LABELS: Record<string, string> = {
  claims_unreviewed: "Claims not yet reviewed",
  batch_no_claims: "No claims on this remittance",
  // ── Slice 6b: the approval obligations ──
  /** An APPROVER owes an action: the work is done and nobody has pressed it. */
  claims_awaiting_approval: "Ready to approve for posting",
  /** An approve ran and left a claim out. Somebody owes a fix or a disposition. */
  claims_withheld: "Claims held back at approval",
  // ── Slice 6c: the drain ──
  /**
   * A posting run did not finish — blocked, failed, or PARTLY posted.
   *
   * An obligation rather than an observation, and `partially_posted` is the
   * reason: money reached the chart and the check may not exist, which is the
   * failure window the whole posting queue exists to survive. A state like that
   * sitting quietly on a list nobody opens is the most expensive silence there
   * is in this module.
   */
  posting_failed: "Posting needs attention",
};

export const OBSERVATION_LABELS: Record<string, string> = {
  claims_flagged: "Claims flagged for review",
  claims_unmatched: "Claims not matched to Open Dental",
  batch_open: "Held — something on this remittance was flagged",
  batch_unbalanced: "Totals do not reconcile",
  batch_error: "This check is in error",
  batch_posting: "A posting is under way on this check",
  /**
   * Slice 6b. The SYSTEM owes the next step and no human does, which is why it
   * is grey — "queued" means a person authorised a posting and nothing has been
   * written to Open Dental.
   *
   * 6c narrowed it rather than replacing it: a plan that FAILED now raises
   * `posting_failed` instead, so this chip means what it has always said.
   */
  claims_queued: "Approved — ready to post",
  /**
   * Slice 6c. Finished: the money is on the chart and every write was verified
   * by reading it back. An observation, because nobody owes anything — the
   * remittance stays visible under "All" and leaves the work view.
   */
  claims_posted: "Posted to Open Dental",
};

export function attentionLabel(reason: string): string {
  return ATTENTION_LABELS[reason] ?? OBSERVATION_LABELS[reason] ?? humanize(reason);
}

// ─── Match state ─────────────────────────────────────────────────────────────

/**
 * `not_run` and `no_candidate` read very differently on purpose. One is work
 * nobody has started; the other is a finished search with a real, negative
 * result — and a biller chases those two things in completely different ways.
 */
export const MATCH_STATUS_LABELS: Record<OdMatchStatus, string> = {
  not_run: "Not matched",
  candidates: "Candidates found — needs a decision",
  no_candidate: "No matching claim in Open Dental",
  confirmed: "Matched",
};

/**
 * The chip's words for a claim whose snapshot we can see.
 *
 * `no_candidate` is one database status covering two different answers: "Open
 * Dental has nothing" and "Open Dental had things and none could be offered".
 * The status column cannot tell them apart — the CHECK constraint has four
 * values and adding a fifth for a display distinction would be the tail wagging
 * the dog — but a chip that asserts the first while the panel below explains
 * the second is a screen arguing with itself.
 *
 * @param status the stored status
 * @param rejectedCandidates from the snapshot; 0 when there is no snapshot
 */
export function matchStatusLabel(status: OdMatchStatus, rejectedCandidates = 0): string {
  if (status === "no_candidate" && rejectedCandidates > 0) return "Examined — none offered";
  return MATCH_STATUS_LABELS[status];
}

export const MATCH_STATUS_TONE: Record<OdMatchStatus, string> = {
  not_run: "bg-muted text-muted-foreground",
  candidates: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  no_candidate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  confirmed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

/** Confidence chip colours. Deliberately NOT green for HIGH at the top level —
 *  green reads as "done", and a HIGH candidate is still an unmade decision. */
export const CONFIDENCE_TONE: Record<MatchConfidence, string> = {
  HIGH: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  MEDIUM:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  LOW: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
};

/** Positive evidence reads green, negative reads amber. Weight decides, so a
 *  new tag is coloured correctly without this file being edited. */
export function evidenceTone(weight: number): string {
  return weight >= 0
    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
}

// ─── Batch status ────────────────────────────────────────────────────────────

/**
 * Slice 5's contract, restated for the reader: `ready` means "a person could
 * act on this now", and `open` means SOMETHING on it was flagged.
 */
export const BATCH_STATUS_LABELS: Record<string, string> = {
  open: "Held for review",
  ready: "Ready",
  posting: "Posting",
  balanced: "Balanced",
  unbalanced: "Unbalanced",
  posted: "Posted",
  error: "Error",
};

export function batchStatusLabel(status: string): string {
  return BATCH_STATUS_LABELS[status] ?? humanize(status);
}

export function batchStatusTone(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "posted":
      return "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300";
    case "error":
    case "unbalanced":
      return "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
    default:
      return "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
  }
}

/** '835' vs 'eob' — not cosmetic. See the tooltip copy in the list. */
export const SOURCE_LABELS: Record<string, string> = {
  "835": "835",
  eob: "EOB PDF",
};

export const SOURCE_TITLES: Record<string, string> = {
  "835": "Parsed from a carrier's X12 835. A machine-readable file can be malformed, but it cannot be misread.",
  eob: "Read from a PDF by a model. Check the figures against the source document before posting.",
};

/**
 * 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", 11–13 → "11th"–"13th".
 *
 * §1's last rename: "1 posting attempt" reads as a statistic about failure;
 * "Posted on the 1st try" is the same fact in the words a person would use, and
 * it lets the ordinary case — it worked first time — read as ordinary rather
 * than as something that had to be counted.
 *
 * A non-positive or non-finite count returns "1st": the caller only reaches this
 * on a check that HAS posted, so at least one try happened by construction, and
 * printing "0th" would be arithmetic showing through the copy.
 */
export function ordinal(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "1st";
  const i = Math.floor(n);
  const tens = i % 100;
  if (tens >= 11 && tens <= 13) return `${i}th`;
  switch (i % 10) {
    case 1:
      return `${i}st`;
    case 2:
      return `${i}nd`;
    case 3:
      return `${i}rd`;
    default:
      return `${i}th`;
  }
}
