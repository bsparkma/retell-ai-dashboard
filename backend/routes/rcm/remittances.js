'use strict';

/**
 * /api/rcm/remittances — the review workbench's list and detail (Slice 6a).
 *
 *   GET  /api/rcm/remittances?office=…        every payment batch, needs-attention first
 *   GET  /api/rcm/remittances/:id?office=…    one batch: claims, lines, adjustments
 *   POST /api/rcm/remittances/:id/match?office=…  run the OD match over its claims
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE EXISTS BEFORE ANY POSTING CODE
 * ─────────────────────────────────────────────────────────────────────────────
 * Slices 4 and 5 proved intake: an EOB extracts in seconds, an 835 parses into
 * a batch with claims and lines, duplicates are refused. But the only visible
 * evidence was a counter on an office card. A real 835 was uploaded to staging
 * and there was nowhere to look at what it contained.
 *
 * A module whose data can only be inspected with `psql` is not shippable, and
 * building the posting path on top of an invisible one would mean a biller's
 * first look at a remittance and their first irreversible action on it arriving
 * in the same release.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEEDS ATTENTION IS THE DEFAULT VIEW
 * ─────────────────────────────────────────────────────────────────────────────
 * Same philosophy as the voice worklist: the default is the work, not the
 * archive — and "the work" means an ACTION a human still owes, never a fact the
 * file happens to carry. A batch needs attention while any claim on it has not
 * been dispositioned (marked reviewed). Flags, an honest `no_candidate` and a
 * batch held `open` are shown beside it as observations and hold nothing.
 * See `attentionFor` below for why, and for what it cost to learn.
 *
 * That predicate is computed HERE, server-side, from the same rows the detail
 * renders, so the list, the count and the detail cannot disagree about whether
 * something is done.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL WRITES, AND NO POSTING
 * ─────────────────────────────────────────────────────────────────────────────
 * The only Open Dental traffic anywhere under this mount is GET, through the
 * office's own client (see ./claims.js). There is no approve, no enqueue, no
 * post: `rcm_posting_queue` is untouched by this slice, and the workbench's
 * Approve button is rendered DISABLED so the layout is right when 6b lands.
 */

const express = require('express');

