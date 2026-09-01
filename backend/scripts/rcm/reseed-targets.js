'use strict';

/*
 * THE CONSTANTS THE RESEED SCRIPTS MUST AGREE ON, AND NOTHING ELSE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * The same lesson `rcm-s10-targets.js` records, and it was learned the hard way
 * on 2026-08-24: the D-7 read sweep got its shared id by importing the write
 * probe, the probe called `main()` at module load, and a script named "read
 * sweep" re-issued every write verb.
 *
 * `reseed-prep.js` WRITES to Open Dental. `reseed-835.js` does not. They need
 * the same patients, the same fee schedule and the same manifest path. Neither
 * may import the other, so the agreement lives here: constants and pure helpers,
 * from `node:fs` and `node:path` only, with NO top-level call. There is nothing
 * here that requiring could run.
 *
 * Everything in this file is a decision, not a default.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * ROLAND ONLY. Not a default — a constraint.
 *
 * Riley's walk (§10.5) has never been run, `rcm-s10-targets.js` records that
 * Riley's deny-list is empty because nothing has ever created a row there, and
 * this reseed is a click-through fixture rather than the first write into a
 * second practice's chart. `resolveOffice` throws on anything else; a typo must
 * not get as far as holding a credential.
 * @type {string}
 */
const OFFICE = 'roland';

/**
 * THE TWO DESIGNATED ROLAND TEST PATIENTS, AND THERE ARE ONLY TWO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY R1 HAS THREE LINES AND TWO PATIENTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The brief asked for three lines on three different patients. Roland has two
 * designated synthetic patients and no third:
 *
 *   - `11373` is REJECTED as a fixture — its number is a shared family phone, so
 *     phone matching returns several records and the match is ambiguous by
 *     construction (CLAUDE.md, `rcm-seed-fixtures.cjs` FORBIDDEN_PATNUMS).
 *   - `7115` is valley's test patient. **7115 in Roland is a different, REAL
 *     person.** A PatNum without an office is not an address.
 *   - The deny-lists in `rcm-s10-targets.js` hold ClaimNums, ProcNums,
 *     ClaimProcNums, AdjNums and PatPlanNums. They have never held a patient, so
 *     "another test patient already on the deny-list" names nothing.
 *
 * Ruling A (2026-09-01) is that no new Open Dental chart may be created. So R1
 * runs 12827 / 12828 / 12827 across three separate claims: the Patient column
 * still changes from row to row, which is what the fixture was for, and nothing
 * synthetic had to be invented to get it.
 *
 * `LName` / `FName` are the CHART's own spelling and are READ BACK by the prep
 * rather than written here. What is recorded below is only which PatNums are
 * permissible — a name a script believes a patient has is a name that is quietly
 * wrong one rename later, and on the matcher's name-search lane a disagreement
 * is DISQUALIFYING rather than merely costly.
 * @type {Readonly<Record<number, string>>}
 */
const TEST_PATIENTS = Object.freeze({
  12827: 'the Stedi resolve/preview fixture',
  12828: 'the TC + Mango staging fixture',
});

/** Every PatNum this reseed may address. Anything else is a refusal. */
const ALLOWED_PATNUMS = Object.freeze(Object.keys(TEST_PATIENTS).map(Number));

/**
 * REJECTED AS A FIXTURE, and named so the refusal is explicit rather than
 * incidental. `11373`'s number is a shared family phone; `7115` in Roland is a
 * real person. Neither may appear in a target, and `assertPatNum` refuses both
 * with their own reason rather than with a generic "not allowed".
 * @type {Readonly<Record<number, string>>}
 */
const FORBIDDEN_PATNUMS = Object.freeze({
  11373: 'shared family phone — phone matching returns several records, so the match is ambiguous by construction',
  7115: 'valley’s test patient. 7115 in ROLAND is a different, REAL person',
});

