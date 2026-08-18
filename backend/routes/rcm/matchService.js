'use strict';

/**
 * The workbench's shared read + match orchestration (Slice 6a).
 *
 * Sits between the routes (./claims.js, ./remittances.js) and the two things
 * that do the actual work: the PURE scorer (services/rcm/claimMatch.js) and the
 * READ-ONLY Open Dental shell (services/rcm/odClaimReads.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO OPEN DENTAL WRITES
 * ─────────────────────────────────────────────────────────────────────────────
 * The only Open Dental transport reachable from here is `apiGetRaw`, closed
 * over the office's own client. There is no POST/PUT/PATCH/DELETE counterpart
 * on that client for a caller to reach, and `rcmNoOdWrites.test.js` asserts
 * that no OD write method is called from this module's require graph under any
 * of its endpoints.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OFFICE LAW
 * ─────────────────────────────────────────────────────────────────────────────
 * Office comes from the router-wide `requireOffice` (a validated `?office=`
 * query param). Every SQL statement filters on it, and every Open Dental call
 * goes through `assertOfficeMatch(office, getOdOffice(office))` — the guard
 * config/odOffices.js calls "the safety heart". PatNum numbering restarts in
 * every Open Dental database (7115 is Riley's test patient and a different,
 * real person in Roland), so a client bound to the wrong practice is refused
 * rather than used, and never falls back.
 */

const odOffices = require('../../config/odOffices');
const tenantDb = require('../../platform/tenantDb');
const claimMatch = require('../../services/rcm/claimMatch');
const odClaimReads = require('../../services/rcm/odClaimReads');
const odPacer = require('../../services/rcm/odPacer');
const { describeAdjustment } = require('../../services/rcm/adjustmentCodes');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { num, iso, isoDate } = require('./helpers');

/**
 * Minimum gap between EVERY RCM Open Dental call — not between claims.
 *
 * This used to pace only the loop over a remittance's claims, which left the
 * calls WITHIN a claim completely unpaced: one unlinked patient with a common
 * surname is 35–40 sequential GETs at the transport's 120ms default, i.e. ~8
 * req/s against a credential Open Dental throttles at 1 req/s and that the
 * VOICE module and TC are using in production. The modules that would have
 * eaten the 429s are the phone system and TC, not RCM.
 *
 * services/rcm/odPacer.js now gates every call, so the guarantee holds per
 * request rather than per claim. This constant is retained only to report the
 * effective interval on the batch-match response.
 */
const BATCH_PACING_MS = odPacer.resolveMinIntervalMs();

/**
 * Claims in one batch-match run. A remittance larger than this is matched a
 * page at a time, and the response says how many were left — a cap that does
 * not announce itself reads as "everything matched".
 */
const MAX_BATCH_MATCH_CLAIMS = odClaimReads.intEnv('RCM_OD_MAX_BATCH_MATCH_CLAIMS', 25);

/**
 * How long ONE batch-match request may spend before it stops and reports what
 * it got. Wall clock, not a claim count.
 *
 * A claim-count cap alone does not bound the request: at ≥1.2s per Open Dental
 * CALL, one unlinked patient with a common surname is 35–40 calls, so 25 claims
 * is minutes to tens of minutes on a single held HTTP request. The client's
 * timeout then fires as the NORMAL outcome and the result panel becomes
 * unreachable — the operation does not fit the transport.
 *
 * Rather than stretch the transport, the run is bounded to fit it: it stops on
 * the budget, says how many it did not reach, and the biller presses again. The
 * ordering below is what makes pressing again make progress rather than redo
 * the front of the list.
 *
 * The proper answer is a job the page polls (PR #87's bounded-poll pattern);
 * that needs run state this slice has no table for, so it is 6b's.
 */
const BATCH_MATCH_BUDGET_MS = odClaimReads.intEnv('RCM_OD_BATCH_MATCH_BUDGET_MS', 90000);

