/**
 * ONE REMITTANCE, SEVEN STEPS — the model every RCM screen renders.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-08-25 the person who commissioned this product drove the posting flow
 * cold and got stuck four times in twenty minutes. Not one of those was a defect
 * in the machinery: approve lived on the remittance page, review and match lived
 * on the claim page, and nothing on either said where you were or what came
 * next. RCM_POSTING.md §15.2.
 *
 * A biller should be able to answer "where is this one, and what is the next
 * click" from any page in under two seconds. That answer has to be computed in
 * ONE place, or the three screens will each grow their own opinion and start
 * disagreeing — the same failure the vocabulary maps and the server-side
 * attention predicate already exist to prevent one level down.
 *
 *   Upload → Match → Confirm → Review → Approve → Post → Deposit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE MAY AND MAY NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * It DERIVES a presentation from state the server already sent. It never
 * predicts an outcome the server has not: the approval gate's own checklist
 * remains the only thing that says whether a claim will be approved, and the
 * step this file calls `approve` reports what HAS happened, never what will.
 * Where a fact is genuinely unknown from the payload in hand — whether a plan
 * has drained, when you are looking at a single claim — the step reads `todo`
 * or `unknown` rather than a guess.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPOSIT IS RENDERED AND IS NOT BUILT
 * ─────────────────────────────────────────────────────────────────────────────
 * Recording the practice's deposit against the check is Slice 6e. It is drawn
 * as the last step, greyed, saying so. Ending the stepper at `post` would make
 * a plan look finished while the deposit is still somebody's morning job, and
 * the shape of the flow would change under a biller's feet the week it ships.
 */
import type {
  OdMatchStatus,
  PostingQueueLabel,
  PostingQueueRow,
  Remittance,
  RemittanceClaim,
  WorkbenchClaim,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { blockedCopy } from "@/features/rcm/posting";
import { officeDay } from "@/features/rcm/time";

export const RCM_STEPS = [
  "upload",
  "match",
  "confirm",
  "review",
  "approve",
  "post",
  "deposit",
] as const;
export type RcmStep = (typeof RCM_STEPS)[number];

/**
 * What a step is, on THIS thing, right now.
 *
 *  done        — happened; the tick is a statement of fact
 *  current     — the work in front of you
 *  todo        — a later step, not reachable yet
 *  blocked     — something has to change before this can happen, and `detail`
 *                says what, in a biller's words
 *  unknown     — this screen genuinely cannot tell. A claim page cannot see
 *                whether its plan has drained, and saying "not posted" would be
 *                an assertion nobody made.
 *  unavailable — not built yet (deposit). Never reads as a failure.
 */
export type StepState = "done" | "current" | "todo" | "blocked" | "unknown" | "unavailable";

/** The verbs a CTA can fire. A page handles the ones it owns and no others. */
export type RcmAction = "run-match" | "approve" | "drain" | "review";

export interface StepView {
  step: RcmStep;
  /** The step's name, in the words the stepper prints. */
  title: string;
  state: StepState;
  /** One line under the step. On `blocked`, this is the blocking reason. */
  detail: string | null;
  /** Where this step is done. Null when it is not somewhere you can go. */
  href: string | null;
}

export interface RcmCta {
  /** Which step this CTA advances — what lights up in the stepper. */
  step: RcmStep;
  label: string;
  /** Navigate here, unless `action` is handled by the page. */
  href: string | null;
  /** A verb the page may handle itself. */
  action: RcmAction | null;
  /** True when the next thing cannot be pressed. `reason` always says why. */
  disabled: boolean;
  reason: string | null;
  /** A quiet line under the button — where it takes you, or what it does. */
  note: string | null;
}

export interface RcmFlow {
  steps: StepView[];
  cta: RcmCta | null;
}

const TITLES: Record<RcmStep, string> = {
  upload: "Upload",
  match: "Match",
  confirm: "Confirm",
  review: "Review",
  approve: "Approve",
  post: "Post",
  deposit: "Deposit",
};

/** The one step that is drawn and is not built. */
const DEPOSIT: StepView = {
  step: "deposit",
  title: TITLES.deposit,
  state: "unavailable",
  detail: "Coming soon — recording the practice's deposit against this check.",
  href: null,
};

function view(
  step: RcmStep,
  state: StepState,
  detail: string | null,
  href: string | null = null,
): StepView {
  return { step, title: TITLES[step], state, detail, href };
}

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);