/**
 * THE SEVEN TARGETS, and the whole shape of the reseed in one table.
 *
 * Every field here is a fixed literal. Nothing reads the clock, nothing reads a
 * random source, and no amount is parameterised — the same discipline
 * `rcm-seed-fixtures.cjs` holds, for the same reason: two consecutive dry runs
 * must print byte-identical plans.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN THE MODULE'S OWN DEFINITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * `services/rcm/lineDecisions.js` defines it once, and these fixtures are
 * authored against that definition rather than against a plausible-looking 835:
 *
 *     contractual write-off   W = billed − allowed     (the CARRIER's figure)
 *     patient remainder       R = allowed − paid       (the DECISION)
 *
 * In X12 that is `CAS*CO*45*<W>` for the contractual half and a `CAS*PR*…` group
 * summing to `R` for the patient half, with `CLP05` carrying `R` for the claim.
 * A file whose CAS groups do not reconcile to its CLP05 is flagged for review by
 * the parser (defect A1), which would put the walk on a detour before it began.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FEES ARE REAL SIZES AND NOT $1.00
 * ─────────────────────────────────────────────────────────────────────────────
 * §10's walk deliberately uses $1.00 so a mis-post is a dollar. This is not that
 * walk. This is the fixture Beau clicks through to see whether the SCREENS read
 * correctly, and a workbench where every line is $1.00 cannot show him a verdict
 * line, a contractual write-off and a patient remainder as different sizes of
 * number. The amounts below are ordinary dental fees.
 *
 * The chart-side risk is unchanged in kind and larger in degree, which is why
 * `reseed-prep.js` reads back every id it creates and `rcm-s11-unwind.js` is the
 * only way these come off again.
 *
 * @type {ReadonlyArray<{ key: string, remittance: string, patNum: number,
 *   procCode: string, billedCents: number, allowedCents: number, paidCents: number,
 *   note: string }>}
 */
const TARGETS = Object.freeze([
  // ── R1 · the clean check ──────────────────────────────────────────────────
  {
    key: 'R1-1',
    remittance: 'R1',
    patNum: 12827,
    procCode: 'D0120',
    billedCents: 5800,
    allowedCents: 4600,
    paidCents: 3680,
    /*
     * THE CC-5 LINE. Allowed 46.00, paid 36.80 — so R = $9.20 and the verdict
     * line has a non-zero patient remainder to project. Every other line on R1
     * pays in full, which is what makes this one legible: one number moved, and
     * the screen has to say which.
     */
    note: 'CC-5 — 80% coinsurance, so the patient is left owing $9.20',
  },
  {
    key: 'R1-2',
    remittance: 'R1',
    patNum: 12828,
    procCode: 'D1110',
    billedCents: 9800,
    allowedCents: 7400,
    paidCents: 7400,
    note: 'paid in full at the allowed rate; the write-off is the carrier’s',
  },
  {
    key: 'R1-3',
    remittance: 'R1',
    patNum: 12827,
    procCode: 'D0274',
    billedCents: 7200,
    allowedCents: 5400,
    paidCents: 5400,
    note: 'paid in full at the allowed rate',
  },

  // ── R2 · the contractual write-off and the one the office eats ────────────
  {
    key: 'R2-1',
    remittance: 'R2',
    patNum: 12828,
    procCode: 'D2391',
    billedCents: 21500,
    allowedCents: 16000,
    paidCents: 16000,
    note: 'CONTRACTUAL ONLY — W = $55.00, R = $0. Nothing to decide; the line renders without the control',
  },
  {
    key: 'R2-2',
    remittance: 'R2',
    patNum: 12827,
    procCode: 'D2740',
    billedCents: 128000,
    allowedCents: 96000,
    paidCents: 48000,
    /*
     * R = $480.00 — a deductible-and-coinsurance remainder big enough that
     * `office_writeoff` is a decision somebody would actually agonise over,
     * which is the point of the fixture. The reason is REQUIRED on that path,
     * and the gate refuses without one (D-11, REASON_GATE: absent = blocking).
     */
    note: 'THE OFFICE EATS IT — R = $480.00 on the office_writeoff path, reason REQUIRED',
  },

  // ── R3 · the takeback ─────────────────────────────────────────────────────
  {
    key: 'R3-1',
    remittance: 'R3',
    patNum: 12828,
    procCode: 'D0220',
    billedCents: 3500,
    allowedCents: 2900,
    paidCents: 2900,
    /*
     * R3 is generated as the NEGATED MIRROR of this line — CLP02=22, reversal of
     * previous payment. The claim is created and paid like any other; the 835
     * takes the money back off it.
     *
     * ⚠ ORDERING. A takeback pairs to the PAID line, so R3 can only be matched
     * once this claim has actually posted. Matched before, the eligible set is
     * empty and the approve refuses NO_REVERSIBLE_LINES — correctly. See
     * `reseed-835.js`'s banner and RCM_POSTING §10.6.4 finding 1.
     */
    note: 'the line R3 reverses — R3 is its negated mirror, CLP02=22',
  },

  // ── R4 · the dead end (§15.1c) ────────────────────────────────────────────
  {
    key: 'R4-1',
    remittance: 'R4',
    patNum: 12827,
    procCode: 'D0330',
    billedCents: 14500,
    allowedCents: 11000,
    paidCents: 8800,
    /*
     * THE CLAIM IS REAL. The 835 that pays it is not findable.
     *
     * This claim is created exactly like the other five — it exists in Open
     * Dental, on a designated test patient, and Beau can see it in the other
     * window. `reseed-835.js` then writes R4's `NM1*QC` with a TRANSPOSED
     * SURNAME, so the matcher's only route to a patient — a prefix search on
     * `LName` and on `FName` — returns nobody, and `findClaimCandidates` returns
     * before it ever looks at a claim.
     *
     * CLP01 still carries the REAL ClaimNum, which makes the dead end sharper
     * rather than softer: the right number is in the file, and CareIN still
     * cannot get there, because candidates are gathered by PATIENT and never by
     * claim number. That is §15.1c exactly, and it is not a bug to be fixed by
     * loosening anything — 6d.2 owes the fix.
     */
    note: '§15.1c THE DEAD END — real claim, transposed name in the 835, no candidate reachable',
  },
]);

