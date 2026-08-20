'use strict';

/**
 * RCM Slice 6c — THE DRAIN. The posting state machine.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ═════════════════════════════════════════════════════════════════════════════
 * Slices 1–6b turned a carrier's remittance into an approved, durable record of
 * INTENDED posting: `rcm_posting_queue` + `rcm_posting_queue_line`, written
 * before any Open Dental call, carrying per-line intended `InsPayAmt` /
 * `WriteOff` / `DedApplied` in cents and the chart identifiers a confirmed match
 * recorded.
 *
 * This module drains that record into a real patient's ledger.
 *
 * It does NOT decide what to post. The gate did that (6b), server-side, over
 * twelve conditions, with no force flag anywhere. This machine's whole job is to
 * carry out an already-authorised plan through a forced call sequence, prove
 * every step by reading it back, and be resumable from Open Dental's own state
 * when anything breaks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FORCED ORDER, AND WHY IT IS FORCED
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental has no transactions, no savepoints and no rollback endpoint (G4),
 * and the order of operations is not a preference:
 *
 *     per line   PUT  /claimprocs/{n}  Status=Received, InsPayAmt, WriteOff, DedApplied
 *     per claim  PUT  /claims/{n}      ClaimStatus=R, DateReceived
 *     per check  POST /claimpayments[/Batch]   CheckAmt = the eligible total
 *     (6d)       POST /documents/Upload        the EOB PDF
 *
 * `POST /claimpayments` requires `CheckAmt` to equal the total of the
 * ClaimProcs' `InsPayAmt` *"with ClaimPaymentNum=0"*, and `InsPayAmt` *"cannot
 * be updated when there is already a ClaimPayment attached"*. Money before
 * check, per-line before per-claim, per-claim before the check. Creating an
 * empty check and filling it in later is not expressible in this API.
 *
 * `RCM_OD_WRITES.md` §8 names the worst failure window explicitly: between the
 * claim PUT and the check POST, *"the claim reads Received with money on the
 * lines and no check exists"*, and *"recovery works, but only if the poster
 * knows exactly which claimprocs it had touched"*. That sentence is why the
 * queue exists, and this file is its consumer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR RULES THAT ARE NOT NEGOTIABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **READ BACK EVERYTHING.** Open Dental returns `200 OK` on writes it
 *    silently ignores (G2, test 2b). A write whose read-back disagrees is a
 *    FAILURE of that step with the disagreement stored — never a success because
 *    the status line said so. `odPostingWrites.js` returns verdicts, not
 *    statuses, and there is no branch here that reads a status code.
 *
 * 2. **PERSIST BEFORE THE NEXT CALL.** Every transition is written to Postgres
 *    before the following Open Dental call starts. A process that dies at any
 *    instant leaves a row that says where it was.
 *
 * 3. **RESUME RE-READS OPEN DENTAL FIRST, ALWAYS.** Before any write on any
 *    attempt — first or fifth — the machine reads `GET /claims/{n}`,
 *    `GET /claimprocs?ClaimNum=` and, if we hold one, `GET
 *    /claimprocs?ClaimPaymentNum=`, and continues from what the CHART says
 *    rather than from what our columns remember. A line Open Dental already
 *    shows `Received` with our exact amounts is `skipped_already_posted`, not
 *    re-written. Our columns are a plan and a log; they are never the authority
 *    on what is in a patient's chart.
 *
 * 4. **NO SECOND CHECK, EVER.** Before `POST /claimpayments*` the machine checks
 *    `od_claim_payment_num` on the row AND looks for a check already attached to
 *    our own lines in the chart. If it finds one it ADOPTS it. There is no path
 *    through this file that creates a second ClaimPayment for one plan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES, AND WHY REFUSING IS A STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * `blocked` + a machine reason, with NO Open Dental call made:
 *
 *   `valley_not_enabled`        D-7. Valley drains only after Riley's DefNums
 *                               are read from Riley's own database, the Riley
 *                               key's WRITE permission groups are proven, and a
 *                               valley e2e passes. Until all three are recorded
 *                               in docs/RCM_POSTING.md this is where a valley
 *                               row stops. Never a silent skip; never a roland
 *                               fallback.
 *   `recoupment_not_in_scope`   D-6. A negative supplemental is the ONE
 *                               irreversible Open Dental operation (G10) and it
 *                               belongs to 6d behind a harder gate.
 *   `office_config_unresolved`  The office's own PayType could not be read. A
 *                               check posted under a guessed payment type is a
 *                               reconciliation failure discovered weeks later.
 *   `office_mismatch`, `plan_empty`, `claim_not_confirmed`,
 *   `claim_not_on_this_plan`, `negative_intent`, `plan_total_mismatch`,
 *   `snapshot_superseded`, `od_writes_disabled`
 *
 * A refusal is not an error and not a skip. `failed` means something was
 * attempted and did not work; `blocked` means nothing was attempted and a human
 * must change something first. Collapsing the two would make the queue unable to
 * say which of those two very different things happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERIAL, SINGLE RUNNER, maxReplicas = 1
 * ─────────────────────────────────────────────────────────────────────────────
 * One in-process loop, one row at a time, claims in order, lines in order, every
 * Open Dental call through `odPacer` at ≥1.2 s (D-8 — the credential is shared
 * with the phones and TC, and a biller draining a check must never degrade them).
 * No fan-out anywhere.
 *
 * The same standing invariant `eobStartupSweep.js` documents applies and applies
 * harder: **under a second replica this design is actively unsafe** — replica B
 * would pick up a row replica A is mid-sequence on and re-issue writes A has
 * already made. A timestamp filter does not fix that. The fix is a lease with a
 * heartbeat on the queue row, and that is the work to do BEFORE raising
 * maxReplicas, not after. `DRAIN_MUTEX` below is a process-wide guard and is
 * honest about being exactly that.
 */

const odPostingWrites = require('./odPostingWrites');
const odOfficeConfig = require('./odOfficeConfig');
/*
 * NAMESPACE IMPORT, NOT A DESTRUCTURE.
 *
 * `const { audit } = require(...)` pins the function at require time, so a suite
 * that installs a recording stub on the module gets the real one anyway — and
 * the real one reaches the control database, which a unit test has no business
 * needing. The module is required as a namespace and called as `auditModule
 * .audit(...)` for the same reason `routes/rcm/era.js` imports `eraFileStore`
 * that way, and the same reason the RCM slice-3 notes say never to destructure
 * `withTenantDb`.
 */
const auditModule = require('../../platform/audit');

const { STEPS, OdWriteError } = odPostingWrites;

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Machine reasons a plan is `blocked`. Slugs, never sentences: the UI renders
 * copy from these and nothing parses prose.
 */
const BLOCK_REASONS = Object.freeze({
  VALLEY_NOT_ENABLED: 'valley_not_enabled',
  RECOUPMENT_NOT_IN_SCOPE: 'recoupment_not_in_scope',
  OFFICE_CONFIG_UNRESOLVED: 'office_config_unresolved',
  OFFICE_MISMATCH: 'office_mismatch',
  PLAN_EMPTY: 'plan_empty',
  CLAIM_NOT_CONFIRMED: 'claim_not_confirmed',
  CLAIM_NOT_ON_THIS_PLAN: 'claim_not_on_this_plan',
  NEGATIVE_INTENT: 'negative_intent',
  PLAN_TOTAL_MISMATCH: 'plan_total_mismatch',
  SNAPSHOT_SUPERSEDED: 'snapshot_superseded',
  OD_WRITES_DISABLED: 'od_writes_disabled',
  ELIGIBLE_TOTAL_MISMATCH: 'eligible_total_mismatch',
  NO_PAY_TYPE: 'no_pay_type',
});

/** The one skip reason 6c can produce. See the migration's column comment. */
const SKIP_ALREADY_RECEIVED = 'already_received_matching';

/**
 * The map between what the database stores and what a screen says.
 *
 * Slice 1 named the first two states `approved` and `posting`; the 6c brief
 * calls them `queued` and `running`. They are the same states, the stored words
 * are not renamed (see the migration header), and this is the single place the
 * two vocabularies meet. `postingDrain.test.js` pins that every stored value has
 * a label and that no label is invented for a value the CHECK cannot hold.
 */
const QUEUE_STATUS_LABEL = Object.freeze({
  approved: 'queued',
  posting: 'running',
  posted: 'posted',
  partially_posted: 'partially_posted',
  failed: 'failed',
  blocked: 'blocked',
});

/**
 * Which stored statuses the drain will pick up.
 *
 * `posting` is NOT here. A row in `posting` is either genuinely in flight in
 * this process — the mutex below prevents a second run reaching it — or it was
 * left behind by a process that died, and re-homing THOSE is the startup
 * sweep's job, run once before `server.listen()` where no live run can exist.
 * Picking up a `posting` row here would be this file guessing that some other
 * runner is dead.
 *
 * `blocked` is not here either: a blocked row is waiting on a human, and
 * retrying it automatically is how a refusal becomes a loop. Re-approving or
 * fixing the cause is what moves it.
 */
