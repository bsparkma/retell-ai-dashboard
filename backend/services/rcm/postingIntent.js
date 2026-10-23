'use strict';

/**
 * W-21 — THE DRAIN'S WRITE-AHEAD LOG, AND THE ONE PLACE A PLAN'S ENDING IS
 * JUDGED FROM EVIDENCE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ═════════════════════════════════════════════════════════════════════════════
 * Before ANY call that writes to Open Dental, an intent row naming that write is
 * committed. `recordIntent` returns a receipt only after the INSERT has come
 * back, and `odPostingWrites.js` refuses to issue a write without a receipt of
 * the matching kind — so "no Open Dental write without a trace" is enforced by
 * the writer, not remembered by each caller.
 *
 * A crash one instruction after the write leaves a `pending` intent. A `pending`
 * intent means "this may or may not be in the chart", and it is resolved ONLY by
 * reading the chart — never by the fact that the run died.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW AN ENDING IS CLASSIFIED — CLAIM BY CLAIM, FROM THE RECORD
 * ═════════════════════════════════════════════════════════════════════════════
 *   clean       zero intents and no stored proof. Nothing was written. The ONLY
 *               classification allowed to say so.
 *   unknown     at least one intent is still `pending`. Its own state
 *               (`outcome_unknown`) — never `failed`, never `posted`.
 *   proven      an intent settled `landed`/`disagreed`, or the line already
 *               carries proof from before intents existed (a check number, an
 *               adjustment id, a written status). `partially_posted`.
 *   not_landed  intents exist and every one was settled `absent` or `refused`:
 *               attempted, and proven not to be in the chart. `failed` — which
 *               the screens never render as "nothing was written".
 *
 * A plan is `outcome_unknown` if any claim is unknown, else `partially_posted`
 * if any claim is proven, else `failed`. Unknown dominates on purpose: a plan
 * where one claim is proven and another may or may not have moved is a plan
 * whose total nobody can state, and the press that resolves it re-reads first.
 *
 * No patient identity is stored here — identifiers and cents only.
 */

/** The receipts this module minted. A forged object cannot get in. */
const RECEIPTS = new WeakSet();

const WRITE_KINDS = Object.freeze({
  CLAIMPROC_RECEIVED: 'claimproc_received',
  CLAIM_RECEIVED: 'claim_received',
  CLAIM_PAYMENT: 'claim_payment',
  WRITEOFF_ADJUSTMENT: 'writeoff_adjustment',
  RECOUPMENT_ADJUSTMENT: 'recoupment_adjustment',
  RECOUPMENT_SUPPLEMENTAL: 'recoupment_supplemental',
  DOCUMENT_UPLOAD: 'document_upload',
});

const OUTCOMES = Object.freeze({
  PENDING: 'pending',
  LANDED: 'landed',
  DISAGREED: 'disagreed',
  ABSENT: 'absent',
  REFUSED: 'refused',
});

/** Settled outcomes that PROVE a write reached the chart. */
const PROOF_OUTCOMES = Object.freeze([OUTCOMES.LANDED, OUTCOMES.DISAGREED]);

const CLAIM_CLASSES = Object.freeze({
  CLEAN: 'clean',
  UNKNOWN: 'unknown',
  PROVEN: 'proven',
  NOT_LANDED: 'not_landed',
});

const INTENT_COLUMNS = [
  'intent_id',
  'office_id',
  'queue_id',
  'queue_line_id',
  'od_claim_num',
  'attempt',
  'write_kind',
  'target',
  'outcome',
  'evidence',
  'created_at',
  'resolved_at',
];

/**
 * Hoisted for the reason `postingDrain.PLAN_QUERIES` is: `scripts/rcm-verify-
 * queries.js` sends the real text to a migrated Postgres in CI.
 */