// Namespace import — see the note in summary.js.
const tenantDb = require('../../platform/tenantDb');
const { h, actorEmail, auditRcmRead, auditRcmDenial, isUuid, num, iso, isoDate } = require('./helpers');
const { describeActors, resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { requirePermission, holdsPermission } = require('../../config/permissions');
const { audit } = require('../../platform/audit');
const { toClaimSummary, loadClaimBundle, runBatchMatch, CLAIM_LIST_COLUMNS } = require('./matchService');
const approvalGate = require('./approvalGate');

const router = express.Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * The populations `GET /` will page. Anything else falls back to `all`.
 *
 * Server-side, over the whole office, for the same reason the attention view is:
 * a filter applied to a page while the header counts the practice is two
 * statements about two populations, which is the Slice 6a defect the whole-office
 * scan exists to prevent.
 */
const REMITTANCE_VIEWS = Object.freeze(['attention', 'parked', 'set_aside', 'all']);

/**
 * The CURRENT set-aside vocabulary.
 *
 * It lives on the migration that last widened it, not on the one that created
 * the column: `1787500000000` exports the five it wrote and must go on doing so,
 * because a database migrated only that far holds a five-value CHECK. Stage C
 * added `sent_in_error` and this is where the six now live.
 *
 * @see migrations-tenant/1787800000000_rcm_set_aside_sent_in_error.js
 */
const {
  SET_ASIDE_REASONS,
} = require('../../migrations-tenant/1787800000000_rcm_set_aside_sent_in_error');

/**
 * The shadow-mode comparison's two vocabularies (Stage C-2).
 *
 * Same contract as `SET_ASIDE_REASONS` above: they live on the migration that
 * wrote the CHECK, so a database migrated only that far and this route can never
 * disagree about what is storable.
 *
 * @see migrations-tenant/1787900000000_rcm_shadow_comparison.js
 */
const {
  COMPARISON_VERDICTS,
  COMPARISON_REASONS,
} = require('../../migrations-tenant/1787900000000_rcm_shadow_comparison');

/**
 * How long a biller's own sentence may be, on either action.
 *
 * Deliberately SHORTER than a review note's 2000 (`claims.js MAX_REVIEW_NOTE`).
 * A review note is the record of a decision about a claim and may need to argue;
 * these two are a line on a card — "waiting on the carrier to resend" — read at
 * a glance among several. A column with no bound is one somebody eventually
 * pastes a chart into, and a card that can hold a chart is a card nobody reads.
 */
const MAX_WORKLIST_NOTE = 500;

/**
 * How many patient names a Checks ROW may carry. See BATCH_COLUMNS' header for
 * why the list carries any at all.
 *
 * Two, and the cap is applied HERE rather than in the browser. A row is one
 * line of a scannable list; three names wrap it and the list stops scanning.
 * More to the point, a client-side cap is not a budget — the whole check would
 * still have crossed the wire.
 */
const LIST_PATIENT_NAMES = 2;

/**
 * Batch columns the list and detail read. Named explicitly (no SELECT * in this
 * repo), and the list doubles as the response's PHI budget — a payment batch
 * carries no patient data itself, which is why the batch list is cheap and the
 * claim list under it is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUDGET WAS WIDENED ON PURPOSE — Stage C-3b, item 1
 * ─────────────────────────────────────────────────────────────────────────────
 * The sentence above is no longer the whole truth, and the change was a
 * decision rather than a leak. The batch list now ships **at most two patient
 * names per check**, in `toBatchWire`'s `patientNames`.
 *
 * WHY. A Checks row said "DELTA DENTAL OF ARKANSAS · 830200001 · 9 claims" and
 * nothing else, so the one question a biller actually arrives with — *is my
 * patient on this check?* — could only be answered by opening every row in
 * turn. Nine opened checks to find one name is nine audited PHI reads of a
 * whole claim list; two names on the row is one.
 *
 * WHAT DID NOT CHANGE. No new column here, no new statement, and **no Open
 * Dental read**: the names come off `claimsByBatch`, the join the list already
 * runs for `balance` and the attention counts. The cap is enforced SERVER-SIDE
 * (`LIST_PATIENT_NAMES`) — shipping every name and letting the browser show two
 * would widen the budget by the whole check while pretending not to. Date of
 * birth and subscriber id stay out, on the reasoning in `CLAIM_DETAIL_COLUMNS`.
 *
 * The list read is already audited as a PHI read (`auditRcmRead` below), which
 * was true before this and is what makes the widening recordable rather than
 * merely small.
 */
const BATCH_COLUMNS = [
  'batch_id',
  'office_id',
  'payer',
  'check_number',
  'eft_number',
  'trace_number',
  'payment_method',
  'deposit_date',
  'total_amount_cents',
  'posted_amount_cents',
  'plb_total_cents',
  'plb_adjustments',
  'claim_count',
  'status',
  'era_file_key',
  /*
   * Slice 5.5's structured remittance flags. Selected here because Slice 6a
   * shipped without them and the detail screen could only say "Held — something
   * on this remittance was flagged" — the same sin one level up that Slice 6a
   * fixed at claim level. A whole-check takeback deserves to be named.
   */
  'flags',
  /*
   * Slice 6b. WHETHER SOMEBODY HAS PRESSED APPROVE, whatever came of it — the
   * fact that turns "this claim is not ready" into "this claim was withheld".
   * See attentionFor.
   */
  'approval_attempted_at',
  'approval_attempted_by',
  'notes',
  /*
   * THE TWO WAYS A CHECK LEAVES TODAY'S LIST (1787500000000).
   *
   * `parked_*` is a biller's note to herself — still work, still counted, and
   * the whole of what "where did I leave off" reads. `set_aside_*` is the
   * opposite: a check nobody is coming back to, out of the attention counts and
   * findable only under its own filter.
   *
   * Both are selected on the LIST as well as the detail, because both change
   * what a row says about itself rather than merely how it is filtered.
   */
  'parked_at',
  'parked_by',
  'parked_note',
  'set_aside_at',
  'set_aside_by',
  'set_aside_reason',
  'set_aside_reason_note',
  /*
   * DID THE APP GET THIS CHECK RIGHT? (1787900000000, Stage C-2).
   *
   * The shadow-mode comparison. Selected on the DETAIL and on the list, for the
   * same reason both worklist states are: it changes what a row says about
   * itself — a check somebody has already answered must not go on asking.
   *
   * `comparison_note` is PHI-capable and ships only on the detail's own wire,
   * to the person who wrote it; nothing in the list rendering reads it.
   */
  'comparison_verdict',
  'comparison_reason',
  'comparison_note',
  'comparison_by',
  'comparison_at',
  'comparison_revision',
  'created_by',
  'created_at',
].join(', ');

/** @param {unknown} raw @param {number} fallback @param {number} max */
function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * Does this batch still owe a human an ACTION?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OBLIGATIONS, NOT FACTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this counted four things and needed attention if any of
 * them held: the batch was not `ready`, some claim carried a review reason,
 * some claim was not `confirmed`, some claim was not reviewed. Three of those
 * are PERMANENT FACTS ABOUT THE FILE that no action available in this slice can
 * change.
 *
 * A biller on staging did everything the screen lets her do — ran the match on
 * both claims (honest `no_candidate`; the fixture PatNums do not exist in that
 * database), read the flags, marked both claims reviewed with a note — and the
 * batch stayed in the needs-attention view. It stayed because Slice 5 held the
 * batch `open` over a downcode and an unreadable CAS (correct, and it stays
 * open until posting exists), because the claims carry their review reasons
 * forever, and because `no_candidate` is not `confirmed`. Reviewing cleared
 * exactly one of four reasons, so the review action was a no-op against the
 * filter and the list was not a worklist at all — it was "not yet posted".
 *
 * Telling somebody who has finished that they still owe something is the
 * honest-states rule failing by crying wolf, which costs the same thing every
 * false alarm costs: the true ones stop being read.
 *
 * So: **needs attention means a human still owes an action.** A claim is
 * DISPOSITIONED when a human marked it reviewed. What they saw — flags, no
 * candidate, ambiguity — stays visible as an observation and is recorded in
 * their note; that is evidence of work done, not an outstanding obligation.
 *
 * `observations` ride alongside so the screen still says WHY a remittance was
 * worth looking at.
 *
 * NO AUTO-REVIEW. A claim with no flags, matched and confirmed, still owes an
 * explicit disposition: a biller marking "looked, nothing to do" is real work
 * and the audit row is what proves it happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SLICE 6b'S OBLIGATIONS, ADDED WITHOUT WIDENING THE FILTER BY ACCIDENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Approval is the first ACTION this module has that a fact can be waiting on,
 * so it is the first thing since `claims_unreviewed` that earns a place in
 * `reasons`. Three of them, and the division is the same one D-12 settled:
 *
 *   claims_awaiting_approval  an APPROVER owes an action — the work is done and
 *                             somebody with posting permission has not pressed
 *                             the button.
 *   claims_withheld           an approve RAN and left a claim out. SOMEBODY owes
 *                             a fix, or a manual disposition. It can only fire
 *                             after somebody has actually pressed the button,
 *                             which is what keeps it from crying wolf at a
 *                             biller who has finished everything the screen
 *                             lets her do.
 *
 *                             "Ran" means ATTEMPTED, not "produced a queue row".
 *                             The first version keyed on the queue existing, and
 *                             a wholly-refused approve rolls back — so pressing
 *                             Approve, being told "nothing here can be posted
 *                             and here is why", and going back to the list made
 *                             the remittance VANISH from the default view. The
 *                             same crying-wolf rule, failing the other way:
 *                             silence at the exact moment somebody was told they
 *                             owed work. `approval_attempted_at` is the stamp
 *                             that survives the rollback.
 *   claims_queued             an OBSERVATION. The system owes the next step and
 *                             no human does; it becomes an obligation again only
 *                             when 6c fails a row and has somewhere to say so.
 *
 * Which of the two obligations a claim produces is decided by
 * `approvalGate.looksApprovable`, the cheap necessary subset of the gate — see
 * its header for why the list is allowed to be imprecise between two
 * obligations and never about whether one exists.
 *
 * @param {{ status: string, flags?: string[] }} batch
 * @param {ReadonlyArray<{ needsReviewReasons: string[], odMatchStatus: string,
 *                         reviewedAt: string|null, postingQueueId: string|null }>} claims
 * @param {{ hasQueue?: boolean, attempted?: boolean }} [approval] whether an
 *   approval has been ATTEMPTED on this remittance (or produced a plan) — the
 *   fact that turns "not ready yet" into "withheld"
 * @returns {{ needsAttention: boolean, reasons: string[], observations: string[] }}
 */
function attentionFor(batch, claims, approval = {}) {
  /** Outstanding ACTIONS. These, and only these, decide `needsAttention`. */
  const reasons = [];
  /** FACTS worth showing. They never make a remittance need attention. */
  const observations = [];

  /*
   * ── SET ASIDE SHORT-CIRCUITS, AND IT IS THE ONLY THING HERE THAT DOES ─────
   *
   * A person has said, on the record and with a reason, that nobody is coming
   * back to this check. That is a DISPOSITION, exactly like marking a claim
   * reviewed, and it is the only disposition available for the case §15.2
   * finding 5 describes: a remittance whose claims an unwind deleted is matched,
   * reviewed and permanently unapprovable, so every other predicate below keeps
   * finding real outstanding work on it forever.
   *
   * Returning EARLY rather than filtering the result is deliberate. The reasons
   * a set-aside check would otherwise carry are not facts worth showing beside
   * it — they are the obligations a human has explicitly discharged, and
   * printing them under a "Set aside" heading would re-raise the alarm the
   * action exists to silence. `set_aside` is the one observation, so a screen
   * can still say WHY the row is quiet.
   *
   * It never hides money: `set_aside_at` is a stamp on the remittance and
   * touches no plan, no claim and no chart. A set-aside check with a posting
   * plan still appears on the Posting page exactly as before — this is about
   * one worklist, not about the record.
   */
  if (batch.setAside) {
    return { needsAttention: false, reasons: [], observations: ['set_aside'] };
  }

  // ── The obligations ───────────────────────────────────────────────────────

  const unreviewed = claims.filter((c) => !c.reviewedAt).length;
  if (unreviewed) reasons.push('claims_unreviewed');

  /*
   * A batch with NO claims is not finished, it is unworkable.
   *
   * "Every claim is reviewed" is vacuously true of an empty list, so without
   * this an 835 that produced a payment batch and no claim rows — a parse
   * problem, or a check naming payments whose claims were never created —
   * would read as done the moment it landed. That is the same failure as the
   * one above, pointing the other way: silence where somebody should look.
   * It cannot be dispositioned by reviewing claims, so it is its own reason.
   */
  if (claims.length === 0) reasons.push('batch_no_claims');

  /*
   * THE APPROVAL OBLIGATIONS — only once every claim has been dispositioned.
   *
   * Guarded on `unreviewed === 0` on purpose: while a claim is still unreviewed
   * the outstanding action is the review, and stacking "and also approve it"
   * beside it would put two chips on one row for one piece of work. The queue
   * shows the NEXT thing owed, not every thing eventually owed.
   */
  const batchFlags = Array.isArray(batch.flags) ? batch.flags : [];
  const unqueued = claims.filter((c) => !c.postingQueueId);
  if (unreviewed === 0 && claims.length > 0) {
    if (unqueued.some((c) => approvalGate.looksApprovable(c, batchFlags))) {
      reasons.push('claims_awaiting_approval');
    }
    /*
     * A claim is WITHHELD, rather than merely not ready, once an approval has
     * actually been RUN on this remittance and left it out. Before that there is
     * nothing to be withheld from: an unapprovable claim that a biller has
     * reviewed with "the carrier owes a corrected EOB" is finished work, and
     * calling it an obligation is exactly the false alarm this predicate was
     * rewritten to stop raising.
     *
     * `attempted` OR `hasQueue`, not just the queue: a wholly-refused approve
     * writes no plan, and keying on the plan alone dropped the remittance out of
     * the view in the same breath as telling its owner it needed work.
     */
    const approvalRan = approval.attempted === true || approval.hasQueue === true;
    if (approvalRan && unqueued.some((c) => !approvalGate.looksApprovable(c, batchFlags))) {
      reasons.push('claims_withheld');
    }
  }

  /*
   * ── SLICE 6c: THE LINE 6b SAID WOULD HAVE TO CHANGE ───────────────────────
   *
   * 6b's note here read: *"until 6c ships, 'queued for posting' means a person
   * authorised it and NOTHING HAS BEEN WRITTEN TO OPEN DENTAL. That is exactly
   * true, and it stops being true the day the drain lands — at which point this
   * is the line that has to change with it."* This is that change.
   *
   * One plan, three different things to say, and only one of them is work:
   *
   *   posting_failed  an OBLIGATION. A drain ran and the plan did not finish —
   *                   `failed`, `partially_posted` or `blocked`. Somebody owes an
   *                   action: fix what blocked it, or look at what half-posted.
   *                   `partially_posted` in particular MUST reach this view:
   *                   money moved and a check may not exist, which is the §8
   *                   window and the single most expensive state in the module
   *                   to leave sitting quietly on a list nobody opens.
   *   claims_posted   an OBSERVATION. Finished. The money is on the chart and the
   *                   read-back proved it.
   *   claims_queued   an OBSERVATION, unchanged in meaning: approved, waiting,
   *                   and nothing has been written to Open Dental.
   *
   * Read from the PLAN's status rather than from the claim's link, because the
   * claim link only says "a plan took this claim" and every one of the three
   * cases above satisfies that equally.
   */
  const planStatuses = Array.isArray(approval.queueStatuses) ? approval.queueStatuses : [];
  const anyClaimQueued = claims.some((c) => c.postingQueueId);

  if (planStatuses.some((s) => s === 'failed' || s === 'partially_posted' || s === 'blocked')) {
    reasons.push('posting_failed');
  }
  // ── The observations ──────────────────────────────────────────────────────

  if (anyClaimQueued || planStatuses.length > 0) {
    // `every`, not `some`: a remittance with one posted plan and one still
    // waiting is not finished, and calling it posted would retire it from view
    // with work outstanding.
    if (planStatuses.length > 0 && planStatuses.every((s) => s === 'posted')) {
      observations.push('claims_posted');
    } else if (!planStatuses.some((s) => s === 'failed' || s === 'partially_posted' || s === 'blocked')) {
      observations.push('claims_queued');
    }
  }

  // Slice 5's contract: a batch is held `open` when ANYTHING on it was flagged
  // — a reversal, a PLB, a downcode, an unreadable adjustment, a total that
  // does not reconcile. Nearly every real 835 carries one of those, so on its
  // own it can never be the thing that holds a remittance in the queue: if it
  // were, nothing would ever leave. `ready` means "a person could act on this
  // now", and posting is what will move it — in 6b.
  if (batch.status !== 'ready' && batch.status !== 'posted') {
    observations.push(`batch_${batch.status}`);
  }

  const flagged = claims.filter((c) => c.needsReviewReasons.length > 0).length;
  if (flagged) observations.push('claims_flagged');

  // `no_candidate` is a finished search with a real, negative answer. It is not
  // an unfinished task, and there is no action in this slice that turns it into
  // `confirmed` when Open Dental genuinely has no such claim.
  const unmatched = claims.filter((c) => c.odMatchStatus !== 'confirmed').length;
  if (unmatched) observations.push('claims_unmatched');

  return { needsAttention: reasons.length > 0, reasons, observations };
}

/**
 * The patients this check names — the first two, and how many more there are.
 *
 * DISTINCT names, in `position` order off the 835. A check that pays two claims
 * for the same person would otherwise print them twice, which reads as a bug
 * rather than as a fact; and `more` counts PEOPLE, so it is not `claimCount`
 * minus two and must never be rendered as though it were. `claimCount` is the
 * batch's own column and is shipped separately, unchanged.
 *
 * `shown` empty with `more: 0` means this check named no claim rows we can
 * resolve — an honest "nothing to show", never "no patients".
 *
 * @param {ReadonlyArray<{ patientName: string }>} claims in position order
 * @returns {{ shown: string[], more: number }}
 */
function patientNamesFor(claims) {
  /** @type {string[]} */
  const distinct = [];
  for (const c of claims) {
    const name = typeof c.patientName === 'string' ? c.patientName.trim() : '';
    if (name && !distinct.includes(name)) distinct.push(name);
  }
  return {
    shown: distinct.slice(0, LIST_PATIENT_NAMES),
    more: Math.max(0, distinct.length - LIST_PATIENT_NAMES),
  };
}

/** Map a batch row + its claims to the list/detail wire shape. */
function toBatchWire(batch, claims, source, actors, approval = {}, decided = null) {
  const batchFlags = Array.isArray(batch.flags) ? batch.flags : [];
  const attention = attentionFor(
    { status: batch.status, flags: batchFlags, setAside: batch.set_aside_at != null },
    claims,
    {
      ...approval,
      attempted: batch.approval_attempted_at != null,
    }
  );
  const claimTotalCents = claims.reduce((sum, c) => sum + c.totalPaidCents, 0);
  const createdBy = batch.created_by ? actors[batch.created_by] : null;

  return {
    batchId: batch.batch_id,
    officeId: batch.office_id,
    payer: batch.payer,
    checkNumber: batch.check_number || null,
    eftNumber: batch.eft_number || null,
    traceNumber: batch.trace_number || null,
    paymentMethod: batch.payment_method || null,
    depositDate: isoDate(batch.deposit_date),
    totalAmountCents: num(batch.total_amount_cents),
    postedAmountCents: num(batch.posted_amount_cents),
    plbTotalCents: num(batch.plb_total_cents),
    claimCount: num(batch.claim_count),
    /**
     * WHO IS ON THIS CHECK — at most two names, plus how many more people.
     *
     * PHI, deliberately and within a widened budget: see BATCH_COLUMNS. The
     * count is of PEOPLE, not of the claims left over, so a screen must not
     * render it against `claimCount`.
     */
    patientNames: patientNamesFor(claims),
    status: batch.status,
    /** '835' when an ERA produced it, 'eob' when a PDF extraction did. */
    source,
    /**
     * Slice 5.5's remittance-level facts, as a vocabulary rather than as prose.
     * The workbench colours them by the D-11 split: a blocking flag is amber
     * because it will withhold every claim on this check, an annotating one is
     * grey. Both are always shown.
     */
    flags: batchFlags,
    notes: batch.notes || '',
    createdAt: iso(batch.created_at),
    createdBy: createdBy ? createdBy.displayName : null,

    /**
     * THE BALANCE CHECK, computed rather than stored.
     *
     * `balanced` is the batch's own total against the sum of what its claims
     * were paid. They should agree; when they do not, the difference is the
     * number a biller chases, so it is returned rather than a boolean alone.
     * A PLB moves money at the provider level rather than on any claim, so it
     * is a legitimate reason for the two to differ and is surfaced beside it.
     */
    balance: {
      batchTotalCents: num(batch.total_amount_cents),
      claimTotalCents,
      differenceCents: num(batch.total_amount_cents) - claimTotalCents,
      plbTotalCents: num(batch.plb_total_cents),
      balanced: num(batch.total_amount_cents) - claimTotalCents - num(batch.plb_total_cents) === 0,
    },

    needsAttention: attention.needsAttention,
    /** Outstanding ACTIONS — the ones that put this row in the queue. */
    attentionReasons: attention.reasons,
    /** FACTS worth reading. Shown, but never a reason to hold a remittance. */
    attentionObservations: attention.observations,
    reviewReasonCount: claims.reduce((n, c) => n + c.needsReviewReasons.length, 0),
    unmatchedClaimCount: claims.filter((c) => c.odMatchStatus !== 'confirmed').length,
    /** How many claims a human has approved into a posting plan. */
    queuedClaimCount: claims.filter((c) => c.postingQueueId).length,
    /**
     * When somebody last pressed Approve, whatever came of it. Null means
     * nobody has — which is why a claim that cannot be posted is "not ready"
     * rather than "withheld".
     */
    approvalAttemptedAt: iso(batch.approval_attempted_at),
    approvalAttemptedBy: batch.approval_attempted_by
      ? (actors[batch.approval_attempted_by] || {}).displayName || batch.approval_attempted_by
      : null,

    /**
     * SAVED FOR TOMORROW — a biller's note to herself, and the whole of what
     * Today's "where you left off" card reads.
     *
     * `parkedBy` is a display name rather than a key because the card names the
     * person; it falls back to the raw key rather than to "somebody", since an
     * un-crosswalked actor is a fact worth seeing rather than one worth hiding.
     * Null throughout means NOT PARKED — never "parked by nobody".
     */
    parkedAt: iso(batch.parked_at),
    parkedBy: batch.parked_by
      ? (actors[batch.parked_by] || {}).displayName || batch.parked_by
      : null,
    /** Her own sentence. Optional by design; PHI-capable, so never audited. */
    parkedNote: batch.parked_note || null,

    /**
     * SET ASIDE — out of the attention counts, and saying so out loud.
     *
     * `setAsideReason` is the SLUG the client renders copy from, on the same
     * contract `blockedReason` and `withdrawnReason` have. The note is the
     * person's own words and is required by the route only when the slug is
     * `other`.
     */
    setAsideAt: iso(batch.set_aside_at),
    setAsideBy: batch.set_aside_by
      ? (actors[batch.set_aside_by] || {}).displayName || batch.set_aside_by
      : null,
    setAsideReason: batch.set_aside_reason || null,
    setAsideNote: batch.set_aside_reason_note || null,

    /**
     * DID THE APP GET THIS CHECK RIGHT? — the shadow-mode comparison (C-2).
     *
     * `comparisonVerdict` null means NOBODY HAS ANSWERED, never "no difference
     * found": the screen renders the ask, not a result. `comparisonReason` is
     * the SLUG the client renders copy from, on the same contract
     * `setAsideReason` has, and the note is the biller's own words.
     *
     * `comparisonRevision` is how many times this check has been answered. It is
     * what lets the screen say "you changed this" rather than pretending the
     * newest answer was the only one — an answer is changeable until the check
     * posts, and a change that left no trace would be a silent overwrite.
     */
    comparisonVerdict: batch.comparison_verdict || null,
    comparisonReason: batch.comparison_reason || null,
    comparisonNote: batch.comparison_note || null,
    comparisonAt: iso(batch.comparison_at),
    comparisonBy: batch.comparison_by
      ? (actors[batch.comparison_by] || {}).displayName || batch.comparison_by
      : null,
    comparisonRevision: num(batch.comparison_revision),

    /**
     * WHEN SOMEBODY LAST DECIDED A WRITE-OFF HERE — §15.2's finding 9 (Stage B).
     *
     * The per-user touch stamp "where you left off" never had. Parking and
     * pressing Approve are the two facts it worked from, and neither is what a
     * biller means by leaving off: that is the check she was reading when the
     * phone rang, which she neither parked nor tried to approve.
     *
     * Null throughout means nobody has decided anything on this check — NOT
     * "decided by nobody". The name falls back to the raw crosswalk key rather
     * than to "somebody", on the same contract `parkedBy` has: an un-crosswalked
     * actor is a fact worth seeing.
     */
    lastDecidedAt: iso(decided ? decided.at : null),
    lastDecidedBy: decided && decided.byKey
      ? (actors[decided.byKey] || {}).displayName || decided.byKey
      : null,
  };
}

/**
 * WHEN SOMEBODY LAST DECIDED A WRITE-OFF ON THIS CHECK, AND WHO — §15.2's ninth
 * finding, closed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING
 * ─────────────────────────────────────────────────────────────────────────────
 * Today's "where you left off" card had two attributable facts to work from:
 * a check somebody PARKED, and a check somebody pressed Approve on. Both are
 * real, and neither is what a biller means by "where I left off" on a Tuesday
 * afternoon — that is the check she was reading when the phone rang, which she
 * neither parked nor tried to approve.
 *
 * Stage B gives it one. A write-off decision is a per-user, per-instant act on a
 * specific check, recorded because it has to be recorded anyway. There is no new
 * state and no new endpoint: this widens a read the list already makes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO STATEMENTS, NOT A JOIN — the same discipline `readProvenance` follows
 * ─────────────────────────────────────────────────────────────────────────────
 * `office_id` is a column on the batch links, on the claims AND on the lines.
 * A join written on ids alone would be a cross-office read waiting for a uuid
 * collision, and scoping every leg of a three-table join is the kind of thing
 * that is right the day it is written and wrong the day somebody edits it.
 *
 * So: the page's claim ids out of the links, then the decided lines for those
 * claims, both office-scoped in their own WHERE, and the reduction in JS. Two
 * round trips for a whole page, not per row.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @param {ReadonlyArray<string>} batchIds
 * @returns {Promise<Map<string, { at: Date, byKey: string|null }>>}
 */
async function lastDecidedByBatch(pool, office, batchIds) {
  if (batchIds.length === 0) return new Map();

  const links = await pool.query(
    `SELECT batch_id, claim_id FROM rcm_batch_claim_payments ` +
      `WHERE office_id = $1 AND batch_id = ANY($2::uuid[])`,
    [office, batchIds]
  );
  /** @type {Map<string, string>} claim → the batch it arrived on */
  const batchOfClaim = new Map();
  for (const row of links.rows) {
    if (row.claim_id) batchOfClaim.set(String(row.claim_id), String(row.batch_id));
  }
  if (batchOfClaim.size === 0) return new Map();

  const lines = await pool.query(
    `SELECT claim_id, decided_at, decided_by FROM rcm_procedure_lines ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[]) AND decided_at IS NOT NULL`,
    [office, [...batchOfClaim.keys()]]
  );

  /** @type {Map<string, { at: Date, byKey: string|null }>} */
  const out = new Map();
  for (const row of lines.rows) {
    const batchId = batchOfClaim.get(String(row.claim_id));
    if (!batchId || row.decided_at == null) continue;
    const current = out.get(batchId);
    // NEWEST WINS. "Where you left off" is about the last time she touched it,
    // so an older decision on the same check must not overwrite a newer one.
    if (!current || Date.parse(row.decided_at) > Date.parse(current.at)) {
      out.set(batchId, {
        at: row.decided_at,
        byKey: row.decided_by == null ? null : String(row.decided_by),
      });
    }
  }
  return out;
}

/**
 * Which of these batches already carry a posting plan.
 *
 * ONE query for a whole page. It is what tells `attentionFor` the difference
 * between "not approvable yet" and "an approve ran and left this out" — and the
 * only thing 6b's list needs to know about the queue. The plan's CONTENTS are
 * never read here: a list has no use for them, and one of them is a per-line
 * record of money about to move.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @param {ReadonlyArray<string>} batchIds
 * @returns {Promise<Set<string>>}
 */
async function batchesWithQueue(pool, office, batchIds) {
  if (batchIds.length === 0) return new Map();
  /*
   * Slice 6c: the STATUS comes back too, not merely the existence.
   *
   * A plan's CONTENTS are still never read here — a list has no use for a
   * per-line record of money about to move. But "a plan exists" stopped being
   * enough the day the drain shipped: a plan that POSTED is finished work, and a
   * plan that FAILED is an action somebody owes. Both used to render as the same
   * grey "Queued for posting" chip, which is the honest-states rule failing on
   * the one screen a biller uses to decide what to do next.
   */
  /*
   * THE PLAN'S ID COMES BACK TOO, and it is the whole of what lets a check be
   * posted from its own page.
   *
   * `POST /posting/drain` has taken an optional `queueId` since 6c — the
   * narrowing is one extra `AND queue_id = $3` on the same office-scoped,
   * same-status-filtered query, so a request cannot name its way into anything
   * the office-wide run would not have drained. What was missing was any way for
   * the remittance screen to KNOW that id: it could see that a plan existed and
   * what state it was in, and nothing else. So the Post button lived on one page
   * and the check lived on another.
   *
   * A plan id is not PHI and not money. The plan's CONTENTS are still never read
   * here — a list has no use for a per-line record of money about to move.
   */
  const rows = await pool.query(
    `SELECT batch_id, queue_id, status FROM rcm_posting_queue ` +
      `WHERE office_id = $1 AND batch_id = ANY($2::uuid[]) ORDER BY approved_at ASC`,
    [office, batchIds]
  );
  /** @type {Map<string, Array<{ queueId: string, status: string }>>} */
  const byBatch = new Map();
  for (const row of rows.rows) {
    const key = String(row.batch_id);
    if (!byBatch.has(key)) byBatch.set(key, []);
    byBatch.get(key).push({ queueId: String(row.queue_id), status: String(row.status) });
  }
  return byBatch;
}

/**
 * The statuses alone, for the callers that only ever wanted those.
 *
 * `attentionFor` takes `queueStatuses` and always has. Keeping that signature
 * rather than teaching the predicate about plan ids means the shape change above
 * cannot alter a single attention answer — which is the property the list's two
 * counts depend on.
 *
 * @param {ReadonlyArray<{ status: string }>|undefined} plans
 * @returns {string[]}
 */
function statusesOf(plans) {
  return Array.isArray(plans) ? plans.map((p) => p.status) : [];
}

/**
 * Load the claims belonging to a set of batches, via the join table.
 *
 * Two statements rather than a JOIN, matching the module's existing style: the
 * link rows carry the batch↔claim relationship and the claim rows carry
 * everything else. `claim_id` is nullable on a link (a batch can name a payment
 * whose claim row was never created), so the nulls are dropped before the
 * second read rather than producing a `= ANY(NULL)`.
 *
 * @returns {Promise<Map<string, any[]>>} batch_id → claim summaries
 */
async function claimsByBatch(pool, office, batchIds) {
  if (batchIds.length === 0) return new Map();

  const links = await pool.query(
    `SELECT batch_id, claim_id, position FROM rcm_batch_claim_payments ` +
      `WHERE office_id = $1 AND batch_id = ANY($2::uuid[]) ORDER BY position ASC`,
    [office, batchIds]
  );

  const claimIds = [...new Set(links.rows.map((r) => r.claim_id).filter(Boolean))];
  if (claimIds.length === 0) return new Map();

  const claims = await pool.query(
    `SELECT ${CLAIM_LIST_COLUMNS} FROM rcm_claims ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[])`,
    [office, claimIds]
  );
  const byId = new Map(claims.rows.map((r) => [r.claim_id, r]));

  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const link of links.rows) {
    const row = link.claim_id ? byId.get(link.claim_id) : null;
    if (!row) continue;
    if (!out.has(link.batch_id)) out.set(link.batch_id, []);
    out.get(link.batch_id).push(toClaimSummary(row));
  }
  return out;
}

