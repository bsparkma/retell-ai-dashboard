'use strict';

/*
 * §10 PREP, STEP 2 OF 3 — CREATE THE TWO DISPOSABLE TARGETS.  THIS WRITES.
 *
 *     PROBE_OFFICE=roland S10_EXPECTED_CLAIMS=<n> node scripts/rcm-s10-prep.js
 *
 * `<n>` is the claim count `rcm-s10-inventory.js` printed. Run the inventory
 * first; this script refuses without the number, because the pre-check below is
 * the only thing standing between "two disposable claims" and "we created a
 * target beside a claim somebody was working on".
 *
 * From inside the staging container. Roland only. PatNum 12827 only. $1.00.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT CREATES, AND WHY TWICE
 * ─────────────────────────────────────────────────────────────────────────────
 * The §10.1 recipe, run twice:
 *
 *   POST /procedurelogs {PatNum, procCode:"D0140", ProcStatus:"C", ProcFee:1.00,
 *                        ProvNum:1}                     -> 201  ProcNum
 *   POST /claims        {PatNum, procNums:[ProcNum], ClaimType:"P"}
 *                                                        -> 201  ClaimNum, status W
 *   GET  /claimprocs?ClaimNum=<C>                        -> exactly 1 NotReceived row
 *
 * Target A is §10.2's walk. Target B is §10.3's kill-mid-drain, which needs a
 * SECOND plan because the first one is `posted` by then and §10.4 proves a
 * replay of a posted plan makes no Open Dental call at all. Creating B on the
 * night, mid-walk, would mean writing to a chart while measuring a drain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G2 — A 201 IS NOT PROOF
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /claimprocs {DateCP}` returns 200 OK and changes nothing (RCM_OD_WRITES
 * G2, Spike 0b test 2b). Open Dental answers success to writes it ignores. So
 * every id this script reports is READ BACK before it is written to the
 * manifest, and a create whose read-back disagrees is a FAILURE, not a warning.
 * The manifest is the unwind's only authority; an id in it that does not exist,
 * or exists differently, would send the unwind at the wrong row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY PROPERTIES — enforced in code, pinned by test/rcmS10Scripts.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. POST only. No PUT, no DELETE anywhere in this file.
 *   2. PatNum is the hard-coded constant, never an argument.
 *   3. ProcFee is the hard-coded constant, never an argument.
 *   4. Exactly TARGET_COUNT (2) iterations — a fixed loop, not a parameter.
 *   5. It REFUSES if the manifest already exists, so a second run cannot mint a
 *      third target onto a patient whose first two are still un-unwound.
 *   6. It REFUSES any PROBE_OFFICE but roland.
 *   7. It re-runs the open-claim pre-check before EACH procedure POST, and
 *      aborts if the count moved — a claim that appeared between the inventory
 *      and now means somebody else is working on this patient.
 *   8. >= 1.3 s between calls, so it cannot crowd the shared credential.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IF `POST /claims` FAILS
 * ─────────────────────────────────────────────────────────────────────────────
 * 12827 has an active plan (PatPlanNum 20469, 2026-01-01 -> 2026-12-31) that
 * Beau added for Spike 0b; without it `POST /claims` fails. If it fails for a
 * plan reason, this script STOPS and says so. It does not touch PatPlanNum
 * 20469 and it does not add a plan — that is a decision about a chart, and a
 * script does not get to make one.
 *
 * It does NOT roll the procedure back either: this file holds POST and nothing
 * else, deliberately, so it has no way to. What it does instead is write the
 * orphan procedure into the manifest before exiting, so `rcm-s11-unwind.js` —
 * the one file here that may DELETE — can remove it. A partial run therefore
 * leaves a $1.00 charge on 12827 and a manifest that names it. That is honest and
 * recoverable; a script that silently cleaned up after itself with a delete verb
 * it should not own would not be.
 */

const fs = require('node:fs');
const odOffices = require('../config/odOffices');
const T = require('./rcm-s10-targets');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open Dental's date strings are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`; the null
 * date is `0001-01-01`. Return the day part, or null for absent/null-date — never
 * today's date, which would be an invention.
 * @param {unknown} value
 * @returns {string|null}
 */
function isoDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return day === '0001-01-01' ? null : day;
}

