'use strict';

/**
 * Referral attachments (queue item 55, R4) — the handlers, mounted by three
 * routers with their own gates:
 *
 *   TC (tc.full)              POST /:id/attachments, GET /:id/attachments,
 *                             GET  /:id/attachments/:attachmentId
 *   Sign-off (doctor + admin) GET  /:id/attachments, GET /:id/attachments/:aid
 *   Hygiene (hyg.write)       POST /:aptNum/referrals/:id/attachments
 *                             (only for a referral THIS visit started)
 *
 * UPLOAD — honest, limited, fail closed:
 *   - images + PDF only, decided by the BYTES (magic numbers), never by the
 *     client's declared type or filename;
 *   - 10 MB a file (multer refuses beyond it, before the body is buffered on);
 *     exactly 10 MB is allowed;
 *   - at most 5 a referral, counted under a row lock on the referral so two
 *     uploads at the fifth slot cannot both land;
 *   - the filename is sanitized (no path, no control or quote characters);
 *   - storage unconfigured, or the container missing → 503
 *     REFERRAL_STORAGE_UNAVAILABLE and NO metadata row;
 *   - the blob is written FIRST and the row only after the service confirmed
 *     it, in one transaction with the audit row. A failure after the blob
 *     write leaves an orphan blob (findable), never a row claiming a file
 *     that is not there.
 *   - memory only: bytes are never spooled to the container's disk.
 *
 * VIEW — FETCH, AUDIT, SERVE (the RCM documents rule): the bytes are read,
 * then the audit row is written (a failed audit refuses the view: nothing is
 * served unrecorded), then they are served — `Content-Type` from OUR key,
 * `nosniff`, `inline`, and `Cache-Control: private, no-store`, so the browser
 * keeps no copy and every look comes back through here and is audited. A
 * cache hit would be a disclosure with no trail; there is no cache.
 *
 * No Open Dental Images. Nothing sends.
 */

const multer = require('multer');
const { randomUUID } = require('node:crypto');

const { contract, actorEmail, auditTc } = require('./helpers');
const { audit } = require('../../platform/audit');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./referralStore');
const blob = require('../../services/tc/referralAttachmentStore');

const MAX_BYTES = contract.TC_REFERRAL_ATTACHMENT_MAX_BYTES;
const MAX_FILES = contract.TC_REFERRAL_ATTACHMENT_MAX_FILES;

/**
 * While a referral is still being decided, files may be added to it. The
 * default window; the TC staff route widens it (R6.9a, referrals.js).
 */
const ATTACHABLE_STATUSES = Object.freeze(['draft', 'pending_signoff']);

const ATTACHMENT_COLS = [
  'attachment_id',
  'office_id',
  'referral_id',
  'file_name',
  'content_type',
  'size_bytes',
  'blob_key',
  'uploaded_by',
  'uploaded_at',
];

// `fileSize` is a cut-off busboy trips on REACHING it, so +1 lets a file of
// exactly 10 MB through (the client's pre-check and the DB CHECK both allow
// ≤ 10 MB). `defParamCharset: 'utf8'`: a filename like "röntgen 🦷.png" is
// stored as typed, not as latin1 mojibake.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES + 1, files: 1 },
  defParamCharset: 'utf8',
});