/**
 * The snapshot's shape version. 6c reads this before trusting the contents, and
 * `confirmMatch` refuses anything that is not this number.
 *
 * v2 (this review round) renamed `confirmed.odAmountsAsRead.claimFeeCents` to
 * `claimHeaderFeeCents` and added `billedCents` beside it. The old name held the
 * raw OD claim header total, which still includes soft-deleted procedures
 * (G12) — so 6c, re-verifying "the billed amount has not moved", was comparing
 * against the one billed figure the tri-state exclusion had not been applied
 * to. A rename rather than a silent value change, so a v1 snapshot is REFUSED
 * and re-run instead of being read with the wrong meaning.
 */
const SNAPSHOT_VERSION = 2;

/**
 * Columns the list views read. `raw_extracted_json` is deliberately ABSENT —
 * it is the full PHI extraction payload and a list has no use for it; the
 * Slice 3 claims list made the same call and for the same reason.
 */
const CLAIM_LIST_COLUMNS = [
  'claim_id',
  'office_id',
  'claim_number',
  'check_number',
  'patient_name',
  'od_patient_id',
  'od_claim_num',
  'payer',
  'service_date',
  'received_date',
  'status',
  'payment_status',
  'insurance_type',
  'total_billed_cents',
  'total_allowed_cents',
  'total_paid_cents',
  'total_deductible_cents',
  'patient_balance_cents',
  'needs_review_reasons',
  'confidence',
  'od_match_status',
  'od_match_at',
  'od_match_confirmed_at',
  'od_matched_by',
  'reviewed_at',
  'reviewed_by',
  'review_note',
  'created_at',
].join(', ');

/** The detail view adds the snapshot; everything else is the same read. */
const CLAIM_DETAIL_COLUMNS = `${CLAIM_LIST_COLUMNS}, od_match_snapshot`;

const LINE_COLUMNS = [
  'line_id',
  'claim_id',
  'position',
  'billed_code',
  'paid_code',
  'code',
  'description',
  'billed_cents',
  'allowed_cents',
  'deductible_cents',
  'copay_cents',
  'paid_cents',
  'adjustment_cents',
  'patient_resp_cents',
  'write_off_cents',
  'adjustment_reason',
  'is_downcoded',
  'is_bundled',
  'is_denied',
  'flags',
  'od_claim_proc_num',
].join(', ');

const ADJUSTMENT_COLUMNS = [
  'adjustment_id',
  'procedure_line_id',
  'claim_id',
  'group_code',
  'reason_code',
  'reason_description',
  'amount_cents',
  'quantity',
  'remark_code',
  'remark_description',
].join(', ');

/**
 * A claim row as the list renders it.
 *
 * `odMatchedByKey` / `reviewedByKey` are the raw `rcm_user_map` keys, kept so
 * the caller can resolve display names in ONE query for a whole page rather
 * than one per row. They are stripped before the response goes out.
 */
function toClaimSummary(row) {
  return {
    claimId: row.claim_id,
    officeId: row.office_id,
    claimNumber: row.claim_number,
    checkNumber: row.check_number || null,
    patientName: row.patient_name,
    odPatientId: row.od_patient_id == null ? null : num(row.od_patient_id),
    odClaimNum: row.od_claim_num == null ? null : num(row.od_claim_num),
    payer: row.payer,
    serviceDate: isoDate(row.service_date),
    receivedDate: isoDate(row.received_date),
    status: row.status,
    paymentStatus: row.payment_status,
    insuranceType: row.insurance_type,
    totalBilledCents: num(row.total_billed_cents),
    totalAllowedCents: num(row.total_allowed_cents),
    totalPaidCents: num(row.total_paid_cents),
    totalDeductibleCents: num(row.total_deductible_cents),
    patientBalanceCents: num(row.patient_balance_cents),
    needsReviewReasons: Array.isArray(row.needs_review_reasons) ? row.needs_review_reasons : [],
    /** The extractor's own 0–100 confidence. NOT the OD match confidence. */
    extractionConfidence: num(row.confidence),
    odMatchStatus: row.od_match_status || 'not_run',
    odMatchAt: iso(row.od_match_at),
    odMatchConfirmedAt: iso(row.od_match_confirmed_at),
    odMatchedByKey: row.od_matched_by || null,
    reviewedAt: iso(row.reviewed_at),
    reviewedByKey: row.reviewed_by || null,
    reviewNote: row.review_note || null,
    createdAt: iso(row.created_at),
  };
}

