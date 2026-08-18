'use strict';

/**
 * The EOB extraction worker — blob in, PROPOSAL rows out.
 *
 * ── THIS FILE TOUCHES NO OPEN DENTAL ─────────────────────────────────────────
 * There is no OD client here, no `getOdOffice`, no `assertOfficeMatch`, no
 * commlog, no ClaimProc. What an extraction produces is rcm_claims rows in
 * 'pending_review' with rcm_procedure_lines and rcm_procedure_adjustments
 * beneath them — a machine's reading of a document, waiting for a human. Slice 6
 * is what turns an approved proposal into an Open Dental write, and it will do
 * so through the office-keyed client registry with `assertOfficeMatch`, exactly
 * as the voice path does. `eobNoOdImports.test.js` fails if an import ever
 * appears in this module's graph.
 *
 * ── THE STATUS LADDER IS HONEST ──────────────────────────────────────────────
 *   uploaded    the bytes are stored; extraction has not been ATTEMPTED yet.
 *               Also the state a document sits in while the daily cost breaker
 *               is tripped, or while no LLM is configured — with the reason in
 *               error_message. Nothing was tried, so nothing failed.
 *   processing  an attempt is in flight and money may have been spent.
 *   extracted   set INSIDE the same transaction as the rows it refers to. A row
 *               that says 'extracted' is a row whose claims exist; there is no
 *               instant where one is true and the other is not.
 *   failed      we tried, on THIS document, and it did not work.
 *               error_message says why, in words a poster can act on.
 *
 * ── THE MONEY IS CHARGED THE MOMENT IT IS SPENT ──────────────────────────────
 * `budget.charge()` runs immediately after the Azure call returns, BEFORE the
 * answer is parsed or stored. Tokens are spent whether or not we like the
 * answer, and a breaker that only counted successful extractions would under-
 * report exactly on the documents that burn the most retries.
 */

const budget = require('./extractionBudget');
const blobStore = require('./eobBlobStore');
const llm = require('./rcmLlm');
const { extractPdfText, DocumentTextError } = require('./eobDocumentText');
const { REMITTANCE_FLAGS, EOB_FAILURE_CODES } = require('./rcmVocabulary');
const {
  EOB_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  normalizeExtraction,
  deriveClaimReviewReasons,
  deriveBatchReviewReasons,
  claimsPaidSum,
} = require('./eobExtraction');

/** Day boundary for `received_date`. The offices' zone, same as the OD sync. */
const OFFICE_TIMEZONE = process.env.OFFICE_TIMEZONE || 'America/Chicago';

/** 'YYYY-MM-DD' in the office's local day. */
function officeToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: OFFICE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Columns the worker reads off rcm_eob_uploads. Named explicitly — no SELECT *.
 * `filename` is NOT read: it is PHI, the worker has no use for it, and not
 * loading it is the cheapest way to guarantee it never reaches a log line.
 */
const UPLOAD_COLUMNS = 'upload_id, office_id, file_key, status, result_claim_id, result_batch_id';

/**
 * Run one extraction.
 *
 * The job is plain data (see eobExtractionQueue) — the tenant pool, the storage
 * client, and the LLM client are all re-resolved here from those strings.
 *
 * @param {{ tenantId: string, tenantSlug: string, office: string, uploadId: string }} job
 * @returns {Promise<{ status: 'extracted'|'exists'|'failed'|'deferred'|'not_found',
 *                     claimId?: string, batchId?: string, reason?: string, resetsAt?: string }>}
 */
