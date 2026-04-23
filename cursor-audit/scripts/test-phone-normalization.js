#!/usr/bin/env node
/**
 * test-phone-normalization.js
 *
 * Confirms or refutes LK-02 in cursor-audit/11-evidence-and-confidence.md:
 *   "Phone numbers from Retell (e.g. '+15551234567') will not match patients in
 *    Open Dental whose phone is stored with formatting (e.g. '(555) 123-4567')."
 *
 * Why this script exists:
 *   - Code review (backend/config/openDental.js:918-962) shows the DB path uses
 *     `WHERE HmPhone LIKE '%<digits-only-query>%'`. If HmPhone contains
 *     formatting characters, that LIKE will not match.
 *   - That alone is enough to call this Likely. This script promotes it to
 *     CONFIRMED or REFUTED with evidence from the actual production data.
 *
 * What it does (READ-ONLY):
 *   1. Connects to the Open Dental MySQL database using OPEN_DENTAL_DATABASE_URL.
 *   2. Samples up to N active patients with non-null phones.
 *   3. For each patient, pulls HmPhone and WkPhone as actually stored.
 *   4. Normalizes each phone to digits-only.
 *   5. Re-runs the *exact* DB search the dashboard would run, with the digits-only string.
 *   6. Reports per-patient PASS / FAIL and an overall hit-rate.
 *
 *   Also tries 5 common Retell-style input formats against one sample patient,
 *   so you can see which formats the search code does and does not handle.
 *
 * It does NOT write anything to the OD database.
 *
 *   - Output: cursor-audit/scripts/results/test-phone-normalization-<ts>.json
 */

const fs = require('fs');
const path = require('path');

// Reuse the backend's own config — no duplication of pool setup.
process.chdir(path.resolve(__dirname, '..', '..', 'backend'));
require('dotenv').config();

const mysql = require('mysql2/promise');
const { URL } = require('url');

// -- Config ------------------------------------------------------------------

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 25);
const RESULTS_DIR = path.resolve(__dirname, 'results');
const DATABASE_URL =
  process.env.OPEN_DENTAL_DATABASE_URL ||
  process.env.OPENDENTAL_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'FATAL: no DATABASE URL found. Set OPEN_DENTAL_DATABASE_URL in backend/.env',
  );
  process.exit(2);
}

// -- Helpers -----------------------------------------------------------------

function digitsOnly(s) {
  return (s || '').toString().replace(/\D/g, '');
}

function buildPool(url) {
  const u = new URL(url);
  return mysql.createPool({
    host: u.hostname,
    port: u.port || 3306,
    user: u.username,
    password: u.password,
    database: u.pathname.slice(1),
    connectionLimit: 2,
    waitForConnections: true,
    connectTimeout: 10_000,
  });
}

/**
 * Replicates the LIKE search the dashboard runs (openDental.js:939-950).
 * Returns true if the patient is found, false otherwise.
 */
async function dashboardLikeSearchFinds(pool, queryString, expectedPatNum) {
  const term = `%${queryString}%`;
  const sql = `
    SELECT PatNum
    FROM patient
    WHERE (
      CONCAT(FName, ' ', LName) LIKE ?
      OR CONCAT(LName, ', ', FName) LIKE ?
      OR Preferred LIKE ?
      OR HmPhone LIKE ?
      OR WkPhone LIKE ?
      OR Email LIKE ?
    )
    AND PatStatus = 0
    LIMIT 50
  `;
  const params = [term, term, term, term, term, term];
  const [rows] = await pool.execute(sql, params);
  return rows.some((r) => r.PatNum === expectedPatNum);
}

// -- Main --------------------------------------------------------------------

