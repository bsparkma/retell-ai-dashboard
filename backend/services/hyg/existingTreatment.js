'use strict';

/**
 * EXISTING TREATMENT (hygiene Slice 2a) — the Open Dental read.
 *
 * The patient's treatment-planned procedures, for the office and PatNum on the
 * STORED visit. GET only: like routes/tc/odReads.js, every function here takes
 * `odGet(path, params, opts)` and there is no write path to reach for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SAME READ TC MAKES
 * ═════════════════════════════════════════════════════════════════════════════
 * The procedure rows come from `odReads.getTpProcedureRows` — the TC reader's
 * own `/procedurelogs?PatNum&ProcStatus=TP` sweep, extracted unchanged — so the
 * hygiene screen and the TC COB panel cannot disagree about what is planned.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO REQUESTS AT MOST, AND A SHORT CACHE
 * ═════════════════════════════════════════════════════════════════════════════
 * One procedure read, plus ONE `/appointments?PatNum&AptStatus=Scheduled` read
 * only when some procedure is attached to an appointment — "Already scheduled"
 * is claimed only for an appointment Open Dental says is Scheduled, never from
 * `AptNum > 0` alone (that can be a broken or unscheduled-list appointment).
 * Both go through the office's own client, which applies the shared OD pacer.
 *
 * A successful read is cached for at most ten minutes, keyed (office, visit,
 * PatNum), so every chip tap's server-side check does not cost the practice an
 * Open Dental round trip. A failure is NEVER cached: the next Retry asks again.
 * Retry with `refresh` skips the cache.
 */

const odReads = require('../../routes/tc/odReads');
const contract = require('../../hyg/contract.gen.cjs');

/** Same per-call timeout as the day read (services/hyg/odDay.js). */
const OD_CALL_TIMEOUT_MS = Number(process.env.HYG_OD_CALL_TIMEOUT_MS || 30000);

/** Ten minutes is the ceiling; an env value above it is clamped down to it. */
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

function ttlMs() {
  const raw = Number(process.env.HYG_EXISTING_TX_CACHE_TTL_MS);
  if (!Number.isFinite(raw) || raw < 0) return MAX_TTL_MS;
  return Math.min(raw, MAX_TTL_MS);
}

/**
 * Successful reads only. An expired entry is simply overwritten by the next
 * successful read; at the size cap the whole map is cleared (500 visits inside
 * ten minutes is far past a practice's day). There is deliberately no
 * `.delete(` call in this file: hygNoOdWrites.test.js treats any write-shaped
 * call on a non-router receiver as a possible Open Dental write, and that scan
 * stays strict rather than learning an exemption for a Map.
 *
 * @type {Map<string, { at: number, value: { items: object[], readAt: string } }>}
 */
const cache = new Map();
/**
 * The read in flight per key, so a page open and a chip tap on a cold cache —
 * or a double Retry — cost one Open Dental read, not two. Overwritten with
 * null when it settles (no `.delete(`, as above).
 * @type {Map<string, Promise<{ items: object[], readAt: string }> | null>}
 */
const inFlight = new Map();

