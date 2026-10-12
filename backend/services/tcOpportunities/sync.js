'use strict';

/**
 * The nightly Opportunities sync for ONE office.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THROTTLE IS THE DESIGN CONSTRAINT
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental allows one request per second per credential, and that slot is
 * shared by every module on the credential. So:
 *
 *   - Every request goes through the office's OWN client
 *     (`odOffices.getOdOffice(office).client.apiGetRaw`) — the transport that
 *     owns the shared per-credential slot. There is no fetch, no axios, no
 *     second client in this file; `tcOpportunitiesSync.test.js` scans for one.
 *   - It holds that slot at `minIntervalMs` (1200 ms floor — RCM's D-8
 *     spacing), so a 02:30 batch can never over-drive the key.
 *   - It is sequential: one request in flight, ever.
 *
 * Cost of one pass (see docs/reports/feature-tc-od-opportunities.md):
 *   sweep  ceil(N_TP / 100) pages of GET /procedurelogs?ProcStatus=TP&Offset
 *   names  ≤ maxNameReads GET /patients/{PatNum}, only for rows with NO name
 *          snapshot yet, through services/odPatientCache.js
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A FULL SWEEP AND NOT A DateTStamp DELTA
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /procedurelogs` accepts `DateTStamp` ("on or after"), and every row
 * carries `serverDateTime`. A delta read of `ProcStatus=TP&DateTStamp=<w>`
 * returns procedures that are STILL treatment-planned and changed since w — it
 * can never return the ones that LEFT TP (completed, deleted, scheduled onto an
 * appointment), because they no longer match `ProcStatus=TP`. The inbox would
 * then keep offering treatment that was done last week. Only a complete sweep
 * proves absence. The sweep is ~1 request per 100 TP procedures, so it fits the
 * budget; the watermark (`serverDateTime` at the sweep) is still recorded so a
 * future incremental mode has a measured place to resume from.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED, PER OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 *   - A sweep that does not COMPLETE applies NOTHING to tc_opportunities. A
 *     patient's procedures can straddle pages, so a partial sweep would shrink
 *     values and "clear" rows that are merely on the unread pages. The attempt
 *     is recorded (`partial` / `failed` + reason); `last_synced_at` stays at the
 *     last sweep that worked, which is what the UI shows.
 *   - OD LIST FILTERS ARE SILENTLY IGNORED when unrecognised (proven on four
 *     other endpoints). Every row is re-verified client-side: ONE row whose
 *     ProcStatus is not 'TP' means the filter was ignored and this is a
 *     full-table scan — the sweep aborts (`FILTER_IGNORED`) instead of reading
 *     every procedure the practice ever recorded at one per second.
 *   - The office is re-asserted (`assertOfficeMatch`) on EVERY request, not
 *     just at the start, so nothing between the two can swap in another
 *     practice's client.
 *   - The name pass is the one progressive part: names already read are kept,
 *     the rest wait for the next night. A row without a name is shown as
 *     "name pending", never as a guessed name.
 *
 * NO AUDIT ROWS. Like the hygiene warm, nobody is looking at anything: this is
 * the application fetching on its own initiative at 02:30. The disclosure is
 * when a TC opens the inbox, and routes/tc/opportunities.js audits that.
 *
 * READ-ONLY toward Open Dental. `apiGetRaw` is the only client method used.
 */

const { randomUUID } = require('node:crypto');

const core = require('./core');
const store = require('./store');

/** OD pages /procedurelogs at 100 rows. */
const OD_PAGE_SIZE = 100;

/** @param {unknown} data @returns {any[]} */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(/** @type {any} */ (data).data)) return /** @type {any} */ (data).data;
  return [];
}

/**
 * `serverDateTime` from a page of rows — Open Dental stamps every row with the
 * server's clock at response time. Max seen, as a 'yyyy-MM-dd HH:mm:ss' string.
 * @param {any[]} rows
 * @param {string|null} current
 */
function maxServerDateTime(rows, current) {
  let best = current;
  for (const r of rows) {
    const s = r && typeof r.serverDateTime === 'string' ? r.serverDateTime : null;
    if (s && (!best || s > best)) best = s;
  }
  return best;
}