/**
 * Which uploads produced these batches, so the list can say whether a
 * remittance came from a machine-readable 835 or from a model reading a PDF.
 *
 * That distinction is not cosmetic. An 835 is PARSED and can only be malformed;
 * an EOB PDF is READ by a model and can be WRONG. A biller deciding how hard to
 * scrutinise a line needs to know which they are looking at.
 *
 * AND, for an EOB, HOW the model got the text it read: a text layer, or OCR
 * over page images. That is a second distinction on top of the first and it
 * matters for the same reason — an 835 can only be malformed, a text-layer PDF
 * can be mis-READ, and a scan can be mis-SEEN before it is ever mis-read. The
 * biller deciding how hard to scrutinise a $4,000 check should be told which.
 *
 * @returns {Promise<Map<string, { source: '835'|'eob', uploadId: string, filename: string,
 *                                 uploadedAt: string|null, uploadedBy: string|null,
 *                                 textSource: string|null, ocrPageCount: number|null,
 *                                 ocrMeanConfidence: number|null }>>}
 */
async function uploadsByBatch(pool, office, batches) {
  /** @type {Map<string, any>} */
  const out = new Map();
  if (batches.length === 0) return out;

  const eraKeys = batches.map((b) => b.era_file_key).filter(Boolean);
  const batchIds = batches.map((b) => b.batch_id);

  const [byKey, byResult] = await Promise.all([
    eraKeys.length
      ? pool.query(
          `SELECT upload_id, filename, file_key, uploaded_at, uploaded_by, ` +
            `text_source, ocr_page_count, ocr_mean_confidence FROM rcm_eob_uploads ` +
            `WHERE office_id = $1 AND file_key = ANY($2::text[])`,
          [office, eraKeys]
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT upload_id, filename, result_batch_id, uploaded_at, uploaded_by, ` +
        `text_source, ocr_page_count, ocr_mean_confidence FROM rcm_eob_uploads ` +
        `WHERE office_id = $1 AND result_batch_id = ANY($2::uuid[])`,
      [office, batchIds]
    ),
  ]);

  const uploadByKey = new Map(byKey.rows.map((r) => [r.file_key, r]));
  for (const batch of batches) {
    const era = batch.era_file_key ? uploadByKey.get(batch.era_file_key) : null;
    const eob = era ? null : byResult.rows.find((r) => r.result_batch_id === batch.batch_id);
    const upload = era || eob;
    if (!upload) continue;
    out.set(batch.batch_id, {
      source: era ? '835' : 'eob',
      uploadId: upload.upload_id,
      filename: upload.filename,
      uploadedAt: iso(upload.uploaded_at),
      uploadedByKey: upload.uploaded_by || null,
      // null on an 835 (nothing was READ — the file was parsed) and on any
      // document not yet extracted. The screen renders those two the same way:
      // it says nothing, rather than guessing.
      textSource: upload.text_source || null,
      ocrPageCount: upload.ocr_page_count == null ? null : num(upload.ocr_page_count),
      ocrMeanConfidence:
        upload.ocr_mean_confidence == null ? null : Number(upload.ocr_mean_confidence),
    });
  }
  return out;
}

/**
 * The narrow claim scan the LIST predicate runs on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WHOLE OFFICE, AND WHY THESE COLUMNS AND NO OTHERS
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 6a computed `needsAttentionCount` over the PAGE while `total` counted
 * the office, so the header could truthfully read "12 needing attention · 640
 * total" about two different populations — and a remittance needing attention
 * and older than the hundredth newest was invisible AND uncounted, on a screen
 * whose stated premise is that the default is the work.
 *
 * The predicate is not expressible in SQL: it reads `needs_review_reasons`
 * through the D-11 gate map, which lives in `rcmVocabulary.js` and must have
 * exactly one home — mirroring it into a WHERE clause would create the second
 * source of truth that whole file exists to prevent. So the scan runs in JS,
 * over the office, on the SIX columns the predicate actually reads.
 *
 * NO PHI. No patient name, no subscriber id, no amount. The expensive claim
 * summaries are loaded only for the page that is about to be rendered.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @returns {Promise<Map<string, Array<object>>>} batch_id → predicate rows
 */
async function attentionScan(pool, office) {
  const links = await pool.query(
    `SELECT batch_id, claim_id FROM rcm_batch_claim_payments WHERE office_id = $1`,
    [office]
  );
  const claimIds = [...new Set(links.rows.map((r) => r.claim_id).filter(Boolean))];
  /** @type {Map<string, Array<object>>} */
  const out = new Map();
  if (claimIds.length === 0) return out;

  const claims = await pool.query(
    `SELECT claim_id, reviewed_at, od_match_status, needs_review_reasons, posting_queue_id ` +
      `FROM rcm_claims WHERE office_id = $1 AND claim_id = ANY($2::uuid[])`,
    [office, claimIds]
  );
  const byId = new Map(
    claims.rows.map((r) => [
      r.claim_id,
      {
        reviewedAt: iso(r.reviewed_at),
        odMatchStatus: r.od_match_status || 'not_run',
        needsReviewReasons: Array.isArray(r.needs_review_reasons) ? r.needs_review_reasons : [],
        postingQueueId: r.posting_queue_id || null,
      },
    ])
  );

  for (const link of links.rows) {
    const row = link.claim_id ? byId.get(link.claim_id) : null;
    if (!row) continue;
    if (!out.has(link.batch_id)) out.set(link.batch_id, []);
    out.get(link.batch_id).push(row);
  }
  return out;
}


/**
 * The one 404 this router serves, so every path answers a probe identically.
 *
 * Audited, because walking ids must not be a silent activity — and this covers
 * "belongs to the other office" too, since `office_id` is in every WHERE.
 * Best-effort (see auditRcmDenial): turning a refusal into a 500 because the
 * trail could not be written would hand a prober a way to tell "no such id"
 * from "audit is down".
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} office
 * @param {string} batchId
 */
async function notFound(req, res, office, batchId) {
  await auditRcmDenial(req, 'rcm_remittance', isUuid(batchId) ? batchId : null, { office });
  return res.status(404).json({
    success: false,
    error: 'No such remittance for this office',
    code: 'REMITTANCE_NOT_FOUND',
  });
}

// ─── GET / — the remittance list ─────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    /*
     * THE VIEW IS APPLIED SERVER-SIDE, BUT ITS DEFAULT IS `all`.
     *
     * Slice 6a filtered in the browser, over a 100-row page, while the header
     * counted the whole office — so "12 needing attention · 640 total" was two
     * statements about two different populations, and a remittance needing
     * attention and older than the hundredth newest was invisible AND uncounted.
     * The filter and both counts now run here, over everything.
     *
     * The DEFAULT stays `all` even though the workbench opens on
     * "Needs attention": a list endpoint that silently hides most of the list is
     * a trap for the next caller. The screen asks for the view it wants; the
     * counts come back for both either way. An unrecognised value falls back to
     * the default rather than 400ing — refusing a whole list over a typo in a
     * display preference is the worse failure.
     */
    const view = REMITTANCE_VIEWS.includes(req.query.view) ? String(req.query.view) : 'all';

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      // Every batch for the office, but only the columns the predicate and the
      // ordering need. The full BATCH_COLUMNS read happens for the page alone.
      const [all, scan] = await Promise.all([
        pool.query(
          // `set_aside_at` and `parked_at` join the predicate columns because
          // both decide MEMBERSHIP of a view over the whole office, exactly as
          // `approval_attempted_at` does. Reading them on the page alone would
          // put the filter and the counts back on two populations — the Slice 6a
          // defect the whole-office scan exists to prevent.
          `SELECT batch_id, status, flags, approval_attempted_at, set_aside_at, parked_at ` +
            `FROM rcm_payment_batches ` +
            `WHERE office_id = $1 ORDER BY deposit_date DESC NULLS LAST, created_at DESC`,
          [office]
        ),
        attentionScan(pool, office),
      ]);
      const queued = await batchesWithQueue(
        pool,
        office,
        all.rows.map((r) => r.batch_id)
      );

      // The predicate, over the WHOLE population, with the same function the
      // detail screen uses. This is what makes the two counts below true of one
      // set of rows.
      const marked = all.rows.map((row) => ({
        batchId: row.batch_id,
        setAside: row.set_aside_at != null,
        parked: row.parked_at != null,
        needsAttention: attentionFor(
          {
            status: row.status,
            flags: Array.isArray(row.flags) ? row.flags : [],
            setAside: row.set_aside_at != null,
          },
          scan.get(row.batch_id) || [],
          {
            hasQueue: queued.has(row.batch_id),
            // Slice 6c: the plan's own state, so a FAILED drain reaches this
            // view as an obligation instead of resting under the same grey
            // "queued" chip as one that has not started.
            queueStatuses: statusesOf(queued.get(row.batch_id)),
            attempted: row.approval_attempted_at != null,
          }
        ).needsAttention,
      }));

      const attentionCount = marked.filter((m) => m.needsAttention).length;
      /*
       * FOUR VIEWS, AND THE DEFAULT STILL SHOWS EVERYTHING.
       *
       *   attention  what a human still owes an action on. Set-aside rows are
       *              already excluded by the predicate itself, not filtered out
       *              here — one rule, one place.
       *   parked     what somebody put down meaning to come back. Today's
       *              "where you left off" card reads this and nothing else.
       *   set_aside  the checks nobody is coming back to. Its own view because
       *              set-aside is REVERSIBLE, and a state you can undo must have
       *              somewhere you can find it.
       *   all        everything, set-aside included. The default, because a list
       *              endpoint that silently hides rows is a trap for the next
       *              caller — the same reasoning that keeps `all` the default
       *              while the screen opens on "Needs attention".
       *
       * An unrecognised value falls back to `all` rather than 400ing: refusing a
       * whole list over a typo in a display preference is the worse failure.
       */
      const selected =
        view === 'attention'
          ? marked.filter((m) => m.needsAttention)
          : view === 'parked'
            ? marked.filter((m) => m.parked && !m.setAside)
            : view === 'set_aside'
              ? marked.filter((m) => m.setAside)
              : marked;
      const pageIds = selected.slice(offset, offset + limit).map((m) => m.batchId);

      if (pageIds.length === 0) {
        return {
          batches: [],
          claims: new Map(),
          uploads: new Map(),
          decided: new Map(),
          actors: {},
          queued,
          total: marked.length,
          attentionCount,
          parkedCount: marked.filter((m) => m.parked && !m.setAside).length,
          setAsideCount: marked.filter((m) => m.setAside).length,
          matching: selected.length,
        };
      }

      const page = await pool.query(
        `SELECT ${BATCH_COLUMNS} FROM rcm_payment_batches ` +
          `WHERE office_id = $1 AND batch_id = ANY($2::uuid[])`,
        [office, pageIds]
      );
      // The page query loses the ORDER BY (it selects by id set), so the
      // already-ordered id list is what restores it.
      const byId = new Map(page.rows.map((r) => [r.batch_id, r]));
      const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean);

      const [claims, uploads, decided] = await Promise.all([
        claimsByBatch(pool, office, pageIds),
        uploadsByBatch(pool, office, ordered),
        // §15.2 finding 9. One statement for the page, joined to the id set that
        // is already in hand — it costs a round trip, not a round trip per row.
        lastDecidedByBatch(pool, office, pageIds),
      ]);
      const actors = await describeActors(pool, [
        ...ordered.map((b) => b.created_by),
        ...ordered.map((b) => b.approval_attempted_by),
        // The two worklist actors. A parked check names the person who parked
        // it, on the card that exists to tell her where she left off — a row
        // that could only print a crosswalk key would not do that job.
        ...ordered.map((b) => b.parked_by),
        ...ordered.map((b) => b.set_aside_by),
        // …whoever answered the shadow-mode comparison on each check (C-2), on
        // the same argument again: a panel reading "answered by u-7" is a panel
        // that has forgotten who works here.
        ...ordered.map((b) => b.comparison_by),
        // …and whoever last decided a write-off on each check, for the same
        // reason: the card names the person.
        ...[...decided.values()].map((d) => d.byKey),
        ...[...uploads.values()].map((u) => u.uploadedByKey),
      ]);

      return {
        batches: ordered,
        claims,
        uploads,
        decided,
        actors,
        queued,
        total: marked.length,
        attentionCount,
        parkedCount: marked.filter((m) => m.parked && !m.setAside).length,
        setAsideCount: marked.filter((m) => m.setAside).length,
        matching: selected.length,
      };
    });

    // A remittance list names patients one level down, and the batch rows carry
    // payer and check identifiers. PHI leaves the building only after the trail
    // is recorded (hard rule 5).
    await auditRcmRead(req, 'rcm_remittance', { office });

    const remittances = loaded.batches.map((batch) => {
      const claims = loaded.claims.get(batch.batch_id) || [];
      const upload = loaded.uploads.get(batch.batch_id) || null;
      const wire = toBatchWire(
        batch,
        claims,
        upload ? upload.source : null,
        loaded.actors,
        {
          hasQueue: loaded.queued.has(batch.batch_id),
          queueStatuses: statusesOf(loaded.queued.get(batch.batch_id)),
        },
        loaded.decided.get(batch.batch_id) || null
      );
      return {
        ...wire,
        upload: upload
          ? {
              uploadId: upload.uploadId,
              filename: upload.filename,
              uploadedAt: upload.uploadedAt,
              // Null is the honest answer for anything uploaded before D-5
              // landed. The screen says "not recorded", never "system".
              uploadedBy: upload.uploadedByKey
                ? (loaded.actors[upload.uploadedByKey] || {}).displayName || upload.uploadedByKey
                : null,
              textSource: upload.textSource,
              ocrPageCount: upload.ocrPageCount,
              ocrMeanConfidence: upload.ocrMeanConfidence,
            }
          : null,
      };
    });

    return res.json({
      success: true,
      office,
      /** Which population `remittances` was paged out of. */
      view,
      remittances,
      /** Every remittance this office holds — NOT the page, and NOT the filter. */
      total: loaded.total,
      /**
       * How many of that same population need attention. Computed over the
       * whole set with the same predicate, so "12 needing attention · 640
       * total" is a statement about one population rather than two.
       */
      needsAttentionCount: loaded.attentionCount,
      /**
       * The same whole-office population, counted for the two views Today reads
       * without paging them. A card that says "3 saved for tomorrow" and a tab
       * that then shows 3 is the one-population property the attention count
       * already has, extended to the states this slice adds.
       */
      parkedCount: loaded.parkedCount,
      setAsideCount: loaded.setAsideCount,
      /** How many rows the CURRENT view holds — what `offset`/`limit` page. */
      matchingCount: loaded.matching,
      limit,
      offset,
    });
  })
);

// ─── GET /:id — one remittance, in full ──────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);

    // A malformed id is NOT FOUND, not a 500. See helpers.isUuid.
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      // office_id is in the WHERE, not merely checked afterwards: a batch that
      // belongs to the other practice is not found, rather than found and then
      // refused. There is no code path through this handler that omits it.
      const batches = await pool.query(
        `SELECT ${BATCH_COLUMNS} FROM rcm_payment_batches WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId]
      );
      if (batches.rows.length === 0) return null;
      const batch = batches.rows[0];

      const claims = (await claimsByBatch(pool, office, [batchId])).get(batchId) || [];
      const uploads = await uploadsByBatch(pool, office, [batch]);
      const upload = uploads.get(batchId) || null;

      // The lines and adjustments beneath every claim on this batch — this is
      // the screen where the Slice 4 and Slice 5 flags finally get seen.
      const details = await Promise.all(
        claims.map((c) => loadClaimBundle(pool, office, c.claimId, { includeSnapshot: false }))
      );

      // §15.2 finding 9 — the per-user touch stamp, on the detail read too, so
      // the check's own page and Today's card say the same thing about it.
      const decided = (await lastDecidedByBatch(pool, office, [batchId])).get(batchId) || null;

      const actors = await describeActors(pool, [
        batch.created_by,
        batch.approval_attempted_by,
        // Who answered the shadow-mode comparison (C-2). The panel names her.
        batch.comparison_by,
        upload && upload.uploadedByKey,
        decided && decided.byKey,
        ...claims.map((c) => c.odMatchedByKey),
        ...claims.map((c) => c.reviewedByKey),
        ...claims.map((c) => c.approvedByKey),
      ]);

      const queued = await batchesWithQueue(pool, office, [batchId]);

      return {
        batch,
        claims,
        details,
        upload,
        decided,
        actors,
        hasQueue: queued.has(batchId),
        queueStatuses: statusesOf(queued.get(batchId)),
        queuePlans: queued.get(batchId) || [],
      };
    });

    if (!loaded) return notFound(req, res, office, batchId);

    await auditRcmRead(req, 'rcm_remittance', { office });

    const wire = toBatchWire(
      loaded.batch,
      loaded.claims,
      loaded.upload ? loaded.upload.source : null,
      loaded.actors,
      { hasQueue: loaded.hasQueue, queueStatuses: loaded.queueStatuses },
      loaded.decided
    );

    return res.json({
      success: true,
      office,
      remittance: {
        ...wire,
        /**
         * THIS CHECK'S POSTING PLANS — ids and states, nothing else.
         *
         * The one fact that lets the check be posted from its own page. Until
         * now the detail could see THAT a plan existed and what state it was in,
         * and not which plan — so the only screen that could press Post was the
         * office-wide monitor, and a biller finishing a check had to leave it,
         * find her row among everyone else's, and press there. §15.2 finding 1,
         * one level up: the button was on a different page from the work.
         *
         * `POST /posting/drain` has taken an optional `queueId` since 6c and
         * narrows on it inside the same office-scoped, status-filtered query, so
         * naming a plan here cannot reach anything the office-wide run would not
         * have drained. Nothing about the plan's CONTENTS ships — no line, no
         * amount, no patient. An id and a status.
         *
         * An ARRAY because the table permits more than one plan per batch and
         * this route must not assert otherwise; today `(office_id,
         * remittance_key)` is unique so it holds at most one, and the screen
         * reads `plans[0]`.
         */
        plans: (loaded.queuePlans || []).map((plan) => ({
          queueId: plan.queueId,
          status: plan.status,
        })),
        /**
         * Provider Level Balance adjustments — money moved at the provider
         * level rather than on any claim, which is exactly why they make the
         * batch's total disagree with the sum of its claims. Returned verbatim
         * from what the parser stored, because a PLB is detect-and-flag: there
         * is no action on one in this slice, only a link to the manual SOP.
         */
        plbAdjustments: Array.isArray(loaded.batch.plb_adjustments)
          ? loaded.batch.plb_adjustments
          : [],
        upload: loaded.upload
          ? {
              uploadId: loaded.upload.uploadId,
              filename: loaded.upload.filename,
              uploadedAt: loaded.upload.uploadedAt,
              uploadedBy: loaded.upload.uploadedByKey
                ? (loaded.actors[loaded.upload.uploadedByKey] || {}).displayName ||
                  loaded.upload.uploadedByKey
                : null,
              /**
               * PROVENANCE. 'text_layer' | 'ocr' | null — and null genuinely
               * means "we do not know", covering both an 835 (parsed, not read)
               * and any EOB extracted before this slice.
               */
              textSource: loaded.upload.textSource,
              ocrPageCount: loaded.upload.ocrPageCount,
              ocrMeanConfidence: loaded.upload.ocrMeanConfidence,
              /** The authorised download; the blob key itself never ships. */
              documentUrl: `/api/rcm/uploads/${loaded.upload.uploadId}/document?office=${office}`,
            }
          : null,
      },
      claims: loaded.details,
    });
  })
);

