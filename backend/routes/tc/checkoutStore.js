'use strict';

/**
 * tc_checkout_handoffs — reads and writes (queue item 49; the front desk's
 * lifecycle, item 50).
 *
 * Explicit columns, parameterized, office in every WHERE. No Open Dental
 * anywhere: a handoff is a snapshot the hygiene module sent.
 */

const { iso, num, isoDate } = require('./helpers');

const COLS = [
  'handoff_id',
  'office_id',
  'source_key',
  'od_patient_id',
  'patient_name',
  'provider',
  'provider_seen',
  'operatory',
  'visit_date',
  'payload',
  'is_final',
  'revision',
  'submitted_by',
  'updated_by',
  'created_at',
  'updated_at',
  // Item 50.
  'status',
  'claimed_by',
  'claimed_at',
  'dismissed_reason',
  'dismissed_by',
  'dismissed_at',
  'outcome_by',
  'outcome_at',
  'appointment_note',
  'case_id',
  'expired_at',
  'expired_by',
];

/**
 * The actor recorded on an expiry — the row's `expired_by` and the audit
 * row's user. A constant, like the nurture module's `system:nurture`, because
 * the system closed it, not whoever's request happened to run the sweep.
 */
const EXPIRY_ACTOR = 'system:checkout_expiry';

/** Still waiting on the front desk — what the inbox shows and the badge counts. */
const WAITING_STATUSES = Object.freeze(['open', 'claimed']);
/** Every status a handoff can hold; the same seven as the DB CHECK. */
const STATUSES = Object.freeze([
  'open',
  'claimed',
  'scheduled',
  'not_scheduled',
  'nothing_needed',
  'dismissed',
  'expired',
]);
/** The three front-desk answers. */
const OUTCOMES = Object.freeze(['scheduled', 'not_scheduled', 'nothing_needed']);

/** Postgres's unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** A jsonb cell as an object (pg returns objects; a fake may store strings). */
function obj(v) {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/** One row → the contract's TcCheckoutHandoff. */
function toHandoff(row) {
  return {
    handoffId: String(row.handoff_id),
    officeId: row.office_id,
    odPatientId: num(row.od_patient_id),
    patientName: row.patient_name,
    provider: row.provider ?? '',
    providerSeen: row.provider_seen ?? '',
    operatory: row.operatory ?? '',
    visitDate: isoDate(row.visit_date),
    snapshot: obj(row.payload),
    final: row.is_final === true,
    revision: Number(row.revision),
    submittedBy: row.submitted_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    status: row.status ?? 'open',
    claimedBy: row.claimed_by ?? null,
    claimedAt: iso(row.claimed_at),
    dismissedReason: row.dismissed_reason ?? null,
    dismissedBy: row.dismissed_by ?? null,
    dismissedAt: iso(row.dismissed_at),
    outcomeBy: row.outcome_by ?? null,
    outcomeAt: iso(row.outcome_at),
    appointmentNote: row.appointment_note ?? null,
    caseId: row.case_id ? String(row.case_id) : null,
    expiredAt: iso(row.expired_at),
    expiredBy: row.expired_by ?? null,
  };
}

/** One handoff by id, in one office, or null. */
async function findById(q, office, handoffId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2`,
    [office, handoffId]
  );
  return res.rows[0] || null;
}

// ── C2b (item 50b): the staff panel and its attestations ────────────────────

const ATTESTATION_COLS = ['office_id', 'handoff_id', 'item_index', 'item_key', 'attested_by', 'attested_at'];

/**
 * Every handoff answered onto a case, newest visit first. Office-scoped; the
 * case id alone never crosses offices.
 */
async function listForCase(q, office, caseId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs
      WHERE office_id = $1 AND case_id = $2
      ORDER BY visit_date DESC, created_at DESC LIMIT 100`,
    [office, caseId]
  );
  return res.rows;
}

/** The handoffs linked to any of these cases (the pipeline badge). */
async function listForCases(q, office, caseIds) {
  if (caseIds.length === 0) return [];
  const res = await q.query(
    `SELECT handoff_id, case_id, payload FROM tc_checkout_handoffs
      WHERE office_id = $1 AND case_id = ANY($2)`,
    [office, caseIds]
  );
  return res.rows;
}

/** Every attestation on these handoffs. */
async function listAttestations(q, office, handoffIds) {
  if (handoffIds.length === 0) return [];
  const res = await q.query(
    `SELECT ${ATTESTATION_COLS.join(', ')} FROM tc_checkout_attestations
      WHERE office_id = $1 AND handoff_id = ANY($2)`,
    [office, handoffIds]
  );
  return res.rows;
}

