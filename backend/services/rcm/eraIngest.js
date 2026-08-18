'use strict';

/**
 * Turn a parsed 835 into PROPOSAL rows, inside one transaction (RCM Slice 5).
 *
 * "Proposal" is the load-bearing word. Nothing here is a payment; it is what we
 * read in a carrier's file, recorded so a human can decide. Concretely:
 *
 *   rcm_payment_batches       one carrier check       status 'open' | 'ready'
 *   rcm_batch_claim_payments  one claim's money in it status 'pending'
 *   rcm_claims                the claim itself        status 'pending_review'
 *   rcm_procedure_lines       the service lines
 *   rcm_procedure_adjustments the CARC/RARC codes
 *   rcm_remittance_keys       the dedupe reservation, finalized on success
 *
 * HARD RULE 1: **no Open Dental.** Not a read, not a write, not a lookup.
 * `od_patient_id`, `od_claim_num` and `od_claim_proc_num` are all left NULL —
 * matching a remittance line to a real OD claim needs the odReads seam and one
 * audit row per PHI read, and that is Slice 6. A claim row here asserts "the
 * carrier says it paid this"; it asserts nothing about our chart.
 *
 * HARD RULE 5: honest states. A structure we parsed but will not act on —
 * a reversal, a PLB, a CAS we could not read — is FLAGGED and visible, never
 * dropped and never posted. That is what `needs_review_reasons` on the claim
 * and `status = 'open'` on the batch are for.
 *
 * ─── Everything is one transaction, and that is the release protocol ───────
 *
 * The caller opens a transaction and passes its client. Reserve, every row
 * below, and finalize therefore commit together or not at all. A failure
 * anywhere leaves NO reservation — which is a cleaner retry than the source's
 * `status='failed'` release, and it is why `releaseRemittanceKey` is not on
 * this path (see remittanceKey.js for where it does belong).
 *
 * Concurrency is handled by the unique index, not by application code: two
 * simultaneous uploads of one file race on `(office_id, remittance_key)`, and
 * the loser sees the conflict rather than writing a second set of proposals.
 */

const {
  buildRemittanceKey,
  remittanceIdentity,
  reserveRemittanceKey,
  finalizeRemittanceKey,
  checkRemittanceProcessed,
} = require('./remittanceKey');
const { LINE_FLAGS } = require('./eraParser');

/**
 * The CARC group codes `rcm_procedure_adjustments.group_code` accepts, verbatim
 * from that table's CHECK constraint.
 *
 * An 835 may legally carry a group outside this set. Rather than let the INSERT
 * abort the whole upload, such an adjustment is SKIPPED and its line raises
 * `unexplained_adj` — the same treatment an unreadable CAS gets, and for the
 * same reason: the money is unaccounted for, so say so instead of failing the
 * file or silently swallowing it.
 */
const ADJUSTMENT_GROUP_CODES = Object.freeze(['CO', 'PR', 'OA', 'PI', 'CR']);

/** Review reason recorded when an adjustment could not be stored. */
const UNSTORABLE_ADJUSTMENT = 'unstorable_adjustment_group';

/**
 * A batch is `ready` only when nothing on it needs a human first. Anything
 * flagged — a reversal, an unreadable adjustment, a downcode, a total that does
 * not reconcile — holds it at `open`.
 *
 * The distinction is the whole product: `ready` means "a person could act on
 * this now", and a status that said that about a takeback would be a lie.
 *
 * @param {import('./eraParser').ParsedRemittance} remittance
 * @param {Array<{ needsReviewReasons: string[] }>} claims
 * @returns {'open'|'ready'}
 */
function batchStatusFor(remittance, claims) {
  if (remittance.flags.length > 0) return 'open';
  if (claims.some((c) => c.needsReviewReasons.length > 0)) return 'open';
  if (claims.length === 0) return 'open';
  return 'ready';
}

/** Keep only flags the rcm_procedure_lines CHECK constraint accepts. */
function storableLineFlags(flags) {
  return flags.filter((f) => LINE_FLAGS.includes(f));
}

/**
 * Free-text summary of a line's adjustments — `adjustment_reason`, which
 * survives alongside the structured codes rather than instead of them. It is
 * what a biller reads in a list without opening the adjustment rows.
 * @param {import('./eraParser').ParsedAdjustment[]} adjustments
 * @returns {string|null}
 */
