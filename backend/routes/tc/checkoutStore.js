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
  // CO-1.
  'workup',
  // CO-5a.
  'source',
  'hygiene_merged_at',
  // CO-5a fix.
  'reopened_from',
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
    workup: workupOf(row),
    // CO-5a. NULL is every record before it: they all came from hygiene.
    source: row.source === 'manual' ? 'manual' : 'hygiene',
    hygieneMergedAt: iso(row.hygiene_merged_at),
    reopenedFrom: reopenedOf(row),
  };
}

/** The answer a reopened card had (CO-5a fix), or null. */
function reopenedOf(row) {
  const r = obj(row.reopened_from);
  return r && typeof r === 'object' && !Array.isArray(r) && r.outcome ? r : null;
}

/**
 * The row's workup checklist (CO-1), always the full shape: a NULL column (every
 * record before CO-1, and every one nobody has ticked) reads as nothing ticked.
 */
function workupOf(row) {
  const w = obj(row.workup);
  const o = w && typeof w === 'object' && !Array.isArray(w) ? w : {};
  const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    workedUp: record(o.workedUp),
    present: record(o.present),
    collected: o.collected && typeof o.collected === 'object' ? o.collected : null,
    referrals: o.referrals && typeof o.referrals === 'object' ? o.referrals : null,
  };
}

/**
 * Lock one handoff's row for the rest of the transaction (SELECT … FOR
 * UPDATE), so two ticks on the same checkout serialize instead of one
 * read-modify-write erasing the other. A lock, not a write: a refused or no-op
 * tick leaves the row exactly as it was (review round 1). False when there is
 * no such row in this office.
 */
async function lockHandoff(q, office, handoffId) {
  const res = await q.query(
    'SELECT handoff_id FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2 FOR UPDATE',
    [office, handoffId]
  );
  return res.rows.length === 1;
}

/** Replace the workup checklist (call with the row locked). A real change, so updated_at moves. */
async function writeWorkup(q, office, handoffId, workup) {
  const res = await q.query(
    'UPDATE tc_checkout_handoffs SET workup = $3::jsonb, updated_at = now() WHERE office_id = $1 AND handoff_id = $2 RETURNING handoff_id',
    [office, handoffId, JSON.stringify(workup)]
  );
  return res.rowCount === 1;
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

// ── CO-1: same-day hygiene intakes belong to the checkout card ─────────────

/**
 * The checkout statuses that HAND a same-day hygiene intake back to the TC
 * Inbox: "not a checkout after all" (dismissed), and a day that ended with
 * nobody answering it (expired). Every other status means the front desk has
 * the patient: waiting (open / claimed) or answered.
 */
const RELEASES_INBOX_STATUSES = Object.freeze(['dismissed', 'expired']);

/**
 * The checkout handoffs, in one office, for any of these patients on any of
 * these days. One indexed, office-scoped read; the caller does the matching.
 */
async function listForPatientsOnDays(q, office, odPatientIds, days) {
  if (odPatientIds.length === 0 || days.length === 0) return [];
  const res = await q.query(
    `SELECT handoff_id, od_patient_id, visit_date, status FROM tc_checkout_handoffs
      WHERE office_id = $1 AND od_patient_id = ANY($2) AND visit_date = ANY($3)`,
    [office, odPatientIds, days]
  );
  return res.rows;
}

/**
 * Which Inbox rows a same-day checkout entry claims. Pure.
 *
 * An intake is "same-day" when a checkout handoff in the same office exists for
 * the same Open Dental patient with the same visit day, in a status that holds
 * it (anything but RELEASES_INBOX_STATUSES). An intake with no PatNum, or no
 * day, is never claimed: there is nothing to match it on.
 *
 * @param {Array<{ od_patient_id: unknown, day: string|null }>} intakes
 * @param {Array<{ od_patient_id: unknown, visit_date: unknown, status: string }>} handoffs
 * @returns {boolean[]} true = belongs to the checkout card, not the Inbox
 */
function claimedBySameDayCheckout(intakes, handoffs) {
  const holding = new Set(
    handoffs
      .filter((h) => !RELEASES_INBOX_STATUSES.includes(h.status || 'open'))
      .map((h) => `${num(h.od_patient_id)}|${isoDate(h.visit_date)}`)
  );
  return intakes.map((i) => i.od_patient_id != null && i.day != null && holding.has(`${num(i.od_patient_id)}|${i.day}`));
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
    'source',
  ];
  const placeholders = cols.map((c, i) => (c === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await q.query(
    `INSERT INTO tc_checkout_handoffs (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    cols.map((c) =>
      c === 'payload'
        ? JSON.stringify(row[c])
        : c === 'status'
          ? row.status || 'open'
          : c === 'source'
            ? row.source || 'hygiene'
            : row[c]
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

// ── CO-5a: a card added by hand, and a hygiene handoff that arrives after ───

/** The statuses in which a card still HOLDS its patient for the day (CO-1's rule). */
const HOLDING_STATUSES = Object.freeze(STATUSES.filter((st) => !RELEASES_INBOX_STATUSES.includes(st)));

/**
 * Serialize, for the rest of the transaction, everything that creates or
 * merges a checkout card for ONE patient on ONE day in ONE office: two "Add
 * patient" clicks, or a click and a hygiene handoff arriving at the same
 * moment, run one after the other, so the second sees the first's card. A
 * transaction-scoped advisory lock: released at COMMIT or ROLLBACK, and never
 * blocks anything about any other patient.
 */
async function lockPatientDay(q, office, odPatientId, day) {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tc_checkout_patient_day:${office}:${odPatientId}:${day}`]);
}

/**
 * The newest card that holds this patient on this day in this office — any
 * source, any status but dismissed / expired — or null. "Add patient" opens it
 * instead of making a second.
 */
async function findHoldingForPatientDay(q, office, odPatientId, day) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs
      WHERE office_id = $1 AND od_patient_id = $2 AND visit_date = $3 AND status = ANY($4)
      ORDER BY created_at DESC, handoff_id DESC LIMIT 1`,
    [office, odPatientId, day, [...HOLDING_STATUSES]]
  );
  return res.rows[0] || null;
}

/**
 * The manual card a hygiene handoff for this patient and day merges onto: one
 * added by hand, still holding the patient, that no hygiene handoff has merged
 * onto yet. Null when there is none (the handoff then makes its own card).
 */
async function findManualAwaitingHygiene(q, office, odPatientId, day) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs
      WHERE office_id = $1 AND od_patient_id = $2 AND visit_date = $3 AND status = ANY($4)
        AND source = 'manual' AND hygiene_merged_at IS NULL
      ORDER BY created_at DESC, handoff_id DESC LIMIT 1`,
    [office, odPatientId, day, [...HOLDING_STATUSES]]
  );
  return res.rows[0] || null;
}

