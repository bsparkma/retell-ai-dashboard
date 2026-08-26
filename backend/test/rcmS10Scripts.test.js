'use strict';

/**
 * THE §10/§11 STAGING-WALK SCRIPTS — the properties that make them safe to run
 * against a live practice database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE TESTED AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * D-7 taught this the expensive way: a script that is written, reviewed and
 * approved but never RUN hides its defects until an operator is at a console
 * beside a live chart database at 9pm. That run exposed two — the script could
 * not load its own secrets, and importing it executed it — and both were
 * invisible to every existing guard.
 *
 * `routes/rcm/rcmNoOdWrites.test.js` carries the STATIC rule: which files under
 * scripts/ may name a write verb, and that any file naming one must guard
 * `main()`. This file carries the rules that are specific to these four scripts
 * and that a name-based scan cannot express — chiefly that
 * `rcm-s11-unwind.js`, the one file in this repository that may DELETE from a
 * chart, can only ever aim at rows the prep script recorded creating.
 *
 * These are SOURCE-level assertions. That is a deliberate limit, and it is the
 * same limit `rcmNoOdWrites.test.js`'s scripts/ scan accepts: driving these
 * scripts for real means talking to Open Dental, which is exactly the thing the
 * tests exist to bound. Where a property can be exercised without a network —
 * the 835 builder, the manifest gates — it is exercised rather than grepped.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

const FILES = {
  targets: 'rcm-s10-targets.js',
  inventory: 'rcm-s10-inventory.js',
  prep: 'rcm-s10-prep.js',
  era: 'rcm-s10-835.js',
  unwind: 'rcm-s11-unwind.js',
};

/** @param {string} name */
function read(name) {
  return fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
}

/** Source with comments stripped — prose that explains an absent call is not a call. */
function code(name) {
  return read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ─── 0. They exist, and they are the four the docs name ─────────────────────

test('all five walk scripts are checked in', () => {
  for (const name of Object.values(FILES)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, name)), `scripts/${name} is missing`);
  }
});

// ─── 1. The shared-constants module has no reach ────────────────────────────

test('rcm-s10-targets imports only inert stdlib and runs nothing on import', () => {
  /*
   * The same rule `rcm-d7-ghost.js` follows, for the same reason. Four scripts
   * must agree on one patient, one office and one manifest path; two of them
   * write and one DELETEs. If they got that agreement by importing each other,
   * requiring one would be enough to run another — which is precisely what
   * happened on 2026-08-24, when a script named "read sweep" re-issued every
   * write verb because the file it imported called main() at load.
   *
   * This asserted `['node:path']` exactly until `checkOutDirWritable` moved here.
   * That helper belongs in this file — all four scripts share the output
   * directory, so a per-script copy would be four chances to disagree about where
   * the manifest lives — and it needs `node:fs`.
   *
   * The list is widened deliberately, and the PROPERTY tightens: inert stdlib
   * only, nothing from this repo, and no top-level call of any kind. The rule was
   * never about the name `node:path`; it was about import being unable to *act*,
   * and that is now asserted directly rather than by proxy.
   */
  const src = code(FILES.targets);
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['node:fs', 'node:path'], 'only inert stdlib');

  /*
   * And nothing this file DEFINES is invoked at module scope. `path.join` at the
   * top level is fine and necessary — it derives the manifest path and is pure.
   * What must never happen is `checkOutDirWritable()` (or any future helper)
   * running on import: that would touch a filesystem the moment any of the four
   * scripts required this one, which is the 2026-08-24 shape exactly.
   */
  const topLevel = src.replace(/function[\s\S]*?\n}/g, '');
  const defined = [...src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  assert.ok(defined.includes('checkOutDirWritable'), 'sanity: the helper is defined here');
  for (const name of defined) {
    assert.ok(
      !new RegExp(`\\b${name}\\s*\\(`).test(topLevel),
      `${name}() must not be called at module scope`
    );
  }
  // No filesystem work on import either, whatever it is spelled.
  assert.ok(!/\bfs\.\w+\(/.test(topLevel), 'no fs call at module scope');
});

test('the output directory is on /data, not inside the read-only image', () => {
  /*
   * MEASURED 2026-08-25: the first prep run died on
   *
   *     EACCES: permission denied, mkdir '/app/scripts/out'
   *
   * `/app` is read-only to the non-root user the container runs as. `/data` is
   * the AzureFile volume, and it has to be that one specifically: §10.3 kills and
   * restarts the container mid-drain, and days pass before the §11 unwind. A
   * manifest on the ephemeral container layer would be gone by the time the rows
   * it describes needed removing — live $1.00 claims on a chart with no record of
   * which rows this walk created, and so no way for the unwind to remove them.
   */
  const priorEnv = process.env.S10_OUT_DIR;
  const targetsPath = require.resolve(path.join(SCRIPTS, FILES.targets));
  delete process.env.S10_OUT_DIR;
  delete require.cache[targetsPath];
  try {
    const fresh = require(targetsPath);
    assert.equal(fresh.OUT_DIR, '/data/rcm-s10', 'the default must be the durable volume');
    assert.ok(!fresh.OUT_DIR.includes('app'), 'never inside the image');
    // `path.dirname`, not `startsWith`: this suite runs on Windows too, where
    // `path.join('/data/rcm-s10', x)` comes back with backslashes and a prefix
    // comparison against the forward-slash constant fails for a reason that has
    // nothing to do with the property being tested.
    const normalised = path.normalize(fresh.OUT_DIR);
    assert.equal(path.dirname(fresh.MANIFEST_PATH), normalised, 'the manifest lives there');
    assert.equal(path.dirname(fresh.ERA_A_PATH), normalised, 'and so do the 835s');
    assert.equal(path.dirname(fresh.ERA_B_PATH), normalised);
  } finally {
    if (priorEnv === undefined) delete process.env.S10_OUT_DIR;
    else process.env.S10_OUT_DIR = priorEnv;
    delete require.cache[targetsPath];
  }

  // And `S10_OUT_DIR` overrides it, which is the only reason this suite and a
  // local run are possible at all.
  assert.match(code(FILES.targets), /process\.env\.S10_OUT_DIR \|\| '\/data\/rcm-s10'/);
});