const INTENT_QUERIES = Object.freeze({
  insert:
    'INSERT INTO rcm_posting_intent ' +
    '(office_id, queue_id, queue_line_id, od_claim_num, attempt, write_kind, target, outcome, created_at) ' +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now()) RETURNING intent_id",
  /*
   * `AND outcome = 'pending'` makes settling a compare-and-set: an intent is
   * settled once, and a second read cannot overwrite the first verdict.
   */
  resolve:
    'UPDATE rcm_posting_intent SET outcome = $3, evidence = $4, resolved_at = now() ' +
    "WHERE intent_id = $1 AND office_id = $2 AND outcome = 'pending' RETURNING intent_id",
  listForPlan:
    `SELECT ${INTENT_COLUMNS.join(', ')} FROM rcm_posting_intent ` +
    'WHERE office_id = $1 AND queue_id = $2 ORDER BY created_at ASC',
});

/** @param {Record<string, unknown>} row */
function toIntent(row) {
  return {
    intentId: String(row.intent_id),
    officeId: String(row.office_id),
    queueId: String(row.queue_id),
    queueLineId: row.queue_line_id == null ? null : String(row.queue_line_id),
    odClaimNum: row.od_claim_num == null ? null : Number(row.od_claim_num),
    attempt: Number(row.attempt || 0),
    writeKind: String(row.write_kind),
    target: row.target && typeof row.target === 'object' ? row.target : {},
    outcome: String(row.outcome),
    evidence: row.evidence == null ? null : row.evidence,
  };
}

/**
 * Commit the intent, THEN hand back the receipt the writer demands.
 *
 * Throws if the INSERT throws — and then no write happens, because nobody holds
 * a receipt. That is the fail-closed half: a database that cannot record the
 * intent is a database that cannot later prove what happened.
 *
 * @param {{ query: Function }} pool
 * @param {{ office: string, queueId: string, queueLineId?: string|null,
 *           odClaimNum?: number|null, attempt: number, writeKind: string,
 *           target: Record<string, unknown> }} spec
 * @returns {Promise<Readonly<{ intentId: string, office: string, queueId: string,
 *           queueLineId: string|null, odClaimNum: number|null, writeKind: string }>>}
 */
async function recordIntent(pool, spec) {
  if (!Object.values(WRITE_KINDS).includes(spec.writeKind)) {
    throw new Error(`postingIntent: unknown write kind '${spec.writeKind}'`);
  }
  if (!spec.office || !spec.queueId) {
    throw new Error('postingIntent: an intent needs its office and its plan');
  }
  const res = await pool.query(INTENT_QUERIES.insert, [
    spec.office,
    spec.queueId,
    spec.queueLineId || null,
    spec.odClaimNum == null ? null : Number(spec.odClaimNum),
    Number(spec.attempt || 0),
    spec.writeKind,
    JSON.stringify(spec.target || {}),
  ]);
  const intentId = res.rows[0] && res.rows[0].intent_id;
  if (!intentId) throw new Error('postingIntent: the intent INSERT returned no id');

  const receipt = Object.freeze({
    intentId: String(intentId),
    office: spec.office,
    queueId: spec.queueId,
    queueLineId: spec.queueLineId || null,
    odClaimNum: spec.odClaimNum == null ? null : Number(spec.odClaimNum),
    writeKind: spec.writeKind,
  });
  RECEIPTS.add(receipt);
  return receipt;
}

/**
 * Is this a receipt THIS module minted, for THIS kind of write?
 *
 * @param {unknown} receipt
 * @param {string} writeKind
 * @returns {boolean}
 */
function isReceiptFor(receipt, writeKind) {
  return (
    typeof receipt === 'object' &&
    receipt !== null &&
    RECEIPTS.has(receipt) &&
    /** @type {{ writeKind: string }} */ (receipt).writeKind === writeKind
  );
}

/**
 * Settle one intent from evidence. A no-op on one already settled.
 *
 * @param {{ query: Function }} pool
 * @param {{ intentId: string, office?: string, officeId?: string }} intent a receipt or a listed intent
 * @param {string} outcome one of OUTCOMES, never PENDING
 * @param {Record<string, unknown>} evidence ids and money only
 */
