/**
 * Labels and tones for the posting queue (Slice 6c).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CLIENT NEVER TRANSLATES A STATE ITSELF
 * ─────────────────────────────────────────────────────────────────────────────
 * The server ships BOTH the stored `status` (`approved`, `posting`, …) and the
 * screen's `statusLabel` (`queued`, `running`, …), so this file maps a LABEL to
 * copy and a colour, never a stored word to a meaning. That way a state added
 * to the CHECK constraint next slice cannot silently render as its own slug on
 * one screen while the server calls it something else — the mismatch the
 * `rcm-labels` drift test exists to catch one level down.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN UNKNOWN SLUG FAILS CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 * `blockedCopy` returns the slug itself with a neutral explanation rather than
 * an empty string. A reason nobody wrote copy for must still be READABLE — the
 * whole point of `blocked` is that a human is being told to go do something, and
 * a blank chip tells them nothing. This is the same failure the 6b labels test
 * caught: the client failing OPEN on a slug it did not recognise.
 */
import type { PostingLineStatus, PostingQueueLabel, PostingStep } from "@/features/rcm/api";

/** What a plan's state means, in the words a biller would use. */
export const QUEUE_STATE_COPY: Record<PostingQueueLabel, { label: string; hint: string }> = {
  queued: {
    label: "Queued",
    hint: "Approved and waiting. Nothing has been written to Open Dental.",
  },
  running: {
    label: "Running",
    hint: "Posting to Open Dental right now.",
  },
  posted: {
    label: "Posted",
    hint: "The money is on the chart and every write was verified by reading it back.",
  },
  partially_posted: {
    label: "Partly posted",
    hint: "Some of this plan reached the chart and some did not. The lines below say exactly where it stopped.",
  },
  failed: {
    label: "Failed",
    hint: "Nothing was written. Draining again re-reads Open Dental first and starts clean.",
  },
  blocked: {
    label: "Blocked",
    hint: "No Open Dental call was made. Somebody has to change something before this can post.",
  },
  withdrawn: {
    label: "Retired",
    hint:
      "This plan will never post. It is kept so the remittance still has a record, but " +
      "it cannot be drained again.",
  },
};

