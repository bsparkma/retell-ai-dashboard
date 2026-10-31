'use strict';

/**
 * Checkout cards from TODAY'S SCHEDULE (CO-5b). Beau's rulings, 2026-10-30:
 * non-hygiene appointments only, cards start in Waiting, a per-office switch
 * that defaults OFF (Roland pilots).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT ONE SWEEP DOES, FOR ONE OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. Switch check. `tc_checkout_enabled` AND `tc_auto_checkout_enabled` must
 *      both be on for the office, or the sweep reads nothing and writes nothing.
 *   2. ONE read of the office's appointments today (hyg's odDay.readAppointments,
 *      paged), through the office's own GET-only transport, paced at ≥ 1200 ms.
 *   3. Keep each appointment that is
 *        (a) Complete in Open Dental,
 *        (b) NOT a hygiene appointment — hyg's own rule, the APPOINTMENT's
 *            IsHygiene, never the chair's. Unknown counts as hygiene and is
 *            SKIPPED: the hygiene app owns that lane, and a double card is
 *            worse than a wait,
 *        (c) a real patient — PatNum > 0 (a blockout or an unattached row
 *            carries none), and
 *        (d) not already carded: no card was ever made from this AptNum (any
 *            status — a dismissed card is not re-made), and the patient holds
 *            no card today (any source, any status but dismissed / expired:
 *            CO-5a's rule).
 *   4. Name the first `maxCreatePerSweep` (default 100) of those, through the
 *      shared patient cache and the same paced transport. An appointment whose
 *      patient could not be named waits for the next sweep, at the back.
 *   5. Make each card in its own transaction, under CO-5a's patient-day lock,
 *      re-checking (d) inside it: source 'schedule', status open (Waiting), the
 *      empty snapshot (no hygiene data — the workup says so), the appointment
 *      kept in origin_apt_num / origin_appt. ONE CREATE audit row per card,
 *      `source_ref` `apt_num:<AptNum>`, written inside the transaction so a
 *      failed audit write leaves no card behind. The actor is the system.
 *
 * A LATER hygiene handoff for the same patient and day merges onto the card by
 * the existing rule (routes/tc/hygiene.js, checkoutStore.MERGEABLE_SOURCES).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHEN IT RUNS — no nightly
 * ═════════════════════════════════════════════════════════════════════════════
 * `ensureFresh` runs a sweep when the office's last one is older than the cache
 * window (default 60 s), and never two at once per office. The Checkout page
 * asks while it is open (on focus, on becoming visible, and every 60 s while
 * visible — the day-progress pattern), and the Pipeline's "Sync now" forces one.
 * So the Open Dental cost is at most one schedule read per office per window,
 * however many pages are open.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HONEST STATE
 * ═════════════════════════════════════════════════════════════════════════════
 * Each office's last attempt, last SUCCESS and the counts are kept here, in
 * process. A failed read is `failed` until a read succeeds — the page says
 * "Couldn't check today's schedule" with the last-success time, never a silent
 * stale list. A process that has not finished a read since it started says
 * `pending`, not `ok`.
 *
 * ZERO Open Dental writes: the only transport is apiGetRaw (GET).
 */

const { randomUUID } = require('node:crypto');

const tcCheckout = require('../../config/tcCheckout');
const tcAutoCheckout = require('../../config/tcAutoCheckout');
const checkoutStore = require('../../routes/tc/checkoutStore');
const odDay = require('../hyg/odDay');
const contract = require('../../tc/contract.gen.cjs');

/** The actor on a card the sweep made, and on its audit row. */
const SYSTEM_ACTOR = 'system:auto_checkout';

/**
 * @typedef {{
 *   completedNonHygiene: number, created: number, alreadyCarded: number,
 *   skippedHygiene: number, skippedNoPatient: number, deferred: number, partial: boolean
 * }} SweepSummary
 */

/**
 * Per-office state, in process.
 * @type {Map<string, { lastAttemptAt: string|null, lastAttemptMs: number, lastSuccessAt: string|null,
 *                      failed: boolean, summary: SweepSummary|null, running: Promise<unknown>|null,
 *                      deferredAptNums: Set<number> }>}
 */
