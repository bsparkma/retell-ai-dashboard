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
const { describeAdjustment } = require('../../services/rcm/adjustmentCodes');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { num, iso, isoDate } = require('./helpers');

/**
 * Minimum gap between claims in a batch match.
 *
 * Each claim costs a handful of Open Dental calls against an API that is
 * throttled and ~10 hops deep. Pacing is how a twelve-claim remittance stays a
 * background-shaped operation instead of a burst the OD rate limiter answers
 * with 429s — which the client would then back off from anyway, slower and
 * noisier than doing it on purpose. Floor of 1200ms; a smaller env value is
 * raised to it rather than honoured.
 */
const BATCH_PACING_MS = Math.max(1200, Number(process.env.RCM_OD_BATCH_PACING_MS || 1200));

/**
 * Claims in one batch-match run. A remittance larger than this is matched a
 * page at a time, and the response says how many were left — a cap that does
 * not announce itself reads as "everything matched".
 */
const MAX_BATCH_MATCH_CLAIMS = Number(process.env.RCM_OD_MAX_BATCH_MATCH_CLAIMS || 25);

/** The snapshot's shape version. 6c reads this before trusting the contents. */
const SNAPSHOT_VERSION = 1;

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
    // A GET-only closure. Nothing downstream of this line holds a client
    // object, so nothing downstream can find a write verb on one.
    odGet: (path, params, opts) => handle.client.apiGetRaw(path, params, opts),
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
 * @param {{ force?: boolean }} [opts] force re-runs over a confirmed match
 * @returns {Promise<{ status: string, claimId: string, snapshot: object }>}
 */
async function runClaimMatch(req, office, claimId, { force = false } = {}) {
  const claim = await tenantDb.withTenantDb(req, (pool) =>
    loadClaimBundle(pool, office, claimId, { includeSnapshot: false })
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
    found.candidates
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
    candidates,
    /** Carried forward across a re-run so a prior confirmation is auditable. */
    confirmed: null,
  };

  // `no_candidate` is a first-class outcome, not an empty list: it records that
  // we LOOKED, against this office's database, at this instant, and Open Dental
  // had nothing. "Nobody has checked" and "we checked and there is none" are
  // different facts a biller acts on differently.
  const status = candidates.length > 0 ? 'candidates' : 'no_candidate';

  await tenantDb.withTenantDb(req, (pool) =>
    pool.query(
      `UPDATE rcm_claims SET od_match_status = $3, od_match_snapshot = $4, od_match_at = now(), ` +
        `od_claim_num = NULL, od_match_confirmed_at = NULL, od_matched_by = NULL, updated_at = now() ` +
        `WHERE office_id = $1 AND claim_id = $2`,
      [office, claimId, status, JSON.stringify(snapshot)]
    )
  );

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
 * @param {ReadonlyArray<string>} claimIds
 */
async function runBatchMatch(req, office, claimIds) {
  const todo = claimIds.slice(0, MAX_BATCH_MATCH_CLAIMS);
  const skipped = claimIds.length - todo.length;

  /** @type {Array<{ claimId: string, status: string, candidateCount?: number, error?: string }>} */
  const results = [];
  let odCalls = 0;

  for (let i = 0; i < todo.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, BATCH_PACING_MS));
    try {
      const out = await runClaimMatch(req, office, todo[i]);
      odCalls += out.snapshot.odCalls;
      results.push({
        claimId: todo[i],
        status: out.status,
        candidateCount: out.snapshot.candidates.length,
        ambiguous: out.snapshot.ambiguous,
      });
    } catch (err) {
      // A confirmed claim is skipped rather than reported as a failure — it is
      // the expected outcome of re-running a batch someone has partly worked.
      const code = err && err.code;
      results.push({
        claimId: todo[i],
        status: code === 'MATCH_ALREADY_CONFIRMED' ? 'already_confirmed' : 'failed',
        ...(code === 'MATCH_ALREADY_CONFIRMED' ? {} : { error: (err && err.message) || 'Match failed' }),
      });
    }
  }

  return {
    matched: results,
    odCalls,
    pacingMs: BATCH_PACING_MS,
    // Stated, never silent: a cap that does not announce itself reads as
    // "everything matched".
    skipped,
    ...(skipped > 0
      ? {
          note: `${skipped} claim${skipped === 1 ? '' : 's'} were not matched in this run (cap: ${MAX_BATCH_MATCH_CLAIMS}). Run it again to continue.`,
        }
      : {}),
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
          odAmountsAsRead: {
            claimFeeCents: candidate.od.claimFeeCents,
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