(async () => {
  console.log('=== LK-02 phone-normalization verification ===');
  console.log(`Database: ${new URL(DATABASE_URL).hostname}`);
  console.log(`Sample size: ${SAMPLE_SIZE}`);
  console.log('');

  const pool = buildPool(DATABASE_URL);
  const results = {
    startedAt: new Date().toISOString(),
    sampleSize: SAMPLE_SIZE,
    patients: [],
    formatProbe: null,
    summary: null,
  };

  try {
    const [sample] = await pool.execute(
      `SELECT PatNum, FName, LName, HmPhone, WkPhone
       FROM patient
       WHERE PatStatus = 0
         AND (HmPhone IS NOT NULL AND HmPhone <> ''
              OR WkPhone IS NOT NULL AND WkPhone <> '')
       ORDER BY RAND()
       LIMIT ?`,
      [SAMPLE_SIZE],
    );

    if (sample.length === 0) {
      console.error('No patients with phones found. Cannot test.');
      process.exit(2);
    }

    let hits = 0;

    for (const p of sample) {
      const phone = p.HmPhone || p.WkPhone;
      const digits = digitsOnly(phone);
      if (digits.length < 10) continue;

      const found = await dashboardLikeSearchFinds(pool, digits, p.PatNum);
      if (found) hits++;

      results.patients.push({
        PatNum: p.PatNum,
        storedHmPhone: p.HmPhone,
        storedWkPhone: p.WkPhone,
        digitsOnlyQuery: digits,
        dashboardSearchHit: found,
      });

      const flag = found ? 'HIT ' : 'MISS';
      console.log(
        `  [${flag}] PatNum=${p.PatNum}  stored="${phone}"  query="${digits}"`,
      );
    }

    const total = results.patients.length;
    const hitRate = total ? (hits / total) * 100 : 0;

    console.log('');
    console.log(`Hit rate: ${hits}/${total}  (${hitRate.toFixed(1)}%)`);

    // -- Format probe on one patient --
    const sample0 = results.patients.find((r) => r.dashboardSearchHit);
    if (sample0) {
      const formats = [
        sample0.digitsOnlyQuery, // 5551234567
        sample0.digitsOnlyQuery.replace(
          /(\d{3})(\d{3})(\d{4})/,
          '($1) $2-$3',
        ), // (555) 123-4567
        sample0.digitsOnlyQuery.replace(
          /(\d{3})(\d{3})(\d{4})/,
          '$1-$2-$3',
        ), // 555-123-4567
        sample0.digitsOnlyQuery.replace(
          /(\d{3})(\d{3})(\d{4})/,
          '$1.$2.$3',
        ), // 555.123.4567
        '+1' + sample0.digitsOnlyQuery, // +15551234567
      ];

      const probe = [];
      for (const f of formats) {
        const found = await dashboardLikeSearchFinds(pool, f, sample0.PatNum);
        probe.push({ inputFormat: f, found });
        console.log(`  format-probe "${f}"  →  ${found ? 'HIT' : 'MISS'}`);
      }
      results.formatProbe = { PatNum: sample0.PatNum, attempts: probe };
    }

    // -- Verdict --
    let result;
    if (hitRate >= 95) {
      result = {
        status: 'REFUTED',
        message:
          'Digits-only search matches stored phones for ≥95% of patients. ' +
          'The DB path appears tolerant (likely because phones are stored unformatted).',
      };
    } else if (hitRate >= 60) {
      result = {
        status: 'PARTIAL',
        message:
          'Digits-only search hits some but not all patients. The fix is still ' +
          'worth shipping (normalize on read), but the impact is smaller than worst-case.',
      };
    } else {
      result = {
        status: 'CONFIRMED',
        message:
          'Digits-only search misses most patients with stored formatted phones. ' +
          'LK-02 is confirmed. Ship phone normalization in P1.',
      };
    }
    results.summary = { hits, total, hitRatePct: hitRate, ...result };

    console.log('');
    console.log('=== VERDICT ===');
    console.log(`  ${result.status}`);
    console.log(`  ${result.message}`);
  } finally {
    await pool.end();
  }

  results.finishedAt = new Date().toISOString();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(
    RESULTS_DIR,
    `test-phone-normalization-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('');
  console.log(`Results written to ${outPath}`);
})().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});