async function runExtraction(job) {
  const { tenantId, tenantSlug, office, uploadId } = job;
  const tenantDb = require('../../platform/tenantDb');
  const pool = await tenantDb.getTenantPool(tenantId);

  // Office-scoped even here, where the office came from the enqueueing request
  // rather than from a client: a job whose office does not match the stored row
  // finds nothing, rather than extracting one office's document into the other.
  const found = await pool.query(
    `SELECT ${UPLOAD_COLUMNS} FROM rcm_eob_uploads WHERE upload_id = $1 AND office_id = $2`,
    [uploadId, office]
  );
  const upload = found.rows[0];
  if (!upload) {
    console.warn(`[rcm/eob] upload ${uploadId} not found in office ${office} — nothing to extract`);
    return { status: 'not_found' };
  }

  // Idempotent: a re-enqueue of an already-extracted document costs nothing and
  // re-spends nothing. Same guard, same reason, as the Mango transcript dedup.
  if (upload.status === 'extracted' && upload.result_claim_id) {
    return { status: 'exists', claimId: upload.result_claim_id, batchId: upload.result_batch_id };
  }

  // ── The two "not attempted" states, checked before anything is spent ───────
  if (!llm.isConfigured()) {
    const reason =
      'Extraction is not available: no Azure OpenAI deployment is configured for this ' +
      'environment. The document is stored and will extract once it is.';
    await markPending(pool, uploadId, office, reason);
    // No resetsAt — there is no clock to wait on. A re-POST re-enqueues it.
    return { status: 'deferred', reason };
  }

  const gate = budget.check();
  if (!gate.allowed) {
    const reason =
      `Extraction paused — the daily cost cap of $${(gate.capCents / 100).toFixed(2)} is used up. ` +
      'The document is stored and will extract after the cap resets.';
    await markPending(pool, uploadId, office, reason);
    return { status: 'deferred', reason, resetsAt: gate.resetsAt };
  }

  // ── Attempt ────────────────────────────────────────────────────────────────
  await pool.query(
    `UPDATE rcm_eob_uploads SET status = 'processing', error_message = NULL, updated_at = now()
      WHERE upload_id = $1 AND office_id = $2`,
    [uploadId, office]
  );

  const startedAt = Date.now();
  try {
    const bytes = await blobStore.getEob(upload.file_key);
    // A6: an over-length document now THROWS DOCUMENT_TOO_LARGE rather than
    // returning a silently truncated text layer. Nothing to warn about here any
    // more — the refusal reaches the user through `failure_code`.
    const doc = await extractPdfText(bytes);

    // HARD BACKSTOP, immediately before the spend. `check()` above lets the job
    // park cleanly; this one is what makes it impossible to spend past the cap
    // even if that check is ever removed.
    budget.assertAllowed();

    const { json, usage } = await llm.completeJson({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(doc.text),
      jsonSchema: EOB_EXTRACTION_SCHEMA,
    });

    // Charged before the answer is examined — see the header.
    const charged = budget.charge(usage);
    console.log(
      `[rcm/eob] upload ${uploadId} extracted with ${usage.total_tokens} tokens ` +
        `(~${charged.chargedCents}¢; $${(charged.usedCents / 100).toFixed(2)} of ` +
        `$${(charged.capCents / 100).toFixed(2)} today)`
    );

    const extracted = normalizeExtraction(json);
    const processingTimeSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

    const result = await persistProposal(pool, {
      office,
      upload,
      extracted,
      processingTimeSec,
      today: officeToday(),
    });

    return { status: 'extracted', claimId: result.claimId, batchId: result.batchId };
  } catch (err) {
    const reason = failureReason(err);
    await pool
      .query(
        // SLICE 5.5 REVIEW. `AND result_batch_id IS NULL` closes a window where
        // the proposal transaction COMMITS and then something after it throws —
        // a client error, a released pool, a serialization failure surfacing
        // late. Without the guard this marks a row 'failed' while its batch and
        // claims exist, which RELEASES the content hash (the unique index
        // excludes 'failed'), and the next upload of the same PDF ingests it a
        // second time. A row that produced a batch is never a failure.
        `UPDATE rcm_eob_uploads SET status = 'failed', error_message = $3, failure_code = $4,
                processed_at = now(), updated_at = now()
          WHERE upload_id = $1 AND office_id = $2 AND result_batch_id IS NULL`,
        // A6: the MESSAGE is the human sentence; the CODE is what the panel
        // switches on. "too long, split it" and "this PDF is encrypted" are
        // different conversations and the UI has to be able to tell them apart
        // without string-matching prose.
        [uploadId, office, reason, failureCode(err)]
      )
      .catch((e) =>
        console.error(`[rcm/eob] could not record failure on upload ${uploadId}:`, e && e.message)
      );
    console.error(`[rcm/eob] upload ${uploadId} extraction failed: ${reason}`);
    return { status: 'failed', reason };
  }
}

