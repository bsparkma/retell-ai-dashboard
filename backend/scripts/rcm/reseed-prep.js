'use strict';

/*
 * RESEED, STEP 1 OF 2 — CREATE THE SEVEN DISPOSABLE CLAIMS.  THIS WRITES.
 *
 *     # Look first. Dry run is the default and issues no write at all.
 *     PROBE_OFFICE=roland node scripts/rcm/reseed-prep.js
 *
 *     # Then, with the claim count the dry run printed:
 *     PROBE_OFFICE=roland RESEED_EXPECTED_CLAIMS=<n> \
 *       node scripts/rcm/reseed-prep.js --execute
 *
 * From inside the staging container, at `/app`. Roland only. PatNums 12827 and
 * 12828 only — the two designated synthetic fixtures, and Ruling A (2026-09-01)
 * forbids creating a new chart for this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT CREATES
 * ─────────────────────────────────────────────────────────────────────────────
 * §10.1's recipe, once per target in `reseed-targets.js` TARGETS:
 *
 *   POST /procedurelogs {PatNum, ProcDate:<today, Central>, procCode,
 *                        ProcStatus:"C", ProcFee:<billed>, ProvNum:1}
 *                                                        -> 201  ProcNum
 *   POST /claims        {PatNum, procNums:[ProcNum], ClaimType:"P"}
 *                                                        -> 201  ClaimNum, status "W"
 *   GET  /claimprocs?ClaimNum=<C>                        -> exactly 1 NotReceived row
 *
 * Seven of them, across the two patients, so the worklist's Patient column
 * changes from row to row. `reseed-835.js` then writes the four 835s that pay
 * them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G2 — A 201 IS NOT PROOF
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /claimprocs {DateCP}` returns 200 OK and changes nothing (RCM_OD_WRITES
 * G2). Open Dental answers success to writes it ignores. So every id this script
 * reports is READ BACK before it reaches the manifest, and a create whose
 * read-back disagrees is a FAILURE, not a warning — the manifest is the unwind's
 * only authority, and an id in it that does not exist, or exists differently,
 * would send the unwind at the wrong row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY PROPERTIES — enforced in code, pinned by test/rcmReseedScripts.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. POST only. No PUT, no DELETE anywhere in this file.
 *   2. Dry run is the DEFAULT. `--execute` is required to issue a single write.
 *   3. Every PatNum comes from the frozen TARGETS table and is re-checked
 *      against `assertPatNum` at run time — never from an argument.
 *   4. Every fee comes from the same table. There is no amount argument.
 *   5. Exactly TARGETS.length iterations — a fixed loop, not a parameter.
 *   6. It REFUSES if a manifest already exists, so a second run cannot mint a
 *      second set onto a patient whose first is still un-unwound.
 *   7. It REFUSES any PROBE_OFFICE but roland.
 *   8. It re-runs the open-claim pre-check before EACH procedure POST, and
 *      aborts if the count moved — a claim that appeared between the dry run and
 *      now means somebody else is working on these patients.
 *   9. >= 1.3 s between calls (D-8), so it cannot crowd the shared credential.
 *  10. It proves the output directory is WRITABLE before the first Open Dental
 *      call, so it cannot create seven live claims and then discover it has no
 *      way to record them.
 *  11. The manifest is written after EVERY target, not at the end. The worst
 *      outcome available here is a row created and unrecorded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT LOADS ITS OWN SECRETS
 * ─────────────────────────────────────────────────────────────────────────────
 * §9's D-7 run exposed two defects in a script that had been written, reviewed
 * and approved but never executed: it could not load its own secrets, and
 * importing it ran it. Both are closed here — `loadSecrets()` is awaited before
 * the office registry is touched, and `main()` is behind `require.main`.
 */

const fs = require('node:fs');
const odOffices = require('../../config/odOffices');
const T = require('./reseed-targets');

/*
 * Resolved once, at load. An office the registry does not name THROWS here,
 * before `main()` and before any Open Dental client exists. Failing at require
 * time rather than mid-run is deliberate: a typo must not get as far as holding
 * a credential.
 */
