'use strict';

/*
 * The constants the four §10/§11 scripts must agree on, AND NOTHING ELSE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * Same lesson as `rcm-d7-ghost.js`, learned the same way. The D-7 read sweep got
 * its shared id by importing the write probe, the probe called `main()` at module
 * load, and so a script named "read sweep" re-issued every write verb on
 * 2026-08-24. The static guard could not see it: the verbs sat in the one file
 * that legitimately owns them.
 *
 * The inventory, the prep, the 835 generator and the unwind all need the same
 * patient, the same office and the same manifest path. None of them may import
 * another, because two of them write and one of them DELETEs. So the agreement
 * lives here: constants and one pure helper, from `node:fs` and `node:path`
 * only, with NO top-level call. There is nothing here that importing could run.
 *
 * Everything in this file is a decision, not a default. Read the reasons before
 * changing a value.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The ONLY office these scripts will touch.
 *
 * Roland, hard-coded, because valley is fail-closed until D-7 is discharged
 * (`docs/RCM_POSTING.md` §9) and because PatNum 7115 — valley's test patient —
 * is 6d's, not this walk's. `PROBE_OFFICE` is still read so the invocation
 * matches the D-7 probes an operator has already run, but any value other than
 * this one is a REFUSAL rather than a redirect. Same stance as hard rule 2 on
 * the voice side: an office in a parameter is an assertion that can only cause a
 * refusal, never a change of destination.
 * @type {string}
 */
const OFFICE = 'roland';

/**
 * The disposable target patient. Roland's, and Roland's only —
 * PatNum 7115 is a DIFFERENT, REAL person in Roland's database than it is in
 * Riley's, which is the whole reason the per-office layer exists. A PatNum
 * without an office is not an address.
 * @type {number}
 */
const PAT_NUM = 12827;

/** The disposable procedure: a limited exam, one dollar, so a mis-post is a dollar. */
const PROC_CODE = 'D0140';

/** Dollars. Hard-coded — nothing about this walk should be parameterised by amount. */
const PROC_FEE = 1.0;

/** Cents, for the 835 and for arithmetic that must not touch a float. */
const PROC_FEE_CENTS = 100;

/** Exactly two targets: one for §10.2's walk, one for §10.3's kill-mid-drain. */
const TARGET_COUNT = 2;

/**
 * Milliseconds between consecutive Open Dental calls in any of these scripts.
 *
 * Open Dental's published rate is 1 req/s and the credential is SHARED with the
 * live phone path and TC (decision D-8, `services/rcm/odPacer.js`). These scripts
 * do not go through the RCM pacer — they are operational scripts, not module
 * code — so they hold themselves to the same floor by hand, exactly as the two
 * D-7 probes do.
 * @type {number}
 */
const PACE_MS = 1300;

/**
 * Where the manifest and the two 835s land.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `/data`, NOT `scripts/out` — MEASURED 2026-08-25
 * ─────────────────────────────────────────────────────────────────────────────
 * This was `path.join(__dirname, 'out')`, which is `/app/scripts/out` in the
 * container. The first prep run died on it:
 *
 *     EACCES: permission denied, mkdir '/app/scripts/out'
 *
 * **`/app` is read-only to the non-root user the container runs as.** The image
 * is not a scratch directory, and treating it as one is how a script works on a
 * workstation and fails in the only place it is ever actually run.
 *
 * `/data` is the AzureFile volume — the same mount `CALLSTORE_DIR` uses in prod
 * and staging. That matters beyond writability: **§10.3 deliberately kills and
 * restarts the container mid-drain**, and days may pass between the walk and the
 * §11 unwind. A manifest on the ephemeral container layer would be gone by the
 * time the thing it describes needed removing — leaving live $1.00 claims on a
 * chart with no record of which rows this walk had created, and therefore no way
 * for the unwind to remove them. The manifest MUST outlive the container.
 *
 * `S10_OUT_DIR` overrides it, for local runs and for tests, where `/data` is
 * either absent or is `C:\data`.
 * @type {string}
 */
const OUT_DIR = process.env.S10_OUT_DIR || '/data/rcm-s10';

/**
 * THE ONLY AUTHORITY THE UNWIND ACCEPTS.
 *
 * `rcm-s11-unwind.js` reads its ids from this file and from nowhere else — not
 * from argv, not from an env var, not from a fresh read of the patient's claims.
 * An unwind that takes ids from an argument is one typo away from deleting
 * somebody's real claim, and "the operator will be careful" is not a safety
 * property. If the manifest is absent, there is nothing this walk created, and
 * therefore nothing to unwind.
 * @type {string}
 */