/**
 * One line, with its adjustments resolved into plain English.
 *
 * Descriptions come from services/rcm/adjustmentCodes.js at RENDER time rather
 * than from what was stored at parse time, because RARC descriptions had no
 * source of data before Slice 6a — every `remark_description` Slice 5 wrote is
 * the empty string. A stored, non-placeholder description still wins: it is the
 * payer's own wording.
 */
function toLineWire(line, adjustments) {
  return {
    lineId: line.line_id,
    position: num(line.position),
    billedCode: line.billed_code,
    /** Set only when the carrier downcoded; both codes are kept. */
    paidCode: line.paid_code || null,
    code: line.code,
    description: line.description || '',
    billedCents: num(line.billed_cents),
    allowedCents: num(line.allowed_cents),
    deductibleCents: num(line.deductible_cents),
    copayCents: num(line.copay_cents),
    paidCents: num(line.paid_cents),
    adjustmentCents: num(line.adjustment_cents),
    patientRespCents: num(line.patient_resp_cents),
    writeOffCents: num(line.write_off_cents),
    adjustmentReason: line.adjustment_reason || null,
    isDowncoded: line.is_downcoded === true,
    isBundled: line.is_bundled === true,
    isDenied: line.is_denied === true,
    flags: Array.isArray(line.flags) ? line.flags : [],
    odClaimProcNum: line.od_claim_proc_num == null ? null : num(line.od_claim_proc_num),
    adjustments: adjustments.map((a) => ({
      adjustmentId: a.adjustment_id,
      amountCents: num(a.amount_cents),
      quantity: num(a.quantity),
      ...describeAdjustment({
        groupCode: a.group_code,
        reasonCode: a.reason_code,
        reasonDescription: a.reason_description,
        remarkCode: a.remark_code,
        remarkDescription: a.remark_description,
      }),
    })),
  };
}

/**
 * One claim with its lines and adjustments, office-scoped at every statement.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @param {string} claimId
 * @param {{ includeSnapshot?: boolean }} [opts]
 * @returns {Promise<object|null>}
 */
