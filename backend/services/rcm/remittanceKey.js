'use strict';

/**
 * The remittance key — RCM's dedupe primitive, ported from
 * `rcm-posting @ fix/prod-acr-registry-identity` (9bf5ac8), `server/db.ts`.
 *
 * A remittance key is a deterministic string identifying ONE carrier payment
 * from its own contents: trace number, payer, payment date, amount, check
 * number. Two uploads of the same 835 produce the same key; two genuinely
 * different checks cannot. The database's `UNIQUE (office_id, remittance_key)`
 * is the backstop, and this module is the behaviour around it.
 *
 * ─── Office is IN the key's uniqueness (the port's one structural change) ──
 *
 * The source declared a bare global `UNIQUE(remittanceKey)`, which it could
 * afford because it had no office dimension at all. Here two practices
 * legitimately receive distinct checks whose components collide — same payer,
 * same day, same amount — and under a global key one office's remittance would
 * silently block the other's. The failure would look exactly like successful
 * dedupe, which is the worst way for it to look. Every statement below is
 * therefore scoped by `office_id`, including the ON CONFLICT target.
 *
 * ─── There is no forceDuplicate, and there is no successor to it ───────────
 *
 * The source carried an override that skipped the check. It is not ported, and
 * no flag, query param, or header replaces it. If a legitimate re-process case
 * appears, it stops the work and goes to the PM as a named, designed operation
 * — because "post this check again" is a decision about money, and the moment
 * it exists as a generic escape hatch it becomes the thing everyone reaches for
 * when the real answer is that something else is wrong.
 *
 * ─── The reservation protocol, and what Slice 5 actually needs of it ──────
 *
 *   reserve  → 'pending'  a key is claimed BEFORE the work it guards
 *   finalize → 'posted'   the work committed; blocks forever after
 *   release  → 'failed'   nothing landed; a retry may take the key over
 *
 * `pending` blocks as firmly as `posted`. A stuck `pending` means a run died
 * mid-flight, and until a human has confirmed what did or did not land, the
 * safe reading of "we may have already done this" is that we did.
 *
 * **In Slice 5 the guarded work is a single Postgres transaction**, so reserve,
 * the proposal writes, and finalize all commit or all roll back together — a
 * failure leaves no key row at all, which is a cleaner retry than 'failed' and
 * is what the route relies on. Two concurrent uploads of one file are still
 * ordered correctly, by the unique index rather than by application code: the
 * second INSERT waits on the first's uncommitted row and then either conflicts
 * or proceeds, depending on how the first ended.
 *
 * `releaseRemittanceKey` is therefore NOT on this slice's happy path. It is
 * implemented, tested, and exported here because Slice 6 — which writes to Open
 * Dental between reserve and finalize, where a rollback cannot undo what
 * already reached the chart — is the consumer that needs all three states, and
 * because it is the operator's recovery for a crashed reservation today.
 *
 * ─── Statement-level, not pool-level, on purpose ───────────────────────────
 *
 * Every function takes a `client` (a pg client or pool). That is what lets the
 * caller run the whole protocol inside one `BEGIN`; a module that opened its
 * own connection could not participate in the caller's transaction, and the
 * reservation would commit independently of the rows it guards.
 */

/** Thrown when a remittance carries neither a trace number nor a check number. */
class RemittanceIdentityError extends Error {
  constructor(message) {
    super(
      message ||
        'Remittance has no trace number or check number — cannot build a remittance key'
    );
    this.name = 'RemittanceIdentityError';
    this.code = 'REMITTANCE_IDENTITY_MISSING';
  }
}

/**
 * Build the canonical key string from identity components.
 *
 * Uppercased and pipe-joined so equivalent inputs cannot diverge on case or
 * padding. Missing payer and missing date become the literals `NO_PAYER` /
 * `NO_DATE` rather than empty segments — an empty segment would let two
 * different absences collide.
 *
 * `paymentDate` MUST be the remittance's own date. Never today: a key that
 * embeds the current date is different tomorrow, and a dedupe primitive that
 * changes over time detects nothing.
 *
 * @param {{ traceNumber?: string, payerId?: string, paymentDate?: string|null,
 *           paymentAmountCents: number, checkNumber?: string }} params
 * @returns {string}
 * @throws {RemittanceIdentityError} when trace and check are both blank
 */
function generateRemittanceKey(params) {
  const trace = (params.traceNumber || '').trim();
  const check = (params.checkNumber || '').trim();
  if (!trace && !check) throw new RemittanceIdentityError();

  return [
    trace || 'NO_TRACE',
    (params.payerId || '').trim() || 'NO_PAYER',
    (params.paymentDate || '').trim() || 'NO_DATE',
    String(params.paymentAmountCents),
    check,
  ]
    .join('|')
    .toUpperCase();
}