function keyOf(office, visitId, patNum) {
  return `${office}|${visitId}|${patNum}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Open Dental's priority NAME, trimmed, or null. The DefNum alone is never read as a name. */
function priorityNameOf(row) {
  const name = row.priority;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One raw procedurelog row → the contract's ExistingTxItem fields (without the
 * disposition and last-discussed, which come from CareIN's own tables).
 * Returns null for a row with no usable ProcNum. No fee is carried.
 */
function normalizeProc(row, scheduledAptNums) {
  const procNum = num(row.ProcNum);
  if (!Number.isSafeInteger(procNum) || procNum <= 0) return null;
  const aptNum = num(row.AptNum);
  const priorityName = priorityNameOf(row);
  return {
    procNum,
    code: String(row.procCode || row.ProcCode || '').toUpperCase(),
    description: String(row.descript || row.Descript || ''),
    tooth: String(row.ToothNum ?? '').trim() || String(row.ToothRange ?? '').trim(),
    surface: String(row.Surf || ''),
    dateTp: odReads.odDate(row.DateTP) || null,
    priorityName,
    watch: contract.isWatchPriority(priorityName),
    scheduled: aptNum > 0 && scheduledAptNums.has(aptNum),
  };
}

/** Newest planned date first; an unknown date last; ties by ProcNum, newest first. */
function byNewest(a, b) {
  if (a.dateTp !== b.dateTp) {
    if (a.dateTp === null) return 1;
    if (b.dateTp === null) return -1;
    return a.dateTp < b.dateTp ? 1 : -1;
  }
  return b.procNum - a.procNum;
}

/**
 * The AptNums of this patient's appointments Open Dental reports as Scheduled.
 * Same capability-miss fallback getNextAppointment uses.
 * @returns {Promise<Set<number>>}
 */
async function scheduledAptNumsFor(odGet, patNum) {
  const opts = { timeoutMs: OD_CALL_TIMEOUT_MS };
  let res = await odGet('/appointments', { PatNum: patNum, AptStatus: 'Scheduled' }, opts);
  if (!res.ok && odReads.isCapabilityMiss(res)) {
    res = await odGet('/appointments', { PatNum: patNum }, opts);
  }
  if (!res.ok) {
    const err = new Error(`Failed to fetch appointments (${res.status})`);
    err.odStatus = res.status;
    throw err;
  }
  const out = new Set();
  for (const a of odReads.asArray(res.data)) {
    // Checked even when OD filtered: a row is Scheduled because it SAYS so.
    const status = String(a.AptStatus || '');
    if (status !== 'Scheduled' && status !== '1') continue;
    const n = num(a.AptNum);
    if (n > 0) out.add(n);
  }
  return out;
}

/**
 * Read the patient's treatment-planned procedures from Open Dental. Uncached.
 * Throws on any Open Dental failure — an empty list is only ever "none".
 *
 * @param {(path: string, params: object, opts: object) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {{ patNum: number }} args
 */
async function readExistingTreatment(odGet, { patNum }) {
  const tp = await odReads.getTpProcedureRows(odGet, patNum);
  const attached = tp.rows.some((r) => num(r.AptNum) > 0);
  const scheduled = attached ? await scheduledAptNumsFor(odGet, patNum) : new Set();
  const items = tp.rows
    .map((r) => normalizeProc(r, scheduled))
    .filter((i) => i !== null)
    .sort(byNewest);
  return { items, readAt: new Date().toISOString() };
}

/**
 * The cached read for one visit. `refresh` skips the cache (the Retry button).
 * Resolves `{ items, readAt, cached }`; rejects on an Open Dental failure, and a
 * failure is never cached.
 */
async function loadExistingTreatment(odGet, { office, visitId, patNum, refresh = false }) {
  const key = keyOf(office, visitId, patNum);
  const ttl = ttlMs();
  if (!refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return { ...hit.value, cached: true };
  }

  // A read already in flight is as fresh as a new one, so even a Retry joins it.
  let pending = inFlight.get(key) || null;
  if (pending === null) {
    if (inFlight.size >= MAX_ENTRIES && !inFlight.has(key)) inFlight.clear();
    const started = readExistingTreatment(odGet, { patNum }).then(
      (value) => {
        if (inFlight.get(key) === started) inFlight.set(key, null);
        if (ttl > 0) {
          if (cache.size >= MAX_ENTRIES && !cache.has(key)) cache.clear();
          cache.set(key, { at: Date.now(), value });
        }
        return value;
      },
      (err) => {
        if (inFlight.get(key) === started) inFlight.set(key, null);
        throw err;
      }
    );
    inFlight.set(key, started);
    pending = started;
  }
  const value = await pending;
  return { ...value, cached: false };
}

/** Tests only: every boot starts cold. */
function resetExistingTreatmentCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  readExistingTreatment,
  loadExistingTreatment,
  resetExistingTreatmentCache,
  normalizeProc,
  MAX_TTL_MS,
};
