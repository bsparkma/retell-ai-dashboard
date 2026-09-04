#!/usr/bin/env node
'use strict';

/**
 * What one hygiene Day View load costs — cold, warm, and after a morning warm.
 *
 *     node backend/scripts/measure-hyg-day-cost.js [--patients 40] [--spacing 1000]
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
 * The CODE under measurement is the shipped code: services/hyg/odDay.js
 * readDay, services/odPatientCache.js, services/hygDayWarm.js's fan-out. What
 * is simulated is the NETWORK — a transport that answers instantly, behind a
 * gate that enforces Open Dental's documented **one request per second per
 * credential** (docs/RCM_OD_WRITES.md; the same spacing config/openDental.js
 * applies for real via OD_SLOTS).
 *
 * That is the honest shape of this measurement, and it is the right one: the
 * throttle is deterministic and documented, the variable under test is HOW MANY
 * REQUESTS the code issues, and simulating the one while measuring the other
 * gives a number nobody has to take on faith. `--spacing 0` reports pure
 * request counts with no clock at all.
 *
 * ── WHY THIS IS NOT A STAGING RUN ────────────────────────────────────────────
 * It cannot be one yet. `/api/hyg/*` is behind `requireModule('hyg')` and no
 * tenant is entitled; every office's `hygOdEnabled` is a hardcoded `false` in
 * config/odOffices.js with no environment override. So on staging today the
 * endpoint answers 403, and after entitlement it answers 409 OFFICE_NOT_READY.
 * A staging before/after needs this branch deployed AND both switches flipped —
 * see docs/HYG_MODULE.md §7.
 *
 * NO NETWORK, NO CREDENTIALS, NO PHI. Every PatNum below is synthetic.
 */

const odDay = require('../services/hyg/odDay');
const odPatientCache = require('../services/odPatientCache');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const PATIENTS = arg('patients', 40);
const SPACING_MS = arg('spacing', 1000);
const DATE = '2026-09-08';
const OFFICE = 'roland';

/** Synthetic PatNums, far outside any real range. */
const PAT_NUMS = Array.from({ length: PATIENTS }, (_, i) => 900000 + i);

/**
 * A transport that spaces every request the way the shared per-credential slot
 * does. One queue, because the slot is one queue — which is exactly why raising
 * a caller's concurrency buys nothing.
 */
function makeOdGet() {
  let reservedAt = 0;
  const counts = { list: 0, patient: 0 };

  const odGet = async (path) => {
    if (SPACING_MS > 0) {
      const now = Date.now();
      const wait = Math.max(0, reservedAt - now);
      reservedAt = Math.max(now, reservedAt) + SPACING_MS;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    if (path.startsWith('/patients/')) {
      counts.patient += 1;
      const patNum = Number(path.slice('/patients/'.length));
      return {
        ok: true,
        status: 200,
        data: { PatNum: patNum, LName: 'Synthetic', FName: 'Patient', Premed: false, MedUrgNote: '' },
      };
    }

    counts.list += 1;
    if (path === '/appointments') {
      return {
        ok: true,
        status: 200,
        data: PAT_NUMS.map((patNum, i) => ({
          AptNum: 900000 + i,
          PatNum: patNum,
          AptStatus: 'Scheduled',
          Pattern: 'XXXXXXXXXXXX',
          Op: 2,
          ProvHyg: 7,
          AptDateTime: DATE + ' 08:00:00',
        })),
      };
    }
    if (path === '/operatories') {
      return { ok: true, status: 200, data: [{ OperatoryNum: 2, OpName: 'Hygiene 1', ItemOrder: 1 }] };
    }
    if (path === '/appointmenttypes') {
      return { ok: true, status: 200, data: [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }] };
    }
    if (path === '/providers') return { ok: true, status: 200, data: [{ ProvNum: 7, Abbr: 'HYG1' }] };
    return { ok: false, status: 404, data: null, error: 'unscripted' };
  };

  return { odGet, counts };
}

function line(label, stats, wallMs) {
  const requests = stats.odListReads + stats.odPatientReads;
  console.log(
    label.padEnd(34) +
      String(requests).padStart(4) + ' OD requests  ' +
      ('(' + stats.odListReads + ' list, ' + stats.odPatientReads + ' patient)').padEnd(26) +
      String(stats.patientCacheHits).padStart(3) + ' cache hits  ' +
      (wallMs / 1000).toFixed(1).padStart(6) + 's'
  );
}

async function main() {
  console.log(
    `\nOne hygiene Day View load — ${PATIENTS} distinct patients, ` +
      `${SPACING_MS}ms per request (Open Dental's documented 1 req/s per credential)\n`
  );

  // ── 1. COLD. What ships on develop today. ─────────────────────────────────
  odPatientCache.resetOdPatientCache();
  let t = makeOdGet();
  let startedAt = Date.now();
  let day = await odDay.readDay(t.odGet, { date: DATE, office: OFFICE });
  line('BEFORE  cold, no cache', day.stats, Date.now() - startedAt);

  // ── 2. The same day again, seconds later. A refresh, a back navigation. ───
  t = makeOdGet();
  startedAt = Date.now();
  day = await odDay.readDay(t.odGet, { date: DATE, office: OFFICE });
  line('AFTER   second load, warm cache', day.stats, Date.now() - startedAt);

  // ── 3. The 8am first load, after the 7:45 warm. The one that matters. ─────
  odPatientCache.resetOdPatientCache();
  t = makeOdGet();
  startedAt = Date.now();
  // The warm's fan-out, through the same function the Day View uses.
  await odDay.readPatients(t.odGet, PAT_NUMS, { office: OFFICE });
  const warmMs = Date.now() - startedAt;

  t = makeOdGet();
  startedAt = Date.now();
  day = await odDay.readDay(t.odGet, { date: DATE, office: OFFICE });
  line('AFTER   first load, pre-warmed', day.stats, Date.now() - startedAt);

  console.log(
    `\n        the warm itself: ${PAT_NUMS.length} patient reads in ${(warmMs / 1000).toFixed(1)}s, ` +
      'at 7:45am against an idle credential, with nobody waiting.\n'
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
