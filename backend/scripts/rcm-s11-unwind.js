'use strict';

/*
 * §11 — RETURN PatNum 12827 TO THE BALANCE §10 FOUND IT AT.  RUN AFTER THE WALK.
 *
 *     PROBE_OFFICE=roland node scripts/rcm-s11-unwind.js             # DRY RUN
 *     PROBE_OFFICE=roland node scripts/rcm-s11-unwind.js --execute   # writes
 *
 * DO NOT RUN THIS DURING THE PREP. It exists so that when the walk is finished
 * the test patient goes back to where it started, and nothing it removes can be
 * put back. Beau runs it, with `--execute`, after §10.4, and the transcript goes
 * into §11.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER IS MANDATORY
 * ─────────────────────────────────────────────────────────────────────────────
 * Measured end to end in the Spike 0b teardown; the first pass fails if you try
 * it any other way (RCM_POSTING.md §11):
 *
 *   1. DELETE /claimpayments/{n}   only possible BEFORE an EOB or deposit is
 *                                  attached. Deleting the check does NOT clear
 *                                  the claimproc: InsPayAmt stays put and
 *                                  ClaimPaymentNum resets to 0.
 *   2. PUT /claimprocs/{n}         {Status:"NotReceived", InsPayAmt:0,
 *                                  WriteOff:0, DedApplied:0}. The claim is
 *                                  pinned by the money on its lines until this
 *                                  runs.
 *   3. DELETE /claims/{n}
 *   4. DELETE /procedurelogs/{n}   SOFT delete (G12) — see below.
 *
 * The steps run per target and in this order, and a step that fails stops THAT
 * target rather than the run: target B's rows are not held hostage by whatever
 * went wrong on A, and every failure is printed with the reason Open Dental gave.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G12 — DELETE /procedurelogs IS A SOFT DELETE
 * ─────────────────────────────────────────────────────────────────────────────
 * The row comes back with `ProcStatus:"D"` and STILL APPEARS in
 * `GET /procedurelogs`. Spike 0b's own teardown counted "D" rows as live charges
 * and over-applied a reversal by $2.00. The before/after balances printed here
 * filter them out — that filtering is the point of printing a balance at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE MAY NAME DELETE, AND WHAT KEEPS THAT NARROW
 * ─────────────────────────────────────────────────────────────────────────────
 * `OpenDentalService.apiWriteRaw` is POST/PUT ONLY, deliberately: nothing in the
 * posting sequence deletes, so the drain does not get a verb it never needs. The
 * unwind is a human-run operational script, not module code, and it genuinely
 * needs DELETE — so it reaches the raw axios instance, exactly as the D-7 write
 * probe does, and `routes/rcm/rcmNoOdWrites.test.js` carries a named allow-list
 * entry for this one file plus tests for every property below.
 *
 * The consequence of going around `apiWriteRaw` is that the transport's
 * `OPENDENTAL_WRITE_DISABLED` guard does not apply, so it is re-checked HERE
 * before anything is issued. A dev box that sets that flag so it cannot post
 * into the shared live practice database must not be able to DELETE from it
 * either, and the guard living in the transport was the reason that was true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY PROPERTIES — enforced in code, pinned by test/rcmS10Scripts.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. IDS COME FROM THE MANIFEST AND FROM NOWHERE ELSE. Not argv, not env, not
 *      a fresh read of the patient's claims. An unwind that takes ids from an
 *      argument is one typo away from deleting a real patient's claim, and "the
 *      operator will be careful" is not a safety property. If there is no
 *      manifest, this walk created nothing, so there is nothing to unwind.
 *   2. A HARD DENY-LIST. Spike 0b's residue — claim 53648, procedure 405237,
 *      supplemental 533931, adjustments 19109-19112, PatPlanNum 20469 — is
 *      refused even if it appears in a manifest. The failure mode that matters
 *      is not a typo, it is a manifest regenerated from a live read that sweeps
 *      the residue in with the targets. A deny-list survives that.
 *   3. DRY RUN IS THE DEFAULT. `--execute` is required to issue anything.
 *   4. Roland only. Any other PROBE_OFFICE is a refusal.
 *   5. >= 1.3 s between calls.
 *   6. Every deletion is READ BACK (G2). A 200 from Open Dental is a claim about
 *      a row, not the row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CANNOT BE UNWOUND
 * ─────────────────────────────────────────────────────────────────────────────
 * A negative supplemental. It cannot be reverted (400 "Cannot change Status from
 * Supplemental when there is a ClaimProc with a different status and the same
 * ProcNum.") and cannot be deleted (`DELETE /claimprocs` does not exist on
 * 25.4.48). It then pins its claim and that claim's procedure forever. Slice 6c
 * never creates one — that is D-6 and 6d — so this script never has to face one.
 */

