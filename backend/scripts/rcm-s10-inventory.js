'use strict';

/*
 * §10 PREP, STEP 1 OF 3 — WHAT IS ALREADY ON PatNum 12827?  READ-ONLY.
 *
 *     PROBE_OFFICE=roland node scripts/rcm-s10-inventory.js
 *
 * From inside the staging container, so Roland's customer key is resolved from
 * Key Vault by the app's own loader and never printed. Running it from a
 * workstation is not an option: `kv-carein-staging` is in a different Entra
 * tenant from a workstation `az` token (`AKV10032: Invalid issuer`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS BEFORE ANYTHING IS CREATED
 * ─────────────────────────────────────────────────────────────────────────────
 * §10 ends at §11: the walk is only finishable if the patient can be returned to
 * the balance it started at, and "returned to" is meaningless without a picture
 * of where it started. Spike 0b left permanent residue on this patient — a
 * negative supplemental that Open Dental will not let any API caller remove,
 * pinning its claim and that claim's procedure forever. That residue nets to
 * zero against four adjustments. If ANYTHING ELSE has appeared on 12827 since,
 * the walk's arithmetic at the end would silently absorb it, and a $1.00 test
 * would be reported as balancing when it did not.
 *
 * So this is not a formality. It is the baseline the §11 unwind is measured
 * against, and its output is pasted into §10.1.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G12 — SOFT DELETES ARE COUNTED SEPARATELY, NEVER SILENTLY
 * ─────────────────────────────────────────────────────────────────────────────
 * `DELETE /procedurelogs` is a SOFT delete (RCM_OD_WRITES G12): the row comes
 * back with `ProcStatus: "D"` and STILL APPEARS in `GET /procedurelogs`. Spike
 * 0b's own teardown counted "D" rows as live charges and over-applied a reversal
 * by $2.00. Every "D" row here is FLAGGED in the table and EXCLUDED from the
 * balance — and the count of excluded rows is printed, so a smaller number is
 * never shown without saying why.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO WRITES. NO NAMES.
 * ─────────────────────────────────────────────────────────────────────────────
 * GET only — there is no POST, PUT or DELETE anywhere in this file, and the
 * scripts/ scan in `routes/rcm/rcmNoOdWrites.test.js` fails the build if one
 * appears. Ids, statuses, dates, codes and amounts are printed. The patient's
 * name is NOT: 12827 is a designated synthetic fixture, but the habit is the
 * point, and this transcript goes into a document.
 */

const odOffices = require('../config/odOffices');
const T = require('./rcm-s10-targets');


/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 6d: WHICH PRACTICE THIS RUN ADDRESSES, RESOLVED ONCE, AT LOAD.
 * ─────────────────────────────────────────────────────────────────────────────
 * `PROBE_OFFICE` selects; an office the registry does not name THROWS here,
 * before `main()` and before any Open Dental client exists. Failing at require
 * time rather than mid-run is deliberate: a typo must not get as far as holding
 * a credential.
 *
 * Every id below is per-office, because ClaimNum, ProcNum and ClaimProcNum
 * numbering restarts in every Open Dental database — and PatNum 7115 is valley's
 * test patient and a DIFFERENT, REAL person in Roland.
 */
const TARGET = T.resolveTarget();
const PATHS = T.pathsFor(TARGET.office);
const DENY = T.denyIdsFor(TARGET);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cents from a dollar-ish value, without ever touching a float.
 * Same stance as `services/rcm/eraParser.toCents`: money is integer cents here
 * because the whole point of the closing arithmetic is that it is exact.
 * @param {unknown} value
 * @returns {number}
 */
function cents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?/.exec(String(value).trim());
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] ? Number.parseInt(m[2], 10) : 0;
  const frac = Number.parseInt((m[3] || '').padEnd(2, '0'), 10) || 0;
  return sign * (whole * 100 + frac);
}