async function loadClaimBundle(pool, office, claimId, { includeSnapshot = true } = {}) {
  const claims = await pool.query(
    `SELECT ${includeSnapshot ? CLAIM_DETAIL_COLUMNS : CLAIM_LIST_COLUMNS} FROM rcm_claims ` +
      `WHERE office_id = $1 AND claim_id = $2`,
    [office, claimId]
  );
  if (claims.rows.length === 0) return null;
  const row = claims.rows[0];

  const [lines, adjustments] = await Promise.all([
    pool.query(
      `SELECT ${LINE_COLUMNS} FROM rcm_procedure_lines WHERE office_id = $1 AND claim_id = $2 ` +
        `ORDER BY position ASC`,
      [office, claimId]
    ),
    pool.query(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM rcm_procedure_adjustments ` +
        `WHERE office_id = $1 AND claim_id = $2`,
      [office, claimId]
    ),
  ]);

  const adjByLine = new Map();
  for (const a of adjustments.rows) {
    if (!adjByLine.has(a.procedure_line_id)) adjByLine.set(a.procedure_line_id, []);
    adjByLine.get(a.procedure_line_id).push(a);
  }

  const summary = toClaimSummary(row);
  return {
    ...summary,
    lines: lines.rows.map((l) => toLineWire(l, adjByLine.get(l.line_id) || [])),
    ...(includeSnapshot
      ? { matchSnapshot: row.od_match_snapshot || null }
      : {}),
  };
}

/**
 * Resolve THIS office's Open Dental client, or refuse.
 *
 * Unknown office, office not OD-connected, and office switched on but unkeyed
 * all land here — and none of them falls back to another practice's client.
 * That fallback is precisely the PatNum-collision hazard the per-office
 * registry exists to prevent.
 *
 * @param {string} office
 * @returns {{ odGet: Function, officeName: string }}
 * @throws {import('../../config/odOffices').OdOfficeError}
 */
function odTransportFor(office) {
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  return {
    // A GET-only closure, PACED. Nothing downstream of this line holds a client
    // object, so nothing downstream can find a write verb on one — and nothing
    // downstream has to remember to pace, because the transport it was handed
    // already does. That is why the wrap happens here and not at each call site.
    odGet: odPacer.pacedOdGet((path, params, opts) =>
      handle.client.apiGetRaw(path, params, opts)
    ),
    officeName: handle.officeName,
  };
}

/**
 * Run the match for one claim: read Open Dental, score, store the snapshot.
 *
 * Writes to OUR rows only — `od_match_status`, `od_match_snapshot`,
 * `od_match_at`. It never sets `od_claim_num`: that column is meaningful only
 * in the `confirmed` state (a database CHECK enforces it), and only a human
 * confirming can move it there.
 *
 * Re-running is allowed and EXPLICIT — the route is a POST a person presses.
 * A re-run replaces the snapshot, which is why a CONFIRMED claim is refused
 * here rather than silently re-matched: overwriting a decision somebody made,
 * without their asking, is the "never silent overwrite" rule this slice is
 * built on. Un-confirming is a separate, deliberate act.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} claimId
 * @param {{ force?: boolean, onPhiRead?: ((ctx: { claimId: string, force: boolean,
 *   supersedes: object|null }) => Promise<void>)|null }} [opts] force re-runs
 *   over a confirmed match; `onPhiRead` is awaited BEFORE anything is stored.
 * @returns {Promise<{ status: string, claimId: string, snapshot: object }>}
 */
async function runClaimMatch(req, office, claimId, { force = false, onPhiRead = null } = {}) {
  // The snapshot is loaded, not skipped: a forced re-run has to carry the
  // confirmation it is about to destroy into the new one (see `supersedes`).
  const claim = await tenantDb.withTenantDb(req, (pool) =>
    loadClaimBundle(pool, office, claimId, { includeSnapshot: true })
  );
  if (!claim) {
    const err = new Error('No such claim for this office');
    err.httpStatus = 404;
    err.code = 'CLAIM_NOT_FOUND';
    throw err;
  }
  if (claim.odMatchStatus === 'confirmed' && !force) {
    const err = new Error('This claim already has a confirmed Open Dental match');
    err.httpStatus = 409;
    err.code = 'MATCH_ALREADY_CONFIRMED';
    throw err;
  }

  /**
   * The confirmation this run is about to overwrite, if any.
   *
   * Only a `force` run can reach this with a confirmation in place. It is
   * carried into the new snapshot rather than blanked, because otherwise WHO
   * confirmed, WHEN, and against WHICH ClaimNum are unrecoverable the moment
   * somebody forces a re-run — and that is precisely the event most worth being
   * able to reconstruct.
   */
  const prior = claim.matchSnapshot && claim.matchSnapshot.confirmed ? claim.matchSnapshot.confirmed : null;
  const supersedes = force && claim.odMatchStatus === 'confirmed' ? prior : null;

  const { odGet, officeName } = odTransportFor(office);

  const found = await odClaimReads.findClaimCandidates(odGet, {
    patientName: claim.patientName,
    odPatientId: claim.odPatientId,
    claimNumber: claim.claimNumber,
    serviceDate: claim.serviceDate,
    totalBilledCents: claim.totalBilledCents,
    lines: claim.lines,
  });

  const ranked = claimMatch.rankCandidates(
    {
      claimNumber: claim.claimNumber,
      patientName: claim.patientName,
      serviceDate: claim.serviceDate,
      totalBilledCents: claim.totalBilledCents,
      lines: claim.lines,
    },
    found.candidates,
    // The name-mismatch disqualifier is a defence against OD returning
    // STRANGERS when a name filter is ignored. On the linked-PatNum lane there
    // are no strangers to defend against, and a married-name change would
    // otherwise disqualify every claim on the right patient.
    { patientResolvedByLink: found.patientResolvedByLink === true }
  );

  // Line pairing is computed per candidate at match time so the screen can show
  // which chart lines a candidate would touch BEFORE anyone confirms — and so
  // confirming has nothing left to compute.
  const candidates = ranked.candidates.map((c) => ({
    ...c,
    linePairs: claimMatch.pairLines(claim.lines, c.od.lines),
  }));

  const snapshot = {
    version: SNAPSHOT_VERSION,
    fetchedAt: found.fetchedAt,
    office,
    officeName,
    odCalls: found.odCalls,
    truncated: found.truncated,
    notes: found.notes,
    patientsConsidered: found.patientsConsidered,
    ambiguous: ranked.ambiguous,
    margin: ranked.margin,
    /**
     * Examined and NOT offered — counted, with the rule that dropped each one.
     *
     * These are what keep `no_candidate` honest. Its documented meaning is "a
     * search ran and Open Dental had nothing"; without them, a search that
     * found three claims and disqualified all three tells a biller the chart
     * has no such claim. The screen reads the two differently.
     */
    rejectedCandidates: ranked.rejected,
    rejectedReasons: ranked.rejectedReasons,
    minScore: ranked.minScore,
    /** False ⇒ the patient was already linked, so the name rule was off. */
    nameRuleApplied: ranked.nameRuleApplied,
    candidates,
    /** A fresh run has confirmed nothing. A human confirming fills this in. */
    confirmed: null,
    /**
     * The confirmation a forced re-run replaced — who, when, which ClaimNum.
     * Null on every ordinary run.
     */
    supersededConfirmation: supersedes,
  };

  // `no_candidate` is a first-class outcome, not an empty list: it records that
  // we LOOKED, against this office's database, at this instant, and Open Dental
  // had nothing. "Nobody has checked" and "we checked and there is none" are
  // different facts a biller acts on differently.
  const status = candidates.length > 0 ? 'candidates' : 'no_candidate';

  /*
   * THE TRAIL IS WRITTEN BEFORE THE SNAPSHOT, not after the response.
   *
   * The snapshot contains Open Dental PATIENT NAMES. Persisting it first and
   * auditing afterwards means an audit failure leaves PHI on disk, re-readable
   * through GET /claims/:id, with nothing recorded — the exact inversion
   * documents.js states as its own rule ("the trail is written before the
   * bytes"). This is fail-CLOSED: `onPhiRead` throws AuditError and h() turns
   * that into a 500 before anything is stored.
   */
  if (onPhiRead) await onPhiRead({ claimId, force, supersedes });

  /*
   * THE GUARD IS IN THE WHERE, NOT ONLY IN THE READ ABOVE.
   *
   * The `confirmed` check at the top of this function reads on one connection;
   * this writes on another, and between them sit the Open Dental round trips —
   * seconds. Two billers working the same remittance, or one biller's second
   * click while the first run is still draining, would both pass the read and
   * the later UPDATE would blank a confirmation the other had already
   * committed: `od_claim_num`, `od_matched_by` and `od_match_confirmed_at` all
   * set back to NULL, no error, no audit row recording the reversal, and the
   * claim silently back in needs-attention.
   *
   * Re-asserting the status in the WHERE makes the check-and-write one
   * statement, so the loser writes nothing and finds out. Same reason the
   * remittance-key protocol re-asserts its own status inside its WHERE.
   */
  const written = await tenantDb.withTenantDb(req, (pool) =>
    pool.query(
      `UPDATE rcm_claims SET od_match_status = $3, od_match_snapshot = $4, od_match_at = now(), ` +
        `od_claim_num = NULL, od_match_confirmed_at = NULL, od_matched_by = NULL, updated_at = now() ` +
        `WHERE office_id = $1 AND claim_id = $2` +
        (force ? '' : ` AND od_match_status <> 'confirmed'`),
      [office, claimId, status, JSON.stringify(snapshot)]
    )
  );

  if (!force && written.rowCount === 0) {
    // Somebody confirmed it while we were reading Open Dental. Their decision
    // stands; this run's snapshot is discarded rather than overwriting it.
    const err = new Error('This claim was confirmed while the match was running');
    err.httpStatus = 409;
    err.code = 'MATCH_ALREADY_CONFIRMED';
    throw err;
  }

  return { status, claimId, snapshot };
}

/**
 * Match every claim on a remittance, one at a time, with pacing.
 *
 * Never rejects on a single claim's failure: a remittance where one patient's
 * chart is unreadable should still tell the biller about the other eleven. Each
 * outcome is reported individually, and `failed` is a status in the result
 * rather than an exception that discards the work already done.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {ReadonlyArray<{ claimId: string, odMatchStatus?: string }|string>} claims
 */
async function runBatchMatch(req, office, claims, { onPhiRead = null } = {}) {
  /*
   * UNMATCHED FIRST, so pressing the button again makes PROGRESS.
   *
   * The run is bounded by BATCH_MATCH_BUDGET_MS as well as by claim count, so a
   * large remittance takes several presses. In deposit order each press would
   * redo the front of the list and never reach the tail. Claims nobody has
   * looked at go first; a stable secondary order keeps the result reproducible.
   */
  const RANK = { not_run: 0, no_candidate: 1, candidates: 2, confirmed: 3 };
  const ordered = claims
    .map((c, i) => (typeof c === 'string' ? { claimId: c, odMatchStatus: 'not_run', i } : { ...c, i }))
    .sort((a, b) => (RANK[a.odMatchStatus] ?? 0) - (RANK[b.odMatchStatus] ?? 0) || a.i - b.i);

  const todo = ordered.slice(0, MAX_BATCH_MATCH_CLAIMS);
  let skipped = ordered.length - todo.length;

  /*
   * ONE AUDIT ROW PER CHART READ — the obligation belongs to each claim.
   *
   * This used to hand `onPhiRead` only to `todo[0]`, on a "one row per human
   * action" reading of the granularity rule. Two things were wrong with it. If
   * claim zero threw before reaching the PHI point — a claim somebody had
   * already confirmed, the mundane outcome of re-running a partly-worked
   * remittance — the catch swallowed it, the loop carried on, and claims 1..N
   * read charts and persisted PHI-bearing snapshots with NO audit row for the
   * whole run. And even when it fired, one row with `resource_id: null` could
   * not answer "whose chart was read on Tuesday" for up to 25 claims across as
   * many patients, which is the question the trail exists to answer.
   *
   * The granularity rule is about not writing a row per Open Dental CALL. A
   * claim is not a call: it is one patient's chart. N charts is N rows. The
   * route writes a separate row for the run itself before this is entered, so
   * a run in which every claim fails is still recorded.
   */

  /** @type {Array<{ claimId: string, status: string, candidateCount?: number, error?: string }>} */
  const results = [];
  let odCalls = 0;
  const startedAt = Date.now();
  let outOfTime = false;

  for (let i = 0; i < todo.length; i++) {
    // No sleep here: every OD call this loop causes is already gated by
    // odPacer, so an extra between-claims wait would only add latency without
    // adding a guarantee. The pacing that matters is per CALL.
    //
    // The budget is checked BEFORE starting a claim, never mid-claim: a claim
    // abandoned halfway has read charts and stored nothing, which is the one
    // outcome worse than not starting it.
    if (Date.now() - startedAt >= BATCH_MATCH_BUDGET_MS) {
      outOfTime = true;
      skipped += todo.length - i;
      break;
    }
    try {
      const out = await runClaimMatch(req, office, todo[i].claimId, { onPhiRead });
      odCalls += out.snapshot.odCalls;
      results.push({
        claimId: todo[i].claimId,
        status: out.status,
        candidateCount: out.snapshot.candidates.length,
        ambiguous: out.snapshot.ambiguous,
      });
    } catch (err) {
      // A confirmed claim is skipped rather than reported as a failure — it is
      // the expected outcome of re-running a batch someone has partly worked.
      const code = err && err.code;
      results.push({
        claimId: todo[i].claimId,
        status: code === 'MATCH_ALREADY_CONFIRMED' ? 'already_confirmed' : 'failed',
        ...(code === 'MATCH_ALREADY_CONFIRMED' ? {} : { error: (err && err.message) || 'Match failed' }),
      });
    }
  }

  const note = outOfTime
    ? `${skipped} claim${skipped === 1 ? '' : 's'} were not reached before this run's ${Math.round(BATCH_MATCH_BUDGET_MS / 1000)}s budget ran out. Run it again to continue — unmatched claims go first.`
    : skipped > 0
      ? `${skipped} claim${skipped === 1 ? '' : 's'} were not matched in this run (cap: ${MAX_BATCH_MATCH_CLAIMS}). Run it again to continue.`
      : null;

  return {
    matched: results,
    odCalls,
    pacingMs: BATCH_PACING_MS,
    budgetMs: BATCH_MATCH_BUDGET_MS,
    /** True when the WALL CLOCK stopped the run rather than the claim cap. */
    outOfTime,
    // Stated, never silent: a cap that does not announce itself reads as
    // "everything matched".
    skipped,
    ...(note ? { note } : {}),
  };
}

/**
 * Confirm one candidate as THE Open Dental claim for this proposal.
 *
 * The module's first attributed action, and the reason decision D-5 exists:
 * `od_matched_by` is a FK to `rcm_user_map`, satisfied by upserting the SSO
 * identity inside this same transaction.
 *
 * Everything moves together or not at all — the user row, the claim's status
 * and ClaimNum, and the per-line ClaimProcNums. A half-written confirmation
 * would leave `od_claim_num` set with lines pointing nowhere, which is what
 * Slice 6c reads to decide which chart to touch.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} claimId
 * @param {number} odClaimNum the candidate the human chose
 * @param {{ email: string, displayName?: string }} actor
 */
async function confirmMatch(req, office, claimId, odClaimNum, actor) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const claims = await client.query(
        `SELECT ${CLAIM_DETAIL_COLUMNS} FROM rcm_claims WHERE office_id = $1 AND claim_id = $2`,
        [office, claimId]
      );
      if (claims.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('No such claim for this office');
        err.httpStatus = 404;
        err.code = 'CLAIM_NOT_FOUND';
        throw err;
      }
      const row = claims.rows[0];
      const snapshot = row.od_match_snapshot || null;

      // Confirming requires a match to confirm. Accepting a bare ClaimNum from
      // the request body would make this endpoint a way to write an arbitrary
      // ClaimNum onto a claim without anyone ever having read that claim from
      // Open Dental — and 6c posts money against exactly that number.
      if (!snapshot || !Array.isArray(snapshot.candidates)) {
        await client.query('ROLLBACK');
        const err = new Error('Run a match before confirming one');
        err.httpStatus = 409;
        err.code = 'NO_MATCH_TO_CONFIRM';
        throw err;
      }

      /*
       * THE SNAPSHOT MUST BELONG TO THIS OFFICE, AND TO THIS SHAPE.
       *
       * `runClaimMatch` stamps both and confirm used to read neither — then
       * wrote `od_patient_id = candidate.odPatNum`. PatNum numbering RESTARTS
       * in every Open Dental database (7115 is Riley's test patient and a
       * different, real person in Roland), so confirming against a snapshot
       * taken under another office would write that other practice's PatNum
       * onto a row stamped with this one. Hard rule 3, enforced rather than
       * assumed.
       *
       * The version check is the same argument for shape: 6c reads
       * `confirmed.linePairs` and `odAmountsAsRead` out of this structure, and
       * a snapshot written by an older or newer slice may not carry them.
       */
      // UNCONDITIONAL. `snapshot.office && …` skipped the check for a snapshot
      // with a missing or empty office — and a snapshot that cannot say which
      // practice it was read from is not trustworthy, it is unreadable.
      if (snapshot.office !== office) {
        await client.query('ROLLBACK');
        const err = new Error(
          'That match was run against a different office — re-run it for this one before confirming'
        );
        err.httpStatus = 409;
        err.code = 'SNAPSHOT_OFFICE_MISMATCH';
        throw err;
      }
      if (Number(snapshot.version) !== SNAPSHOT_VERSION) {
        await client.query('ROLLBACK');
        const err = new Error('That match was recorded in an older format — re-run it before confirming');
        err.httpStatus = 409;
        err.code = 'SNAPSHOT_VERSION_STALE';
        throw err;
      }

      const candidate = snapshot.candidates.find((c) => Number(c.odClaimNum) === Number(odClaimNum));
      if (!candidate) {
        await client.query('ROLLBACK');
        const err = new Error('That claim was not among the candidates this match found');
        err.httpStatus = 409;
        err.code = 'CANDIDATE_NOT_FOUND';
        throw err;
      }

      // D-5: the acting user, created on first use, on THIS connection so the
      // FK below sees it.
      const userKey = await resolveRcmActor(client, actor);

      const confirmedAt = new Date().toISOString();
      const nextSnapshot = {
        ...snapshot,
        confirmed: {
          odClaimNum: Number(odClaimNum),
          odPatNum: candidate.odPatNum,
          confirmedAt,
          confirmedBy: userKey,
          /** What 6c re-verifies against at drain time. */
          linePairs: candidate.linePairs || [],
          /*
           * WHAT 6c RE-VERIFIES AGAINST — line-derived, not the claim header.
           *
           * `billedCents` is the LIVE lines' FeeBilled, the same figure the
           * BILLED_AMOUNT_* evidence was computed from. The header total is
           * kept beside it under a name that says what it is: `ClaimFee` still
           * includes soft-deleted procedures (G12), so a re-verification
           * against it would compare a clean number to a contaminated one and
           * call the difference a change.
           */
          odAmountsAsRead: {
            billedCents: candidate.od.billedCents,
            claimHeaderFeeCents: candidate.od.claimHeaderFeeCents,
            insPaidCents: candidate.od.insPaidCents,
            writeOffCents: candidate.od.writeOffCents,
            claimStatus: candidate.od.claimStatus,
          },
        },
      };

      await client.query(
        `UPDATE rcm_claims SET od_match_status = 'confirmed', od_claim_num = $3, od_patient_id = $4, ` +
          `od_match_confirmed_at = now(), od_matched_by = $5, od_match_snapshot = $6, ` +
          `status = 'matched', updated_at = now() WHERE office_id = $1 AND claim_id = $2`,
        [
          office,
          claimId,
          Number(odClaimNum),
          candidate.odPatNum,
          userKey,
          JSON.stringify(nextSnapshot),
        ]
      );

      // Per-line ClaimProcNums. A line the pairing could not resolve is set to
      // NULL rather than left at whatever a previous match wrote — a stale
      // ClaimProcNum is worse than none, because 6c would PUT against it.
      for (const pair of candidate.linePairs || []) {
        if (!pair.lineId) continue;
        await client.query(
          `UPDATE rcm_procedure_lines SET od_claim_proc_num = $3, updated_at = now() ` +
            `WHERE office_id = $1 AND line_id = $2`,
          [office, pair.lineId, pair.odClaimProcNum == null ? null : Number(pair.odClaimProcNum)]
        );
      }

      await client.query('COMMIT');
      return { claimId, odClaimNum: Number(odClaimNum), confirmedAt, confirmedBy: userKey };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Mark a claim reviewed, with an optional note. Worklist hygiene ONLY.
 *
 * No Open Dental effect whatsoever, and deliberately independent of the match:
 * "the carrier owes a corrected EOB, there is nothing here to post" is a real
 * outcome for a claim with no chart linkage at all, and forcing a match before
 * it could be recorded would push billers into confirming matches they do not
 * believe in to clear their queue.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} claimId
 * @param {string|null} note
 * @param {{ email: string, displayName?: string }} actor
 */
async function markReviewed(req, office, claimId, note, actor) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const found = await client.query(
        `SELECT claim_id FROM rcm_claims WHERE office_id = $1 AND claim_id = $2`,
        [office, claimId]
      );
      if (found.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('No such claim for this office');
        err.httpStatus = 404;
        err.code = 'CLAIM_NOT_FOUND';
        throw err;
      }

      const userKey = await resolveRcmActor(client, actor);
      await client.query(
        `UPDATE rcm_claims SET reviewed_at = now(), reviewed_by = $3, review_note = $4, ` +
          `updated_at = now() WHERE office_id = $1 AND claim_id = $2`,
        [office, claimId, userKey, note]
      );

      await client.query('COMMIT');
      return { claimId, reviewedBy: userKey };
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

module.exports = {
  BATCH_PACING_MS,
  BATCH_MATCH_BUDGET_MS,
  MAX_BATCH_MATCH_CLAIMS,
  SNAPSHOT_VERSION,
  CLAIM_LIST_COLUMNS,
  CLAIM_DETAIL_COLUMNS,
  LINE_COLUMNS,
  ADJUSTMENT_COLUMNS,
  toClaimSummary,
  toLineWire,
  loadClaimBundle,
  odTransportFor,
  runClaimMatch,
  runBatchMatch,
  confirmMatch,
  markReviewed,
};
