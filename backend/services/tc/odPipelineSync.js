'use strict';

/**
 * The Open Dental-driven pipeline sync (CO-4b). Beau's rulings, 2026-10-30:
 * READ-ONLY signals, UNAMBIGUOUS only, badge + undo + audit, per-office switch
 * default OFF.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT FOLLOWS
 * ═════════════════════════════════════════════════════════════════════════════
 * A case in `scheduled` whose Scheduled checkout carries a CO-4a anchor (the
 * AptNum the desk linked, tc_checkout_handoffs.appt_*). The office is the
 * case's own and the anchor's own — the same row, the same office_id — and the
 * appointment is read from THAT office's Open Dental through the office-checked
 * GET-only transport (routes/tc/checkoutAppointments.odGetForOffice). Nothing
 * here can name an office the database did not.
 *
 * ONE GET PER CASE: GET /appointments/{AptNum}. At most `maxPerRun()` per office
 * per run (default 200), least-recently-checked first so the cap rotates; every
 * request rides the shared Open Dental pacer at ≥ 1200 ms spacing and a timeout.
 * There is NO Open Dental write anywhere in this file, by construction: it never
 * touches a client, only the transport handed to it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SIGNAL MAP — decide(), pure
 * ═════════════════════════════════════════════════════════════════════════════
 *   AptStatus Complete                 → the case moves scheduled → completed
 *   AptStatus Broken / UnschedList     → the case moves scheduled → pending_pt
 *                                        ("Pending Patient", where the checkout's
 *                                        own "Not scheduled" puts a case). The
 *                                        anchor stays on the checkout as history.
 *   AptStatus Scheduled, new date/time → the anchor's time follows Open Dental,
 *                                        with a "rescheduled in Open Dental" note
 *                                        on the case. NO column move.
 *   AptStatus Scheduled, same time     → nothing (a stale flag is cleared).
 *   404 / gone, another patient's
 *   PatNum, any other status, or more
 *   than one appointment linked        → FLAG "Open Dental no longer matches —
 *                                        check". Nothing else is touched.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED, PER OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 * Every read for the office happens BEFORE any write. One read that FAILS (not a
 * 404 — that is an answer — but a timeout, a 5xx, an unreachable or unready
 * office) ends the office's run as `failed` and applies NOTHING: no move, no
 * flag, no note. A partial picture is never acted on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BADGE, UNDO, AND NO REDO
 * ═════════════════════════════════════════════════════════════════════════════
 * Each automatic change is stored on the case (od_sync_action) — the badge and
 * the Undo read it — and audited as its own event with the prior state. Undo
 * reverts the case (or the anchor's time) and records the Open Dental state it
 * reverted (od_sync_undone.fingerprint). The engine will not make that change
 * again while Open Dental still shows that same state; only a NEW state is a
 * new signal.
 *
 * SWITCH OFF ⇒ NOTHING. No read, no run row, no flag, no audit row.
 */

const { randomUUID } = require('node:crypto');

const tcOdSync = require('../../config/tcOdSync');
const odReads = require('../../routes/tc/odReads');
const caseStore = require('../../routes/tc/caseStore');
const nurtureHooks = require('../tcNurture/hooks');

/** Who the case timeline and the audit trail name for an automatic change. */
const SYNC_ACTOR = 'system:od_pipeline_sync';

/** The badge text, one definition. */
const BADGE = 'Moved by Open Dental sync';

/** Open Dental statuses that end a case's appointment unambiguously. */
const MOVE_FOR_STATUS = Object.freeze({
  Complete: { kind: 'completed', toStatus: 'completed' },
  Broken: { kind: 'unscheduled', toStatus: 'pending_pt' },
  UnschedList: { kind: 'unscheduled', toStatus: 'pending_pt' },
});

/** Offices with a run in flight in this process (single replica — see the Opportunities scheduler). */
const running = new Set();