/** @param {number} c */
function money(c) {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Walk a paginated Open Dental list, re-applying `keep` CLIENT-SIDE.
 *
 * Open Dental silently ignores list filters it does not implement
 * (RCM_OD_WRITES §9) — it answers 200 with everybody's rows rather than
 * refusing. `odClaimReads.scanList` re-filters for exactly that reason and
 * reports whether the filter was honoured; so does this. An inventory that
 * trusted `?PatNum=` could print another patient's claims as this one's.
 *
 * @param {{client: {apiGetRaw: Function}}} handle
 * @param {string} path
 * @param {Record<string, unknown>} params
 * @param {(row: Record<string, unknown>) => boolean} keep
 */
async function scan(handle, path, params, keep) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  let dropped = 0;
  let truncated = false;
  for (let page = 0; page < T.MAX_PAGES; page++) {
    await sleep(T.PACE_MS);
    const res = await handle.client.apiGetRaw(
      path,
      { ...params, ...(page > 0 ? { Offset: page * T.OD_PAGE_SIZE } : {}) },
      { timeoutMs: T.OD_TIMEOUT_MS }
    );
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${res.error}`);
    const batch = Array.isArray(res.data) ? res.data : [];
    for (const row of batch) {
      if (keep(row)) rows.push(row);
      else dropped++;
    }
    if (batch.length < T.OD_PAGE_SIZE) return { rows, dropped, truncated };
    if (page === T.MAX_PAGES - 1) truncated = true;
  }
  return { rows, dropped, truncated };
}

/**
 * Why a row is on the deny-list, or empty when it is not.
 *
 * Two buckets, and they are kept apart deliberately. Spike 0b's rows and the ids
 * this walk spent are both untouchable, for the same underlying reason (Open
 * Dental does not reissue ids, so a manifest naming one did not come from a prep
 * run) — but printing `SPIKE 0b RESIDUE` beside a procedure 0b never created
 * would be a label that is simply false, and a false label in an inventory is
 * worse than none.
 *
 * @param {number} id
 * @param {'claims'|'procedures'|'claimProcs'|'adjustments'} bucket
 * @returns {string}
 */
function denyNote(id, bucket) {
  const n = Number(id);
  if ((T.SPIKE_0B_RESIDUE[bucket] || []).includes(n)) return '*** SPIKE 0b RESIDUE — DO NOT TOUCH';
  if ((T.WALK_SPENT_IDS[bucket] || []).includes(n)) return '*** SPENT BY A PREVIOUS WALK — DO NOT TOUCH';
  return '';
}

/**
 * Fixed-width table printer. Nothing fancy — this output is pasted into a doc.
 * @param {string} title
 * @param {string[]} columns
 * @param {Array<Array<unknown>>} rows
 */
function table(title, columns, rows) {
  console.log(`\n-- ${title} (${rows.length}) ${'-'.repeat(Math.max(4, 58 - title.length))}`);
  if (rows.length === 0) {
    console.log('   (none)');
    return;
  }
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i] ?? '').length))
  );
  const line = (cells) => '   ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(columns));
  console.log('   ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

async function main() {
  /*
   * Required lazily and awaited FIRST, before any odOffices call.
   *
   * `config/odOffices` reads the customer key from `process.env`, and the ONLY
   * thing that puts it there is this loader — which used to be called by
   * `server.js` and by nothing else. That is the defect the 2026-08-24 D-7 run
   * exposed: a standalone script inherited an environment without the key, died
   * on OFFICE_OD_KEY_MISSING before issuing anything, and got improvised through
   * a `node -e` wrapper at a live chart database. A script whose documented
   * invocation does not work gets improvised by whoever is at the console.
   */
  await require('../config/secrets').loadSecrets();

  /*
   * 6d: THE OFFICE ALREADY REFUSED, ABOVE, AT LOAD.
   *
   * `T.resolveTarget()` throws on a `PROBE_OFFICE` the registry does not name,
   * so by the time `main()` runs the office is one of exactly two and its PatNum
   * came from the same frozen row. There is no longer a roland-only refusal to
   * make here -- what there IS, and what matters more, is the assertion below
   * that the Open Dental handle we are about to use is frozen to this same
   * office. A PatNum in the wrong database is a different, real person.
   */
  const office = TARGET.office;

  // Belt AND braces: the office is validated against the registry above, and the
  // handle is asserted to be the one that office froze onto itself. That is the
  // idiom every OD call site in this repo uses — `assertOfficeMatch(key,
  // getOdOffice(key))` — and config/odOffices calls it the safety heart of the
  // per-office slice.
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));

  console.log(`\n=== S10 INVENTORY — ${office} (${handle.officeName}), PatNum ${TARGET.patNum} ===`);
  console.log(`    READ-ONLY. started: ${new Date().toISOString()}`);

  // -- Claims ----------------------------------------------------------------
  const claims = await scan(handle, '/claims', { PatNum: TARGET.patNum }, (r) => Number(r.PatNum) === TARGET.patNum);
  if (claims.dropped) {
    console.log(
      `\n   ! Open Dental ignored the PatNum filter on /claims and returned ${claims.dropped} other rows; discarded here.`
    );
  }
  if (claims.truncated) console.log('\n   ! /claims was TRUNCATED at the page cap — this inventory is incomplete.');

  table(
    'CLAIMS',
    ['ClaimNum', 'ClaimStatus', 'DateService', 'ClaimFee', 'note'],
    claims.rows.map((c) => [
      c.ClaimNum,
      c.ClaimStatus,
      c.DateService,
      c.ClaimFee,
      denyNote(c.ClaimNum, 'claims'),
    ])
  );

  // -- Procedures ------------------------------------------------------------
  const procs = await scan(handle, '/procedurelogs', { PatNum: TARGET.patNum }, (r) => Number(r.PatNum) === TARGET.patNum);
  if (procs.dropped) {
    console.log(
      `\n   ! Open Dental ignored the PatNum filter on /procedurelogs and returned ${procs.dropped} other rows; discarded here.`
    );
  }
  if (procs.truncated) {
    console.log('\n   ! /procedurelogs was TRUNCATED at the page cap. A missing procedure row cannot be told');
    console.log('     from a deleted one, so the balance below would be WRONG. Do not create targets on this reading.');
  }

  const deleted = procs.rows.filter((p) => String(p.ProcStatus) === 'D');
  table(
    'PROCEDURELOGS',
    ['ProcNum', 'ProcStatus', 'code', 'ProcFee', 'ProcDate', 'note'],
    procs.rows.map((p) => [
      p.ProcNum,
      p.ProcStatus,
      p.procCode ?? p.CodeNum ?? '',
      p.ProcFee,
      p.ProcDate,
      [
        String(p.ProcStatus) === 'D' ? 'SOFT-DELETED (G12) — excluded from balance' : '',
        denyNote(p.ProcNum, 'procedures'),
      ]
        .filter(Boolean)
        .join('  '),
    ])
  );
  console.log(`   ${deleted.length} row(s) read ProcStatus "D" and are excluded from every total below.`);

  /*
   * -- ClaimProcs, BY PATIENT rather than by claim --------------------------
   *
   * This read used to loop the claims and ask for each one's lines. That is how
   * `odClaimReads.js` does it, and for matching it is right: a candidate is a
   * claim, so its lines come from the claim.
   *
   * It is WRONG for a ledger, and the 2026-08-25 run proved it. PatNum 12827 had
   * ZERO claims and a claimproc all the same: `533930`, `ClaimNum: 0`, a detached
   * Spike 0b estimate. A claim-scoped walk cannot see a row that belongs to no
   * claim, so the baseline the §11 unwind is measured against silently omitted
   * it. That row happens to carry $0.00, so the number did not move — but "the
   * number did not move this time" is not a property, and the next detached row
   * could carry money.
   *
   * One PatNum-scoped read replaces N claim-scoped ones: fewer calls against the
   * shared credential AND a complete set.
   */
  const claimProcScan = await scan(
    handle,
    '/claimprocs',
    { PatNum: TARGET.patNum },
    (r) => Number(r.PatNum) === TARGET.patNum
  );
  if (claimProcScan.dropped) {
    console.log(
      `\n   ! Open Dental ignored the PatNum filter on /claimprocs and returned ${claimProcScan.dropped} other rows; discarded here.`
    );
  }
  if (claimProcScan.truncated) {
    console.log('\n   ! /claimprocs was TRUNCATED at the page cap — this inventory is incomplete.');
  }
  const allClaimProcs = claimProcScan.rows;

  /** @type {Set<number>} */
  const claimPaymentNums = new Set();
  for (const cp of allClaimProcs) {
    const n = Number(cp.ClaimPaymentNum);
    if (Number.isFinite(n) && n > 0) claimPaymentNums.add(n);
  }

  const claimNums = new Set(claims.rows.map((c) => Number(c.ClaimNum)));
  const detached = allClaimProcs.filter((cp) => !claimNums.has(Number(cp.ClaimNum)));

  table(
    'CLAIMPROCS',
    ['ClaimProcNum', 'ClaimNum', 'ProcNum', 'Status', 'InsPayAmt', 'WriteOff', 'ClaimPaymentNum', 'note'],
    allClaimProcs.map((cp) => [
      cp.ClaimProcNum,
      cp.ClaimNum,
      cp.ProcNum,
      cp.Status,
      cp.InsPayAmt,
      cp.WriteOff,
      cp.ClaimPaymentNum,
      [
        claimNums.has(Number(cp.ClaimNum)) ? '' : 'DETACHED — belongs to no claim on this patient',
        denyNote(cp.ClaimProcNum, 'claimProcs'),
      ]
        .filter(Boolean)
        .join('  '),
    ])
  );
  if (detached.length) {
    console.log(
      `   ${detached.length} claimproc(s) belong to no claim on this patient. They are counted in the balance` +
        ' below — a claim-scoped read would have missed them entirely.'
    );
  }

  // -- ClaimPayments referenced by those lines -------------------------------
  const payments = [];
  for (const num of claimPaymentNums) {
    await sleep(T.PACE_MS);
    const res = await handle.client.apiGetRaw(`/claimpayments/${num}`, {}, { timeoutMs: T.OD_TIMEOUT_MS });
    payments.push(
      res.ok
        ? [num, res.data?.CheckAmt, res.data?.CheckDate, res.data?.CheckNum, res.data?.IsPartial, '']
        : [num, '', '', '', '', `read failed (${res.status})`]
    );
  }
  table(
    'CLAIMPAYMENTS referenced by the lines above',
    ['ClaimPaymentNum', 'CheckAmt', 'CheckDate', 'CheckNum', 'IsPartial', 'note'],
    payments
  );

  // -- Adjustments -----------------------------------------------------------
  const adj = await scan(handle, '/adjustments', { PatNum: TARGET.patNum }, (r) => Number(r.PatNum) === TARGET.patNum);
  table(
    'ADJUSTMENTS',
    ['AdjNum', 'AdjDate', 'AdjAmt', 'note'],
    adj.rows.map((a) => [
      a.AdjNum,
      a.AdjDate,
      a.AdjAmt,
      denyNote(a.AdjNum, 'adjustments'),
    ])
  );

  /*
   * -- Balance, with "D" rows excluded --------------------------------------
   *
   * Deliberately NOT read from a patient's `Balance`/`EstBalance` field. This is
   * the arithmetic §11 has to reproduce at the end of the walk, so it is computed
   * HERE from the same rows, the same way, with the same exclusion — otherwise
   * "back to where it started" would be measured against a number nobody derived,
   * and a disagreement between the two readings would look like a posting error.
   */
  const liveProcNums = new Set(
    procs.rows.filter((p) => String(p.ProcStatus) !== 'D').map((p) => Number(p.ProcNum))
  );
  const chargesCents = procs.rows
    .filter((p) => String(p.ProcStatus) === 'C')
    .reduce((sum, p) => sum + cents(p.ProcFee), 0);
  const insPaidCents = allClaimProcs
    .filter((cp) => liveProcNums.has(Number(cp.ProcNum)))
    .reduce((sum, cp) => sum + cents(cp.InsPayAmt), 0);
  const writeOffCents = allClaimProcs
    .filter((cp) => liveProcNums.has(Number(cp.ProcNum)))
    .reduce((sum, cp) => sum + cents(cp.WriteOff), 0);
  const adjCents = adj.rows.reduce((sum, a) => sum + cents(a.AdjAmt), 0);
  const balance = chargesCents - insPaidCents - writeOffCents + adjCents;

  console.log('\n-- COMPUTED BALANCE (ProcStatus "D" excluded) -----------------------');
  console.log(`   charges  (ProcStatus "C")   ${money(chargesCents).padStart(12)}`);
  console.log(`   insurance paid              ${money(-insPaidCents).padStart(12)}`);
  console.log(`   write-offs                  ${money(-writeOffCents).padStart(12)}`);
  console.log(`   adjustments                 ${money(adjCents).padStart(12)}`);
  console.log('   ' + '-'.repeat(40));
  console.log(`   PATIENT BALANCE             ${money(balance).padStart(12)}`);
  console.log(`   (${deleted.length} soft-deleted procedure row(s) excluded)`);

  // -- The one judgement this script makes -----------------------------------
  const residueClaims = claims.rows.filter((c) => T.SPIKE_0B_RESIDUE.claims.includes(Number(c.ClaimNum)));
  const otherClaims = claims.rows.filter((c) => !T.SPIKE_0B_RESIDUE.claims.includes(Number(c.ClaimNum)));
  console.log('\n-- BASELINE VERDICT -------------------------------------------------');
  console.log(`   Spike 0b residue claims present : ${residueClaims.map((c) => c.ClaimNum).join(', ') || 'NONE'}`);
  console.log(`   Other claims on this patient    : ${otherClaims.map((c) => c.ClaimNum).join(', ') || 'none'}`);
  console.log(`   CLAIM COUNT FOR THE PREP PRE-CHECK : ${claims.rows.length}`);
  console.log(`   (pass it to prep as S10_EXPECTED_CLAIMS=${claims.rows.length})`);
  if (otherClaims.length) {
    console.log('   ! Something besides the Spike 0b residue is on this patient. Read the tables above');
    console.log('     and decide DELIBERATELY whether the walk still nets to a number you can verify.');
  }
  if (balance !== 0) {
    console.log(`   ! The patient does NOT start at $0.00 (${money(balance)}). Section 11 must return it to THIS`);
    console.log('     number, not to zero. Record it in section 10.1 before creating anything.');
  }

  console.log(`\nDONE ${new Date().toISOString()} — nothing was created, updated or deleted.`);
  console.log(`NEXT: PROBE_OFFICE=${TARGET.office} S10_EXPECTED_CLAIMS=${claims.rows.length} node scripts/rcm-s10-prep.js`);
}

// Run ONLY when invoked directly — requiring this file must not issue a single
// Open Dental call. See the header of scripts/rcm-s10-targets.js for why that
// rule exists and what it cost to learn.
if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (e) => {
      console.error('INVENTORY FAILED:', e && e.message);
      process.exit(1);
    }
  );
}

module.exports = { main, cents, money };