// ─── POST /:id/match — run the match over every claim on the batch ───────────

router.post(
  '/:id/match',
  // The queue tier (D-9) — see routes/rcm/index.js QUEUE_PATHS. Batch matching
  // reads Open Dental and changes no chart, so a read-tier reviewer may run it.
  requirePermission('rcm.queue'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);

    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    // The claim SUMMARIES, not just their ids: runBatchMatch orders unmatched
    // claims first so that pressing the button again after a budgeted run makes
    // forward progress instead of redoing the front of the list.
    const claims = await tenantDb.withTenantDb(req, async (pool) => {
      const batches = await pool.query(
        `SELECT batch_id FROM rcm_payment_batches WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId]
      );
      if (batches.rows.length === 0) return null;
      const rows = (await claimsByBatch(pool, office, [batchId])).get(batchId) || [];
      return rows.map((c) => ({ claimId: c.claimId, odMatchStatus: c.odMatchStatus }));
    });

    if (claims === null) return notFound(req, res, office, batchId);

    /*
     * SEQUENTIAL, WITH PACING. Never a request-scoped fan-out.
     *
     * Each claim's match is itself a handful of Open Dental calls, and the OD
     * chain is throttled and ~10 network hops deep (TC_OD_READS.md's cost
     * note). Matching a twelve-claim remittance in parallel would be sixty-odd
     * concurrent calls into an API that rate-limits — and the client's own 429
     * backoff would then serialise them anyway, slower and noisier than doing
     * it deliberately. Every call is paced by services/rcm/odPacer.
     */

    /*
     * TWO KINDS OF ROW, AND BOTH ARE NEEDED.
     *
     * The RUN is recorded here, unconditionally and before any claim is
     * touched, so a run in which every claim fails still leaves a trail — the
     * previous shape hung the whole batch's audit on claim zero succeeding, and
     * a remittance whose first claim was already confirmed read charts and
     * recorded nothing.
     *
     * Then one row PER CLAIM below, stamped with the claim id. A claim is one
     * patient's chart, not one Open Dental call, so N charts is N rows —
     * anything coarser cannot answer "whose chart was read on Tuesday", which
     * is the only question this log exists to answer.
     */
    await auditRcmRead(req, 'rcm_remittance_match', { office, resourceId: batchId });

    const result = await runBatchMatch(req, office, claims, {
      // Fail-closed per claim: a claim whose read cannot be recorded is
      // reported as failed rather than matched, and its snapshot is not stored.
      onPhiRead: (ctx) => auditRcmRead(req, 'rcm_claim_match', { office, resourceId: ctx.claimId }),
      // A read that got names off the wire and then failed is a disclosure that
      // did not complete — ERROR, not a refusal, and never silence.
      onReadFailed: (ctx) =>
        auditRcmDenial(req, 'rcm_claim_match', ctx.claimId, { office, result: 'ERROR' }),
    });

    return res.json({ success: true, office, batchId, ...result });
  })
);


// ─── The approval gate (Slice 6b) ────────────────────────────────────────────

/**
 * Turn an ApprovalError into its HTTP answer, or say it was not ours.
 *
 * Every refusal here is a REFUSAL, not an error: a remittance that cannot be
 * posted yet is the gate working. They are audited as `ERROR` rather than
 * `UNAUTHORIZED` — nobody was denied ACCESS, and diluting UNAUTHORIZED with
 * routine gate outcomes is how the one signal that means "somebody was refused"
 * stops being readable. That lesson is already written into auditRcmDenial's
 * header; this is the first route to need the distinction on a write path.
 *
 * @returns {boolean} true when the response has been sent
 */
function respondToApprovalError(req, res, office, err, batchId, resourceType = 'rcm_posting_approval') {
  if (!(err instanceof approvalGate.ApprovalError)) return false;
  /*
   * The refusal is filed under the resource the CALLER was acting on, so a
   * takeback that was refused does not appear in the ordinary-approval trail.
   * That keeps `rcm_recoupment_approval` a complete record of every takeback
   * anybody attempted, refusals included, rather than only the ones that
   * succeeded.
   */
  void auditRcmDenial(req, resourceType, batchId, {
    office,
    result: err.httpStatus === 404 ? 'UNAUTHORIZED' : 'ERROR',
  });
  const body = {
    success: false,
    error: err.message,
    code: err.code,
  };
  if (Array.isArray(err.claims)) body.claims = err.claims;
  if (typeof err.differenceCents === 'number') body.differenceCents = err.differenceCents;
  /*
   * Slice 6c. WHICH state the existing plan is in, for the two queue-collision
   * refusals. The sentence already differs per status (approvalGate
   * .alreadyRanMessage); this lets a screen link somewhere useful — the Posting
   * queue for a plan that can still be drained, nowhere for one that has
   * finished — without parsing prose.
   */
  if (typeof err.queueStatus === 'string') body.queueStatus = err.queueStatus;
  /*
   * Slice 6d. On a typed-confirmation mismatch the screen must be able to show
   * the phrase again — a dialog that says "wrong" without saying what was
   * wanted is a dialog somebody guesses at. `expected` is the same string the
   * checklist served; no patient data is in it, only the carrier's own money.
   */
  if (typeof err.expected === 'string') body.expected = err.expected;
  if (typeof err.recoupmentTotalCents === 'number') {
    body.recoupmentTotalCents = err.recoupmentTotalCents;
  }
  if (Array.isArray(err.paths)) body.paths = err.paths;
  res.status(err.httpStatus).json(body);
  return true;
}

/**
 * GET /:id/approval — THE PRE-FLIGHT CHECKLIST, before anything is pressed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CHECKLIST IS ITS OWN ENDPOINT, AND WHY IT IS A READ
 * ─────────────────────────────────────────────────────────────────────────────
 * A biller should be able to see exactly which claims will be withheld, and
 * why, and go fix them — without pressing the button to find out. Pressing a
 * button to discover a refusal is how people learn to press buttons hopefully.
 *
 * It runs on `rcm.read`, which the `reviewer` tier holds (D-9), so the person
 * who does the reviewing can see the consequences of her own work even though
 * she cannot approve it. The response says so in a field rather than leaving the
 * screen to infer it from a role name: `canApprove` is the server's answer, and
 * `approveRequires` names the permission a colleague would need.
 *
 * It is computed by the SAME function the POST uses, so the screen cannot
 * predict an outcome the button then contradicts.
 */
router.get(
  '/:id/approval',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const preview = await approvalGate.previewApproval(req, office, batchId);
    if (!preview) return notFound(req, res, office, batchId);

    // The checklist names patients. Fail-closed, like every PHI read here.
    await auditRcmRead(req, 'rcm_posting_approval', { office, resourceId: batchId });

    return res.json({
      success: true,
      office,
      batchId,
      /**
       * May THIS caller press it? The screen renders the same checklist either
       * way — seeing why a claim is withheld is not a posting act — and only
       * the button changes.
       */
      canApprove: holdsPermission(req, 'rcm.write'),
      approveRequires: 'rcm.write',
      claims: preview.claims.map((c) => ({
        claimId: c.claimId,
        claimNumber: c.claimNumber,
        patientName: c.patientName,
        postable: c.postable,
        alreadyQueued: c.alreadyQueued,
        checks: c.checks,
        failed: c.failed,
        /**
         * THE PATIENT-RESPONSIBILITY VERDICT THIS CLAIM WAS JUDGED ON (Stage B1).
         *
         * Carried out whole so the panel prints the gate's own numbers rather
         * than a second computation of them. It is the same object the claim
         * read returns, from the same function — which is what makes the
         * checklist row and the workbench's verdict line one statement rather
         * than two that agree today.
         */
        verdict: c.verdict,
      })),
      postableCount: preview.postable.length,
      withheldCount: preview.withheld.length,
      queuedCount: preview.alreadyQueued.length,
      /** The batch's own arithmetic. False holds the WHOLE approve. */
      balanced: preview.batchBalanced,
      differenceCents: preview.batchDifferenceCents,
    });
  })
);

/**
 * POST /:id/approve — the gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERMISSION
 * ─────────────────────────────────────────────────────────────────────────────
 * This route is deliberately NOT in `routes/rcm/index.js` QUEUE_PATHS, so the
 * mount's `requireReadWrite('rcm.read','rcm.write')` demands `rcm.write` for it
 * by construction — a `reviewer` never reaches this handler at all. The
 * in-handler check below is therefore defence in depth rather than the primary
 * gate: it exists so that a future remount, or a route copied to a path that IS
 * exempt, still refuses. Same `holdsPermission` the middleware uses, so the two
 * cannot disagree about super_admins and machine tokens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT COMES OUT
 * ─────────────────────────────────────────────────────────────────────────────
 * `{ queued, withheld, alreadyQueued }` — what was enqueued, what was not and
 * why, and what a previous approval had already taken. Partial success is real
 * success and says exactly which claims it covered. NOTHING has been written to
 * Open Dental: this route creates rows in OUR database describing an intent,
 * and 6c is what acts on them.
 */
router.post(
  '/:id/approve',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    if (!holdsPermission(req, 'rcm.write')) {
      // A refusal of ACCESS — the one case on this route that IS
      // UNAUTHORIZED, as distinct from the gate's own refusals below.
      await auditRcmDenial(req, 'rcm_posting_approval', batchId, {
        office,
        result: 'UNAUTHORIZED',
      });
      return res.status(403).json({
        success: false,
        error:
          'Approving a remittance for posting needs posting permission — ask an approver to press it',
        code: 'APPROVE_REQUIRES_WRITE',
        action: 'rcm.write',
      });
    }

    let result;
    try {
      result = await approvalGate.approveRemittance(req, office, batchId, {
        email: actorEmail(req),
        displayName: (req.user && (req.user.name || req.user.displayName)) || null,
      });
    } catch (err) {
      if (respondToApprovalError(req, res, office, err, batchId)) return undefined;
      throw err;
    }

    /*
     * CREATE, and the resource is the APPROVAL rather than the remittance.
     *
     * A person authorised money to move; that is a new thing in the world, not
     * an update to a batch. Written AFTER the commit on purpose — unlike a PHI
     * read, where the trail must precede the disclosure, here the fact being
     * recorded is one that has already durably happened, and auditing before
     * the commit would record an approval a rollback then erased.
     */
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_posting_approval',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      office,
      batchId,
      queueId: result.queueId,
      /**
       * WHO PRESSED IT, BY NAME — C-3b item 2.
       *
       * A display name off `describeActors`, falling back to the crosswalk key
       * when nobody has given that actor one. It used to be the key itself,
       * which for anybody the platform minted a row for is their email address,
       * so this route was the one attributed field in the module that reached a
       * screen unresolved. It now reads like its siblings — `parkedBy`,
       * `approvalAttemptedBy`, `comparisonBy` — and the client no longer
       * patches it.
       */
      approvedBy: result.approvedByName,
      /** What this press enqueued. */
      queued: result.queued,
      /** What it did not, per claim, with every failing condition. */
      withheld: result.withheld,
      /** What an earlier press had already taken. */
      alreadyQueued: result.alreadyQueued,
      /** The plan's total, read back off the lines actually written. */
      intendedTotalCents: result.intendedTotalCents,
      /**
       * The literal, current truth, and the words the screen prints. It stops
       * being true the day Slice 6c ships, which is the day this line changes.
       */
      note: 'Queued for posting — nothing has been written to Open Dental yet.',
    });
  })
);

/**
 * GET /:id/recoupment — the takeback checklist, and the phrase to type.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PHRASE COMES FROM THE SERVER
 * ─────────────────────────────────────────────────────────────────────────────
 * D-6's friction is that a person reads an amount and types it back. That only
 * works if the amount on the screen and the amount the server will demand are
 * produced by ONE function — otherwise the dialog shows `-54.08`, the server
 * wants `-54.8`, and the approver is stuck typing a phrase nothing displayed.
 *
 * So `typedTotalExpected` ships from here, already formatted, and the client
 * renders it verbatim rather than formatting cents itself. `rcm-labels.test.ts`
 * has the mirror rule one level down for exactly this class of drift.
 *
 * A READ, on `rcm.read` — a `reviewer` may look at what a takeback would do
 * without being able to authorise it, the same split every other RCM screen has.
 */
router.get(
  '/:id/recoupment',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const preview = await approvalGate.previewRecoupment(req, office, batchId);
    if (!preview) return notFound(req, res, office, batchId);

    // The claim rows name patients. Same PHI trail the ordinary checklist writes.
    await auditRcmRead(req, 'rcm_posting_approval', { office, resourceId: batchId });

    return res.json({
      success: true,
      office,
      batchId,
      claims: preview.claims,
      /** Zero is a real answer: this remittance carries no takeback at all. */
      recoupmentClaims: preview.recoupmentClaims,
      recoupmentTotalCents: preview.recoupmentTotalCents,
      /** THE STRING to type. Rendered verbatim; never re-derived by the client. */
      typedTotalExpected: preview.typedTotalExpected,
      paths: preview.paths,
      /**
       * Stated by the server so a client cannot quietly pre-select the
       * irreversible one. The adjustment is the default; the supplemental is
       * the opt-in.
       */
      defaultPath: preview.defaultPath,
      balanced: preview.batchBalanced,
      differenceCents: preview.batchDifferenceCents,
      canApprove: holdsPermission(req, 'rcm.write'),
      approveRequires: 'rcm.write',
    });
  })
);

/**
 * POST /:id/approve-recoupment — D-6. The one-way door, behind a typed phrase.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE ROUTE AND NOT A FLAG ON APPROVE
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /:id/approve` refuses every takeback and always will — `NOT_RECOUPMENT`
 * and `NOT_REVERSAL` block it, and nothing a request can say turns them off. A
 * takeback is approved HERE or nowhere.
 *
 * A boolean on the ordinary route would have been one line shorter and one
 * missed default away from an irreversible chart write. A separate path means
 * the dangerous thing has its own URL, its own audit resource, its own screen
 * and its own test file — and that a reviewer reading a diff can see which one
 * they are looking at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER VALIDATES THE PHRASE. THE DIALOG IS A COURTESY.
 * ─────────────────────────────────────────────────────────────────────────────
 * `approveRecoupment` computes the total from the claim rows and compares it to
 * `typedTotal` byte for byte after trim. There is no request shape that gets
 * past it — no flag, no header, no pre-confirmed token — so the confirmation
 * cannot be skipped by a client that simply does not render the dialog.
 *
 * `path` picks WHICH write the drain will make later:
 *   `adjustment`   reversible (by an offsetting adjustment — there is no
 *                  DELETE /adjustments, G6). The default.
 *   `supplemental` G10. Cannot be reverted, cannot be deleted, and permanently
 *                  pins its claim and procedure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * D-6 DELIBERATELY DID *NOT* ADD A PERMISSION
 * ─────────────────────────────────────────────────────────────────────────────
 * Alternative (b) — a separate `rcm.recoup` granted to fewer roles — was
 * rejected for now: it is role-admin overhead at a solo-biller practice where
 * the same person would hold it anyway. `rcm.write` PLUS the typed phrase is
 * the gate. If that changes, this is the one handler that has to learn about it.
 */
router.post(
  '/:id/approve-recoupment',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    if (!holdsPermission(req, 'rcm.write')) {
      await auditRcmDenial(req, 'rcm_recoupment_approval', batchId, {
        office,
        result: 'UNAUTHORIZED',
      });
      return res.status(403).json({
        success: false,
        error:
          'Approving a takeback needs posting permission — ask an approver to press it',
        code: 'APPROVE_REQUIRES_WRITE',
        action: 'rcm.write',
      });
    }

    let result;
    try {
      result = await approvalGate.approveRecoupment(
        req,
        office,
        batchId,
        {
          email: actorEmail(req),
          displayName: (req.user && (req.user.name || req.user.displayName)) || null,
        },
        {
          // Carried as a STRING, deliberately. Parsing it here would accept
          // `-54.080` and `-54.8` as the same answer and defeat the ceremony.
          typedTotal: typeof req.body?.typedTotal === 'string' ? req.body.typedTotal : '',
          path: typeof req.body?.path === 'string' ? req.body.path : '',
        }
      );
    } catch (err) {
      if (respondToApprovalError(req, res, office, err, batchId, 'rcm_recoupment_approval')) {
        return undefined;
      }
      throw err;
    }

    /*
     * A DISTINCT AUDIT EVENT — AND WHY IT IS NAMED IN `resource_type`.
     *
     * The 6d brief asked for an `APPROVE_RECOUPMENT` audit ACTION. `audit_log`
     * permits only READ | CREATE | UPDATE | DELETE by CHECK constraint and has
     * no `detail` column, and widening an append-only cross-module table so one
     * RCM event can name itself is a far larger change than the event warrants.
     *
     * So the distinctness lives where this platform already puts it: an ordinary
     * approve writes `rcm_posting_approval`, and a takeback writes
     * `rcm_recoupment_approval`. **An ordinary APPROVE row is never written for
     * a recoupment plan** — the two resource types are disjoint, so "every
     * takeback anyone ever authorised" is one indexed query on
     * `(resource_type, resource_id)`.
     *
     * The numbers the brief wanted in `detail` are all recoverable from the plan
     * this row points at: `is_recoupment`, `intended_total_cents`, the line
     * count and each line's `recoupment_path`. `typed_ok` needs no column —
     * this row cannot exist unless the phrase matched, because the approve
     * throws before it.
     */
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_recoupment_approval',
      resourceId: result.queueId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      office,
      batchId,
      queueId: result.queueId,
      approvedBy: result.approvedBy,
      /** Which write the drain will make. The client shows this back. */
      recoupmentPath: result.recoupmentPath,
      recoupmentTotalCents: result.recoupmentTotalCents,
      queued: result.queued,
      withheld: result.withheld,
      alreadyQueued: result.alreadyQueued,
      intendedTotalCents: result.intendedTotalCents,
      /**
       * The honest sentence for each path. A biller who chose the supplemental
       * should be told, at the moment they chose it, that nothing will undo it.
       */
      note:
        result.recoupmentPath === 'supplemental'
          ? 'Queued as a negative supplemental. Nothing has been written to Open Dental yet — but once it is, it cannot be reversed or deleted.'
          : 'Queued as an adjustment. Nothing has been written to Open Dental yet; once it is, it can be reversed by an offsetting adjustment.',
    });
  })
);