/** One attestation, or null. */
async function findAttestation(q, office, handoffId, index) {
  const res = await q.query(
    `SELECT ${ATTESTATION_COLS.join(', ')} FROM tc_checkout_attestations
      WHERE office_id = $1 AND handoff_id = $2 AND item_index = $3`,
    [office, handoffId, index]
  );
  return res.rows[0] || null;
}

/**
 * Record (or re-record over a stale one) "this item is in Open Dental".
 * Returns the stored row, read back by RETURNING: what the caller reports is
 * what persisted.
 */
async function upsertAttestation(q, { office, handoffId, index, itemKey, actor, at }) {
  const res = await q.query(
    `INSERT INTO tc_checkout_attestations (office_id, handoff_id, item_index, item_key, attested_by, attested_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (office_id, handoff_id, item_index) DO UPDATE SET item_key = EXCLUDED.item_key, attested_by = EXCLUDED.attested_by, attested_at = EXCLUDED.attested_at RETURNING ${ATTESTATION_COLS.join(', ')}`,
    [office, handoffId, index, itemKey, actor, at]
  );
  return res.rows[0] || null;
}

/** Remove one attestation; returns the removed row, or null if there was none. */
async function deleteAttestation(q, office, handoffId, index) {
  const res = await q.query(
    `DELETE FROM tc_checkout_attestations WHERE office_id = $1 AND handoff_id = $2 AND item_index = $3 RETURNING ${ATTESTATION_COLS.join(', ')}`,
    [office, handoffId, index]
  );
  return res.rows[0] || null;
}

/** The snapshot's procedures (an empty list for a malformed payload). */
function proceduresOf(row) {
  const payload = obj(row.payload);
  return payload && Array.isArray(payload.procedures) ? payload.procedures : [];
}

/**
 * The staff panel's items for one handoff: each staged procedure with its
 * CURRENT attestation. An attestation made against a different item (the
 * snapshot was revised after it) is `stale` and does not count as entered.
 * Pure.
 *
 * @param {object} row  a tc_checkout_handoffs row
 * @param {object[]} attestations  rows for this handoff
 * @param {(p: object) => string} keyOf  contract.checkoutItemKey
 */
function panelItems(row, attestations, keyOf) {
  const byIndex = new Map(attestations.map((a) => [Number(a.item_index), a]));
  return proceduresOf(row).map((procedure, index) => {
    const a = byIndex.get(index);
    const current = Boolean(a) && a.item_key === keyOf(procedure);
    return {
      index,
      procedure,
      enteredBy: current ? a.attested_by : null,
      enteredAt: current ? iso(a.attested_at) : null,
      stale: Boolean(a) && !current,
    };
  });
}

/**
 * The case ids, among these handoffs, with at least one staged item not yet
 * attested as entered in Open Dental. Pure.
 */
function casesWithUnenteredTreatment(handoffRows, attestations, keyOf) {
  const byHandoff = new Map();
  for (const a of attestations) {
    const k = String(a.handoff_id);
    if (!byHandoff.has(k)) byHandoff.set(k, []);
    byHandoff.get(k).push(a);
  }
  const out = new Set();
  for (const row of handoffRows) {
    const items = panelItems(row, byHandoff.get(String(row.handoff_id)) || [], keyOf);
    if (items.some((i) => i.enteredBy === null)) out.add(String(row.case_id));
  }
  return out;
}

/** One office's handoffs for one office day, in the given statuses, newest first. */
async function listForDay(q, office, day, statuses) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs
      WHERE office_id = $1 AND visit_date = $2 AND status = ANY($3)
      ORDER BY created_at DESC, handoff_id DESC LIMIT 500`,
    [office, day, [...statuses]]
  );
  return res.rows;
}

/**
 * Close every still-waiting handoff whose office day has passed, as `expired`.
 *
 * One statement PER PRIOR STATUS, so each closed row is known with what it was
 * — the audit row's `prior_state`. Conditional on that status, so a row a human
 * acted on in the meantime is never overwritten.
 *
 * @returns {Promise<Array<{ handoffId: string, priorState: 'open'|'claimed' }>>}
 */
async function expireBefore(q, office, today) {
  const out = [];
  for (const prior of WAITING_STATUSES) {
    const res = await q.query(
      `UPDATE tc_checkout_handoffs
          SET status = 'expired', expired_at = now(), expired_by = $4, updated_at = now()
        WHERE office_id = $1 AND status = $2 AND visit_date < $3
        RETURNING handoff_id`,
      [office, prior, today, EXPIRY_ACTOR]
    );
    for (const r of res.rows) out.push({ handoffId: String(r.handoff_id), priorState: prior });
  }
  return out;
}

/** Claim: open → claimed. Conditional; false when somebody else got there. */
async function claim(q, { office, handoffId, actor }) {
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET status = 'claimed', claimed_by = $3, claimed_at = now(), updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND status = 'open'
      RETURNING handoff_id`,
    [office, handoffId, actor]
  );
  return res.rowCount === 1;
}

