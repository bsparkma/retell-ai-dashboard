/**
 * ONE CHECK, FIVE STEPS — the model every RCM screen renders.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-08-25 the person who commissioned this product drove the posting flow
 * cold and got stuck four times in twenty minutes; RCM_POSTING.md §15.2. That
 * produced the rail. On 2026-08-30 he read the finished rail cold and could not
 * parse the words on it — *"the term drain, I don't understand — that does not
 * make any sense to me"* — which is a different failure with the same cost.
 *
 * A biller should be able to answer "where is this one, and what is the next
 * click" from any page in under two seconds, IN HER OWN VOCABULARY. That answer
 * has to be computed in ONE place, or the three screens will each grow their own
 * opinion and start disagreeing.
 *
 *   Add the check → Match it up → Check it over → Post → Deposit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVEN BECAME FIVE, AND WHICH TWO FOLDED
 * ─────────────────────────────────────────────────────────────────────────────
 * The rail used to read `Upload → Match → Confirm → Review → Approve → Post →
 * Deposit`. Seven steps across a card is a diagram of an implementation, not a
 * description of a morning, and two of them were not separate acts to the person
 * doing them:
 *
 *   CONFIRM FOLDED INTO MATCH. Picking between the candidates Open Dental
 *   offered IS matching — a biller does not experience "the search ran" and "I
 *   chose one" as two stages, and drawing them apart put a permanently-half-lit
 *   rail on every check with one ambiguous claim. **The confirm ACTION, its
 *   route, its audit row and its `rcm.write` tier are all unchanged.** What
 *   changed is that `match` reads `done` only once every claim is CONFIRMED, so
 *   the fold cannot make an unfinished check look finished.
 *
 *   APPROVE FOLDED INTO REVIEW. "Check it over" carries look-at-it AND
 *   say-yes; `post` carries exactly one verb, the write to Open Dental.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY APPROVE FOLDS INTO REVIEW AND NOT INTO POST — PM RULING, 2026-08-30
 * ─────────────────────────────────────────────────────────────────────────────
 * This was built the other way first, and reversed on review. The reasons, in
 * the order they matter, because two of them are not obvious from the diagram:
 *
 *   1. SHADOW MODE IS THE NEXT FOUR WEEKS OF THIS PRODUCT'S LIFE, and posting
 *      is switched off for all of it. With approve inside `post`, every check a
 *      biller works ends parked mid-step on "Post — ready to post", and she
 *      never completes the flow once in a month of real work. With approve
 *      inside `review` she finishes four of five steps every time and the fifth
 *      is visibly, honestly switched off. That is the difference between a
 *      product that works with the gate on and one that looks broken.
 *
 *   2. THE STATE VOCABULARY ALREADY ANSWERS IT. "Ready to post" is the state
 *      approving PRODUCES. A step cannot both produce "Ready to post" and be the
 *      step you are standing on while ready to post.
 *
 *   3. REVIEW-THEN-SEND IS THIS MODULE'S FOUNDING SENTENCE (hard rule 1). Every
 *      human judgment in one step, the machine write in the next, and the step
 *      names say the invariant out loud. A "Post" step quietly containing an
 *      approve blurs the one boundary this module does not blur.
 *
 * §4 puts both BUTTONS on one page, and that is not a counter-argument: a page
 * is not a step. The rail says where she is; the page says what she can reach
 * from where she is.
 *
 * The takeback's typed confirmation (D-6) lives inside `review` for the same
 * reason — it is a human authorising money, not a machine writing it.
 *
 * Approving still writes a posting plan, still runs the gate, still demands
 * `rcm.write`; nothing about the ACT moved.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE MAY AND MAY NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * It DERIVES a presentation from state the server already sent. It never
 * predicts an outcome the server has not: the approval gate's own checklist
 * remains the only thing that says whether a claim will be approved, and the
 * step this file calls `post` reports what HAS happened, never what will.
 * Where a fact is genuinely unknown from the payload in hand — whether a posting
 * has run, when you are looking at a single claim — the step reads `todo` or
 * `unknown` rather than a guess.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STEP IDS ARE MACHINE SLUGS AND DID NOT CHANGE
 * ─────────────────────────────────────────────────────────────────────────────
 * `upload | match | review | post | deposit` are the same words they always
 * were. Only `TITLES` — the strings a person reads — is in the biller's
 * vocabulary. `confirm` and `approve` are gone as STEPS; they are untouched as
 * actions, routes, permissions and audit resources.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPOSIT IS RENDERED AND IS NOT BUILT
 * ─────────────────────────────────────────────────────────────────────────────
 * Recording the practice's deposit against the check is Slice 6e. It is drawn as
 * the last step, greyed, saying so. Ending the rail at `post` would make a check
 * look finished while the deposit is still somebody's morning job, and the shape
 * of the flow would change under a biller's feet the week it ships.
 */