// ─── The worklist states: parked, and set aside ──────────────────────────────

/**
 * THE QUEUE TIER (D-9), AND WHY NEITHER OF THESE IS A WRITE ACT.
 *
 * `rcm.queue` is the tier `POST /claims/:id/review` runs on, and the brief's
 * "rcm.review" is that tier under a name that does not exist — there is no
 * `rcm.review` action in `config/permissions.js`, and adding one would split a
 * tier that already means exactly this: worklist hygiene, no Open Dental effect
 * at all.
 *
 * Marking a claim reviewed ALSO takes a remittance out of the needs-attention
 * queue, and it has run on `rcm.queue` since 6a. Parking and setting aside are
 * the same authority over the same queue, and both are reversible — a `reviewer`
 * who can disposition every claim on a check must be able to say "I am coming
 * back to this" about the check.
 *
 * The paths are registered in `routes/rcm/index.js` QUEUE_PATHS so the mount's
 * `requireReadWrite` exempts them from `rcm.write`; each carries its own
 * `requirePermission('rcm.queue')` below, which is what `rcmGuard.test.js` walks
 * the router to see.
 */
const requireQueue = requirePermission('rcm.queue');

/**
 * Load a batch for a worklist write, or null.
 *
 * `office_id` is in the WHERE rather than checked afterwards, so a check
 * belonging to the other practice is NOT FOUND rather than found-and-refused —
 * the same property every other read in this file has, and the reason walking
 * ids across offices tells a prober nothing.
 *
 * @param {{ query: Function }} client
 * @param {string} office
 * @param {string} batchId
 */
