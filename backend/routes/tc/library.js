'use strict';

/**
 * /api/tc/library — per-office library config (tc_library_config).
 *
 * Port of the legacy /api/settings/library + the per-browser localStorage
 * financingSettings (server-owned from this slice on). One row per
 * (office, section); each section's jsonb value validates against its schema
 * in the shared contract's LibrarySectionSchemas — an unknown section or an
 * invalid shape never reaches the table. PUT replaces the whole section
 * atomically (legacy behavior: the settings UI edits a section at a time).
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, auditTc, iso, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');

const { LibrarySectionSchemas } = contract;

const SECTIONS = Object.freeze(Object.keys(LibrarySectionSchemas));

const router = express.Router();
router.use(requireOffice);

function badSection(res, section) {
  return res.status(400).json({
    success: false,
    error: `Unknown library section '${section}'. Valid: ${SECTIONS.join(', ')}`,
    code: 'UNKNOWN_SECTION',
  });
}

// ── GET / — every configured section for the office ─────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT section, value, updated_at FROM tc_library_config WHERE office_id = $1`,
        [req.tcOffice]
      )
    );

    const library = {};
    for (const r of rows.rows) library[r.section] = r.value;
    res.json({ success: true, library });
  })
);

// ── GET /:section ───────────────────────────────────────────────────────────

router.get(
  '/:section',
  h(async (req, res) => {
    const section = req.params.section;
    if (!SECTIONS.includes(section)) return badSection(res, section);

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT section, value, updated_at FROM tc_library_config
          WHERE office_id = $1 AND section = $2`,
        [req.tcOffice, section]
      )
    );
    if (rows.rows.length === 0) return notFound(res, `library section '${section}'`);

    res.json({
      success: true,
      section,
      value: rows.rows[0].value,
      updatedAt: iso(rows.rows[0].updated_at),
    });
  })
);

// ── PUT /:section — validate + upsert the whole section ─────────────────────

router.put(
  '/:section',
  h(async (req, res) => {
    const section = req.params.section;
    if (!SECTIONS.includes(section)) return badSection(res, section);

    const value = parseBody(res, LibrarySectionSchemas[section], req.body);
    if (value === null) return;

    const persisted = await withTenantTx(req, async (client) => {
      const upserted = await client.query(
        `INSERT INTO tc_library_config (office_id, section, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (office_id, section)
          DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          RETURNING section, value, updated_at`,
        [req.tcOffice, section, JSON.stringify(value)]
      );
      return upserted.rows[0];
    });

    await auditTc(req, 'UPDATE', 'tc_library_config', `${req.tcOffice}/${section}`);
    res.json({
      success: true,
      section: persisted.section,
      value: persisted.value,
      updatedAt: iso(persisted.updated_at),
    });
  })
);

module.exports = router;