function adjustmentReasonText(adjustments) {
  if (adjustments.length === 0) return null;
  return adjustments.map((a) => `${a.groupCode}-${a.reasonCode}: ${a.description}`).join('; ');
}

/**
 * Look for remittances this office has already processed, WITHOUT reserving.
 *
 * A cheap read so the common duplicate is refused before we spend a blob write
 * on it. It is an optimization and nothing more — `reserveRemittanceKey` is the
 * guard, because only the unique index can win a race.
 *
 * @param {{ query: Function }} client
 * @param {string} officeId
 * @param {import('./eraParser').ParsedRemittance[]} remittances
 * @returns {Promise<Array<{ index: number, remittanceKey: string, status: string, batchId: string|null, processedAt: Date|null }>>}
 */
async function findAlreadyProcessed(client, officeId, remittances) {
  const found = [];
  for (const remittance of remittances) {
    const remittanceKey = buildRemittanceKey(remittance);
    const seen = await checkRemittanceProcessed(client, { officeId, remittanceKey });
    if (seen.alreadyProcessed) {
      found.push({
        index: remittance.index,
        remittanceKey,
        status: seen.status,
        batchId: seen.batchId,
        processedAt: seen.postedAt || null,
      });
    }
  }
  return found;
}

/**
 * Write every proposal row for one parsed file.
 *
 * @param {{ query: Function }} client a client already inside BEGIN
 * @param {{
 *   officeId: string,
 *   parsed: ReturnType<typeof import('./eraParser').parse835>,
 *   file: { filename: string, key: string, hash: string, sizeBytes: number, contentType: string },
 *   actorKey?: string|null,
 * }} params `actorKey` is the rcm_user_map key of the person who uploaded the
 *   file, resolved by the route through decision D-5. NULL means system — and
 *   is what every row written before Slice 6a carries, which the workbench
 *   renders as "not recorded" rather than as an automated upload.
 * @returns {Promise<{ uploadId: string, batches: object[], counts: object } | { conflict: object[] }>}
 *   `conflict` is returned — not thrown — when a reservation is refused, so the
 *   caller can roll back and answer with a specific 409 rather than a 500.
 */
async function ingestParsedEra(client, { officeId, parsed, file, actorKey = null }) {
  /** @type {object[]} */
  const conflicts = [];

  // Reserve EVERY key before writing anything. A file whose second check is a
  // duplicate must not leave the first one's proposals behind — see the
  // all-or-nothing note in docs/RCM_ERA_UPLOAD.md.
  /** @type {Array<{ remittance: object, remittanceKey: string, identity: object }>} */
  const reserved = [];
  for (const remittance of parsed.remittances) {
    const identity = remittanceIdentity(remittance);
    const remittanceKey = buildRemittanceKey(remittance);
    const result = await reserveRemittanceKey(client, {
      officeId,
      remittanceKey,
      traceNumber: identity.traceNumber,
      payerId: identity.payerId,
      paymentDate: identity.paymentDate,
      paymentAmountCents: identity.paymentAmountCents,
      checkNumber: identity.checkNumber || null,
    });
    if (!result.reserved) {
      conflicts.push({
        index: remittance.index,
        remittanceKey,
        status: result.status,
        batchId: result.batchId,
        processedAt: result.postedAt || null,
      });
      continue;
    }
    reserved.push({ remittance, remittanceKey, identity });
  }

  if (conflicts.length > 0) return { conflict: conflicts };

  const counts = { batches: 0, claims: 0, lines: 0, adjustments: 0 };
  /** @type {object[]} */
  const batches = [];

  for (const { remittance, remittanceKey } of reserved) {
    const written = await writeRemittance(client, { officeId, remittance, file, counts, actorKey });
    await finalizeRemittanceKey(client, { officeId, remittanceKey, batchId: written.batchId });
    // `index` is the transaction's ordinal in the FILE, carried explicitly so
    // the caller pairs a batch with its parsed remittance by identity rather
    // than by both arrays happening to be the same length.
    batches.push({ ...written, index: remittance.index, remittanceKey });
  }

  // The upload record last, so it can point at what it produced. `file_url` is
  // '' by platform rule: rows carry blob KEYS, and there is no URL to give.
  const uploadRes = await client.query(
    `INSERT INTO rcm_eob_uploads
       (office_id, filename, file_key, file_url, file_hash, file_size_bytes,
        content_type, result_batch_id, status, processed_at, uploaded_by)
     VALUES ($1, $2, $3, '', $4, $5, $6, $7, 'extracted', now(), $8)
     RETURNING upload_id`,
    [
      officeId,
      file.filename,
      file.key,
      file.hash,
      file.sizeBytes,
      file.contentType,
      batches.length > 0 ? batches[0].batchId : null,
      actorKey,
    ]
  );

  return { uploadId: uploadRes.rows[0].upload_id, batches, counts };
}