async function loadWorklistState(client, office, batchId) {
  const found = await client.query(
    /*
     * The comparison columns ride along (C-2) because the comparison write needs
     * to know whether the answer it was handed is actually a CHANGE: re-sending
     * the same answer must not advance `comparison_revision`, or a double-click
     * would make the summary say a check was answered twice.
     *
     * Widened here rather than read in a second statement, so the current answer
     * is loaded inside the same transaction — and under the same row read — that
     * the write then acts on.
     */
    `SELECT batch_id, parked_at, set_aside_at, ` +
      `comparison_verdict, comparison_reason, comparison_note, comparison_revision ` +
      `FROM rcm_payment_batches WHERE office_id = $1 AND batch_id = $2`,
    [office, batchId]
  );
  return found.rows[0] || null;
}

/**
 * Run one worklist mutation inside its own transaction, resolving the actor on
 * the SAME connection.
 *
 * D-5: `resolveRcmActor` upserts the crosswalk row whose key the FK checks at
 * statement time, so it must run on this connection rather than on the pool —
 * the same rule `markReviewed` follows, and the same one that makes the FK a
 * RESTRICT rather than a hope.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @param {(client: any, userKey: string|null, row: any) => Promise<void>} write
 * @param {{ needsActor?: boolean }} [opts]
 */