/** multer's own errors, in the module's shape. */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.`,
        code: 'ATTACHMENT_TOO_LARGE',
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Send exactly one file, in a multipart field named "file".',
      code: 'INVALID_UPLOAD',
    });
  });
}

/**
 * A display name safe to store and to send back in a header: the last path
 * segment only, no control or quote characters, a bounded length, and a
 * fallback that carries the real extension.
 */
function sanitizeFilename(name, contentType) {
  const ext = Object.entries(blob.CONTENT_TYPE_BY_EXT).find(([, t]) => t === contentType)?.[0] || 'bin';
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return base || `attachment.${ext}`;
}

/** RFC 6266 Content-Disposition with an ASCII fallback (see routes/rcm/documents.js). */
function contentDisposition(filename) {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, '').replace(/[\\"]/g, '').trim() || 'attachment';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A row → what the client sees. The blob key never leaves the server. */
function toAttachment(r) {
  return {
    attachmentId: String(r.attachment_id),
    referralId: String(r.referral_id),
    fileName: r.file_name,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : String(r.uploaded_at),
  };
}

async function listRows(q, office, referralId) {
  const res = await q.query(
    `SELECT ${ATTACHMENT_COLS.join(', ')} FROM tc_referral_attachments WHERE office_id = $1 AND referral_id = $2 ORDER BY uploaded_at ASC`,
    [office, referralId]
  );
  return res.rows;
}

function refuse(res, status, error, code) {
  return res.status(status).json({ success: false, error, code });
}

/**
 * POST — one file onto one referral.
 *
 * @param {{ officeOf: (req) => string, referralIdOf: (req) => string,
 *           guard?: (req, referralRow) => (Promise<null | [number, string, string]> | null | [number, string, string]),
 *           attachableStatuses?: readonly string[], lockedMessage?: string }} opts
 *   attachableStatuses / lockedMessage: the status window and its refusal
 *   sentence, read under the row lock. Default: ATTACHABLE_STATUSES. Only the
 *   TC staff route widens it (R6.9a).
 */
function uploadHandler({
  officeOf,
  referralIdOf,
  guard,
  attachableStatuses = ATTACHABLE_STATUSES,
  lockedMessage = 'Files can be added only while a referral is a draft or awaiting sign-off.',
}) {
  return async (req, res) => {
    const office = officeOf(req);
    const referralId = referralIdOf(req);
    if (!contract.z.string().uuid().safeParse(referralId).success) {
      return refuse(res, 400, 'Invalid referral id', 'INVALID_ID');
    }
    // Fail closed BEFORE anything is read or stored.
    if (!blob.isConfigured()) {
      return refuse(res, 503, "Attachment storage isn't set up here yet. Nothing was saved.", 'REFERRAL_STORAGE_UNAVAILABLE');
    }
    const file = req.file;
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      return refuse(res, 400, 'Choose a file to attach.', 'INVALID_UPLOAD');
    }
    const contentType = blob.sniffContentType(file.buffer);
    if (!contentType) {
      return refuse(res, 415, 'Only images (PNG, JPEG, WebP, GIF) and PDFs can be attached.', 'ATTACHMENT_TYPE_NOT_ALLOWED');
    }
    const tenantSlug = req.tenant && req.tenant.slug;
    if (!tenantSlug) return refuse(res, 403, 'No practice for this request', 'NO_TENANT');
    const fileName = sanitizeFilename(file.originalname, contentType);
    const actor = actorEmail(req);

    // A refusal THROWS this, so the transaction rolls back and a refused
    // attempt leaves the referral exactly as it was (not even updated_at).
    const refusal = (status, error, code) => Object.assign(new Error(code), { refusal: [status, error, code] });

    let outcome;
    try {
      outcome = await withTenantTx(req, async (client) => {
        // Row-lock the referral FIRST (an UPDATE takes it), so the status read
        // and the count below cannot be overtaken by a submit, an approval or
        // another upload committing in between.
        await client.query('UPDATE tc_referrals SET updated_at = now() WHERE office_id = $1 AND referral_id = $2', [
          office,
          referralId,
        ]);
        const ref = await store.findReferral(client, office, referralId);
        if (!ref) throw refusal(404, 'Referral not found', 'NOT_FOUND');
        if (guard) {
          const g = await guard(req, ref);
          if (g) throw refusal(...g);
        }
        if (!attachableStatuses.includes(ref.status)) {
          throw refusal(409, lockedMessage, 'REFERRAL_LOCKED');
        }
        const existing = await listRows(client, office, referralId);
        if (existing.length >= MAX_FILES) {
          throw refusal(409, `A referral can carry at most ${MAX_FILES} files.`, 'ATTACHMENT_LIMIT');
        }
        // The bytes first; the row only once storage confirmed them.
        const stored = await blob.putAttachment({ tenantSlug, data: file.buffer, contentType });
        const attachmentId = randomUUID();
        await client.query(
          `INSERT INTO tc_referral_attachments (attachment_id, office_id, referral_id, file_name, content_type, size_bytes, blob_key, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [attachmentId, office, referralId, fileName, contentType, stored.bytes, stored.key, actor]
        );
        const row = (await listRows(client, office, referralId)).find((r) => String(r.attachment_id) === attachmentId);
        if (!row) throw new Error('attachment row was not stored');
        await auditTc(req, 'CREATE', 'tc_referral_attachment', attachmentId, { office, sourceRef: `referral:${referralId}` });
        return { row };
      });
    } catch (err) {
      if (err && err.refusal) return refuse(res, ...err.refusal);
      if (err && err.code === 'REFERRAL_STORAGE_UNAVAILABLE') {
        console.error(`[tc/referralAttachments] office=${office} storage unavailable: ${err.message}`);
        return refuse(res, 503, "Attachment storage isn't set up here yet. Nothing was saved.", 'REFERRAL_STORAGE_UNAVAILABLE');
      }
      throw err;
    }
    return res.status(201).json({ success: true, attachment: toAttachment(outcome.row) });
  };
}