/**
 * Name / phone / status out of a raw /patients/{PatNum} record — the same
 * fields routes/tc/odReads.js normalizePatient reads, "Last, First".
 * @param {Record<string, unknown>} p
 */
function patientSnapshot(p) {
  const last = String(p.LName || '').trim();
  const first = String(p.FName || '').trim();
  const name = [last, first].filter(Boolean).join(', ');
  const phone = String(p.WirelessPhone || p.HmPhone || p.WkPhone || '').trim();
  return {
    name: name || null,
    phone: phone || null,
    status: p.PatStatus == null ? null : String(p.PatStatus),
  };
}

/**
 * @typedef {{
 *   office: string, status: 'ok'|'partial'|'failed', error: string|null,
 *   proceduresScanned: number, pages: number, patients: number|null,
 *   inserted: number, refreshed: number, touched: number, resurrected: number,
 *   cleared: number, existingCaseFlips: number, nameReads: number,
 *   namesPending: number|null, odRequests: number, durationMs: number,
 *   excluded: Record<string, number>, watermark: string|null
 * }} SyncOutcome
 */

/**
 * Run one office's pass.
 *
 * @param {{
 *   office: string,
 *   pool: { query: Function, connect: () => Promise<any> },
 *   odOffices: { getOdOffice: Function, assertOfficeMatch: Function },
 *   odPatientCache: { getPatient: Function },
 *   config: { minIntervalMs: () => number, maxPages: () => number, lookbackDays: () => number,
 *             budgetMs: () => number, maxNameReads: () => number, callTimeoutMs: () => number,
 *             timezone: () => string },
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {Promise<SyncOutcome>}
 */
