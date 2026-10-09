#!/usr/bin/env node
'use strict';

/**
 * MEASURE what the Opportunities sync (item 41) builds on. READ ONLY — the
 * only client method in this file is apiGetRaw, and it prints COUNTS and FIELD
 * NAMES only: never a name, a PatNum, a fee, or any row value.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ NOT YET RUN. It is committed so the unknowns in
 *    docs/reports/feature-tc-od-opportunities.md §1 can be turned from
 *    DOCUMENTED/ASSUMED into MEASURED before the sync is switched on.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * What it answers, per office:
 *   Q1  ProcStatus=TP page 0: status, row count (the page size), field names,
 *       every ProcStatus value seen (all 'TP' ⇒ the filter is honoured), how
 *       many rows carry serverDateTime, AptNum > 0, an OD null DateTP.
 *   Q2  ProcStatus=C page 0: are all rows 'C'? (a DIFFERENT value gives a
 *       DIFFERENT answer — the only proof a filter is not silently ignored)
 *   Q3  Offset=100 vs Offset=0: ProcNum overlap (0 ⇒ Offset pages)
 *   Q4  DateTStamp=<page-0 serverDateTime minus 1 day>: row count vs page 0 and
 *       whether every row's DateTStamp is ≥ the value (⇒ the filter works)
 *   Q5  (only with TC_OPPS_PROBE_COUNT=1) walk EVERY ProcStatus=TP page through
 *       the sync's own spacing, and report N, pages, distinct patients, how
 *       many qualify, and the elapsed time — the real budget numbers.
 *
 * HOW TO RUN (from the backend folder, or inside the container at /app):
 *   env TC_OPPS_PROBE_OFFICE=roland node scripts/probe-tc-opportunities.js
 *   env TC_OPPS_PROBE_OFFICE=roland TC_OPPS_PROBE_COUNT=1 node scripts/probe-tc-opportunities.js
 * Q5 costs one request per 100 TP procedures at 1.2 s each; run it off-hours.
 * `TC_OPPS_PROBE_APP_ROOT` lets the file run from outside the image tree.
 */

const path = require('node:path');

const APP_ROOT = process.env.TC_OPPS_PROBE_APP_ROOT || path.join(__dirname, '..');
const odOffices = require(path.join(APP_ROOT, 'config/odOffices'));
const { loadSecrets } = require(path.join(APP_ROOT, 'config/secrets'));
const tcOppsConfig = require(path.join(APP_ROOT, 'config/tcOpportunities'));
const core = require(path.join(APP_ROOT, 'services/tcOpportunities/core'));

/** Every key seen across the rows. @param {any[]} rows */
function keysSeen(rows) {
  const keys = new Set();
  for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) keys.add(k);
  return [...keys].sort().join(', ') || '(none)';
}

/** @param {any} data @returns {any[]} */
function rowsOf(data) {
  return Array.isArray(data) ? data : [];
}