const MANIFEST_PATH = path.join(OUT_DIR, 'rcm-s10-manifest.json');

/** Where the two synthetic 835s are written. */
const ERA_A_PATH = path.join(OUT_DIR, 'rcm-s10-835-A.txt');
const ERA_B_PATH = path.join(OUT_DIR, 'rcm-s10-835-B.txt');

/**
 * SPIKE 0b's RESIDUE ON 12827 — never touched, by any script here.
 *
 * `docs/RCM_OD_WRITES.md` "Cleanup ledger" and `docs/RCM_POSTING.md` §10/§11.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED 2026-08-25 — "PERMANENT" TURNED OUT NOT TO BE
 * ─────────────────────────────────────────────────────────────────────────────
 * The docs say the negative supplemental claimproc 533931 cannot be reverted
 * (400 "Cannot change Status from Supplemental…"), cannot be deleted (`DELETE
 * /claimprocs` does not exist on 25.4.48), and therefore pins claim 53648 and
 * procedure 405237 forever. That was true of the API. It was not true of the
 * practice: the first §10 inventory run found
 *
 *     GET /claims/53648      -> 404 "Claim not found."
 *     GET /claimprocs/533931 -> 404 "ClaimProc not found."
 *
 * Both were removed some time after 2026-08-13, almost certainly through Open
 * Dental's desktop UI, which can do what the cloud API cannot. What is actually
 * left is procedure 405237 (live, $1.00), a DETACHED $0.00 estimate claimproc
 * 533930 (`ClaimNum: 0`), the four adjustments, and two soft-deleted procedures
 * 405238/405239 the docs never mentioned.
 *
 * The 404ing ids stay on the deny-list anyway. Denying an id that no longer
 * exists costs nothing, and the list exists so that a manifest naming one is
 * REFUSED — which is exactly as valuable as it was. "It is gone, so we can stop
 * guarding it" is how a guard quietly stops guarding, and Open Dental ids are
 * not reissued.
 *
 * Consequence for §11: the patient nets to **−$0.20**, not $0.00. The $0.00 the
 * docs quote was only true while the −$0.20 supplemental existed to offset the
 * −$1.20 of adjustments against the $1.00 charge. It does not now.
 *
 * This is a DENY-LIST, not a comment. The unwind refuses any of these ids even
 * if one somehow reaches its manifest — because the failure mode that matters is
 * not "an operator types the wrong number", it is "a manifest is regenerated
 * from a live read and sweeps the residue in with the targets". A deny-list
 * survives that; a warning in a header does not.
 *
 * PatPlanNum 20469 is the fake subscriber plan Beau added so `POST /claims`
 * would work at all on 12827. Removing it would break every future run of this
 * walk, so it is denied too.
 * @type {Readonly<{claims:number[], procedures:number[], claimProcs:number[], adjustments:number[], patPlans:number[]}>}
 */
const SPIKE_0B_RESIDUE = Object.freeze({
  claims: Object.freeze([53648]),
  // 405238 and 405239 are Spike 0b's, soft-deleted ("D"), and absent from every
  // doc until the 2026-08-25 inventory printed them. Denied for the same reason
  // as the rest: a manifest that names one did not come from the prep script.
  procedures: Object.freeze([405237, 405238, 405239]),
  // 533930 is the DETACHED $0.00 estimate that is actually still there; 533931 is
  // the supplemental that is not.
  claimProcs: Object.freeze([533930, 533931]),
  adjustments: Object.freeze([19109, 19110, 19111, 19112]),
  patPlans: Object.freeze([20469]),
});