const DRAINABLE_STATUSES = Object.freeze(['approved', 'failed', 'partially_posted']);

/**
 * D-7's gate, as data.
 *
 * `roland` drains. `valley` does not, until all three prerequisites are recorded
 * in `docs/RCM_POSTING.md`:
 *   (a) Riley's PayType / AdjType / DocCategory DefNums read from Riley's OWN
 *       Open Dental and written down;
 *   (b) the Riley key's WRITE permission groups (Insurance, Documents) proven —
 *       TC #97 proved the READ groups, which is a different entitlement;
 *   (c) a valley end-to-end on PatNum 7115.
 *
 * An env var deliberately CANNOT open this. The lockdown-as-a-flag idiom fits a
 * bootstrap fallback; it does not fit "may this practice's charts be written
 * to", where the cost of a typo in an app setting is a payment posted into the
 * wrong database under DefNums nobody verified. Enabling valley is a code
 * change, in a diff, with the evidence in the same commit.
 */
const OFFICES_ENABLED_FOR_POSTING = Object.freeze(['roland']);

/**
 * How long one drain run may hold the request before stopping cleanly.
 *
 * Bounded for the same reason the batch matcher is: at ≥1.2 s per Open Dental
 * call a twenty-claim plan is minutes of wall clock, and an unbounded loop
 * inside an HTTP handler is a request that eventually dies somewhere with no
 * record of where it got to.
 *
 * THE BUDGET IS CHECKED BETWEEN ROWS ONLY. Stopping mid-claim would leave the
 * §8 window open on purpose, which is the one thing this whole design exists to
 * avoid. A row that starts finishes, or fails and says where.
 */
const DEFAULT_BUDGET_MS = 4 * 60 * 1000;

/**
 * Process-wide, and honest about it.
 *
 * Two billers pressing Drain at the same moment must not both run: the second
 * would read the same `approved` rows and re-issue writes the first is
 * mid-sequence on. This is a mutex in one process, not a distributed lock — see
 * the maxReplicas note in the header.
 */
const DRAIN_MUTEX = { running: false, since: null, office: null };

// ─── Pure core: preconditions ────────────────────────────────────────────────

/**
 * Every precondition, evaluated BEFORE the first Open Dental call of a row.
 *
 * PURE. No transport, no clock, no database — a plan and its context in, a
 * refusal or null out. That is what makes it exhaustively testable, and it is
 * where the fail-closed rule lives: any miss returns a named reason and no Open
 * Dental call is made.
 *
 * Order matters and is the order a reviewer reads them: what the module refuses
 * on policy first (valley, recoupment, environment), then identity, then the
 * shape of the plan, then its arithmetic.
 *
 * @param {{
 *   queue: { queueId: string, officeId: string, status: string, isRecoupment: boolean,
 *            intendedTotalCents: number },
 *   lines: Array<{ queueLineId: string, officeId: string, position: number,
 *                  odClaimProcNum: number, odClaimNum: number|null, claimId: string|null,
 *                  intendedInsPayAmtCents: number, intendedWriteOffCents: number,
 *                  intendedDedAppliedCents: number, isSupplemental: boolean, status: string }>,
 *   claims: Array<{ claimId: string, officeId: string, odMatchStatus: string,
 *                   odClaimNum: number|null, postingQueueId: string|null,
 *                   snapshotVersion: number|null }>,
 *   office: string,
 *   odWritesDisabled: boolean,
 *   snapshotVersion: number,
 * }} ctx
 * @returns {{ reason: string, detail: string }|null}
 */
function checkPreconditions(ctx) {
  const { queue, lines, claims, office } = ctx;

  // -- Policy: D-7. Valley cannot be drained yet, and says so. ---------------
  if (!OFFICES_ENABLED_FOR_POSTING.includes(office)) {
    return {
      reason: BLOCK_REASONS.VALLEY_NOT_ENABLED,
      detail:
        `Posting is not enabled for '${office}' yet. This practice's own PayType, ` +
        `AdjType and DocCategory DefNums must be read from its own Open Dental, its ` +
        `key's write permission groups proven, and a test-patient end-to-end run ` +
        `completed first (D-7).`,
    };
  }

  // -- Policy: D-6. A recoupment is 6d's, and it is irreversible. ------------
  //
  // Checked in THREE ways because the flag, the sign on a line and the sign on
  // the plan total are three independent chances for a takeback to reach this
  // machine, and the operation at the end of it cannot be undone (G10).
  if (queue.isRecoupment) {
    return {
      reason: BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE,
      detail:
        'This plan is a recoupment. A negative supplemental cannot be reverted or ' +
        'deleted in Open Dental, so it posts behind its own harder gate (6d), not here.',
    };
  }
  const negative = lines.find(
    (l) => Number(l.intendedInsPayAmtCents) < 0 || l.isSupplemental === true
  );
  if (negative) {
    return {
      reason: BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE,
      detail:
        `Line ${negative.position} carries a negative payment or is marked supplemental. ` +
        'Negative posting is 6d and is irreversible once written.',
    };
  }
  if (Number(queue.intendedTotalCents) < 0) {
    return {
      reason: BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE,
      detail: 'The plan total is negative — the whole remittance is a takeback.',
    };
  }

  // -- Environment. A dev box sharing production credentials must not post. ---
  if (ctx.odWritesDisabled) {
    return {
      reason: BLOCK_REASONS.OD_WRITES_DISABLED,
      detail:
        'Open Dental writes are disabled in this environment ' +
        '(OPENDENTAL_WRITE_DISABLED). Nothing was sent.',
    };
  }

  // -- The plan must have something to do. -----------------------------------
  const actionable = lines.filter((l) => l.status !== 'skipped' && l.status !== 'skipped_already_posted');
  if (lines.length === 0 || actionable.length === 0) {
    return {
      reason: BLOCK_REASONS.PLAN_EMPTY,
      detail: 'This plan has no postable lines.',
    };
  }

  // -- Office consistency across all three levels. ---------------------------
  //
  // The office already came from the queue row server-side, so this is not
  // "which office" — it is "do the row, its lines and its claims all agree".
  // ClaimProcNum and PatNum numbering restart in every Open Dental database, so
  // a plan whose parts disagree about the practice is a plan that could write
  // one office's amounts into another office's chart.
  if (queue.officeId !== office) {
    return {
      reason: BLOCK_REASONS.OFFICE_MISMATCH,
      detail: `The plan is stamped '${queue.officeId}' but is being drained as '${office}'.`,
    };
  }
  const foreignLine = lines.find((l) => l.officeId !== office);
  if (foreignLine) {
    return {
      reason: BLOCK_REASONS.OFFICE_MISMATCH,
      detail: `Line ${foreignLine.position} is stamped '${foreignLine.officeId}'.`,
    };
  }
  const foreignClaim = claims.find((c) => c.officeId !== office);
  if (foreignClaim) {
    return {
      reason: BLOCK_REASONS.OFFICE_MISMATCH,
      detail: 'A claim on this plan is stamped with a different practice.',
    };
  }

  // -- Every claim is still confirmed, and still on THIS plan. ---------------
  //
  // 6b's database CHECK stops a queued claim being re-matched, so this cannot
  // normally drift. It is re-asserted because the alternative is trusting a
  // constraint from a different slice at the exact moment money moves, and
  // because a claim silently unlinked from the plan would otherwise be posted
  // as though it were still authorised.
  for (const claim of claims) {
    if (claim.odMatchStatus !== 'confirmed' || !claim.odClaimNum) {
      return {
        reason: BLOCK_REASONS.CLAIM_NOT_CONFIRMED,
        detail: 'A claim on this plan is no longer a confirmed match.',
      };
    }
    if (claim.postingQueueId !== queue.queueId) {
      return {
        reason: BLOCK_REASONS.CLAIM_NOT_ON_THIS_PLAN,
        detail: 'A claim on this plan is linked to a different posting plan.',
      };
    }
    if (claim.snapshotVersion !== null && claim.snapshotVersion !== ctx.snapshotVersion) {
      return {
        reason: BLOCK_REASONS.SNAPSHOT_SUPERSEDED,
        detail:
          `A claim's match snapshot is version ${claim.snapshotVersion}; this build ` +
          `writes and reads version ${ctx.snapshotVersion}. Re-match and re-confirm it.`,
      };
    }
  }

  // -- No line may carry a negative component. -------------------------------
  //
  // `intended_ins_pay_amt_cents` was covered by the recoupment pass above; write
  // -off and deductible are checked here for their own sake. A negative
  // write-off is not a recoupment, it is a parse defect, and Open Dental would
  // take it without complaint.
  const badLine = lines.find(
    (l) => Number(l.intendedWriteOffCents) < 0 || Number(l.intendedDedAppliedCents) < 0
  );
  if (badLine) {
    return {
      reason: BLOCK_REASONS.NEGATIVE_INTENT,
      detail: `Line ${badLine.position} carries a negative write-off or deductible.`,
    };
  }

  // -- Every line must name a claim. -----------------------------------------
  const orphan = lines.find((l) => !l.odClaimNum);
  if (orphan) {
    return {
      reason: BLOCK_REASONS.PLAN_EMPTY,
      detail: `Line ${orphan.position} does not name an Open Dental claim.`,
    };
  }

  // -- The arithmetic. -------------------------------------------------------
  //
  // Sum of intended payments must equal the plan's own recorded total, which is
  // the CheckAmt this run will assert to Open Dental. `POST /claimpayments`
  // refuses a mismatch with a 400 (test 5), and discovering that at the check
  // step means discovering it in the §8 window. Discovering it here costs
  // nothing.
  const sum = lines.reduce((a, l) => a + Number(l.intendedInsPayAmtCents), 0);
  if (sum !== Number(queue.intendedTotalCents)) {
    return {
      reason: BLOCK_REASONS.PLAN_TOTAL_MISMATCH,
      detail:
        `The lines sum to ${sum} cents but the plan records ${queue.intendedTotalCents}. ` +
        'Nothing was sent.',
    };
  }

  return null;
}