/**
 * Dismiss: open/claimed → dismissed, with a reason. One conditional statement
 * PER PRIOR STATUS (like expireBefore), so the status it replaced is the one
 * the database matched — never a read taken before a concurrent claim.
 *
 * @returns {Promise<'open'|'claimed'|null>} what it was, or null when nothing matched
 */
async function dismiss(q, { office, handoffId, actor, reason }) {
  for (const prior of WAITING_STATUSES) {
    const res = await q.query(
      `UPDATE tc_checkout_handoffs
          SET status = 'dismissed', dismissed_reason = $3, dismissed_by = $4, dismissed_at = now(),
              updated_at = now()
        WHERE office_id = $1 AND handoff_id = $2 AND status = $5
        RETURNING handoff_id`,
      [office, handoffId, reason, actor, prior]
    );
    if (res.rowCount === 1) return prior;
  }
  return null;
}

/**
 * Record an outcome: open/claimed → scheduled | not_scheduled | nothing_needed.
 * Conditional on the status the caller READ, so two people answering the same
 * checkout cannot both win; the loser's transaction (and any case it made)
 * rolls back.
 */
async function recordOutcome(q, { office, handoffId, expectStatus, outcome, actor, appointmentNote, caseId }) {
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET status = $4, outcome_by = $5, outcome_at = now(), appointment_note = $6, case_id = $7,
            updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND status = $3
      RETURNING handoff_id`,
    [office, handoffId, expectStatus, outcome, actor, appointmentNote, caseId]
  );
  return res.rowCount === 1;
}

/** The handoff for one source key in one office, or null. */
async function findBySourceKey(q, office, sourceKey) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs WHERE office_id = $1 AND source_key = $2`,
    [office, sourceKey]
  );
  return res.rows[0] || null;
}

/** Insert a new handoff. Throws the pg error on a duplicate key (23505). */
async function insertHandoff(q, row) {
  const cols = [
    'handoff_id',
    'office_id',
    'source_key',
    'od_patient_id',
    'patient_name',
    'provider',
    'provider_seen',
    'operatory',
    'visit_date',
    'payload',
    'is_final',
    'revision',
    'submitted_by',
    'updated_by',
    'status',
  ];
  const placeholders = cols.map((c, i) => (c === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await q.query(
    `INSERT INTO tc_checkout_handoffs (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    cols.map((c) =>
      c === 'payload' ? JSON.stringify(row[c]) : c === 'status' ? row.status || 'open' : row[c]
    )
  );
}

/**
 * Replace a handoff's snapshot — conditional on the revision the caller read,
 * so two racing updates cannot both apply (the loser sees rowCount 0).
 *
 * @returns {Promise<boolean>} whether THIS call's update applied
 */
async function updatePayload(q, { office, handoffId, expectRevision, row }) {
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET payload = $3::jsonb, is_final = $4, revision = $5, patient_name = $6,
            provider = $7, provider_seen = $8, operatory = $9, updated_by = $10,
            updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND revision = $11`,
    [
      office,
      handoffId,
      JSON.stringify(row.payload),
      row.is_final,
      expectRevision + 1,
      row.patient_name,
      row.provider,
      row.provider_seen,
      row.operatory,
      row.updated_by,
      expectRevision,
    ]
  );
  return res.rowCount === 1;
}

module.exports = {
  COLS,
  WAITING_STATUSES,
  STATUSES,
  EXPIRY_ACTOR,
  OUTCOMES,
  PG_UNIQUE_VIOLATION,
  toHandoff,
  findById,
  listForCase,
  listForCases,
  listAttestations,
  findAttestation,
  upsertAttestation,
  deleteAttestation,
  proceduresOf,
  panelItems,
  casesWithUnenteredTreatment,
  listForDay,
  expireBefore,
  claim,
  dismiss,
  recordOutcome,
  findBySourceKey,
  insertHandoff,
  updatePayload,
};
