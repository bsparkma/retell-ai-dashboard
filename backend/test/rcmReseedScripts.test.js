'use strict';

/*
 * THE PROPERTIES THAT KEEP THE RESEED SCRIPTS NARROW.
 *
 * Same shape and the same reasoning as `test/rcmS10Scripts.test.js`. These are
 * static properties of files that write to a LIVE practice database, and the
 * §9 run of 2026-08-24 is why they are pinned rather than reviewed once: the
 * D-7 probes had been written, reviewed and approved, and the first time anybody
 * executed them they could not load their own secrets and importing one ran it.
 *
 * A property asserted in a header is a property until somebody edits the file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../scripts/rcm/reseed-targets');

const SCRIPTS = path.join(__dirname, '..', 'scripts', 'rcm');

/** A script with comments stripped — the headers explain what the code must not do. */
function code(name) {
  return fs
    .readFileSync(path.join(SCRIPTS, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ALL = ['reseed-targets.js', 'reseed-prep.js', 'reseed-835.js', 'reset-staging-fixtures.js'];

test('every reseed script guards main() behind require.main', () => {
  /*
   * Requiring a file must not be enough to make it write to a chart or delete a
   * row. `reseed-targets.js` is the exception and must have NO main at all —
   * it is the constants module the other two share, and the whole reason it
   * exists is that requiring it can run nothing.
   */
  for (const name of ALL) {
    if (name === 'reseed-targets.js') continue;
    assert.match(code(name), /require\.main\s*===\s*module/, `${name} must guard main()`);
  }
});

test('reseed-targets.js has no top-level call, and requires only node builtins', () => {
  /*
   * THE 2026-08-24 LESSON, PORTED. The D-7 read sweep got its shared id by
   * importing the write probe; the probe called `main()` at load; a script named
   * "read sweep" re-issued every write verb. The fix is a constants module that
   * cannot do anything.
   *
   * `reseed-prep.js` WRITES and `reseed-835.js` does not, and neither may import
   * the other — so the agreement lives here, and here must be inert.
   */
  const src = code('reseed-targets.js');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(
    requires.sort(),
    ['node:fs', 'node:path'],
    'the constants module must require nothing but node builtins'
  );
  assert.ok(!/\bmain\s*\(/.test(src), 'it must not call anything at module scope');
  /*
   * And in particular it must not REQUIRE the two scripts that use it. The
   * `requires` assertion above already proves that; this is the same property
   * spelled at the name, so a future edit that adds `require('./reseed-prep')`
   * fails on the sentence that says why rather than on a list of builtins.
   *
   * NOTE it is a check on requires, not on the bytes: the refusal messages in
   * this file legitimately PRINT `scripts/rcm/reseed-prep.js` as the command an
   * operator should run next, and a substring scan would flag that help text.
   */
  for (const sibling of ['reseed-prep', 'reseed-835']) {
    assert.ok(
      !requires.some((r) => r.includes(sibling)),
      `the constants must not require ${sibling} — one of them writes to a chart`
    );
  }
});

test('the prep is POST-only — no PUT, no DELETE, anywhere in the file', () => {
  const src = code('reseed-prep.js');
  /*
   * `apiWriteRaw` itself accepts PUT. The seam in this file passes no method
   * through, so there is no argument any caller could supply that would issue
   * one — but the static check is what stops the seam from growing a parameter.
   */
  assert.ok(src.includes("apiWriteRaw('POST'"), 'the prep must name POST explicitly');
  assert.ok(!/apiWriteRaw\(\s*['"]PUT/.test(src), 'no PUT');
  assert.ok(!/apiWriteRaw\(\s*['"]DELETE/.test(src), 'no DELETE');
  assert.ok(!/axios\.delete\(|client\.delete\(|axios\.put\(|client\.put\(/.test(src), 'no raw PUT/DELETE');
  // `POST` must be the only method string the seam can carry.
  const methods = [...src.matchAll(/apiWriteRaw\(\s*['"](\w+)['"]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['POST']);
});

test('the prep loads its own secrets BEFORE it touches the office registry', () => {
  /*
   * §9's defect, exactly: a standalone script that never called `loadSecrets()`
   * could not resolve the customer key and died holding nothing useful. The
   * ORDER is the property — secrets, then registry — because the registry read
   * is what needs the secret.
   */
  const src = code('reseed-prep.js');
  const secrets = src.indexOf('loadSecrets');
  const registry = src.indexOf('getOdOffice');
  assert.ok(secrets !== -1, 'the prep must load its own secrets');
  assert.ok(registry !== -1, 'the prep must resolve an office handle');
  assert.ok(secrets < registry, 'secrets must be loaded before the office registry is read');
  // And the office must be asserted against the handle it was resolved from.
  assert.match(src, /assertOfficeMatch\(\s*OFFICE\s*,\s*odOffices\.getOdOffice\(OFFICE\)\s*\)/);
});

test('the prep takes no positional arguments, and its patients and fees are constants', () => {
  const src = code('reseed-prep.js');
  /*
   * `--execute` is the ONLY thing argv may carry. An unwind or a prep that takes
   * ids from an argument is one typo away from writing against a real chart, and
   * "the operator will be careful" is not a safety property.
   */
  const argvReads = [...src.matchAll(/process\.argv[^\n]*/g)].map((m) => m[0]);
  assert.equal(argvReads.length, 1, `argv must be read exactly once, saw: ${argvReads.join(' | ')}`);
  assert.match(argvReads[0], /includes\('--execute'\)/);

  // No PatNum literal in the writer at all — they come from the frozen table.
  assert.ok(!/\b1282[78]\b/.test(src), 'PatNums belong in reseed-targets.js, not in the writer');
  // The loop is over the frozen table, not over anything a caller supplies.
  assert.match(src, /for \(const target of T\.TARGETS\)/);
});

test('the prep re-checks the baseline before EVERY create, not once at the top', () => {
  /*
   * The seven creates are seconds apart, and a claim appearing between two of
   * them is precisely the condition being watched for — somebody else working on
   * these patients while this runs. A single check at the top would miss it.
   */
  const src = code('reseed-prep.js');
  const loopStart = src.indexOf('for (const target of T.TARGETS)');
  assert.ok(loopStart !== -1);
  const loopBody = src.slice(loopStart);
  assert.match(loopBody, /claimCounts\(od\)/, 'the pre-check must run inside the loop');
  assert.match(loopBody, /ABORTED before/, 'and abort by name when the count moved');
});

test('the prep writes the manifest after every target, including a partial run', () => {
  /*
   * The worst outcome available here is a row created and UNRECORDED: the unwind
   * removes only what the manifest names, so a create the manifest does not name
   * can never be removed by the tooling that made it.
   */
  const src = code('reseed-prep.js');
  const loopStart = src.indexOf('for (const target of T.TARGETS)');
  assert.match(src.slice(loopStart), /writeManifest\(manifest\)/);
  // `complete: false` is written first and only flipped at the end.
  assert.match(src, /complete:\s*false/);
  assert.match(src, /manifest\.complete\s*=\s*true/);
  assert.ok(
    src.indexOf('complete: false') < src.indexOf('manifest.complete = true'),
    'the manifest must start incomplete and be completed last'
  );
});

test('the prep proves it can record before it creates anything', () => {
  /*
   * The 2026-08-25 §10 run: the prep aborted correctly on a 400, then died on
   * EACCES from the manifest write in the abort path, and the last line the
   * operator saw described neither failure. Check the cheap precondition first.
   */
  const src = code('reseed-prep.js');
  const writable = src.indexOf('checkOutDirWritable');
  const secrets = src.indexOf('loadSecrets');
  assert.ok(writable !== -1 && secrets !== -1);
  assert.ok(writable < secrets, 'the writability check must precede the first Open Dental call');
});

test('the prep paces itself at the D-8 floor', () => {
  /*
   * Open Dental publishes 1 req/s and the credential is SHARED with the live
   * phone path and TC. These scripts do not go through `services/rcm/odPacer.js`
   * — they are operational, not module code — so they hold the floor by hand.
   */
  assert.ok(T.PACE_MS >= 1300, 'the pace must be at least 1.3s');
  assert.match(code('reseed-prep.js'), /T\.PACE_MS/);
});

test('the generator touches no Open Dental at all', () => {
  const src = code('reseed-835.js');
  for (const forbidden of ['odOffices', 'apiWriteRaw', 'apiGetRaw', 'loadSecrets', 'axios']) {
    assert.ok(!src.includes(forbidden), `the generator must not name ${forbidden}`);
  }
});

test('every script refuses an office that is not roland', () => {
  assert.equal(T.resolveOffice('roland'), 'roland');
  assert.equal(T.resolveOffice(undefined), 'roland');
  for (const bad of ['valley', 'Valley', 'rolnad', '']) {
    if (bad === '') continue; // empty falls back to the default, like PROBE_OFFICE unset
    assert.throws(() => T.resolveOffice(bad), /roland only/i, `${bad} must be refused`);
  }
  // Riley in particular, and with its reason.
  assert.throws(() => T.resolveOffice('valley'), /never had a walk run in it/);
});

test('the manifest path carries the office, so two practices cannot overwrite each other', () => {
  const roland = T.pathsFor('roland');
  const valley = T.pathsFor('valley');
  assert.notEqual(roland.manifestPath, valley.manifestPath);
  assert.match(roland.manifestPath.replace(/\\/g, '/'), /\/roland\//);
});

test('the deny-list date moves whenever the spent-id list grows', () => {
  /*
   * `RESEED_SPENT_IDS` is empty until the first run, and that is a MEASURED
   * answer rather than a placeholder. The paired date is what catches a manifest
   * written before a run that has since been unwound whose ids happen not to
   * collide — walk night 2's defect, which the id check alone does not catch.
   *
   * When the first run adds ids, this test is what says the date must move too.
   */
  const total =
    T.RESEED_SPENT_IDS.claims.length +
    T.RESEED_SPENT_IDS.procedures.length +
    T.RESEED_SPENT_IDS.claimProcs.length;
  assert.ok(Number.isFinite(Date.parse(T.RESEED_SPENT_RECORDED_AT)), 'the date must parse');
  if (total > 0) {
    assert.ok(
      Date.parse(T.RESEED_SPENT_RECORDED_AT) > Date.parse('2026-09-01T00:00:00.000Z'),
      'ids were added to RESEED_SPENT_IDS without moving RESEED_SPENT_RECORDED_AT — the staleness ' +
        'screen would then certify manifests it should refuse'
    );
  }
  // The three buckets exist whether or not they hold anything.
  for (const bucket of ['claims', 'procedures', 'claimProcs']) {
    assert.ok(Array.isArray(T.RESEED_SPENT_IDS[bucket]), `${bucket} must be an array`);
  }
});

test('the four remittances have distinct check numbers and control numbers', () => {
  /*
   * The office-scoped remittance key covers (trace, payer, payment date). R3 and
   * R4 share a payer and a date on purpose — that is realistic — so it is the
   * CHECK NUMBER that has to differ, or uploading the second would be deduped
   * against the first and the §15.1c fixture would never reach the screen.
   */
  const checks = T.REMITTANCES.map((r) => r.checkNumber);
  const ctls = T.REMITTANCES.map((r) => r.controlNumber);
  assert.equal(new Set(checks).size, checks.length, 'check numbers must differ');
  assert.equal(new Set(ctls).size, ctls.length, 'interchange control numbers must differ');
  assert.equal(T.REMITTANCES.length, 4);
});

test('tooth and surface codes carry a ToothNum; whole-mouth codes carry none', () => {
  /*
   * MEASURED on the first live run, 2026-09-01: `POST /procedurelogs` for D2391
   * returned 400 "A ToothNum is required for the procedure code's treatment
   * area". Open Dental validates a procedure against its code's TreatArea, and
   * three targets had already gone in before the fourth was refused.
   *
   * The pairs below are the treatment areas, not a preference — a surface code
   * needs both, a tooth code needs one, a whole-mouth code needs neither. And a
   * ToothNum on a whole-mouth code would be inventing a clinical fact about a
   * chart, so "just send one everywhere" is not the fix.
   */
  const NEEDS = {
    D0120: { tooth: false, surface: false }, // periodic exam        — mouth
    D1110: { tooth: false, surface: false }, // prophylaxis          — mouth
    D0274: { tooth: false, surface: false }, // four bitewings       — mouth
    D0330: { tooth: false, surface: false }, // panoramic            — mouth
    D0220: { tooth: true, surface: false }, //  periapical           — tooth
    D2740: { tooth: true, surface: false }, //  crown                — tooth
    D2391: { tooth: true, surface: true }, //   posterior composite  — surface
  };
  for (const t of T.TARGETS) {
    const need = NEEDS[t.procCode];
    assert.ok(need, `${t.procCode} has no recorded treatment area — add one before using it`);
    assert.equal(Boolean(t.toothNum), need.tooth, `${t.key} (${t.procCode}) ToothNum`);
    assert.equal(Boolean(t.surface), need.surface, `${t.key} (${t.procCode}) Surf`);
  }

  // And the prep must send them CONDITIONALLY, never as a default.
  const src = code('reseed-prep.js');
  assert.match(src, /if \(target\.toothNum\) procBody\.ToothNum/);
  assert.match(src, /if \(target\.surface\) procBody\.Surf/);
});

test('a PARTIAL manifest resumes; a COMPLETE one is still refused', () => {
  /*
   * The first live run left three live claims and `complete: false`. Refusing
   * outright at that point offers only bad moves — mint a second set on top of
   * the first, or move the manifest aside and orphan three claims nothing can
   * name any more. The manifest being the unwind's ONLY authority is exactly
   * what makes an orphan unremovable.
   */
  const src = code('reseed-prep.js');
  assert.match(src, /if \(existing\.complete\)/, 'a complete manifest must still refuse');
  assert.match(src, /resumed = existing/, 'a partial one must be resumed');
  assert.match(src, /done\.has\(target\.key\)/, 'already-created targets must be skipped by key');
  // The resume must NOT re-stamp createdAt — the staleness screen reads it.
  assert.match(src, /const manifest = resumed \|\|/, 'a resume must keep the original manifest object');
});

test('the ids Open Dental burned on the refused create are denied, in their OWN bucket', () => {
  /*
   * The 2026-09-01 prep reached R2-1 and Open Dental refused it — "A ToothNum is
   * required for the procedure code's treatment area." — AFTER it had already
   * consumed the ids. `ClaimNum 53860` and `ProcNum 406653` / `406654` are the
   * numbers it burned.
   *
   * A THIRD list, not a corner of either other one, because the three mean
   * different things and the difference decides what may be done with them:
   *
   *   pending  created, live, and the unwind must REACH them.
   *   spent    created, and since REMOVED — dated by RESEED_SPENT_RECORDED_AT.
   *   burned   NEVER CREATED. Nothing to reach, nothing to date, nobody to own
   *            them. No honest manifest names one, because the prep records only
   *            what it read back — so a file that does was not written by a prep
   *            run, and the right response to an untrustworthy list of things to
   *            DELETE is to delete none of them.
   */
  assert.deepEqual([...T.RESEED_BURNED_IDS.claims], [53860]);
  assert.deepEqual([...T.RESEED_BURNED_IDS.procedures], [406653, 406654]);
  assert.deepEqual([...T.RESEED_BURNED_IDS.claimProcs], []);

  // Disjoint from both other lists, in every bucket. An id in two of them would
  // be saying two contradictory things about the same row.
  for (const bucket of ['claims', 'procedures', 'claimProcs']) {
    for (const id of T.RESEED_BURNED_IDS[bucket]) {
      assert.ok(!T.RESEED_PENDING_AT_UNWIND[bucket].includes(id), `${id} cannot also be pending`);
      assert.ok(!T.RESEED_SPENT_IDS[bucket].includes(id), `${id} cannot also be spent`);
    }
  }

  /*
   * `reseedDenyIds()` is the DELETE guard and is a strict superset of
   * `denyIds()`, the staleness screen. The two questions are different: a burned
   * id was never created, so it can never make a manifest STALE — but a manifest
   * naming one is a file nothing in this repo wrote.
   */
  const deny = T.reseedDenyIds();
  for (const id of [53860, 406653, 406654]) {
    assert.ok(deny.includes(id), `${id} must be on the unwind's deny-list`);
  }
  for (const id of T.denyIds()) assert.ok(deny.includes(id), `${id} must survive the superset`);

  // And the LIVE ids stay off it, or the unwind would refuse the one manifest
  // that can remove them.
  for (const bucket of ['claims', 'procedures', 'claimProcs']) {
    for (const id of T.RESEED_PENDING_AT_UNWIND[bucket]) {
      assert.ok(!deny.includes(id), `${bucket} ${id} is live and must stay reachable`);
    }
  }
});

test('pending-at-unwind ids are recorded, and never also on the spent deny-list', () => {
  /*
   * The 2026-09-01 run's seven claims are LIVE on Roland's chart. They belong on
   * a deny-list eventually — the §10 convention is that an id is spent the moment
   * it EXISTS — but not until the unwind removes them, because
   * `screenManifestForSpentIds` REFUSES any manifest naming a listed id, and
   * their manifest is the only thing that can remove them.
   *
   * So the two lists must never overlap: an id in both would be simultaneously
   * "still on the chart" and "retired", and the screen would refuse the file the
   * unwind depends on.
   */
  const pending = T.RESEED_PENDING_AT_UNWIND;
  const spent = T.RESEED_SPENT_IDS;
  for (const bucket of ['claims', 'procedures', 'claimProcs']) {
    assert.ok(Array.isArray(pending[bucket]), `${bucket} must be an array`);
    const overlap = pending[bucket].filter((id) => spent[bucket].includes(id));
    assert.deepEqual(
      overlap,
      [],
      `${bucket}: an id cannot be both pending-at-unwind and spent — found ${overlap.join(', ')}`
    );
  }

  // One id per target, in every bucket. A short list is a lost row.
  assert.equal(pending.claims.length, T.TARGETS.length);
  assert.equal(pending.procedures.length, T.TARGETS.length);
  assert.equal(pending.claimProcs.length, T.TARGETS.length);

  // And nothing may be double-counted inside a bucket.
  for (const bucket of ['claims', 'procedures', 'claimProcs']) {
    assert.equal(new Set(pending[bucket]).size, pending[bucket].length, `${bucket} has a duplicate`);
  }

  /*
   * The deny-list SCREEN reads RESEED_SPENT_IDS only. Pending ids must stay
   * invisible to it, or the manifest naming them is refused — which is the whole
   * reason the two lists are separate.
   */
  const manifest = {
    createdAt: new Date().toISOString(),
    targets: pending.claims.map((claimNum) => ({ claimNum })),
  };
  assert.equal(
    T.screenManifestForSpentIds(manifest),
    null,
    'a manifest naming the live reseed claims must still be accepted'
  );
});