/** jsonb from pg (object) or from the test store (maybe a string). */
function obj(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/** 'YYYY-MM-DD HH:MM' — the minute an appointment starts, as the office's wall clock reads it. */
function minuteOf(dateTime) {
  return String(dateTime || '').replace('T', ' ').slice(0, 16);
}

/** The Open Dental state a decision was made on. */
function fingerprintOf(aptNum, read) {
  if (read.missing) return `${aptNum}|missing`;
  return `${aptNum}|${read.appointment.aptStatus}|${minuteOf(read.appointment.dateTime)}`;
}

/**
 * The decision for one case. PURE: no I/O, so every mapping is tested alone.
 *
 * @param {{ undone: { fingerprint?: string }|null }} kase
 * @param {{ aptNum: number, patNum: number, atLocal: string }} anchor
 * @param {{ missing: true } | { missing: false, appointment: { aptNum: number, patNum: number|null, aptStatus: string, dateTime: string } }} read
 * @returns {{ kind: 'none'|'flag'|'completed'|'unscheduled'|'rescheduled'|'held', fingerprint: string,
 *             reason?: 'missing'|'status'|'patient', aptStatus?: string|null, toStatus?: string, toDateTime?: string }}
 */
function decide(kase, anchor, read) {
  const fingerprint = fingerprintOf(anchor.aptNum, read);
  if (read.missing) return { kind: 'flag', reason: 'missing', aptStatus: null, fingerprint };
  const a = read.appointment;
  // The anchor was the PATIENT's appointment. A different PatNum is never ours to act on.
  if (a.patNum !== anchor.patNum) return { kind: 'flag', reason: 'patient', aptStatus: a.aptStatus, fingerprint };

  let change = null;
  if (MOVE_FOR_STATUS[a.aptStatus]) {
    change = { ...MOVE_FOR_STATUS[a.aptStatus] };
  } else if (a.aptStatus === 'Scheduled') {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(minuteOf(a.dateTime))) {
      return { kind: 'flag', reason: 'status', aptStatus: a.aptStatus, fingerprint };
    }
    if (minuteOf(a.dateTime) === minuteOf(anchor.atLocal)) return { kind: 'none', fingerprint };
    change = { kind: 'rescheduled', toDateTime: a.dateTime.replace('T', ' ').slice(0, 19) };
  } else {
    return { kind: 'flag', reason: 'status', aptStatus: a.aptStatus, fingerprint };
  }

  // NO REDO: a person undid exactly this. Only a different Open Dental state acts again.
  if (kase.undone && kase.undone.fingerprint === fingerprint) return { kind: 'held', fingerprint };
  return { ...change, fingerprint };
}

/**
 * The office's Scheduled cases and their anchors. Two single-table reads (no
 * JOIN), named columns.
 *
 * @returns {Promise<{ tracked: Array<{ caseId: string, undone: object|null, flag: object|null,
 *            checkedAt: unknown, anchors: Array<{ handoffId: string, aptNum: number, aptNumRaw: unknown,
 *            patNum: number, atLocal: string }> }>, unanchored: number }>}
 */
async function loadScheduled(q, office) {
  const cases = await q.query(
    `SELECT case_id, od_sync_undone, od_sync_flag, od_sync_checked_at
       FROM tc_cases
      WHERE office_id = $1 AND status = 'scheduled'`,
    [office]
  );
  if (cases.rows.length === 0) return { tracked: [], unanchored: 0 };
  const ids = cases.rows.map((r) => r.case_id);
  const handoffs = await q.query(
    `SELECT handoff_id, case_id, od_patient_id, appt_num, appt_at_local
       FROM tc_checkout_handoffs
      WHERE office_id = $1 AND case_id = ANY($2) AND status = 'scheduled' AND appt_num IS NOT NULL`,
    [office, ids]
  );
  /** @type {Map<string, Array<object>>} */
  const byCase = new Map();
  for (const h of handoffs.rows) {
    const key = String(h.case_id);
    if (!byCase.has(key)) byCase.set(key, []);
    byCase.get(key).push({
      handoffId: String(h.handoff_id),
      aptNum: Number(h.appt_num),
      aptNumRaw: h.appt_num,
      patNum: Number(h.od_patient_id),
      atLocal: String(h.appt_at_local || ''),
    });
  }
  const tracked = [];
  let unanchored = 0;
  for (const r of cases.rows) {
    const anchors = byCase.get(String(r.case_id)) || [];
    if (anchors.length === 0) {
      unanchored += 1;
      continue;
    }
    tracked.push({
      caseId: String(r.case_id),
      undone: obj(r.od_sync_undone),
      flag: obj(r.od_sync_flag),
      checkedAt: r.od_sync_checked_at,
      anchors,
    });
  }
  // Least recently checked first (never-checked before all), so the cap rotates.
  const t = (v) => (v == null ? -Infinity : new Date(v).getTime());
  tracked.sort((a, b) => t(a.checkedAt) - t(b.checkedAt) || a.caseId.localeCompare(b.caseId));
  return { tracked, unanchored };
}