async function syncOffice(deps) {
  const { office, pool, odOffices, odPatientCache, config } = deps;
  const clock = deps.now || Date.now;
  const startedAt = clock();
  const deadline = startedAt + config.budgetMs();

  /** @type {SyncOutcome} */
  const out = {
    office,
    status: 'failed',
    error: null,
    proceduresScanned: 0,
    pages: 0,
    patients: null,
    inserted: 0,
    refreshed: 0,
    touched: 0,
    resurrected: 0,
    cleared: 0,
    existingCaseFlips: 0,
    nameReads: 0,
    namesPending: null,
    odRequests: 0,
    durationMs: 0,
    excluded: { not_billable: 0, on_appointment: 0, too_old: 0, no_patient: 0 },
    watermark: null,
  };

  const finish = async () => {
    out.durationMs = clock() - startedAt;
    try {
      await store.recordSync(pool, office, {
        status: out.status,
        error: out.error,
        watermark: out.watermark,
        proceduresScanned: out.proceduresScanned,
        pages: out.pages,
        patients: out.patients,
        nameReads: out.nameReads,
        namesPending: out.namesPending,
        durationMs: out.durationMs,
      });
    } catch (err) {
      // The state row failing to write must not hide the pass's own outcome.
      out.error = `${out.error ? out.error + '; ' : ''}SYNC_STATE_WRITE_FAILED: ${(err && err.message) || err}`;
    }
    return out;
  };

  // ── Resolve the office's own client. Refused → nothing is read. ──────────
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    out.error = (err && err.code) || (err && err.message) || 'OFFICE_UNAVAILABLE';
    return finish();
  }

  /**
   * The ONLY way this file reaches Open Dental. Re-asserts the office on every
   * call, holds the shared slot at the sync's spacing, attributes the traffic.
   */
  const odGet = (path, params) => {
    odOffices.assertOfficeMatch(office, od);
    out.odRequests += 1;
    return od.client.apiGetRaw(path, params, {
      module: 'tc-opps',
      quiet: true,
      minIntervalMs: config.minIntervalMs(),
      timeoutMs: config.callTimeoutMs(),
    });
  };

  // ── 1. Sweep. ─────────────────────────────────────────────────────────────
  const cutoff = core.cutoffDate(config.lookbackDays(), new Date(clock()), config.timezone());
  /** @type {Array<{ patNum: number, procedure: import('./core').OpportunityProcedure }>} */
  const qualified = [];
  const seenProcNums = new Set();
  let complete = false;
  const maxPages = config.maxPages();

  for (let page = 0; page < maxPages; page += 1) {
    const res = await odGet('/procedurelogs', { ProcStatus: core.OD_TP_STATUS, Offset: page * OD_PAGE_SIZE });
    if (!res || !res.ok) {
      out.status = page === 0 ? 'failed' : 'partial';
      out.error = `OD_READ_FAILED: GET /procedurelogs page ${page + 1} → ${(res && res.status) || 0}`;
      return finish();
    }
    const rows = asArray(res.data);
    out.pages += 1;
    out.watermark = maxServerDateTime(rows, out.watermark);

    for (const row of rows) {
      const procNum = Number(row && row.ProcNum);
      if (seenProcNums.has(procNum)) continue;
      seenProcNums.add(procNum);
      out.proceduresScanned += 1;
      const q = core.qualifyProcedure(row, { cutoff });
      if (q.ok) {
        qualified.push({ patNum: q.patNum, procedure: q.procedure });
      } else if (q.reason === 'not_tp') {
        // The filter was ignored (or the build predates it). Continuing would
        // be a whole-practice scan at one request per second. Stop.
        out.status = 'failed';
        out.error =
          'FILTER_IGNORED: Open Dental returned a procedure that is not treatment-planned ' +
          'to a ProcStatus=TP read — refusing a full-table scan';
        return finish();
      } else {
        out.excluded[q.reason] = (out.excluded[q.reason] || 0) + 1;
      }
    }

    if (rows.length < OD_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    out.status = 'partial';
    out.error = `PAGE_CAP: stopped at ${maxPages} page(s) (${out.proceduresScanned} procedures) — nothing applied`;
    return finish();
  }

  // ── 2. Apply (complete sweep only), in one transaction. ───────────────────
  const candidates = core.groupByPatient(qualified);
  out.patients = candidates.size;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await store.listForOffice(client, office);
    const byPatient = new Map(existing.map((r) => [r.od_patient_id, r]));

    for (const row of existing) {
      const incoming = candidates.get(row.od_patient_id) || null;
      const plan = core.planRowChange(row, incoming);
      if (plan.op === 'refresh' && incoming) out.refreshed += await store.refreshOpen(client, office, row, incoming);
      else if (plan.op === 'touch') out.touched += await store.touch(client, office, row);
      else if (plan.op === 'resurrect' && incoming) out.resurrected += await store.resurrect(client, office, row, incoming);
      else if (plan.op === 'clear') out.cleared += await store.clear(client, office, row);
    }
    for (const [patNum, c] of candidates) {
      if (byPatient.has(patNum)) continue;
      await store.insertCandidate(client, office, c, randomUUID());
      out.inserted += 1;
    }
    out.existingCaseFlips = await store.reconcileExistingCases(client, office);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the original error is the one worth reporting */
    }
    out.status = 'failed';
    out.error = `APPLY_FAILED: ${(err && err.message) || err}`;
    client.release();
    return finish();
  }
  client.release();

  // ── 3. Names, progressively, through the shared patient cache. ────────────
  const rows = await store.listForOffice(pool, office);
  const needName = rows
    .filter(
      (r) =>
        r.patient_name == null &&
        r.cleared_at == null &&
        core.ACTIONABLE_STATUSES.includes(r.status)
    )
    .sort((a, b) => b.value_cents - a.value_cents);

  const cap = config.maxNameReads();
  let pendingAfter = needName.length;
  for (const r of needName) {
    if (out.nameReads >= cap || clock() >= deadline) break;
    const readOne = async (patNum) => {
      const res = await odGet(`/patients/${patNum}`, {});
      const record = res && res.ok ? (Array.isArray(res.data) ? res.data[0] : res.data) : null;
      return { ok: Boolean(res && res.ok && record), record: record || null };
    };
    const got = await odPatientCache.getPatient(office, r.od_patient_id, readOne);
    if (got.source === 'fetch') out.nameReads += 1;
    if (got.ok && got.record) {
      const snap = patientSnapshot(got.record);
      if (snap.name) {
        await store.setPatientSnapshot(pool, office, r.opportunity_id, snap);
        pendingAfter -= 1;
      }
    }
  }
  out.namesPending = pendingAfter;
  out.status = 'ok';
  return finish();
}

module.exports = { syncOffice, patientSnapshot, maxServerDateTime, OD_PAGE_SIZE };
