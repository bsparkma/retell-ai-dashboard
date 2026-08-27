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
 * The DEFAULT office, kept only so a bare command still means what it meant.
 *
 * ⚠ **These are no longer the office and patient these scripts act on.** 6d made
 * the walk per-office — see `OFFICES` / `resolveTarget()` below — because §9's
 * three D-7 prerequisites are discharged and §10.5 needs the same walk run in
 * Riley's own database against Riley's own patient.
 *
 * They survive as the default `resolveTarget()` falls back to, and as the values
 * every recorded roland walk used, so a transcript in `docs/RCM_POSTING.md` §10
 * still lines up with a constant somebody can find. **Do not read a new PatNum
 * from here** — read it from the registry, which binds it to an office.
 * @type {string}
 */
const OFFICE = 'roland';

/**
 * Roland's disposable target patient. Bound to Roland by the registry below,
 * because PatNum 7115 is a DIFFERENT, REAL person in Roland's database than it
 * is in Riley's — which is the whole reason the per-office layer exists. A
 * PatNum without an office is not an address.
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
 * TWO WALKS ARE RECORDED HERE, and the list grows by a set per walk:
 *
 * | Walk | Unwound | Claims | Procedures (now `"D"`, G12) | Lines |
 * | --- | --- | --- | --- | --- |
 * | 2026-08-25 | 2026-08-26 02:28Z | `53784`, `53785` | `406124`, `406125` | `535194`, `535195` |
 * | 2026-08-26 | 2026-08-26 01:25Z | `53805`, `53806` | `406272`, `406273` | `535348`, `535349` |
 *
 * The 2026-08-26 walk never posted — it stopped at the first Drain on the
 * `od_patient_office` defect (§10.3) — but its targets were still CREATED, and
 * created is the only thing that matters to a deny-list. An id is spent the
 * moment it exists, not the moment it is used successfully.
 *
 * NOT included: ClaimPaymentNums `21399`/`21400`. The manifest has no field for a
 * check — its shape is `{procNum, claimNum, claimProcNum}` — so "a future
 * manifest must never name them" cannot apply to a check. The unwind discovers a
 * ClaimPaymentNum from a live read of the claimproc, and both of those lines are
 * gone.
 * @type {Readonly<{claims:number[], procedures:number[], claimProcs:number[]}>}
 */