export function queueStateTone(label: PostingQueueLabel): string {
  switch (label) {
    case "posted":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "running":
      return "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300";
    case "failed":
    case "partially_posted":
      return "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
    case "blocked":
      return "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
    // Deliberately the quietest tone in the set. A retired plan is not a
    // problem to solve and not a success to celebrate; it is a closed file, and
    // it should not compete for attention with the plans that still need a
    // human.
    case "withdrawn":
      return "bg-muted text-muted-foreground line-through decoration-muted-foreground/40";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * Every machine reason the drain can refuse with, and what a person does about
 * it.
 *
 * The copy answers "what do I do now", not "what happened" — a biller reading
 * `office_config_unresolved` needs to know the practice's Open Dental could not
 * be read, not that a promise rejected.
 */
const BLOCKED_COPY: Record<string, { label: string; fix: string }> = {
  valley_not_enabled: {
    label: "This practice is not switched on for posting yet",
    fix:
      "Riley's own payment-type numbers have to be read from Riley's Open Dental, its key's " +
      "write access proven, and a test-patient run completed before anything posts here. " +
      "Roland is unaffected.",
  },
  recoupment_unconfirmed: {
    label: "A takeback nobody confirmed",
    fix:
      "Money is moving backwards on this plan, but it was approved through the ordinary " +
      "button rather than the takeback panel. Nothing was sent. Open the remittance and " +
      "approve the takeback there — it asks you to type the amount first.",
  },
  no_adj_type: {
    label: "This practice cannot book a reversible takeback",
    fix:
      "Open Dental has no adjustment type named 'Insurance deductions from previous " +
      "payments' here, so the takeback cannot be written the reversible way — and it will " +
      "never be switched to the permanent one on your behalf. Add the type in Open Dental's " +
      "setup, then drain again.",
  },
  no_doc_category: {
    label: "There is nowhere to file the EOB",
    fix:
      "Open Dental has no document category named 'Insurance' or 'Financial' here. The " +
      "payment itself is unaffected.",
  },
  office_config_unresolved: {
    label: "This practice's Open Dental settings could not be read",
    fix:
      "The payment types come from Open Dental itself and there is nothing safe to assume. " +
      "Check that Open Dental is reachable, then drain again.",
  },
  no_pay_type: {
    label: "No matching insurance payment type in Open Dental",
    fix:
      "This practice's Open Dental has no payment type named for a check or an EFT. Add one in " +
      "Open Dental's setup, then drain again.",
  },
  eligible_total_mismatch: {
    label: "Open Dental holds money this plan does not know about",
    fix:
      "The claim carries another unposted line, so the check total would not match. The lines " +
      "are written and the claims are received; no check was created. Resolve the extra line " +
      "in Open Dental, then drain again.",
  },
  office_mismatch: {
    label: "This plan's rows disagree about which practice they belong to",
    fix: "Nothing was sent. This needs looking at before anything posts.",
  },
  plan_empty: {
    label: "There is nothing on this plan to post",
    fix: "Re-approve the remittance.",
  },
  claim_not_confirmed: {
    label: "A claim on this plan is no longer a confirmed match",
    fix: "Re-match and re-confirm the claim, then approve it again.",
  },
  claim_not_on_this_plan: {
    label: "A claim on this plan is linked to a different plan",
    fix: "Nothing was sent. Open the remittance and re-approve.",
  },
  negative_intent: {
    label: "A line carries a negative write-off or deductible",
    fix: "That is a reading error rather than a payment. Re-check the remittance.",
  },
  plan_total_mismatch: {
    label: "The lines do not add up to the plan's total",
    fix: "Nothing was sent. Re-approve the remittance so the plan is rebuilt from the claims.",
  },
  snapshot_superseded: {
    label: "A claim's match was recorded in an older format",
    fix: "Re-match and re-confirm that claim, then approve it again.",
  },
  od_writes_disabled: {
    label: "Open Dental writes are switched off in this environment",
    fix: "This is a development safety setting. Nothing was sent.",
  },
};

/**
 * Why a plan was retired. Two reasons, and they read very differently: one is
 * something the machine found out, the other is something a person decided.
 */
const WITHDRAWN_COPY: Record<string, { label: string; fix: string }> = {
  target_removed: {
    label: "The claim this plan was for no longer exists",
    fix:
      "The drain asked Open Dental and got nothing back — the claim was deleted after this " +
      "plan was approved. Open Dental never reuses a claim number, so this can never post. " +
      "If the money still has to go in, it goes in from a new claim.",
  },
  manual: {
    label: "Retired by hand",
    fix: "Somebody decided this plan should not post. Their reason is below.",
  },
};

/** @see WITHDRAWN_COPY — fails closed onto the slug, exactly as blockedCopy does. */
export function withdrawnCopy(reason: string | null): { label: string; fix: string } | null {
  if (!reason) return null;
  return (
    WITHDRAWN_COPY[reason] ?? {
      label: reason.replace(/_/g, " "),
      fix: "This plan was retired and will not post.",
    }
  );
}

export function blockedCopy(reason: string | null): { label: string; fix: string } | null {
  if (!reason) return null;
  return (
    BLOCKED_COPY[reason] ?? {
      // FAIL CLOSED. A reason nobody wrote copy for must still be readable — a
      // blank chip on a screen whose job is to say "go do something" is worse
      // than an ugly one.
      label: reason.replace(/_/g, " "),
      fix: "This plan was refused and no Open Dental call was made.",
    }
  );
}

/** What a line's state means. The vocabulary is the CHECK constraint's. */
export const LINE_STATE_COPY: Record<PostingLineStatus, string> = {
  pending: "Not started",
  claimproc_written: "Adjudication written",
  claim_received: "Claim marked received",
  paid: "On the check",
  failed: "Failed",
  skipped: "Skipped",
  // The distinction that proves a resume did not double-post.
  skipped_already_posted: "Already posted — left alone",
  // 6d. Not "paid": the carrier took this money back rather than sending it.
  recouped: "Taken back",
};

/** How far through the forced sequence a plan got. */
export const STEP_COPY: Record<PostingStep, string> = {
  resolve_config: "Reading this practice's Open Dental settings",
  read_od_truth: "Reading what Open Dental already holds",
  claimproc_writes: "Writing each line's adjudication",
  claim_receipts: "Marking the claims received",
  check: "Creating the insurance check",
  reconcile: "Reading the check back",
  recoupment: "Writing the takeback",
  document_attach: "Filing the EOB into the patient chart",
};

export function stepCopy(step: PostingStep | string | null): string | null {
  if (!step) return null;
  return STEP_COPY[step as PostingStep] ?? step.replace(/_/g, " ");
}
