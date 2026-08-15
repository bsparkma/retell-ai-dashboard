'use strict';

/**
 * /api/rcm/era — manual 835 (ERA) upload (RCM Slice 5).
 *
 *   POST /api/rcm/era?office=roland|valley   upload one .edi/.txt 835
 *   GET  /api/rcm/era?office=roland|valley   what this office has uploaded
 *
 * Office comes from Slice 3's router-wide `requireOffice` — the validated
 * `?office=` query param, never a body field. A MANUAL upload is a human
 * asserting whose 835 this is, which is the only attribution available here;
 * payee-based attribution belongs to the Stedi path, and Stedi stays dormant in
 * this slice (no polling, no API, and `rcm_stedi_poll_state` stays empty).
 *
 * `rcm.write` is enforced one level up, by the mount's
 * `requireReadWrite('rcm.read','rcm.write')` — every non-GET method under
 * /api/rcm demands the write action. That is why POST needs no gate of its own,
 * and `era.test.js` pins it rather than trusting the comment.
 *
 * ─── The headline behaviour: uploading the same 835 twice ─────────────────
 *
 * The second upload creates ZERO proposals and says exactly why:
 *
 *   409 { code: 'REMITTANCE_ALREADY_PROCESSED',
 *         error: 'Already processed: remittance …|…|2026-03-02|65100|… on 2026-03-02',
 *         remittances: [{ index, remittanceKey, status, batchId, processedAt }] }
 *
 * There is no override. No `?force=`, no header, no flag — see remittanceKey.js
 * for why `forceDuplicate` has no successor.
 *
 * ─── ALL-OR-NOTHING PER FILE ──────────────────────────────────────────────
 *
 * A file carrying several ST/BPR transactions is several checks, each with its
 * own remittance key. If ANY of them is already processed, the WHOLE file is
 * refused and the response names which. Accepting the new ones and skipping the
 * seen ones would leave an operator unable to say what landed from the file
 * they just uploaded — and re-uploading a superset of an already-processed file
 * is far more often a mistake than an intent.
 *
 * ─── Why the body is raw bytes, not multipart ─────────────────────────────
 *
 * This repository has no multipart middleware and no `multer` dependency, and
 * adding one for a single route is a larger change than the route. A browser
 * can POST a `File` object directly as the request body, so the client sends
 * the bytes and puts the name in `X-RCM-Filename`. If a second upload route
 * ever needs true multipart, that is the moment to take the dependency.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { h, actorEmail, num, iso, isoDate } = require('./helpers');
const { parse835, X12FormatError } = require('../../services/rcm/eraParser');
const { RemittanceIdentityError, buildRemittanceKey } = require('../../services/rcm/remittanceKey');
const { ingestParsedEra, findAlreadyProcessed } = require('../../services/rcm/eraIngest');
const eraFileStore = require('../../services/rcm/eraFileStore');

const router = express.Router();

/**
 * Upload ceiling. A real 835 is kilobytes; the largest thing a clearinghouse
 * sends in one file is a few hundred. 5 MB is generous by two orders of
 * magnitude and still refuses a mis-drag of a scanned PDF folder.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Columns returned by the list endpoint. Named explicitly — no SELECT *. */
const UPLOAD_COLUMNS = [
  'upload_id',
  'filename',
  'file_key',
  'file_hash',
  'file_size_bytes',
  'content_type',
  'status',
  'uploaded_at',
  'processed_at',
].join(', ');

const BATCH_COLUMNS = [
  'batch_id',
  'era_file_key',
  'check_number',
  'eft_number',
  'trace_number',
  'payment_method',
  'payer',
  'deposit_date',
  'total_amount_cents',
  'claim_count',
  'status',
  'plb_total_cents',
  'notes',
].join(', ');

const KEY_COLUMNS = ['batch_id', 'remittance_key', 'status', 'posted_at'].join(', ');