async function withWorklistWrite(req, office, batchId, write, { needsActor = true } = {}) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await loadWorklistState(client, office, batchId);
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false };
      }
      const userKey = needsActor
        ? await resolveRcmActor(client, {
            email: actorEmail(req),
            displayName: (req.user && (req.user.name || req.user.displayName)) || '',
          })
        : null;
      await write(client, userKey, row);
      await client.query('COMMIT');
      return { ok: true, userKey };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* keep the original */
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * POST /:id/park — "save this for tomorrow".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT TAKE THE CHECK OUT OF THE QUEUE
 * ─────────────────────────────────────────────────────────────────────────────
 * A parked remittance still needs attention, is still counted, and still appears
 * everywhere it appeared before. The ONLY thing parking changes is that Today
 * can lead with it: *this is what you were doing.* Making it hide the row would
 * turn a note-to-self into a way to lose work, which is exactly the difference
 * between this and `set-aside` below.
 *
 * IDEMPOTENT, and re-parking MOVES the stamp. Somebody who puts the same check
 * down twice in a week is telling you about the second time; keeping the first
 * instant would date "where you left off" to a session she has forgotten.
 *
 * The note is OPTIONAL. Demanding a sentence at 4:55pm is the friction that
 * stops anybody parking anything, and an un-parked check re-derived from scratch
 * is the cost this route exists to avoid.
 */
router.post(
  '/:id/park',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const raw = req.body && req.body.note;
    const note = typeof raw === 'string' ? raw.trim() : '';
    if (note.length > MAX_WORKLIST_NOTE) {
      return res.status(400).json({
        success: false,
        error: `That note is too long (max ${MAX_WORKLIST_NOTE} characters)`,
        code: 'NOTE_TOO_LONG',
      });
    }

    const done = await withWorklistWrite(req, office, batchId, (client, userKey) =>
      client.query(
        `UPDATE rcm_payment_batches SET parked_at = now(), parked_by = $3, parked_note = $4, ` +
          `updated_at = now() WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId, userKey, note || null]
      )
    );
    if (!done.ok) return notFound(req, res, office, batchId);

    /*
     * `UPDATE` ON THE REMITTANCE, AND THE NOTE IS NOT IN IT.
     *
     * `audit_log` has no detail column, and this platform never puts free text a
     * person typed into one — a parked note is PHI-capable by nature (a biller
     * may name a patient in it), and the trail's job is to record that somebody
     * did this to this row, not to become a second copy of the prose.
     */
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_remittance_park',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, office, batchId, parked: true });
  })
);

/**
 * POST /:id/unpark — put it back on the ordinary pile.
 *
 * Fired by the SCREEN when somebody opens a parked check, as well as by an
 * explicit press: a note saying "come back to this" has done its job the moment
 * she is looking at it, and a card that still says "where you left off" about
 * the page she is standing on is furniture.
 *
 * IDEMPOTENT over an un-parked check — 200, `parked: false`. It is not an error
 * to un-park something nobody parked, and the screen fires this on open, so
 * refusing would make every ordinary visit produce a 409 nobody can act on.
 *
 * `parked_by` and `parked_note` are cleared alongside the stamp because the
 * schema's pairing CHECK demands it: an actor left behind on an un-parked row is
 * a name a screen would print beside a check nobody is holding.
 */
router.post(
  '/:id/unpark',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    let wasParked = false;
    const done = await withWorklistWrite(
      req,
      office,
      batchId,
      async (client, _userKey, row) => {
        wasParked = row.parked_at != null;
        if (!wasParked) return;
        await client.query(
          `UPDATE rcm_payment_batches SET parked_at = NULL, parked_by = NULL, ` +
            `parked_note = NULL, updated_at = now() WHERE office_id = $1 AND batch_id = $2`,
          [office, batchId]
        );
      },
      // No actor is resolved for an un-park: nothing records WHO un-parked, so
      // upserting a crosswalk row would leave a durable side effect behind an
      // action that leaves no trace of itself by design.
      { needsActor: false }
    );
    if (!done.ok) return notFound(req, res, office, batchId);

    // Audited only when something actually changed. A row per page-open would
    // bury every real event under the ordinary act of looking at a check.
    if (wasParked) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'rcm_remittance_park',
        resourceId: batchId,
        result: 'SUCCESS',
        office,
        sourceRef: null,
      });
    }

    return res.json({ success: true, office, batchId, parked: false, wasParked });
  })
);

/**
 * POST /:id/set-aside — a check nobody is coming back to.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * **Not `withdrawn`.** That is a POSTING PLAN's terminal state (§2.2.0): it
 * decides that money will never post through CareIN, it cannot be undone, and it
 * lives on `rcm_posting_queue`. This decides that a REMITTANCE is not worth a
 * biller's morning, it can be undone by anybody who can set it aside, and it
 * touches no plan. A check with a live plan that somebody sets aside still
 * appears on the Posting page, still drains, still posts.
 *
 * **Not a delete, and not a hide.** The row is untouched but for four stamps. It
 * stays in `view=all`, gains its own `view=set_aside`, and says on its face who
 * set it aside, when, and why.
 *
 * **Not a chart write.** No Open Dental call is made or possible from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REASON IS REQUIRED, AND `other` DEMANDS THE SENTENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * A check dropped out of the one queue that means "a human is needed here", with
 * no account of why, is the queue quietly losing work nobody can later explain.
 * The slug is a closed set (a CHECK constraint, migration 1787500000000) so a
 * screen can render copy from it; `other` exists so that set can stay small, and
 * it requires the note so that it can never be a silent shrug.
 */
router.post(
  '/:id/set-aside',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const rawNote = req.body && req.body.note;
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';

    if (!SET_ASIDE_REASONS.includes(reason)) {
      return res.status(400).json({
        success: false,
        error: 'Setting a check aside needs a reason',
        code: 'SET_ASIDE_REASON_REQUIRED',
        reasons: [...SET_ASIDE_REASONS],
      });
    }
    if (note.length > MAX_WORKLIST_NOTE) {
      return res.status(400).json({
        success: false,
        error: `That note is too long (max ${MAX_WORKLIST_NOTE} characters)`,
        code: 'NOTE_TOO_LONG',
      });
    }
    if (reason === 'other' && note.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Say in a line why this check is being set aside',
        code: 'SET_ASIDE_NOTE_REQUIRED',
      });
    }

    const done = await withWorklistWrite(req, office, batchId, (client, userKey) =>
      client.query(
        `UPDATE rcm_payment_batches SET set_aside_at = now(), set_aside_by = $3, ` +
          `set_aside_reason = $4, set_aside_reason_note = $5, updated_at = now() ` +
          `WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId, userKey, reason, note || null]
      )
    );
    if (!done.ok) return notFound(req, res, office, batchId);

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_remittance_set_aside',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, office, batchId, setAside: true, reason });
  })
);

/**
 * POST /:id/restore — put a set-aside check back in the queue.
 *
 * The half that makes set-aside safe to press. Every other way of taking
 * something off this module's board is terminal by design, and each of those had
 * to argue for it; this one has not, and does not need to. Somebody who sets
 * aside the wrong check should be able to fix it in one click rather than
 * escalating.
 *
 * The set-aside stamps are CLEARED rather than kept as history. The schema's
 * pairing CHECK requires it, and it is right: a screen reading "set aside on
 * Aug 30 — currently in the queue" is describing two states at once. The audit
 * row is the history.
 *
 * IDEMPOTENT over a check nobody set aside, for the same reason `unpark` is.
 */