/** The four remittances, in upload order, with what each is for. */
const REMITTANCES = Object.freeze([
  Object.freeze({
    label: 'R1',
    payer: 'DELTA DENTAL OF OKLAHOMA',
    checkNumber: 'RS-104477',
    controlNumber: '000100001',
    /** Ordinary paper check. BPR04=CHK, and the office's check PayType DefNum. */
    paymentMethod: 'CHK',
    purpose: 'clean 835, 3 lines, 3 claims, 2 patients — one line leaves the patient owing $9.20 (CC-5)',
  }),
  Object.freeze({
    label: 'R2',
    payer: 'METLIFE DENTAL',
    checkNumber: 'RS-889021',
    controlNumber: '000100002',
    paymentMethod: 'CHK',
    purpose: 'one contractual-only line, one the office should eat (office_writeoff, reason required)',
  }),
  Object.freeze({
    label: 'R3',
    payer: 'CIGNA DENTAL',
    checkNumber: 'RS-330415',
    controlNumber: '000100003',
    paymentMethod: 'CHK',
    purpose: 'the takeback — CLP02=22, negated mirror of R3-1. UPLOAD LAST, after R3-1 has POSTED',
  }),
  Object.freeze({
    label: 'R4',
    payer: 'CIGNA DENTAL',
    checkNumber: 'RS-330416',
    controlNumber: '000100004',
    paymentMethod: 'CHK',
    purpose: '§15.1c — the matcher cannot resolve this one, on purpose. Do NOT loosen the matcher',
  }),
]);

/**
 * R4's transposed surname, and it is a CONSTANT rather than a computation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT DERIVED FROM THE CHART NAME
 * ─────────────────────────────────────────────────────────────────────────────
 * A `swapTwoLetters(chartName)` helper would be cleverer and would be wrong the
 * first time a transposition happened to still prefix-match. Open Dental matches
 * `LName` and `FName` by PREFIX, so `TEST` transposed to `TSET` is safe while
 * `TEST 2` transposed to `TEST 2` (the space moved) is not, and nothing about
 * the derivation would say which one it produced.
 *
 * So the pair below is fixed, and `reseed-835.js` REFUSES if either token is a
 * prefix of, or is prefixed by, the chart's real tokens. The check is the
 * guarantee; this constant is only the candidate.
 *
 * Both tokens are nonsense on their face — they are not a person's name, and
 * they resemble nobody.
 */
const R4_TRANSPOSED = Object.freeze({ last: 'TSET', first: 'SDETI' });

/** Milliseconds between consecutive Open Dental calls. Open Dental publishes
 *  1 req/s and the credential is SHARED with the live phone path and TC (D-8).
 *  These are operational scripts and do not go through `services/rcm/odPacer.js`,
 *  so they hold themselves to the same floor by hand, exactly as §10's do. */
const PACE_MS = 1300;

/** Open Dental per-call timeout for these scripts. */
const OD_TIMEOUT_MS = 30000;

/** Open Dental list page size, and the cap on how many pages any read here walks. */
const OD_PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Where the manifest and the four 835s land.
 *
 * `/data` is the AzureFile volume — the same mount `CALLSTORE_DIR` uses. NOT
 * `scripts/out`: `/app` is READ-ONLY to the non-root user the container runs as,
 * which is how the first §10 prep run died (`EACCES: permission denied, mkdir
 * '/app/scripts/out'`, 2026-08-25).
 *
 * It also has to OUTLIVE the container. Days pass between a reseed and the
 * unwind that removes what it created, and a manifest on the ephemeral layer
 * would be gone by then — leaving live claims on a chart with no record of which
 * rows this reseed made, and therefore no way to remove them.
 *
 * `RESEED_OUT_DIR` overrides it, for local runs and for tests.
 * @type {string}
 */