/** GET — a referral's files (metadata only). */
function listHandler({ officeOf, referralIdOf, guard }) {
  return async (req, res) => {
    const office = officeOf(req);
    const referralId = referralIdOf(req);
    if (!contract.z.string().uuid().safeParse(referralId).success) {
      return refuse(res, 400, 'Invalid referral id', 'INVALID_ID');
    }
    const out = await tenantDb.withTenantDb(req, async (pool) => {
      const ref = await store.findReferral(pool, office, referralId);
      if (!ref) return { refusal: [404, 'Referral not found', 'NOT_FOUND'] };
      if (guard) {
        const g = await guard(req, ref);
        if (g) return { refusal: g };
      }
      return { rows: await listRows(pool, office, referralId) };
    });
    if (out.refusal) return refuse(res, ...out.refusal);
    // File names can carry PHI (a scan named after the patient): the list is a
    // read, and is audited like every other referral read.
    await auditTc(req, 'READ', 'tc_referral_attachment', null, { office, sourceRef: `referral:${referralId}` });
    return res.json({ success: true, attachments: out.rows.map(toAttachment) });
  };
}

/** GET — one file's bytes. FETCH, AUDIT, SERVE. */
function viewHandler({ officeOf, referralIdOf, guard }) {
  return async (req, res) => {
    const office = officeOf(req);
    const referralId = referralIdOf(req);
    const attachmentId = req.params.attachmentId;
    const Uuid = contract.z.string().uuid();
    if (!Uuid.safeParse(referralId).success || !Uuid.safeParse(attachmentId).success) {
      return refuse(res, 400, 'Invalid id', 'INVALID_ID');
    }
    const found = await tenantDb.withTenantDb(req, async (pool) => {
      const ref = await store.findReferral(pool, office, referralId);
      if (!ref) return { refusal: [404, 'Attachment not found', 'NOT_FOUND'] };
      if (guard) {
        const g = await guard(req, ref);
        if (g) return { refusal: g };
      }
      const row = (await listRows(pool, office, referralId)).find((r) => String(r.attachment_id) === attachmentId);
      return row ? { row } : { refusal: [404, 'Attachment not found', 'NOT_FOUND'] };
    });
    if (found.refusal) return refuse(res, ...found.refusal);
    const contentType = blob.contentTypeForKey(found.row.blob_key);
    if (!blob.isConfigured() || !contentType) {
      return refuse(res, 503, "Attachment storage isn't available here.", 'REFERRAL_STORAGE_UNAVAILABLE');
    }

    let bytes;
    try {
      bytes = await blob.getAttachment(String(found.row.blob_key));
    } catch (err) {
      console.error(`[tc/referralAttachments] office=${office} attachment=${attachmentId} read failed:`, (err && err.message) || err);
      // An attempt, not a read: nothing was served.
      await audit(req, {
        action: 'READ',
        resourceType: 'tc_referral_attachment',
        resourceId: attachmentId,
        result: 'ERROR',
        office,
        sourceRef: `referral:${referralId}`,
      }).catch(() => {});
      return refuse(res, 502, 'The stored file could not be read', 'ATTACHMENT_READ_FAILED');
    }

    // The trail precedes the bytes: a failed audit throws, and nothing is served.
    await auditTc(req, 'READ', 'tc_referral_attachment', attachmentId, { office, sourceRef: `referral:${referralId}` });

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition(found.row.file_name));
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  };
}

module.exports = {
  ATTACHABLE_STATUSES,
  ATTACHMENT_COLS,
  receiveFile,
  sanitizeFilename,
  contentDisposition,
  toAttachment,
  uploadHandler,
  listHandler,
  viewHandler,
};