async function resolveIntent(pool, intent, outcome, evidence) {
  if (outcome === OUTCOMES.PENDING || !Object.values(OUTCOMES).includes(outcome)) {
    throw new Error(`postingIntent: cannot settle an intent as '${outcome}'`);
  }
  await pool.query(INTENT_QUERIES.resolve, [
    intent.intentId,
    intent.office || intent.officeId,
    outcome,
    JSON.stringify(evidence || {}),
  ]);
}

/**
 * Every intent on a plan, every attempt, oldest first.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @param {string} queueId
 */
async function listIntents(pool, office, queueId) {
  const res = await pool.query(INTENT_QUERIES.listForPlan, [office, queueId]);
  return res.rows.map(toIntent);
}

/**
 * One claim's classification. PURE.
 *
 * @param {{ storedProof: boolean, intents: ReadonlyArray<{ outcome: string }> }} claim
 * @returns {'clean'|'unknown'|'proven'|'not_landed'}
 */
function classifyClaim(claim) {
  const intents = claim.intents || [];
  if (intents.some((i) => i.outcome === OUTCOMES.PENDING)) return CLAIM_CLASSES.UNKNOWN;
  if (claim.storedProof === true || intents.some((i) => PROOF_OUTCOMES.includes(i.outcome))) {
    return CLAIM_CLASSES.PROVEN;
  }
  if (intents.length === 0) return CLAIM_CLASSES.CLEAN;
  return CLAIM_CLASSES.NOT_LANDED;
}

/**
 * A plan's ending, from its claims. PURE.
 *
 * `lines` carry `odClaimNum` and a `storedProof` boolean the caller computed
 * (proof recorded on the line itself — what a plan that predates intents has).
 * Intents are grouped onto claims by `odClaimNum`; one with no claim (an EOB
 * filed into a patient) forms its own group.
 *
 * @param {{ lines: ReadonlyArray<{ odClaimNum: number|null, storedProof: boolean }>,
 *           intents: ReadonlyArray<{ odClaimNum: number|null, outcome: string }> }} input
 * @returns {{ status: 'outcome_unknown'|'partially_posted'|'failed', nothingWritten: boolean,
 *             claims: Array<{ odClaimNum: number|null, class: string, pending: number }> }}
 */
function classifyPlan(input) {
  /** @type {Map<string, { odClaimNum: number|null, storedProof: boolean, intents: object[] }>} */
  const byClaim = new Map();
  const slot = (odClaimNum) => {
    const key = odClaimNum == null ? 'none' : String(Number(odClaimNum));
    if (!byClaim.has(key)) {
      byClaim.set(key, {
        odClaimNum: odClaimNum == null ? null : Number(odClaimNum),
        storedProof: false,
        intents: [],
      });
    }
    return byClaim.get(key);
  };
  for (const line of input.lines || []) {
    const c = slot(line.odClaimNum);
    if (line.storedProof === true) c.storedProof = true;
  }
  for (const intent of input.intents || []) slot(intent.odClaimNum).intents.push(intent);

  const claims = [...byClaim.values()].map((c) => ({
    odClaimNum: c.odClaimNum,
    class: classifyClaim(c),
    pending: c.intents.filter((i) => i.outcome === OUTCOMES.PENDING).length,
  }));

  let status = 'failed';
  if (claims.some((c) => c.class === CLAIM_CLASSES.UNKNOWN)) status = 'outcome_unknown';
  else if (claims.some((c) => c.class === CLAIM_CLASSES.PROVEN)) status = 'partially_posted';

  return {
    status,
    nothingWritten: claims.every((c) => c.class === CLAIM_CLASSES.CLEAN),
    claims,
  };
}

module.exports = {
  WRITE_KINDS,
  OUTCOMES,
  PROOF_OUTCOMES,
  CLAIM_CLASSES,
  INTENT_COLUMNS,
  INTENT_QUERIES,
  recordIntent,
  isReceiptFor,
  resolveIntent,
  listIntents,
  classifyClaim,
  classifyPlan,
};
