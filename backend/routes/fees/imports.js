'use strict';

/**
 * /api/fees/imports — upload a payer fee schedule, parse it, look at it.
 *
 *   POST /                      multipart, file in a field named `file`
 *   GET  /                      this office's imports, newest first
 *   GET  /:batchId              one import and every row parsed out of it
 *
 * Office comes from the router-wide `requireOffice` — the validated `?office=`
 * query param, never a body field. A fee schedule belongs to ONE office's
 * contract with a payer; Roland and Riley hold different terms with the same
 * carriers, so a schedule attached to the wrong one would eventually reprice a
 * practice against terms it never agreed to.
 *
 * `fees.write` is enforced one level up by the mount's
 * `requireReadWrite('fees.read','fees.write')` — every non-GET method under
 * /api/fees demands the write action. That is why POST needs no gate of its
 * own, and `feesImports.test.js` pins it rather than trusting this comment.
 *
 * ─── NOTHING HERE TOUCHES OPEN DENTAL ─────────────────────────────────────
 *
 * Not to write, and not to read. There is no office client, no `getOdOffice`,
 * no MySQL. `feesNoOdAccess.test.js` scans this module's whole source for
 * either and fails on it. Slice 1 is: here is what your file says. Deciding it
 * is right, and posting it through the office-keyed OD cloud API, is a later
 * slice with its own approval shape.
 *
 * ─── HONEST STATES ────────────────────────────────────────────────────────
 *
 * A file that will not parse is STORED as a `failed` batch carrying the reason,
 * and the response is a 422 naming both. Three things follow from that, and all
 * three are deliberate:
 *
 *  - The upload is never silently lost. "I uploaded it and nothing happened" is
 *    the support ticket that follows a dropped request, and it is unanswerable.
 *  - The response is a REFUSAL, not a success with zero rows. A 200 whose body
 *    says `rowCount: 0` reads as "your schedule has no fees in it".
 *  - `status: 'failed'` and `row_count: 0` are enforced together by a CHECK, so
 *    half a parse cannot be presented as a preview somebody would post.
 *
 * And success is reported only after the rows are IN the database: the response
 * is built from what `insertBatch` read back, not from what the parser
 * returned. A success we cannot show the user again is a lie — the same rule
 * services/onDemandTranscription.js states for its own write.
 */

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');

const tenantDb = require('../../platform/tenantDb');
const { h, refuse, actorEmail, auditBatchCreate, isUuid } = require('./helpers');
const { parseFeeSchedule, sourceTypeFromFilename } = require('../../services/fees/parseFeeSchedule');
const importStore = require('./importStore');

const router = express.Router();

/**
 * Upload ceiling. The largest payer fee schedule in the corpus is a 40-page PDF
 * at about 600 KB; 10 MB is more than an order of magnitude of headroom and
 * still refuses a mis-drag of a scanned folder.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Smaller than the shortest legal PDF container. A truncated download, not a
 * schedule. (A CSV can legitimately be tiny, but not this tiny: `Code,Fee` plus
 * one row is already 24 bytes and would still be refused by the parser's own
 * NO_DATA_ROWS rule if it were only a header.)
 */
const MIN_UPLOAD_BYTES = 16;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Memory storage. The bytes are never written to disk — see the transport note
 * in the tenant migration's `file_sha256` comment, and routes/rcm/era.js, which
 * makes the same choice for the same reason.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * Turn multer's own errors into the module's structured shape — the same
 * treatment, and the same codes, the RCM upload routes give them. Without this,
 * an oversized file surfaces as multer's default handler rather than as
 * something a client can switch on.
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
      return refuse(
        res,
        400,
        'INVALID_UPLOAD',
        'Send exactly one file, in a multipart field named "file".'
      );
    }
    return refuse(res, 400, 'INVALID_UPLOAD', 'Could not read the uploaded file.');
  });
}

/**
 * The uploaded name, reduced to something safe to store.
 *
 * A fee schedule filename names a payer and a year, so unlike RCM's 835 names
 * it is not PHI. It is still attacker-controlled text: path separators are
 * stripped so a name can never escape into a path, control characters are
 * dropped so it cannot forge a line in a log, and it is bounded at 255.
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
  return cleaned.slice(0, 255) || 'fee-schedule';
}

/** A bounded, non-negative integer from a query param. */
function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

// ─── POST /api/fees/imports ─────────────────────────────────────────────────

