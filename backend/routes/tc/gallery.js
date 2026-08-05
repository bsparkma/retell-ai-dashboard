'use strict';

/**
 * /api/tc/gallery — before/after gallery metadata (tc_gallery_cases).
 *
 * Metadata CRUD against blob KEYS — image bytes live in Azure Blob and are
 * served ONLY through the entitlement-checked media proxy (./media.js), never
 * via public/SAS URLs (the legacy app served them as unauthenticated static
 * files — that does not survive the port).
 *
 * DELETE removes the metadata row only; blob garbage collection is a Slice 2/7
 * concern (the importer owns the container lifecycle).
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, parseBody, h, auditTc, iso, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');

const { z, TcGalleryCase, Uuid } = contract;

const router = express.Router();
router.use(requireOffice);

const COLS = [
  'gallery_id',
  'legacy_id',
  'office_id',
  'title',
  'category',
  'description',
  'doctor_name',
  'before_blob_key',
  'after_blob_key',
];

/** DB row → contract entity. */
function toContract(r) {
  return TcGalleryCase.parse({
    galleryId: r.gallery_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    title: r.title,
    category: r.category,
    description: r.description,
    doctorName: r.doctor_name,
    beforeBlobKey: r.before_blob_key,
    afterBlobKey: r.after_blob_key,
    createdAt: iso(r.created_at),
  });
}

const GalleryCreate = TcGalleryCase.omit({
  galleryId: true,
  legacyId: true,
  officeId: true,
  createdAt: true,
})
  .partial({ category: true, description: true, doctorName: true })
  .strict();

async function loadOne(q, office, galleryId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')}, created_at FROM tc_gallery_cases
      WHERE office_id = $1 AND gallery_id = $2`,
    [office, galleryId]
  );
  return res.rows.length ? toContract(res.rows[0]) : null;
}

/** Insert one gallery row (shared with smile-sim's save-to-gallery). */
async function insertGalleryRow(q, row) {
  await q.query(
    `INSERT INTO tc_gallery_cases (${COLS.join(', ')})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.gallery_id,
      row.legacy_id,
      row.office_id,
      row.title,
      row.category,
      row.description,
      row.doctor_name,
      row.before_blob_key,
      row.after_blob_key,
    ]
  );
}

// ── GET / — list ────────────────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')}, created_at FROM tc_gallery_cases
          WHERE office_id = $1 ORDER BY created_at DESC LIMIT 500`,
        [req.tcOffice]
      )
    );

    await auditTc(req, 'READ', 'tc_gallery', null);
    res.json({ success: true, gallery: rows.rows.map(toContract) });
  })
);

// ── POST / — create metadata (bytes must already be in Blob) ────────────────

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, GalleryCreate, req.body);
    if (!input) return;

    const galleryId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      await insertGalleryRow(client, {
        gallery_id: galleryId,
        legacy_id: null,
        office_id: req.tcOffice,
        title: input.title,
        category: input.category ?? '',
        description: input.description ?? '',
        doctor_name: input.doctorName ?? '',
        before_blob_key: input.beforeBlobKey,
        after_blob_key: input.afterBlobKey,
      });
      return loadOne(client, req.tcOffice, galleryId);
    });

    await auditTc(req, 'CREATE', 'tc_gallery', galleryId);
    res.status(201).json({ success: true, galleryCase: persisted });
  })
);

// ── GET /:id ────────────────────────────────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const parsed = Uuid.safeParse(req.params.id);
    if (!parsed.success) return notFound(res, 'gallery case');

    const found = await tenantDb.withTenantDb(req, (pool) => loadOne(pool, req.tcOffice, parsed.data));
    if (!found) return notFound(res, 'gallery case');

    await auditTc(req, 'READ', 'tc_gallery', parsed.data);
    res.json({ success: true, galleryCase: found });
  })
);

// ── DELETE /:id — metadata row only ─────────────────────────────────────────

router.delete(
  '/:id',
  h(async (req, res) => {
    const parsed = Uuid.safeParse(req.params.id);
    if (!parsed.success) return notFound(res, 'gallery case');

    const deleted = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        'DELETE FROM tc_gallery_cases WHERE office_id = $1 AND gallery_id = $2 RETURNING gallery_id',
        [req.tcOffice, parsed.data]
      )
    );
    if (deleted.rows.length === 0) return notFound(res, 'gallery case');

    await auditTc(req, 'DELETE', 'tc_gallery', parsed.data);
    res.json({ success: true });
  })
);

module.exports = router;
module.exports.insertGalleryRow = insertGalleryRow;
module.exports.GALLERY_COLS = COLS;