/** The count of Scheduled cases nobody linked an appointment to. */
async function countUnanchored(q, office) {
  return (await loadScheduled(q, office)).unanchored;
}

/** BEGIN/COMMIT on a dedicated client from the pool, ROLLBACK on any throw. */
async function inTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Thrown inside a transaction when the row moved under us; rolls the case back, counts as raced. */
class Raced extends Error {}

const STATUS_WORDS = { Complete: 'complete', Broken: 'broken', UnschedList: 'on the unscheduled list' };

/**
 * Apply one decided change to one case, in one transaction.
 * @returns {Promise<{ applied: boolean, audit: object[] }>}
 */
async function applyChange(pool, { office, runId, item, anchor, decision, read, at, audit }) {
  const action = {
    kind: decision.kind,
    at,
    runId,
    aptNum: anchor.aptNum,
    handoffId: anchor.handoffId,
    fromStatus: 'scheduled',
    toStatus: decision.kind === 'rescheduled' ? 'scheduled' : decision.toStatus,
    fromDateTime: anchor.atLocal,
    toDateTime: decision.kind === 'rescheduled' ? decision.toDateTime : anchor.atLocal,
    fingerprint: decision.fingerprint,
  };
  try {
    return await inTx(pool, async (client) => {
      // The read is minutes old by now (up to 200 reads at >= 1.2 s): act only if
      // the case still carries THAT appointment. A re-link or a cleared anchor
      // since the read is a race the person wins. Locked, so it cannot change
      // under us.
      const still = await client.query(
        `SELECT handoff_id FROM tc_checkout_handoffs
          WHERE office_id = $1 AND handoff_id = $2 AND status = 'scheduled' AND appt_num = $3 AND appt_at_local = $4
          FOR UPDATE`,
        [office, anchor.handoffId, anchor.aptNumRaw, anchor.atLocal]
      );
      if (still.rows.length !== 1) throw new Raced();
      if (decision.kind === 'rescheduled') {
        const moved = await client.query(
          `UPDATE tc_checkout_handoffs
              SET appt_at_local = $5, updated_at = now()
            WHERE office_id = $1 AND handoff_id = $2 AND appt_num = $3 AND appt_at_local = $4
            RETURNING handoff_id`,
          [office, anchor.handoffId, anchor.aptNumRaw, anchor.atLocal, decision.toDateTime]
        );
        if (moved.rows.length !== 1) throw new Raced();
        const kase = await client.query(
          `UPDATE tc_cases
              SET od_sync_action = $3, od_sync_flag = $4, od_sync_checked_at = $5, updated_at = now()
            WHERE office_id = $1 AND case_id = $2 AND status = 'scheduled'
            RETURNING case_id`,
          [office, item.caseId, JSON.stringify(action), null, at]
        );
        if (kase.rows.length !== 1) throw new Raced();
        await caseStore.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: item.caseId,
          office_id: office,
          ts: at,
          type: 'note_added',
          description: `Rescheduled in Open Dental: ${minuteOf(anchor.atLocal)} → ${minuteOf(decision.toDateTime)} (${BADGE.toLowerCase()})`,
          actor: SYNC_ACTOR,
          detail: null,
          legacy_id: null,
        });
      } else {
        const kase = await client.query(
          `UPDATE tc_cases
              SET status = $3, status_changed_at = $4, od_sync_action = $5, od_sync_flag = $6,
                  od_sync_checked_at = $4, updated_at = now()
            WHERE office_id = $1 AND case_id = $2 AND status = 'scheduled'
            RETURNING case_id`,
          [office, item.caseId, decision.toStatus, at, JSON.stringify(action), null]
        );
        if (kase.rows.length !== 1) throw new Raced();
        await caseStore.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: item.caseId,
          office_id: office,
          ts: at,
          type: 'status_change',
          // The funnel report parses `<from> → <to>`; keep that prefix exact.
          description: `scheduled → ${decision.toStatus}: Open Dental shows the appointment ${
            STATUS_WORDS[read.appointment.aptStatus] || read.appointment.aptStatus
          } (${BADGE.toLowerCase()})`,
          actor: SYNC_ACTOR,
          detail: null,
          legacy_id: null,
        });
        // Into a terminal status ⇒ a running nurture enrollment stops, as for a manual move.
        await nurtureHooks.stopForTerminalCase(client, {
          office,
          caseId: item.caseId,
          newStatus: decision.toStatus,
          actor: SYNC_ACTOR,
          now: new Date(at),
        });
      }
      // The change's own audit row, BEFORE the commit: an audit write that fails
      // rolls the change back, so no automatic change ever stands untrailed.
      await audit([
        withResult({
          action: 'UPDATE',
          resourceType: `tc_case.od_sync_${decision.kind}`,
          resourceId: item.caseId,
          office,
          sourceRef: `od_sync_run:${runId}`,
          priorState: 'scheduled',
        }),
      ]);
      return { applied: true };
    });
  } catch (err) {
    if (err instanceof Raced) return { applied: false };
    throw err;
  }
}

