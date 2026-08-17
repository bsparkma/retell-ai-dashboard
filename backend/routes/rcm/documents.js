'use strict';

/**
 * GET /api/rcm/uploads/:id/document?office=roland|valley — the source document.
 *
 * The workbench shows a parsed remittance. This is the route back to the bytes
 * it was parsed from, and it exists because **a review screen that renders a
 * parser's output with no way to check it against the original asks people to
 * trust a parser they cannot see.** An EOB PDF in particular was read by a
 * model and can be WRONG, not merely malformed; the biller's recourse when a
 * number looks off is to open the document.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE KEY IS NEVER THE CAPABILITY
 * ─────────────────────────────────────────────────────────────────────────────
 * Blob keys are opaque (`tenant/<slug>/rcm/eob/<uuid>.pdf`) and are NOT in any
 * response body — Slice 4 is explicit that "a key in a response is a key in a
 * browser cache". The client addresses a document by its `upload_id`, and this
 * route resolves that to a key only after four things hold:
 *
 *   1. the platform auth gate and `tenantContext` put a tenant on the request
 *      (fail-closed 403 without one), so the pool is this tenant's;
 *   2. `requireModule('rcm')` — the practice is entitled;
 *   3. `requireOffice` — and the row is read with `office_id` IN THE WHERE, so
 *      another office's document is NOT FOUND rather than found and refused;
 *   4. the audit row is written BEFORE a byte is served (hard rule 5).
 *
 * The container is private, the storage account has shared-key auth disabled,
 * and no SAS token is ever minted, so the bytes can only reach a browser
 * through this proxy — which is what makes those four checks the whole access
 * control rather than one layer of several.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FILENAMES ARE PHI
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm_eob_uploads.filename` routinely carries a patient name — it is a
 * documented PHI column. It IS sent as the Content-Disposition filename,
 * because a document that downloads as a uuid is one nobody can file. It is
 * never logged: this route logs the upload id and the office, and nothing else.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { h } = require('./helpers');
const eobBlobStore = require('../../services/rcm/eobBlobStore');
const eraFileStore = require('../../services/rcm/eraFileStore');

const router = express.Router();

/**
 * Which store holds this upload's bytes.
 *
 * The two containers are separate on purpose (`RCM_EOB_CONTAINER` /
 * `RCM_ERA_CONTAINER` — sharing one variable would have silently filed raw 835s
 * into the EOB container). The key's own path segment says which is which, and
 * reading it is more reliable than inferring from `content_type`, which is
 * whatever the browser guessed at upload time.
 *
 * @param {string} key
 * @returns {{ kind: 'era'|'eob', read: (key: string) => Promise<Buffer>, contentType: string }|null}
 */
function storeFor(key) {
  if (/\/rcm\/era\//.test(key)) {
    return { kind: 'era', read: eraFileStore.getEraFile, contentType: 'application/edi-x12' };
  }
  if (/\/rcm\/eob\//.test(key)) {
    return { kind: 'eob', read: eobBlobStore.getEob, contentType: 'application/pdf' };
  }
  return null;
}

/**
 * A filename safe for a Content-Disposition header.
 *
 * Quotes, control characters and newlines are stripped rather than escaped: a
 * filename is a label here, and a header-splitting attempt in one is not
 * something to preserve faithfully.
 * @param {unknown} name
 * @param {string} fallback
 */
function safeFilename(name, fallback) {
  const s = typeof name === 'string' ? name.replace(/[\r\n"\\]/g, '').trim() : '';
  return s.slice(0, 200) || fallback;
}

router.get(
  '/:id/document',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const uploadId = String(req.params.id);

    const upload = await tenantDb.withTenantDb(req, async (pool) => {
      // office_id in the WHERE — see the header. A cross-office read is
      // structurally a miss, not a refusal that had to be remembered.
      const { rows } = await pool.query(
        `SELECT upload_id, filename, file_key, content_type, status ` +
          `FROM rcm_eob_uploads WHERE office_id = $1 AND upload_id = $2`,
        [office, uploadId]
      );
      return rows[0] || null;
    });

    if (!upload) {
      return res
        .status(404)
        .json({ success: false, error: 'No such document for this office', code: 'DOCUMENT_NOT_FOUND' });
    }

    const store = upload.file_key ? storeFor(String(upload.file_key)) : null;
    if (!store) {
      // A row whose key we cannot place is a data problem, not a 404: the
      // document may well exist, and saying "not found" would send someone
      // looking for a missing upload instead of a mis-shaped key.
      console.error(`[rcm/documents] office=${office} upload=${uploadId} has an unrecognised blob key`);
      return res.status(500).json({
        success: false,
        error: 'This document is stored under an unrecognised key',
        code: 'DOCUMENT_KEY_UNRECOGNISED',
      });
    }

    if (!eraFileStore.isConfigured()) {
      // Same 503 vocabulary the uploads use. Both stores read the one
      // RCM_BLOB_ACCOUNT_URL, so either module's check answers for both.
      return res.status(503).json({
        success: false,
        error: 'Document storage is not configured for this environment',
        code: 'RCM_STORAGE_UNAVAILABLE',
      });
    }

    // THE TRAIL IS WRITTEN BEFORE THE BYTES. `audit` throws AuditError on
    // failure and h() turns that into a 500 — so a document is never served
    // without a recorded read (hard rule 5). resourceId is the upload id, which
    // we minted; the filename is PHI and stays out of the trail.
    await audit(req, {
      action: 'READ',
      resourceType: 'rcm_source_document',
      resourceId: uploadId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    let bytes;
    try {
      bytes = await store.read(String(upload.file_key));
    } catch (err) {
      console.error(
        `[rcm/documents] office=${office} upload=${uploadId} blob read failed:`,
        (err && err.message) || err
      );
      return res.status(502).json({
        success: false,
        error: 'The stored document could not be read',
        code: 'DOCUMENT_READ_FAILED',
      });
    }

    const filename = safeFilename(upload.filename, `remittance.${store.kind === 'era' ? 'edi' : 'pdf'}`);
    res.setHeader('Content-Type', upload.content_type || store.contentType);
    // `inline` so a PDF opens in the browser's viewer rather than landing in a
    // downloads folder — the point is to look at it next to the parsed rows.
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(bytes.length));
    // PHI must not sit in a shared cache, and a private one is enough for the
    // back button to work within a session.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  })
);

module.exports = router;
module.exports.storeFor = storeFor;
module.exports.safeFilename = safeFilename;