/**
 * Park an upload at 'uploaded' with a stated reason.
 *
 * NOT 'failed': nothing was attempted on this document. `error_message` is the
 * only free-text column the Slice 1 schema gives us, so it doubles as the
 * "why hasn't this progressed" note — documented in RCM_EOB_INGESTION.md so the
 * next reader does not take a message on an 'uploaded' row as a failure.
 */
async function markPending(pool, uploadId, office, reason) {
  await pool.query(
    `UPDATE rcm_eob_uploads SET status = 'uploaded', error_message = $3, updated_at = now()
      WHERE upload_id = $1 AND office_id = $2`,
    [uploadId, office, reason]
  );
}

/**
 * A message a poster can act on, without leaking internals.
 *
 * Every branch here is a code this slice defines; an unrecognized error becomes
 * a generic line, because an unexpected stack in a user-facing field is both
 * useless and a disclosure risk. The full error is already on the console.
 */
function failureReason(err) {
  const code = err && err.code;
  if (
    err instanceof DocumentTextError ||
    code === 'NO_EXTRACTABLE_TEXT' ||
    code === 'PDF_UNREADABLE' ||
    code === 'DOCUMENT_TOO_LARGE'
  ) {
    return err.message;
  }
  if (code === 'RCM_EXTRACTION_BUDGET_EXCEEDED') {
    // Reachable only if the cap was consumed between check() and assertAllowed()
    // by a concurrent job. Rare, honest, and retryable after the reset.
    return 'Extraction paused — the daily cost cap was reached while this document was processing.';
  }
  if (code === 'LLM_UNAVAILABLE') return 'Extraction is not available: no LLM deployment is configured.';
  if (code === 'LLM_RESPONSE_TRUNCATED') {
    return 'The remittance was too long to extract in one pass. Split it and upload the pages separately.';
  }
  if (code === 'LLM_BAD_JSON' || code === 'LLM_EMPTY_RESPONSE' || code === 'EXTRACTION_MALFORMED') {
    return 'The extraction service returned an unusable answer. Try again.';
  }
  if (code === 'LLM_CALL_FAILED') return 'The extraction service could not be reached. Try again.';
  if (code === 'EOB_STORAGE_UNAVAILABLE') return 'Document storage is not configured for this environment.';
  return 'Extraction failed unexpectedly. Try again, or report this upload id.';
}

/**
 * The remittance flags an extracted EOB batch carries.
 *
 * Drawn from the SAME frozen vocabulary the ERA path uses
 * (`rcmVocabulary.REMITTANCE_FLAGS`), because a biller reading the workbench
 * should not have to know which door a proposal came through. Only the members
 * an EOB can actually establish are reachable here: an extraction has no
 * envelope to validate and no PLB to carry.
 *
 * @param {import('./eobExtraction').ExtractedEob} extracted
 * @param {boolean} balanced
 * @returns {string[]}
 */
function batchFlags(extracted, balanced) {
  const flags = [];
  if (!balanced) flags.push('claim_total_mismatch');
  if (extracted.claims.length === 0) flags.push('no_claims_in_remittance');
  return flags.filter((f) => REMITTANCE_FLAGS.includes(f));
}

/**
 * The machine-readable half of a failure — `rcm_eob_uploads.failure_code`.
 *
 * Slice 5.5 (A6) added this because the panel had only `error_message` to go
 * on, so distinguishing "split this document" from "this PDF is encrypted"
 * meant matching prose. The vocabulary is CHECKed in the database; anything
 * unmapped becomes the honest catch-all rather than a value the constraint
 * would reject.
 *
 * @param {unknown} err
 * @returns {string} a member of rcmVocabulary.EOB_FAILURE_CODES
 */
function failureCode(err) {
  const code = err && err.code;
  switch (code) {
    case 'DOCUMENT_TOO_LARGE':
      return 'document_too_large';
    case 'NO_EXTRACTABLE_TEXT':
      return 'no_extractable_text';
    case 'PDF_UNREADABLE':
      return 'pdf_unreadable';
    case 'RCM_EXTRACTION_BUDGET_EXCEEDED':
      return 'budget_exhausted';
    case 'LLM_UNAVAILABLE':
      return 'llm_unavailable';
    case 'LLM_BAD_JSON':
    case 'LLM_EMPTY_RESPONSE':
    case 'EXTRACTION_MALFORMED':
    case 'LLM_RESPONSE_TRUNCATED':
      return 'extraction_invalid';
    default:
      return 'extraction_failed';
  }
}