const WALK_SPENT_IDS = Object.freeze({
  // 2026-08-25 walk, unwound 2026-08-26 02:28Z (§11.2).
  // 2026-08-26 walk, unwound 2026-08-26 01:25Z (§11.4).
  claims: Object.freeze([53784, 53785, 53805, 53806]),
  procedures: Object.freeze([406124, 406125, 406272, 406273]),
  claimProcs: Object.freeze([535194, 535195, 535348, 535349]),
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 6d: THE WALK IS PER-OFFICE NOW, AND `PROBE_OFFICE` FINALLY SELECTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Through 6c this file hard-coded roland and treated `PROBE_OFFICE` as an
 * assertion that could only refuse. That was right while valley was fail-closed:
 * there was nothing for the variable to select.
 *
 * §9's three prerequisites are now discharged, so §10.5 needs the same walk run
 * against Riley — and it must be run against Riley's OWN patient, in Riley's own
 * database, with Riley's own DefNums. So the constants below are a REGISTRY
 * keyed by office rather than a set of module-level values.
 *
 * WHAT DID NOT CHANGE: an office this registry does not name is a REFUSAL, never
 * a fallback to roland. Same stance as hard rule 2 — an office in a parameter
 * can only cause a refusal, never a change of destination.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PatNum 7115 IS THE REASON THE OFFICE LAYER EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * 7115 in Riley is valley's test patient. **7115 in Roland is a different, real
 * person.** A PatNum without an office is not an address, and this registry is
 * the one place in these scripts where the two are bound together.
 */
const OFFICES = Object.freeze({
  roland: Object.freeze({
    office: 'roland',
    officeName: 'Roland Family Dental',
    /** The disposable target patient. Roland's, and Roland's only. */
    patNum: 12827,
    /**
     * Spike 0b's residue and the ids two previous walks spent. Never touched by
     * any script here, and a manifest naming one did not come from the prep.
     */
    spike0bResidue: SPIKE_0B_RESIDUE,
    walkSpentIds: WALK_SPENT_IDS,
  }),
  valley: Object.freeze({
    office: 'valley',
    officeName: 'Valley Fort Smith',
    /**
     * Riley's test patient, and the one §9(c) confirmed can carry a claim:
     * `PatPlanNum 12402, InsSubNum 9088, Ordinal 1`, PatStatus Patient.
     *
     * ⚠ **PatPlanNum 12402 IS LIVE AND MUST NEVER BE TOUCHED.** Unlike 12827 —
     * which needed Beau to ADD a plan before Spike 0b could run — 7115 already
     * has one. The prep scripts create a procedure and a claim and nothing else;
     * the plan is a prerequisite they read, never a thing they manage.
     */
    patNum: 7115,
    /**
     * NOTHING YET, and that is a measured answer rather than an empty default.
     *
     * §9(c)'s read found 7115 carrying 0 claims and 1 procedurelog, and no walk
     * has ever run in Riley — so there is no residue to deny and no spent id to
     * protect. `rcm-s10-inventory.js` is what establishes this before the first
     * valley walk, and the first walk's own ids get added here afterwards, the
     * same way roland's were.
     */
    spike0bResidue: Object.freeze({
      claims: Object.freeze([]),
      procedures: Object.freeze([]),
      claimProcs: Object.freeze([]),
      adjustments: Object.freeze([]),
      patPlans: Object.freeze([12402]),
    }),
    walkSpentIds: Object.freeze({
      claims: Object.freeze([]),
      procedures: Object.freeze([]),
      claimProcs: Object.freeze([]),
    }),
  }),
});

/**
 * Resolve the office these scripts will act on, or refuse.
 *
 * Reads `PROBE_OFFICE` — the same variable the two D-7 probes take, so an
 * operator's invocation looks the same across all of them. Defaults to roland
 * because every recorded walk so far is roland's and a bare command must keep
 * meaning what it meant.
 *
 * THROWS on anything else. A typo must not silently address a practice.
 *
 * @param {string} [raw]
 * @returns {{ office: string, officeName: string, patNum: number,
 *             spike0bResidue: object, walkSpentIds: object }}
 */
function resolveTarget(raw = process.env.PROBE_OFFICE) {
  const key = String(raw || 'roland').trim().toLowerCase();
  const found = OFFICES[key];
  if (!found) {
    throw new Error(
      `PROBE_OFFICE='${raw}' is not a practice these scripts know. ` +
        `Expected one of: ${Object.keys(OFFICES).join(', ')}.`
    );
  }
  return found;
}

/**
 * Every denied id for ONE office, flattened — what the unwind checks against.
 *
 * Per-office because ClaimNum, ProcNum and ClaimProcNum numbering restarts in
 * every Open Dental database. A flat cross-office deny-list would refuse a
 * legitimate Riley id because Roland once used the same number, and — far worse
 * — would fail to protect a Riley id that Roland's list happens not to name.
 *
 * @param {{ spike0bResidue: object, walkSpentIds: object }} target
 * @returns {ReadonlyArray<number>}
 */
function denyIdsFor(target) {
  return Object.freeze([
    ...target.spike0bResidue.claims,
    ...target.spike0bResidue.procedures,
    ...target.spike0bResidue.claimProcs,
    ...target.spike0bResidue.adjustments,
    ...target.spike0bResidue.patPlans,
    ...target.walkSpentIds.claims,
    ...target.walkSpentIds.procedures,
    ...target.walkSpentIds.claimProcs,
  ]);
}

/**
 * Where ONE office's manifest and synthetic 835s live.
 *
 * `/data/rcm-s10/<office>/` — the office is in the PATH, so a roland manifest
 * and a valley manifest cannot overwrite one another and an unwind cannot be
 * pointed at the wrong practice's ids by running in the wrong order. The same
 * reason office is in every database key in this module.
 *
 * `eraRPath` is the RECOUPMENT file, and it is deliberately a separate name
 * rather than a `-C` continuing the series. A, B and R are not three of a kind:
 * A and B each pay a claim of their own, while R takes money BACK off the claim
 * A already paid, and it is only uploaded once A has actually posted. A name
 * that read as "the third one" would invite uploading all three together, which
 * cannot work — there is nothing to recoup yet.
 *
 * @param {string} office
 * @returns {{ outDir: string, manifestPath: string, eraAPath: string, eraBPath: string, eraRPath: string }}
 */
function pathsFor(office) {
  const outDir = path.join(OUT_DIR, office);
  return {
    outDir,
    manifestPath: path.join(outDir, 'rcm-s10-manifest.json'),
    eraAPath: path.join(outDir, 'rcm-s10-835-A.txt'),
    eraBPath: path.join(outDir, 'rcm-s10-835-B.txt'),
    eraRPath: path.join(outDir, 'rcm-s10-835-R-recoupment.txt'),
  };
}

/**
 * The `+` AdjType each office books a takeback REVERSAL under, by DefNum.
 *
 * Written down here rather than resolved live, because the one script that may
 * DELETE from a chart — `rcm-s11-unwind.js` — reads nothing from the
 * environment and contacts nothing but Open Dental's own endpoints. The numbers
 * come from §9(b)'s live read of each practice's own Category-1 list
 * (`Insurance adjustment (+)`), and `rcm-s10-capture.js` copies the right one
 * into the manifest.
 *
 * THEY MUST NEVER CROSS. 260 is not an AdjType in Riley and 402 is not one in
 * Roland; booking either in the other practice would put a number in the books
 * meaning something nobody chose. Same rule as the CommLog DefNums.
 */
const REVERSAL_ADJ_TYPE_DEFNUM = Object.freeze({
  roland: 260,
  valley: 402,
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
 * THE DIRECTORY IS AN ARGUMENT AND HAS NO DEFAULT, which is the 2026-08-26
 * lesson. It defaulted to `OUT_DIR`, and every caller took the default — but
 * the manifest is written to `pathsFor(office).outDir`, one level DEEPER, and
 * that level was never created. The probe wrote happily into the parent and the
 * prep then died on `ENOENT` writing the manifest, after creating the live
 * claims it was supposed to be recording. A check that passes for a directory
 * nothing writes to is worse than no check.
 *
 * Pass the directory you are about to write to. Nothing else is a check.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function checkOutDirWritable(dir) {
  if (!dir) return 'checkOutDirWritable needs the directory that will be written to';
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
  OFFICES,
  resolveTarget,
  denyIdsFor,
  pathsFor,
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
  REVERSAL_ADJ_TYPE_DEFNUM,
  DENY_IDS,
  OD_PAGE_SIZE,
  MAX_PAGES,
  OD_TIMEOUT_MS,
  checkOutDirWritable,
};
