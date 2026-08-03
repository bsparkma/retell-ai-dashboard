'use strict';

/**
 * /api/tc/media — the entitlement-checked media proxy.
 *
 * GET /?office=<o>&key=<blobKey> streams a gallery / smile-sim image through
 * the backend. The legacy app served these as UNAUTHENTICATED static files;
 * here a blob is served only when ALL of these hold:
 *   1. the request passed the /api auth gate + tenantContext (upstream),
 *   2. the tenant is entitled to the tc module (mount guard),
 *   3. the requested key is EXACTLY a blob key stored in a tc_gallery_cases or
 *      tc_smile_simulations row of the requested office.
 * Check 3 is the office-scoping + anti-traversal check in one: arbitrary keys
 * (or another office's keys) 404 without ever touching Blob storage.
 *
 * Blob access is via managed identity (services/tcMediaStore.js) — no SAS URL
 * ever reaches the client. Every served blob is an audited PHI READ (clinical
 * photos).
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, auditTc, notFound } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const mediaStore = require('../../services/tcMediaStore');

const { z } = contract;

const router = express.Router();
router.use(requireOffice);

const MediaQuery = z
  .object({
    office: z.string(),
    key: z.string().min(1).max(500),
  })
  .strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, MediaQuery, req.query);
    if (!query) return;

    // The key must be a stored blob key of THIS office — one indexed-enough
    // existence check across both metadata tables.
    const owned = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT 1 FROM tc_gallery_cases
          WHERE office_id = $1 AND (before_blob_key = $2 OR after_blob_key = $2)
         UNION ALL
         SELECT 1 FROM tc_smile_simulations
          WHERE office_id = $1 AND (original_blob_key = $2 OR result_blob_key = $2)
         LIMIT 1`,
        [req.tcOffice, query.key]
      )
    );
    if (owned.rows.length === 0) return notFound(res, 'media');

    if (!mediaStore.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'TC media storage is not configured on this deployment',
        code: 'MEDIA_STORE_UNCONFIGURED',
      });
    }

    const blob = await mediaStore.openBlob(query.key);
    if (!blob) return notFound(res, 'media');

    // Serving the clinical photo is a PHI read — audit BEFORE bytes flow
    // (fail-closed: no audit row, no image).
    await auditTc(req, 'READ', 'tc_media', query.key);

    res.setHeader('Content-Type', blob.contentType || 'application/octet-stream');
    if (blob.contentLength != null) res.setHeader('Content-Length', String(blob.contentLength));
    res.setHeader('Cache-Control', 'private, no-store');
    blob.stream.on('error', (err) => {
      console.error('[tc/media] stream error:', err && err.message ? err.message : err);
      res.destroy(err);
    });
    blob.stream.pipe(res);
  })
);

module.exports = router;
