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
 * lives here: constants, no requires beyond `path`, no side effects. There is
 * nothing here that importing could run.
 *
 * Everything in this file is a decision, not a default. Read the reasons before
 * changing a value.
 */

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

/** Where the manifest lands. Gitignored: it names live chart rows. */
const OUT_DIR = path.join(__dirname, 'out');

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

/** Every residue id, flattened — what the unwind actually checks against. */
const DENY_IDS = Object.freeze([
  ...SPIKE_0B_RESIDUE.claims,
  ...SPIKE_0B_RESIDUE.procedures,
  ...SPIKE_0B_RESIDUE.claimProcs,
  ...SPIKE_0B_RESIDUE.adjustments,
  ...SPIKE_0B_RESIDUE.patPlans,
]);

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
  DENY_IDS,
  OD_PAGE_SIZE,
  MAX_PAGES,
  OD_TIMEOUT_MS,
};
