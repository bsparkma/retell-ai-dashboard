'use strict';

/**
 * Startup sweep — retire extractions this process cannot possibly be running.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * `processing` means "an attempt is in flight and money may be being spent". The
 * queue is in-process (see eobExtractionQueue.js), so a container restart takes
 * every in-flight job with it — but the ROW still says `processing`. Nothing
 * would ever move it again. A row claiming work is happening when no worker
 * exists anywhere is exactly the kind of lie the platform's honest-states rule
 * forbids, and it is worse than a failure: a failure tells the poster to try
 * again, whereas a permanent `processing` tells them to wait for something that
 * will never come.
 *
 * So on boot, every `processing` row becomes `failed` with a plain reason. The
 * retry path is unchanged and is the one already documented: re-upload the same
 * PDF and the dedup probe re-queues it.
 *
 * ── WHY THIS IS SAFE, AND WHAT WOULD BREAK IT ────────────────────────────────
 * Two conditions, both load-bearing:
 *
 *   1. It runs BEFORE `server.listen()`. No request served by THIS process can
 *      have set a row to `processing` yet, so the sweep cannot race a live
 *      extraction of its own making.
 *   2. The app runs at **maxReplicas = 1**. That is the standing invariant for
 *      the container apps (it is also what the AzureFile call-store mount
 *      requires). Under a second replica this sweep becomes actively harmful:
 *      replica B booting would mark replica A's genuinely in-flight extraction
 *      `failed`, and A would then commit a proposal against a row that says it
 *      failed. A timestamp filter does NOT fix that — A's row was set to
 *      `processing` before B booted, so any "older than my boot" filter still
 *      catches it. The real fix is a lease/heartbeat on the row, and that is
 *      the work to do BEFORE raising maxReplicas, not after.
 *
 * ── NEVER BLOCKS STARTUP ─────────────────────────────────────────────────────
 * Unlike `audit.assertReady()`, which deliberately aborts boot, this is
 * housekeeping. An unreachable tenant database logs and is skipped: refusing to
 * start the whole app because one tenant's cleanup could not run would trade a
 * stale row for an outage.
 */

const INTERRUPTED_REASON =
  'Extraction was interrupted — the server restarted while this document was ' +
  'processing. Upload it again to retry.';

/**
 * Mark every `processing` upload in every active tenant as `failed`.
 *
 * @param {{ registry?: unknown, tenantDb?: unknown }} [deps] injectable for tests
 * @returns {Promise<{ swept: number, tenants: number, skipped: number }>}
 */
async function sweepInterruptedExtractions(deps = {}) {
  const registry = deps.registry || require('../../platform/registry');
  const tenantDb = deps.tenantDb || require('../../platform/tenantDb');

  let tenants = [];
  try {
    tenants = await registry.listTenants();
  } catch (err) {
    console.warn(
      '[rcm/eob] startup sweep skipped — could not list tenants:',
      err && err.message ? err.message : err
    );
    return { swept: 0, tenants: 0, skipped: 0 };
  }

  const active = (tenants || []).filter((t) => t && t.status === 'active');
  let swept = 0;
  let skipped = 0;

  for (const tenant of active) {
    try {
      const pool = await tenantDb.getTenantPool(tenant.tenant_id);
      // Not office-scoped: there is no request here, and a restart interrupted
      // whatever was running in EVERY office. `processing` is unambiguous —
      // there is exactly one worker and it no longer exists.
      const res = await pool.query(
        `UPDATE rcm_eob_uploads
            SET status = 'failed', error_message = $1, processed_at = now(), updated_at = now()
          WHERE status = 'processing'
          RETURNING upload_id`,
        [INTERRUPTED_REASON]
      );
      const n = res.rows.length;
      swept += n;
      if (n > 0) {
        console.warn(
          `[rcm/eob] startup sweep: ${n} interrupted extraction(s) marked failed for ` +
            `tenant '${tenant.slug}' — re-upload to retry`
        );
      }
    } catch (err) {
      // A tenant that has never run the rcm_* migration, or whose database is
      // unreachable, is skipped rather than fatal. Logged so a persistent
      // failure is visible rather than silent.
      skipped++;
      console.warn(
        `[rcm/eob] startup sweep skipped tenant '${tenant.slug}':`,
        err && err.message ? err.message : err
      );
    }
  }

  return { swept, tenants: active.length, skipped };
}

module.exports = { sweepInterruptedExtractions, INTERRUPTED_REASON };