/**
 * Accept the file as bytes whatever the browser labelled it.
 *
 * `type: () => true` is deliberate: an .edi upload arrives as
 * application/edi-x12, application/octet-stream, or text/plain depending
 * entirely on the operating system's guess, and refusing on that basis would
 * reject valid files for a reason the uploader cannot see or fix. The content
 * is validated by PARSING it, which is the only check that means anything.
 *
 * The one exception is application/json, which the global `express.json()`
 * upstream has already consumed — so raw() would hand back an empty buffer and
 * the failure would look like an empty file. Refused explicitly below.
 */
const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/** A structured refusal, in the shape the rest of /api/rcm uses. */
function refuse(res, status, code, error, extra) {
  return res.status(status).json({ success: false, error, code, ...(extra || {}) });
}

/**
 * The uploaded name, reduced to something safe to store.
 *
 * PHI: 835 filenames routinely carry a patient and a payer
 * ("Delta_Smith_John_0302.edi"), which is why `rcm_eob_uploads.filename` is
 * documented PHI and why this value NEVER reaches a log line or a blob key.
 * Path separators are stripped so a name can never escape into a path.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function safeFilename(raw) {
  let name = typeof raw === 'string' ? raw : '';
  // The client percent-encodes, because a header value must be Latin-1 and
  // `fetch` refuses an accented character outright. A caller that did not
  // encode still works — decodeURIComponent only throws on a malformed escape.
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not percent-encoded; use it as sent */
  }
  const cleaned = Array.from(name)
    .filter((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f)
    .join('')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned.slice(0, 255) || 'upload.edi';
}

function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

// ─── POST /api/rcm/era ──────────────────────────────────────────────────────