const OUT_DIR = process.env.RESEED_OUT_DIR || '/data/rcm-reseed';

/**
 * Where one office's manifest and 835s live. The office is in the PATH so a
 * roland manifest and a valley manifest cannot overwrite one another.
 *
 * @param {string} office
 * @returns {{ outDir: string, manifestPath: string, eraPath(label: string): string }}
 */
function pathsFor(office) {
  const outDir = path.join(OUT_DIR, office);
  return {
    outDir,
    manifestPath: path.join(outDir, 'rcm-reseed-manifest.json'),
    eraPath: (label) => path.join(outDir, `rcm-reseed-835-${label}.txt`),
  };
}

/**
 * Resolve the office this run addresses, or refuse.
 *
 * Reads `PROBE_OFFICE`, the same variable the D-7 probes and the §10 scripts
 * take, so an operator's invocation looks the same across all of them.
 *
 * @param {string} [raw]
 * @returns {string}
 */
function resolveOffice(raw = process.env.PROBE_OFFICE) {
  const key = String(raw || OFFICE).trim().toLowerCase();
  if (key !== OFFICE) {
    throw new Error(
      `PROBE_OFFICE='${raw}' — this reseed is ${OFFICE} only.\n` +
        "  Riley has never had a walk run in it (RCM_POSTING §10.5), its deny-list is empty because\n" +
        '  nothing has ever created a row there, and a click-through fixture is not the right first\n' +
        "  write into a second practice's chart."
    );
  }
  return OFFICE;
}

/**
 * Is this PatNum one this reseed may address? Returns the refusal SENTENCE, or
 * null when it is fine — the same shape `checkOutDirWritable` uses, so a caller
 * is one `if` away from a message.
 *
 * @param {unknown} patNum
 * @returns {string|null}
 */
function assertPatNum(patNum) {
  const n = Number(patNum);
  if (!Number.isFinite(n) || n <= 0) return `'${patNum}' is not a PatNum.`;
  if (Object.prototype.hasOwnProperty.call(FORBIDDEN_PATNUMS, n)) {
    return `PatNum ${n} is REJECTED as a fixture: ${FORBIDDEN_PATNUMS[n]}.`;
  }
  if (!ALLOWED_PATNUMS.includes(n)) {
    return (
      `PatNum ${n} is not a designated ${OFFICE} test patient.\n` +
      `  The only ones are ${ALLOWED_PATNUMS.join(' and ')}. Ruling A (2026-09-01): no new Open\n` +
      '  Dental chart may be created for this reseed.'
    );
  }
  return null;
}

/**
 * Make `dir` exist and PROVE it is writable. Returns an error STRING, or null.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CALLED BEFORE THE FIRST OPEN DENTAL CALL, NEVER AFTER
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-08-25 §10 prep run is why this exists. It aborted correctly on an
 * unrelated 400, printed "Nothing was created for this target", and then died on
 * `EACCES` from the manifest write in the abort path. The last line the operator
 * saw was `PREP FAILED: EACCES`, which described neither. A failure in the
 * reporting path must never mask the failure being reported.
 *
 * It writes and removes a probe FILE rather than trusting `fs.accessSync(W_OK)`:
 * on an AzureFile mount, and under an overlay filesystem, access bits are not a
 * reliable predictor of whether a write lands.
 *
 * The directory is an ARGUMENT and has no default — the 2026-08-26 lesson, where
 * the probe wrote happily into the PARENT and the prep then died on `ENOENT`
 * writing the manifest one level deeper, after creating the live claims it was
 * supposed to be recording.
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
      '  In the container this must be on the /data volume — /app is READ-ONLY to the user the app\n' +
      '  runs as. Set RESEED_OUT_DIR to somewhere writable if you are running locally.'
    );
  }
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    return (
      `${dir} exists but is not writable: ${err.code || ''} ${err.message}\n` +
      '  The manifest is the only record of what this reseed created, and the only authority the\n' +
      '  unwind accepts. Refusing to create anything that could not be recorded.'
    );
  }
  return null;
}

/**
 * IDS THIS RESEED HAS SPENT — retired, never to be named again.
 *
 * Empty until the first run, and that is a MEASURED answer rather than a
 * placeholder: no reseed has been run, so there is nothing to deny. The run's
 * own ids get added here afterwards, the same way §10's walks added theirs to
 * `rcm-s10-targets.js`, and `RCM_POSTING.md` §10.8 carries the same table in prose.
 *
 * Why deny ids that are already deleted: Open Dental does not reissue an id, so
 * nothing can ever legitimately sit at these numbers again — therefore a manifest
 * naming one did not come from a prep run, and acting on it would mean issuing
 * writes at numbers whose meaning nobody can vouch for.
 *
 * @type {Readonly<{claims:number[], procedures:number[], claimProcs:number[]}>}
 */