/**
 * Identity components of a payment batch — the shape both the key and the
 * stored `rcm_remittance_keys` row are built from, so the row can never
 * describe something other than the key indexing it.
 *
 * `payerId` is the payer NAME. The source did the same, and the 835 gives us
 * no better identifier: `payerIdentifier` was never populated there either,
 * and a payer's own id is optional in the file.
 *
 * @param {{ traceNumber?: string|null, checkNumber?: string|null,
 *           eftNumber?: string|null, payer?: string|null,
 *           depositDate?: string|null, totalAmountCents: number }} batch
 */
function batchRemittanceIdentity(batch) {
  return {
    traceNumber: batch.traceNumber || batch.checkNumber || batch.eftNumber || '',
    payerId: batch.payer || 'UNKNOWN',
    paymentDate: batch.depositDate || '',
    paymentAmountCents: batch.totalAmountCents,
    checkNumber: batch.checkNumber == null ? undefined : batch.checkNumber,
  };
}

/**
 * The canonical key for a payment batch. Every call site derives keys through
 * here, so a preflight and a submit can never disagree about what they are
 * about to guard.
 * @param {Parameters<typeof batchRemittanceIdentity>[0]} batch
 * @returns {string}
 */
function buildBatchRemittanceKey(batch) {
  return generateRemittanceKey(batchRemittanceIdentity(batch));
}

/**
 * Identity for one parsed 835 transaction (`ParsedRemittance` from eraParser).
 *
 * The adapter exists so the ERA path and the future Stedi path build identical
 * keys for the same check: the same physical payment must not dedupe
 * differently depending on which door it came through.
 *
 * @param {{ traceNumber: string, checkNumber: string, payerName: string,
 *           paymentDate: string|null, totalPaymentCents: number }} remittance
 */
function remittanceIdentity(remittance) {
  return batchRemittanceIdentity({
    traceNumber: remittance.traceNumber,
    // eraParser sets checkNumber = TRN02, and falls back to the literal
    // 'UNKNOWN' when there is no TRN at all. 'UNKNOWN' is not an identity —
    // letting it into the key would make every trace-less remittance from a
    // payer on a date for an amount collide with every other one.
    checkNumber: remittance.checkNumber === 'UNKNOWN' ? null : remittance.checkNumber,
    payer: remittance.payerName,
    depositDate: remittance.paymentDate,
    totalAmountCents: remittance.totalPaymentCents,
  });
}

/** The canonical key for one parsed 835 transaction. */
function buildRemittanceKey(remittance) {
  return generateRemittanceKey(remittanceIdentity(remittance));
}

/**
 * Columns selected when reporting an existing reservation. Named explicitly —
 * no `SELECT *` in this repo, and here the list is also the answer's shape.
 */
const KEY_COLUMNS =
  'remittance_key_id, office_id, remittance_key, status, batch_id, reserved_at, posted_at';

/**
 * @typedef {{ reserved: true, remittanceKeyId: string }} Reserved
 * @typedef {{ reserved: false, status: 'pending'|'posted', remittanceKeyId: string|null,
 *             batchId: string|null, postedAt: Date|null, reservedAt: Date|null }} Blocked
 */

/**
 * Claim a remittance key for this office.
 *
 * `ON CONFLICT DO NOTHING` rather than a read-then-write: the read-then-write
 * loses to a concurrent upload of the same file, and the whole point of this
 * function is that it cannot.
 *
 * A `failed` row is taken over atomically (the UPDATE re-asserts the status in
 * its WHERE, so two retries cannot both win it). A `pending` or `posted` row
 * blocks and is reported with enough detail for an honest refusal — which
 * batch it produced, and when.
 *
 * @param {{ query: Function }} client pg client or pool; pass the transaction's
 *   client so the reservation commits with the rows it guards
 * @param {{ officeId: string, remittanceKey: string, traceNumber: string,
 *           payerId: string, paymentDate: string, paymentAmountCents: number,
 *           checkNumber?: string|null }} data
 * @returns {Promise<Reserved|Blocked>}
 */