router.post(
  '/:id/restore',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    let wasSetAside = false;
    const done = await withWorklistWrite(
      req,
      office,
      batchId,
      async (client, _userKey, row) => {
        wasSetAside = row.set_aside_at != null;
        if (!wasSetAside) return;
        await client.query(
          `UPDATE rcm_payment_batches SET set_aside_at = NULL, set_aside_by = NULL, ` +
            `set_aside_reason = NULL, set_aside_reason_note = NULL, updated_at = now() ` +
            `WHERE office_id = $1 AND batch_id = $2`,
          [office, batchId]
        );
      },
      { needsActor: false }
    );
    if (!done.ok) return notFound(req, res, office, batchId);

    if (wasSetAside) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'rcm_remittance_set_aside',
        resourceId: batchId,
        result: 'SUCCESS',
        office,
        sourceRef: null,
      });
    }

    return res.json({ success: true, office, batchId, setAside: false, wasSetAside });
  })
);

// ─── The shadow-mode comparison: did the app get this check right? ───────────

/**
 * Plan statuses that CLOSE the question, because money has reached the chart.
 *
 * An answer is changeable *until the check posts*, and this is what "posts"
 * means: `posted` is the whole check on the ledger, `partially_posted` is some
 * of it. Either way the hand-posting the comparison is a comparison AGAINST is
 * over, and an answer changed afterwards would be describing a different world
 * from the one it is filed under.
 *
 * `failed`, `blocked` and `withdrawn` are deliberately NOT here. Nothing reached
 * a chart in any of them, so the question is still live — and `withdrawn` in
 * particular is a check that will be posted BY HAND, which is precisely the case
 * this whole exercise is about.
 */
const COMPARISON_CLOSED_STATUSES = Object.freeze(['posted', 'partially_posted']);

/**
 * POST /:id/comparison — "did the app get this check right?"
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * Shadow mode (RCM_POSTING §2.5) is several weeks of a real biller working real
 * remittances with posting switched off, putting the same money into Open Dental
 * by hand. The only question that period exists to answer is whether what this
 * app worked out matches what she would have done — and the go-live plan
 * answered it with a hand-maintained CSV, which asks a tired person at 9pm to do
 * bookkeeping about her own work. The record is the first thing that gets
 * dropped, and then the decision to switch posting on rests on an impression.
 *
 * One click, at the moment she already knows the answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CANNOT AFFECT POSTING, AND THAT IS THE LOAD-BEARING PROPERTY
 * ─────────────────────────────────────────────────────────────────────────────
 * It writes six columns on `rcm_payment_batches` and reads two from
 * `rcm_posting_queue`. It touches no plan, no line, no status, no gate, no
 * `drain_enabled`, and no Open Dental client — there is none reachable from this
 * file. `shadowComparison.test.js` proves the claim rather than asserting it, by
 * driving the REAL posting run twice, once with an answer recorded and once
 * without, and comparing the Open Dental call transcript and the resulting rows.
 *
 * That is also why it sits on `rcm.queue` (D-9) beside marking a claim reviewed
 * and parking a check, rather than on the `rcm.post` that presses Post: saying
 * what happened is worklist hygiene, not a posting act.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ANSWER IS CHANGEABLE, AND A CHANGE IS RECORDED
 * ─────────────────────────────────────────────────────────────────────────────
 * She may have said `same` and then found the difference an hour later. Refusing
 * the second answer would leave the record saying the opposite of what she now
 * knows, which is the one outcome that makes the whole exercise worthless.
 *
 * So a change is accepted and `comparison_revision` advances, and one audit row
 * is filed per answer. A resubmission of the SAME answer is a no-op — 200,
 * revision unchanged, no audit row — because the screen may re-send and a
 * counter that could be inflated by a double-click would make "this one was
 * answered twice" a lie in the summary.
 */
router.post(
  '/:id/comparison',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);
    if (!isUuid(batchId)) return notFound(req, res, office, batchId);

    const verdict = typeof req.body?.verdict === 'string' ? req.body.verdict.trim() : '';
    const rawReason = req.body && req.body.reason;
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    const rawNote = req.body && req.body.note;
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';

    if (!COMPARISON_VERDICTS.includes(verdict)) {
      return res.status(400).json({
        success: false,
        error: 'Say whether this check came out the same or not',
        code: 'COMPARISON_VERDICT_REQUIRED',
        verdicts: [...COMPARISON_VERDICTS],
      });
    }
    /*
     * A `same` CARRYING A REASON IS REFUSED, not quietly stripped.
     *
     * The CHECK constraint would refuse the row anyway, so the choice here is
     * between a named 400 and an INTERNAL_ERROR — and a body saying "the same,
     * because the payment amount was off" is a client that has a bug, which a
     * route that silently dropped the field would hide until somebody read the
     * database.
     */
    if (verdict === 'same' && (reason || note)) {
      return res.status(400).json({
        success: false,
        error: 'A check marked the same carries no reason and no note',
        code: 'COMPARISON_SAME_TAKES_NO_REASON',
      });
    }
    if (verdict === 'differed' && !COMPARISON_REASONS.includes(reason)) {
      return res.status(400).json({
        success: false,
        error: 'Say which part was off',
        code: 'COMPARISON_REASON_REQUIRED',
        reasons: [...COMPARISON_REASONS],
      });
    }
    if (note.length > MAX_WORKLIST_NOTE) {
      return res.status(400).json({
        success: false,
        error: `That note is too long (max ${MAX_WORKLIST_NOTE} characters)`,
        code: 'NOTE_TOO_LONG',
      });
    }
    /*
     * THE NOTE IS REQUIRED FOR EVERY `differed`, not only for `other`.
     *
     * `set_aside_reason` demands its sentence only on `other`, because there the
     * slug is usually the whole story. Here it never is: "the payment amount"
     * without the two figures is a defect report nobody can act on, and the
     * person reading this in three weeks to decide whether to switch posting on
     * is not the person who typed it.
     */
    if (verdict === 'differed' && note.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Say in a line what was off',
        code: 'COMPARISON_NOTE_REQUIRED',
      });
    }

    const storedReason = verdict === 'differed' ? reason : null;
    const storedNote = verdict === 'differed' ? note : null;

    /** @type {{ code: string, message: string }|null} */
    let refusal = null;
    let unchanged = false;
    let revision = 0;
    /**
     * WHAT THE ANSWER WAS BEFORE THIS ONE, as a slug — `same` or
     * `differed:<reason>`. Null when this is the first answer on the check.
     *
     * The counter on the row says an answer was CHANGED; this says which way.
     * A `same` corrected to `differed` is the app being caught, and a `differed`
     * corrected to `same` is the biller catching herself — opposite facts about
     * the software, and the counter cannot tell them apart.
     *
     * SLUGS ONLY. The note never appears here, on the same rule that keeps it
     * out of every other audit row: it is the biller's own words and may name a
     * patient. `audit_log_prior_state_check` refuses anything that is not
     * slug-shaped, so that rule is the database's rather than this comment's.
     */
    let priorState = null;

    const done = await withWorklistWrite(req, office, batchId, async (client, userKey, row) => {
      /*
       * THE PRECONDITIONS, READ INSIDE THE TRANSACTION.
       *
       * Both are facts about the posting, so both are read from
       * `rcm_posting_queue` on this connection rather than from anything the
       * screen sent — a body cannot assert a check into being answerable.
       */
      const plans = await client.query(
        `SELECT queue_id, status FROM rcm_posting_queue WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId]
      );
      if (plans.rows.length === 0) {
        /*
         * NOTHING TO COMPARE AGAINST. The question is "did the app get this
         * check right", and until somebody has approved it the app has not said
         * what it would do. A 409 rather than a 400: the body is fine, the
         * check is not ready to be asked about yet.
         */
        refusal = {
          code: 'COMPARISON_NOT_APPROVED',
          message: 'This check has not been approved yet, so there is nothing to compare.',
        };
        return;
      }
      if (plans.rows.some((p) => COMPARISON_CLOSED_STATUSES.includes(String(p.status)))) {
        refusal = {
          code: 'COMPARISON_CLOSED',
          message: 'This check has posted. The answer recorded before it posted stands.',
        };
        return;
      }

      unchanged =
        (row.comparison_verdict || null) === verdict &&
        (row.comparison_reason || null) === storedReason &&
        (row.comparison_note || null) === storedNote;
      if (unchanged) {
        revision = Number(row.comparison_revision) || 0;
        return;
      }

      /*
       * Read off the row loaded inside THIS transaction, before the update
       * overwrites it — so the slug describes what was actually replaced rather
       * than what a second read might have found after somebody else moved it.
       */
      if (row.comparison_verdict === 'same') {
        priorState = 'same';
      } else if (row.comparison_verdict === 'differed') {
        priorState = row.comparison_reason
          ? `differed:${row.comparison_reason}`
          : 'differed';
      }

      const written = await client.query(
        `UPDATE rcm_payment_batches SET comparison_verdict = $3, comparison_reason = $4, ` +
          `comparison_note = $5, comparison_by = $6, comparison_at = now(), ` +
          `comparison_revision = comparison_revision + 1, updated_at = now() ` +
          `WHERE office_id = $1 AND batch_id = $2 RETURNING comparison_revision`,
        [office, batchId, verdict, storedReason, storedNote, userKey]
      );
      revision = Number((written.rows[0] || {}).comparison_revision) || 0;
    });
    if (!done.ok) return notFound(req, res, office, batchId);
    if (refusal) {
      await auditRcmDenial(req, 'rcm_remittance_comparison', batchId, { office });
      return res.status(409).json({ success: false, error: refusal.message, code: refusal.code });
    }

    /*
     * ONE AUDIT ROW PER ANSWER, AND THE NOTE IS NOT IN IT.
     *
     * The row records that this person answered this check at this instant,
     * which is what makes a changed answer a recorded change rather than a
     * silent overwrite. `audit_log` has no detail column and this platform never
     * puts free text a person typed into one — a comparison note is PHI-capable
     * by nature, on exactly the reasoning `parked_note` carries.
     *
     * Nothing is filed for a no-op resubmission, on `unpark`'s rule: a row per
     * re-render would bury every real answer under the ordinary act of looking.
     */
    if (!unchanged) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'rcm_remittance_comparison',
        resourceId: batchId,
        result: 'SUCCESS',
        office,
        sourceRef: null,
        /*
         * Null on a first answer, which is what makes the chain readable: for
         * one check ordered by `ts`, each row names its predecessor and the
         * batch row names the last one, so the whole sequence and every
         * direction of travel falls out of N rows. See 1788000000000.
         */
        priorState,
      });
    }

    return res.json({
      success: true,
      office,
      batchId,
      verdict,
      reason: storedReason,
      revision,
      /** False when the same answer was sent twice — nothing was written. */
      recorded: !unchanged,
    });
  })
);

module.exports = router;
module.exports.attentionFor = attentionFor;
module.exports.BATCH_COLUMNS = BATCH_COLUMNS;
module.exports.batchesWithQueue = batchesWithQueue;
module.exports.statusesOf = statusesOf;
module.exports.REMITTANCE_VIEWS = REMITTANCE_VIEWS;
module.exports.MAX_WORKLIST_NOTE = MAX_WORKLIST_NOTE;
module.exports.SET_ASIDE_REASONS = SET_ASIDE_REASONS;
module.exports.COMPARISON_VERDICTS = COMPARISON_VERDICTS;
module.exports.COMPARISON_REASONS = COMPARISON_REASONS;
module.exports.COMPARISON_CLOSED_STATUSES = COMPARISON_CLOSED_STATUSES;
