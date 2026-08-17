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

/** Integer cents → "$1,234.56". The ONLY division by 100 in this feature. */
export function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/**
 * A 'YYYY-MM-DD' date, rendered without a timezone shift.
 *
 * Parsed at NOON UTC on purpose: `new Date("2026-03-02")` is midnight UTC,
 * which in America/Chicago is the evening of March 1st — so a service date
 * would render one day early for every user in the practice's own timezone.
 */
export function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** An ISO instant → a short local date and time. */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A snake_case slug rendered readably when we have no label for it. */
export function humanize(slug: string): string {
  return slug.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ─── Claim-level review reasons (Slices 4 and 5 produce these) ───────────────

/**
 * The machine-readable reasons a claim is held for a human.
 *
 * This is where the ERA parser's detect-and-flag decisions and the EOB
 * extractor's uncertainty flags finally get SEEN. Slice 5 wrote them into
 * `needs_review_reasons` and nothing rendered them.
 */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  reversal_not_postable: "Reversal / takeback — cannot be posted",
  claim_denied: "Denied by the carrier",
  secondary_payer_adjudication: "Secondary payer (coordination of benefits)",
  prior_payer_payment_on_primary_claim: "Prior payer's money on a claim marked primary",
  unparseable_cas: "An adjustment could not be read",
  unstorable_adjustment_group: "An adjustment used an unknown group code",
  procedure_downcoded: "The carrier changed a procedure code",
  no_service_lines: "No service lines",
  line_total_mismatch: "Line payments do not sum to the claim total",
  low_confidence_extraction: "The extraction was low-confidence",
  uncertain_line: "A line was read with low confidence",
};

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

export function reviewReasonLabel(reason: string): string {
  return REVIEW_REASON_LABELS[reason] ?? humanize(reason);
}

// ─── Line flags (rcm_procedure_lines.flags) ──────────────────────────────────

export const LINE_FLAG_LABELS: Record<string, string> = {
  downcode: "Downcoded",
  bundled: "Bundled",
  denied: "Denied",
  partial_pay: "Partial payment",
  unexplained_adj: "Unexplained adjustment",
  frequency_limit: "Frequency limit",
  not_covered: "Not covered",
  pre_auth_required: "Pre-auth required",
};

export function lineFlagLabel(flag: string): string {
  return LINE_FLAG_LABELS[flag] ?? humanize(flag);
}

/** Tailwind classes for a line flag chip. Warning tone for anything unread. */
export function lineFlagTone(flag: string): string {
  if (flag === "denied" || flag === "not_covered") {
    return "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
  }
  if (flag === "unexplained_adj") {
    return "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

// ─── Batch-level attention reasons (computed server-side) ────────────────────

export const ATTENTION_LABELS: Record<string, string> = {
  claims_flagged: "Claims flagged for review",
  claims_unmatched: "Claims not matched to Open Dental",
  claims_unreviewed: "Claims not yet reviewed",
  batch_open: "Held — something on this remittance was flagged",
  batch_unbalanced: "Totals do not reconcile",
  batch_error: "The batch is in error",
  batch_posting: "A posting run holds this batch",
};

export function attentionLabel(reason: string): string {
  return ATTENTION_LABELS[reason] ?? humanize(reason);
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