test('checkOutDirWritable proves a write lands, and reports rather than throws', () => {
  /*
   * It writes and removes a probe file rather than trusting `accessSync(W_OK)`:
   * on an AzureFile mount, and under an overlay filesystem, access bits are not a
   * reliable predictor of whether a write succeeds. And it RETURNS a message
   * instead of throwing, so the caller controls what an operator sees — the whole
   * point being that this failure must not arrive as a stack trace.
   */
  const T = require(path.join(SCRIPTS, FILES.targets));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-s10-'));
  try {
    const good = path.join(base, 'nested', 'out');
    assert.equal(T.checkOutDirWritable(good), null, 'a creatable directory is fine');
    assert.ok(fs.existsSync(good), 'and it is created, recursively');
    assert.ok(!fs.existsSync(path.join(good, '.write-probe')), 'the probe file is cleaned up');

    // A FILE where the directory should be: mkdir fails, and the caller gets a
    // sentence naming the path and pointing at /data.
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const msg = T.checkOutDirWritable(path.join(blocker, 'out'));
    assert.ok(typeof msg === 'string' && msg.length > 0, 'it must report a problem');
    assert.match(msg, /cannot create the output directory/);
    assert.match(msg, /\/app is READ-ONLY/, 'and name the actual cause in the container');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the targets module pins the office, the patient and the fee as constants', () => {
  const T = require(path.join(SCRIPTS, FILES.targets));
  assert.equal(T.OFFICE, 'roland', 'valley is fail-closed until D-7 is discharged');
  assert.equal(T.PAT_NUM, 12827, 'the designated Roland fixture');
  assert.equal(T.PROC_FEE, 1.0);
  assert.equal(T.PROC_FEE_CENTS, 100);
  assert.equal(T.TARGET_COUNT, 2, 'one target for the drain, one for the kill-mid-drain');
  assert.ok(T.PACE_MS >= 1300, 'Open Dental publishes 1 req/s and the credential is shared');
});

test('the Spike 0b residue is a deny-list, not a comment', () => {
  /*
   * The docs' list — claim 53648, procedure 405237, supplemental 533931,
   * adjustments 19109-19112, PatPlanNum 20469 — plus what the 2026-08-25
   * inventory actually found on the patient: soft-deleted procedures 405238 and
   * 405239, and the detached $0.00 estimate 533930.
   *
   * 53648 and 533931 now read 404 — they were removed through Open Dental's
   * desktop UI, which can do what the cloud API cannot. They STAY denied.
   * Denying an id that no longer exists costs nothing, Open Dental does not
   * reissue ids, and the list's job is to refuse a manifest that names one —
   * which is exactly as valuable as it was. Dropping a guard because the thing
   * it guarded went away is how a guard quietly stops guarding.
   */
  const T = require(path.join(SCRIPTS, FILES.targets));
  for (const id of [53648, 405237, 405238, 405239, 533930, 533931, 19109, 19110, 19111, 19112, 20469]) {
    assert.ok(T.DENY_IDS.includes(id), `${id} must be on the deny-list`);
  }
});

test('the ids the 2026-08-25 walk spent are denied, in their OWN bucket', () => {
  /*
   * Created by the prep on 2026-08-25, unwound on 2026-08-26. Denied for the same
   * underlying reason as Spike 0b's rows — Open Dental does not reissue ids, so a
   * manifest naming one did not come from a prep run and its numbers mean nothing
   * anybody can vouch for.
   *
   * SEPARATE from SPIKE_0B_RESIDUE, and the separation is the assertion. Folding
   * them in would make the inventory print '*** SPIKE 0b RESIDUE' beside rows 0b
   * never touched, and a label that is wrong is worse than no label.
   *
   * ClaimPaymentNums 21399/21400 are deliberately absent: the manifest has no
   * field for a check, so "a future manifest must never name them" cannot apply.
   */
  const T = require(path.join(SCRIPTS, FILES.targets));
  assert.deepEqual([...T.WALK_SPENT_IDS.claims], [53784, 53785]);
  assert.deepEqual([...T.WALK_SPENT_IDS.procedures], [406124, 406125]);
  assert.deepEqual([...T.WALK_SPENT_IDS.claimProcs], [535194, 535195]);

  for (const id of [53784, 53785, 406124, 406125, 535194, 535195]) {
    assert.ok(T.DENY_IDS.includes(id), `${id} must be on the deny-list`);
    for (const bucket of Object.values(T.SPIKE_0B_RESIDUE)) {
      assert.ok(!bucket.includes(id), `${id} must NOT be filed as Spike 0b residue`);
    }
  }

  // One flat list, no duplicates — a repeated id means a bucket was merged rather
  // than added.
  assert.equal(new Set(T.DENY_IDS).size, T.DENY_IDS.length);
});

// ─── 2. The inventory reads and only reads ──────────────────────────────────

test('the inventory names no write verb of any kind', () => {
  /*
   * It is not on `rcmNoOdWrites.test.js`'s allow-list, so that scan already fails
   * the build if it grows one. This states the intent from the other side: the
   * baseline for the unwind's arithmetic is gathered without changing the thing
   * being measured.
   */
  const src = code(FILES.inventory);
  for (const verb of ['apiWriteRaw', 'axios.post(', 'axios.put(', 'axios.delete(', 'client.post(', 'client.put(', 'client.delete(']) {
    assert.ok(!src.includes(verb), `the inventory must not name ${verb}`);
  }
});

test('the inventory excludes soft-deleted procedures from its balance (G12)', () => {
  /*
   * `DELETE /procedurelogs` is a SOFT delete: the row returns ProcStatus "D" and
   * still appears in list reads. Spike 0b's own teardown counted "D" rows as live
   * charges and over-applied a reversal by $2.00. This is the trap, so this is
   * the assertion.
   */
  const src = read(FILES.inventory);
  assert.match(src, /ProcStatus\) === 'D'/, 'it must identify "D" rows');
  assert.match(src, /excluded from every total/i, 'and say how many it excluded');
});

