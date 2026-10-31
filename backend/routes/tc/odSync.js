'use strict';

/**
 * /api/tc/od-sync — the Pipeline's Open Dental sync (CO-4b). tc.full.
 *
 *   GET  /status?office=                 the switch, the last run and its summary, the
 *                                        cases it cannot track (no appointment linked),
 *                                        the standing automatic changes (with Undo) and
 *                                        the open flags
 *   POST /run?office=                    "Sync now": starts a sweep of THIS office and
 *                                        answers 202 at once (a sweep paces Open Dental at
 *                                        ≥ 1.2 s per read); the page polls /status
 *   POST /cases/:caseId/undo?office=     revert the last automatic change on a case
 *
 * OFFICE LAW. `?office=` through requireOffice; every statement names it; the
 * engine reads only the appointments the office's own rows anchor, from that
 * office's own Open Dental. Nothing in a body names an office or a PatNum.
 *
 * SYNC NOW is refused while the office's switch is off (409 OD_SYNC_OFF), while a
 * sweep of the office is running (409 OD_SYNC_IN_PROGRESS), and within the
 * cooldown of the office's last manual run (429 OD_SYNC_RATE_LIMITED, with
 * retryAfterSeconds) — the rate limit reads the stored runs, so a restart does
 * not reset it. Undo is NOT behind the switch: turning the sync off must never
 * trap a move nobody can take back.
 *
 * The voice module's "Sync now" (routes/unifiedCalls.js) is the pattern: the
 * person asks, the system runs, the trail names both.
 */

const express = require('express');
const { z } = require('zod');

const { requireOffice, actorEmail, h, auditTc, notFound } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { auditMany } = require('../../platform/audit');
const store = require('./caseStore');
const tcOdSync = require('../../config/tcOdSync');
const engine = require('../../services/tc/odPipelineSync');

const router = express.Router();
router.use(requireOffice);

/** Sweeps started by this router and not yet finished (tests await them). */
const inflight = new Map();
/** Offices between "accepted" and the engine holding its own lock — closes the double-click race. */
const starting = new Set();

/** The request the engine's audit rows are written through: the system as the actor. */
function systemRequest(req) {
  return Object.assign(Object.create(req), { user: { email: engine.SYNC_ACTOR } });
}

function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** A stored run, as the page shows it. A 'running' row older than 30 minutes died with its process. */
function runView(row, now) {
  if (!row) return null;
  const summary = row.summary && typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary || null;
  let status = row.status;
  if (status === 'running' && now - new Date(row.started_at).getTime() > 30 * 60 * 1000) status = 'interrupted';
  return {
    runId: String(row.run_id),
    trigger: row.trigger,
    requestedBy: row.requested_by || null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    status,
    summary,
    errorCode: row.error_code || null,
  };
}

/** When the next manual run is allowed, or null when it is allowed now. */
function nextAllowedAt(lastManual, now) {
  if (!lastManual) return null;
  const next = new Date(lastManual.started_at).getTime() + tcOdSync.manualCooldownMinutes() * 60 * 1000;
  return next > now ? new Date(next).toISOString() : null;
}

// ── GET /status ─────────────────────────────────────────────────────────────

router.get(
  '/status',
  h(async (req, res) => {
    const office = req.tcOffice;
    const enabled = await tcOdSync.isEnabled(office);
    const now = Date.now();
    const out = await tenantDb.withTenantDb(req, async (pool) => {
      const [last, lastManual, panel, unanchored] = await Promise.all([
        engine.lastRun(pool, office),
        engine.lastManualRun(pool, office),
        engine.listForPanel(pool, office),
        engine.countUnanchored(pool, office),
      ]);
      return { last, lastManual, panel, unanchored };
    });
    // The panel names patients (the changed and flagged cases).
    await auditTc(req, 'READ', 'tc_case', null, { office });
    res.json({
      success: true,
      office,
      enabled,
      running: engine.isRunning(office) || starting.has(office),
      lastRun: runView(out.last, now),
      nextAllowedAt: nextAllowedAt(out.lastManual, now),
      unanchoredCount: out.unanchored,
      changes: out.panel.changes,
      flagged: out.panel.flagged,
    });
  })
);