/**
 * IDS THIS WALK HAS ALREADY SPENT — retired, never to be named again.
 *
 * A SEPARATE object from `SPIKE_0B_RESIDUE`, not an addition to it. These rows
 * are not Spike 0b's: `rcm-s10-prep.js` created them on 2026-08-25 and the §11
 * unwind removed them on 2026-08-26. Folding them into the 0b bucket would make
 * the inventory print `*** SPIKE 0b RESIDUE` beside rows 0b never touched, and a
 * label that is wrong is worse than no label at all.
 *
 * Why deny ids that are already deleted:
 *
 *   - Open Dental does not reissue ids, so nothing can ever legitimately sit at
 *     these numbers again;
 *   - therefore a manifest naming one did not come from a prep run — it came
 *     from a stale file, a copy, or a hand-edit — and acting on it would mean
 *     issuing writes at numbers whose meaning nobody can vouch for;
 *   - and screening the manifest is the whole job of the deny-list, so the moment
 *     an id is spent is exactly the moment it belongs here.
 *
 * The claims are `53784`/`53785`, the procedures `406124`/`406125` (both now
 * soft-deleted, `ProcStatus:"D"`, G12), the lines `535194`/`535195`.
 *
 * NOT included: ClaimPaymentNums `21399`/`21400`. The manifest has no field for a
 * check — its shape is `{procNum, claimNum, claimProcNum}` — so "a future
 * manifest must never name them" cannot apply to a check. The unwind discovers a
 * ClaimPaymentNum from a live read of the claimproc, and both of those lines are
 * gone.
 * @type {Readonly<{claims:number[], procedures:number[], claimProcs:number[]}>}
 */
const WALK_SPENT_IDS = Object.freeze({
  claims: Object.freeze([53784, 53785]),
  procedures: Object.freeze([406124, 406125]),
  claimProcs: Object.freeze([535194, 535195]),
});

/** Every denied id, flattened — what the unwind actually checks against. */
const DENY_IDS = Object.freeze([
  ...SPIKE_0B_RESIDUE.claims,
  ...SPIKE_0B_RESIDUE.procedures,
  ...SPIKE_0B_RESIDUE.claimProcs,
  ...SPIKE_0B_RESIDUE.adjustments,
  ...SPIKE_0B_RESIDUE.patPlans,
  ...WALK_SPENT_IDS.claims,
  ...WALK_SPENT_IDS.procedures,
  ...WALK_SPENT_IDS.claimProcs,
]);

/**
 * Make `OUT_DIR` exist and prove it is writable. Returns an error STRING, or
 * null when all is well.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CALLED BEFORE THE FIRST OPEN DENTAL CALL, NEVER AFTER
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-08-25 prep run is why this exists, and why it is a separate step
 * rather than a `try` around the write at the end. The run aborted correctly on
 * an unrelated 400, printed *"Nothing was created for this target"* — and then
 * died on `EACCES` from the manifest write in the abort path. The last line an
 * operator saw was `PREP FAILED: EACCES`, which describes neither what went
 * wrong nor what the script did about it. **A failure in the reporting path had
 * masked the failure being reported.**
 *
 * Checking up front makes the first error the only error. It also means the
 * expensive, chart-touching part of the script never starts when the cheap
 * precondition it depends on is already broken — a prep that creates two live
 * claims and THEN discovers it cannot record them is the one outcome this whole
 * design exists to prevent.
 *
 * It writes and removes a probe file rather than trusting `fs.accessSync(W_OK)`:
 * on an AzureFile mount, and under an overlay filesystem, access bits are not a
 * reliable predictor of whether a write lands.
 *
 * @param {string} [dir]
 * @returns {string|null}
 */
function checkOutDirWritable(dir = OUT_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return (
      `cannot create the output directory ${dir}: ${err.code || ''} ${err.message}\n` +
      `  In the container this must be on the /data volume — /app is READ-ONLY to the user\n` +
      `  the app runs as. Set S10_OUT_DIR to somewhere writable if you are running locally.`
    );
  }
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    return (
      `${dir} exists but is not writable: ${err.code || ''} ${err.message}\n` +
      `  The manifest is the only record of what this walk created, and the only authority\n` +
      `  the unwind accepts. Refusing to create anything that could not be recorded.`
    );
  }
  return null;
}

/** Open Dental list page size, and the cap on how many pages any read here walks. */
const OD_PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Open Dental per-call timeout for these scripts. */
const OD_TIMEOUT_MS = 30000;

module.exports = {
  OFFICE,
  PAT_NUM,
  PROC_CODE,
  PROC_FEE,
  PROC_FEE_CENTS,
  TARGET_COUNT,
  PACE_MS,
  OUT_DIR,
  MANIFEST_PATH,
  ERA_A_PATH,
  ERA_B_PATH,
  SPIKE_0B_RESIDUE,
  WALK_SPENT_IDS,
  DENY_IDS,
  OD_PAGE_SIZE,
  MAX_PAGES,
  OD_TIMEOUT_MS,
  checkOutDirWritable,
};