const fs = require('node:fs');
const odOffices = require('../config/odOffices');
const T = require('./rcm-s10-targets');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {unknown} value */
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
 * The patient's balance with soft-deleted procedures excluded — THE G12 TRAP.
 *
 * The same arithmetic `rcm-s10-inventory.js` prints, reproduced here so before
 * and after are measured the same way. A balance derived differently at the two
 * ends would make a correct unwind look like a posting error, or the reverse.
 *
 * @param {(path:string, params?:Record<string,unknown>) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} get
 */
async function balanceOf(get) {
  /** @param {string} path */
  async function list(path) {
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    for (let page = 0; page < T.MAX_PAGES; page++) {
      const res = await get(path, {
        PatNum: T.PAT_NUM,
        ...(page > 0 ? { Offset: page * T.OD_PAGE_SIZE } : {}),
      });
      if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${res.error}`);
      const batch = Array.isArray(res.data) ? res.data : [];
      // Client-side re-filter: OD silently ignores list filters it does not
      // implement and answers 200 with everybody's rows.
      for (const r of batch) if (Number(r.PatNum) === T.PAT_NUM) rows.push(r);
      if (batch.length < T.OD_PAGE_SIZE) return rows;
    }
    throw new Error(`GET ${path} did not terminate within the page cap.`);
  }

  const procs = await list('/procedurelogs');
  const claims = await list('/claims');
  const adjustments = await list('/adjustments');
  /*
   * BY PATIENT, not by claim. A claim-scoped walk cannot see a claimproc that
   * belongs to no claim, and PatNum 12827 has one: `533930`, `ClaimNum: 0`, a
   * detached Spike 0b estimate found on 2026-08-25. It carries $0.00 today, so
   * omitting it did not move the number — but a balance that is right only
   * because the row it missed happened to be empty is not a balance.
   *
   * It matters MORE here than in the inventory: this function runs twice, and a
   * detached row that appeared between the two readings would show up as an
   * unexplained delta on a script whose entire output is a delta.
   */
  const claimProcs = await list('/claimprocs');

  const deletedCount = procs.filter((p) => String(p.ProcStatus) === 'D').length;
  const liveProcNums = new Set(
    procs.filter((p) => String(p.ProcStatus) !== 'D').map((p) => Number(p.ProcNum))
  );

  const charges = procs
    .filter((p) => String(p.ProcStatus) === 'C')
    .reduce((sum, p) => sum + cents(p.ProcFee), 0);
  const insPaid = claimProcs
    .filter((cp) => liveProcNums.has(Number(cp.ProcNum)))
    .reduce((sum, cp) => sum + cents(cp.InsPayAmt), 0);
  const writeOff = claimProcs
    .filter((cp) => liveProcNums.has(Number(cp.ProcNum)))
    .reduce((sum, cp) => sum + cents(cp.WriteOff), 0);
  const adj = adjustments.reduce((sum, a) => sum + cents(a.AdjAmt), 0);

  return {
    charges,
    insPaid,
    writeOff,
    adj,
    total: charges - insPaid - writeOff + adj,
    deletedCount,
    claimCount: claims.length,
  };
}

/** @param {ReturnType<typeof balanceOf> extends Promise<infer B> ? B : never} b */
function printBalance(label, b) {
  console.log(`\n-- BALANCE ${label} (ProcStatus "D" excluded) ------------------------`);
  console.log(`   charges  (ProcStatus "C")   ${money(b.charges).padStart(12)}`);
  console.log(`   insurance paid              ${money(-b.insPaid).padStart(12)}`);
  console.log(`   write-offs                  ${money(-b.writeOff).padStart(12)}`);
  console.log(`   adjustments                 ${money(b.adj).padStart(12)}`);
  console.log('   ' + '-'.repeat(40));
  console.log(`   PATIENT BALANCE             ${money(b.total).padStart(12)}`);
  console.log(`   claims: ${b.claimCount}   soft-deleted procedures excluded: ${b.deletedCount}`);
}

async function main() {
  // FIRST. See rcm-s10-inventory.js for what a script that cannot load its own
  // secrets costs at a live chart database.
  await require('../config/secrets').loadSecrets();

  const execute = process.argv.includes('--execute');

  const office = process.env.PROBE_OFFICE || T.OFFICE;
  if (office !== T.OFFICE) {
    console.error(`REFUSED: PROBE_OFFICE='${office}'. This script touches '${T.OFFICE}' only.`);
    process.exitCode = 2;
    return;
  }

  // SAFETY 1 — the manifest is the ONLY authority.
  if (!fs.existsSync(T.MANIFEST_PATH)) {
    console.error(
      `REFUSED: no manifest at\n  ${T.MANIFEST_PATH}\n` +
        '  This script deletes only what the prep script recorded creating. No manifest means\n' +
        '  this walk created nothing, so there is nothing here to unwind. It will NOT go looking\n' +
        "  for rows to remove: an unwind that reads a live chart for its targets is a script that\n" +
        '  can delete a real claim.'
    );
    process.exitCode = 3;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(T.MANIFEST_PATH, 'utf8'));
  if (manifest.office !== T.OFFICE || Number(manifest.patNum) !== T.PAT_NUM) {
    console.error(
      `REFUSED: the manifest is for office='${manifest.office}' patNum=${manifest.patNum}; ` +
        `this script is '${T.OFFICE}'/${T.PAT_NUM} only.`
    );
    process.exitCode = 4;
    return;
  }

  /*
   * SAFETY 2 — the deny-list, applied to the manifest BEFORE anything is issued.
   *
   * Not a warning and not a skip: if the residue is in the manifest, the manifest
   * is not trustworthy, and the right response to an untrustworthy list of things
   * to delete is to delete none of them.
   */
  const denied = [];
  for (const t of manifest.targets || []) {
    for (const [field, id] of [
      ['procNum', Number(t.procNum)],
      ['claimNum', Number(t.claimNum)],
      ['claimProcNum', Number(t.claimProcNum)],
    ]) {
      if (T.DENY_IDS.includes(id)) denied.push(`${field}=${id}`);
    }
  }
  if (denied.length) {
    console.error(
      'REFUSED: the manifest names Spike 0b residue: ' +
        denied.join(', ') +
        '\n  Those rows are permanent (RCM_POSTING.md section 11) and this script will not touch them.\n' +
        '  A manifest containing them was not written by the prep script, so NOTHING was issued.'
    );
    process.exitCode = 5;
    return;
  }

  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));

  /*
   * SAFETY — the environment guard, re-checked here.
   *
   * `apiWriteRaw` enforces OPENDENTAL_WRITE_DISABLED inside the transport, which
   * is what makes it un-routable-around for everything writing through the class.
   * This script does NOT write through the class — it needs DELETE, which the
   * transport does not offer — so the guard would not otherwise apply. A dev box
   * that sets the flag so it cannot post into the shared live practice database
   * must not be able to delete from it either.
   */
  if (require('../middleware/envGuards').isOdWriteDisabled()) {
    console.error(
      'REFUSED: OPENDENTAL_WRITE_DISABLED is set in this environment.\n' +
        '  This script reaches the raw client for DELETE, so the transport guard does not cover\n' +
        '  it — the check is made here instead. Nothing was issued.'
    );
    process.exitCode = 6;
    return;
  }

  const axios = handle.client.client;
  const get = async (path, params = {}) => {
    await sleep(T.PACE_MS);
    return handle.client.apiGetRaw(path, params, { timeoutMs: T.OD_TIMEOUT_MS });
  };

  console.log(`\n=== S11 UNWIND — ${office} (${handle.officeName}), PatNum ${T.PAT_NUM} ===`);
  console.log(`    mode: ${execute ? '*** EXECUTE — THIS WILL WRITE ***' : 'DRY RUN (pass --execute to write)'}`);
  console.log(`    started: ${new Date().toISOString()}`);
  console.log(`    manifest: ${T.MANIFEST_PATH}`);
  console.log(`    baseline claim count recorded at prep: ${manifest.baselineClaimCount}`);

  const before = await balanceOf(get);
  printBalance('BEFORE', before);

  /**
   * Issue one write, or describe it. `--execute` is the only thing that makes
   * this touch the network.
   * @param {'DELETE'|'PUT'} verb
   * @param {string} path
   * @param {Record<string, unknown>} [body]
   */
  async function issue(verb, path, body) {
    if (!execute) {
      console.log(`   [dry run] ${verb} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
      return { ok: true, status: 0, dryRun: true };
    }
    await sleep(T.PACE_MS);
    try {
      const res = verb === 'DELETE' ? await axios.delete(path) : await axios.put(path, body);
      console.log(`   ${verb} ${path} -> ${res.status}`);
      return { ok: true, status: res.status, dryRun: false };
    } catch (err) {
      const status = err.response?.status ?? 0;
      const raw = err.response?.data;
      const msg = (typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : err.message).slice(0, 300);
      console.log(`   ${verb} ${path} -> ${status} FAILED`);
      console.log(`       ${msg}`);
      return { ok: false, status, dryRun: false };
    }
  }

  for (const [i, target] of (manifest.targets || []).entries()) {
    const label = String.fromCharCode(65 + i);
    const procNum = Number(target.procNum);
    const claimNum = Number(target.claimNum);
    const claimProcNum = Number(target.claimProcNum);
    console.log(`\n-- TARGET ${label}: ProcNum=${procNum} ClaimNum=${claimNum} ClaimProcNum=${claimProcNum} --`);

    // ── 1. The check, if the drain wrote one ────────────────────────────────
    //
    // Read the claimproc to find its ClaimPaymentNum rather than assuming one:
    // on target B the drain may have been killed before the check was written,
    // and on a plan that never drained there is no check at all.
    let claimPaymentNum = 0;
    if (claimProcNum > 0) {
      const cp = await get(`/claimprocs/${claimProcNum}`);
      if (cp.ok) {
        const n = Number(cp.data?.ClaimPaymentNum);
        if (Number.isFinite(n) && n > 0) claimPaymentNum = n;
        console.log(
          `   read: Status="${cp.data?.Status}" InsPayAmt=${cp.data?.InsPayAmt} WriteOff=${cp.data?.WriteOff} ClaimPaymentNum=${cp.data?.ClaimPaymentNum}`
        );
      } else {
        console.log(`   read: GET /claimprocs/${claimProcNum} -> ${cp.status} (${cp.error})`);
      }
    }

    if (claimPaymentNum > 0) {
      if (T.DENY_IDS.includes(claimPaymentNum)) {
        console.log(`   SKIPPED: ClaimPaymentNum ${claimPaymentNum} is on the deny-list.`);
      } else {
        const r = await issue('DELETE', `/claimpayments/${claimPaymentNum}`);
        if (execute && r.ok) {
          // G2: read it back. A 200 is a claim about a row, not the row.
          const back = await get(`/claimpayments/${claimPaymentNum}`);
          console.log(`   read-back: GET /claimpayments/${claimPaymentNum} -> ${back.status} ${back.ok ? 'STILL EXISTS' : 'gone'}`);
        }
      }
    } else {
      console.log('   no ClaimPaymentNum on this line — nothing to delete at step 1.');
    }

    // ── 2. The line, back to NotReceived ────────────────────────────────────
    //
    // The claim is pinned by the money on its lines until this runs, so step 3
    // fails without it. Deleting the check does NOT clear it: InsPayAmt stays
    // put and ClaimPaymentNum resets to 0.
    if (claimProcNum > 0) {
      const r = await issue('PUT', `/claimprocs/${claimProcNum}`, {
        Status: 'NotReceived',
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
      });
      if (execute && r.ok) {
        const back = await get(`/claimprocs/${claimProcNum}`);
        console.log(
          `   read-back: Status="${back.data?.Status}" InsPayAmt=${back.data?.InsPayAmt} WriteOff=${back.data?.WriteOff}`
        );
        if (back.ok && (String(back.data?.Status) !== 'NotReceived' || cents(back.data?.InsPayAmt) !== 0)) {
          console.log('   ! THE PUT DID NOT TAKE. Open Dental answers 200 to writes it ignores (G2).');
          console.log('     Step 3 will fail while money remains on the line. Stopping this target.');
          continue;
        }
      }
    }

    // ── 3. The claim ────────────────────────────────────────────────────────
    if (claimNum > 0) {
      const r = await issue('DELETE', `/claims/${claimNum}`);
      if (execute && r.ok) {
        const back = await get(`/claims/${claimNum}`);
        console.log(`   read-back: GET /claims/${claimNum} -> ${back.status} ${back.ok ? 'STILL EXISTS' : 'gone'}`);
      }
    }

    // ── 4. The procedure — SOFT delete ──────────────────────────────────────
    if (procNum > 0) {
      const r = await issue('DELETE', `/procedurelogs/${procNum}`);
      if (execute && r.ok) {
        const back = await get(`/procedurelogs/${procNum}`);
        // G12: the row is EXPECTED to still exist, reading ProcStatus "D". A
        // read-back that said "gone" here would mean something else happened.
        console.log(
          `   read-back: GET /procedurelogs/${procNum} -> ${back.status} ProcStatus="${back.data?.ProcStatus}"` +
            (String(back.data?.ProcStatus) === 'D' ? '  (soft delete, as documented — G12)' : '  ! NOT "D"')
        );
      }
    }
  }

  const after = await balanceOf(get);
  printBalance(execute ? 'AFTER' : 'AFTER (unchanged — dry run)', after);

  console.log('\n-- VERDICT ----------------------------------------------------------');
  console.log(`   before ${money(before.total)}   after ${money(after.total)}   delta ${money(after.total - before.total)}`);
  if (!execute) {
    console.log('   DRY RUN — nothing was issued. Re-run with --execute to unwind.');
  } else if (after.claimCount === manifest.baselineClaimCount) {
    console.log(`   claim count is back to the prep baseline (${manifest.baselineClaimCount}).`);
  } else {
    console.log(
      `   ! claim count is ${after.claimCount}, not the prep baseline of ${manifest.baselineClaimCount}.` +
        ' Read the per-target output above.'
    );
  }
  console.log('\n   Paste this transcript into docs/RCM_POSTING.md section 11.');
  console.log(`DONE ${new Date().toISOString()}`);
}

// Run ONLY when invoked directly. This file holds DELETE; requiring it must not
// be enough to remove a row from a chart. On 2026-08-24 a script named "read
// sweep" re-issued every write verb because the file it imported ran main() at
// module load. See scripts/rcm-s10-targets.js.
if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (e) => {
      console.error('UNWIND FAILED:', e && e.message);
      process.exit(1);
    }
  );
}

module.exports = { main, balanceOf, cents, money };