import type {
  OdMatchStatus,
  PostingQueueLabel,
  PostingQueueRow,
  Remittance,
  RemittanceClaim,
  WorkbenchClaim,
} from "@/features/rcm/api";
import { matchStatusLabel, money } from "@/features/rcm/format";
import { blockedCopy, withdrawnCopy } from "@/features/rcm/posting";
import { officeDay } from "@/features/rcm/time";

export const RCM_STEPS = ["upload", "match", "review", "post", "deposit"] as const;
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
 *                whether its check has been posted, and saying "not posted"
 *                would be an assertion nobody made.
 *  unavailable — not built yet (deposit). Never reads as a failure.
 */
export type StepState = "done" | "current" | "todo" | "blocked" | "unknown" | "unavailable";

/**
 * The verbs a CTA can fire. A page handles the ones it owns and no others.
 *
 * MACHINE NAMES, unchanged. `drain` is what the server calls posting to Open
 * Dental and what `POST /api/rcm/posting/drain` is still named; only what a
 * person reads on the button changed.
 */
export type RcmAction = "run-match" | "approve" | "drain" | "review";

export interface StepView {
  step: RcmStep;
  /** The step's name, in the words the rail prints. */
  title: string;
  state: StepState;
  /** One line under the step. On `blocked`, this is the blocking reason. */
  detail: string | null;
  /** Where this step is done. Null when it is not somewhere you can go. */
  href: string | null;
}