router.post(
  '/',
  rawBody,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const contentType = String(req.get('content-type') || '').toLowerCase();

    if (contentType.includes('application/json')) {
      return refuse(
        res,
        415,
        'ERA_BODY_NOT_RAW',
        'Send the 835 as raw bytes (Content-Type: application/edi-x12 or text/plain), not JSON'
      );
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return refuse(res, 400, 'ERA_EMPTY_UPLOAD', 'No file content received');
    }

    const bytes = req.body;
    const filename = safeFilename(req.get('x-rcm-filename'));

    // ── Parse first. Nothing is stored, reserved, or written until the file
    //    has proven to be an 835 — a blob write for an unparseable upload is
    //    litter, and a reservation for one is a key we could not have derived.
    let parsed;
    try {
      parsed = parse835(bytes.toString('utf8'));
    } catch (err) {
      if (err instanceof X12FormatError) {
        // The parser's own message names the structural problem and contains no
        // file content, so it is safe to hand back.
        return refuse(res, 422, 'ERA_PARSE_FAILED', `Not a parseable 835: ${err.message}`);
      }
      throw err;
    }

    if (parsed.remittances.length === 0) {
      return refuse(res, 422, 'ERA_NO_REMITTANCES', 'The file contains no 835 payment transactions');
    }

    // The remittance key must be time-independent, and the schema's
    // payment_date is NOT NULL. A file carrying neither DTM*405 nor BPR16 is
    // refused rather than dated "today" — a key built from today's date detects
    // no duplicates tomorrow, which is the one thing it exists to do.
    const undated = parsed.remittances.filter((r) => !r.paymentDate);
    if (undated.length > 0) {
      return refuse(
        res,
        422,
        'ERA_MISSING_PAYMENT_DATE',
        'The file carries no payment date (DTM*405 or BPR16); it cannot be deduplicated safely',
        { transactionIndexes: undated.map((r) => r.index) }
      );
    }

    // Trace/check number is the other half of identity. Surfaced as its own
    // refusal so an operator sees WHICH thing the file is missing.
    let keys;
    try {
      keys = parsed.remittances.map((r) => buildRemittanceKey(r));
    } catch (err) {
      if (err instanceof RemittanceIdentityError) {
        return refuse(res, 422, 'ERA_NO_REMITTANCE_IDENTITY', err.message);
      }
      throw err;
    }

    // ── Cheap duplicate pre-check, before we spend a blob write. Advisory
    //    only: the reservation inside the transaction is the actual guard.
    const seen = await tenantDb.withTenantDb(req, (pool) =>
      findAlreadyProcessed(pool, office, parsed.remittances)
    );
    if (seen.length > 0) return alreadyProcessed(res, office, seen);

    if (!eraFileStore.isConfigured()) {
      return refuse(
        res,
        503,
        'ERA_STORAGE_UNAVAILABLE',
        'Remittance file storage is not configured in this environment'
      );
    }

    // ── The raw file IS the audit artifact (hard rule 6). Stored before the
    //    rows so a committed proposal can never reference a blob that does not
    //    exist; the reverse — a blob whose transaction rolled back — is an
    //    orphan of a few kilobytes, and the retry writes a fresh one.
    const stored = await eraFileStore.putEraFile({
      tenantSlug: req.tenant.slug,
      bytes,
      contentType: contentType || 'application/edi-x12',
    });

    const file = {
      filename,
      key: stored.key,
      hash: stored.hash,
      sizeBytes: stored.bytes,
      contentType: contentType || 'application/edi-x12',
    };

    // ── One transaction: reserve, write, finalize. A failure anywhere leaves
    //    no reservation and no rows, so the same file can simply be re-sent.
    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await ingestParsedEra(client, { officeId: office, parsed, file });
        if (result.conflict) {
          await client.query('ROLLBACK');
          return result;
        }
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // Best-effort rollback: if the connection itself is the problem the
        // transaction is already dead, and the original error is the useful one.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });

    if (outcome.conflict) return alreadyProcessed(res, office, outcome.conflict);

    // PHI (patient names) leaves the building only after the trail is written,
    // and an audit failure 500s rather than serving it untracked (hard rule 5).
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_era_upload',
      resourceId: outcome.uploadId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    console.log(
      `[rcm/era] ${office} ingested ${outcome.counts.batches} batch(es), ` +
        `${outcome.counts.claims} claim(s), ${outcome.counts.lines} line(s) ` +
        `by ${actorEmail(req)}`
    );

    return res.status(201).json({
      success: true,
      office,
      upload: {
        uploadId: outcome.uploadId,
        filename,
        fileKey: file.key,
        fileHash: file.hash,
        fileSizeBytes: file.sizeBytes,
      },
      remittances: outcome.batches.map((b) => ({
        index: b.index,
        batchId: b.batchId,
        status: b.status,
        remittanceKey: b.remittanceKey,
        checkNumber: parsed.remittances[b.index].checkNumber,
        traceNumber: parsed.remittances[b.index].traceNumber,
        payer: parsed.remittances[b.index].payerName,
        paymentDate: parsed.remittances[b.index].paymentDate,
        paymentMethod: parsed.remittances[b.index].paymentMethod,
        totalAmountCents: parsed.remittances[b.index].totalPaymentCents,
        plbTotalCents: parsed.remittances[b.index].plbTotalCents,
        // The structures we parsed and will NOT act on, said out loud.
        flags: parsed.remittances[b.index].flags,
        claims: b.claims.map((c) => ({
          claimId: c.claimId,
          claimNumber: c.claimNumber,
          patientName: c.patientName,
          totalPaidCents: c.totalPaidCents,
          lineCount: c.lineCount,
          needsReviewReasons: c.needsReviewReasons,
        })),
      })),
      counts: outcome.counts,
    });
  })
);

/**
 * The honest refusal. Names the key and the date it was first processed, so an
 * operator can go and look at what they already have rather than wonder.
 */
