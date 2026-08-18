'use strict';

/**
 * /api/rcm/eob — EOB document ingestion (Slice 4).
 *
 *   POST /api/rcm/eob?office=roland|valley   multipart PDF → stored + queued
 *   GET  /api/rcm/eob?office=roland|valley   this office's uploads + breaker state
 *
 * THE FIRST WRITE SURFACE IN THIS MODULE. `rcm.write` has been mounted and
 * unused since Slice 3 precisely so this POST would demand it by construction
 * rather than by whoever wrote it remembering — server.js applies
 * requireReadWrite('rcm.read','rcm.write') at the mount, so this POST is gated
 * on rcm.write without a single line here saying so. A role that holds neither
 * gets a 403 naming `rcm.write` as the action that failed.
 *
 * NOTHING HERE REACHES OPEN DENTAL. A POST stores bytes and queues a job; the
 * job produces proposal rows. There is no OD client in this file's graph, and
 * eobNoOdImports.test.js fails if one appears.
 *
 * Office comes from the router-wide `requireOffice` (index.js) — the validated
 * `?office=` query param, never a body field. Every row this route creates
 * carries `req.rcmOffice`.
 */

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { h, actorEmail, auditRcmRead, num, iso } = require('./helpers');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const blobStore = require('../../services/rcm/eobBlobStore');
const budget = require('../../services/rcm/extractionBudget');
const odPacer = require('../../services/rcm/odPacer');
const openDental = require('../../config/openDental');
const queue = require('../../services/rcm/eobExtractionQueue');
const { looksLikePdf } = require('../../services/rcm/eobDocumentText');

const router = express.Router();

/**
 * 25 MB. Generous on purpose — a multi-page scanned remittance from a payer
 * portal is routinely 5–15 MB, and a limit that bounces real documents turns
 * into staff emailing PDFs around instead. Same ceiling the source used.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Anything smaller than this is not a document. A truncated download or an
 * empty file picker selection is worth refusing before it reaches storage.
 */
const MIN_UPLOAD_BYTES = 256;

/** Page size for the list. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Bytes are held in memory, never on disk.
 *
 * Deliberate: the container filesystem is ephemeral and, in prod, the only
 * mounted volume is the AzureFile share the call store lives on. A PDF full of
 * patient names spooled to either one is a copy of PHI nobody scheduled for
 * deletion. It goes buffer → Blob → out of scope.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * Columns the list returns. `file_key` and `file_url` are ABSENT: they are
 * storage coordinates the client has no use for (the container is private and
 * there are no SAS tokens), and a key in a response body is a key in a browser
 * cache. `filename` IS returned — it is how the person who uploaded it
 * recognizes their own document, which is the entire point of the list.
 */
const LIST_COLUMNS = [
  'upload_id',
  'office_id',
  'filename',
  'file_size_bytes',
  'status',
  'error_message',
  // A6: the machine-readable half of a failure. The panel switches on THIS;
  // error_message stays the human sentence.
  'failure_code',
  'result_claim_id',
  'result_batch_id',
  'uploaded_at',
  'processed_at',
].join(', ');

/** Map a DB row to the wire shape. camelCase out. */
function toWire(row) {
  return {
    uploadId: row.upload_id,
    officeId: row.office_id,
    filename: row.filename,
    fileSizeBytes: row.file_size_bytes == null ? null : num(row.file_size_bytes),
    status: row.status,
    // On a 'failed' row this is why it failed. On an 'uploaded' row it is why
    // extraction has not started yet (budget paused, or no LLM configured) —
    // see the worker's markPending(). The UI distinguishes them by `status`.
    message: row.error_message || null,
    // A6. Slice 5.5: what the panel switches on, so "split this document" and
    // "this PDF is encrypted" can render differently without matching prose.
    failureCode: row.failure_code || null,
    resultClaimId: row.result_claim_id || null,
    resultBatchId: row.result_batch_id || null,
    uploadedAt: iso(row.uploaded_at),
    processedAt: iso(row.processed_at),
  };
}