router.post(
  '/',
  receiveFile,
  h(async (req, res) => {
    const office = req.feesOffice;
    const uploaded = req.file;

    if (!uploaded || !Buffer.isBuffer(uploaded.buffer) || uploaded.buffer.length === 0) {
      return refuse(
        res,
        400,
        'NO_FILE',
        'No file was attached. Send the fee schedule as a multipart field named "file".'
      );
    }
    if (uploaded.buffer.length < MIN_UPLOAD_BYTES) {
      return refuse(
        res,
        400,
        'FILE_TOO_SMALL',
        `That file is only ${uploaded.buffer.length} bytes — too small to be a fee schedule.`
      );
    }

    const bytes = uploaded.buffer;
    const filename = safeFilename(uploaded.originalname);

    // The extension, not the browser's Content-Type: a .csv arrives variously as
    // text/csv, application/vnd.ms-excel and application/octet-stream depending
    // on whether Excel is installed, so the header is not a usable signal. The
    // declared type is then VERIFIED against the bytes inside parseFeeSchedule
    // (a PDF must start with %PDF-), so a mislabelled file is refused by name
    // rather than by pdf-parse complaining about a container.
    const sourceType = sourceTypeFromFilename(filename);
    if (sourceType === null) {
      // Refused BEFORE anything is stored: there is no lane to attempt, so
      // there is no parse to record the failure of. `source_type` is NOT NULL
      // with a CHECK, so a batch for an .xlsx could not be written anyway —
      // which is the schema agreeing with this refusal rather than a coincidence.
      return refuse(
        res,
        415,
        'UNSUPPORTED_FILE_TYPE',
        `"${filename}" is neither a PDF nor a CSV. Upload the schedule as one of those.`
      );
    }

    // SHA-256 of the exact bytes — the only durable link back to a file whose
    // contents are not stored.
    const fileSha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const parsed = await parseFeeSchedule({ bytes, sourceType });

    const common = {
      office,
      filename,
      fileSha256,
      fileSizeBytes: bytes.length,
      sourceType,
      createdBy: actorEmail(req),
    };

    // ── The failure path. The batch is STORED, with the reason, and the
    //    response refuses. See the honest-states note in the header.
    if (!parsed.ok) {
      const { batch } = await tenantDb.withTenantDb(req, (pool) =>
        importStore.insertBatch(
          pool,
          {
            ...common,
            status: 'failed',
            warningCount: 0,
            warnings: [],
            failureReason: parsed.failureReason,
            failureCode: parsed.failureCode,
          },
          []
        )
      );

      // Audited BEFORE the response, and on the failure path too: a file that
      // would not parse is still a file somebody uploaded, and the trail is how
      // "who has been trying to import what" is answerable. Fail-closed —
      // AuditError becomes a 500 rather than a quiet 422.
      await auditBatchCreate(req, { office, resourceId: batch.batchId, result: 'ERROR' });

      return refuse(res, 422, parsed.failureCode, parsed.failureReason, { batch });
    }

    // ── The success path. One transaction; the response is built from what came
    //    BACK out of the database, never from the parser's own arrays.
    const stored = await tenantDb.withTenantDb(req, (pool) =>
      importStore.insertBatch(
        pool,
        {
          ...common,
          status: 'parsed',
          warningCount: parsed.warningCount,
          warnings: parsed.warnings,
          failureReason: null,
          failureCode: null,
        },
        parsed.rows
      )
    );

    await auditBatchCreate(req, { office, resourceId: stored.batch.batchId, result: 'SUCCESS' });

    return res.status(201).json({ success: true, batch: stored.batch, rows: stored.rows });
  })
);

// ─── GET /api/fees/imports ──────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.feesOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    const batches = await tenantDb.withTenantDb(req, (pool) =>
      importStore.listBatches(pool, office, { limit, offset })
    );

    return res.json({ success: true, office, batches, limit, offset });
  })
);

// ─── GET /api/fees/imports/:batchId ─────────────────────────────────────────

router.get(
  '/:batchId',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId } = req.params;

    // A malformed id is simply not found. Letting it reach Postgres produces
    // `invalid input syntax for type uuid` → a 500, so probing a real-looking
    // id that does not exist and probing a malformed one would answer
    // differently, and the shape of the error would tell a prober which.
    if (!isUuid(batchId)) {
      return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');
    }

    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const batch = await importStore.getBatch(pool, office, batchId);
      if (!batch) return null;
      // A failed batch has no rows by construction (the CHECK enforces it), so
      // this returns [] rather than needing a branch here.
      const rows = await importStore.getBatchRows(pool, office, batchId);
      return { batch, rows };
    });

    if (!result) {
      // The office is in the WHERE, so a batch belonging to the OTHER office is
      // indistinguishable from one that does not exist — which is the correct
      // answer to give, not a leak to paper over.
      return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');
    }

    return res.json({ success: true, batch: result.batch, rows: result.rows });
  })
);

module.exports = router;