// ─── Pure core: what resume decides for each line ────────────────────────────

/**
 * Given what Open Dental ACTUALLY holds, decide what to do with one planned line.
 *
 * This is rule 3 as a function, and it is the difference between a resume and a
 * replay. Four outcomes:
 *
 *   `write`   the chart does not yet show our adjudication — do the PUT.
 *   `skip`    the chart already shows `Received` with our EXACT amounts. Nothing
 *             to write, and re-writing would be pointless at best. Recorded as
 *             `skipped_already_posted` with a reason, never as a silent success:
 *             "we did this" and "this was already done" are different facts and
 *             the second is what proves a resume did not double-post.
 *   `attached` the line already carries a ClaimPaymentNum. It CANNOT be PUT
 *             (test 11: `400 "Cannot change InsPayAmt when Status is Received and
 *             attached to a ClaimPayment."`) and it must not be — the money is
 *             already on a check. Carries which check, so the caller can adopt it.
 *   `conflict` the chart shows this line Received with DIFFERENT amounts from
 *             the ones this plan intends. Somebody or something posted it
 *             otherwise. This is a refusal — overwriting it would be re-posting a
 *             line a human already dealt with, and *"editing a received ClaimProc
 *             can delete all of the Income Transfers on the claim"* is the most
 *             dangerous sentence in Open Dental's documentation.
 *
 * @param {{ intendedInsPayAmtCents: number, intendedWriteOffCents: number,
 *           intendedDedAppliedCents: number }} line
 * @param {Record<string, unknown>|undefined} odRow
 * @returns {{ action: 'write'|'skip'|'attached'|'conflict', checkNum?: number,
 *             mismatches?: Array<{field:string,sent:unknown,read:unknown}> }}
 */
function decideLineAction(line, odRow) {
  if (!odRow) {
    // The plan names a ClaimProcNum the claim does not have. Not writable and
    // not skippable — the plan is built on something that has since changed.
    return { action: 'conflict', mismatches: [{ field: 'ClaimProcNum', sent: 'planned', read: null }] };
  }

  const attached = odPostingWrites.attachedCheckNum(odRow);

  const verdict = odPostingWrites.compareClaimProc(
    {
      Status: 'Received',
      InsPayAmt: odPostingWrites.centsToDollars(line.intendedInsPayAmtCents),
      WriteOff: odPostingWrites.centsToDollars(line.intendedWriteOffCents),
      DedApplied: odPostingWrites.centsToDollars(line.intendedDedAppliedCents),
    },
    odRow
  );

  if (attached > 0) {
    /*
     * Attached to a check. If the amounts also agree this is simply our own
     * earlier run, complete — adopt the check. If they DISAGREE the money on
     * this line is not ours and nothing here may touch it.
     */
    return verdict.agreed
      ? { action: 'attached', checkNum: attached }
      : { action: 'conflict', checkNum: attached, mismatches: verdict.mismatches };
  }

  if (verdict.agreed) return { action: 'skip' };

  const status = typeof odRow.Status === 'string' ? odRow.Status.trim() : '';
  if (status === 'Received') {
    // Received, unattached, and with amounts that are not ours.
    return { action: 'conflict', mismatches: verdict.mismatches };
  }

  /*
   * Not received yet — the ordinary first-attempt case, and also the case where
   * a previous run died before its PUT landed.
   *
   * The blocked statuses Open Dental refuses to update are checked here rather
   * than discovered as a 400, so the plan says why instead of the transport.
   */
  if (['Adjustment', 'InsHist', 'CapClaim', 'CapComplete', 'CapEstimate'].includes(status)) {
    return {
      action: 'conflict',
      mismatches: [{ field: 'Status', sent: 'Received', read: status }],
    };
  }
  if (odRow.IsTransfer === true || String(odRow.IsTransfer).trim().toLowerCase() === 'true') {
    return {
      action: 'conflict',
      mismatches: [{ field: 'IsTransfer', sent: false, read: odRow.IsTransfer }],
    };
  }

  return { action: 'write' };
}

/**
 * Group a plan's lines by the Open Dental claim they belong to, preserving the
 * plan's own ordering.
 *
 * `position` is what 6b assigns and continues across a re-approve, so it is the
 * deterministic replay order rule 6 promises. Claims are ordered by the position
 * of their first line, so "claims within a row in order, lines within a claim in
 * order" is one sort rather than two conventions.
 *
 * @param {Array<{ position: number, odClaimNum: number }>} lines
 * @returns {Array<{ odClaimNum: number, lines: any[] }>}
 */