const offices = new Map();

/** The clock the cache window is measured on, swappable in tests. */
let clockMs = () => Date.now();

function stateOf(office) {
  if (!offices.has(office)) {
    offices.set(office, {
      lastAttemptAt: null,
      lastAttemptMs: 0,
      lastSuccessAt: null,
      failed: false,
      summary: null,
      running: null,
      deferredAptNums: new Set(),
    });
  }
  return offices.get(office);
}

/** Both switches: checkout itself, and cards from the schedule. */
async function isOn(office) {
  return (await tcCheckout.isEnabled(office)) && (await tcAutoCheckout.isEnabled(office));
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
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[tc/auto-checkout] rollback failed:', rollbackErr && rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** A trimmed string, or ''. */
function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The appointments a sweep could card, from one schedule read. Pure.
 *
 * @param {Array<Record<string, unknown>>} rows  Open Dental's appointments for `today`
 * @param {string} today  'YYYY-MM-DD'
 */
function classify(rows, today) {
  /** @type {Array<{ aptNum: number, patNum: number, row: Record<string, unknown> }>} */
  const candidates = [];
  let skippedHygiene = 0;
  let skippedNoPatient = 0;
  const seen = new Set();
  for (const r of rows) {
    if (text(r.AptStatus) !== 'Complete') continue;
    // Today only, whatever the list endpoint chose to return.
    if (!text(r.AptDateTime).startsWith(today)) continue;
    // hyg's rule (services/hyg/odDay.js readDay): the APPOINTMENT's IsHygiene,
    // never the chair's. `!== false` is hygiene — unknown included.
    if (odDay.odBool(r.IsHygiene) !== false) {
      skippedHygiene += 1;
      continue;
    }
    const aptNum = odDay.odInt(r.AptNum);
    const patNum = odDay.odInt(r.PatNum);
    // PatNum 0 is Open Dental's "nobody is attached to this row".
    if (aptNum === null || aptNum <= 0 || patNum === null || patNum <= 0) {
      skippedNoPatient += 1;
      continue;
    }
    if (seen.has(aptNum)) continue;
    seen.add(aptNum);
    candidates.push({ aptNum, patNum, row: r });
  }
  candidates.sort((a, b) => text(a.row.AptDateTime).localeCompare(text(b.row.AptDateTime)) || a.aptNum - b.aptNum);
  return { candidates, skippedHygiene, skippedNoPatient };
}

/** Labels from the hour-cached practice lists; an unreadable list is an empty map. */
async function labelsFor(odGet, office) {
  const [types, provs, ops] = await Promise.all([
    odDay.readAppointmentTypeLabels(odGet, { office }).catch(() => ({ byNum: new Map() })),
    odDay.readProviderLabels(odGet, { office }).catch(() => ({ byNum: new Map() })),
    odDay.readOperatories(odGet, { office }).catch(() => ({ operatories: [] })),
  ]);
  return {
    typeName: types.byNum || new Map(),
    provName: provs.byNum || new Map(),
    opName: new Map((ops.operatories || []).map((o) => [o.opNum, o.name || o.abbrev || ''])),
  };
}

/**
 * Sweep one office once. Returns the summary, or `{ status: 'off' }` having
 * touched nothing.
 *
 * @param {{
 *   office: string,
 *   today: string,                       the office's today, 'YYYY-MM-DD'
 *   pool: { query: Function, connect: Function },   the tenant database
 *   odGet?: Function,                    the office's GET-only transport (resolved lazily)
 *   resolveOdGet?: (office: string) => Function,
 *   audit: (entry: object) => Promise<void>,  writes one audit row as the system
 * }} opts
 * @returns {Promise<{ status: 'off' } | { status: 'ok', summary: SweepSummary }>}
 * @throws when the schedule read fails outright (nothing was made)
 */
async function sweepOffice(opts) {
  const { office, today, pool, audit } = opts;
  if (!(await isOn(office))) return { status: 'off' };
  const st = stateOf(office);

  const transport = opts.odGet || (opts.resolveOdGet || require('../../routes/tc/checkoutAppointments').odGetForOffice)(office);
  // Every request this sweep makes holds the shared slot at the batch spacing.
  const odGet = (p, params, o) =>
    transport(p, params, {
      ...(o || {}),
      timeoutMs: tcAutoCheckout.callTimeoutMs(),
      minIntervalMs: tcAutoCheckout.minIntervalMs(),
    });

  const appts = await odDay.readAppointments(odGet, today);
  if (appts.error && appts.rows.length === 0) {
    const err = new Error(`schedule read failed: ${appts.error}`);
    err.code = 'SCHEDULE_READ_FAILED';
    throw err;
  }
  const partial = Boolean(appts.error) || appts.truncated;

  const { candidates, skippedHygiene, skippedNoPatient } = classify(appts.rows, today);
  /** @type {SweepSummary} */
  const summary = {
    completedNonHygiene: candidates.length,
    created: 0,
    alreadyCarded: 0,
    skippedHygiene,
    skippedNoPatient,
    deferred: 0,
    partial,
  };

  // (d), cheaply, before Open Dental is asked for a single name.
  const carded = await checkoutStore.findOriginAptNums(pool, office, candidates.map((c) => c.aptNum));
  const holding = await checkoutStore.findHoldingPatientsOnDay(
    pool,
    office,
    [...new Set(candidates.map((c) => c.patNum))],
    today
  );
  const open = candidates.filter((c) => !carded.has(c.aptNum) && !holding.has(c.patNum));
  summary.alreadyCarded = candidates.length - open.length;

  // ROTATION: an appointment whose patient could not be named last time goes
  // to the back, so one unreadable chart cannot hold the front of the queue.
  const ordered = [
    ...open.filter((c) => !st.deferredAptNums.has(c.aptNum)),
    ...open.filter((c) => st.deferredAptNums.has(c.aptNum)),
  ];
  // One card per patient per sweep: a second same-day appointment finds the
  // first card held, the rule (d) would apply on the next sweep anyway.
  const onePerPatient = [];
  const patients = new Set();
  for (const c of ordered) {
    if (patients.has(c.patNum)) {
      summary.alreadyCarded += 1;
      continue;
    }
    patients.add(c.patNum);
    onePerPatient.push(c);
  }
  const cap = tcAutoCheckout.maxCreatePerSweep();
  const batch = onePerPatient.slice(0, cap);
  summary.deferred = onePerPatient.length - batch.length;
  if (batch.length === 0) {
    st.deferredAptNums = new Set();
    return { status: 'ok', summary };
  }

  const names = await odDay.readPatients(odGet, batch.map((c) => c.patNum), { office, odBudget: cap });
  const labels = await labelsFor(odGet, office);
  const nextDeferred = new Set();

  for (const c of batch) {
    const patient = names.byPatNum.get(c.patNum);
    const patientName = patient && typeof patient.displayName === 'string' ? patient.displayName.trim() : '';
    if (!patientName) {
      // Not named — never a card that says "Unknown". It waits, at the back.
      nextDeferred.add(c.aptNum);
      summary.deferred += 1;
      continue;
    }
    const typeNum = odDay.odInt(c.row.AppointmentTypeNum);
    const provNum = odDay.odInt(c.row.ProvNum);
    const opNum = odDay.odInt(c.row.Op);
    const origin = {
      aptNum: c.aptNum,
      dateTime: text(c.row.AptDateTime),
      appointmentType: ((typeNum !== null && labels.typeName.get(typeNum)) || text(c.row.ProcDescript)).slice(0, 200),
      provider: ((provNum !== null && labels.provName.get(provNum)) || '').slice(0, 200),
      operatory: opNum === null ? '' : (labels.opName.get(opNum) || `Op ${opNum}`).slice(0, 200),
      aptStatus: 'Complete',
    };

    let made = false;
    try {
      made = await inTx(pool, async (client) => {
        await checkoutStore.lockPatientDay(client, office, c.patNum, today);
        // (d) again, under the lock: a click, a hygiene handoff or another
        // sweep may have carded this patient since the cheap check above.
        const already = await checkoutStore.findOriginAptNums(client, office, [c.aptNum]);
        if (already.size > 0) return false;
        if (await checkoutStore.findHoldingForPatientDay(client, office, c.patNum, today)) return false;
        const handoffId = randomUUID();
        await checkoutStore.insertHandoff(client, {
          handoff_id: handoffId,
          office_id: office,
          source_key: `schedule:${c.aptNum}`,
          od_patient_id: c.patNum,
          patient_name: patientName,
          provider: '',
          provider_seen: origin.provider,
          operatory: origin.operatory,
          visit_date: today,
          payload: contract.emptyCheckoutSnapshot(),
          is_final: false,
          revision: 1,
          submitted_by: SYSTEM_ACTOR,
          updated_by: SYSTEM_ACTOR,
          status: 'open',
          source: 'schedule',
          origin_apt_num: c.aptNum,
          origin_appt: origin,
        });
        // Inside the transaction: a failed audit write rolls the card back.
        await audit({
          action: 'CREATE',
          resourceType: 'tc_checkout_handoff',
          resourceId: handoffId,
          result: 'SUCCESS',
          office,
          sourceRef: `apt_num:${c.aptNum}`,
        });
        return true;
      });
    } catch (err) {
      // Another sweep (or a racing click) won the unique index: theirs stands.
      if (!err || err.code !== checkoutStore.PG_UNIQUE_VIOLATION) throw err;
      made = false;
    }
    if (made) summary.created += 1;
    else summary.alreadyCarded += 1;
  }
  st.deferredAptNums = nextDeferred;
  return { status: 'ok', summary };
}

/**
 * Run a sweep for the office when its last one is older than the cache window
 * (or `force`), unless one is already running — then that one is returned.
 * Records the outcome as the office's state. Never throws.
 *
 * @param {string} office
 * @param {() => Promise<{ status: 'off' } | { status: 'ok', summary: SweepSummary }>} run
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<unknown>|null}  the sweep in flight, or null when the state is fresh
 */
function ensureFresh(office, run, { force = false } = {}) {
  const now = clockMs;
  const st = stateOf(office);
  if (st.running) return st.running;
  const ttlMs = tcAutoCheckout.cacheTtlSeconds() * 1000;
  if (!force && st.lastAttemptMs > 0 && now() - st.lastAttemptMs < ttlMs) return null;
  st.running = (async () => {
    try {
      const out = await run();
      if (out.status === 'off') return out;
      st.failed = false;
      st.summary = out.summary;
      st.lastSuccessAt = new Date(now()).toISOString();
      return out;
    } catch (err) {
      st.failed = true;
      console.error(
        `[tc/auto-checkout] office=${office} schedule sweep failed: ${(err && (err.code || err.name)) || 'error'} ${(err && err.message) || ''}`.trim()
      );
      return { status: 'failed' };
    } finally {
      st.lastAttemptMs = now();
      st.lastAttemptAt = new Date(st.lastAttemptMs).toISOString();
      st.running = null;
    }
  })();
  return st.running;
}

/**
 * The office's state for the Checkout page. Pure read of the in-process state.
 * @param {string} office
 * @param {boolean} enabled
 */
function statusOf(office, enabled) {
  const st = stateOf(office);
  return {
    status: !enabled ? 'off' : st.failed ? 'failed' : st.lastSuccessAt ? 'ok' : 'pending',
    running: st.running !== null,
    lastSuccessAt: st.lastSuccessAt,
    lastAttemptAt: st.lastAttemptAt,
    summary: enabled ? st.summary : null,
  };
}

/** TESTS ONLY: forget every office's state (waits for nothing), and restore the clock. */
function resetForTests() {
  offices.clear();
  clockMs = () => Date.now();
}

/** TESTS ONLY: the clock the cache window is measured on (null restores it). */
function setNowForTests(fn) {
  clockMs = fn || (() => Date.now());
}

/** TESTS ONLY: wait for every sweep in flight. */
async function waitForSweepsForTests() {
  await Promise.all([...offices.values()].map((s) => s.running).filter(Boolean));
}

module.exports = {
  SYSTEM_ACTOR,
  isOn,
  classify,
  sweepOffice,
  ensureFresh,
  statusOf,
  resetForTests,
  setNowForTests,
  waitForSweepsForTests,
};