/**
 * Every Open Dental call in this file goes through here, so the pacing is a
 * property of the transport rather than of whoever remembered to await a sleep.
 * @param {{client: {apiGetRaw: Function, apiWriteRaw: Function}}} handle
 */
function pacedOd(handle) {
  return {
    async get(path, params = {}) {
      await sleep(T.PACE_MS);
      return handle.client.apiGetRaw(path, params, { timeoutMs: T.OD_TIMEOUT_MS });
    },
    /**
     * POST ONLY. `apiWriteRaw` itself accepts PUT, and this wrapper deliberately
     * does not pass it through: nothing in creating a disposable target updates
     * an existing row, so the capability is not offered. The PUT that returns a
     * claimproc to NotReceived belongs to the unwind, in its own file, behind
     * its own allow-list entry.
     */
    async post(path, body) {
      await sleep(T.PACE_MS);
      return handle.client.apiWriteRaw('POST', path, body, {
        timeoutMs: T.OD_TIMEOUT_MS,
        module: 'rcm-s10-prep',
      });
    },
  };
}

/**
 * Count 12827's claims, client-side filtered.
 *
 * Open Dental silently ignores list filters it does not implement — it answers
 * 200 with everybody's rows rather than refusing (RCM_OD_WRITES §9). A pre-check
 * that trusted `?PatNum=` would be comparing a whole-practice count against an
 * inventory's per-patient one and would abort every time, or worse, pass by luck.
 * @param {ReturnType<typeof pacedOd>} od
 */
async function claimCount(od) {
  let total = 0;
  for (let page = 0; page < T.MAX_PAGES; page++) {
    const res = await od.get('/claims', {
      PatNum: T.PAT_NUM,
      ...(page > 0 ? { Offset: page * T.OD_PAGE_SIZE } : {}),
    });
    if (!res.ok) throw new Error(`GET /claims failed (${res.status}): ${res.error}`);
    const batch = Array.isArray(res.data) ? res.data : [];
    total += batch.filter((r) => Number(r.PatNum) === T.PAT_NUM).length;
    if (batch.length < T.OD_PAGE_SIZE) return total;
  }
  throw new Error('GET /claims did not terminate within the page cap — refusing to guess the count.');
}