const OFFICE = T.resolveOffice();
const PATHS = T.pathsFor(OFFICE);

/** `--execute` issues the writes. Absent, nothing is written — see property 2. */
const EXECUTE = process.argv.includes('--execute');

/** Milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Today in the OFFICE's timezone, as `YYYY-MM-DD`.
 *
 * `OFFICE_TIMEZONE`, not UTC and not the container's `TZ`. UTC midnight lands at
 * 7pm the previous evening in Roland, so a UTC "today" run after 7pm would date
 * every procedure to tomorrow — and `DTM*472` in the 835 is scored against this
 * date by the matcher. The same reasoning the drain applies to `DateReceived`
 * (§3.3).
 *
 * @returns {string}
 */
function todayLocal() {
  const tz = String(process.env.OFFICE_TIMEZONE || 'America/Chicago').trim() || 'America/Chicago';
  // `en-CA` renders as YYYY-MM-DD, which is the format Open Dental wants and
  // saves hand-assembling one out of parts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The Open Dental seam, deliberately narrow.
 *
 * `post` is the ONLY write this file can express. `apiWriteRaw` itself accepts
 * PUT; this wrapper does not pass a method through, so there is no argument any
 * caller below could supply that would make it issue one.
 *
 * @param {{client: {apiGetRaw: Function, apiWriteRaw: Function}}} handle
 */
function odSeam(handle) {
  let lastCall = 0;
  /** Hold the D-8 floor by hand — these are operational scripts and do not go
   *  through `services/rcm/odPacer.js`. */
  const pace = async () => {
    const wait = T.PACE_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  };
  return {
    async get(path, params) {
      await pace();
      return handle.client.apiGetRaw(path, params, { timeoutMs: T.OD_TIMEOUT_MS });
    },
    async post(path, body) {
      await pace();
      return handle.client.apiWriteRaw('POST', path, body, { timeoutMs: T.OD_TIMEOUT_MS });
    },
  };
}

/**
 * How many claims each target patient carries right now.
 *
 * Read per patient rather than as one number, so the abort message can say WHICH
 * patient moved. `?PatNum=` is re-filtered client-side for the same reason every
 * other list read in this module is: if Open Dental ever stops honouring the
 * filter it returns page 1 of the claim table with a 200, and a count taken from
 * that is a number about somebody else.
 *
 * @param {ReturnType<typeof odSeam>} od
 * @returns {Promise<Record<number, number>>}
 */
async function claimCounts(od) {
  /** @type {Record<number, number>} */
  const counts = {};
  for (const patNum of T.ALLOWED_PATNUMS) {
    const res = await od.get('/claims', { PatNum: patNum, Limit: T.OD_PAGE_SIZE });
    if (!res || res.ok === false) {
      throw new Error(
        `could not read claims for PatNum ${patNum} (${(res && res.status) || '?'}). ` +
          'Refusing to create anything against a baseline that could not be established.'
      );
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    counts[patNum] = rows.filter((r) => Number(r.PatNum) === patNum).length;
  }
  return counts;
}

/** The total across both patients — the one number `RESEED_EXPECTED_CLAIMS` carries. */
const totalOf = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/**
 * The chart's own name for a patient, read rather than believed.
 *
 * The matcher scores `NM1*QC` against `LName`/`FName`, and on the name-search
 * lane a disagreement is DISQUALIFYING. A name this script assumed would be
 * quietly wrong one rename later — and R4's whole fixture is a TRANSPOSITION of
 * this exact string, so getting it from anywhere but the chart would make the
 * dead end accidental rather than authored.
 *
 * @param {ReturnType<typeof odSeam>} od
 * @param {number} patNum
 * @returns {Promise<{ patNum: number, last: string, first: string }>}
 */
async function chartName(od, patNum) {
  const res = await od.get(`/patients/${patNum}`, {});
  if (!res || res.ok === false || !res.data) {
    throw new Error(`could not read PatNum ${patNum} (${(res && res.status) || '?'}).`);
  }
  const last = String(res.data.LName || '').trim();
  const first = String(res.data.FName || '').trim();
  if (!last) {
    throw new Error(
      `PatNum ${patNum} has no surname on the chart. Without it the matcher scores ` +
        'PATIENT_NAME_MISMATCH and refuses to offer the candidate at all.'
    );
  }
  return { patNum, last, first };
}

/**
 * Create ONE target and read every id back. Returns the manifest entry.
 *
 * @param {ReturnType<typeof odSeam>} od
 * @param {(typeof T.TARGETS)[number]} target
 * @param {string} serviceDate
 */
async function createTarget(od, target, serviceDate) {
  const denied = T.assertPatNum(target.patNum);
  if (denied) throw new Error(denied);

  // ── 1. The procedure ──────────────────────────────────────────────────────
  const procRes = await od.post('/procedurelogs', {
    PatNum: target.patNum,
    ProcDate: serviceDate,
    procCode: target.procCode,
    ProcStatus: 'C',
    ProcFee: target.billedCents / 100,
    ProvNum: 1,
  });
  if (!procRes || procRes.ok === false) {
    throw new Error(
      `POST /procedurelogs failed for ${target.key} (${(procRes && procRes.status) || '?'}): ` +
        `${JSON.stringify((procRes && procRes.error) || (procRes && procRes.data) || null)}`
    );
  }
  const procNum = Number(procRes.data && procRes.data.ProcNum);
  if (!Number.isFinite(procNum) || procNum <= 0) {
    throw new Error(`POST /procedurelogs returned no usable ProcNum for ${target.key}.`);
  }

  // G2: read it back. A 201 is not proof.
  const procBack = await od.get(`/procedurelogs/${procNum}`, {});
  if (!procBack || procBack.ok === false || !procBack.data) {
    throw new Error(`created ProcNum ${procNum} for ${target.key} but could not read it back.`);
  }
  const backDate = String(procBack.data.ProcDate || '').slice(0, 10);
  if (backDate !== serviceDate) {
    throw new Error(
      `ProcNum ${procNum} read back with ProcDate '${backDate}', not '${serviceDate}'. ` +
        'The 835 carries the CHART\'s date, so a disagreement here is a broken fixture, not a warning.'
    );
  }
  if (Number(procBack.data.PatNum) !== target.patNum) {
    throw new Error(
      `ProcNum ${procNum} read back on PatNum ${procBack.data.PatNum}, not ${target.patNum}. STOPPING.`
    );
  }

  // ── 2. The claim ──────────────────────────────────────────────────────────
  const claimRes = await od.post('/claims', {
    PatNum: target.patNum,
    procNums: [procNum],
    ClaimType: 'P',
  });
  if (!claimRes || claimRes.ok === false) {
    throw new Error(
      `POST /claims failed for ${target.key} (${(claimRes && claimRes.status) || '?'}): ` +
        `${JSON.stringify((claimRes && claimRes.error) || (claimRes && claimRes.data) || null)}\n` +
        `  ProcNum ${procNum} WAS created and is recorded in the manifest — the unwind will remove it.`
    );
  }
  const claimNum = Number(claimRes.data && claimRes.data.ClaimNum);
  if (!Number.isFinite(claimNum) || claimNum <= 0) {
    throw new Error(`POST /claims returned no usable ClaimNum for ${target.key}.`);
  }

  // ── 3. The claimproc Open Dental created for us ───────────────────────────
  const cpRes = await od.get('/claimprocs', { ClaimNum: claimNum });
  if (!cpRes || cpRes.ok === false) {
    throw new Error(`could not read claimprocs for ClaimNum ${claimNum} (${(cpRes && cpRes.status) || '?'}).`);
  }
  const cpRows = (Array.isArray(cpRes.data) ? cpRes.data : []).filter(
    (r) => Number(r.ClaimNum) === claimNum
  );
  if (cpRows.length !== 1) {
    throw new Error(
      `ClaimNum ${claimNum} carries ${cpRows.length} claimprocs; the fixture needs exactly 1. STOPPING.`
    );
  }
  const claimProcNum = Number(cpRows[0].ClaimProcNum);
  if (!Number.isFinite(claimProcNum) || claimProcNum <= 0) {
    throw new Error(`ClaimNum ${claimNum} claimproc has no usable ClaimProcNum.`);
  }

  return {
    key: target.key,
    remittance: target.remittance,
    patNum: target.patNum,
    procCode: target.procCode,
    billedCents: target.billedCents,
    allowedCents: target.allowedCents,
    paidCents: target.paidCents,
    procNum,
    claimNum,
    claimProcNum,
    serviceDate,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Write the manifest. Called after EVERY target, and especially on a partial
 * run: the unwind removes only what the manifest names, so a create the manifest
 * does not name can never be removed by the tooling that made it. `complete`
 * says out loud which kind of file this is.
 *
 * @param {object} manifest
 */
function writeManifest(manifest) {
  fs.writeFileSync(PATHS.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log(`\n=== RCM RESEED PREP — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} · office ${OFFICE} ===`);

  // ── The plan, printed before anything is loaded ───────────────────────────
  console.log('\n-- the seven targets');
  for (const t of T.TARGETS) {
    const W = t.billedCents - t.allowedCents;
    const R = t.allowedCents - t.paidCents;
    console.log(
      `  ${t.remittance}  ${t.key.padEnd(5)} PatNum ${t.patNum}  ${t.procCode}  ` +
        `billed $${(t.billedCents / 100).toFixed(2)}  write-off $${(W / 100).toFixed(2)}  ` +
        `paid $${(t.paidCents / 100).toFixed(2)}  patient $${(R / 100).toFixed(2)}`
    );
    console.log(`         ${t.note}`);
  }

  // ── Refuse a second set before touching anything ──────────────────────────
  if (fs.existsSync(PATHS.manifestPath)) {
    console.error(
      `\nREFUSED: a manifest already exists at\n  ${PATHS.manifestPath}\n` +
        '  A second run would mint a second set of claims onto patients whose first set is still\n' +
        '  un-unwound, and the unwind would then have no record of half of them. Run\n' +
        '  `scripts/rcm-s11-unwind.js` first, or move the manifest aside if you know it is spent.'
    );
    process.exitCode = 2;
    return;
  }

  // ── Prove we can record what we are about to create ───────────────────────
  const outDirProblem = T.checkOutDirWritable(PATHS.outDir);
  if (outDirProblem) {
    console.error(`\nREFUSED: ${outDirProblem}`);
    process.exitCode = 3;
    return;
  }

  // Secrets BEFORE the office registry — §9's lesson, and the reason the D-7
  // probes could not run the first time they were invoked.
  await require('../../config/secrets').loadSecrets();
  const handle = odOffices.assertOfficeMatch(OFFICE, odOffices.getOdOffice(OFFICE));
  const od = odSeam(handle);

  const serviceDate = todayLocal();
  console.log(`\n-- service date ${serviceDate} (OFFICE_TIMEZONE, not UTC)`);

  // ── The baseline ──────────────────────────────────────────────────────────
  const baseline = await claimCounts(od);
  const baselineTotal = totalOf(baseline);
  console.log('\n-- baseline, before anything is created');
  for (const [patNum, n] of Object.entries(baseline)) {
    console.log(`  PatNum ${patNum}  ${n} claim(s)`);
  }
  console.log(`  TOTAL ${baselineTotal}`);

  const names = [];
  for (const patNum of T.ALLOWED_PATNUMS) names.push(await chartName(od, patNum));

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing was created. Open Dental was READ and not written.');
    console.log('\nTo create the seven targets, re-run with the baseline you just read:');
    console.log(
      `  PROBE_OFFICE=${OFFICE} RESEED_EXPECTED_CLAIMS=${baselineTotal} ` +
        'node scripts/rcm/reseed-prep.js --execute'
    );
    return;
  }

  // ── The opt-in, and it must match what was just read ──────────────────────
  const expected = Number(process.env.RESEED_EXPECTED_CLAIMS);
  if (!Number.isFinite(expected)) {
    console.error(
      '\nREFUSED: RESEED_EXPECTED_CLAIMS is not set.\n' +
        '  Run the dry run first and pass the total it prints. Without a baseline, "nothing else\n' +
        '  appeared on these patients" is an assumption rather than a check.'
    );
    process.exitCode = 4;
    return;
  }
  if (expected !== baselineTotal) {
    console.error(
      `\nREFUSED: RESEED_EXPECTED_CLAIMS=${expected} but these patients carry ${baselineTotal} claim(s) now.\n` +
        '  Something changed since the dry run. Nothing has been created.'
    );
    process.exitCode = 5;
    return;
  }

  /** @type {object} */
  const manifest = {
    office: OFFICE,
    createdAt: new Date().toISOString(),
    serviceDate,
    baselineClaimCount: baselineTotal,
    patients: names.map((n) => ({ patNum: n.patNum, last: n.last, first: n.first })),
    complete: false,
    targets: [],
  };
  writeManifest(manifest);

  console.log('\n-- creating');
  let runningTotal = baselineTotal;
  for (const target of T.TARGETS) {
    /*
     * THE PRE-CHECK, RE-RUN BEFORE EVERY CREATE.
     *
     * Not once at the top. The seven creates are ~5 s apart, and a claim
     * appearing between two of them is precisely the condition being watched
     * for — somebody else working on these patients while this runs. The
     * expected count grows by one per target because this script is itself the
     * thing adding them.
     */
    const now = totalOf(await claimCounts(od));
    if (now !== runningTotal) {
      manifest.abortedBefore = target.key;
      manifest.abortReason = `claim count moved from ${runningTotal} to ${now} before ${target.key}`;
      writeManifest(manifest);
      console.error(
        `\nABORTED before ${target.key}: these patients carried ${runningTotal} claim(s) and now carry ${now}.\n` +
          '  Somebody else is working on this chart. Everything created so far IS in the manifest and\n' +
          '  can be unwound. Nothing further will be created.'
      );
      process.exitCode = 6;
      return;
    }

    const entry = await createTarget(od, target, serviceDate);
    manifest.targets.push(entry);
    writeManifest(manifest);
    runningTotal += 1;
    console.log(
      `  ${entry.key.padEnd(5)} PatNum ${entry.patNum}  ProcNum ${entry.procNum}  ` +
        `ClaimNum ${entry.claimNum}  ClaimProcNum ${entry.claimProcNum}`
    );
  }

  manifest.complete = true;
  writeManifest(manifest);

  console.log(`\nDONE. ${manifest.targets.length} target(s) created and read back.`);
  console.log(`  manifest ${PATHS.manifestPath}`);
  console.log('\n-- ADD THESE TO THE DENY-LIST');
  console.log('   `RESEED_SPENT_IDS` in scripts/rcm/reseed-targets.js, and the §10.8 table in');
  console.log('   docs/RCM_POSTING.md. An id is spent the moment it EXISTS, not the moment it is');
  console.log('   used successfully.');
  console.log(`   claims:      [${manifest.targets.map((t) => t.claimNum).join(', ')}]`);
  console.log(`   procedures:  [${manifest.targets.map((t) => t.procNum).join(', ')}]`);
  console.log(`   claimProcs:  [${manifest.targets.map((t) => t.claimProcNum).join(', ')}]`);
  console.log('\nNEXT: node scripts/rcm/reseed-835.js');
}

// Run ONLY when invoked directly. Requiring this file must never write to a chart.
if (require.main === module) {
  main()
    .then(() => {
      process.exit(process.exitCode || 0);
    })
    .catch((err) => {
      console.error(`\nRESEED PREP FAILED: ${err && err.message ? err.message : err}`);
      console.error('Anything already created is recorded in the manifest and can be unwound.');
      process.exit(1);
    });
}

module.exports = { main, createTarget, claimCounts, chartName, todayLocal, odSeam };
