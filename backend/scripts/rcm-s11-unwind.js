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
 * THE ORDER IS MANDATORY — AND IT CHANGED ON 2026-08-25
 * ─────────────────────────────────────────────────────────────────────────────
 * The four-step order this file shipped with came from the Spike 0b teardown.
 * It was correct for what 0b produced and WRONG for what the drain produces, and
 * the first real §11 run is how that was found:
 *
 *     DELETE /claimpayments/21399 -> 200   (read-back 404, gone)
 *     PUT    /claimprocs/535194   -> 400   "Cannot change Status to NotReceived
 *                                           when attached to a received claim."
 *     DELETE /claims/53784        -> 400   "Claim cannot be deleted. Claim status
 *                                           is Received."
 *     DELETE /procedurelogs/406124-> 400   "Not allowed to delete a procedure
 *                                           that is attached to a claim."
 *
 * **Spike 0b never set the claim to Received. Slice 6c does** — `PUT /claims
 * {ClaimStatus:"R"}` is step 2 of the drain's forced order
 * (`services/rcm/odPostingWrites.js`). So the teardown recipe was written for a
 * claim shape the thing it is meant to tear down never produces. Everything after
 * the check-delete cascaded off that one missing step.
 *
 * The order now, per target:
 *
 *   1. DELETE /claimpayments/{n}   only possible BEFORE an EOB or deposit is
 *                                  attached. Deleting the check does NOT clear
 *                                  the claimproc: InsPayAmt stays put and
 *                                  ClaimPaymentNum resets to 0.
 *   2. PUT /claims/{n}             {ClaimStatus:"W"} — UN-RECEIVE THE CLAIM.
 *                                  The new step. Open Dental's claims reference
 *                                  lists ClaimStatus as updatable, accepting
 *                                  "U" | "H" | "W" | "S" | "R", and documents no
 *                                  restriction on moving back off "R". "W"
 *                                  (waiting in queue) is chosen because it is the
 *                                  status a freshly created claim already has —
 *                                  the prep's own POST lands there — so the claim
 *                                  is returned to its pre-drain shape rather than
 *                                  to some other legal one.
 *   3. PUT /claimprocs/{n}         {Status:"NotReceived", InsPayAmt:0,
 *                                  WriteOff:0, DedApplied:0}. Refused while the
 *                                  claim reads Received, which is why 2 precedes
 *                                  it. The claim is then pinned by the money on
 *                                  its lines until this runs.
 *   4. DELETE /claims/{n}          Refused while the claim reads Received (the
 *                                  reference: "Will not delete claims with
 *                                  insurance payments/checks attached or have a
 *                                  status of Received") — 2 again.
 *   5. DELETE /procedurelogs/{n}   SOFT delete (G12) — see below.
 *
 * If step 2 does not read back as "W", the target STOPS THERE, before any DELETE.
 * A claim that would not un-receive is a claim whose deletes are going to be
 * refused anyway, and issuing them regardless just buries the real reason under
 * three more 400s — which is precisely how the 8/25 transcript reads.
 *
 * A step that fails stops THAT target rather than the run: target B's rows are
 * not held hostage by whatever went wrong on A, and every failure is printed with
 * the reason Open Dental gave.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY STEP IS RESUMABLE, SO THE WHOLE SCRIPT IS RE-RUNNABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * The 8/25 run left 12827 half-unwound: the checks were gone, but the claims were
 * still Received and the claimprocs still carried `InsPayAmt=1` with
 * `ClaimPaymentNum=0`. A teardown script that can only run against a pristine
 * post-walk state is a script that cannot clean up after its own failure.
 *
 * So every step READS FIRST and reports `already done` when the resource is
 * already in its target state — a deleted check, a claim that is no longer
 * Received, a line already at NotReceived/0, a claim that is gone, a procedure
 * already `"D"`. Nothing is issued twice, and a re-run from any partial state
 * finishes the job rather than piling refusals on top of it.
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
 *   6. Every write is READ BACK (G2). A 200 from Open Dental is a claim about a
 *      row, not the row — and the un-receive read-back is load-bearing, because a
 *      200 that did not take would send two DELETEs at a still-Received claim.
 *   7. RESUMABLE. Every step reads before it writes and reports `already done`
 *      rather than re-issuing. The script is safe to run from any partial state.
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
const odOfficeConfig = require('../services/rcm/odOfficeConfig');


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
        PatNum: TARGET.patNum,
        ...(page > 0 ? { Offset: page * T.OD_PAGE_SIZE } : {}),
      });
      if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${res.error}`);
      const batch = Array.isArray(res.data) ? res.data : [];
      // Client-side re-filter: OD silently ignores list filters it does not
      // implement and answers 200 with everybody's rows.
      for (const r of batch) if (Number(r.PatNum) === TARGET.patNum) rows.push(r);
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

// ─── The step machine ────────────────────────────────────────────────────────

/**
 * The five steps, in the only order Open Dental accepts. Exported so the tests
 * assert against the same list the script runs, rather than a copy of it.
 * @type {ReadonlyArray<'payment'|'unreceive'|'line'|'claim'|'procedure'>}
 */
/*
 * `reversal` IS FIRST, and the order is the whole design.
 *
 * A takeback booked as an adjustment sits on the PATIENT's ledger, not on the
 * claim — so deleting the claim would leave the adjustment behind with nothing
 * to explain it, and the ledger would carry a deduction against a claim that no
 * longer exists. Reverse it while its claim is still there to make sense of it.
 */
const STEPS = Object.freeze(['reversal', 'payment', 'unreceive', 'line', 'claim', 'procedure']);

/** Human labels for the summary table. */
const STEP_LABELS = Object.freeze({
  reversal: 'POST offsetting adjustment',
  payment: 'DELETE claimpayment',
  unreceive: 'PUT claim -> W',
  line: 'PUT claimproc -> NotReceived',
  claim: 'DELETE claim',
  procedure: 'DELETE procedurelog',
});

/**
 * The status a claim is returned to.
 *
 * "W" = waiting in queue, which is what `POST /claims` produces (Spike 0b test 1
 * confirmed a new claim defaults to "W", not "U"). Returning the claim to the
 * status it had before the drain touched it means the unwind restores a shape the
 * system already knows how to produce, rather than inventing a legal-but-novel
 * one. The reference's full set is "U" | "H" | "W" | "S" | "R".
 */
const UNRECEIVED_STATUS = 'W';

/**
 * Unwind ONE target, resumably.
 *
 * Split out of `main()` and given its I/O rather than reaching for it, so the
 * order and the idempotence can be driven by a recorded fake in
 * `test/rcmS10Scripts.test.js`. Those are behavioural properties — "step 2 runs
 * before step 3", "a second run issues nothing" — and a source grep cannot
 * express either.
 *
 * @param {{
 *   get: (path: string, params?: Record<string, unknown>) => Promise<{ok:boolean,status:number,data?:any,error?:string}>,
 *   write: (verb: 'PUT'|'DELETE', path: string, body?: Record<string, unknown>) => Promise<{ok:boolean,status:number,data?:any,error?:string,dryRun?:boolean}>,
 *   log: (line: string) => void,
 *   execute: boolean,
 * }} io
 * @param {{ procNum: number, claimNum: number, claimProcNum: number }} target
 * @returns {Promise<{ steps: Record<string, string>, aborted: boolean }>}
 */
async function unwindTarget(io, target) {
  const procNum = Number(target.procNum);
  const claimNum = Number(target.claimNum);
  const claimProcNum = Number(target.claimProcNum);

  /*
   * THE SECOND DRY-RUN GATE.
   *
   * `main()`'s `issue()` already short-circuits when `--execute` is absent, and
   * that was the only gate until this function was split out of it. The split
   * created a trap: `unwindTarget` was handed `io.execute` and never read it, so
   * any caller whose `write` did not implement dry-run itself would have written
   * during what it believed was a dry run. A test harness found that in seconds;
   * a future caller would have found it against a chart.
   *
   * Two independent gates on a path that issues DELETE is proportionate. Reads
   * still happen either way -- that is what lets a dry run report what is already
   * done rather than guess at it.
   */
  const write = async (verb, wpath, body) => {
    if (io.execute === false) {
      io.log(`   [dry run] ${verb} ${wpath}${body ? ' ' + JSON.stringify(body) : ''}`);
      return { ok: true, status: 0, dryRun: true };
    }
    return io.write(verb, wpath, body);
  };

  /** @type {Record<string, string>} */
  const steps = {};
  for (const s of STEPS) steps[s] = 'blocked';
  let aborted = false;

  /**
   * Refuse any id on the deny-list, wherever it came from.
   *
   * The manifest is screened up front, but `payment` acts on a ClaimPaymentNum
   * discovered at RUN time off a live read — so it needs its own check. Applying
   * the same test to every step costs nothing and means no future step can be
   * added that skips it.
   */
  const denied = (id) => DENY.includes(Number(id));

  /*
   * A TARGET IS ALL-OR-NOTHING.
   *
   * `main()` already refuses the whole run when the manifest names a denied id,
   * so this is unreachable through the normal path — and it is here anyway,
   * because a test found the hole it closes. Step 1 discovers its
   * ClaimPaymentNum by READING the claimproc, and it checked only the payment's
   * own id. So a target whose CLAIMPROC was denied would still have had its check
   * deleted, because the check's number was innocent.
   *
   * A manifest naming a spent id did not come from a prep run, so nothing about
   * it can be trusted — not even the parts that look fine. There is no partial
   * cooperation with an untrustworthy list.
   */
  if (denied(procNum) || denied(claimNum) || denied(claimProcNum)) {
    for (const s of STEPS) steps[s] = 'skipped';
    io.log(
      `   SKIPPED ENTIRELY — this target names a denied id (proc ${procNum}, claim ${claimNum},` +
        ` claimproc ${claimProcNum}). Nothing was read past this point, and nothing was written.`
    );
    return { steps, aborted: false };
  }

  /*
   * ── 0. THE TAKEBACK'S ADJUSTMENT — REVERSED, NEVER DELETED ────────────────
   *
   * **`DELETE /adjustments` DOES NOT EXIST** (G6, documented-absence, verified).
   * That is not an oversight in this script: the verb is absent from the Open
   * Dental cloud API, so an adjustment once written cannot be removed by any
   * caller. The only way back is an OFFSETTING adjustment of the opposite sign,
   * which Spike 0b test 8 proved nets the ledger to zero (−1.00 under DefNum 12,
   * reversed by +1.00 under DefNum 260).
   *
   * So the ledger ends where it started, and the patient's chart carries TWO
   * adjustment rows rather than none. That is the honest outcome and it is worth
   * being explicit about: this step returns the MONEY to zero. It does not
   * return the chart to a state where the takeback never happened, because
   * nothing can.
   *
   * The AdjType is resolved BY NAME with its SIGN CHECKED — `pickAdjType`
   * refuses a type whose `ItemValue` says it deducts. A reversal booked under a
   * minus type would double the deduction while reporting success, and the
   * read-back below would be the only thing that noticed.
   */
  if (Number(target.odAdjustmentNum) > 0) {
    const adjNum = Number(target.odAdjustmentNum);
    if (denied(adjNum)) {
      steps.reversal = 'skipped';
      io.log(`   0. reversal     SKIPPED — adjustment ${adjNum} is on the deny-list`);
    } else {
      const orig = await io.get(`/adjustments/${adjNum}`);
      if (!orig.ok) {
        // A reversal we cannot price is a reversal we must not guess at.
        steps.reversal = 'failed';
        aborted = true;
        io.log(`   0. reversal     FAILED — GET /adjustments/${adjNum} -> ${orig.status}`);
      } else {
        const origAmt = Number(orig.data?.AdjAmt);
        const patNum = Number(orig.data?.PatNum);
        io.log(`   read: /adjustments/${adjNum} AdjAmt=${origAmt} PatNum=${patNum} AdjType=${orig.data?.AdjType}`);

        if (!Number.isFinite(origAmt) || origAmt === 0) {
          steps.reversal = 'failed';
          aborted = true;
          io.log(`   0. reversal     FAILED — cannot read an amount to offset`);
        } else if (Number(target.odReversalAdjNum) > 0) {
          // A previous run already posted it. Reversing twice would move the
          // ledger the wrong way by the same amount it moved the right way.
          steps.reversal = 'already done';
          io.log(`   0. reversal     already done — offsetting adjustment ${target.odReversalAdjNum}`);
        } else {
          /*
           * THE ADJTYPE IS RESOLVED BY NAME, AT RUN TIME, WITH ITS SIGN CHECKED.
           *
           * Not a number in a table in this repo. `Insurance adjustment` is 260
           * in Roland and 402 in Riley today, and a DefNum written down here is
           * a number that is right until somebody edits a definitions list in
           * one practice — at which point this script books a reversal under
           * whatever that number now means, in a patient's ledger, silently.
           * Same hard rule the CommLog DefNums and the PayType follow.
           *
           * Resolved ONCE per run in `main()` through the same
           * `odOfficeConfig.pickAdjType(config, 'recoupment_reversal')` the
           * drain uses, which requires the name AND a `+` sign. No handle here
           * means no reversal here.
           */
          const adjType = io.reversalAdjType;
          if (!adjType || !Number(adjType.defNum)) {
            steps.reversal = 'failed';
            aborted = true;
            io.log(
              '   0. reversal     FAILED — this office has no `+` "insurance adjustment" ' +
                'AdjType. Nothing was written.'
            );
            return { steps, aborted };
          }
          io.log(
            `   resolved AdjType: "${adjType.name}" DefNum=${adjType.defNum} (by name, sign +)`
          );

          const r = await write('POST', '/adjustments', {
            PatNum: patNum,
            AdjDate: String(target.serviceDate || '').slice(0, 10),
            AdjAmt: -origAmt,
            AdjType: Number(adjType.defNum),
            AdjNote: 'CareIN S10 walk unwind: offsetting the takeback adjustment',
          });
          if (r.dryRun) {
            steps.reversal = 'pending';
          } else if (!r.ok) {
            steps.reversal = 'failed';
            aborted = true;
            io.log(`   0. reversal     FAILED — POST /adjustments -> ${r.status}`);
          } else {
            /*
             * READ BOTH BACK AND ADD THEM UP. A 200 is not proof (G2), and for
             * this step the proof is not "a row exists" but "the two rows net to
             * zero" — which is the only statement that means the ledger is where
             * it started.
             */
            const newNum = Number(r.data?.AdjNum);
            const back = await io.get(`/adjustments/${newNum}`);
            const backAmt = Number(back.data?.AdjAmt);
            const net = origAmt + backAmt;
            io.log(
              `   read-back: /adjustments/${newNum} AdjAmt=${backAmt}  ` +
                `net ${origAmt} + ${backAmt} = ${net}`
            );
            /*
             * THREE FACTS, NOT ONE (ruling F). "The amounts cancel" is necessary
             * and not sufficient: a row that nets to zero under the WRONG
             * AdjType is a number in the practice's books meaning something
             * nobody chose, and one on the wrong PATIENT is money moved in a
             * stranger's ledger. Both would read as success from the total
             * alone.
             */
            const backType = Number(back.data?.AdjType);
            const backPat = Number(back.data?.PatNum);
            const typeOk = backType === Number(adjType.defNum);
            const patOk = backPat === Number(patNum);
            if (!typeOk || !patOk) {
              io.log(
                `   read-back MISMATCH: AdjType=${backType} (wanted ${adjType.defNum}), ` +
                  `PatNum=${backPat} (wanted ${patNum})`
              );
            }
            if (back.ok && net === 0 && typeOk && patOk) {
              steps.reversal = 'done';
              target.odReversalAdjNum = newNum;
            } else {
              steps.reversal = 'failed';
              aborted = true;
              io.log(
                `   0. reversal     FAILED — the pair does not net to zero (${net}). The ` +
                  `offsetting row ${newNum} is PERMANENT; there is no DELETE /adjustments.`
              );
            }
          }
        }
      }
    }
  } else {
    steps.reversal = 'already done';
    io.log('   0. reversal     nothing to reverse — this target carries no takeback adjustment');
  }

  if (aborted) return { steps, aborted };

  // ── 1. The check ─────────────────────────────────────────────────────────
  let claimPaymentNum = 0;
  if (claimProcNum > 0) {
    const cp = await io.get(`/claimprocs/${claimProcNum}`);
    if (cp.ok) {
      const n = Number(cp.data?.ClaimPaymentNum);
      if (Number.isFinite(n) && n > 0) claimPaymentNum = n;
      io.log(
        `   read: Status="${cp.data?.Status}" InsPayAmt=${cp.data?.InsPayAmt} WriteOff=${cp.data?.WriteOff} ClaimPaymentNum=${cp.data?.ClaimPaymentNum}`
      );
    } else {
      io.log(`   read: GET /claimprocs/${claimProcNum} -> ${cp.status} (${cp.error || ''})`);
    }
  }

  if (claimPaymentNum === 0) {
    // Either the drain never wrote a check, or a previous run already deleted it
    // and Open Dental reset ClaimPaymentNum to 0 — which is exactly the state the
    // 8/25 half-run left behind. Both mean there is nothing to delete.
    steps.payment = 'already done';
    io.log('   1. payment      already done — no ClaimPaymentNum on this line');
  } else if (denied(claimPaymentNum)) {
    steps.payment = 'skipped';
    io.log(`   1. payment      SKIPPED — ClaimPaymentNum ${claimPaymentNum} is on the deny-list`);
  } else {
    const exists = await io.get(`/claimpayments/${claimPaymentNum}`);
    if (!exists.ok && exists.status === 404) {
      steps.payment = 'already done';
      io.log(`   1. payment      already done — /claimpayments/${claimPaymentNum} is gone`);
    } else {
      const r = await write('DELETE', `/claimpayments/${claimPaymentNum}`);
      if (r.dryRun) {
        steps.payment = 'pending';
      } else if (!r.ok) {
        steps.payment = 'failed';
        aborted = true;
      } else {
        const back = await io.get(`/claimpayments/${claimPaymentNum}`);
        io.log(`   read-back: GET /claimpayments/${claimPaymentNum} -> ${back.status} ${back.ok ? 'STILL EXISTS' : 'gone'}`);
        steps.payment = back.ok ? 'failed' : 'done';
        if (back.ok) aborted = true;
      }
    }
  }
  if (aborted) return { steps, aborted };

  // ── 2. Un-receive the claim — THE STEP THE 8/25 RUN WAS MISSING ──────────
  //
  // Both DELETEs below are refused while the claim reads Received, and so is the
  // claimproc PUT. This is the one that unblocks all three.
  if (claimNum > 0 && !denied(claimNum)) {
    const claim = await io.get(`/claims/${claimNum}`);
    if (!claim.ok && claim.status === 404) {
      // Already deleted by an earlier run; steps 2 and 4 are both moot.
      steps.unreceive = 'already done';
      steps.claim = 'already done';
      io.log(`   2. unreceive    already done — /claims/${claimNum} is gone`);
    } else if (String(claim.data?.ClaimStatus) !== 'R') {
      steps.unreceive = 'already done';
      io.log(`   2. unreceive    already done — ClaimStatus is "${claim.data?.ClaimStatus}", not "R"`);
    } else {
      const r = await write('PUT', `/claims/${claimNum}`, { ClaimStatus: UNRECEIVED_STATUS });
      if (r.dryRun) {
        steps.unreceive = 'pending';
      } else if (!r.ok) {
        steps.unreceive = 'failed';
        aborted = true;
      } else {
        /*
         * G2, and it matters more here than anywhere else in this file. A 200
         * that did not take would leave the claim Received, and the two DELETEs
         * after this would each answer 400 — burying the real reason under three
         * refusals, which is exactly how the 8/25 transcript reads. Stop instead.
         */
        const back = await io.get(`/claims/${claimNum}`);
        const status = String(back.data?.ClaimStatus);
        io.log(`   read-back: GET /claims/${claimNum} -> ${back.status} ClaimStatus="${status}"`);
        if (back.ok && status === UNRECEIVED_STATUS) {
          steps.unreceive = 'done';
        } else {
          steps.unreceive = 'failed';
          aborted = true;
          io.log(
            `   ! the claim did not un-receive (wanted "${UNRECEIVED_STATUS}", read "${status}").` +
              ' STOPPING this target before any DELETE — they would only 400.'
          );
        }
      }
    }
  } else if (claimNum > 0) {
    steps.unreceive = 'skipped';
    io.log(`   2. unreceive    SKIPPED — ClaimNum ${claimNum} is on the deny-list`);
  } else {
    steps.unreceive = 'already done';
    steps.claim = 'already done';
  }
  if (aborted) return { steps, aborted };

  // ── 3. The line, back to NotReceived ─────────────────────────────────────
  if (claimProcNum > 0 && !denied(claimProcNum)) {
    const cp = await io.get(`/claimprocs/${claimProcNum}`);
    const clean =
      cp.ok &&
      String(cp.data?.Status) === 'NotReceived' &&
      cents(cp.data?.InsPayAmt) === 0 &&
      cents(cp.data?.WriteOff) === 0 &&
      cents(cp.data?.DedApplied) === 0;
    if (!cp.ok && cp.status === 404) {
      steps.line = 'already done';
      io.log(`   3. line         already done — /claimprocs/${claimProcNum} is gone`);
    } else if (clean) {
      steps.line = 'already done';
      io.log('   3. line         already done — Status="NotReceived" and every amount is 0');
    } else {
      const r = await write('PUT', `/claimprocs/${claimProcNum}`, {
        Status: 'NotReceived',
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
      });
      if (r.dryRun) {
        steps.line = 'pending';
      } else if (!r.ok) {
        steps.line = 'failed';
        aborted = true;
      } else {
        const back = await io.get(`/claimprocs/${claimProcNum}`);
        io.log(
          `   read-back: Status="${back.data?.Status}" InsPayAmt=${back.data?.InsPayAmt} WriteOff=${back.data?.WriteOff}`
        );
        if (back.ok && String(back.data?.Status) === 'NotReceived' && cents(back.data?.InsPayAmt) === 0) {
          steps.line = 'done';
        } else {
          steps.line = 'failed';
          aborted = true;
          io.log('   ! THE PUT DID NOT TAKE (G2). The claim stays pinned by the money on its line.');
        }
      }
    }
  } else if (claimProcNum > 0) {
    steps.line = 'skipped';
  } else {
    steps.line = 'already done';
  }
  if (aborted) return { steps, aborted };

  // ── 4. The claim ─────────────────────────────────────────────────────────
  if (steps.claim !== 'already done' && claimNum > 0 && !denied(claimNum)) {
    const claim = await io.get(`/claims/${claimNum}`);
    if (!claim.ok && claim.status === 404) {
      steps.claim = 'already done';
      io.log(`   4. claim        already done — /claims/${claimNum} is gone`);
    } else {
      const r = await write('DELETE', `/claims/${claimNum}`);
      if (r.dryRun) {
        steps.claim = 'pending';
      } else if (!r.ok) {
        steps.claim = 'failed';
        aborted = true;
      } else {
        const back = await io.get(`/claims/${claimNum}`);
        io.log(`   read-back: GET /claims/${claimNum} -> ${back.status} ${back.ok ? 'STILL EXISTS' : 'gone'}`);
        steps.claim = back.ok ? 'failed' : 'done';
        if (back.ok) aborted = true;
      }
    }
  } else if (claimNum > 0 && denied(claimNum)) {
    steps.claim = 'skipped';
  }
  if (aborted) return { steps, aborted };

  // ── 5. The procedure — SOFT delete (G12) ─────────────────────────────────
  if (procNum > 0 && !denied(procNum)) {
    const proc = await io.get(`/procedurelogs/${procNum}`);
    if (!proc.ok && proc.status === 404) {
      // Not expected — the delete is soft — but "gone" is still not "to do".
      steps.procedure = 'already done';
      io.log(`   5. procedure    already done — /procedurelogs/${procNum} is gone`);
    } else if (String(proc.data?.ProcStatus) === 'D') {
      steps.procedure = 'already done';
      io.log(`   5. procedure    already done — ProcStatus is already "D"`);
    } else {
      const r = await write('DELETE', `/procedurelogs/${procNum}`);
      if (r.dryRun) {
        steps.procedure = 'pending';
      } else if (!r.ok) {
        steps.procedure = 'failed';
        aborted = true;
      } else {
        const back = await io.get(`/procedurelogs/${procNum}`);
        const ps = String(back.data?.ProcStatus);
        // G12: the row is EXPECTED to still be there, reading "D". A read-back
        // that said "gone" would mean something other than a delete happened.
        io.log(
          `   read-back: GET /procedurelogs/${procNum} -> ${back.status} ProcStatus="${ps}"` +
            (ps === 'D' ? '  (soft delete, as documented — G12)' : '  ! NOT "D"')
        );
        steps.procedure = ps === 'D' ? 'done' : 'failed';
        if (ps !== 'D') aborted = true;
      }
    }
  } else if (procNum > 0) {
    steps.procedure = 'skipped';
  } else {
    steps.procedure = 'already done';
  }

  return { steps, aborted };
}

async function main() {
  // FIRST. See rcm-s10-inventory.js for what a script that cannot load its own
  // secrets costs at a live chart database.
  await require('../config/secrets').loadSecrets();

  const execute = process.argv.includes('--execute');

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

  // SAFETY 1 — the manifest is the ONLY authority.
  if (!fs.existsSync(PATHS.manifestPath)) {
    console.error(
      `REFUSED: no manifest at\n  ${PATHS.manifestPath}\n` +
        '  This script deletes only what the prep script recorded creating. No manifest means\n' +
        '  this walk created nothing, so there is nothing here to unwind. It will NOT go looking\n' +
        "  for rows to remove: an unwind that reads a live chart for its targets is a script that\n" +
        '  can delete a real claim.'
    );
    process.exitCode = 3;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(PATHS.manifestPath, 'utf8'));
  if (manifest.office !== TARGET.office || Number(manifest.patNum) !== TARGET.patNum) {
    console.error(
      `REFUSED: the manifest is for office='${manifest.office}' patNum=${manifest.patNum}; ` +
        `this script is '${TARGET.office}'/${TARGET.patNum} only.`
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
      if (DENY.includes(id)) denied.push(`${field}=${id}`);
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

  console.log(`\n=== S11 UNWIND — ${office} (${handle.officeName}), PatNum ${TARGET.patNum} ===`);
  console.log(`    mode: ${execute ? '*** EXECUTE — THIS WILL WRITE ***' : 'DRY RUN (pass --execute to write)'}`);
  console.log(`    started: ${new Date().toISOString()}`);
  console.log(`    manifest: ${PATHS.manifestPath}`);
  console.log(`    baseline claim count recorded at prep: ${manifest.baselineClaimCount}`);

  const before = await balanceOf(get);
  printBalance('BEFORE', before);

  /*
   * ─── THE REVERSAL ADJTYPE, RESOLVED ONCE, BY NAME ─────────────────────────
   *
   * Resolved here rather than per target, because five paced reads of a
   * practice's definitions list is six seconds a two-target unwind should spend
   * once. Resolved AT ALL only when a target actually carries a takeback
   * adjustment — an ordinary unwind should cost no definitions read.
   *
   * A failure here is NOT fatal to the run: the reversal step reports `failed`
   * for the targets that need it and the rest of the unwind is unaffected. What
   * it must never do is proceed with a guess.
   */
  let reversalAdjType = null;
  const needsReversal = (manifest.targets || []).some((t) => Number(t.odAdjustmentNum) > 0);
  if (needsReversal) {
    try {
      const resolved = await odOfficeConfig.resolvePostingConfig(get, office);
      reversalAdjType = odOfficeConfig.pickAdjType(resolved.config, 'recoupment_reversal');
      console.log(
        reversalAdjType
          ? `    reversal AdjType: "${reversalAdjType.name}" DefNum=${reversalAdjType.defNum} ` +
              `— resolved from ${office}'s OWN definitions, by name, sign +`
          : `    reversal AdjType: NONE — ${office} has no '+' "insurance adjustment". ` +
              'Any target needing a reversal will refuse.'
      );
    } catch (err) {
      console.log(
        `    reversal AdjType: UNRESOLVED — ${err && err.message ? err.message : err}. ` +
          'Any target needing a reversal will refuse.'
      );
    }
  }

  /**
   * Issue one write, or describe it. `--execute` is the only thing that makes
   * this touch the network.
   * `POST` IS HERE FOR EXACTLY ONE CALLER: the reversal's offsetting adjustment.
   * It was missing when that step was written, and `verb === 'DELETE' ? delete :
   * put` would have sent it as a **PUT to `/adjustments`** — a different verb at
   * a collection endpoint, which Open Dental answers with a 400 that reads like
   * a permission problem. Enumerated rather than defaulted, so the next verb
   * somebody adds has to be named too.
   *
   * @param {'DELETE'|'PUT'|'POST'} verb
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
      const res =
        verb === 'DELETE'
          ? await axios.delete(path)
          : verb === 'POST'
            ? await axios.post(path, body)
            : await axios.put(path, body);
      console.log(`   ${verb} ${path} -> ${res.status}`);
      return { ok: true, status: res.status, data: res.data, dryRun: false };
    } catch (err) {
      const status = err.response?.status ?? 0;
      const raw = err.response?.data;
      const msg = (typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : err.message).slice(0, 300);
      console.log(`   ${verb} ${path} -> ${status} FAILED`);
      console.log(`       ${msg}`);
      return { ok: false, status, dryRun: false };
    }
  }

  /** @type {Array<{label:string, target:object, steps:Record<string,string>, aborted:boolean}>} */
  const results = [];
  for (const [i, target] of (manifest.targets || []).entries()) {
    const label = String.fromCharCode(65 + i);
    console.log(
      `\n-- TARGET ${label}: ProcNum=${target.procNum} ClaimNum=${target.claimNum} ClaimProcNum=${target.claimProcNum} --`
    );
    const io = {
      get,
      write: issue,
      log: (line) => console.log(line),
      execute,
      reversalAdjType,
    };
    const outcome = await unwindTarget(io, target);
    results.push({ label, target, ...outcome });
  }

  const after = await balanceOf(get);
  printBalance(execute ? 'AFTER' : 'AFTER (unchanged — dry run)', after);

  /*
   * ── The per-step table ───────────────────────────────────────────────────
   *
   * Added after the 8/25 run, whose transcript said what each CALL returned but
   * never what STATE the patient ended in. Reading "400, 400, 400" and working
   * out that target A still had a Received claim, a paid line and a live
   * procedure took longer than it should have. Now the last thing printed is the
   * answer to "what is left to do", per target, per step.
   */
  console.log('\n-- STEPS ------------------------------------------------------------');
  const widest = Math.max(...STEPS.map((s) => STEP_LABELS[s].length));
  console.log('   ' + 'step'.padEnd(widest + 4) + results.map((r) => r.label.padEnd(14)).join(''));
  console.log('   ' + '-'.repeat(widest + 4 + results.length * 14));
  for (const step of STEPS) {
    console.log(
      '   ' +
        STEP_LABELS[step].padEnd(widest + 4) +
        results.map((r) => String(r.steps[step] ?? '-').padEnd(14)).join('')
    );
  }
  const stuck = results.filter((r) => r.aborted);
  if (stuck.length) {
    console.log(
      `   ! ${stuck.map((r) => r.label).join(', ')} stopped early. Read that target's output above;` +
        ' re-running is safe — every finished step reports "already done" and issues nothing.'
    );
  }

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

module.exports = { main, unwindTarget, balanceOf, cents, money, STEPS, STEP_LABELS, UNRECEIVED_STATUS };