/** "1 claim" / "3 claims" */
const claims = (n: number) => `${n} ${plural(n, "claim")}`;

/**
 * The claim page's URL, carrying where it was opened from.
 *
 * `from` is the ONLY way the claim screen can offer "back to the remittance":
 * `GET /api/rcm/claims/:id` does not return the claim's `batch_id` (see the
 * backend asks in the PR). Arriving without it is handled — the breadcrumb
 * falls back to the list rather than inventing a link.
 */
export function claimHref(claimId: string, batchId?: string | null): string {
  return batchId
    ? `/rcm/claims/${encodeURIComponent(claimId)}?from=${encodeURIComponent(batchId)}`
    : `/rcm/claims/${encodeURIComponent(claimId)}`;
}

export function remittanceHref(batchId: string): string {
  return `/rcm/remittances/${encodeURIComponent(batchId)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// A WHOLE REMITTANCE — the detail screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where this remittance is, from its own row and its claims.
 *
 * The claims carry the human decisions (matched, confirmed, reviewed, approved);
 * the row carries what happened AFTER approval, because a drain writes to the
 * posting queue rather than back onto the claims. `attentionReasons` and
 * `attentionObservations` are the server's own vocabulary for that, so this
 * function reads them rather than inferring a posting state the server never
 * claimed.
 */
export function remittanceFlow(remittance: Remittance, rows: RemittanceClaim[]): RcmFlow {
  const batchId = remittance.batchId;
  const total = rows.length;
  const reasons = new Set(remittance.attentionReasons);
  const observations = new Set(remittance.attentionObservations);

  const unmatched = rows.filter((c) => c.odMatchStatus === "not_run");
  const undecided = rows.filter((c) => c.odMatchStatus === "candidates");
  const noCandidate = rows.filter((c) => c.odMatchStatus === "no_candidate");
  const confirmed = rows.filter((c) => c.odMatchStatus === "confirmed");
  const unreviewed = rows.filter((c) => !c.reviewedAt);
  const queued = rows.filter((c) => c.postingQueueId);

  // ── Upload ────────────────────────────────────────────────────────────────
  const upload = view(
    "upload",
    "done",
    remittance.source === "eob"
      ? "Read from an EOB PDF."
      : remittance.source === "835"
        ? "Parsed from the carrier's 835 file."
        : "This remittance is in CareIN.",
    "/rcm/remittances",
  );

  // ── Match ─────────────────────────────────────────────────────────────────
  let match: StepView;
  if (total === 0) {
    match = view(
      "match",
      "blocked",
      "This remittance carries no claims, so there is nothing to match.",
    );
  } else if (unmatched.length > 0) {
    match = view(
      "match",
      "current",
      `${claims(unmatched.length)} of ${total} have not been looked for in Open Dental yet.`,
      remittanceHref(batchId),
    );
  } else {
    match = view(
      "match",
      "done",
      `All ${claims(total)} searched against Open Dental.`,
      remittanceHref(batchId),
    );
  }

  // ── Confirm ───────────────────────────────────────────────────────────────
  // Only a person may pick a candidate, so this step is never "nearly done".
  let confirm: StepView;
  const firstUndecided = undecided[0] ?? null;
  if (total === 0) {
    confirm = view("confirm", "todo", null);
  } else if (unmatched.length > 0 && undecided.length === 0) {
    confirm = view("confirm", "todo", "Run the match first.");
  } else if (undecided.length > 0) {
    confirm = view(
      "confirm",
      "current",
      `${claims(undecided.length)} found candidates and are waiting for somebody to pick the right one.`,
      firstUndecided ? claimHref(firstUndecided.claimId, batchId) : null,
    );
  } else if (confirmed.length === 0 && noCandidate.length > 0) {
    confirm = view(
      "confirm",
      "blocked",
      `Open Dental has no claim that can be offered for ${
        noCandidate.length === total ? "any of these" : claims(noCandidate.length)
      }. Nothing here can be posted until that is resolved in Open Dental.`,
      noCandidate[0] ? claimHref(noCandidate[0].claimId, batchId) : null,
    );
  } else {
    confirm = view(
      "confirm",
      "done",
      `${claims(confirmed.length)} linked to a chart claim${
        noCandidate.length > 0 ? ` · ${noCandidate.length} with nothing to link to` : ""
      }.`,
      confirmed[0] ? claimHref(confirmed[0].claimId, batchId) : null,
    );
  }

  // ── Review ────────────────────────────────────────────────────────────────
  // Deliberately independent of matching: "looked, nothing to do" is finished
  // work, and a claim with no chart match can still be reviewed.
  let review: StepView;
  if (total === 0) {
    review = view("review", "todo", null);
  } else if (unreviewed.length > 0) {
    review = view(
      "review",
      "current",
      `${claims(unreviewed.length)} still need a note and a Mark reviewed.`,
      claimHref(unreviewed[0].claimId, batchId),
    );
  } else {
    review = view(
      "review",
      "done",
      `All ${claims(total)} reviewed.`,
      claimHref(rows[0].claimId, batchId),
    );
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  // Reports what HAS happened. Whether a claim WILL be approved is the gate's
  // answer and only the gate's — the checklist below the stepper is where that
  // is stated, computed by the same server call the button runs.
  let approve: StepView;
  if (!remittance.balance.balanced) {
    approve = view(
      "approve",
      "blocked",
      `This remittance does not balance — ${money(remittance.balance.differenceCents)} is unaccounted for. Nothing on it can be approved.`,
      remittanceHref(batchId),
    );
  } else if (total > 0 && queued.length === total) {
    approve = view(
      "approve",
      "done",
      `All ${claims(total)} approved for posting.`,
      remittanceHref(batchId),
    );
  } else if (queued.length > 0) {
    approve = view(
      "approve",
      "current",
      `${queued.length} of ${total} approved · ${total - queued.length} still withheld.`,
      remittanceHref(batchId),
    );
  } else if (reasons.has("claims_withheld")) {
    approve = view(
      "approve",
      "blocked",
      "An approval ran and every claim was withheld. The checklist below says which check failed on each.",
      remittanceHref(batchId),
    );
  } else if (unreviewed.length > 0 || undecided.length > 0 || unmatched.length > 0) {
    approve = view(
      "approve",
      "todo",
      "Finish matching and reviewing first.",
      remittanceHref(batchId),
    );
  } else {
    approve = view("approve", "current", "Nothing has been approved yet.", remittanceHref(batchId));
  }

  // ── Post ──────────────────────────────────────────────────────────────────
  let post: StepView;
  if (observations.has("claims_posted") || remittance.status === "posted") {
    post = view(
      "post",
      "done",
      `Posted to Open Dental${
        remittance.postedAmountCents ? ` · ${money(remittance.postedAmountCents)}` : ""
      }.`,
      "/rcm/posting",
    );
  } else if (reasons.has("posting_failed")) {
    post = view(
      "post",
      "blocked",
      "A posting run did not finish. Open the posting queue — it says exactly where it stopped.",
      "/rcm/posting",
    );
  } else if (queued.length > 0) {
    post = view(
      "post",
      "current",
      "Waiting in the posting queue. Nothing has reached a chart yet.",
      "/rcm/posting",
    );
  } else {
    post = view("post", "todo", "Approve first.", "/rcm/posting");
  }

  const steps = [upload, match, confirm, review, approve, post, DEPOSIT];
  return {
    steps,
    cta: ctaFor(steps, {
      batchId,
      undecided: firstUndecided,
      unreviewed: unreviewed[0] ?? null,
      postable: total - queued.length,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE CLAIM — the match screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where THIS claim is.
 *
 * `post` is `unknown` rather than `todo` on purpose: the claim payload knows a
 * plan exists (`postingQueueId`) and knows nothing about whether it drained.
 * Printing "not posted" from here would be this screen asserting something
 * nobody told it, which is the one thing every other refusal in this module is
 * careful not to do.
 */
export function claimFlow(claim: WorkbenchClaim, batchId: string | null): RcmFlow {
  const back = batchId ? remittanceHref(batchId) : "/rcm/remittances";
  const here = claimHref(claim.claimId, batchId);

  const upload = view(
    "upload",
    "done",
    claim.checkNumber ? `Came in on check ${claim.checkNumber}.` : "In CareIN.",
    back,
  );

  const match =
    claim.odMatchStatus === "not_run"
      ? view(
          "match",
          "current",
          "Nobody has looked in Open Dental yet. Running a match only READS the chart.",
          here,
        )
      : claim.matchSnapshotStale
        ? view(
            "match",
            "current",
            "The stored match is in an older format and cannot be read. Run it again.",
            here,
          )
        : view("match", "done", "Searched against Open Dental.", here);

  const confirm = confirmStepFor(claim.odMatchStatus, claim.odClaimNum, here);

  const review = claim.reviewedAt
    ? view(
        "review",
        "done",
        `Reviewed by ${claim.reviewedBy ?? "somebody"} on ${officeDay(claim.reviewedAt, claim.officeId)}.`,
        here,
      )
    : view("review", "current", "Add a note and mark this claim reviewed.", here);

  const approve = claim.postingQueueId
    ? view(
        "approve",
        "done",
        `Approved for posting${
          claim.approvedAt ? ` on ${officeDay(claim.approvedAt, claim.officeId)}` : ""
        }.`,
        back,
      )
    : view(
        "approve",
        claim.odMatchStatus === "confirmed" && claim.reviewedAt ? "current" : "todo",
        "Approving happens on the remittance, where the whole check is approved at once.",
        back,
      );

  const post = claim.postingQueueId
    ? view(
        "post",
        "unknown",
        "This claim is on a posting plan. The posting queue says whether it has run.",
        "/rcm/posting",
      )
    : view("post", "todo", "Approve first.", "/rcm/posting");

  const steps = [upload, match, confirm, review, approve, post, DEPOSIT];
  return {
    steps,
    cta: ctaFor(steps, { batchId, claimId: claim.claimId, odClaimNum: claim.odClaimNum }),
  };
}

/**
 * The confirm step from a match status alone.
 *
 * Split out because the claim screen and the mapping test both want exactly
 * this, one status at a time, with no other state to reason about.
 */
export function confirmStepFor(
  status: OdMatchStatus,
  odClaimNum: number | null,
  href: string | null,
): StepView {
  switch (status) {
    case "confirmed":
      return view("confirm", "done", `Linked to Open Dental claim ${odClaimNum ?? "—"}.`, href);
    case "candidates":
      return view("confirm", "current", "Candidates are waiting — pick the right one.", href);
    case "no_candidate":
      return view(
        "confirm",
        "blocked",
        "Open Dental has no claim that can be offered for this one. Nothing can be posted against it until that is resolved in Open Dental.",
        href,
      );
    case "not_run":
    default:
      return view("confirm", "todo", "Run the match first.", href);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE POSTING PLAN — the posting row's expanded detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plan's flow.
 *
 * Everything up to and including `approve` is `done` by construction: a plan
 * cannot exist unless a person confirmed every match and approved the check.
 * The only live step is `post`, and its state is the SERVER'S `statusLabel`
 * rather than the stored status — the same rule `posting.ts` follows, so a
 * state added to the CHECK constraint next slice cannot render as its own slug.
 */
export function planFlow(row: PostingQueueRow): RcmFlow {
  const back = remittanceHref(row.batchId);
  const upload = view("upload", "done", "This check is in CareIN.", back);
  const match = view(
    "match",
    "done",
    "Every claim on this plan was searched against Open Dental.",
    back,
  );
  const confirm = view("confirm", "done", "Every claim was linked to a chart claim by a person.", back);
  const review = view("review", "done", "Every claim was reviewed.", back);
  const approve = view(
    "approve",
    "done",
    `Approved by ${row.approvedBy ?? "somebody"}${
      row.approvedAt ? ` on ${officeDay(row.approvedAt, row.office)}` : ""
    }.`,
    back,
  );

  const steps = [upload, match, confirm, review, approve, postStepFor(row), DEPOSIT];
  return { steps, cta: ctaFor(steps, { queueId: row.queueId }) };
}

/** The `post` step for one plan, keyed by the label the server chose. */
export function postStepFor(row: PostingQueueRow): StepView {
  const here = "/rcm/posting";
  const label: PostingQueueLabel = row.statusLabel;
  switch (label) {
    case "posted":
      return view(
        "post",
        "done",
        row.odClaimPaymentNum
          ? `Open Dental check #${row.odClaimPaymentNum}, verified by reading it back.`
          : "Posted and verified by read-back.",
        here,
      );
    case "running":
      return view("post", "current", "Posting to Open Dental right now.", here);
    case "queued":
      return view(
        "post",
        "current",
        "Approved and waiting. Nothing has been written to Open Dental.",
        here,
      );
    case "partially_posted":
      return view(
        "post",
        "blocked",
        "Money reached the chart and the run stopped part-way. The lines below say exactly where.",
        here,
      );
    case "failed":
      return view(
        "post",
        "blocked",
        row.lastError ??
          "Nothing was written. Draining again re-reads Open Dental first and starts clean.",
        here,
      );
    case "blocked":
    default: {
      const copy = blockedCopy(row.blockedReason);
      return view(
        "post",
        "blocked",
        copy
          ? `${copy.label}. ${copy.fix}`
          : "Somebody has to change something before this can post.",
        here,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE BUTTON
// ─────────────────────────────────────────────────────────────────────────────

interface CtaContext {
  batchId?: string | null;
  claimId?: string;
  odClaimNum?: number | null;
  queueId?: string;
  /** The first claim whose match is undecided, when there is one. */
  undecided?: RemittanceClaim | null;
  /** The first unreviewed claim, when there is one. */
  unreviewed?: RemittanceClaim | null;
  /** How many claims on this remittance are not yet on a plan. */
  postable?: number;
}

/**
 * ONE call to action, never two.
 *
 * The first step that is `current` or `blocked`, in order — which is exactly
 * what a person walking the flow top to bottom would reach next. A blocked step
 * still produces a CTA, disabled, carrying the blocking reason: "the button is
 * greyed and nothing says why" is finding 4 of §15.2 and the reason this
 * function returns a `reason` rather than an `undefined`.
 *
 * Returns null only when every step through `post` is done — there genuinely is
 * no next click, and inventing one would send somebody to a screen with nothing
 * on it.
 */
export function ctaFor(steps: StepView[], ctx: CtaContext = {}): RcmCta | null {
  const live = steps.find(
    (s) => s.step !== "deposit" && (s.state === "current" || s.state === "blocked"),
  );
  if (!live) return null;

  const blocked = live.state === "blocked";
  const base = { step: live.step, disabled: blocked, reason: blocked ? live.detail : null };

  switch (live.step) {
    case "match":
      return {
        ...base,
        label: "Run the match",
        href: null,
        action: "run-match" as const,
        note: "Reads Open Dental. Writes nothing to any chart.",
      };
    case "confirm": {
      const target = ctx.undecided
        ? claimHref(ctx.undecided.claimId, ctx.batchId)
        : ctx.claimId
          ? claimHref(ctx.claimId, ctx.batchId)
          : null;
      return {
        ...base,
        label: ctx.undecided
          ? `Confirm the match on ${ctx.undecided.patientName}`
          : "Confirm the right claim",
        href: target,
        action: null,
        note: "Links the claim. Still writes nothing to the chart.",
      };
    }
    case "review": {
      const target = ctx.unreviewed ? claimHref(ctx.unreviewed.claimId, ctx.batchId) : null;
      return {
        ...base,
        label: ctx.unreviewed ? `Review ${ctx.unreviewed.patientName}` : "Mark reviewed",
        href: target,
        action: ctx.unreviewed ? null : ("review" as const),
        note: "Worklist hygiene. Changes nothing in Open Dental.",
      };
    }
    case "approve": {
      const n = ctx.postable ?? 0;
      return {
        ...base,
        label: n > 0 ? `Approve ${claims(n)} for posting` : "Approve for posting",
        // On the CLAIM screen approving is somewhere else, so the CTA is a link.
        // On the remittance screen the real button is already on the page, so
        // the CTA takes you to it rather than becoming a second one.
        href: ctx.claimId && ctx.batchId ? remittanceHref(ctx.batchId) : null,
        action: ctx.claimId ? null : ("approve" as const),
        note: ctx.claimId
          ? "Approving happens on the remittance, where the whole check is approved at once."
          : "Takes you to the approval gate below, where the checklist explains every claim.",
      };
    }
    case "post":
      return {
        ...base,
        label: "Go to Posting",
        href: "/rcm/posting",
        action: null,
        note: "The only screen in CareIN that writes to a patient's chart.",
      };
    default:
      return null;
  }
}