function alreadyProcessed(res, office, remittances) {
  const first = remittances[0];
  const when = isoDate(first.processedAt) || 'an earlier upload';
  return refuse(
    res,
    409,
    'REMITTANCE_ALREADY_PROCESSED',
    `Already processed: remittance ${first.remittanceKey} on ${when}` +
      (remittances.length > 1 ? ` (and ${remittances.length - 1} more in this file)` : ''),
    {
      office,
      remittances: remittances.map((r) => ({
        index: r.index,
        remittanceKey: r.remittanceKey,
        // 'pending' means a run is in flight or died mid-flight; it blocks just
        // as firmly as 'posted', and the difference is what an operator needs.
        status: r.status,
        batchId: r.batchId,
        processedAt: iso(r.processedAt),
      })),
    }
  );
}

// ─── GET /api/rcm/era ───────────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    const { uploads, batches, keys, total } = await tenantDb.withTenantDb(req, async (pool) => {
      const [page, count] = await Promise.all([
        pool.query(
          `SELECT ${UPLOAD_COLUMNS} FROM rcm_eob_uploads WHERE office_id = $1 ` +
            `ORDER BY uploaded_at DESC LIMIT $2 OFFSET $3`,
          [office, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM rcm_eob_uploads WHERE office_id = $1`, [office]),
      ]);

      // Batches join back to their upload on era_file_key — the blob key, which
      // is the one identifier both rows are certain to share (result_batch_id
      // names only the FIRST batch of a multi-check file).
      const fileKeys = page.rows.map((r) => r.file_key).filter(Boolean);
      if (fileKeys.length === 0) {
        return { uploads: page.rows, batches: [], keys: [], total: num(count.rows[0].n) };
      }

      const batchRows = await pool.query(
        `SELECT ${BATCH_COLUMNS} FROM rcm_payment_batches ` +
          `WHERE office_id = $1 AND era_file_key = ANY($2::text[]) ORDER BY created_at ASC`,
        [office, fileKeys]
      );
      const batchIds = batchRows.rows.map((r) => r.batch_id);
      const keyRows = batchIds.length
        ? await pool.query(
            `SELECT ${KEY_COLUMNS} FROM rcm_remittance_keys ` +
              `WHERE office_id = $1 AND batch_id = ANY($2::uuid[])`,
            [office, batchIds]
          )
        : { rows: [] };

      return {
        uploads: page.rows,
        batches: batchRows.rows,
        keys: keyRows.rows,
        total: num(count.rows[0].n),
      };
    });

    const keyByBatch = new Map(keys.map((k) => [k.batch_id, k]));
    const batchesByFile = new Map();
    for (const b of batches) {
      if (!batchesByFile.has(b.era_file_key)) batchesByFile.set(b.era_file_key, []);
      batchesByFile.get(b.era_file_key).push(b);
    }

    // `filename` is PHI, so this is a PHI path and the read is audited
    // fail-closed — same rule as the claims list.
    await audit(req, {
      action: 'READ',
      resourceType: 'rcm_era_upload',
      resourceId: null,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      office,
      uploads: uploads.map((u) => ({
        uploadId: u.upload_id,
        filename: u.filename,
        fileHash: u.file_hash,
        fileSizeBytes: u.file_size_bytes == null ? null : num(u.file_size_bytes),
        contentType: u.content_type,
        status: u.status,
        uploadedAt: iso(u.uploaded_at),
        processedAt: iso(u.processed_at),
        remittances: (batchesByFile.get(u.file_key) || []).map((b) => {
          const key = keyByBatch.get(b.batch_id);
          return {
            batchId: b.batch_id,
            checkNumber: b.check_number,
            eftNumber: b.eft_number,
            traceNumber: b.trace_number,
            paymentMethod: b.payment_method,
            payer: b.payer,
            paymentDate: isoDate(b.deposit_date),
            totalAmountCents: num(b.total_amount_cents),
            plbTotalCents: num(b.plb_total_cents),
            claimCount: num(b.claim_count),
            status: b.status,
            notes: b.notes || '',
            // The dedupe status. A row here is what makes a re-upload refuse.
            remittanceKey: key ? key.remittance_key : null,
            dedupeStatus: key ? key.status : null,
          };
        }),
      })),
      total,
      limit,
      offset,
    });
  })
);

module.exports = router;
