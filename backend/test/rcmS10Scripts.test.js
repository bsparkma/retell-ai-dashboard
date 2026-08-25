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

test('rcm-s10-targets requires nothing but node:path, so importing it can run nothing', () => {
  /*
   * The same rule `rcm-d7-ghost.js` follows, for the same reason. Four scripts
   * must agree on one patient, one office and one manifest path; two of them
   * write and one DELETEs. If they got that agreement by importing each other,
   * requiring one would be enough to run another — which is precisely what
   * happened on 2026-08-24, when a script named "read sweep" re-issued every
   * write verb because the file it imported called main() at load.
   */
  const src = code(FILES.targets);
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['node:path'], 'rcm-s10-targets must import nothing else');
  assert.ok(!/\bmain\s*\(/.test(src), 'and it must not call anything');
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
  // The only env vars it reads are the office assertion and the inventory's
  // baseline. Neither can change WHAT it writes, only whether it runs at all.
  const envs = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(envs)], ['PROBE_OFFICE', 'S10_EXPECTED_CLAIMS']);
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
  const deletes = [...src.matchAll(/issue\('DELETE',\s*`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(
    deletes.sort(),
    ['/claimpayments/${claimPaymentNum}', '/claims/${claimNum}', '/procedurelogs/${procNum}'].sort(),
    'exactly three DELETE targets, all interpolated from manifest-derived ids'
  );
  // No bare axios.delete outside the one issue() helper — a second call site is
  // a second policy about what may be removed.
  assert.equal((src.match(/axios\.delete\(/g) || []).length, 1);
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
  // The claimpayment it discovers at run time is checked too — that id comes off
  // a live read rather than off the manifest, so it needs its own check.
  assert.match(src, /T\.DENY_IDS\.includes\(claimPaymentNum\)/);
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

test('the unwind runs the four steps in the mandatory order', () => {
  /*
   * DELETE claimpayment -> PUT claimproc back to NotReceived -> DELETE claim ->
   * DELETE procedurelog. Measured in the Spike 0b teardown; the first pass fails
   * in any other order, because the claim is pinned by the money on its lines.
   */
  const src = code(FILES.unwind);
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `expected to find ${needle}`);
    return i;
  };
  const payment = at("issue('DELETE', `/claimpayments/");
  const line = at("issue('PUT', `/claimprocs/");
  const claim = at("issue('DELETE', `/claims/");
  const proc = at("issue('DELETE', `/procedurelogs/");
  assert.ok(payment < line, 'the check comes out before the line is cleared');
  assert.ok(line < claim, 'the line is cleared before the claim is deleted');
  assert.ok(claim < proc, 'the claim is deleted before the procedure');
});

test('the unwind reads every deletion back, and expects the procedure to survive as "D"', () => {
  const src = read(FILES.unwind);
  assert.match(src, /read-back: GET \/claimpayments/);
  assert.match(src, /read-back: GET \/claims/);
  // G12: the procedure row is EXPECTED to still be there, reading ProcStatus "D".
  // A read-back that reported "gone" would mean something other than a delete
  // happened, so the assertion is on the "D", not on absence.
  assert.match(src, /soft delete, as documented — G12/);
  assert.match(src, /ProcStatus="\$\{back\.data\?\.ProcStatus\}"/, 'the read-back prints what came back');
});

test('the unwind prints a balance before and after, with "D" rows filtered', () => {
  const src = read(FILES.unwind);
  assert.match(src, /printBalance\('BEFORE'/);
  assert.match(src, /printBalance\(execute \? 'AFTER'/);
  assert.match(src, /ProcStatus\) !== 'D'/, 'live procedures only');
  assert.match(src, /soft-deleted procedures excluded/);
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