async function reserveRemittanceKey(client, data) {
  // `posted_at` is deliberately omitted: the column is NOT NULL with a now()
  // default (it was designed for rows written after a successful post), so a
  // reservation necessarily carries one. `reserved_at` is the honest timestamp
  // for a 'pending' row, and `status` is what says which to believe.
  const inserted = await client.query(
    `INSERT INTO rcm_remittance_keys
       (office_id, trace_number, payer_id, payment_date, payment_amount_cents,
        check_number, remittance_key, status, reserved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now())
     ON CONFLICT (office_id, remittance_key) DO NOTHING
     RETURNING remittance_key_id`,
    [
      data.officeId,
      data.traceNumber,
      data.payerId,
      data.paymentDate,
      data.paymentAmountCents,
      data.checkNumber || null,
      data.remittanceKey,
    ]
  );
  if (inserted.rows.length > 0) {
    return { reserved: true, remittanceKeyId: inserted.rows[0].remittance_key_id };
  }

  const existing = await client.query(
    `SELECT ${KEY_COLUMNS} FROM rcm_remittance_keys
      WHERE office_id = $1 AND remittance_key = $2
      LIMIT 1`,
    [data.officeId, data.remittanceKey]
  );
  const row = existing.rows[0];
  if (!row) {
    // The insert conflicted but the row is not visible: another transaction
    // holds it uncommitted. Fail closed — treat it as a live reservation.
    return {
      reserved: false,
      status: 'pending',
      remittanceKeyId: null,
      batchId: null,
      postedAt: null,
      reservedAt: null,
    };
  }

  if (row.status === 'failed') {
    const taken = await client.query(
      `UPDATE rcm_remittance_keys
          SET status = 'pending', reserved_at = now(), updated_at = now()
        WHERE office_id = $1 AND remittance_key = $2 AND status = 'failed'
      RETURNING remittance_key_id`,
      [data.officeId, data.remittanceKey]
    );
    if (taken.rows.length > 0) {
      return { reserved: true, remittanceKeyId: taken.rows[0].remittance_key_id };
    }
  }

  return {
    reserved: false,
    status: row.status === 'posted' ? 'posted' : 'pending',
    remittanceKeyId: row.remittance_key_id,
    batchId: row.batch_id || null,
    postedAt: row.posted_at || null,
    reservedAt: row.reserved_at || null,
  };
}

/**
 * Mark a reservation posted and link it to what it produced.
 *
 * The link matters as much as the status: an honest refusal of the NEXT upload
 * has to be able to say which batch the first one became.
 *
 * @param {{ query: Function }} client
 * @param {{ officeId: string, remittanceKey: string, batchId?: string|null }} data
 * @returns {Promise<void>}
 */
async function finalizeRemittanceKey(client, data) {
  await client.query(
    `UPDATE rcm_remittance_keys
        SET status = 'posted', posted_at = now(), updated_at = now(),
            batch_id = COALESCE($3, batch_id)
      WHERE office_id = $1 AND remittance_key = $2`,
    [data.officeId, data.remittanceKey, data.batchId || null]
  );
}

/**
 * Release a reservation whose guarded work definitively did not happen.
 *
 * Only ever transitions `pending` → `failed`, and the status is re-asserted in
 * the WHERE so this can never un-post a finalized key.
 *
 * NEVER call this when any part of the guarded work may have succeeded — in
 * Slice 6, when anything may have reached Open Dental. Leaving a key `pending`
 * costs one operator check; releasing one that half-posted invites a second
 * payment against the same claim.
 *
 * @param {{ query: Function }} client
 * @param {{ officeId: string, remittanceKey: string }} data
 * @returns {Promise<boolean>} whether a reservation was actually released
 */
async function releaseRemittanceKey(client, data) {
  const res = await client.query(
    `UPDATE rcm_remittance_keys
        SET status = 'failed', updated_at = now()
      WHERE office_id = $1 AND remittance_key = $2 AND status = 'pending'
      RETURNING remittance_key_id`,
    [data.officeId, data.remittanceKey]
  );
  return res.rows.length > 0;
}

/**
 * Read-side check: has this office already processed this remittance?
 *
 * Unlike `reserveRemittanceKey` this does NOT fail closed on an absent row —
 * it is a question, not a guard, and the guard is the reservation.
 *
 * @param {{ query: Function }} client
 * @param {{ officeId: string, remittanceKey: string }} data
 * @returns {Promise<{ alreadyProcessed: boolean, status?: string, batchId?: string|null, postedAt?: Date|null }>}
 */
async function checkRemittanceProcessed(client, data) {
  const res = await client.query(
    `SELECT ${KEY_COLUMNS} FROM rcm_remittance_keys
      WHERE office_id = $1 AND remittance_key = $2
      LIMIT 1`,
    [data.officeId, data.remittanceKey]
  );
  const row = res.rows[0];
  if (!row || row.status === 'failed') return { alreadyProcessed: false };
  return {
    alreadyProcessed: true,
    status: row.status,
    batchId: row.batch_id || null,
    postedAt: row.posted_at || null,
  };
}

module.exports = {
  RemittanceIdentityError,
  generateRemittanceKey,
  batchRemittanceIdentity,
  buildBatchRemittanceKey,
  remittanceIdentity,
  buildRemittanceKey,
  reserveRemittanceKey,
  finalizeRemittanceKey,
  releaseRemittanceKey,
  checkRemittanceProcessed,
};