/**
 * Record a flag (or clear one) and the check time. Never moves the case.
 *
 * One transaction, locking the checkout first and the case second — the same
 * order as a move and as the checkout routes. The anchor is re-checked (AptNum
 * AND time) so a re-link, a cleared anchor or an Undo since the read makes the
 * read say nothing (`raced`). The undo hold is decided on the LOCKED case row,
 * never on the sweep's snapshot, and released only after a CLEAN read
 * (`release`): Open Dental showing the appointment fine, in a different state
 * from the one undone. A flag never releases it.
 *
 * @returns {Promise<{ newlyFlagged: boolean, raced: boolean }>}
 */
async function recordCheck(pool, { office, item, anchor, flag, at, fingerprint, release = false }) {
  return inTx(pool, async (client) => {
    if (anchor) {
      const still = await client.query(
        `SELECT handoff_id FROM tc_checkout_handoffs
          WHERE office_id = $1 AND handoff_id = $2 AND status = 'scheduled' AND appt_num = $3 AND appt_at_local = $4
          FOR UPDATE`,
        [office, anchor.handoffId, anchor.aptNumRaw, anchor.atLocal]
      );
      if (still.rows.length !== 1) return { newlyFlagged: false, raced: true };
    }
    const found = await client.query(
      `SELECT case_id, od_sync_flag, od_sync_undone FROM tc_cases
        WHERE office_id = $1 AND case_id = $2 AND status = 'scheduled'
        FOR UPDATE`,
      [office, item.caseId]
    );
    const row = found.rows[0];
    if (!row) return { newlyFlagged: false, raced: true };
    const undone = obj(row.od_sync_undone);
    const keep = undone && release && fingerprint && undone.fingerprint !== fingerprint ? null : undone;
    await client.query(
      `UPDATE tc_cases
          SET od_sync_flag = $3, od_sync_checked_at = $4, od_sync_undone = $5
        WHERE office_id = $1 AND case_id = $2`,
      [office, item.caseId, flag ? JSON.stringify(flag) : null, at, keep ? JSON.stringify(keep) : null]
    );
    const prior = obj(row.od_sync_flag);
    const was = prior && prior.reason ? prior.reason : null;
    return { newlyFlagged: !!flag && was !== flag.reason, raced: false };
  });
}

