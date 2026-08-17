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
 * ─── Same transport as POST /eob ──────────────────────────────────────────
 *
 * multipart/form-data, file in a field named `file`, via the `multer` instance
 * Slice 4 introduced. Two upload endpoints in one module with two different
 * transports would be a wart, and the shared shape means the client, the tests
 * and the error vocabulary are the same for both.
 *
 * Bytes are held in memory, never on disk — the container filesystem is
 * ephemeral, and the one mounted volume in prod is the AzureFile share the call
 * store lives on. An 835 full of patient names spooled to either is a copy of
 * PHI nobody scheduled for deletion. It goes buffer → Blob → out of scope.
 */

const express = require('express');
const multer = require('multer');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { h, actorEmail, num, iso, isoDate } = require('./helpers');
const { parse835, X12FormatError } = require('../../services/rcm/eraParser');
const { RemittanceIdentityError, buildRemittanceKey } = require('../../services/rcm/remittanceKey');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { ingestParsedEra, findAlreadyProcessed } = require('../../services/rcm/eraIngest');
const eraFileStore = require('../../services/rcm/eraFileStore');

const router = express.Router();

/**
 * Upload ceiling. A real 835 is kilobytes; the largest thing a clearinghouse
 * sends in one file is a few hundred. 5 MB is generous by two orders of
 * magnitude and still refuses a mis-drag of a scanned PDF folder.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Smaller than the shortest legal 835. A truncated download, not a remittance. */
const MIN_UPLOAD_BYTES = 64;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Memory storage — see the transport note in the header. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

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

/** A structured refusal, in the shape the rest of /api/rcm uses. */
function refuse(res, status, code, error, extra) {
  return res.status(status).json({ success: false, error, code, ...(extra || {}) });
}

/**
 * Turn multer's own errors into the module's structured shape — the same
 * treatment, and the same codes, POST /eob gives them.
 */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return refuse(
        res,
        413,
        'FILE_TOO_LARGE',
        `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`
      );
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return refuse(res, 400, 'INVALID_UPLOAD', 'Send exactly one file, in a multipart field named "file".');
    }
    return refuse(res, 400, 'INVALID_UPLOAD', 'Could not read the uploaded file.');
  });
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
  const name = typeof raw === 'string' ? raw : '';
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
  receiveFile,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const uploaded = req.file;

    if (!uploaded || !Buffer.isBuffer(uploaded.buffer) || uploaded.buffer.length === 0) {
      return refuse(
        res,
        400,
        'NO_FILE',
        'No file was attached. Send the 835 as a multipart field named "file".'
      );
    }
    if (uploaded.buffer.length < MIN_UPLOAD_BYTES) {
      return refuse(
        res,
        400,
        'FILE_TOO_SMALL',
        `That file is only ${uploaded.buffer.length} bytes — too small to be an 835.`
      );
    }

    const bytes = uploaded.buffer;
    const filename = safeFilename(uploaded.originalname);
    // The browser's guess for a .edi is usually application/octet-stream or
    // text/plain, and neither is worth refusing on: the content is validated by
    // PARSING it, which is the only check that means anything here. (POST /eob
    // checks magic bytes instead, because a PDF has some; an 835 does not.)
    const contentType = uploaded.mimetype || 'application/edi-x12';

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
      contentType,
    });

    const file = {
      filename,
      key: stored.key,
      hash: stored.hash,
      sizeBytes: stored.bytes,
      contentType,
    };

    // ── One transaction: reserve, write, finalize. A failure anywhere leaves
    //    no reservation and no rows, so the same file can simply be re-sent.
    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // D-5: resolve (and, on a first RCM action, create) the acting user
        // INSIDE this transaction — every actor column in the schema is a FK to
        // rcm_user_map, and a row committed on another connection would not be
        // visible to a transaction already in flight.
        const actorKey = await resolveRcmActor(client, {
          email: actorEmail(req),
          displayName: (req.user && (req.user.name || req.user.displayName)) || '',
        });
        const result = await ingestParsedEra(client, { officeId: office, parsed, file, actorKey });
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