const RESEED_SPENT_IDS = Object.freeze({
  claims: Object.freeze([]),
  procedures: Object.freeze([]),
  claimProcs: Object.freeze([]),
});

/**
 * WHEN `RESEED_SPENT_IDS` LAST GREW — the second half of the screen, and the
 * half the ids alone cannot express.
 *
 * The id check catches a manifest naming a spent id. It does NOT catch a
 * manifest written before a run that has since been unwound but whose ids happen
 * not to collide — walk night 2 regenerated both §10 835s from a two-day-old
 * manifest and said nothing. "This file is older than the last thing we retired"
 * is the cheaper, blunter question that catches both.
 *
 * ISO 8601, UTC, and it MOVES every time a set is added above.
 */
const RESEED_SPENT_RECORDED_AT = '2026-09-01T00:00:00.000Z';

/** Every denied id, flattened — what a manifest is screened against. */
function denyIds() {
  return Object.freeze([
    ...RESEED_SPENT_IDS.claims,
    ...RESEED_SPENT_IDS.procedures,
    ...RESEED_SPENT_IDS.claimProcs,
  ]);
}

/**
 * Is this manifest safe to act on, or is it a stale file describing rows that no
 * longer exist? Returns the refusal SENTENCE, or null.
 *
 * TWO REFUSALS, catching different failures — a NAMED SPENT ID, and a MANIFEST
 * OLDER THAN THE LAST RUN WE RETIRED. See `RESEED_SPENT_RECORDED_AT`.
 *
 * @param {{ createdAt?: unknown, targets?: ReadonlyArray<Record<string, unknown>> }} manifest
 * @returns {string|null}
 */
function screenManifestForSpentIds(manifest) {
  const deny = denyIds();
  const named = [];
  for (const t of (manifest && manifest.targets) || []) {
    for (const field of ['procNum', 'claimNum', 'claimProcNum']) {
      const id = Number(t && t[field]);
      if (Number.isFinite(id) && id > 0 && deny.includes(id)) named.push(`${field}=${id}`);
    }
  }
  if (named.length) {
    return [
      `this manifest names ${named.length} RETIRED id(s): ${named.join(', ')}.`,
      '  Open Dental never reissues an id, so these rows are gone and cannot come back. This',
      '  manifest did not come from a prep run against the current chart — it is a stale file, a',
      '  copy, or a hand-edit. Move it aside and run the prep again:',
      '      mv <manifest> <manifest>.spent.json',
      '      PROBE_OFFICE=roland node scripts/rcm/reseed-prep.js --execute',
    ].join('\n');
  }

  const createdAt = Date.parse(String((manifest && manifest.createdAt) || ''));
  if (!Number.isFinite(createdAt)) {
    return [
      'this manifest carries no usable `createdAt`, so its age cannot be checked.',
      '  Every prep this repo has shipped writes one. Move it aside and run the prep again.',
    ].join('\n');
  }
  const spentAt = Date.parse(RESEED_SPENT_RECORDED_AT);
  if (createdAt < spentAt) {
    return [
      `this manifest was written ${new Date(createdAt).toISOString()}, BEFORE the most recent run`,
      `  was retired (${RESEED_SPENT_RECORDED_AT}). Its targets were unwound. Regenerating files`,
      '  from it would name claims that no longer exist. Move it aside and run the prep again.',
    ].join('\n');
  }

  return null;
}

module.exports = {
  OFFICE,
  TEST_PATIENTS,
  ALLOWED_PATNUMS,
  FORBIDDEN_PATNUMS,
  TARGETS,
  REMITTANCES,
  R4_TRANSPOSED,
  PACE_MS,
  OD_TIMEOUT_MS,
  OD_PAGE_SIZE,
  MAX_PAGES,
  OUT_DIR,
  RESEED_SPENT_IDS,
  RESEED_SPENT_RECORDED_AT,
  pathsFor,
  resolveOffice,
  assertPatNum,
  checkOutDirWritable,
  denyIds,
  screenManifestForSpentIds,
};