async function insertRun(pool, run) {
  await pool.query(
    `INSERT INTO tc_od_sync_runs (run_id, office_id, trigger, requested_by, started_at, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [run.runId, run.office, run.trigger, run.requestedBy, run.startedAt, 'running']
  );
}

async function finishRun(pool, { runId, office, status, summary, errorCode, at }) {
  await pool.query(
    `UPDATE tc_od_sync_runs
        SET status = $3, summary = $4, error_code = $5, finished_at = $6
      WHERE office_id = $1 AND run_id = $2`,
    [office, runId, status, summary ? JSON.stringify(summary) : null, errorCode, at]
  );
}

/** The most recent run for an office (any trigger), or null. */
async function lastRun(q, office) {
  const res = await q.query(
    `SELECT run_id, trigger, requested_by, started_at, finished_at, status, summary, error_code
       FROM tc_od_sync_runs
      WHERE office_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [office]
  );
  return res.rows[0] || null;
}

/** The most recent MANUAL run for an office, for the Sync now rate limit. */
async function lastManualRun(q, office) {
  const res = await q.query(
    `SELECT run_id, started_at
       FROM tc_od_sync_runs
      WHERE office_id = $1 AND trigger = 'manual'
      ORDER BY started_at DESC
      LIMIT 1`,
    [office]
  );
  return res.rows[0] || null;
}

/** Is a run for this office in flight in this process? */
function isRunning(office) {
  return running.has(office);
}

/**
 * Sweep ONE office. Never throws for an Open Dental problem (that is a `failed`
 * run); a database or audit failure propagates.
 *
 * @param {{
 *   office: string,
 *   pool: { query: Function, connect: Function },
 *   trigger: 'manual'|'nightly',
 *   requestedBy?: string|null,
 *   audit: (entries: object[]) => Promise<void>,
 *   odGet?: Function,                  the office's GET-only transport (resolved lazily when absent)
 *   resolveOdGet?: (office: string) => Function,
 *   sw?: { isEnabled: (office: string) => Promise<boolean> },
 *   clock?: () => Date,
 *   runId?: string,
 * }} opts
 * @returns {Promise<{ status: 'skipped'|'ok'|'failed', reason?: string, runId?: string, summary?: object, errorCode?: string }>}
 */