// ── POST /run — Sync now ────────────────────────────────────────────────────

router.post(
  '/run',
  h(async (req, res) => {
    const office = req.tcOffice;
    const actor = actorEmail(req);
    if (!(await tcOdSync.isEnabled(office))) {
      return res.status(409).json({
        success: false,
        error: 'Open Dental sync is off for this office',
        code: 'OD_SYNC_OFF',
      });
    }
    if (engine.isRunning(office) || starting.has(office)) {
      return res.status(409).json({
        success: false,
        error: 'A sync of this office is already running',
        code: 'OD_SYNC_IN_PROGRESS',
      });
    }
    starting.add(office);
    let accepted = false;
    try {
      const lastManual = await tenantDb.withTenantDb(req, (pool) => engine.lastManualRun(pool, office));
      const next = nextAllowedAt(lastManual, Date.now());
      if (next) {
        const retryAfterSeconds = Math.max(1, Math.ceil((new Date(next).getTime() - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          success: false,
          error: `Sync now can run once every ${tcOdSync.manualCooldownMinutes()} minutes per office`,
          code: 'OD_SYNC_RATE_LIMITED',
          retryAfterSeconds,
          nextAllowedAt: next,
        });
      }

      const runId = require('node:crypto').randomUUID();
      // The person's request is on the trail before anything is read.
      await auditTc(req, 'CREATE', 'tc_od_sync_run', runId, { office });
      const sys = systemRequest(req);
      const done = tenantDb
        .withTenantDb(req, (pool) =>
          engine.syncOffice({
            office,
            pool,
            trigger: 'manual',
            requestedBy: actor,
            runId,
            audit: (entries) => auditMany(sys, entries),
          })
        )
        .catch((err) => {
          console.error(`[tc/od-sync] office=${office} run=${runId} errored: ${(err && err.message) || err}`);
          return { status: 'failed', runId, errorCode: 'RUN_ERRORED' };
        })
        .finally(() => {
          starting.delete(office);
          inflight.delete(runId);
        });
      inflight.set(runId, done);
      accepted = true;
      return res.status(202).json({ success: true, runId });
    } finally {
      if (!accepted) starting.delete(office);
    }
  })
);

// ── POST /cases/:caseId/undo ────────────────────────────────────────────────

const CaseId = z.string().uuid();

router.post(
  '/cases/:caseId/undo',
  h(async (req, res) => {
    const id = CaseId.safeParse(req.params.caseId);
    if (!id.success) return notFound(res, 'case');
    const office = req.tcOffice;
    const actor = actorEmail(req);
    const at = new Date().toISOString();
    // The undo's audit row is written inside its transaction, so a failed audit
    // write rolls the undo back rather than leaving it untrailed.
    const out = await tenantDb.withTenantDb(req, (pool) =>
      engine.undoChange(pool, {
        office,
        caseId: id.data,
        actor,
        at,
        audit: ({ priorState }) => auditTc(req, 'UPDATE', 'tc_case.od_sync_undo', id.data, { office, priorState }),
      })
    );
    if (!out.ok) {
      if (out.code === 'NOT_FOUND') return notFound(res, 'case');
      if (out.code === 'NOTHING_TO_UNDO') {
        return res.status(409).json({ success: false, error: 'Nothing on this case to undo', code: 'OD_SYNC_NOTHING_TO_UNDO' });
      }
      return res.status(409).json({
        success: false,
        error: 'This case has changed since the sync moved it, so the move cannot be undone here',
        code: 'OD_SYNC_UNDO_STALE',
      });
    }
    const aggregate = await tenantDb.withTenantDb(req, (pool) => store.loadCaseAggregate(pool, office, id.data));
    res.json({ success: true, undone: out.kind, case: aggregate });
  })
);

/** TESTS ONLY: wait for every sweep this router started. */
async function waitForRunsForTests() {
  await Promise.all([...inflight.values()]);
}

module.exports = router;
module.exports.waitForRunsForTests = waitForRunsForTests;