/**
 * One check: its batch, its claims, their lines and adjustments.
 * @returns {Promise<{ batchId: string, status: string, claims: object[] }>}
 */
async function writeRemittance(client, { officeId, remittance, file, counts, actorKey = null }) {
  const status = batchStatusFor(remittance, remittance.claims);
  const isEft = remittance.paymentMethod === 'eft';

  const batchRes = await client.query(
    `INSERT INTO rcm_payment_batches
       (office_id, check_number, eft_number, payment_method, payer, deposit_date,
        total_amount_cents, claim_count, status, era_file_key, trace_number,
        trace_originator_id, plb_adjustments, plb_total_cents, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING batch_id`,
    [
      officeId,
      // TRN02 is the number the bank, the EOB and Open Dental all agree on. It
      // is written to whichever column matches how the payer actually sent the
      // money, so a later reconciliation joins on the right one.
      isEft ? null : remittance.checkNumber,
      isEft ? remittance.traceNumber : null,
      remittance.paymentMethod,
      remittance.payerName,
      remittance.paymentDate,
      remittance.totalPaymentCents,
      remittance.claims.length,
      status,
      file.key,
      remittance.traceNumber,
      remittance.traceOriginatorId,
      // PLB is provider-level money belonging to no single claim. Kept as the
      // author-owned structure the column was designed for, and flagged on the
      // batch — Slice 5 records it and acts on none of it.
      JSON.stringify(remittance.plbAdjustments),
      remittance.plbTotalCents,
      remittance.flags.length > 0 ? `Flagged: ${remittance.flags.join(', ')}` : '',
      // D-5: the batch is created BY the person who uploaded the file. Slice 5
      // wrote NULL here and said so ("the staff crosswalk is deferred to Slice
      // 6"); this is that deferral being discharged.
      actorKey,
    ]
  );
  const batchId = batchRes.rows[0].batch_id;
  counts.batches += 1;

  const claims = [];
  for (let i = 0; i < remittance.claims.length; i += 1) {
    claims.push(
      await writeClaim(client, {
        officeId,
        batchId,
        position: i + 1,
        claim: remittance.claims[i],
        remittance,
        file,
        counts,
      })
    );
  }

  return { batchId, status, claims };
}