/** Count of each distinct value of a field. @param {any[]} rows @param {string} field */
function tally(rows, field) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of rows) {
    const k = String(r && r[field]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 'yyyy-MM-dd HH:mm:ss' minus one day (string arithmetic on OD's own clock). */
function minusOneDay(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(stamp || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}:${p(d.getUTCSeconds())}`;
}

async function main({ env = process.env, log = console.log } = {}) {
  const office = String(env.TC_OPPS_PROBE_OFFICE || '').trim();
  if (!Object.prototype.hasOwnProperty.call(odOffices.OFFICE_OD_SETTINGS, office)) {
    console.error(`Refusing to run: TC_OPPS_PROBE_OFFICE must be one of ${Object.keys(odOffices.OFFICE_OD_SETTINGS).join(', ')}`);
    process.exit(2);
  }

  // Standalone scripts never get secrets unless they ask (server.js does it
  // for the app). Without this every office reads OFFICE_OD_KEY_MISSING.
  await loadSecrets();
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const get = (p, params) =>
    od.client.apiGetRaw(p, params, {
      module: 'tc-opps-probe',
      minIntervalMs: tcOppsConfig.minIntervalMs(),
      timeoutMs: 30000,
    });

  // Q1
  const tp0 = await get('/procedurelogs', { ProcStatus: 'TP', Offset: 0 });
  const tpRows = rowsOf(tp0.data);
  log(`\nQ1 GET /procedurelogs?ProcStatus=TP&Offset=0 ok=${tp0.ok} status=${tp0.status} rows=${tpRows.length}`);
  if (!tp0.ok) log(`   error=${JSON.stringify(tp0.error || null)}`);
  log(`   keys=[${keysSeen(tpRows)}]`);
  log(`   ProcStatus values=${JSON.stringify(tally(tpRows, 'ProcStatus'))}`);
  log(`   with serverDateTime=${tpRows.filter((r) => typeof r.serverDateTime === 'string').length}`);
  log(`   AptNum>0=${tpRows.filter((r) => Number(r.AptNum) > 0).length}  PlannedAptNum>0=${tpRows.filter((r) => Number(r.PlannedAptNum) > 0).length}`);
  log(`   DateTP null-date=${tpRows.filter((r) => core.odDate(r.DateTP) === null).length}`);
  log(`   typeof ProcFee=${JSON.stringify(tally(tpRows.map((r) => ({ t: typeof r.ProcFee })), 't'))}`);

  // Q2
  const c0 = await get('/procedurelogs', { ProcStatus: 'C', Offset: 0 });
  log(`\nQ2 GET /procedurelogs?ProcStatus=C&Offset=0 ok=${c0.ok} status=${c0.status} rows=${rowsOf(c0.data).length}`);
  log(`   ProcStatus values=${JSON.stringify(tally(rowsOf(c0.data), 'ProcStatus'))}`);

  // Q3
  const tp1 = await get('/procedurelogs', { ProcStatus: 'TP', Offset: 100 });
  const ids0 = new Set(tpRows.map((r) => Number(r.ProcNum)));
  const rows1 = rowsOf(tp1.data);
  log(`\nQ3 GET /procedurelogs?ProcStatus=TP&Offset=100 ok=${tp1.ok} status=${tp1.status} rows=${rows1.length}`);
  log(`   ProcNum overlap with Offset=0: ${rows1.filter((r) => ids0.has(Number(r.ProcNum))).length}`);

  // Q4
  const stamp = tpRows.map((r) => r.serverDateTime).find((s) => typeof s === 'string');
  const since = minusOneDay(stamp);
  if (since) {
    const ts = await get('/procedurelogs', { ProcStatus: 'TP', DateTStamp: since, Offset: 0 });
    const tsRows = rowsOf(ts.data);
    log(`\nQ4 GET /procedurelogs?ProcStatus=TP&DateTStamp=<serverDateTime-1d> ok=${ts.ok} status=${ts.status} rows=${tsRows.length}`);
    log(`   every DateTStamp >= value: ${tsRows.every((r) => String(r.DateTStamp || '') >= since)}`);
    log(`   ProcStatus values=${JSON.stringify(tally(tsRows, 'ProcStatus'))}`);
  } else {
    log('\nQ4 skipped: no serverDateTime on page 0');
  }

  // Q5
  if (String(env.TC_OPPS_PROBE_COUNT || '').trim() === '1') {
    const started = Date.now();
    const cutoff = core.cutoffDate(tcOppsConfig.lookbackDays(), new Date(), tcOppsConfig.timezone());
    const seen = new Set();
    const patients = new Set();
    const qualifiedPatients = new Set();
    /** @type {Record<string, number>} */
    const reasons = {};
    let pages = 0;
    let qualified = 0;
    let stopped = null;
    for (let page = 0; page < tcOppsConfig.maxPages(); page += 1) {
      const res = await get('/procedurelogs', { ProcStatus: 'TP', Offset: page * 100 });
      if (!res.ok) {
        stopped = `page ${page + 1} → ${res.status}`;
        break;
      }
      const rows = rowsOf(res.data);
      pages += 1;
      for (const r of rows) {
        if (seen.has(Number(r.ProcNum))) continue;
        seen.add(Number(r.ProcNum));
        patients.add(Number(r.PatNum));
        const q = core.qualifyProcedure(r, { cutoff });
        if (q.ok) {
          qualified += 1;
          qualifiedPatients.add(q.patNum);
        } else reasons[q.reason] = (reasons[q.reason] || 0) + 1;
      }
      if (rows.length < 100) break;
      if (page === tcOppsConfig.maxPages() - 1) stopped = 'PAGE_CAP';
    }
    const ms = Date.now() - started;
    log(`\nQ5 full TP sweep: N=${seen.size} pages=${pages} ms=${ms} stopped=${stopped || 'no (complete)'}`);
    log(`   distinct patients=${patients.size} qualifying procedures=${qualified} qualifying patients=${qualifiedPatients.size}`);
    log(`   excluded=${JSON.stringify(reasons)} (lookback cutoff ${cutoff})`);
    log(`   names a FIRST night would need: ${qualifiedPatients.size} → at ${tcOppsConfig.minIntervalMs()} ms ≈ ${Math.round((qualifiedPatients.size * tcOppsConfig.minIntervalMs()) / 60000)} min (capped at ${tcOppsConfig.maxNameReads()} per night)`);
  }
}

// Guarded, so requiring this file reaches Open Dental for nothing.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, keysSeen, tally, minusOneDay };