function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * Turn multer's own errors into the module's structured shape.
 *
 * Without this, an oversized file surfaces as multer's default 500-ish handler
 * and the user is told nothing useful about a limit they can actually respect.
 */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        error: 'Send exactly one file, in a multipart field named "file".',
        code: 'INVALID_UPLOAD',
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Could not read the uploaded file.',
      code: 'INVALID_UPLOAD',
    });
  });
}

// ─── POST /api/rcm/eob ───────────────────────────────────────────────────────

router.post(
  '/',
  receiveFile,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const file = req.file;

    if (!file || !Buffer.isBuffer(file.buffer)) {
      return res.status(400).json({
        success: false,
        error: 'No file was attached. Send the PDF as a multipart field named "file".',
        code: 'NO_FILE',
      });
    }

    if (file.buffer.length < MIN_UPLOAD_BYTES) {
      return res.status(400).json({
        success: false,
        error: `That file is only ${file.buffer.length} bytes — too small to be an EOB.`,
        code: 'FILE_TOO_SMALL',
      });
    }

    // MAGIC BYTES, not the declared content type. Browsers get it wrong and
    // clients lie; `%PDF-` is the only claim worth believing. This slice takes
    // PDFs only — the source also accepted PNG/JPEG, but those need a vision
    // model and this path is text-extraction (see eobDocumentText.js).
    if (!looksLikePdf(file.buffer)) {
      return res.status(415).json({
        success: false,
        error: 'That file is not a PDF. Upload the EOB as a PDF.',
        code: 'NOT_A_PDF',
      });
    }

    if (!blobStore.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Document storage is not configured for this environment.',
        code: 'EOB_STORAGE_UNAVAILABLE',
      });
    }

    const tenantId = req.tenant && req.tenant.id;
    const tenantSlug = req.tenant && req.tenant.slug;

    // SHA-256 of the bytes. Detects the same physical document arriving twice —
    // under a different filename, or because someone hit the button twice.
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // The uploaded filename is PHI (EOB filenames routinely carry patient
    // names). It is stored in a PHI column and NEVER put in a blob key or a log
    // line; `sanitizeFilename` only bounds its length for the text column.
    const filename = sanitizeFilename(file.originalname);

    const existing = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${LIST_COLUMNS} FROM rcm_eob_uploads
          WHERE office_id = $1 AND file_hash = $2
          ORDER BY uploaded_at DESC LIMIT 1`,
        [office, fileHash]
      )
    );
    const prior = existing.rows[0];

    if (prior) {
      // Already extracted → hand back what we have. Re-extracting the same
      // bytes would spend money to produce a duplicate proposal, which is the
      // cost loop the Mango dedup guard exists to prevent on the voice side.
      if (prior.status === 'extracted') {
        await auditEobWrite(req, office, prior.upload_id);
        return res.status(200).json({ success: true, office, duplicate: true, upload: toWire(prior) });
      }
      // In flight → say so rather than queueing a second attempt.
      if (prior.status === 'processing') {
        await auditEobWrite(req, office, prior.upload_id);
        return res.status(200).json({ success: true, office, duplicate: true, upload: toWire(prior) });
      }
      // 'uploaded' (waiting on the budget or on config) or 'failed' → THIS is
      // the retry path. There is no separate retry endpoint and no background
      // rescan: re-uploading the document is the human action that restarts it,
      // which also covers a process restart that lost the in-memory queue.
      // SLICE 5.5 REVIEW. The `23505` guard below protects the INSERT path; this
      // one is the same race on the RETRY path. Two concurrent re-uploads of a
      // document whose prior row is 'failed'/'uploaded' both read that row, both
      // flip it, and both enqueue — two extractions of one upload_id, i.e. the
      // cost the budget breaker exists to prevent, spent twice.
      //
      // The UPDATE re-asserts the status it expects, so exactly one caller can
      // win the transition. The loser did not requeue and says so rather than
      // claiming a restart it did not cause.
      const claimed = await tenantDb.withTenantDb(req, (pool) =>
        pool.query(
          `UPDATE rcm_eob_uploads
              SET status = 'uploaded', error_message = NULL, failure_code = NULL,
                  updated_at = now()
            WHERE upload_id = $1 AND office_id = $2 AND status IN ('uploaded', 'failed')
            RETURNING upload_id`,
          [prior.upload_id, office]
        )
      );
      const requeued = claimed.rows.length > 0;
      if (requeued) queue.enqueue({ tenantId, tenantSlug, office, uploadId: prior.upload_id });
      await auditEobWrite(req, office, prior.upload_id);
      return res.status(200).json({
        success: true,
        office,
        duplicate: true,
        requeued,
        upload: { ...toWire(prior), status: 'uploaded', message: null },
        extraction: budget.status(),
      });
    }

    // Store the bytes FIRST. A row pointing at a blob that does not exist is a
    // lie the worker discovers later; a blob with no row is an orphan a
    // reconciliation sweep can find. Orphan beats lie.
    const stored = await blobStore.putEob({ tenantSlug, data: file.buffer });

    // SLICE 5.5, PART C. The `existing` lookup above is a READ-then-write, so
    // two uploads of the same PDF arriving together both see no prior and both
    // insert — two batches, two sets of claims, two sets of lines, which is a
    // double-post waiting for Slice 6c. The ERA path closed exactly this race
    // with a unique index rather than with application code, because only the
    // database can win it; `rcm_eob_uploads_office_hash_unique` is the EOB
    // equivalent (partial: a FAILED upload does not hold the hash, so a
    // document that failed extraction can still be retried).
    //
    // The loser of the race gets the same answer it would have got a
    // millisecond later, which is the honest one: this document is already here.
    let row;
    try {
      const inserted = await tenantDb.withTenantDb(req, async (pool) => {
        // D-5 (Slice 6a): who brought this document in. `uploaded_by` is a FK
        // to rcm_user_map, and the row is created here on a person's first RCM
        // action rather than requiring an administrator to pre-seed a
        // crosswalk. Resolved before the INSERT and outside any transaction —
        // resolveRcmActor is SELECT-then-INSERT..ON CONFLICT, so it commits on
        // its own and the FK target exists by the time the INSERT below runs.
        const uploadedBy = await resolveRcmActor(pool, {
          email: actorEmail(req),
          displayName: (req.user && (req.user.name || req.user.displayName)) || '',
        });
        return pool.query(
          `INSERT INTO rcm_eob_uploads
             (office_id, filename, file_key, file_url, file_hash, file_size_bytes, content_type, status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', $8)
           RETURNING ${LIST_COLUMNS}`,
          [office, filename, stored.key, stored.url, fileHash, stored.bytes, 'application/pdf', uploadedBy]
        );
      });
      row = inserted.rows[0];
    } catch (err) {
      if (!err || err.code !== '23505') throw err;

      const raced = await tenantDb.withTenantDb(req, (pool) =>
        pool.query(
          `SELECT ${LIST_COLUMNS} FROM rcm_eob_uploads
            WHERE office_id = $1 AND file_hash = $2
            ORDER BY uploaded_at DESC LIMIT 1`,
          [office, fileHash]
        )
      );
      const winner = raced.rows[0];
      if (!winner) throw err; // The constraint fired but the row is gone: not ours to explain.

      await auditEobWrite(req, office, winner.upload_id);
      return res.status(200).json({
        success: true,
        office,
        duplicate: true,
        upload: toWire(winner),
        extraction: budget.status(),
      });
    }

    // Audited BEFORE the 201: a PHI document entering the system without a
    // recorded trail is the thing hard rule 5 forbids, and h() turns an audit
    // failure into a 500 rather than a silent success.
    await auditEobWrite(req, office, row.upload_id);

    // Queued AFTER the audit and AFTER the commit, so the worker can never
    // reach the row before it exists.
    queue.enqueue({ tenantId, tenantSlug, office, uploadId: row.upload_id });

    return res.status(201).json({
      success: true,
      office,
      duplicate: false,
      upload: toWire(row),
      // The honest answer to "will this actually extract?" — the client shows
      // "extraction paused" straight away rather than leaving a document
      // sitting at 'uploaded' with no explanation.
      extraction: budget.status(),
    });
  })
);

/**
 * Audit a write on the EOB path, fail-closed.
 *
 * `resourceId` is the upload id — an identifier we minted, never the filename,
 * which is PHI.  stays null: it means "the external cause of this
 * action" (the voice call id behind a TC handoff), and an upload has no
 * external cause.
 */
async function auditEobWrite(req, office, uploadId) {
  await audit(req, {
    action: 'CREATE',
    resourceType: 'rcm_eob_upload',
    resourceId: uploadId,
    result: 'SUCCESS',
    office,
    sourceRef: null,
  });
}

/**
 * Bound the stored filename. NOT sanitized for path safety — it never becomes a
 * path (the blob key is a uuid) — only clipped so a pathological name cannot
 * bloat the row, and stripped of control characters so it cannot corrupt a
 * terminal or a CSV export downstream.
 */
function sanitizeFilename(raw) {
  const s = typeof raw === 'string' ? raw : '';
  // Control characters, by code point rather than a literal character class —
  // a class containing raw control bytes makes this source file itself binary.
  const clean = Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 0x1f && c !== 0x7f;
    })
    .join('')
    .trim();
  return (clean || 'upload.pdf').slice(0, 255);
}

// ─── GET /api/rcm/eob ────────────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    const { rows, total } = await tenantDb.withTenantDb(req, async (pool) => {
      const [page, count] = await Promise.all([
        pool.query(
          `SELECT ${LIST_COLUMNS} FROM rcm_eob_uploads WHERE office_id = $1 ` +
            `ORDER BY uploaded_at DESC LIMIT $2 OFFSET $3`,
          [office, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM rcm_eob_uploads WHERE office_id = $1`, [office]),
      ]);
      return { rows: page.rows, total: num(count.rows[0] && count.rows[0].n) };
    });

    // filename is PHI, so this list is a PHI read and audits like one.
    await auditRcmRead(req, 'rcm_eob_upload', { office });

    return res.json({
      success: true,
      office,
      uploads: rows.map(toWire),
      total,
      limit,
      offset,
      // Breaker state, surfaced honestly. When `paused` is true, an 'uploaded'
      // row is waiting on the clock, not stuck — and `resetsAt` says when.
      extraction: { ...budget.status(), queue: queue.stats() },
      /*
       * WHAT D-8 COSTS, MEASURED.
       *
       * Beau chose on reasoning that RCM holds the shared per-credential Open
       * Dental slot at 1200ms, which means a live phone-path lookup can wait
       * behind a batch match. He should be able to revisit that on data, so the
       * data is here: 429s attributed to the module whose request got one,
       * RCM's observed interval against its configured floor, and the worst
       * wait any non-RCM caller took behind an RCM reservation.
       *
       * Process-local and reset on restart — a trend indicator, not an SLA.
       */
      odPacing: {
        rcmFloorMs: odPacer.FLOOR_MS,
        rcmConfiguredMs: odPacer.resolveMinIntervalMs(),
        rcmObservedMs: odPacer.observedIntervalMs(),
        rcmCalls: odPacer.stats.calls,
        ...openDental.odTrafficStats(),
      },
    });
  })
);

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.MIN_UPLOAD_BYTES = MIN_UPLOAD_BYTES;