test('the inventory reads claimprocs BY PATIENT, so a detached row cannot hide', () => {
  /*
   * The 2026-08-25 run is why. PatNum 12827 had ZERO claims and a claimproc all
   * the same — 533930, ClaimNum 0, a detached Spike 0b estimate. A claim-scoped
   * walk cannot see a row that belongs to no claim, so the baseline the §11
   * unwind is measured against silently omitted it. That row carries $0.00, so
   * the number did not move; "the number did not move this time" is not a
   * property.
   */
  for (const name of [FILES.inventory, FILES.unwind]) {
    const src = code(name);
    assert.match(
      src,
      /'\/claimprocs',\s*\{\s*PatNum: T\.PAT_NUM|list\('\/claimprocs'\)/,
      `${name} must read claimprocs by patient`
    );
    assert.ok(
      !/'\/claimprocs',\s*\{\s*ClaimNum/.test(src),
      `${name} must not derive the ledger from claim-scoped claimproc reads`
    );
  }
  assert.match(read(FILES.inventory), /DETACHED — belongs to no claim/, 'and say so in the table');
});

// ─── 3. The prep creates two targets and cannot be talked into a third ──────

test('the prep script writes with POST and nothing else', () => {
  const src = code(FILES.prep);
  assert.match(src, /apiWriteRaw\('POST'/, 'it posts through the transport');
  assert.ok(!/apiWriteRaw\('PUT'/.test(src), 'it must not PUT');
  assert.ok(!/axios\.delete\(|client\.delete\(|apiWriteRaw\('DELETE'/.test(src), 'it must not DELETE');
  // And it must not reach the raw axios instance at all — the transport enforces
  // OPENDENTAL_WRITE_DISABLED inside apiWriteRaw, and a dev box that sets that
  // flag must not be able to create charges on the shared live database.
  assert.ok(!/handle\.client\.client/.test(src), 'the prep must write through apiWriteRaw, not raw axios');
});

test('the prep script hard-codes the patient, the fee and the target count', () => {
  const src = code(FILES.prep);
  // Every one of these comes from the frozen constants module. A PatNum or a fee
  // read from argv or the environment is a parameter, and a parameter is a typo
  // away from a real patient.
  assert.match(src, /PatNum: T\.PAT_NUM/);
  assert.match(src, /ProcFee: T\.PROC_FEE/);
  assert.match(src, /i < T\.TARGET_COUNT/, 'a fixed loop, not a configurable count');
  assert.ok(
    !/process\.argv/.test(src),
    'the prep must take no positional arguments — there is nothing about it to vary'
  );
  /*
   * Three env vars, and none of them can redirect the write.
   *
   *   PROBE_OFFICE        an assertion that can only refuse (never redirect).
   *   S10_EXPECTED_CLAIMS the inventory's baseline; gates whether it runs.
   *   OFFICE_TIMEZONE     the zone ProcDate is derived in. It DOES affect what is
   *                       written — by at most one day — which is why the value is
   *                       read back from the chart and a disagreement aborts. It
   *                       is platform-wide config, set once, not a per-run knob;
   *                       the same var the drain and the OD sync already use.
   *
   * Note what is absent: no PatNum, no fee, no count, no id of any kind.
   */
  const envs = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...new Set(envs)],
    ['OFFICE_TIMEZONE', 'PROBE_OFFICE', 'S10_EXPECTED_CLAIMS'],
    'no env var may name a patient, an amount, a count or an id'
  );
});

test('the prep script sends ProcDate, which POST /procedurelogs requires', () => {
  /*
   * MEASURED 2026-08-25: the first prep run got
   *
   *     400 "ProcDate is required."
   *
   * The Open Dental API reference for procedurelogs lists PatNum, ProcDate,
   * ProcStatus and procCode-or-CodeNum as required. The recipe transcribed into
   * `RCM_OD_WRITES.md` and `RCM_POSTING.md` §10.1 omitted ProcDate — both are
   * corrected alongside this test, because a recipe in a doc is what the next
   * person copies.
   *
   * ProcFee and ProvNum are documented OPTIONAL and are sent anyway. ProcFee
   * because the walk's whole arithmetic is that this procedure costs exactly
   * $1.00 and the default is the code's fee "with consideration of the patient's
   * insurance" — a number this walk does not control. ProvNum because its default
   * chain ends at the office default provider, which would make the row depend on
   * practice configuration.
   *
   * DateEntryC is NOT sent: it appears in responses, but the reference does not
   * list it as a create parameter.
   */
  const src = code(FILES.prep);
  const body = /await od\.post\('\/procedurelogs', \{([\s\S]*?)\}\);/.exec(src);
  assert.ok(body, 'the procedurelog create must be findable');
  const fields = [...body[1].matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    fields,
    ['PatNum', 'ProcDate', 'ProcFee', 'ProcStatus', 'ProvNum', 'procCode'].sort(),
    'exactly the four required fields plus the two deliberate optionals'
  );
  assert.ok(!/DateEntryC/.test(src), 'DateEntryC is not a documented create parameter');
});

test('the prep script derives ProcDate in the office timezone, not UTC', () => {
  /*
   * UTC midnight lands mid-evening in Central, so a prep run at 7pm the night
   * before the walk would stamp TOMORROW on the procedure. The matcher would then
   * score the 835's service date against a chart date a day out, and §11 would
   * reconcile against a row dated after the walk that created it.
   *
   * Same reasoning and same implementation as `postingDrain.officeToday()`.
   */
  const src = code(FILES.prep);
  assert.match(src, /OFFICE_TIMEZONE \|\| 'America\/Chicago'/);
  assert.match(src, /timeZone: tz/, 'the date must be formatted IN that zone');
  assert.match(src, /const procDate = officeToday\(\)/);
  assert.ok(
    !/ProcDate: new Date\(\)|ProcDate: .*toISOString/.test(src),
    'never a bare UTC timestamp'
  );

  // 03:00 UTC on the 26th is still the 25th in Central — the exact off-by-one
  // this guards, exercised rather than asserted about.
  const { officeToday } = require(path.join(SCRIPTS, FILES.prep));
  const prior = process.env.OFFICE_TIMEZONE;
  process.env.OFFICE_TIMEZONE = 'America/Chicago';
  try {
    assert.equal(officeToday(new Date('2026-08-26T03:00:00Z')), '2026-08-25');
    assert.equal(officeToday(new Date('2026-08-26T13:00:00Z')), '2026-08-26');
  } finally {
    if (prior === undefined) delete process.env.OFFICE_TIMEZONE;
    else process.env.OFFICE_TIMEZONE = prior;
  }
});

test('the prep script checks the output directory BEFORE its first Open Dental call', () => {
  /*
   * THE ORDERING DEFECT, 2026-08-25. The run aborted correctly on the ProcDate
   * 400, printed "Nothing was created for this target" — and then died on EACCES
   * writing the manifest in the abort path. The last line the operator saw was
   * `PREP FAILED: EACCES`, which describes neither the real failure nor what the
   * script did about it. A failure in the REPORTING path masked the failure being
   * reported.
   *
   * Checking up front makes the first error the only error, and means the
   * chart-touching part never begins when the cheap precondition it depends on is
   * already broken. A prep that creates two live claims and only THEN finds it
   * cannot record them is the exact outcome the manifest exists to prevent.
   */
  /*
   * Measured from the start of `main()`, not from the top of the file: `od.get(`
   * and `od.post(` also appear inside the `pacedOd` helper DEFINED above main,
   * and a whole-file index comparison would be testing where functions are
   * declared rather than the order in which they run.
   */
  const whole = code(FILES.prep);
  const mainAt = whole.indexOf('async function main()');
  assert.ok(mainAt > 0, 'main() must be findable');
  const src = whole.slice(mainAt);

  const check = src.indexOf('T.checkOutDirWritable()');
  assert.ok(check > 0, 'the prep must check the output directory inside main()');

  for (const later of ['loadSecrets()', 'odOffices.getOdOffice', 'od.get(', 'od.post(']) {
    const at = src.indexOf(later);
    assert.ok(at > 0, `sanity: ${later} is called in main()`);
    assert.ok(at > check, `checkOutDirWritable must precede ${later}`);
  }

  // And the manifest write no longer creates the directory itself — that would
  // be a second, later, unguarded chance to hit the same EACCES.
  assert.ok(!/fs\.mkdirSync\(T\.OUT_DIR/.test(src), 'no late mkdir in the prep');
});

test('the prep prints the created ids BEFORE writing the manifest, and survives a failed write', () => {
  /*
   * `checkOutDirWritable` ran before the first Open Dental call, so this write
   * should not fail. "Should not" is not "cannot" — a volume can go away between
   * the two — and if it does, the console transcript becomes the only surviving
   * record of what was created on a live chart. Whatever happens to the file, an
   * operator ends up holding the numbers.
   */
  const src = code(FILES.prep);
  const printed = src.indexOf('WHAT THIS RUN CREATED');
  const written = src.indexOf('fs.writeFileSync(T.MANIFEST_PATH');
  assert.ok(printed > 0 && written > 0);
  assert.ok(printed < written, 'the ids are printed before the file is written');

  // The write is guarded, and the failure path re-prints the whole manifest so it
  // can be reconstructed by hand rather than lost.
  assert.match(src, /try \{\s*\n\s*fs\.writeFileSync\(T\.MANIFEST_PATH/);
  assert.match(src, /COULD NOT WRITE THE MANIFEST/);
  assert.match(src, /ONLY record of what was created/);
});

test('the prep script refuses any office but roland, and refuses an existing manifest', () => {
  const src = read(FILES.prep);
  assert.match(src, /office !== T\.OFFICE/, 'it must refuse a foreign PROBE_OFFICE');
  assert.match(src, /fs\.existsSync\(T\.MANIFEST_PATH\)/, 'it must refuse if a manifest exists');
  assert.match(src, /REFUSED: a manifest already exists/);
  // The office assertion is belt AND braces: validated against the registry, then
  // asserted against the handle the registry froze.
  assert.match(src, /assertOfficeMatch\(office, odOffices\.getOdOffice\(office\)\)/);
});

test('the prep script reads every created id back before trusting it (G2)', () => {
  /*
   * `PUT /claimprocs {DateCP}` returns 200 OK and changes nothing (Spike 0b test
   * 2b). A 201 is a claim about a row, not the row — and the manifest is the
   * unwind's only authority, so an id in it that does not exist would aim a
   * DELETE at nothing, or worse, at something else.
   */
  const src = read(FILES.prep);
  assert.match(src, /did not read back/, 'a create whose read-back disagrees is a failure');
  assert.match(src, /od\.get\(`\/procedurelogs\/\$\{procNum\}`\)/);
  assert.match(src, /od\.get\(`\/claims\/\$\{claimNum\}`\)/);
});

test('the prep script re-checks the claim count before EACH create', () => {
  /*
   * Not once at the top. The two creates are ~10 s apart, and a claim appearing
   * in between is exactly the condition being watched for.
   */
  const src = read(FILES.prep);
  const loopStart = src.indexOf('for (let i = 0; i < T.TARGET_COUNT');
  assert.ok(loopStart > 0);
  assert.ok(
    src.indexOf('const before = await claimCount(od)') > loopStart,
    'the pre-check must run inside the loop'
  );
  assert.match(src, /A claim appeared or disappeared since the inventory/);
});

test('the prep script stops rather than touching the plan when POST /claims fails', () => {
  const src = read(FILES.prep);
  assert.match(src, /Do NOT touch PatPlanNum/);
  assert.match(src, /does not get to make one/);
  // And it must not name a plan-mutating endpoint anywhere.
  assert.ok(!/\/patplans/i.test(code(FILES.prep)), 'the prep must never name /patplans');
});

test('the prep script records a partial run in the manifest rather than losing it', () => {
  /*
   * The worst available outcome here is a row created and unrecorded: the unwind
   * takes ids from the manifest and from nowhere else, so a create the manifest
   * does not name can never be removed by the tooling that made it.
   */
  const src = read(FILES.prep);
  const write = src.indexOf('fs.writeFileSync(T.MANIFEST_PATH');
  assert.ok(write > 0, 'it must write a manifest');
  // The write sits AFTER the loop and outside every abort path, so a run that
  // stopped at target A still records target A.
  assert.ok(
    write > src.indexOf('for (let i = 0; i < T.TARGET_COUNT'),
    'the manifest is written after the loop, so a partial run is still recorded'
  );
  for (const abort of ['process.exitCode = 7;', 'process.exitCode = 8;', 'process.exitCode = 9;']) {
    const at = src.indexOf(abort);
    assert.ok(at > 0 && at < write, `${abort} must break out of the loop rather than return before the manifest`);
  }
  // And completeness is RECORDED rather than assumed, so a partial manifest
  // announces itself to the unwind instead of looking like a finished prep.
  assert.match(src, /complete: targets\.length === T\.TARGET_COUNT/);
});

// ─── 4. The 835 generator ───────────────────────────────────────────────────

test('the 835 generator touches no Open Dental client and loads no secrets', () => {
  /*
   * It reads a manifest and writes two files. Giving it an office handle would
   * make a file-writing script one refactor away from a chart-reading one.
   */
  const src = code(FILES.era);
  assert.ok(!src.includes('odOffices'), 'no office registry');
  assert.ok(!src.includes('loadSecrets'), 'no secrets');
  assert.ok(!src.includes('apiGetRaw') && !src.includes('apiWriteRaw'), 'no transport');
});

test('the generated 835 parses, pays $1.00 on the real ClaimNum, and raises no review flags', () => {
  /*
   * The single most load-bearing behaviour in this file. If the 835 does not
   * parse, or parses to a flagged claim, the walk stops at the upload and the
   * night is spent debugging X12 instead of watching money reach a ledger.
   */
  const { build835 } = require(path.join(SCRIPTS, FILES.era));
  const { parse835 } = require('../services/rcm/eraParser');

  const era = build835({
    label: 'A',
    claimNum: 60001,
    patLast: 'TESTFIXTURE',
    patFirst: 'SYNTHETIC',
    procCode: 'D0140',
    feeCents: 100,
    serviceDate: '2026-08-25',
    controlNumber: '000000001',
  });

  const parsed = parse835(era);
  assert.equal(parsed.totalPaymentCents, 100);
  assert.equal(parsed.checkNumber, 'S10A-60001');
  assert.equal(parsed.claims.length, 1);

  const claim = parsed.claims[0];
  assert.equal(claim.claimNumber, '60001', 'CLP01 must carry the real ClaimNum — 35/100 of the match');
  assert.equal(claim.totalPaidCents, 100);
  assert.equal(claim.totalBilledCents, 100);
  assert.equal(claim.isDenied, false);
  assert.equal(claim.isReversal, false);
  assert.deepEqual(claim.needsReviewReasons, [], 'a prep artifact must not arrive already flagged');
  assert.equal(claim.procedures.length, 1);
  assert.equal(claim.procedures[0].code, 'D0140');
  assert.equal(claim.procedures[0].paidCents, 100);
  assert.deepEqual(claim.procedures[0].adjustments, [], 'no CAS: nothing is disallowed');
});

test('the generated 835 carries the chart name, so the matcher can score it', () => {
  const { build835 } = require(path.join(SCRIPTS, FILES.era));
  const { parse835 } = require('../services/rcm/eraParser');
  const { nameTokens } = require('../services/rcm/claimMatch');

  const parsed = parse835(
    build835({
      label: 'A',
      claimNum: 60001,
      patLast: 'TESTFIXTURE',
      patFirst: 'SYNTHETIC',
      procCode: 'D0140',
      feeCents: 100,
      serviceDate: '2026-08-25',
      controlNumber: '000000001',
    })
  );

  // Two shared tokens is what earns PATIENT_NAME_MATCH; one earns PARTIAL and
  // zero is DISQUALIFYING on the name-search lane.
  const ours = nameTokens(parsed.claims[0].patientName);
  const chart = nameTokens('TESTFIXTURE SYNTHETIC');
  assert.ok(ours.filter((t) => chart.includes(t)).length >= 2);
});

test('the two 835s cannot dedupe each other away', () => {
  /*
   * The remittance key is office-scoped and derived from the check. Two files
   * with the same check number would collide, and the second upload would be
   * refused as a duplicate — leaving §10.3's kill-mid-drain with no target.
   */
  const { build835 } = require(path.join(SCRIPTS, FILES.era));
  const { parse835 } = require('../services/rcm/eraParser');
  const spec = {
    patLast: 'TESTFIXTURE',
    patFirst: 'SYNTHETIC',
    procCode: 'D0140',
    feeCents: 100,
    serviceDate: '2026-08-25',
  };
  const a = parse835(build835({ ...spec, label: 'A', claimNum: 60001, controlNumber: '000000001' }));
  const b = parse835(build835({ ...spec, label: 'B', claimNum: 60002, controlNumber: '000000002' }));
  assert.notEqual(a.checkNumber, b.checkNumber);
  assert.notEqual(a.claims[0].claimNumber, b.claims[0].claimNumber);
});

test('the 835 files carry no DOB, no NPI, no TIN and no subscriber id', () => {
  /*
   * Not "no real person's" — none at all. An invented 10-digit NPI is a number
   * that belongs to somebody, and a fabricated identifier in a file that gets
   * uploaded to a real system is exactly the habit this repo does not want.
   */
  const { build835 } = require(path.join(SCRIPTS, FILES.era));
  const era = build835({
    label: 'A',
    claimNum: 60001,
    patLast: 'TESTFIXTURE',
    patFirst: 'SYNTHETIC',
    procCode: 'D0140',
    feeCents: 100,
    serviceDate: '2026-08-25',
    controlNumber: '000000001',
  });
  assert.ok(!/\bDMG\*/.test(era), 'no DMG — no date of birth');
  assert.ok(!/\*XX\*\d/.test(era), 'no NPI qualifier with a number behind it');
  assert.ok(!/\*MI\*/.test(era), 'no member/subscriber id');
  assert.ok(!/REF\*1L\*/.test(era), 'no group number');
  assert.ok(!/NM1\*82\*/.test(era), 'no rendering provider');
  assert.match(era, /CAREIN SYNTHETIC PAYER/, 'the payer says what it is on its face');
});

// ─── 5. The unwind — the one file that may DELETE ───────────────────────────

test('the unwind takes its ids from the manifest and from nowhere else', () => {
  /*
   * THE PROPERTY THIS WHOLE FILE EXISTS FOR.
   *
   * An unwind that accepts ids as arguments is one typo away from deleting a real
   * patient's claim, and an unwind that FINDS its targets by reading the chart is
   * worse — it would delete whatever happens to look like a target today. Neither
   * is guarded by "the operator will be careful".
   */
  const src = code(FILES.unwind);

  // argv is read for exactly one thing: the --execute flag.
  const argvUses = [...src.matchAll(/process\.argv[^\n]*/g)].map((m) => m[0]);
  assert.equal(argvUses.length, 1, 'argv may be read once');
  assert.match(argvUses[0], /includes\('--execute'\)/, 'and only for the execute flag');

  // No id-shaped env var. PROBE_OFFICE is the office assertion, nothing else.
  const envs = [...new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  assert.deepEqual(envs.sort(), ['PROBE_OFFICE']);

  // Every id it acts on is destructured from a manifest target.
  assert.match(src, /const manifest = JSON\.parse\(fs\.readFileSync\(T\.MANIFEST_PATH/);
  assert.match(src, /Number\(target\.procNum\)/);
  assert.match(src, /Number\(target\.claimNum\)/);
  assert.match(src, /Number\(target\.claimProcNum\)/);
});

test('the unwind refuses when there is no manifest', () => {
  const src = read(FILES.unwind);
  assert.match(src, /if \(!fs\.existsSync\(T\.MANIFEST_PATH\)\)/);
  assert.match(src, /REFUSED: no manifest/);
  // And the refusal comes BEFORE the office handle is ever obtained, so a run
  // without a manifest does not even open a client.
  assert.ok(
    src.indexOf('REFUSED: no manifest') < src.indexOf('odOffices.assertOfficeMatch'),
    'the manifest gate must precede the client'
  );
});

test('the unwind never issues a DELETE against an id that is not in the manifest', () => {
  /*
   * Read literally: every DELETE path in the file interpolates a variable that
   * came off a manifest target (or, for the check, off the claimproc that target
   * names). There is no literal id and no id from any other source.
   */
  const src = code(FILES.unwind);
  const deletes = [...src.matchAll(/\bwrite\('DELETE',\s*`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(
    deletes.sort(),
    ['/claimpayments/${claimPaymentNum}', '/claims/${claimNum}', '/procedurelogs/${procNum}'].sort(),
    'exactly three DELETE targets, all interpolated from manifest-derived ids'
  );
  // No bare axios.delete outside the one issue() helper — a second call site is
  // a second policy about what may be removed.
  assert.equal((src.match(/axios\.delete\(/g) || []).length, 1);

  // And the two PUTs are equally bounded: the un-receive and the line revert,
  // nothing else. A third PUT would be a third thing this script can change.
  const puts = [...src.matchAll(/\bwrite\('PUT',\s*`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(
    puts.sort(),
    ['/claims/${claimNum}', '/claimprocs/${claimProcNum}'].sort(),
    'exactly two PUT targets'
  );
});

test('the unwind hard-denies the Spike 0b residue even if a manifest names it', () => {
  /*
   * The failure mode is NOT an operator typing the wrong number. It is a manifest
   * regenerated from a live read that sweeps the residue in with the targets. A
   * deny-list survives that; a warning in a header does not.
   *
   * And the response is to issue NOTHING, not to skip the denied rows: a list of
   * things to delete that contains something it should not is not a trustworthy
   * list.
   */
  const src = read(FILES.unwind);
  assert.match(src, /T\.DENY_IDS\.includes\(id\)/);
  assert.match(src, /REFUSED: the manifest names Spike 0b residue/);
  assert.ok(
    src.indexOf('REFUSED: the manifest names Spike 0b residue') < src.indexOf('const axios = handle.client.client'),
    'the deny-list must be applied before the raw client is even reached'
  );
  /*
   * And EVERY step re-checks, through one predicate.
   *
   * The manifest is screened up front, but `payment` acts on a ClaimPaymentNum
   * discovered at RUN time off a live read — so it cannot rely on that screening.
   * Applying the same test to all five costs nothing and means a sixth step
   * cannot be added that quietly skips it.
   */
  const body = code(FILES.unwind);
  assert.match(body, /const denied = \(id\) => T\.DENY_IDS\.includes\(Number\(id\)\);/);
  assert.match(body, /denied\(claimPaymentNum\)/, 'the run-time-discovered check id');
  assert.match(body, /denied\(claimNum\)/);
  assert.match(body, /denied\(claimProcNum\)/);
  assert.match(body, /denied\(procNum\)/);
});

test('the unwind is a dry run unless --execute is passed', () => {
  const src = read(FILES.unwind);
  assert.match(src, /const execute = process\.argv\.includes\('--execute'\)/);
  assert.match(src, /if \(!execute\) \{\s*\n\s*console\.log\(`   \[dry run\]/, 'issue() must short-circuit');
  assert.match(src, /DRY RUN \(pass --execute to write\)/);
});

test('the unwind re-checks OPENDENTAL_WRITE_DISABLED, because it bypasses the transport', () => {
  /*
   * `apiWriteRaw` enforces the flag INSIDE the transport, which is what makes it
   * un-routable-around for everything writing through the class. The unwind does
   * not write through the class — it needs DELETE, which the transport does not
   * offer — so the guard would not otherwise apply. A dev box that sets the flag
   * so it cannot post into the shared live practice database must not be able to
   * delete from it either.
   */
  const src = read(FILES.unwind);
  assert.match(src, /isOdWriteDisabled\(\)/);
  assert.ok(
    src.indexOf('isOdWriteDisabled()') < src.indexOf('const axios = handle.client.client'),
    'the check must precede the raw client'
  );
});

test('the unwind runs the FIVE steps in the mandatory order', () => {
  /*
   * DELETE claimpayment -> PUT claim to "W" -> PUT claimproc to NotReceived ->
   * DELETE claim -> DELETE procedurelog.
   *
   * It was four until 2026-08-25. The un-receive is the step the Spike 0b
   * teardown never needed, because 0b never set the claim to Received — and the
   * drain does, as step 2 of its own forced order. Without it Open Dental refuses
   * the claimproc PUT ("Cannot change Status to NotReceived when attached to a
   * received claim.") and both DELETEs ("Claim cannot be deleted. Claim status is
   * Received." / "Not allowed to delete a procedure that is attached to a claim.")
   */
  const src = code(FILES.unwind);
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `expected to find ${needle}`);
    return i;
  };
  const payment = at("write('DELETE', `/claimpayments/");
  const unreceive = at("write('PUT', `/claims/");
  const line = at("write('PUT', `/claimprocs/");
  const claim = at("write('DELETE', `/claims/");
  const proc = at("write('DELETE', `/procedurelogs/");
  assert.ok(payment < unreceive, 'the check comes out first');
  assert.ok(unreceive < line, 'the claim is un-received before the line is reverted');
  assert.ok(line < claim, 'the line is cleared before the claim is deleted');
  assert.ok(claim < proc, 'the claim is deleted before the procedure');

  // The STEPS constant the script iterates for its summary table must agree with
  // the order above, rather than being a second list that can drift from it.
  const { STEPS } = require(path.join(SCRIPTS, FILES.unwind));
  assert.deepEqual([...STEPS], ['payment', 'unreceive', 'line', 'claim', 'procedure']);
});

test('the unwind reads every deletion back, and expects the procedure to survive as "D"', () => {
  const src = read(FILES.unwind);
  assert.match(src, /read-back: GET \/claimpayments/);
  assert.match(src, /read-back: GET \/claims/);
  // G12: the procedure row is EXPECTED to still be there, reading ProcStatus "D".
  // A read-back that reported "gone" would mean something other than a delete
  // happened, so the assertion is on the "D", not on absence.
  assert.match(src, /soft delete, as documented — G12/);
  assert.match(src, /ProcStatus="\$\{ps\}"/, 'the read-back prints what came back');
  // The un-receive read-back is the load-bearing one: a 200 that did not take
  // would send two DELETEs at a still-Received claim and bury the reason under
  // three 400s, which is how the 2026-08-25 transcript reads.
  assert.match(src, /read-back: GET \/claims\/\$\{claimNum\} -> \$\{back\.status\} ClaimStatus=/);
  assert.match(src, /the claim did not un-receive/);
});

test('the unwind prints a balance before and after, with "D" rows filtered', () => {
  const src = read(FILES.unwind);
  assert.match(src, /printBalance\('BEFORE'/);
  assert.match(src, /printBalance\(execute \? 'AFTER'/);
  assert.match(src, /ProcStatus\) !== 'D'/, 'live procedures only');
  assert.match(src, /soft-deleted procedures excluded/);
});


// ─── 5b. The unwind, DRIVEN — the 2026-08-25 defect and its fix ─────────────
//
// Everything above about the unwind is a source assertion, which is the right
// tool for "no id comes from argv" and the wrong one for "step 2 runs before
// step 3". The order and the resumability are BEHAVIOUR, and behaviour is what
// broke on 2026-08-25: the file said the right things about itself and still
// issued three writes Open Dental refused.
//
// So these drive the real `unwindTarget` against a recorded fake Open Dental,
// and assert on the call log.

/**
 * A tiny Open Dental that remembers rows and records every call.
 *
 * Deliberately NOT a mock that returns canned answers per call: it holds STATE,
 * so a second `unwindTarget` over the same instance sees what the first one did.
 * That is the whole property being tested — a script that can finish a job it
 * started — and a stateless stub cannot express it.
 *
 * @param {{ claim?: object|null, claimProc?: object|null, procedure?: object|null, payment?: object|null }} seed
 */
function fakeOd(seed) {
  const rows = {
    claim: seed.claim === undefined ? null : seed.claim,
    claimProc: seed.claimProc === undefined ? null : seed.claimProc,
    procedure: seed.procedure === undefined ? null : seed.procedure,
    payment: seed.payment === undefined ? null : seed.payment,
  };
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const writes = [];

  const missing = { ok: false, status: 404, data: null, error: 'not found' };
  const found = (data) => ({ ok: true, status: 200, data });

  /** Which stored row a path refers to. */
  function route(p) {
    if (/^\/claimpayments\//.test(p)) return 'payment';
    if (/^\/claimprocs\//.test(p)) return 'claimProc';
    if (/^\/claims\//.test(p)) return 'claim';
    if (/^\/procedurelogs\//.test(p)) return 'procedure';
    return null;
  }

  return {
    rows,
    calls,
    writes,
    async get(p) {
      calls.push(`GET ${p}`);
      const key = route(p);
      return key && rows[key] ? found(rows[key]) : missing;
    },
    async write(verb, p, body) {
      calls.push(`${verb} ${p}`);
      writes.push(`${verb} ${p}`);
      const key = route(p);
      if (!key || !rows[key]) return { ok: false, status: 404, error: 'not found' };

      if (verb === 'DELETE') {
        if (key === 'claim' && String(rows.claim.ClaimStatus) === 'R') {
          // The live refusal, verbatim from the 2026-08-25 run.
          return { ok: false, status: 400, error: 'Claim cannot be deleted. Claim status is Received.' };
        }
        if (key === 'procedure') {
          if (rows.claim) {
            return { ok: false, status: 400, error: 'Not allowed to delete a procedure that is attached to a claim.' };
          }
          // G12: soft. The row survives, reading "D".
          rows.procedure = { ...rows.procedure, ProcStatus: 'D' };
          return { ok: true, status: 200 };
        }
        if (key === 'payment') rows.claimProc = { ...rows.claimProc, ClaimPaymentNum: 0 };
        rows[key] = null;
        return { ok: true, status: 200 };
      }

      // PUT
      if (key === 'claimProc' && rows.claim && String(rows.claim.ClaimStatus) === 'R') {
        return {
          ok: false,
          status: 400,
          error: 'Cannot change Status to NotReceived when attached to a received claim.',
        };
      }
      rows[key] = { ...rows[key], ...body };
      return { ok: true, status: 200 };
    },
  };
}

/*
 * FICTIONAL IDS, and they have to be.
 *
 * These fixtures first used the walk's real numbers — claim 53784, claimproc
 * 535194, procedure 406124 — which read well until those ids were retired onto
 * the deny-list once the unwind had spent them. Every one of these tests then
 * failed, correctly: `unwindTarget` skips a denied id, which is exactly what the
 * deny-list is for.
 *
 * That is a good failure and a bad fixture. What these tests assert is the ORDER
 * and the IDEMPOTENCE of the step machine; the specific numbers are scenery. So
 * the scenery moves to ids nothing will ever retire, and the deny-list behaviour
 * gets an assertion of its own below rather than breaking five unrelated tests
 * every time the walk is run again.
 */
const TARGET = { procNum: 419901, claimNum: 59901, claimProcNum: 549901 };
const PAYMENT_NUM = 29901;

/** The shape the 2026-08-25 walk left behind, before any unwind ran. */
function postedTarget() {
  return fakeOd({
    payment: { ClaimPaymentNum: PAYMENT_NUM, CheckAmt: 1 },
    claimProc: { ClaimProcNum: TARGET.claimProcNum, Status: 'Received', InsPayAmt: 1, WriteOff: 0, DedApplied: 0, ClaimPaymentNum: PAYMENT_NUM },
    claim: { ClaimNum: TARGET.claimNum, ClaimStatus: 'R' },
    procedure: { ProcNum: TARGET.procNum, ProcStatus: 'C' },
  });
}

/** @param {ReturnType<typeof fakeOd>} od */
const drive = (od, execute = true) =>
  require(path.join(SCRIPTS, FILES.unwind)).unwindTarget(
    { get: od.get, write: od.write, log: () => {}, execute },
    TARGET
  );

test('the unwind un-receives the claim BEFORE reverting the claimproc', async () => {
  /*
   * THE 2026-08-25 DEFECT, as a test. The old order went straight from the check
   * to the claimproc PUT, and Open Dental refused it — "Cannot change Status to
   * NotReceived when attached to a received claim." — then refused both DELETEs
   * for the same underlying reason. Spike 0b never hit it because 0b never set
   * the claim to Received; the drain does.
   *
   * The fake reproduces both refusals, so this test fails against the old order
   * for exactly the reason the live run did.
   */
  const od = postedTarget();
  const { steps, aborted } = await drive(od);

  assert.equal(aborted, false, 'the whole target should complete');
  assert.deepEqual(steps, {
    payment: 'done',
    unreceive: 'done',
    line: 'done',
    claim: 'done',
    procedure: 'done',
  });

  const order = od.writes;
  assert.deepEqual(order, [
    `DELETE /claimpayments/${PAYMENT_NUM}`,
    `PUT /claims/${TARGET.claimNum}`,
    `PUT /claimprocs/${TARGET.claimProcNum}`,
    `DELETE /claims/${TARGET.claimNum}`,
    `DELETE /procedurelogs/${TARGET.procNum}`,
  ]);
  assert.ok(
    order.indexOf(`PUT /claims/${TARGET.claimNum}`) < order.indexOf(`PUT /claimprocs/${TARGET.claimProcNum}`),
    'the un-receive must precede the line revert'
  );

  // And the end state is the one §11 wants: no check, no claim, the line at
  // NotReceived/0, the procedure soft-deleted.
  assert.equal(od.rows.payment, null);
  assert.equal(od.rows.claim, null);
  assert.equal(od.rows.claimProc.Status, 'NotReceived');
  assert.equal(od.rows.claimProc.InsPayAmt, 0);
  assert.equal(od.rows.procedure.ProcStatus, 'D');
});

test('the unwind skips a claim payment that is already gone and still proceeds', async () => {
  /*
   * Exactly the state the half-failed 2026-08-25 run left: the checks were
   * deleted (so Open Dental reset ClaimPaymentNum to 0) but everything after that
   * was refused. A teardown that can only run against a pristine post-walk state
   * cannot clean up after its own failure.
   */
  const od = fakeOd({
    payment: null,
    claimProc: { ClaimProcNum: TARGET.claimProcNum, Status: 'Received', InsPayAmt: 1, WriteOff: 0, DedApplied: 0, ClaimPaymentNum: 0 },
    claim: { ClaimNum: TARGET.claimNum, ClaimStatus: 'R' },
    procedure: { ProcNum: TARGET.procNum, ProcStatus: 'C' },
  });
  const { steps, aborted } = await drive(od);

  assert.equal(aborted, false);
  assert.equal(steps.payment, 'already done', 'no ClaimPaymentNum means nothing to delete');
  assert.deepEqual(od.writes, [
    `PUT /claims/${TARGET.claimNum}`,
    `PUT /claimprocs/${TARGET.claimProcNum}`,
    `DELETE /claims/${TARGET.claimNum}`,
    `DELETE /procedurelogs/${TARGET.procNum}`,
  ]);
  assert.ok(!od.writes.some((w) => w.includes('/claimpayments/')), 'no payment write at all');
  for (const s of ['unreceive', 'line', 'claim', 'procedure']) {
    assert.equal(steps[s], 'done', `${s} must still run`);
  }
});

test('the unwind writes nothing at all for a target made of denied ids', async () => {
  /*
   * The behaviour that broke the five fixtures above when the 2026-08-25 walk's
   * ids were retired, asserted deliberately instead of by accident.
   *
   * A manifest naming a spent id did not come from a prep run, so nothing about
   * it can be trusted — not even the rows that look fine. Every step reports
   * `skipped` and issues nothing; there is no partial cooperation with an
   * untrustworthy list.
   */
  const T = require(path.join(SCRIPTS, FILES.targets));
  const spent = {
    procNum: T.WALK_SPENT_IDS.procedures[0],
    claimNum: T.WALK_SPENT_IDS.claims[0],
    claimProcNum: T.WALK_SPENT_IDS.claimProcs[0],
  };
  const od = fakeOd({
    payment: { ClaimPaymentNum: 29901, CheckAmt: 1 },
    claimProc: { ClaimProcNum: spent.claimProcNum, Status: 'Received', InsPayAmt: 1, WriteOff: 0, DedApplied: 0, ClaimPaymentNum: 29901 },
    claim: { ClaimNum: spent.claimNum, ClaimStatus: 'R' },
    procedure: { ProcNum: spent.procNum, ProcStatus: 'C' },
  });

  const { steps } = await require(path.join(SCRIPTS, FILES.unwind)).unwindTarget(
    { get: od.get, write: od.write, log: () => {}, execute: true },
    spent
  );

  assert.deepEqual(od.writes, [], 'a denied target must produce no write of any kind');
  for (const step of ['unreceive', 'line', 'claim', 'procedure']) {
    assert.equal(steps[step], 'skipped', `${step} must be skipped`);
  }
  // The rows are untouched, which is the point.
  assert.equal(od.rows.claim.ClaimStatus, 'R');
  assert.equal(od.rows.procedure.ProcStatus, 'C');
});

test('the unwind on an already-unwound target issues zero writes', async () => {
  /*
   * Re-running must be free. Not "harmless" — FREE: no write of any kind reaches
   * a chart, because every step reads its target state first. That is what makes
   * "just run it again" a safe instruction to give an operator at 1am.
   */
  const od = postedTarget();
  await drive(od);
  const afterFirst = od.writes.length;
  assert.ok(afterFirst > 0, 'sanity: the first pass wrote');

  od.writes.length = 0;
  const { steps, aborted } = await drive(od);

  assert.equal(aborted, false);
  assert.deepEqual(od.writes, [], 'a second pass must issue nothing');
  for (const step of Object.keys(steps)) {
    assert.equal(steps[step], 'already done', `${step} should report already done`);
  }
});

test('a ClaimStatus read-back that is not "W" aborts before any DELETE', async () => {
  /*
   * G2 at its most load-bearing. Open Dental answers 200 to writes it ignores
   * (`PUT /claimprocs {DateCP}`, Spike 0b test 2b), so a 200 here is not proof
   * the claim un-received. If it did not, the two DELETEs after it are going to
   * be refused — and issuing them anyway is what buried the real reason under
   * three 400s on 2026-08-25.
   *
   * This fake accepts the PUT with a 200 and quietly keeps the claim Received.
   */
  const od = postedTarget();
  const realWrite = od.write;
  od.write = async (verb, p, body) => {
    if (verb === 'PUT' && p.startsWith('/claims/')) {
      od.calls.push(`${verb} ${p}`);
      od.writes.push(`${verb} ${p}`);
      return { ok: true, status: 200 }; // 200, and nothing changed.
    }
    return realWrite(verb, p, body);
  };

  const { steps, aborted } = await drive(od);

  assert.equal(aborted, true, 'the target must stop');
  assert.equal(steps.unreceive, 'failed');
  assert.deepEqual(od.writes, [`DELETE /claimpayments/${PAYMENT_NUM}`, `PUT /claims/${TARGET.claimNum}`]);
  assert.ok(!od.writes.some((w) => w.startsWith('DELETE /claims/')), 'no claim DELETE');
  assert.ok(!od.writes.some((w) => w.startsWith('DELETE /procedurelogs/')), 'no procedure DELETE');
  // The rows are untouched past the check, so a re-run can still finish the job.
  assert.equal(od.rows.claim.ClaimStatus, 'R');
  assert.equal(od.rows.procedure.ProcStatus, 'C');
});

test('a dry run reads everything and writes nothing', async () => {
  /*
   * The dry run still performs the READS — that is what lets it report "the
   * payments are already gone, four steps pending per target" rather than a
   * guess at what it would do.
   */
  const od = postedTarget();
  const { steps, aborted } = await drive(od, false);

  assert.equal(aborted, false);
  assert.deepEqual(od.writes, [], 'a dry run issues no write');
  assert.ok(od.calls.some((c) => c.startsWith('GET ')), 'but it does read');
  assert.equal(steps.payment, 'pending');
  assert.equal(steps.unreceive, 'pending');
  // The claim is still Received in the fake, so the later steps are reported as
  // pending too rather than being silently reordered.
  assert.equal(od.rows.claim.ClaimStatus, 'R');
});

// ─── 6. Every one of them loads its own secrets and guards main() ───────────

test('every walk script that talks to Open Dental loads secrets first and guards main()', () => {
  /*
   * The two defects the 2026-08-24 D-7 run exposed, generalised. A script whose
   * documented invocation does not work gets improvised at a live database; a
   * script that runs on import turns any require into a write.
   */
  for (const name of [FILES.inventory, FILES.prep, FILES.unwind]) {
    const src = read(name);
    assert.match(src, /await require\('\.\.\/config\/secrets'\)\.loadSecrets\(\);/, `${name} must load its own secrets`);
    // ...and do it before anything reaches the office registry.
    assert.ok(
      src.indexOf('loadSecrets()') < src.indexOf('odOffices.getOdOffice'),
      `${name} must load secrets before resolving an office`
    );
    assert.match(src, /require\.main === module/, `${name} must guard main()`);
  }
  // The 835 generator talks to nothing, but the rule is uniform so nobody has to
  // check which scripts are safe to import.
  assert.match(read(FILES.era), /require\.main === module/);
});

test('every walk script paces itself to the shared credential', () => {
  for (const name of [FILES.inventory, FILES.prep, FILES.unwind]) {
    const src = code(name);
    assert.match(src, /sleep\(T\.PACE_MS\)/, `${name} must pace every Open Dental call`);
  }
});

test('no walk script can be pointed at valley', () => {
  /*
   * valley is fail-closed until D-7 is discharged (RCM_POSTING §9), and PatNum
   * 7115 — valley's test patient — belongs to 6d. More sharply: PatNum 7115 in
   * Roland is a DIFFERENT, REAL person, which is the entire reason the per-office
   * layer exists. `PROBE_OFFICE` is an assertion that can only cause a refusal.
   */
  for (const name of [FILES.inventory, FILES.prep, FILES.unwind]) {
    const src = code(name);
    assert.match(src, /office !== T\.OFFICE/, `${name} must refuse a foreign office`);
    assert.ok(!/'valley'/.test(src), `${name} must not name valley as a target`);
  }
});
