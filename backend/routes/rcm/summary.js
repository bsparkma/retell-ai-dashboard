'use strict';

/**
 * GET /api/rcm/summary?office=roland|valley
 *
 * Per-office counts across the three tables the module is actually about:
 * claims, payment batches, and the posting queue. Cheap (three indexed
 * aggregates, no row bodies, no PHI) and real — this is the first code on the
 * platform to query the rcm_* tables, so it is also what proves the carein_app
 * grants from the Slice 1 migration work outside a migration test.
 *
 * Every count is zero-filled over the status vocabulary from that table's CHECK
 * constraint, so an empty office answers with zeros rather than an empty object
 * the UI has to guess about. Zeros on a freshly-entitled tenant are the honest
 * state, not a failure.
 */

const express = require('express');

// Namespace import, NOT `const { withTenantDb } = …`. A destructured binding is
// captured at module load, which pins whatever the function was then — the same
// reason platform/audit.js and routes/tc/tx.js reach through the namespace.
const tenantDb = require('../../platform/tenantDb');
const { h, auditRcmRead, countsByStatus, totalOf } = require('./helpers');

const router = express.Router();

/**
 * Status vocabularies, copied from the CHECK constraints in
 * migrations-tenant/1786622400000_rcm_schema.js. If a migration widens one of
 * those constraints, widen the matching list here in the same PR — a status the
 * database can store but this file does not name still gets counted (see
 * countsByStatus), it just arrives as an unexpected key.
 */
const CLAIM_STATUSES = Object.freeze(['posted', 'pending_review', 'processing', 'error', 'matched']);
const BATCH_STATUSES = Object.freeze([
  'open',
  'ready',
  'posting',
  'balanced',
  'unbalanced',
  'posted',
  'error',
]);
const QUEUE_STATUSES = Object.freeze([
  'approved',
  'posting',
  'posted',
  'failed',
  'partially_posted',
]);

/**
 * Queue states that still owe work. 'approved' means approved and NOT yet
 * posted; 'partially_posted' means a run failed mid-flight. 'posted' and
 * 'failed' are terminal — a failed row is finished, not waiting, and counting
 * it as depth would make the number never reach zero.
 */
const QUEUE_OPEN_STATUSES = Object.freeze(['approved', 'posting', 'partially_posted']);

/** `SELECT status, COUNT(*) … GROUP BY status`, scoped to one office. */
function countByStatus(pool, table, office, extraWhere = '') {
  return pool.query(
    `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE office_id = $1${extraWhere} GROUP BY status`,
    [office]
  );
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;

    const { claims, batches, queue } = await tenantDb.withTenantDb(req, async (pool) => {
      // Archived claims are excluded: an archived claim is out of the working
      // set, and including it would make "claims in error" a number nobody can
      // act on. The claims LIST applies the same filter, so the two agree.
      const [claimRows, batchRows, queueRows] = await Promise.all([
        countByStatus(pool, 'rcm_claims', office, ' AND archived_at IS NULL'),
        countByStatus(pool, 'rcm_payment_batches', office),
        countByStatus(pool, 'rcm_posting_queue', office),
      ]);
      return { claims: claimRows.rows, batches: batchRows.rows, queue: queueRows.rows };
    });

    const claimCounts = countsByStatus(CLAIM_STATUSES, claims);
    const batchCounts = countsByStatus(BATCH_STATUSES, batches);
    const queueCounts = countsByStatus(QUEUE_STATUSES, queue);

    // No PHI in this response, but the read is audited anyway: "every /api/rcm
    // read leaves a trail" is a rule that survives someone adding a field, and
    // a per-endpoint judgement call is not.
    await auditRcmRead(req, 'rcm_summary', { office });

    return res.json({
      success: true,
      office,
      claims: { byStatus: claimCounts, total: totalOf(claimCounts) },
      batches: { byStatus: batchCounts, total: totalOf(batchCounts) },
      queue: {
        byStatus: queueCounts,
        total: totalOf(queueCounts),
        depth: QUEUE_OPEN_STATUSES.reduce((sum, s) => sum + (queueCounts[s] || 0), 0),
      },
    });
  })
);

module.exports = router;
module.exports.CLAIM_STATUSES = CLAIM_STATUSES;
module.exports.BATCH_STATUSES = BATCH_STATUSES;
module.exports.QUEUE_STATUSES = QUEUE_STATUSES;
module.exports.QUEUE_OPEN_STATUSES = QUEUE_OPEN_STATUSES;