// A code outside the vocabulary would be rejected by the DB CHECK, turning a
// handled failure into an unhandled one. Asserted at load rather than trusted.
for (const code of ['document_too_large', 'no_extractable_text', 'pdf_unreadable',
  'budget_exhausted', 'llm_unavailable', 'extraction_invalid', 'extraction_failed']) {
  if (!EOB_FAILURE_CODES.includes(code)) {
    throw new Error(`[rcm/eob] failureCode() can emit '${code}', which is not in the vocabulary`);
  }
}

/**
 * Write the whole proposal in ONE transaction.
 *
 * ALL-OR-NOTHING, and the upload's 'extracted' flip is INSIDE it. A partial
 * commit would leave either orphan claims nothing points at, or an upload
 * claiming an extraction whose rows are missing — and the second is the kind of
 * lie the platform's honest-states rule exists to prevent. A failure anywhere
 * rolls the lot back and leaves the upload retryable.
 *
 * Insert order is parent-first because the FKs are immediate: batch → claims →
 * lines → adjustments → batch-claim links → the upload's result pointers.
 */
async function persistProposal(pool, { office, upload, extracted, processingTimeSec, today }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchReasons = deriveBatchReviewReasons(extracted);
    const paidSum = claimsPaidSum(extracted);
    const checkTotal = extracted.payment.totalPaidCents;
    const balanced = batchReasons.length === 0;

    // ONE payment batch for the whole check — the same remittance model an 835
    // with many CLPs produces, so Slices 5–7 see one shape, not two.
    const batchRes = await client.query(
      `INSERT INTO rcm_payment_batches
         (office_id, check_number, eft_number, payment_method, payer, deposit_date,
          total_amount_cents, claim_count, status, era_file_key, era_file_url, notes, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING batch_id`,
      [
        office,
        extracted.payment.checkNumber || null,
        extracted.payment.checkNumber || null,
        extracted.payment.paymentMethod,
        extracted.payment.payer || 'Unknown',
        extracted.payment.checkDate,
        checkTotal,
        extracted.claims.length,
        // 'open', never 'ready': ready means a human has looked. Every claim
        // below lands in 'pending_review' for exactly the same reason.
        'open',
        upload.file_key,
        // No URL is stored on the batch — the upload row already holds it, and
        // two copies of a location is two things to keep in step.
        null,
        // B6 (Slice 5.5 review). `notes` is PROSE FOR A HUMAN and nothing
        // switches on it. It used to end in the machine token '· UNBALANCED',
        // which made it a signal the UI would have had to string-match — the
        // same mistake the ERA path made with 'Flagged: a, b'.
        `EOB upload · ${extracted.claims.length} claim(s) · ${extracted.confidence}% confidence · ` +
          `claims paid ${paidSum}¢ vs check ${checkTotal}¢`,
        // …and the SIGNAL goes in the same CHECKed column the ERA path writes,
        // so one UI switch serves both ingestion doors. Before this, every EOB
        // batch showed no flags at all while its real state sat in that string.
        batchFlags(extracted, balanced),
      ]
    );
    const batchId = batchRes.rows[0].batch_id;

    /** @type {string[]} */
    const claimIds = [];

    for (let i = 0; i < extracted.claims.length; i++) {
      const claim = extracted.claims[i];
      const claimReasons = deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, {
        today,
      });
      // A whole-check imbalance is stamped on EVERY claim in the batch: the
      // reviewer works one claim at a time, and a flag that lives only on the
      // batch is a flag they never see.
      const reasons = [...new Set([...claimReasons, ...batchReasons])];
      const patientBalance = claim.totalDeductibleCents + claim.totalCopayCents;

      const claimRes = await client.query(
        `INSERT INTO rcm_claims
           (office_id, claim_number, check_number, patient_name, patient_dob, subscriber_id,
            group_number, payer, service_date, received_date, status, source,
            total_billed_cents, total_allowed_cents, total_deductible_cents, total_copay_cents,
            total_paid_cents, patient_balance_cents, provider_npi, rendering_provider,
            confidence, processing_time_sec, raw_extracted_json, eob_file_key, eob_file_url,
            needs_review_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING claim_id`,
        [
          office,
          claim.claimNumber,
          extracted.payment.checkNumber,
          claim.patientName,
          claim.patientDOB,
          claim.subscriberId,
          claim.groupNumber,
          extracted.payment.payer,
          claim.serviceDate,
          today,
          // The proposal's resting state. Nothing in this slice can set it to
          // anything else, and no code path here writes to Open Dental.
          'pending_review',
          'manual_upload',
          claim.totalBilledCents,
          claim.totalAllowedCents,
          claim.totalDeductibleCents,
          claim.totalCopayCents,
          claim.totalPaidCents,
          patientBalance,
          claim.providerNPI,
          claim.renderingProvider,
          extracted.confidence,
          processingTimeSec,
          // The full payload, per claim, plus the shared remittance context —
          // where the per-line confidences live, since rcm_procedure_lines has
          // no column for them. Slice 7's review UI reads them from here.
          JSON.stringify({ payment: extracted.payment, confidence: extracted.confidence, claim }),
          upload.file_key,
          null,
          reasons,
        ]
      );
      const claimId = claimRes.rows[0].claim_id;
      claimIds.push(claimId);

      for (const proc of claim.procedures) {
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
            office,
            proc.position,
            proc.code,
            // paid_code is "the code the carrier actually paid as", and it
            // differs from billed_code ONLY on a downcode. The extraction
            // schema does not ask for a separate paid code, so NULL is the
            // honest value: "not stated". The source copied billed_code into
            // it, which recorded a paid_code on every clean line and made the
            // column useless for finding downcodes.
            null,
            proc.code,
            proc.description,
            proc.billedCents,
            proc.allowedCents,
            proc.deductibleCents,
            proc.copayCents,
            proc.paidCents,
            proc.adjustmentCents,
            proc.patientRespCents,
            proc.writeOffCents,
            // Free text stays free text; the STRUCTURED codes go in their own
            // table below. Joining the two into one string is how the source
            // ended up unable to query a denial reason.
            null,
            proc.flags.includes('downcode'),
            proc.flags.includes('bundled'),
            proc.flags.includes('denied'),
            proc.flags,
          ]
        );
        const lineId = lineRes.rows[0].line_id;

        for (const adj of proc.adjustments) {
          await client.query(
            `INSERT INTO rcm_procedure_adjustments
               (procedure_line_id, claim_id, office_id, group_code, reason_code,
                reason_description, amount_cents, remark_code, remark_description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              lineId,
              claimId,
              office,
              adj.groupCode,
              adj.reasonCode,
              adj.reasonDescription,
              adj.amountCents,
              adj.remarkCode,
              adj.remarkDescription,
            ]
          );
        }
      }

      await client.query(
        `INSERT INTO rcm_batch_claim_payments
           (batch_id, claim_id, office_id, position, patient_name, subscriber_id, claim_number,
            service_date, paid_cents, allowed_cents, adjustment_cents, patient_resp_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          batchId,
          claimId,
          office,
          i,
          claim.patientName,
          claim.subscriberId,
          claim.claimNumber,
          claim.serviceDate,
          claim.totalPaidCents,
          claim.totalAllowedCents,
          claim.totalBilledCents - claim.totalAllowedCents,
          patientBalance,
          'pending',
        ]
      );
    }

    // The flip, in the same transaction as everything it points at.
    await client.query(
      `UPDATE rcm_eob_uploads
          SET status = 'extracted', result_claim_id = $3, result_batch_id = $4,
              error_message = NULL, processed_at = now(), updated_at = now()
        WHERE upload_id = $1 AND office_id = $2`,
      [upload.upload_id, office, claimIds[0] || null, batchId]
    );

    await client.query('COMMIT');
    return { claimId: claimIds[0] || null, batchId, claimIds };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[rcm/eob] rollback failed:', rollbackErr && rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runExtraction, officeToday, failureReason };