async function syncOffice(opts) {
  const { office, pool, trigger, audit } = opts;
  const sw = opts.sw || tcOdSync;
  const clock = opts.clock || (() => new Date());

  // SWITCH OFF ⇒ NOTHING: checked before any read or write.
  if (!(await sw.isEnabled(office))) return { status: 'skipped', reason: 'SWITCH_OFF' };
  if (running.has(office)) return { status: 'skipped', reason: 'ALREADY_RUNNING' };
  running.add(office);

  const runId = opts.runId || randomUUID();
  const startedAt = clock().toISOString();
  let inserted = false;
  try {
    await insertRun(pool, { runId, office, trigger, requestedBy: opts.requestedBy || null, startedAt });
    inserted = true;
    return await sweep();
  } catch (err) {
    // A database or audit failure ANYWHERE after the run row (the scheduled-case
    // read, the read-phase audit, a change): every change that committed
    // carried its audit row into its own transaction; the run says it failed
    // rather than sitting at 'running'.
    if (inserted) {
      await finishRun(pool, { runId, office, status: 'failed', summary: null, errorCode: 'RUN_ERRORED', at: clock().toISOString() }).catch(() => {});
    }
    throw err;
  } finally {
    running.delete(office);
  }

  async function sweep() {

    const { tracked, unanchored } = await loadScheduled(pool, office);
    const cap = tcOdSync.maxPerRun();
    const batch = tracked.slice(0, cap);
    const summary = {
      checked: 0,
      completed: 0,
      unscheduled: 0,
      rescheduled: 0,
      flagged: 0,
      unchanged: 0,
      heldByUndo: 0,
      raced: 0,
      unanchored,
      tracked: tracked.length,
      deferred: tracked.length - batch.length,
    };

    // ── PHASE 1: every read, before any write ────────────────────────────────
    const readAudit = [];
    /** @type {Array<{ item: object, anchor?: object, read?: object, multiple?: boolean }>} */
    const reads = [];
    let odFailure = null;
    let odGet = opts.odGet || null;
    for (const item of batch) {
      const distinct = [...new Set(item.anchors.map((a) => a.aptNum))];
      if (distinct.length > 1) {
        // More than one appointment linked to one case: which one decides is a guess.
        reads.push({ item, multiple: true });
        continue;
      }
      const anchor = item.anchors[0];
      try {
        if (!odGet) odGet = (opts.resolveOdGet || require('../../routes/tc/checkoutAppointments').odGetForOffice)(office);
        const read = await odReads.getAppointment(odGet, anchor.aptNum, {
          timeoutMs: tcOdSync.callTimeoutMs(),
          minIntervalMs: tcOdSync.minIntervalMs(),
        });
        readAudit.push({
          action: 'READ',
          resourceType: 'od_appointment',
          resourceId: String(anchor.aptNum),
          office,
          sourceRef: `tc_case:${item.caseId}`,
        });
        reads.push({ item, anchor, read });
      } catch (err) {
        odFailure = (err && (err.code || (err.odStatus !== undefined ? `OD_${err.odStatus}` : null))) || 'OD_UNAVAILABLE';
        break;
      }
    }
    // What was read is on the trail even when the run then fails.
    if (readAudit.length) await audit(readAudit.map(withResult));

    if (odFailure) {
      // FAIL CLOSED: nothing below runs. Logged with counts only.
      console.warn(`[tc/od-sync] office=${office} run=${runId} FAILED closed (${odFailure}); nothing applied`);
      await finishRun(pool, { runId, office, status: 'failed', summary: null, errorCode: 'OD_UNAVAILABLE', at: clock().toISOString() });
      return { status: 'failed', runId, errorCode: 'OD_UNAVAILABLE' };
    }

    // The switch is re-read before anything is applied: an office switched off
    // during the reads gets nothing written.
    if (!(await sw.isEnabled(office))) {
      console.warn(`[tc/od-sync] office=${office} run=${runId} switched off mid-run; nothing applied`);
      await finishRun(pool, { runId, office, status: 'failed', summary: null, errorCode: 'SWITCHED_OFF', at: clock().toISOString() });
      return { status: 'skipped', reason: 'SWITCH_OFF', runId };
    }

    // ── PHASE 2: decide and apply, each case with its own audit row ──────────
    {
      for (const r of reads) {
        const at = clock().toISOString();
        summary.checked += 1;
        if (r.multiple) {
          const flag = { reason: 'multiple', aptNum: null, aptStatus: null, at };
          const { newlyFlagged } = await recordCheck(pool, { office, item: r.item, flag, at });
          summary.flagged += 1;
          if (newlyFlagged) await audit([withResult(flagAudit(office, r.item, runId))]);
          continue;
        }
        const decision = decide(r.item, r.anchor, r.read);
        if (decision.kind === 'flag') {
          const flag = { reason: decision.reason, aptNum: r.anchor.aptNum, aptStatus: decision.aptStatus ?? null, at };
          const check = await recordCheck(pool, { office, item: r.item, anchor: r.anchor, flag, at, fingerprint: decision.fingerprint });
          if (check.raced) summary.raced += 1;
          else summary.flagged += 1;
          if (check.newlyFlagged) await audit([withResult(flagAudit(office, r.item, runId))]);
        } else if (decision.kind === 'none' || decision.kind === 'held') {
          const check = await recordCheck(pool, {
            office,
            item: r.item,
            anchor: r.anchor,
            flag: null,
            at,
            fingerprint: decision.fingerprint,
            release: decision.kind === 'none',
          });
          if (check.raced) summary.raced += 1;
          else if (decision.kind === 'held') summary.heldByUndo += 1;
          else summary.unchanged += 1;
        } else {
          const out = await applyChange(pool, { office, runId, item: r.item, anchor: r.anchor, decision, read: r.read, at, audit });
          if (out.applied) summary[decision.kind] += 1;
          else summary.raced += 1;
        }
      }
    }

    await finishRun(pool, { runId, office, status: 'ok', summary, errorCode: null, at: clock().toISOString() });
    console.log(
      `[tc/od-sync] office=${office} run=${runId} trigger=${trigger} checked=${summary.checked} ` +
        `completed=${summary.completed} unscheduled=${summary.unscheduled} rescheduled=${summary.rescheduled} ` +
        `flagged=${summary.flagged} held=${summary.heldByUndo} unanchored=${summary.unanchored} deferred=${summary.deferred}`
    );
    return { status: 'ok', runId, summary };
  }
}