async function main() {
  // FIRST, before any odOffices call. See rcm-s10-inventory.js for what a
  // script that cannot load its own secrets costs at a live chart database.
  await require('../config/secrets').loadSecrets();

  const office = process.env.PROBE_OFFICE || T.OFFICE;
  if (office !== T.OFFICE) {
    console.error(
      `REFUSED: PROBE_OFFICE='${office}'. This script writes to '${T.OFFICE}' only.\n` +
        `  valley is fail-closed until D-7 is discharged, and PatNum 7115 is 6d's, not this walk's.`
    );
    process.exitCode = 2;
    return;
  }

  /*
   * SAFETY 5 — the manifest is a lock, not just an output.
   *
   * Two targets is a decision, not a batch size. If a manifest is already on
   * disk, either the walk is in progress or it finished and was never unwound —
   * and in both cases the right answer is "stop", not "make two more". Deleting
   * the manifest to force a re-run is possible and deliberate; doing it by
   * accident is not.
   */
  if (fs.existsSync(T.MANIFEST_PATH)) {
    console.error(
      `REFUSED: a manifest already exists at\n  ${T.MANIFEST_PATH}\n` +
        `  Two targets were already created. Unwind them first:\n` +
        `      PROBE_OFFICE=${T.OFFICE} node scripts/rcm-s11-unwind.js --execute\n` +
        `  and delete the manifest, or move it aside deliberately.`
    );
    process.exitCode = 3;
    return;
  }

  /*
   * SAFETY 7 — the pre-check needs a number the inventory produced.
   *
   * Not defaulted. A default would make the check pass on a patient nobody
   * looked at, which is exactly the reassurance-without-evidence this module
   * spends its whole discipline avoiding.
   */
  const expectedRaw = process.env.S10_EXPECTED_CLAIMS;
  const expectedClaims = Number.parseInt(String(expectedRaw ?? ''), 10);
  if (!Number.isFinite(expectedClaims) || expectedClaims < 0) {
    console.error(
      'REFUSED: S10_EXPECTED_CLAIMS is not set.\n' +
        '  Run `node scripts/rcm-s10-inventory.js` first and pass the claim count it printed.\n' +
        '  Without it there is no baseline, and "nothing else appeared on this patient" is an\n' +
        '  assumption rather than a check.'
    );
    process.exitCode = 4;
    return;
  }

  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const od = pacedOd(handle);

  console.log(`\n=== S10 PREP — ${office} (${handle.officeName}), PatNum ${T.PAT_NUM} ===`);
  console.log(`    started: ${new Date().toISOString()}`);
  console.log(`    creating ${T.TARGET_COUNT} disposable targets at $${T.PROC_FEE.toFixed(2)} each (${T.PROC_CODE}).`);
  console.log(`    baseline claim count from the inventory: ${expectedClaims}`);

  /*
   * The patient's chart name, read once.
   *
   * The synthetic 835s must carry a name that MATCHES the chart, or the matcher
   * scores PATIENT_NAME_MISMATCH (-15) and — on the name-search lane — refuses to
   * offer the candidate at all (`claimMatch.DISQUALIFYING_TAGS`). Reading it is
   * strictly better than the alternative, which is a script hard-coding what it
   * believes a test patient is called and being quietly wrong. It goes into the
   * manifest so the 835 generator needs no Open Dental access of its own.
   *
   * 12827 is a designated synthetic fixture. It is written to a gitignored file
   * and it is NOT printed here.
   */
  const patRes = await od.get(`/patients/${T.PAT_NUM}`);
  if (!patRes.ok) {
    console.error(`ABORTING: GET /patients/${T.PAT_NUM} failed (${patRes.status}): ${patRes.error}`);
    console.error('  Nothing was created.');
    process.exitCode = 5;
    return;
  }
  const patLast = String(patRes.data?.LName ?? '').trim();
  const patFirst = String(patRes.data?.FName ?? '').trim();
  if (!patLast) {
    console.error('ABORTING: the patient read back with no surname. Nothing was created.');
    process.exitCode = 5;
    return;
  }
  console.log('    patient name read for the 835 generator (not printed).');

  /*
   * @type {Array<{procNum:number, claimNum:number, claimProcNum:number,
   *               serviceDate:string|null, createdAt:string}>}
   *
   * `serviceDate` is recorded because the 835s are PREP artifacts: they are
   * generated tonight and uploaded on the night of the walk, which may be days
   * later. The matcher scores a service date within DATE_NEAR_DAYS (7) of the
   * chart's (`claimMatch.js`), so the 835 must carry the CLAIM'S date, not the
   * date the generator happened to run. Deriving it from `new Date()` in the
   * generator would silently stop being evidence a week after prep.
   */
  const targets = [];

  // SAFETY 4 — a fixed loop over a frozen count. There is no argument, env var
  // or file that can make this run a third time.
  for (let i = 0; i < T.TARGET_COUNT; i++) {
    const label = String.fromCharCode(65 + i); // A, B
    console.log(`\n-- TARGET ${label} ------------------------------------------------`);

    // SAFETY 7, re-run before EACH create rather than once at the top. The two
    // creates are ~10 s apart; a claim appearing in between is exactly the
    // condition this is watching for, and checking once would miss it.
    const before = await claimCount(od);
    const allowed = expectedClaims + targets.length;
    if (before !== allowed) {
      console.error(
        `\nABORTING: PatNum ${T.PAT_NUM} has ${before} claims; expected ${allowed}\n` +
          `  (${expectedClaims} from the inventory + ${targets.length} created by this run).\n` +
          `  A claim appeared or disappeared since the inventory. Somebody else may be working on\n` +
          `  this patient. NOTHING FURTHER WAS CREATED.`
      );
      if (targets.length) {
        console.error(`  ${targets.length} target(s) were already created; they are listed above and in the manifest below.`);
        break;
      }
      process.exitCode = 6;
      return;
    }
    console.log(`   pre-check: ${before} claims — matches the baseline.`);

    // ── 1. The procedure ────────────────────────────────────────────────────
    const procRes = await od.post('/procedurelogs', {
      PatNum: T.PAT_NUM,
      procCode: T.PROC_CODE,
      ProcStatus: 'C',
      ProcFee: T.PROC_FEE,
      ProvNum: 1,
    });
    if (!procRes.ok) {
      console.error(`\nABORTING: POST /procedurelogs failed (${procRes.status}): ${procRes.error}`);
      console.error('  Nothing was created for this target.');
      process.exitCode = 7;
      break;
    }
    const procNum = Number(procRes.data?.ProcNum);
    if (!Number.isFinite(procNum) || procNum <= 0) {
      console.error(`\nABORTING: POST /procedurelogs answered ${procRes.status} but returned no ProcNum.`);
      console.error('  A 2xx without an id is not a create. Read the patient before running this again.');
      process.exitCode = 7;
      break;
    }
    // G2: read it back. A 201 is a claim about a row, not the row.
    const procBack = await od.get(`/procedurelogs/${procNum}`);
    if (!procBack.ok || Number(procBack.data?.PatNum) !== T.PAT_NUM || String(procBack.data?.ProcStatus) !== 'C') {
      console.error(
        `\nABORTING: procedure ${procNum} did not read back as a completed procedure on ${T.PAT_NUM}.\n` +
          `  status=${procBack.status} ProcStatus=${procBack.data?.ProcStatus} PatNum=${procBack.data?.PatNum}`
      );
      process.exitCode = 7;
      break;
    }
    console.log(`   POST /procedurelogs -> ${procRes.status}  ProcNum=${procNum}  (read back: ProcStatus="${procBack.data?.ProcStatus}", ProcFee=${procBack.data?.ProcFee})`);

    // The chart's own service date, read back rather than assumed. See the
    // `targets` declaration above for why the 835 generator must not derive it.
    const serviceDate = isoDay(procBack.data?.ProcDate);

    // ── 2. The claim ────────────────────────────────────────────────────────
    const claimRes = await od.post('/claims', {
      PatNum: T.PAT_NUM,
      procNums: [procNum],
      ClaimType: 'P',
    });
    if (!claimRes.ok) {
      const msg = String(claimRes.error || '');
      console.error(`\nABORTING: POST /claims failed (${claimRes.status}): ${msg}`);
      if (/plan|patplan|insurance|subscriber|coverage/i.test(msg)) {
        console.error(
          '\n  This looks like a PLAN failure. STOP HERE AND REPORT IT.\n' +
            `  Do NOT touch PatPlanNum ${T.SPIKE_0B_RESIDUE.patPlans[0]} and do NOT add a plan to work around it.\n` +
            '  Adding insurance coverage to a chart is a decision about a patient, and this script\n' +
            '  does not get to make one. RCM_POSTING.md section 10.1 records that 12827 has an active\n' +
            `  plan (PatPlanNum ${T.SPIKE_0B_RESIDUE.patPlans[0]}, 2026-01-01 -> 2026-12-31); if it has lapsed or been\n` +
            '  removed, that is Beau\'s call, not a script\'s.'
        );
      }
      console.error(`\n  Procedure ${procNum} WAS created and is now an orphan $${T.PROC_FEE.toFixed(2)} charge.`);
      console.error('  It is recorded in the manifest below so the unwind can remove it.');
      targets.push({ procNum, claimNum: 0, claimProcNum: 0, serviceDate, createdAt: new Date().toISOString() });
      process.exitCode = 8;
      break;
    }
    const claimNum = Number(claimRes.data?.ClaimNum);
    if (!Number.isFinite(claimNum) || claimNum <= 0) {
      console.error(`\nABORTING: POST /claims answered ${claimRes.status} but returned no ClaimNum.`);
      targets.push({ procNum, claimNum: 0, claimProcNum: 0, serviceDate, createdAt: new Date().toISOString() });
      process.exitCode = 8;
      break;
    }
    const claimBack = await od.get(`/claims/${claimNum}`);
    if (!claimBack.ok || Number(claimBack.data?.PatNum) !== T.PAT_NUM) {
      console.error(`\nABORTING: claim ${claimNum} did not read back on PatNum ${T.PAT_NUM} (status ${claimBack.status}).`);
      targets.push({ procNum, claimNum, claimProcNum: 0, serviceDate, createdAt: new Date().toISOString() });
      process.exitCode = 8;
      break;
    }
    console.log(
      `   POST /claims        -> ${claimRes.status}  ClaimNum=${claimNum}  (read back: ClaimStatus="${claimBack.data?.ClaimStatus}", ClaimFee=${claimBack.data?.ClaimFee})`
    );
    if (String(claimBack.data?.ClaimStatus) !== 'W') {
      console.log(`   ! ClaimStatus is "${claimBack.data?.ClaimStatus}", not the expected "W" (waiting to send). Noted, not fatal.`);
    }

    // ── 3. The auto-created claimproc ───────────────────────────────────────
    const cpRes = await od.get('/claimprocs', { ClaimNum: claimNum });
    if (!cpRes.ok) {
      console.error(`\nABORTING: GET /claimprocs?ClaimNum=${claimNum} failed (${cpRes.status}): ${cpRes.error}`);
      targets.push({ procNum, claimNum, claimProcNum: 0, serviceDate, createdAt: new Date().toISOString() });
      process.exitCode = 9;
      break;
    }
    const lines = (Array.isArray(cpRes.data) ? cpRes.data : []).filter(
      (r) => Number(r.ClaimNum) === claimNum
    );
    if (lines.length !== 1) {
      console.error(
        `\nABORTING: expected exactly 1 claimproc on claim ${claimNum}, found ${lines.length}.\n` +
          '  The drain pairs one 835 line to one ClaimProcNum; anything else here would make the\n' +
          '  walk measure something other than what it is meant to measure.'
      );
      targets.push({ procNum, claimNum, claimProcNum: 0, serviceDate, createdAt: new Date().toISOString() });
      process.exitCode = 9;
      break;
    }
    const claimProcNum = Number(lines[0].ClaimProcNum);
    console.log(
      `   GET  /claimprocs    -> ${cpRes.status}  ClaimProcNum=${claimProcNum}  Status="${lines[0].Status}"  InsPayAmt=${lines[0].InsPayAmt}`
    );
    if (String(lines[0].Status) !== 'NotReceived') {
      console.log(`   ! Status is "${lines[0].Status}", not the expected "NotReceived". Noted, not fatal.`);
    }

    targets.push({ procNum, claimNum, claimProcNum, serviceDate, createdAt: new Date().toISOString() });
  }

  // ── The manifest ──────────────────────────────────────────────────────────
  //
  // Written even on a partial run — ESPECIALLY on a partial run. An abort that
  // leaves a procedure behind and no record of it is the worst outcome available
  // here: the unwind takes ids from this file and from nowhere else, so a row
  // created but unrecorded can never be removed by the tooling that created it.
  fs.mkdirSync(T.OUT_DIR, { recursive: true });
  const manifest = {
    office,
    patNum: T.PAT_NUM,
    patLast,
    patFirst,
    procCode: T.PROC_CODE,
    feeCents: T.PROC_FEE_CENTS,
    baselineClaimCount: expectedClaims,
    createdAt: new Date().toISOString(),
    complete: targets.length === T.TARGET_COUNT && targets.every((t) => t.claimNum && t.claimProcNum),
    targets,
  };
  fs.writeFileSync(T.MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\n-- MANIFEST ---------------------------------------------------------`);
  console.log(`   ${T.MANIFEST_PATH}`);
  console.log(`   complete: ${manifest.complete}`);
  for (const [i, t] of targets.entries()) {
    console.log(
      `   ${String.fromCharCode(65 + i)}: ProcNum=${t.procNum}  ClaimNum=${t.claimNum}  ClaimProcNum=${t.claimProcNum}`
    );
  }
  console.log('\n   Record these ids in docs/RCM_POSTING.md section 10.1.');

  if (!manifest.complete) {
    console.error('\n! THE RUN DID NOT COMPLETE. Read the abort above, then unwind what exists:');
    console.error(`      PROBE_OFFICE=${T.OFFICE} node scripts/rcm-s11-unwind.js            # dry run`);
    console.error(`      PROBE_OFFICE=${T.OFFICE} node scripts/rcm-s11-unwind.js --execute`);
    return;
  }

  console.log(`\nDONE ${new Date().toISOString()}`);
  console.log('NEXT: node scripts/rcm-s10-835.js   (no Open Dental access; reads the manifest)');
}

// Run ONLY when invoked directly. Requiring this file must not write to a chart.
// On 2026-08-24 a script named "read sweep" re-issued every write verb because
// the file it imported called main() at module load. See rcm-s10-targets.js.
if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (e) => {
      console.error('PREP FAILED:', e && e.message);
      process.exit(1);
    }
  );
}

module.exports = { main };
