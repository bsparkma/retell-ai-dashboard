#!/usr/bin/env node
'use strict';

/**
 * validate-benefits-formula.js — ONE-patient, read-only check of the two
 * "benefits used" formulas the benefits-remaining probe compares, against
 * Open Dental's own Tx Plan insurance panel (Ins Used / Pending / Remain).
 *
 * The patient is a REAL roland patient designated by the practice owner. So:
 *   - the PatNum arrives at RUNTIME only (VALIDATE_PATNUM), never in code,
 *     a commit, a fixture, or a file; this script never prints it;
 *   - the patient's name is never fetched (getInsuranceSnapshot reads
 *     patplans / inssubs / insplans / carriers / benefits / claimprocs only);
 *   - output goes to the CONSOLE ONLY — nothing is written to disk;
 *   - GETs only, office-scoped to roland via getOdOffice/assertOfficeMatch,
 *     ≥ 1.2 s spacing, and the probe's run-window guard (no 01:55–04:00 CT,
 *     pause :13–:17).
 *
 * Figure A — current code: Received|Supplemental InsPayAmt, DateCP ≥ year start.
 * Figure B — OD panel hypothesis: the same paid rows by ProcDate, + Adjustment
 *            InsPayAmt (together "used"), + sent-unpaid NotReceived InsPayEst
 *            ("pending").  Remaining = annual max − figure.
 *
 * Usage (staging container):
 *   VALIDATE_PATNUM=<n> PROBE_APP_ROOT=/app node /tmp/validate-benefits-formula.js
 */

const path = require('node:path');
const { usageBases, endpointKey, ctClock, windowVerdict } = require('./probe-benefits-remaining');

const OFFICE = 'roland';
const MIN_INTERVAL_MS = 1200;

function parsePatNum(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,12}$/.test(s) || Number(s) <= 0) return null;
  return Number(s);
}

function usd(v) {
  return v == null || !Number.isFinite(v) ? 'n/a' : `$${v.toFixed(2)}`;
}

async function guardWindow(log, clock = ctClock) {
  for (;;) {
    const v = windowVerdict(clock());
    if (v === 'go') return;
    if (v === 'abort') throw new Error('Refusing to run inside the 01:55–04:00 CT window');
    log('pausing for the :13–:17 voice-sync window');
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/**
 * The figures for each plan the patient has. Never carries the PatNum, a
 * name, or a carrier name — only dollar figures and the year basis.
 */
function figuresFor(snap, claimprocs) {
  return snap.plans.map((plan) => {
    const start = plan.usage ? plan.usage.benefitYearStart : null;
    const mine = claimprocs.filter(
      (cp) => Number(cp.InsSubNum) === plan.insSubNum || Number(cp.PlanNum) === plan.planNum
    );
    const u = start ? usageBases(mine, start) : null;
    const figA = u ? u.paidDateCP : null;
    const usedB = u ? u.paidProcDate + u.adjustment : null;
    const pendingB = u ? u.pending : null;
    const figB = u ? usedB + pendingB : null;
    const max = plan.annualMax;
    return {
      ordinal: plan.ordinal,
      yearBasis: plan.usage ? `${plan.usage.basis} (from ${start})` : 'unavailable',
      annualMax: max,
      deductible: plan.deductible,
      figA,
      usedB,
      pendingB,
      figB,
      remainA: max != null && figA != null ? Math.max(0, max - figA) : null,
      remainB: max != null && figB != null ? Math.max(0, max - figB) : null,
    };
  });
}

function printFigures(rows, log) {
  if (rows.length === 0) {
    log('No insurance plans on file for this patient — nothing to compare.');
    return;
  }
  for (const r of rows) {
    log(`\n── plan ${r.ordinal === 1 ? 'primary' : r.ordinal === 2 ? 'secondary' : `#${r.ordinal}`} ── ${r.yearBasis}`);
    log(`  annual max ............................ ${usd(r.annualMax)}`);
    log(`  deductible ............................ ${usd(r.deductible)}`);
    log(`  figure A  (paid, by payment date) ..... ${usd(r.figA)}`);
    log(`  figure B  (paid+pending, by proc date)  ${usd(r.figB)}`);
    log(`     of which used (compare "Ins Used")   ${usd(r.usedB)}`);
    log(`     of which pending (compare "Pending") ${usd(r.pendingB)}`);
    log(`  remaining under A ..................... ${usd(r.remainA)}`);
    log(`  remaining under B (compare "Remain") .. ${usd(r.remainB)}`);
  }
}

async function main({ env = process.env, log = console.log } = {}) {
  const patNum = parsePatNum(env.VALIDATE_PATNUM);
  if (patNum == null) throw new Error('Refusing to run: VALIDATE_PATNUM must be a positive integer');
  await guardWindow(log);

  // Required here, not at the top: requiring this file must load no OD config.
  const APP_ROOT = env.PROBE_APP_ROOT || path.join(__dirname, '..');
  const odOffices = require(path.join(APP_ROOT, 'config/odOffices'));
  const { loadSecrets } = require(path.join(APP_ROOT, 'config/secrets'));
  const odReads = require(path.join(APP_ROOT, 'routes/tc/odReads'));
  await loadSecrets();

  const od = odOffices.assertOfficeMatch(OFFICE, odOffices.getOdOffice(OFFICE));
  const calls = [];
  const claimprocs = [];
  const get = async (p, params = {}, opts = {}) => {
    await guardWindow(log);
    const res = await od.client.apiGetRaw(p, params, {
      timeoutMs: opts.timeoutMs || 30000,
      module: 'benefits-validate',
      minIntervalMs: MIN_INTERVAL_MS,
      quiet: true,
    });
    const ep = endpointKey(p);
    calls.push(`${ep} ${res.status}`);
    if (res.ok && ep === '/claimprocs') {
      const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
      claimprocs.push(...rows);
    }
    return res;
  };

  const snap = await odReads.getInsuranceSnapshot(get, patNum);
  log(`[${OFFICE}] ${calls.length} GETs: ${calls.join(', ')}`);
  if (!snap.ytdAvailable) log('Claim history unreadable — figures A/B unavailable.');
  printFigures(figuresFor(snap, claimprocs), log);
}

if (require.main === module) {
  main().catch((err) => {
    // The message, never the stack: a stack can carry request params.
    console.error(String((err && (err.odStatus || err.message)) || err).slice(0, 200));
    process.exit(1);
  });
}

module.exports = { main, parsePatNum, figuresFor };
