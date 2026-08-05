'use strict';

/**
 * /api/tc/smile-sim — AI smile simulation metadata (tc_smile_simulations).
 *
 * NO AI GENERATION IN SLICE 3: POST /generate exists but returns
 * FEATURE_DISABLED (501) — the image pipeline lands in Slice 7. POST / ports
 * the legacy /api/smile-sim/save flow against blob keys: optionally creates
 * the linked gallery entry ("Smile Sim — <patient> — <treatment>", legacy
 * category mapping) in the same transaction. created_by is the SSO identity.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc, iso, featureDisabled, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');
const { insertGalleryRow } = require('./gallery');

const { z, TcSmileSimulation, Uuid } = contract;

const router = express.Router();
router.use(requireOffice);

const COLS = [
  'sim_id',
  'legacy_id',
  'office_id',
  'case_id',
  'treatment_type',
  'prompt',
  'original_blob_key',
  'result_blob_key',
  'saved_to_gallery',
  'gallery_id',
  'created_by',
];

/** Legacy treatmentType → gallery category map (open vocabulary falls through). */
const TREATMENT_TYPE_TO_GALLERY_CATEGORY = Object.freeze({
  Veneers: 'Veneers',
  Orthodontics: 'Ortho',
  'Crown / Bridge': 'Crowns',
  'Single Crown': 'Crowns',
  Whitening: 'Whitening',
  'Full Mouth Rehab': 'Full Mouth Rehab',
});

/** DB row → contract entity. */
function toContract(r) {
  return TcSmileSimulation.parse({
    simId: r.sim_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    caseId: r.case_id,
    treatmentType: r.treatment_type,
    prompt: r.prompt,
    originalBlobKey: r.original_blob_key,
    resultBlobKey: r.result_blob_key,
    savedToGallery: r.saved_to_gallery,
    galleryId: r.gallery_id,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
  });
}

const SimCreate = TcSmileSimulation.omit({
  simId: true,
  legacyId: true,
  officeId: true,
  createdAt: true,
  createdBy: true,
  savedToGallery: true,
  galleryId: true,
})
  .partial({ caseId: true, prompt: true })
  .extend({ saveToGallery: z.boolean().default(false) })
  .strict();

async function loadOne(q, office, simId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')}, created_at FROM tc_smile_simulations
      WHERE office_id = $1 AND sim_id = $2`,
    [office, simId]
  );
  return res.rows.length ? toContract(res.rows[0]) : null;
}

// ── GET / — list (optionally by case) ───────────────────────────────────────

const ListQuery = z.object({ office: z.string(), caseId: Uuid.optional() }).strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const values = [req.tcOffice];
    let where = 'office_id = $1';
    if (query.caseId) {
      values.push(query.caseId);
      where += ` AND case_id = $${values.length}`;
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')}, created_at FROM tc_smile_simulations
          WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_smile_sim', null);
    res.json({ success: true, simulations: rows.rows.map(toContract) });
  })
);

// ── POST /generate — Slice 7 (AI pipeline) ──────────────────────────────────

router.post('/generate', featureDisabled('tc_smile_sim_generate'));

// ── POST / — save a simulation (blob keys), optional gallery entry ──────────

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, SimCreate, req.body);
    if (!input) return;

    const actor = actorEmail(req);
    const simId = randomUUID();

    const result = await withTenantTx(req, async (client) => {
      let patientName = null;
      if (input.caseId) {
        const header = await store.getCaseHeader(client, req.tcOffice, input.caseId);
        if (!header) return { missingCase: true };
        patientName = header.patient_name;
      }

      let galleryId = null;
      if (input.saveToGallery) {
        galleryId = randomUUID();
        await insertGalleryRow(client, {
          gallery_id: galleryId,
          legacy_id: null,
          office_id: req.tcOffice,
          title: `Smile Sim — ${patientName || 'Unknown Patient'} — ${input.treatmentType}`.slice(0, 200),
          category: TREATMENT_TYPE_TO_GALLERY_CATEGORY[input.treatmentType] || input.treatmentType,
          description: `AI Simulated — ${input.treatmentType}`,
          doctor_name: actor,
          before_blob_key: input.originalBlobKey,
          after_blob_key: input.resultBlobKey,
        });
      }

      await client.query(
        `INSERT INTO tc_smile_simulations (${COLS.join(', ')})
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          simId,
          null,
          req.tcOffice,
          input.caseId ?? null,
          input.treatmentType,
          input.prompt ?? '',
          input.originalBlobKey,
          input.resultBlobKey,
          input.saveToGallery,
          galleryId,
          actor,
        ]
      );
      return { simulation: await loadOne(client, req.tcOffice, simId) };
    });

    if (result.missingCase) return notFound(res, 'case');

    await auditTc(req, 'CREATE', 'tc_smile_sim', simId);
    res.status(201).json({ success: true, simulation: result.simulation });
  })
);

// ── DELETE /:id — metadata row only (blob GC is Slice 2/7) ──────────────────

router.delete(
  '/:id',
  h(async (req, res) => {
    const parsed = Uuid.safeParse(req.params.id);
    if (!parsed.success) return notFound(res, 'simulation');

    const deleted = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        'DELETE FROM tc_smile_simulations WHERE office_id = $1 AND sim_id = $2 RETURNING sim_id',
        [req.tcOffice, parsed.data]
      )
    );
    if (deleted.rows.length === 0) return notFound(res, 'simulation');

    await auditTc(req, 'DELETE', 'tc_smile_sim', parsed.data);
    res.json({ success: true });
  })
);

module.exports = router;