/** One CLP: the claim row, its batch-claim-payment row, its lines. */
async function writeClaim(client, { officeId, batchId, position, claim, remittance, file, counts }) {
  const patientBalanceCents = claim.totalDeductibleCents + claim.totalCopayCents;

  const claimRes = await client.query(
    `INSERT INTO rcm_claims
       (office_id, claim_number, check_number, patient_name, patient_dob, subscriber_id,
        group_number, payer, service_date, received_date, status, source,
        total_billed_cents, total_allowed_cents, total_deductible_cents, total_copay_cents,
        total_paid_cents, total_received_cents, patient_balance_cents, provider_npi,
        rendering_provider, payment_status, insurance_type, cob_sequence, confidence,
        raw_extracted_json, eob_file_key, needs_review_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, 'pending_review', 'manual_upload',
             $10, $11, $12, $13, $14, 0, $15, $16, $17, 'unpaid', $18, $19, 100,
             $20, $21, $22)
     RETURNING claim_id`,
    [
      officeId,
      claim.claimNumber,
      remittance.checkNumber,
      claim.patientName,
      claim.patientDOB,
      claim.subscriberId,
      claim.groupNumber,
      claim.payer,
      claim.serviceDate,
      claim.totalBilledCents,
      claim.totalAllowedCents,
      claim.totalDeductibleCents,
      claim.totalCopayCents,
      claim.totalPaidCents,
      patientBalanceCents,
      claim.providerNPI,
      claim.renderingProvider,
      claim.insuranceType,
      claim.cobSequence,
      // The full parse, kept verbatim. PHI, and the reason this column exists:
      // when a posted payment is questioned, "what did the file actually say"
      // must be answerable without re-parsing a blob.
      JSON.stringify(claim),
      file.key,
      claim.needsReviewReasons,
    ]
  );
  const claimId = claimRes.rows[0].claim_id;
  counts.claims += 1;

  // `total_received_cents` stays 0 and `payment_status` stays 'unpaid': the
  // carrier says it paid, and nothing has been received into Open Dental. Those
  // two columns are about OUR chart, and Slice 6 is what moves them.
  await client.query(
    `INSERT INTO rcm_batch_claim_payments
       (batch_id, claim_id, office_id, position, patient_name, subscriber_id, claim_number,
        service_date, paid_cents, allowed_cents, adjustment_cents, patient_resp_cents, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
    [
      batchId,
      claimId,
      officeId,
      position,
      claim.patientName,
      claim.subscriberId,
      claim.claimNumber,
      claim.serviceDate,
      claim.totalPaidCents,
      claim.totalAllowedCents,
      claim.totalBilledCents - claim.totalAllowedCents,
      claim.patientRespCents,
    ]
  );

  const extraReasons = [];
  for (let i = 0; i < claim.procedures.length; i += 1) {
    const skipped = await writeLine(client, {
      officeId,
      claimId,
      position: i + 1,
      proc: claim.procedures[i],
      counts,
    });
    if (skipped) extraReasons.push(UNSTORABLE_ADJUSTMENT);
  }

  // A group code the schema cannot hold is discovered while writing, not while
  // parsing, so the claim's reasons are topped up rather than pre-computed.
  if (extraReasons.length > 0 && !claim.needsReviewReasons.includes(UNSTORABLE_ADJUSTMENT)) {
    await client.query(
      `UPDATE rcm_claims
          SET needs_review_reasons = array_append(needs_review_reasons, $3),
              updated_at = now()
        WHERE claim_id = $1 AND office_id = $2`,
      [claimId, officeId, UNSTORABLE_ADJUSTMENT]
    );
    claim.needsReviewReasons.push(UNSTORABLE_ADJUSTMENT);
  }

  return {
    claimId,
    claimNumber: claim.claimNumber,
    patientName: claim.patientName,
    totalPaidCents: claim.totalPaidCents,
    needsReviewReasons: claim.needsReviewReasons,
    lineCount: claim.procedures.length,
  };
}

/**
 * One SVC: the line row and its adjustments.
 * @returns {Promise<boolean>} whether any adjustment had to be skipped
 */
async function writeLine(client, { officeId, claimId, position, proc, counts }) {
  const storable = proc.adjustments.filter((a) => ADJUSTMENT_GROUP_CODES.includes(a.groupCode));
  const skippedAny = storable.length !== proc.adjustments.length;

  const flags = storableLineFlags(skippedAny ? [...proc.flags, 'unexplained_adj'] : proc.flags);
  const writeOffCents = proc.billedCents - proc.allowedCents;
  const patientRespCents = proc.deductibleCents + proc.copayCents;

  const lineRes = await client.query(
    `INSERT INTO rcm_procedure_lines
       (claim_id, office_id, position, billed_code, paid_code, code, description,
        billed_cents, allowed_cents, deductible_cents, copay_cents, paid_cents,
        adjustment_cents, patient_resp_cents, write_off_cents, adjustment_reason,
        is_downcoded, is_bundled, is_denied, flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20)
     RETURNING line_id`,
    [
      claimId,
      officeId,
      position,
      proc.billedCode,
      proc.paidCode,
      proc.code,
      proc.description,
      proc.billedCents,
      proc.allowedCents,
      proc.deductibleCents,
      proc.copayCents,
      proc.paidCents,
      writeOffCents,
      patientRespCents,
      writeOffCents,
      adjustmentReasonText(proc.adjustments),
      proc.isDowncoded,
      proc.isBundled,
      proc.isDenied,
      flags,
    ]
  );
  const lineId = lineRes.rows[0].line_id;
  counts.lines += 1;

  for (const adj of storable) {
    await client.query(
      `INSERT INTO rcm_procedure_adjustments
         (procedure_line_id, claim_id, office_id, group_code, reason_code,
          reason_description, amount_cents, quantity, remark_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        lineId,
        claimId,
        officeId,
        adj.groupCode,
        adj.reasonCode,
        adj.description,
        adj.amountCents,
        adj.quantity,
        adj.remarkCode,
      ]
    );
    counts.adjustments += 1;
  }

  return skippedAny;
}

module.exports = {
  ingestParsedEra,
  findAlreadyProcessed,
  batchStatusFor,
  ADJUSTMENT_GROUP_CODES,
  UNSTORABLE_ADJUSTMENT,
};