export interface RcmCta {
  /** Which step this CTA advances — what lights up in the rail. */
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

/**
 * THE ONLY PLACE A STEP'S NAME IS WRITTEN.
 *
 * "Add the check" rather than "Upload": a biller adds a check to the day's work,
 * and uploading is what the file does on the way. "Match it up" and "Check it
 * over" are the phrases used at the desk. "Post" is the one word that already
 * meant the right thing to everybody.
 */
const TITLES: Record<RcmStep, string> = {
  upload: "Add the check",
  match: "Match it up",
  // Look at it AND say yes. See the fold ruling in the header.
  review: "Check it over",
  // ONE verb: the write to Open Dental, and nothing else.
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

/** "1 of 3 claims has" / "2 of 3 claims have" — the subject is the COUNT. */
const someOf = (n: number, total: number) =>
  `${n} of ${total} ${plural(total, "claim")} ${n === 1 ? "has" : "have"}`;

/**
 * EXACTLY ONE STEP IS LIT.
 *
 * Checking a claim over does not depend on matching it — "looked, nothing to do"
 * is finished work on a claim with no chart match — so a fresh check is
 * genuinely available at two steps at once. Drawing both filled makes the rail
 * answer "where am I" with two places, which is not an answer.
 *
 * The first live step keeps its state; anything live after it reads `todo`,
 * detail and all. A BLOCKED step is never demoted: it is not "where you are", it
 * is a thing that has to change, and burying the second one would hide work.
 */
function oneCurrent(steps: StepView[]): StepView[] {
  let seen = false;
  return steps.map((s) => {
    if (s.state !== "current") return s;
    if (seen) return { ...s, state: "todo" as StepState };
    seen = true;
    return s;
  });
}

/**
 * The claim page's URL, carrying where it was opened from.
 *
 * `from` is the ONLY way the claim screen can offer "back to the check":
 * `GET /api/rcm/claims/:id` does not return the claim's `batch_id` (see the
 * backend asks in the PR). Arriving without it is handled — the breadcrumb falls
 * back to the list rather than inventing a link.
 */
export function claimHref(claimId: string, batchId?: string | null): string {
  return batchId
    ? `/rcm/claims/${encodeURIComponent(claimId)}?from=${encodeURIComponent(batchId)}`
    : `/rcm/claims/${encodeURIComponent(claimId)}`;
}

export function remittanceHref(batchId: string): string {
  return `/rcm/remittances/${encodeURIComponent(batchId)}`;
}

/**
 * "Review and approve" — the ONE place approving happens.
 *
 * A helper rather than a template literal at each call site, because Stage C-3
 * replaced the claim screen's permanently-disabled Approve button with a link to
 * here, and two screens now form this URL. Two hand-rolled copies of a route are
 * how one of them ends up pointing at a 404 the day the route moves.
 */
export function approveHref(batchId: string): string {
  return `/rcm/remittances/${encodeURIComponent(batchId)}/approve`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   ONE CLAIM'S STATE, IN ONE SENTENCE — Stage C-3, item 1
   ─────────────────────────────────────────────────────────────────────────────
   The claim screen's three states — candidates, linked, checked over — looked
   95% alike, because each one was reported in five places at once and none of
   them was the place. *"The page I click Mark checked over → Approve for posting
   feels like the same page."*

   So the state now lives in exactly TWO things at the top of the screen: the
   step rail, and this line under it. The header chip that used to be a third is
   folded INTO this line — same words, same tone, one place — and everything
   below is evidence, which does not get to announce the state again.

   It reads the SAME fields `claimFlow` reads, immediately beside it, so the rail
   and the line cannot drift into disagreeing about one claim.
   ────────────────────────────────────────────────────────────────────────────── */

/** The four states a biller distinguishes, in her order. */
export type ClaimStage = "candidates" | "linked" | "checked_over" | "approved";

export interface ClaimStateLine {
  stage: ClaimStage;
  /**
   * The chip's words — the match status, from the SAME helper the chip used.
   *
   * It is here rather than left on a separate element because `no_candidate` is
   * one stored status covering two different answers, and losing that
   * distinction to tidy the header would have been a real fact traded for a
   * shorter page.
   */
  badge: string;
  /** Where it is. Present tense, a fact. */
  where: string;
  /** What the next click is, or null when there is nothing left to do here. */
  next: string | null;
}

/**
 * @param claim the claim as the detail read returned it
 */
export function claimStateLine(claim: WorkbenchClaim): ClaimStateLine {
  /*
   * THE SNAPSHOT FIRST, the projection as the fallback.
   *
   * `claim.rejectedCandidates` exists so a LIST row can tell the two negatives
   * apart without carrying a snapshot at all. Where a snapshot IS loaded — which
   * is every detail read — it is the thing the panel below is rendering from, and
   * a header that disagreed with the panel about how many claims were set aside
   * would be the screen arguing with itself. This is the order the chip this
   * replaced already read them in.
   */
  const rejected = claim.matchSnapshot?.rejectedCandidates ?? claim.rejectedCandidates ?? 0;
  const badge = matchStatusLabel(claim.odMatchStatus, rejected);
  /*
   * BOTH HALVES, ALWAYS. `od_claim_num` is meaningful only when the status is
   * `confirmed` — a DB CHECK enforces the pair — so reading either one alone
   * would let a half-written row render as linked to nothing.
   */
  const linked = claim.odMatchStatus === "confirmed" && claim.odClaimNum !== null;

  if (!linked) {
    return {
      stage: "candidates",
      badge,
      where: "Not linked to Open Dental yet.",
      next: "Pick which Open Dental claim this is. Nothing can be approved until you do.",
    };
  }

  const to = `Linked to Open Dental claim ${claim.odClaimNum}`;

  if (claim.postingQueueId) {
    return {
      stage: "approved",
      badge,
      where: `${to}, checked over, and approved${
        claim.approvedAt ? ` on ${officeDay(claim.approvedAt, claim.officeId)}` : ""
      }.`,
      next: null,
    };
  }

  if (!claim.reviewedAt) {
    return {
      stage: "linked",
      badge,
      where: `${to}.`,
      next: "Read the two sides below, decide any write-offs, then mark it checked over.",
    };
  }

  return {
    stage: "checked_over",
    badge,
    where: `${to} and checked over by ${claim.reviewedBy ?? "somebody"} on ${officeDay(
      claim.reviewedAt,
      claim.officeId,
    )}.`,
    next: "Approving happens on the check — the whole check is approved at once.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A WHOLE CHECK — the detail screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where this check is, from its own row and its claims.
 *
 * The claims carry the human decisions (matched, confirmed, checked over); the
 * row carries what happened AFTER approval, because posting writes to the
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

  // ── Add the check ─────────────────────────────────────────────────────────
  const upload = view(
    "upload",
    "done",
    remittance.source === "eob"
      ? "Read from an EOB PDF."
      : remittance.source === "835"
        ? "Parsed from the carrier's 835 file."
        : "This check is in CareIN.",
    "/rcm/remittances",
  );

  // ── Match it up ───────────────────────────────────────────────────────────
  // Searching and choosing are ONE step. `done` requires CONFIRMED, so folding
  // the choice in cannot make an unfinished check read as finished.
  let match: StepView;
  const firstUndecided = undecided[0] ?? null;
  if (total === 0) {
    match = view("match", "blocked", "This check carries no claims, so there is nothing to match.");
  } else if (unmatched.length > 0) {
    match = view(
      "match",
      "current",
      `${someOf(unmatched.length, total)} not been looked for in Open Dental yet.`,
      remittanceHref(batchId),
    );
  } else if (undecided.length > 0) {
    match = view(
      "match",
      "current",
      `${claims(undecided.length)} found more than one possible match in Open Dental and ${
        undecided.length === 1 ? "is" : "are"
      } waiting for somebody to pick the right one.`,
      firstUndecided ? claimHref(firstUndecided.claimId, batchId) : null,
    );
  } else if (confirmed.length === 0 && noCandidate.length > 0) {
    match = view(
      "match",
      "blocked",
      `Open Dental has no claim that can be offered for ${
        noCandidate.length === total ? "any of these" : claims(noCandidate.length)
      }. Nothing here can be posted until that is fixed in Open Dental.`,
      noCandidate[0] ? claimHref(noCandidate[0].claimId, batchId) : null,
    );
  } else {
    match = view(
      "match",
      "done",
      `${claims(confirmed.length)} tied to a claim in Open Dental${
        noCandidate.length > 0 ? ` · ${noCandidate.length} with nothing to tie to` : ""
      }.`,
      confirmed[0] ? claimHref(confirmed[0].claimId, batchId) : null,
    );
  }

  // ── Check it over ─────────────────────────────────────────────────────────
  // EVERY HUMAN JUDGMENT ON THIS CHECK: read each claim, and then say yes.
  // Deliberately independent of matching — "looked, nothing to do" is finished
  // work, and a claim with no chart match can still be checked over.
  const review = reviewStep({
    total,
    queued: queued.length,
    unreviewed: unreviewed.length,
    balanced: remittance.balance.balanced,
    differenceCents: remittance.balance.differenceCents,
    claimsWithheld: reasons.has("claims_withheld"),
    stillMatching: undecided.length > 0 || unmatched.length > 0,
    firstUnreviewed: unreviewed[0] ?? null,
    batchId,
  });

  // ── Post ──────────────────────────────────────────────────────────────────
  const post = postStep({
    queued: queued.length,
    postedAmountCents: remittance.postedAmountCents,
    isPosted: observations.has("claims_posted") || remittance.status === "posted",
    postingFailed: reasons.has("posting_failed"),
  });

  const steps = oneCurrent([upload, match, review, post, DEPOSIT]);
  return {
    steps,
    cta: ctaFor(steps, {
      batchId,
      undecided: firstUndecided,
      unreviewed: unreviewed[0] ?? null,
      postable: total - queued.length,
      queued: queued.length,
    }),
  };
}

/**
 * CHECK IT OVER — reading every claim, and then approving the check.
 *
 * Two acts, one step, and the step reads `done` only when BOTH have happened.
 * See the fold ruling in the header: every human judgment lands here so that
 * `post` can carry exactly one verb.
 *
 * The precedence:
 *
 *   1. NOTHING TO CHECK — an empty check is `todo`; `match` already says why.
 *   2. STILL READING — claims nobody has dispositioned. The reading comes
 *      before the signing-off, always.
 *   3. UNBALANCED — read, and un-approvable: no claim on a check whose money
 *      does not add up may be approved at all. Blocked before any question of
 *      how much of it is ready.
 *   4. APPROVED — some or all. `done` only at all; a partial approve is still
 *      the step you are on, and it names what was left behind.
 *   5. NOTHING GOT THROUGH — an approve ran and held everything back.
 *   6. NOT THERE YET — matching is unfinished, so approving cannot start.
 *   7. Otherwise: read, and waiting for somebody to say yes.
 */
function reviewStep(f: {
  total: number;
  queued: number;
  unreviewed: number;
  balanced: boolean;
  differenceCents: number;
  claimsWithheld: boolean;
  stillMatching: boolean;
  firstUnreviewed: RemittanceClaim | null;
  batchId: string;
}): StepView {
  const here = remittanceHref(f.batchId);

  if (f.total === 0) return view("review", "todo", null, here);

  if (f.unreviewed > 0) {
    return view(
      "review",
      "current",
      `${claims(f.unreviewed)} ${
        f.unreviewed === 1 ? "still needs" : "still need"
      } a note and a Mark checked over.`,
      f.firstUnreviewed ? claimHref(f.firstUnreviewed.claimId, f.batchId) : here,
    );
  }
  if (!f.balanced) {
    return view(
      "review",
      "blocked",
      `This check does not balance — ${money(
        f.differenceCents,
      )} is unaccounted for. Nothing on it can be approved.`,
      here,
    );
  }
  if (f.queued > 0) {
    return f.queued === f.total
      ? view(
          "review",
          "done",
          `All ${claims(f.total)} checked over and approved.`,
          here,
        )
      : view(
          "review",
          "current",
          `All ${claims(f.total)} checked over · ${f.queued} approved · ${
            f.total - f.queued
          } not ready yet.`,
          here,
        );
  }
  if (f.claimsWithheld) {
    return view(
      "review",
      "blocked",
      "Somebody pressed Approve and nothing could go through. The checklist below says what stopped each claim.",
      here,
    );
  }
  if (f.stillMatching) {
    return view(
      "review",
      "current",
      `All ${claims(f.total)} checked over. Finish matching before approving.`,
      here,
    );
  }
  return view(
    "review",
    "current",
    `All ${claims(f.total)} checked over. Nothing has been approved yet.`,
    here,
  );
}

/**
 * POST — one verb, and exactly one.
 *
 * The write to Open Dental and nothing else. Everything a HUMAN decides about a
 * check happens in `review`, one step earlier; see the fold ruling in the
 * header. That split is hard rule 1 — review-then-send — said out loud in the
 * step names, and it is why this function takes four facts rather than nine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY THREE PRE-POSTED STATES, AND WHY THAT MATTERS IN SHADOW MODE
 * ─────────────────────────────────────────────────────────────────────────────
 *   done     the money is on the chart
 *   blocked  a posting ran and did not finish — money may have moved and the
 *            check may not exist (§8), which outranks every quieter complaint
 *   current  approved and waiting: this is the ONE thing this step can be
 *            before it has run
 *   todo     nobody has approved the check yet
 *
 * Roland ships to production with posting switched off. A biller works checks
 * for four weeks and every one of them stops HERE, at `current`, honestly. Four
 * of five steps complete on every check is a product working with the gate on;
 * the whole rail stalling at a step that also contained her approval would have
 * read as a product that does not work.
 */
function postStep(f: {
  queued: number;
  postedAmountCents: number;
  isPosted: boolean;
  postingFailed: boolean;
}): StepView {
  const here = "/rcm/posting";

  if (f.isPosted) {
    return view(
      "post",
      "done",
      `Posted to Open Dental${f.postedAmountCents ? ` · ${money(f.postedAmountCents)}` : ""}.`,
      here,
    );
  }
  if (f.postingFailed) {
    return view(
      "post",
      "blocked",
      "A posting did not finish. Open the Posting screen — it says exactly where it stopped.",
      here,
    );
  }
  if (f.queued > 0) {
    return view(
      "post",
      "current",
      "Ready to post. Nothing has been written to Open Dental yet.",
      here,
    );
  }
  return view("post", "todo", "Approve the check first.", here);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE CLAIM — the match screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where THIS claim is.
 *
 * `post` is `unknown` rather than `todo` on purpose: the claim payload knows the
 * check has been approved (`postingQueueId`) and knows nothing about whether it
 * has been posted. Printing "not posted" from here would be this screen
 * asserting something nobody told it, which is the one thing every other refusal
 * in this module is careful not to do.
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

  const match = matchStepFor(claim.odMatchStatus, claim.odClaimNum, here, {
    stale: claim.matchSnapshotStale === true,
  });

  /*
   * ONE CLAIM'S "CHECK IT OVER" IS TWO FACTS, and the second belongs to the
   * whole check rather than to this claim.
   *
   * Reading it is per-claim and happens here. APPROVING is per-CHECK — the gate
   * evaluates every claim on a remittance and writes one plan — so a claim that
   * has been read but whose check nobody has approved reads `current` and points
   * back at the check. `done` needs both, exactly as it does on the check's own
   * rail, so the fold cannot make an unapproved claim look finished.
   */
  const review = !claim.reviewedAt
    ? view("review", "current", "Add a note and mark this claim checked over.", here)
    : claim.postingQueueId
      ? view(
          "review",
          "done",
          `Checked over by ${claim.reviewedBy ?? "somebody"} on ${officeDay(
            claim.reviewedAt,
            claim.officeId,
          )}, and approved${
            claim.approvedAt ? ` on ${officeDay(claim.approvedAt, claim.officeId)}` : ""
          }.`,
          here,
        )
      : view(
          "review",
          "current",
          `Checked over by ${claim.reviewedBy ?? "somebody"} on ${officeDay(
            claim.reviewedAt,
            claim.officeId,
          )}. Approving happens on the check, where the whole check is approved at once.`,
          back,
        );

  const post = claim.postingQueueId
    ? view(
        "post",
        "unknown",
        "This claim is approved. The Posting screen says whether it has reached Open Dental.",
        "/rcm/posting",
      )
    : view(
        "post",
        "todo",
        "Posting happens on the check, once the whole check is approved.",
        back,
      );

  const steps = oneCurrent([upload, match, review, post, DEPOSIT]);
  return {
    steps,
    cta: ctaFor(steps, {
      batchId,
      claimId: claim.claimId,
      odClaimNum: claim.odClaimNum,
      queued: claim.postingQueueId ? 1 : 0,
      reviewedHere: claim.reviewedAt != null,
    }),
  };
}

/**
 * The match step from a match status alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS WHERE CONFIRM WENT
 * ─────────────────────────────────────────────────────────────────────────────
 * It replaces `confirmStepFor`, and the important half of the replacement is
 * that `candidates` — the state that used to light `confirm` — now reads
 * `current` HERE and NOT `done`. Searching and choosing are one step to a
 * biller; they are not one step to the machinery, and a fold that let a search
 * count as a match would have made an unconfirmed claim look tied to a chart.
 *
 * `stale` is a fifth case that is not a match status: the stored evidence is in
 * an older format and cannot be read at all, so the step is `current` with its
 * own sentence rather than borrowing `not_run`'s.
 */
export function matchStepFor(
  status: OdMatchStatus,
  odClaimNum: number | null,
  href: string | null,
  { stale = false }: { stale?: boolean } = {},
): StepView {
  if (stale) {
    return view(
      "match",
      "current",
      "The stored match is in an older format and cannot be read. Run it again.",
      href,
    );
  }
  switch (status) {
    case "confirmed":
      return view("match", "done", `Tied to Open Dental claim ${odClaimNum ?? "—"}.`, href);
    case "candidates":
      return view(
        "match",
        "current",
        "Open Dental offered more than one claim — pick the right one.",
        href,
      );
    case "no_candidate":
      return view(
        "match",
        "blocked",
        "Open Dental has no claim that can be offered for this one. Nothing can be posted against it until that is fixed in Open Dental.",
        href,
      );
    case "not_run":
    default:
      return view(
        "match",
        "current",
        "Nobody has looked in Open Dental yet. Matching only READS the chart.",
        href,
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE POSTING — the posting row's expanded detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One posting's flow.
 *
 * Everything up to and including the approval is `done` by construction: this
 * row cannot exist unless a person confirmed every match and approved the check.
 * The only live step is `post`, and its state is the SERVER'S `statusLabel`
 * rather than the stored status — the same rule `posting.ts` follows, so a state
 * added to the CHECK constraint next slice cannot render as its own slug.
 */
export function planFlow(row: PostingQueueRow): RcmFlow {
  const back = remittanceHref(row.batchId);
  const upload = view("upload", "done", "This check is in CareIN.", back);
  const match = view(
    "match",
    "done",
    "Every claim on this check was searched for and tied to a claim in Open Dental.",
    back,
  );
  const review = view(
    "review",
    "done",
    `Every claim was checked over, and approved by ${row.approvedBy ?? "somebody"}${
      row.approvedAt ? ` on ${officeDay(row.approvedAt, row.office)}` : ""
    }.`,
    back,
  );

  const steps = oneCurrent([upload, match, review, postStepFor(row), DEPOSIT]);
  return { steps, cta: ctaFor(steps, { queueId: row.queueId, queued: 1 }) };
}

/** The `post` step for one posting, keyed by the label the server chose. */
export function postStepFor(row: PostingQueueRow): StepView {
  const here = "/rcm/posting";
  const label: PostingQueueLabel = row.statusLabel;
  switch (label) {
    case "posted":
      return view(
        "post",
        "done",
        row.odClaimPaymentNum
          ? `Open Dental check #${row.odClaimPaymentNum}, confirmed in Open Dental.`
          : "Posted, and confirmed in Open Dental.",
        here,
      );
    case "running":
      return view("post", "current", "Posting to Open Dental right now.", here);
    case "queued":
      return view("post", "current", "Ready to post. Nothing has been written to Open Dental.", here);
    case "partially_posted":
      return view(
        "post",
        "blocked",
        "Money reached the chart and the posting stopped part-way. The lines below say exactly where.",
        here,
      );
    case "failed":
      return view(
        "post",
        "blocked",
        row.lastError ??
          "Nothing was written. Posting again re-reads Open Dental first and starts clean.",
        here,
      );
    case "withdrawn": {
      /*
       * `unavailable`, not `blocked`. Every other unhappy state on this rail is
       * an instruction — fix the thing, press again. This one is a full stop:
       * this check will never post and there is nothing here for a biller to do.
       * Rendering it as `blocked` would put it on her worklist forever.
       */
      const copy = withdrawnCopy(row.withdrawnReason);
      const note = row.withdrawnNote ? ` “${row.withdrawnNote}”` : "";
      return view(
        "post",
        "unavailable",
        copy ? `${copy.label}. ${copy.fix}${note}` : "This check was retired and will not post.",
        here,
      );
    }
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
  /** The first claim nobody has checked over, when there is one. */
  unreviewed?: RemittanceClaim | null;
  /** How many claims on this check are not yet approved. */
  postable?: number;
  /** How many ARE approved. */
  queued?: number;
  /**
   * CLAIM SCREEN ONLY: has THIS claim been checked over?
   *
   * `unreviewed` is a whole-check fact and the claim screen has no list to draw
   * one from, so without this a read claim on an unapproved check would be
   * offered "Mark checked over" a second time. The check's own screen never sets
   * it — there, `unreviewed` already answers the question.
   */
  reviewedHere?: boolean;
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
    case "match": {
      /*
       * TWO VERBS BEHIND ONE STEP, and which one is offered depends on whether
       * Open Dental has already been asked. Running the search and picking from
       * what it returned are different clicks in different places; folding the
       * STEP did not fold the CLICK, and offering "match it up" to somebody
       * looking at three candidates would be the rail's own advice being wrong.
       */
      if (ctx.undecided) {
        return {
          ...base,
          label: `Pick the right claim for ${ctx.undecided.patientName}`,
          href: claimHref(ctx.undecided.claimId, ctx.batchId),
          action: null,
          note: "Ties the claim to a chart. Still writes nothing to Open Dental.",
        };
      }
      return {
        ...base,
        label: "Match it up",
        href: null,
        action: "run-match" as const,
        note: "Reads Open Dental. Writes nothing to any chart.",
      };
    }
    case "review": {
      /*
       * TWO VERBS BEHIND ONE STEP — the reading, then the signing-off.
       *
       * Reading comes first and is per-claim, so while any claim is unread the
       * CTA is a link to that claim. Once every claim has been read the next
       * click is the approval, which is per-CHECK and lives on the check's page.
       *
       * On the CLAIM screen the approve button does not exist, so it becomes a
       * link back to the check — a CTA firing a verb the page does not own is a
       * button that does nothing.
       */
      if (ctx.unreviewed) {
        return {
          ...base,
          label: `Check over ${ctx.unreviewed.patientName}`,
          href: claimHref(ctx.unreviewed.claimId, ctx.batchId),
          action: null,
          note: "Worklist hygiene. Changes nothing in Open Dental.",
        };
      }
      if (ctx.claimId && !ctx.reviewedHere) {
        return {
          ...base,
          label: "Mark checked over",
          href: null,
          action: "review" as const,
          note: "Worklist hygiene. Changes nothing in Open Dental.",
        };
      }
      const n = ctx.postable ?? 0;
      return {
        ...base,
        label: n > 0 ? `Approve ${claims(n)} for posting` : "Approve for posting",
        href: ctx.claimId && ctx.batchId ? remittanceHref(ctx.batchId) : null,
        action: ctx.claimId ? null : ("approve" as const),
        note: ctx.claimId
          ? "Approving happens on the check, where the whole check is approved at once."
          : "Takes you to the checklist below, which explains every claim.",
      };
    }
    case "post": {
      /*
       * ONE VERB. Everything a human decides happened at `review`; this is the
       * write, and after §4 the button is on this page.
       *
       * On the CLAIM screen it becomes a link back to the check, for the same
       * reason as above.
       */
      return {
        ...base,
        label: "Post to Open Dental",
        href: ctx.claimId && ctx.batchId ? remittanceHref(ctx.batchId) : null,
        action: ctx.claimId ? null : ("drain" as const),
        note: ctx.claimId
          ? "Posting happens on the check, where the whole check goes at once."
          : "Takes you to the Post button below — the one action in CareIN that writes to a patient's chart.",
      };
    }
    default:
      return null;
  }
}