/** Every row the engine writes records a completed act. */
function withResult(entry) {
  return { result: 'SUCCESS', ...entry };
}

function flagAudit(office, item, runId) {
  return {
    action: 'UPDATE',
    resourceType: 'tc_case.od_sync_flagged',
    resourceId: item.caseId,
    office,
    sourceRef: `od_sync_run:${runId}`,
    priorState: item.flag && item.flag.reason ? `flagged:${item.flag.reason}` : 'unflagged',
  };
}

/**
 * Undo the last automatic change on a case, as a person. Reverts the case (or
 * the anchor's time), clears the badge, and stores the Open Dental state that
 * was reverted so the engine does not redo it. Refused when the case has moved
 * since (a human decision since the sync's is not the sync's to take back).
 *
 * @returns {Promise<{ ok: true, kind: string, priorState: string } | { ok: false, code: 'NOT_FOUND'|'NOTHING_TO_UNDO'|'UNDO_STALE' }>}
 */
async function undoChange(pool, { office, caseId, actor, at, audit }) {
  try {
    return await inTx(pool, async (client) => {
      // Lock order, as everywhere else: the checkout, then the case. The first
      // read only learns WHICH checkout; the locked re-read is what is acted on.
      const peek = await client.query(
        `SELECT case_id, od_sync_action FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
        [office, caseId]
      );
      if (!peek.rows[0]) return { ok: false, code: 'NOT_FOUND' };
      const peeked = obj(peek.rows[0].od_sync_action);
      if (peeked && peeked.handoffId) {
        await client.query(
          `SELECT handoff_id FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2 FOR UPDATE`,
          [office, peeked.handoffId]
        );
      }
      const found = await client.query(
        `SELECT case_id, status, od_sync_action FROM tc_cases WHERE office_id = $1 AND case_id = $2 FOR UPDATE`,
        [office, caseId]
      );
      const row = found.rows[0];
      if (!row) return { ok: false, code: 'NOT_FOUND' };
      const action = obj(row.od_sync_action);
      if (action && peeked && action.runId !== peeked.runId) return { ok: false, code: 'UNDO_STALE' };
      if (!action || !action.kind) return { ok: false, code: 'NOTHING_TO_UNDO' };
      if (row.status !== action.toStatus) return { ok: false, code: 'UNDO_STALE' };
      const undone = JSON.stringify({ kind: action.kind, fingerprint: action.fingerprint, at, by: actor });

      if (action.kind === 'rescheduled') {
        const back = await client.query(
          `UPDATE tc_checkout_handoffs
              SET appt_at_local = $4, updated_at = now()
            WHERE office_id = $1 AND handoff_id = $2 AND appt_at_local = $3
            RETURNING handoff_id`,
          [office, action.handoffId, action.toDateTime, action.fromDateTime]
        );
        if (back.rows.length !== 1) throw new Raced();
        const kase = await client.query(
          `UPDATE tc_cases
              SET od_sync_action = $3, od_sync_undone = $4, updated_at = now()
            WHERE office_id = $1 AND case_id = $2 AND status = 'scheduled'
            RETURNING case_id`,
          [office, caseId, null, undone]
        );
        if (kase.rows.length !== 1) throw new Raced();
        await caseStore.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: caseId,
          office_id: office,
          ts: at,
          type: 'note_added',
          description: `Undid the Open Dental sync's reschedule: the appointment shows ${minuteOf(action.fromDateTime)} again`,
          actor,
          detail: null,
          legacy_id: null,
        });
        // Audited BEFORE the commit: a failed audit write rolls the undo back.
        if (audit) await audit({ priorState: 'rescheduled' });
        return { ok: true, kind: action.kind, priorState: 'rescheduled' };
      }

      const kase = await client.query(
        `UPDATE tc_cases
            SET status = $3, status_changed_at = $4, od_sync_action = $5, od_sync_undone = $6, updated_at = now()
          WHERE office_id = $1 AND case_id = $2 AND status = $7
          RETURNING case_id`,
        [office, caseId, action.fromStatus, at, null, undone, action.toStatus]
      );
      if (kase.rows.length !== 1) throw new Raced();
      await caseStore.insertEventRow(client, {
        event_id: randomUUID(),
        case_id: caseId,
        office_id: office,
        ts: at,
        type: 'status_change',
        description: `${action.toStatus} → ${action.fromStatus}: undid an Open Dental sync move${
          action.kind === 'completed' ? ' (a nurture enrollment the move stopped stays stopped)' : ''
        }`,
        actor,
        detail: null,
        legacy_id: null,
      });
      if (audit) await audit({ priorState: action.toStatus });
      return { ok: true, kind: action.kind, priorState: action.toStatus };
    });
  } catch (err) {
    if (err instanceof Raced) return { ok: false, code: 'UNDO_STALE' };
    throw err;
  }
}