function groupByClaim(lines) {
  const ordered = [...lines].sort((a, b) => a.position - b.position);
  /** @type {Map<number, any[]>} */
  const byClaim = new Map();
  for (const line of ordered) {
    const key = Number(line.odClaimNum);
    if (!byClaim.has(key)) byClaim.set(key, []);
    byClaim.get(key).push(line);
  }
  return [...byClaim.entries()].map(([odClaimNum, claimLines]) => ({ odClaimNum, lines: claimLines }));
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/**
 * Today, in the OFFICE's timezone, as Open Dental's `"yyyy-MM-dd"`.
 *
 * `OFFICE_TIMEZONE` (America/Chicago) rather than UTC, and rather than the
 * container's clock: UTC midnight lands mid-evening in Central, so a drain run
 * at 7pm would stamp tomorrow's date on a payment the practice posted today.
 * The same reasoning `TRANSCRIPTION_BUDGET_TZ` carries on the voice side, for
 * the same class of off-by-one-day bug.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function officeToday(now = new Date()) {
  const tz = process.env.OFFICE_TIMEZONE || 'America/Chicago';
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly Open Dental's date shape.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An invalid TZ must not stop a posting run; UTC is wrong by at most a day
    // and the run is still verifiable by read-back.
    return now.toISOString().slice(0, 10);
  }
}

/**
 * A uuid, or null.
 *
 * Postgres refuses a non-uuid literal in a `uuid` comparison, so an unvalidated
 * value from a request body would 500 rather than simply select nothing — and
 * the shape of that error tells a prober which ids are real. The same reasoning
 * as `helpers.isUuid`, applied where the value reaches SQL.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function asUuidOrNull(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** A pg `date` (Date | string | null) as `"yyyy-MM-dd"`, or null. */
function asOdDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // A pg `date` comes back as a Date at local midnight; slicing the ISO string
    // would shift it a day west of Greenwich. Build it from the local parts.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// Every one of these is a single statement, and every transition is committed
// BEFORE the Open Dental call it precedes (rule 2). There is no transaction
// spanning an OD call: holding one open across a 1.2-s-paced network round trip
// would pin a connection for the length of the drain, and it would buy nothing —
// Open Dental cannot participate in it, so the atomicity would be a comforting
// fiction over the one boundary that actually tears.

const QUEUE_COLUMNS = [
  'queue_id',
  'office_id',
  'batch_id',
  'remittance_key',
  'status',
  'is_recoupment',
  'carrier_eob_date',
  'intended_total_cents',
  'posted_total_cents',
  'od_claim_payment_num',
  'approved_by',
  'approved_at',
  'started_at',
  'finished_at',
  'attempt_count',
  'last_error',
  'blocked_reason',
  'drain_step',
  'drained_by',
  'drain_attempt_at',
  'reconciled_at',
];

const LINE_COLUMNS = [
  'queue_line_id',
  'queue_id',
  'office_id',
  'position',
  'od_claim_proc_num',
  'od_claim_num',
  'claim_id',
  'batch_claim_payment_id',
  'intended_ins_pay_amt_cents',
  'intended_write_off_cents',
  'intended_ded_applied_cents',
  'is_supplemental',
  'status',
  'claimproc_written_at',
  'claim_received_at',
  'paid_at',
  'od_claim_payment_num',
  'last_error',
  'readback',
  'readback_at',
  'skip_reason',
];

/** Row → the camelCase shape the pure core takes. */
function toQueue(row) {
  return {
    queueId: String(row.queue_id),
    officeId: String(row.office_id),
    batchId: String(row.batch_id),
    remittanceKey: String(row.remittance_key),
    status: String(row.status),
    isRecoupment: row.is_recoupment === true,
    carrierEobDate: asOdDate(row.carrier_eob_date),
    intendedTotalCents: Number(row.intended_total_cents || 0),
    postedTotalCents: Number(row.posted_total_cents || 0),
    odClaimPaymentNum: row.od_claim_payment_num == null ? null : Number(row.od_claim_payment_num),
    approvedBy: row.approved_by == null ? null : String(row.approved_by),
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
    drainStep: row.drain_step == null ? null : String(row.drain_step),
    reconciledAt: row.reconciled_at || null,
  };
}

/** Row → the camelCase shape the pure core takes. */
function toLine(row) {
  return {
    queueLineId: String(row.queue_line_id),
    officeId: String(row.office_id),
    position: Number(row.position),
    odClaimProcNum: Number(row.od_claim_proc_num),
    odClaimNum: row.od_claim_num == null ? null : Number(row.od_claim_num),
    claimId: row.claim_id == null ? null : String(row.claim_id),
    intendedInsPayAmtCents: Number(row.intended_ins_pay_amt_cents || 0),
    intendedWriteOffCents: Number(row.intended_write_off_cents || 0),
    intendedDedAppliedCents: Number(row.intended_ded_applied_cents || 0),
    isSupplemental: row.is_supplemental === true,
    status: String(row.status),
    odClaimPaymentNum: row.od_claim_payment_num == null ? null : Number(row.od_claim_payment_num),
    readback: row.readback || null,
    skipReason: row.skip_reason == null ? null : String(row.skip_reason),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

/**
 * Load a plan and everything needed to judge it: the queue row, its lines, the
 * claims linked to it, and the batch the money came on.
 *
 * Office-scoped on every table. A plan is unreachable from the wrong office
 * rather than refused there — the same idiom every other RCM read uses.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @param {string} queueId
 */
async function loadPlan(pool, office, queueId) {
  const q = await pool.query(
    `SELECT ${QUEUE_COLUMNS.join(', ')} FROM rcm_posting_queue ` +
      `WHERE queue_id = $1 AND office_id = $2`,
    [queueId, office]
  );
  if (q.rows.length === 0) return null;
  const queue = toQueue(q.rows[0]);

  const l = await pool.query(
    `SELECT ${LINE_COLUMNS.join(', ')} FROM rcm_posting_queue_line ` +
      `WHERE queue_id = $1 AND office_id = $2 ORDER BY position`,
    [queueId, office]
  );

  const c = await pool.query(
    `SELECT claim_id, office_id, od_match_status, od_claim_num, posting_queue_id, ` +
      `od_match_snapshot, claim_number FROM rcm_claims WHERE posting_queue_id = $1`,
    [queueId]
  );

  const b = await pool.query(
    `SELECT batch_id, payer, check_number, eft_number, payment_method, deposit_date ` +
      `FROM rcm_payment_batches WHERE batch_id = $1 AND office_id = $2`,
    [queue.batchId, office]
  );

  return {
    queue,
    lines: l.rows.map(toLine),
    claims: c.rows.map((row) => {
      // The version is read in JS rather than with a `->>` cast so the same
      // query runs against the test double, and so a snapshot that is not an
      // object reads as "no version" instead of throwing inside Postgres.
      const snap = row.od_match_snapshot;
      const version =
        snap && typeof snap === 'object' && snap.version !== undefined ? Number(snap.version) : null;
      return {
        claimId: String(row.claim_id),
        officeId: String(row.office_id),
        odMatchStatus: String(row.od_match_status || ''),
        odClaimNum: row.od_claim_num == null ? null : Number(row.od_claim_num),
        postingQueueId: row.posting_queue_id == null ? null : String(row.posting_queue_id),
        snapshotVersion: Number.isFinite(version) ? version : null,
        claimNumber: row.claim_number == null ? null : String(row.claim_number),
      };
    }),
    batch: b.rows.length
      ? {
          batchId: String(b.rows[0].batch_id),
          payer: b.rows[0].payer == null ? null : String(b.rows[0].payer),
          checkNumber: b.rows[0].check_number == null ? null : String(b.rows[0].check_number),
          eftNumber: b.rows[0].eft_number == null ? null : String(b.rows[0].eft_number),
          paymentMethod: b.rows[0].payment_method == null ? null : String(b.rows[0].payment_method),
          depositDate: asOdDate(b.rows[0].deposit_date),
        }
      : null,
  };
}

/**
 * Take the row, or find out somebody else has it.
 *
 * A compare-and-set, not a read-then-write: the `WHERE status = ANY(...)` is
 * what makes the claim atomic, so a second runner that reached here first simply
 * matches no row. The same idiom `confirmMatch` and the 6b enqueue use, and the
 * reason neither of them needs a lock.
 *
 * `attempt_count` increments here so a row that fails repeatedly says how many
 * times it has been tried without anything else having to count.
 *
 * @returns {Promise<boolean>} true when this process now owns the row
 */
async function claimRow(pool, office, queueId, drainedBy) {
  const res = await pool.query(
    `UPDATE rcm_posting_queue
        SET status = 'posting',
            drain_step = $4,
            drain_attempt_at = now(),
            drained_by = $5,
            started_at = COALESCE(started_at, now()),
            attempt_count = attempt_count + 1,
            blocked_reason = NULL,
            last_error = NULL,
            finished_at = NULL,
            updated_at = now()
      WHERE queue_id = $1 AND office_id = $2 AND status = ANY($3)
      RETURNING queue_id`,
    [queueId, office, [...DRAINABLE_STATUSES], STEPS[0], drainedBy]
  );
  return res.rows.length > 0;
}

/** Move the row's step cursor. One statement, before the call it precedes. */
async function persistStep(pool, queueId, step) {
  await pool.query(
    'UPDATE rcm_posting_queue SET drain_step = $2, updated_at = now() WHERE queue_id = $1',
    [queueId, step]
  );
}

/**
 * Write one line's transition.
 *
 * Built from an explicit whitelist of columns rather than by spreading a patch
 * object: this is the table that records what happened to a patient's money, and
 * a typo'd key silently doing nothing is the failure mode to design out.
 *
 * @param {{ query: Function }} pool
 * @param {string} queueLineId
 * @param {{ status?: string, claimprocWrittenAt?: boolean, claimReceivedAt?: boolean,
 *           paidAt?: boolean, odClaimPaymentNum?: number|null, readback?: object|null,
 *           lastError?: string|null, skipReason?: string|null }} patch
 */
async function persistLine(pool, queueLineId, patch) {
  const sets = [];
  const params = [queueLineId];
  const put = (sql, value) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };

  if (patch.status !== undefined) put('status', patch.status);
  if (patch.odClaimPaymentNum !== undefined) put('od_claim_payment_num', patch.odClaimPaymentNum);
  if (patch.lastError !== undefined) put('last_error', patch.lastError);
  if (patch.skipReason !== undefined) put('skip_reason', patch.skipReason);
  if (patch.readback !== undefined) {
    put('readback', patch.readback === null ? null : JSON.stringify(patch.readback));
    sets.push('readback_at = now()');
  }
  // The three timestamps are set to now() rather than passed in, so the recorded
  // time is the database's and cannot drift with a container's clock.
  if (patch.claimprocWrittenAt) sets.push('claimproc_written_at = now()');
  if (patch.claimReceivedAt) sets.push('claim_received_at = now()');
  if (patch.paidAt) sets.push('paid_at = now()');

  sets.push('updated_at = now()');
  await pool.query(
    `UPDATE rcm_posting_queue_line SET ${sets.join(', ')} WHERE queue_line_id = $1`,
    params
  );
}

/**
 * Refuse the row, naming why, with nothing having been sent to Open Dental.
 *
 * `finished_at` IS stamped: a blocked row is finished for now — the run is over
 * and the next move is a human's. Leaving it null would render as "still
 * running" on a screen whose whole job is to be honest about that.
 */
async function blockRow(pool, queueId, reason, detail, step) {
  await pool.query(
    `UPDATE rcm_posting_queue
        SET status = 'blocked', blocked_reason = $2, last_error = $3, drain_step = $4,
            finished_at = now(), updated_at = now()
      WHERE queue_id = $1`,
    [queueId, reason, detail ? String(detail).slice(0, 1000) : null, step]
  );
}

/**
 * End the row in one of the three terminal execution states.
 *
 * `posted` carries both proofs and the migration's CHECK refuses it without
 * them. `partially_posted` carries whatever proof exists — a check number
 * without a reconciliation is exactly what that state is for.
 */
async function finalizeRow(pool, queueId, outcome) {
  /*
   * The check number is only ASSIGNED when this run has one. A `null` in the
   * column would erase the proof that money landed — the very thing a resume
   * needs to find an existing check and adopt it rather than create a second —
   * so the assignment is omitted rather than nulled.
   *
   * `reconciled_at` is the opposite: it is set to a value or to NULL every time,
   * because it means "the reconciliation read matched ON THIS ATTEMPT". Carrying
   * a stale one forward past a failed reconciliation would let the migration's
   * `posted` CHECK be satisfied by evidence from a previous run.
   */
  const sets = [
    'status = $2',
    'reconciled_at = $3',
    'posted_total_cents = $4',
    'last_error = $5',
    'drain_step = $6',
    'finished_at = now()',
    'updated_at = now()',
  ];
  const params = [
    queueId,
    outcome.status,
    outcome.reconciled === true ? new Date() : null,
    Number(outcome.postedTotalCents || 0),
    outcome.lastError ? String(outcome.lastError).slice(0, 1000) : null,
    outcome.step,
  ];
  if (outcome.odClaimPaymentNum != null) {
    params.push(outcome.odClaimPaymentNum);
    sets.push(`od_claim_payment_num = $${params.length}`);
  }

  await pool.query(
    `UPDATE rcm_posting_queue SET ${sets.join(', ')} WHERE queue_id = $1`,
    params
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

/**
 * One audit row per Open Dental call the drain makes — reads included.
 *
 * FAIL-CLOSED, and the consequence is deliberate: a failed audit write THROWS,
 * which aborts the row mid-sequence and leaves it `partially_posted` with
 * whatever it had already proven. That is the correct outcome. The alternative —
 * carrying on writing to a chart with no recorded trail — is the exact thing
 * hard rule 5 forbids, and resume re-reads Open Dental anyway, so the abort
 * costs a retry rather than correctness.
 *
 * `resourceId` is the Open Dental identifier the call touched. It is an
 * identifier, not patient data — the same judgement that puts `office` on every
 * row — and without it the trail could say a chart was written but not which.
 *
 * @param {import('express').Request} req
 * @param {{ action: 'READ'|'CREATE'|'UPDATE', resourceType: string,
 *           resourceId: string|number|null, office: string, result?: string }} entry
 */
async function auditOd(req, entry) {
  await auditModule.audit(req, {
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId === undefined ? null : entry.resourceId,
    result: entry.result || 'SUCCESS',
    office: entry.office,
    sourceRef: null,
  });
}

// ─── The row sequence ────────────────────────────────────────────────────────

/**
 * Drain ONE plan: the forced order, verified, resumable.
 *
 * Returns an outcome rather than throwing, because a failed row must not stop
 * the office's queue — the next row may be fine, and a drain that aborts the
 * whole run on one bad plan makes a single unfixable remittance block every
 * other one indefinitely.
 *
 * @param {{ pool: any, req: any, office: string, od: any, config: any,
 *           snapshotVersion: number, operator: string, drainedBy: string }} ctx
 * @param {string} queueId
 * @returns {Promise<{ queueId: string, status: string, reason?: string,
 *                     odClaimPaymentNum?: number|null, detail?: string }>}
 */
async function drainRow(ctx, queueId) {
  const { pool, req, office, od } = ctx;
  let step = STEPS[0];

  const plan = await loadPlan(pool, office, queueId);
  if (!plan) return { queueId, status: 'not_found' };

  /*
   * PRE-FLIGHT, BEFORE ANY OPEN DENTAL CALL.
   *
   * Note what is NOT consulted here: the environment guard is read live rather
   * than passed in, because a plan loaded a minute ago says nothing about the
   * process's current configuration.
   */
  const blocked = checkPreconditions({
    queue: plan.queue,
    lines: plan.lines,
    claims: plan.claims,
    office,
    odWritesDisabled: require('../../middleware/envGuards').isOdWriteDisabled(),
    snapshotVersion: ctx.snapshotVersion,
  });
  if (blocked) {
    await blockRow(pool, queueId, blocked.reason, blocked.detail, step);
    return { queueId, status: 'blocked', reason: blocked.reason, detail: blocked.detail };
  }

  const grouped = groupByClaim(plan.lines);
  /** @type {Map<string, {action: string, checkNum?: number}>} */
  const decisions = new Map();
  /** Every distinct check number the chart already shows on our own lines. */
  const adoptable = new Set();
  let postedTotalCents = 0;

  try {
    // ── STEP: read Open Dental's truth, before deciding anything ────────────
    //
    // Rule 3. This runs on EVERY attempt, not only on a resume, because "first
    // attempt" is not a thing the machine can know: a process that died between
    // the first PUT and its first persist looks exactly like a fresh start.
    step = 'read_od_truth';
    await persistStep(pool, queueId, step);

    /** @type {Map<number, Record<string, unknown>[]>} */
    const claimProcsByClaim = new Map();
    /** @type {Map<number, Record<string, unknown>>} */
    const claimByNum = new Map();

    for (const group of grouped) {
      const claimRow_ = await odPostingWrites.readClaim(od, group.odClaimNum);
      await auditOd(req, {
        action: 'READ',
        resourceType: 'rcm_od_claim',
        resourceId: group.odClaimNum,
        office,
      });
      claimByNum.set(group.odClaimNum, claimRow_);

      const procs = await odPostingWrites.readClaimProcsForClaim(od, group.odClaimNum);
      await auditOd(req, {
        action: 'READ',
        resourceType: 'rcm_od_claimproc',
        resourceId: group.odClaimNum,
        office,
      });
      claimProcsByClaim.set(group.odClaimNum, procs);
    }

    /*
     * If we already hold a check number, read what is on it. This is the second
     * half of rule 4: `od_claim_payment_num` says a check exists, and this read
     * says what it contains — the only way to tell "our run finished and the
     * process died before it could say so" from "a check exists that is not ours".
     */
    if (plan.queue.odClaimPaymentNum) {
      await odPostingWrites.readClaimProcsForPayment(od, plan.queue.odClaimPaymentNum);
      await auditOd(req, {
        action: 'READ',
        resourceType: 'rcm_od_claimpayment',
        resourceId: plan.queue.odClaimPaymentNum,
        office,
      });
      adoptable.add(plan.queue.odClaimPaymentNum);
    }

    // Decide, per line, from the chart.
    for (const group of grouped) {
      const procs = claimProcsByClaim.get(group.odClaimNum) || [];
      for (const line of group.lines) {
        const row = procs.find((p) => Number(p.ClaimProcNum) === line.odClaimProcNum);
        const decision = decideLineAction(line, row);
        decisions.set(line.queueLineId, decision);
        if (decision.action === 'attached' && decision.checkNum) adoptable.add(decision.checkNum);
      }
    }

    /*
     * A CONFLICT IS A REFUSAL OF THE WHOLE ROW, NOT OF ONE LINE.
     *
     * The unit Open Dental adjudicated is the claim, and the eligible-total rule
     * makes the check a statement about ALL of a claim's unattached lines. If one
     * line's money in the chart is not ours, posting the rest would assert a
     * CheckAmt over a set we do not understand — and the refusal we would get is
     * a 400 in the §8 window rather than a clean stop here.
     */
    const conflicted = plan.lines.filter((l) => decisions.get(l.queueLineId).action === 'conflict');
    if (conflicted.length > 0) {
      for (const line of conflicted) {
        await persistLine(pool, line.queueLineId, {
          status: 'failed',
          readback: {
            step: 'read_od_truth',
            agreed: false,
            mismatches: decisions.get(line.queueLineId).mismatches || [],
          },
          lastError: 'Open Dental holds different amounts for this line than this plan intends.',
        });
      }
      await finalizeRow(pool, queueId, {
        status: 'failed',
        postedTotalCents: 0,
        lastError:
          `${conflicted.length} line(s) already carry different amounts in Open Dental. ` +
          'Nothing was written. Re-match and re-approve, or resolve the chart first.',
        step,
      });
      return { queueId, status: 'failed', reason: 'od_conflict' };
    }

    /*
     * THE ELIGIBLE-TOTAL PRE-CHECK, BEFORE THE FIRST WRITE.
     *
     * `POST /claimpayments` refuses unless `CheckAmt` equals the total of the
     * ClaimProcs *"with ClaimPaymentNum=0"* (test 5, verbatim: `400 "CheckAmt
     * does not match the total of eligible ClaimProcs."`). Eligibility is a
     * property of the CHART, not of our plan — so a claim carrying another
     * unposted line that this plan never knew about makes our number wrong.
     *
     * IT IS CHECKED HERE RATHER THAN AT THE CHECK STEP, and that placement is the
     * whole point. Discovering it after the claimproc writes and the claim
     * receipts would leave the chart in the §8 window — lines Received, money on
     * them, no check — over a condition that was already visible in the read
     * above. Discovering it now costs nothing and the plan blocks having written
     * nothing at all, which is what `blocked` promises.
     *
     * Only FOREIGN eligible money counts. Our own lines are what we are about to
     * write; a foreign line that is unreceived or zero contributes nothing to
     * the total and is not a problem.
     */
    const plannedProcNums = new Set(plan.lines.map((l) => l.odClaimProcNum));
    let foreignEligibleCents = 0;
    for (const group of grouped) {
      for (const row of claimProcsByClaim.get(group.odClaimNum) || []) {
        if (plannedProcNums.has(Number(row.ClaimProcNum))) continue;
        if (odPostingWrites.attachedCheckNum(row) > 0) continue;
        const cents = odPostingWrites.dollarsToCents(row.InsPayAmt);
        if (cents) foreignEligibleCents += cents;
      }
    }
    if (foreignEligibleCents !== 0) {
      await blockRow(
        pool,
        queueId,
        BLOCK_REASONS.ELIGIBLE_TOTAL_MISMATCH,
        `These claims carry ${foreignEligibleCents} cents of insurance payment that this plan ` +
          `did not put there and no check has taken. Open Dental would refuse a check for ` +
          `${plan.queue.intendedTotalCents} cents. NOTHING was written. Resolve the extra line ` +
          'in the chart, then drain again.',
        step
      );
      return { queueId, status: 'blocked', reason: BLOCK_REASONS.ELIGIBLE_TOTAL_MISMATCH };
    }

    // ── STEP: per-line claimproc writes ─────────────────────────────────────
    step = 'claimproc_writes';
    await persistStep(pool, queueId, step);

    for (const group of grouped) {
      for (const line of group.lines) {
        const decision = decisions.get(line.queueLineId);

        if (decision.action === 'skip') {
          // Already Received with our exact amounts. Recorded as its own state
          // with its own reason — see the migration's note on why this is not
          // folded into `skipped`.
          await persistLine(pool, line.queueLineId, {
            status: 'skipped_already_posted',
            skipReason: SKIP_ALREADY_RECEIVED,
            lastError: null,
          });
          postedTotalCents += line.intendedInsPayAmtCents;
          continue;
        }

        if (decision.action === 'attached') {
          // On a check already. Never PUT again (test 11) and never re-billed.
          await persistLine(pool, line.queueLineId, {
            status: 'paid',
            odClaimPaymentNum: decision.checkNum,
            paidAt: true,
            lastError: null,
          });
          postedTotalCents += line.intendedInsPayAmtCents;
          continue;
        }

        const { verdict } = await odPostingWrites.writeClaimProcReceived(od, {
          claimNum: group.odClaimNum,
          claimProcNum: line.odClaimProcNum,
          insPayAmtCents: line.intendedInsPayAmtCents,
          writeOffCents: line.intendedWriteOffCents,
          dedAppliedCents: line.intendedDedAppliedCents,
        });
        await auditOd(req, {
          action: 'UPDATE',
          resourceType: 'rcm_od_claimproc',
          resourceId: line.odClaimProcNum,
          office,
          result: verdict.agreed ? 'SUCCESS' : 'ERROR',
        });
        /*
         * THE READ-BACK GETS ITS OWN ROW.
         *
         * It is a second disclosure of a patient's claim data, one call after the
         * write, and rule 13 is "one row per PHI read AND per write" — not "per
         * operation". Folding it into the UPDATE above would under-count reads on
         * exactly the report the trail exists to produce, and would leave no
         * record that a verification happened at all.
         */
        await auditOd(req, {
          action: 'READ',
          resourceType: 'rcm_od_claimproc',
          resourceId: group.odClaimNum,
          office,
        });

        if (!verdict.agreed) {
          /*
           * G2 IN ACTION. The PUT returned 200; the read-back disagrees. This is
           * a failure of the step, and the disagreement is what gets stored — not
           * "OD write failed", which would tell nobody which field lied.
           */
          await persistLine(pool, line.queueLineId, {
            status: 'failed',
            readback: { step: 'claimproc_write', ...verdict },
            lastError:
              'Open Dental accepted the write but read back different values: ' +
              verdict.mismatches.map((m) => m.field).join(', '),
          });
          throw new OdWriteError(
            `claimproc ${line.odClaimProcNum} read back different values`,
            'OD_READBACK_MISMATCH',
            { status: 200, retryable: false }
          );
        }

        await persistLine(pool, line.queueLineId, {
          status: 'claimproc_written',
          claimprocWrittenAt: true,
          readback: { step: 'claimproc_write', ...verdict },
          lastError: null,
        });
        postedTotalCents += line.intendedInsPayAmtCents;
      }
    }

    // ── STEP: per-claim receipt ─────────────────────────────────────────────
    step = 'claim_receipts';
    await persistStep(pool, queueId, step);

    const note = odPostingWrites.buildPostingNote({
      queueId,
      operator: ctx.operator,
      carrierEobDate: plan.queue.carrierEobDate,
    });

    for (const group of grouped) {
      const existing = claimByNum.get(group.odClaimNum);
      const alreadyReceived =
        existing && String(existing.ClaimStatus || '').trim() === 'R';

      /*
       * `DateReceived` from the carrier's own EOB date when we have one. See
       * `writeClaimReceived`'s header for why, and note the fallback is the
       * OFFICE's today rather than the container's.
       */
      const dateReceived = plan.queue.carrierEobDate || officeToday();
      const claimNote = odPostingWrites.appendClaimNote(existing && existing.ClaimNote, note, queueId);

      if (alreadyReceived && claimNote === null) {
        // Received already, and our note is already on it — this claim is done.
        // Skipping the PUT is not an optimisation: re-issuing it is a chart write
        // with nothing to change, and every avoidable chart write is one fewer
        // chance to disturb an income transfer.
      } else {
        const { verdict } = await odPostingWrites.writeClaimReceived(od, {
          claimNum: group.odClaimNum,
          dateReceived,
          note: claimNote,
        });
        await auditOd(req, {
          action: 'UPDATE',
          resourceType: 'rcm_od_claim',
          resourceId: group.odClaimNum,
          office,
          result: verdict.agreed ? 'SUCCESS' : 'ERROR',
        });
        // Its read-back, for the same reason as the claimproc's above.
        await auditOd(req, {
          action: 'READ',
          resourceType: 'rcm_od_claim',
          resourceId: group.odClaimNum,
          office,
        });
        if (!verdict.agreed) {
          throw new OdWriteError(
            `claim ${group.odClaimNum} read back ` +
              verdict.mismatches.map((m) => m.field).join(', '),
            'OD_READBACK_MISMATCH',
            { status: 200, retryable: false }
          );
        }
      }

      /*
       * The claim is received, so every line this run WROTE advances.
       *
       * A line that was `attached` is already `paid` and a line that was `skip`
       * already carries `skipped_already_posted` — both are terminal for this
       * run, and moving them back to `claim_received` would erase the record
       * that the resume decided not to touch them.
       */
      for (const line of group.lines) {
        const action = decisions.get(line.queueLineId).action;
        if (action === 'attached' || action === 'skip') continue;
        await persistLine(pool, line.queueLineId, { status: 'claim_received', claimReceivedAt: true });
      }
    }

    // ── STEP: the check ─────────────────────────────────────────────────────
    step = 'check';
    await persistStep(pool, queueId, step);

    let claimPaymentNum = plan.queue.odClaimPaymentNum;

    /*
     * RULE 4: ADOPT BEFORE CREATING.
     *
     * If the chart already shows our own lines on a check, that check IS this
     * plan's check — created by an earlier attempt that died before it could
     * record the number. Creating another would give the practice two checks for
     * one carrier payment and a deposit that cannot be reconciled. There is no
     * path below that reaches the POST with a check already in hand.
     */
    if (!claimPaymentNum && adoptable.size === 1) {
      claimPaymentNum = [...adoptable][0];
    } else if (!claimPaymentNum && adoptable.size > 1) {
      throw new OdWriteError(
        `this plan's lines are spread across ${adoptable.size} different checks in Open Dental`,
        'OD_MULTIPLE_CHECKS',
        { status: 0, retryable: false }
      );
    }

    if (!claimPaymentNum) {
      /*
       * THE ELIGIBLE TOTAL, RE-VERIFIED AGAINST THE CHART WE JUST WROTE.
       *
       * The condition was already checked before the first write, where a
       * mismatch is `blocked` and costs nothing. This second read is what proves
       * OUR OWN writes produced the total we are about to assert — G2 again: the
       * PUTs each read back agreeing, but the SUM is a different claim from any
       * one of them, and `POST /claimpayments` is about the sum.
       *
       * A disagreement here is NOT `blocked`. Money is on the chart: the lines
       * are Received and the claims say `R`. That is the §8 window, and
       * `partially_posted` is the state that exists to describe it. Calling it
       * `blocked` — which promises nothing was attempted — would be the
       * honest-states rule failing at the most expensive moment in the module.
       *
       * Read fresh: the claimproc writes above changed exactly these values.
       */
      let eligibleCents = 0;
      for (const group of grouped) {
        const procs = await odPostingWrites.readClaimProcsForClaim(od, group.odClaimNum);
        await auditOd(req, {
          action: 'READ',
          resourceType: 'rcm_od_claimproc',
          resourceId: group.odClaimNum,
          office,
        });
        eligibleCents += odPostingWrites.eligibleTotalCents(procs);
      }

      if (eligibleCents !== plan.queue.intendedTotalCents) {
        await finalizeRow(pool, queueId, {
          status: 'partially_posted',
          odClaimPaymentNum: null,
          reconciled: false,
          postedTotalCents,
          lastError:
            `Open Dental's eligible total for these claims is ${eligibleCents} cents; this plan ` +
            `intends ${plan.queue.intendedTotalCents}. The lines ARE written and the claims ARE ` +
            'received; no check was created. Resolve the extra or missing line in the chart, then ' +
            'drain again — the resume re-reads Open Dental and will not re-write what is already there.',
          step,
        });
        return {
          queueId,
          status: 'partially_posted',
          reason: BLOCK_REASONS.ELIGIBLE_TOTAL_MISMATCH,
        };
      }

      const method = plan.batch && plan.batch.paymentMethod === 'eft' ? 'eft' : 'check';
      const payType = odOfficeConfig.pickPayType(ctx.config, method);
      if (!payType) {
        await blockRow(
          pool,
          queueId,
          BLOCK_REASONS.NO_PAY_TYPE,
          `This practice's Open Dental has no insurance payment type named for '${method}' ` +
            `(definitions Category 32). No check was created.`,
          step
        );
        return { queueId, status: 'blocked', reason: BLOCK_REASONS.NO_PAY_TYPE };
      }

      const endpoint = odOfficeConfig.resolveCheckEndpoint(ctx.config, grouped.length);
      const created = await odPostingWrites.writeClaimPayment(od, {
        endpoint,
        claimNums: grouped.map((g) => g.odClaimNum),
        checkAmtCents: plan.queue.intendedTotalCents,
        payTypeDefNum: payType.defNum,
        checkNumber: plan.batch ? plan.batch.checkNumber || plan.batch.eftNumber : null,
        checkDate: (plan.batch && plan.batch.depositDate) || plan.queue.carrierEobDate,
        carrierName: plan.batch ? plan.batch.payer : null,
        note,
      });
      claimPaymentNum = created.claimPaymentNum;

      await auditOd(req, {
        action: 'CREATE',
        resourceType: 'rcm_od_claimpayment',
        resourceId: claimPaymentNum,
        office,
      });

      /*
       * THE CHECK NUMBER IS PERSISTED IMMEDIATELY, BEFORE THE RECONCILIATION
       * READ. This is the narrowest and most expensive window in the sequence: a
       * process that died between the 201 and this statement would leave a real
       * check in the practice's books that our plan had never heard of, and the
       * next attempt would have to find it by inference. One statement closes it.
       */
      await pool.query(
        'UPDATE rcm_posting_queue SET od_claim_payment_num = $2, updated_at = now() WHERE queue_id = $1',
        [queueId, claimPaymentNum]
      );
    }

    // ── STEP: reconciliation ────────────────────────────────────────────────
    step = 'reconcile';
    await persistStep(pool, queueId, step);

    const attachedRows = await odPostingWrites.readClaimProcsForPayment(od, claimPaymentNum);
    await auditOd(req, {
      action: 'READ',
      resourceType: 'rcm_od_claimpayment',
      resourceId: claimPaymentNum,
      office,
    });

    const reconciliation = odPostingWrites.reconcileCheck(
      attachedRows,
      plan.lines.map((l) => ({
        odClaimProcNum: l.odClaimProcNum,
        intendedInsPayAmtCents: l.intendedInsPayAmtCents,
      }))
    );

    for (const line of plan.lines) {
      const onCheck = attachedRows.some(
        (r) => Number(r.ClaimProcNum) === line.odClaimProcNum
      );
      if (!onCheck) continue;
      await persistLine(pool, line.queueLineId, {
        status: 'paid',
        paidAt: true,
        odClaimPaymentNum: claimPaymentNum,
        lastError: null,
      });
    }

    if (!reconciliation.matched) {
      /*
       * A CHECK EXISTS AND IT IS NOT WHAT WE PLANNED.
       *
       * `partially_posted` with the exact positions, per rule 11. Not `failed`:
       * money HAS moved and a state that reads as "nothing happened" would send a
       * biller looking for a payment that is sitting in the chart.
       */
      await finalizeRow(pool, queueId, {
        status: 'partially_posted',
        odClaimPaymentNum: claimPaymentNum,
        reconciled: false,
        postedTotalCents: reconciliation.attachedTotalCents,
        lastError:
          `Check ${claimPaymentNum} does not carry exactly this plan's lines — ` +
          `missing [${reconciliation.missing.join(', ')}], ` +
          `unexpected [${reconciliation.unexpected.join(', ')}], ` +
          `${reconciliation.amountMismatches.length} amount disagreement(s).`,
        step,
      });
      return {
        queueId,
        status: 'partially_posted',
        odClaimPaymentNum: claimPaymentNum,
        reason: 'reconciliation_mismatch',
      };
    }

    /*
     * DOCUMENT ATTACH IS 6d's, AND THE STEP SAYS SO RATHER THAN VANISHING.
     *
     * The plan is `posted` — the money is correct and proven — and the EOB PDF is
     * not yet in the patient's images. §8 puts the document last precisely
     * because *"a document failure is retryable and never a financial error"*, so
     * a posted plan with an unfiled EOB is an honest and complete description of
     * what happened.
     */
    await finalizeRow(pool, queueId, {
      status: 'posted',
      odClaimPaymentNum: claimPaymentNum,
      reconciled: true,
      postedTotalCents: reconciliation.attachedTotalCents,
      lastError: null,
      step: 'document_attach',
    });

    return { queueId, status: 'posted', odClaimPaymentNum: claimPaymentNum };
  } catch (err) {
    /*
     * WHERE IT FAILED DECIDES WHAT THE ROW SAYS.
     *
     * Before the first claimproc write, nothing moved — `failed`, and the next
     * attempt starts clean. At or after it, something may have, so the row must
     * say `partially_posted` and let resume find out from the chart. Guessing
     * `failed` because an exception was thrown would be the honest-states rule
     * failing at the only moment it costs money.
     */
    const touchedChart = ['claimproc_writes', 'claim_receipts', 'check', 'reconcile'].includes(step);
    const message = err instanceof OdWriteError ? `${err.message}: ${err.detail}` : String(err && err.message ? err.message : err);
    console.error(`[rcm/drain] ${office} plan ${queueId} failed at ${step}: ${message}`);

    await finalizeRow(pool, queueId, {
      status: touchedChart ? 'partially_posted' : 'failed',
      odClaimPaymentNum: null,
      reconciled: false,
      postedTotalCents: touchedChart ? postedTotalCents : 0,
      lastError: message,
      step,
    });
    return { queueId, status: touchedChart ? 'partially_posted' : 'failed', detail: message };
  }
}

// ─── The office loop ─────────────────────────────────────────────────────────

/**
 * Drain what is waiting for one office, bounded.
 *
 * SERIAL AND SINGLE. The mutex is process-wide (see the header); a second press
 * gets `DRAIN_ALREADY_RUNNING` rather than a second loop.
 *
 * The office's runtime configuration is resolved ONCE per run rather than per
 * row: five paced reads at ≥1.2 s is six seconds of a budget that exists to be
 * spent on posting, and definitions do not change inside one run.
 *
 * @param {{ pool: any, req: any, office: string, operator: string, drainedBy: string,
 *           snapshotVersion: number, budgetMs?: number, now?: () => number,
 *           transport?: any }} ctx
 * @returns {Promise<{ ran: number, outcomes: object[], outOfTime: boolean,
 *                     remaining: number, config?: object }>}
 */
async function drainOffice(ctx) {
  if (DRAIN_MUTEX.running) {
    const err = new Error('a posting drain is already running in this process');
    err.code = 'DRAIN_ALREADY_RUNNING';
    err.office = DRAIN_MUTEX.office;
    throw err;
  }

  const clock = ctx.now || (() => Date.now());
  const budgetMs = Number.isFinite(ctx.budgetMs) && ctx.budgetMs > 0 ? ctx.budgetMs : DEFAULT_BUDGET_MS;
  const deadline = clock() + budgetMs;

  DRAIN_MUTEX.running = true;
  DRAIN_MUTEX.since = new Date().toISOString();
  DRAIN_MUTEX.office = ctx.office;

  /** @type {object[]} */
  const outcomes = [];
  let outOfTime = false;

  try {
    /*
     * `onlyQueueId` NARROWS, it never widens.
     *
     * It is an extra `AND queue_id = $3` on the same office-scoped, same
     * status-filtered query — so a plan in another office, or one in `blocked`,
     * is simply not selected rather than specially handled. A request cannot
     * name its way into anything the unfiltered run would not have drained.
     *
     * A MALFORMED id is an empty run, not an unfiltered one. `asUuidOrNull`
     * returns null for junk, and null is the sentinel that means "no narrowing"
     * — so passing the sentinel straight through would turn `{queueId: "../.."}`
     * into "drain the whole office". Caught here rather than trusted.
     */
    if (ctx.onlyQueueId != null && asUuidOrNull(ctx.onlyQueueId) === null) {
      return { ran: 0, outcomes, outOfTime: false, remaining: 0 };
    }

    const narrowed = asUuidOrNull(ctx.onlyQueueId);
    const waiting = narrowed
      ? await ctx.pool.query(
          `SELECT queue_id FROM rcm_posting_queue ` +
            `WHERE office_id = $1 AND queue_id = $3 AND status = ANY($2) ` +
            `ORDER BY approved_at ASC`,
          [ctx.office, [...DRAINABLE_STATUSES], narrowed]
        )
      : await ctx.pool.query(
          `SELECT queue_id FROM rcm_posting_queue ` +
            `WHERE office_id = $1 AND status = ANY($2) ` +
            `ORDER BY approved_at ASC`,
          [ctx.office, [...DRAINABLE_STATUSES]]
        );
    const queueIds = waiting.rows.map((r) => String(r.queue_id));
    if (queueIds.length === 0) {
      return { ran: 0, outcomes, outOfTime: false, remaining: 0 };
    }

    /*
     * D-7 AGAIN, ONE LEVEL UP.
     *
     * A disabled office never reaches `resolvePostingConfig`, so a valley run
     * makes no Open Dental call at all — not even a read of Riley's definitions.
     * `checkPreconditions` would have caught it per row anyway; refusing here as
     * well is what makes "no roland fallback" true of the transport and not only
     * of the state machine. Each row is still individually marked `blocked`, so
     * the queue says why rather than merely staying still.
     */
    if (!OFFICES_ENABLED_FOR_POSTING.includes(ctx.office)) {
      for (const queueId of queueIds) {
        const taken = await claimRow(ctx.pool, ctx.office, queueId, ctx.drainedBy);
        if (!taken) continue;
        await blockRow(
          ctx.pool,
          queueId,
          BLOCK_REASONS.VALLEY_NOT_ENABLED,
          `Posting is not enabled for '${ctx.office}' yet (D-7). No Open Dental call was made.`,
          STEPS[0]
        );
        outcomes.push({ queueId, status: 'blocked', reason: BLOCK_REASONS.VALLEY_NOT_ENABLED });
      }
      return { ran: outcomes.length, outcomes, outOfTime: false, remaining: 0 };
    }

    const od = ctx.transport || odPostingWrites.postingTransportFor(ctx.office);

    /*
     * Configuration first, and a failure here blocks every row rather than
     * failing them. Nothing was attempted, so nothing failed — and marking twenty
     * plans `failed` because a definitions read timed out would put twenty rows
     * into a state that means "something went wrong mid-posting".
     */
    let config;
    try {
      const resolved = await odOfficeConfig.resolvePostingConfig(od.get, ctx.office);
      config = resolved.config;
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      for (const queueId of queueIds) {
        const taken = await claimRow(ctx.pool, ctx.office, queueId, ctx.drainedBy);
        if (!taken) continue;
        await blockRow(
          ctx.pool,
          queueId,
          BLOCK_REASONS.OFFICE_CONFIG_UNRESOLVED,
          detail,
          STEPS[0]
        );
        outcomes.push({
          queueId,
          status: 'blocked',
          reason: BLOCK_REASONS.OFFICE_CONFIG_UNRESOLVED,
        });
      }
      return { ran: outcomes.length, outcomes, outOfTime: false, remaining: 0 };
    }

    for (let i = 0; i < queueIds.length; i++) {
      /*
       * THE BUDGET IS CHECKED HERE AND NOWHERE ELSE — between rows, never inside
       * one. A row that has begun finishes or fails with a record of where it
       * got to; stopping halfway would deliberately create the §8 window this
       * whole design exists to survive.
       */
      if (clock() >= deadline) {
        outOfTime = true;
        return {
          ran: outcomes.length,
          outcomes,
          outOfTime,
          remaining: queueIds.length - i,
          config: describeConfig(config),
        };
      }

      const queueId = queueIds[i];
      const taken = await claimRow(ctx.pool, ctx.office, queueId, ctx.drainedBy);
      if (!taken) {
        // Its status moved between the scan and here. Not an error — somebody
        // else's approve, or a blocked row somebody resolved. Skip it silently
        // rather than reporting an outcome that did not happen.
        continue;
      }

      outcomes.push(await drainRow({ ...ctx, od, config }, queueId));
    }

    return {
      ran: outcomes.length,
      outcomes,
      outOfTime,
      remaining: 0,
      config: describeConfig(config),
    };
  } finally {
    DRAIN_MUTEX.running = false;
    DRAIN_MUTEX.since = null;
    DRAIN_MUTEX.office = null;
  }
}

/**
 * The office's resolved configuration, as a screen may see it.
 *
 * DefNums and preference values are practice CONFIGURATION, not patient data,
 * and showing which PayType a check was posted under is exactly what makes the
 * per-office rule auditable by the person who owns both practices.
 */
function describeConfig(config) {
  if (!config) return null;
  return {
    officeKey: config.officeKey,
    resolvedAt: config.resolvedAt,
    payTypes: config.payTypes.map((p) => ({ defNum: p.defNum, name: p.name })),
    adjTypeCount: config.adjTypes.length,
    docCategoryCount: config.docCategories.length,
    prefs: config.prefs,
    filterHonored: config.filterHonored,
  };
}

/**
 * Re-home rows a dead process left mid-flight. Mirrors `eobStartupSweep.js`
 * exactly, and carries the same two load-bearing conditions.
 *
 * IT DOES NOT DRAIN. A `posting` row becomes `approved` again and waits for a
 * human to press the button. Auto-draining on boot would make a container
 * restart a chart write nobody asked for, which is the opposite of every rule in
 * this module.
 *
 * Safe only because (1) it runs BEFORE `server.listen()`, so no request served
 * by this process can have set a row to `posting` yet, and (2) the app runs at
 * maxReplicas = 1. Under a second replica this would re-home replica A's genuinely
 * in-flight run and A would then post against a row that says it is waiting. A
 * timestamp filter does not fix that; a lease does, and that is the work to do
 * before raising maxReplicas.
 *
 * @param {{ registry?: unknown, tenantDb?: unknown }} [deps]
 * @returns {Promise<{ swept: number, tenants: number, skipped: number }>}
 */
async function sweepInterruptedPostings(deps = {}) {
  const registry = deps.registry || require('../../platform/registry');
  const tenantDb = deps.tenantDb || require('../../platform/tenantDb');

  let tenants = [];
  try {
    tenants = await registry.listTenants();
  } catch (err) {
    console.warn(
      '[rcm/drain] startup sweep skipped — could not list tenants:',
      err && err.message ? err.message : err
    );
    return { swept: 0, tenants: 0, skipped: 0 };
  }

  const active = (tenants || []).filter((t) => t && t.status === 'active');
  let swept = 0;
  let skipped = 0;

  for (const tenant of active) {
    try {
      const pool = await tenantDb.getTenantPool(tenant.tenant_id);
      const res = await pool.query(
        `UPDATE rcm_posting_queue
            SET status = 'approved',
                drain_step = NULL,
                last_error = $1,
                updated_at = now()
          WHERE status = 'posting'
          RETURNING queue_id`,
        [
          'The server restarted while this plan was posting. It is queued again; ' +
            'draining re-reads Open Dental first and resumes from what the chart shows.',
        ]
      );
      swept += res.rows.length;
      if (res.rows.length > 0) {
        console.warn(
          `[rcm/drain] startup sweep: ${res.rows.length} interrupted posting plan(s) re-queued ` +
            `for tenant '${tenant.slug}' — press Drain to resume`
        );
      }
    } catch (err) {
      // A tenant that has never run the rcm_* migration, or whose database is
      // unreachable, is skipped rather than fatal — same ruling as the EOB sweep.
      skipped++;
      console.warn(
        `[rcm/drain] startup sweep skipped tenant '${tenant.slug}':`,
        err && err.message ? err.message : err
      );
    }
  }

  return { swept, tenants: active.length, skipped };
}

module.exports = {
  BLOCK_REASONS,
  SKIP_ALREADY_RECEIVED,
  QUEUE_STATUS_LABEL,
  DRAINABLE_STATUSES,
  OFFICES_ENABLED_FOR_POSTING,
  DEFAULT_BUDGET_MS,
  QUEUE_COLUMNS,
  LINE_COLUMNS,
  STEPS,
  DRAIN_MUTEX,
  checkPreconditions,
  decideLineAction,
  groupByClaim,
  officeToday,
  asOdDate,
  asUuidOrNull,
  loadPlan,
  claimRow,
  persistStep,
  persistLine,
  blockRow,
  finalizeRow,
  drainRow,
  drainOffice,
  describeConfig,
  sweepInterruptedPostings,
};