/**
 * Merge a hygiene handoff onto a manual card (call with lockPatientDay held).
 * The card takes the hygiene SOURCE KEY, so every later revision from the same
 * visit finds it exactly as it would have found its own card, and the visit's
 * snapshot. It keeps its id, its status, its workup ticks, who added it, and
 * `source = 'manual'`. Conditional on not having merged already, and on the
 * revision the caller read (a compare-and-swap, like updatePayload).
 *
 * @returns {Promise<boolean>} whether THIS call merged
 */
async function mergeHygieneOntoManual(q, { office, handoffId, expectRevision, sourceKey, row }) {
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET source_key = $3, payload = $4::jsonb, is_final = $5, revision = $6, patient_name = $7,
            provider = $8, provider_seen = $9, operatory = $10, updated_by = $11,
            hygiene_merged_at = now(), updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND source = 'manual' AND hygiene_merged_at IS NULL
        AND revision = $12`,
    [
      office,
      handoffId,
      sourceKey,
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

/**
 * A hygiene visit arrived after this card was ANSWERED (CO-5a fix, PM ruling):
 * put it back in Waiting. Clears the outcome — who, when, the note and the
 * case link, which the outcome CHECKs tie to an answered status — and any
 * claim, and keeps what it was in `reopened_from` for the card's history. The
 * case the answer made or moved is left exactly as it is. The checklist ticks
 * stay. Call inside the merge's transaction, with lockPatientDay held;
 * conditional on the status the caller read.
 *
 * @returns {Promise<object|null>} the history it stored, or null when the row
 *   was no longer in that status
 */
async function reopenAnswered(q, { office, handoffId, row, at }) {
  const prior = row.status;
  if (!OUTCOMES.includes(prior)) return null;
  const history = {
    outcome: prior,
    outcomeBy: row.outcome_by ?? null,
    outcomeAt: iso(row.outcome_at),
    appointmentNote: row.appointment_note ?? null,
    caseId: row.case_id ? String(row.case_id) : null,
    reopenedAt: at,
  };
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET status = 'open', outcome_by = $4, outcome_at = $5, appointment_note = $6, case_id = $7,
            claimed_by = $8, claimed_at = $9, reopened_from = $10::jsonb, updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND status = $3`,
    // One NULL per column: Postgres deduces ONE type per parameter, so a single
    // $n shared across text, timestamptz and uuid columns would be refused.
    [office, handoffId, prior, null, null, null, null, null, null, JSON.stringify(history)]
  );
  return res.rowCount === 1 ? history : null;
}

module.exports = {
  COLS,
  WAITING_STATUSES,
  STATUSES,
  EXPIRY_ACTOR,
  OUTCOMES,
  PG_UNIQUE_VIOLATION,
  toHandoff,
  workupOf,
  lockHandoff,
  writeWorkup,
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
  RELEASES_INBOX_STATUSES,
  listForPatientsOnDays,
  claimedBySameDayCheckout,
  findBySourceKey,
  insertHandoff,
  updatePayload,
  HOLDING_STATUSES,
  lockPatientDay,
  findHoldingForPatientDay,
  findManualAwaitingHygiene,
  mergeHygieneOntoManual,
  reopenAnswered,
};