/**
 * The cases the Pipeline's sync panel lists: standing automatic changes (with
 * their Undo) and open flags. One office, named columns, no JOIN.
 */
async function listForPanel(q, office) {
  const acted = await q.query(
    `SELECT case_id, patient_name, status, od_sync_action
       FROM tc_cases
      WHERE office_id = $1 AND od_sync_action IS NOT NULL`,
    [office]
  );
  const open = await q.query(
    `SELECT case_id, patient_name, status, od_sync_flag
       FROM tc_cases
      WHERE office_id = $1 AND status = 'scheduled' AND od_sync_flag IS NOT NULL`,
    [office]
  );
  const changes = [];
  const flagged = [];
  for (const r of acted.rows) {
    const action = obj(r.od_sync_action);
    // A badge stands only while the case is where the sync put it.
    if (action && action.kind && r.status === action.toStatus) {
      changes.push({ caseId: String(r.case_id), patientName: r.patient_name, status: r.status, action: publicAction(action) });
    }
  }
  for (const r of open.rows) {
    const flag = obj(r.od_sync_flag);
    if (flag && flag.reason) {
      flagged.push({ caseId: String(r.case_id), patientName: r.patient_name, status: r.status, flag: publicFlag(flag) });
    }
  }
  changes.sort((a, b) => String(b.action.at).localeCompare(String(a.action.at)));
  return { changes: changes.slice(0, 50), flagged: flagged.slice(0, 50) };
}

/** What a client may see of a stored action (no fingerprint, no run internals). */
function publicAction(a) {
  return {
    kind: a.kind,
    at: a.at,
    aptNum: Number(a.aptNum),
    fromStatus: a.fromStatus,
    toStatus: a.toStatus,
    fromDateTime: a.fromDateTime,
    toDateTime: a.toDateTime,
  };
}

function publicFlag(f) {
  return { reason: f.reason, at: f.at, aptStatus: f.aptStatus ?? null };
}

/** The card's state from a case row's two columns (the case list adds it to each summary). */
function cardState(status, rawAction, rawFlag) {
  const action = obj(rawAction);
  const flag = obj(rawFlag);
  const standing = action && action.kind && status === action.toStatus ? publicAction(action) : null;
  const open = flag && flag.reason && status === 'scheduled' ? publicFlag(flag) : null;
  return standing || open ? { action: standing, flag: open } : null;
}

module.exports = {
  SYNC_ACTOR,
  BADGE,
  decide,
  fingerprintOf,
  minuteOf,
  loadScheduled,
  countUnanchored,
  syncOffice,
  undoChange,
  listForPanel,
  cardState,
  lastRun,
  lastManualRun,
  isRunning,
};
