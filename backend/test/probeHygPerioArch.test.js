'use strict';

/**
 * The perio arch-string probe (item 11) — everything that can be proven without
 * a database: the guards, the dry run, the cleanup rules, and the mapping
 * derivation that turns a read-back into "which string position is which site".
 *
 * NO PHI: 12827 / 12828 / 7115 are the designated fixtures; exam numbers are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = require.resolve('../scripts/probe-hyg-perio-arch.js');

test('requiring the probe loads no Open Dental config and sends nothing', () => {
  const odOffices = require.resolve('../config/odOffices.js');
  const secrets = require.resolve('../config/secrets.js');
  delete require.cache[odOffices];
  delete require.cache[secrets];
  require(SCRIPT);
  assert.equal(require.cache[odOffices], undefined, 'requiring the probe loaded odOffices');
  assert.equal(require.cache[secrets], undefined, 'requiring the probe loaded secrets');
});

const probe = require(SCRIPT);

const ENV = Object.freeze({ HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828', HYG_PROBE_PROVNUM: '7' });

function tmpManifest(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perio-probe-'));
  const file = path.join(dir, 'manifest.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

/**
 * A fake Open Dental that behaves the way the docs describe the arch strings:
 * digits are depths walked patient-right-to-left with a continuous sweep, and
 * b/s/p/c set flags on the depth before them. It records every call.
 */
function fakeOd({ patNum = 12828, refuseExam = false } = {}) {
  const state = { exams: [], measures: [], calls: [], nextExam: 5001, nextMeasure: 1 };
  const client = {
    async apiGetRaw(p, params) {
      state.calls.push(['GET', p, params]);
      if (p === '/perioexams') return { ok: true, status: 200, data: state.exams.slice() };
      if (p === '/periomeasures') return { ok: true, status: 200, data: state.measures.slice() };
      return { ok: false, status: 404, data: null, error: 'unscripted' };
    },
    async apiWriteRaw(method, p, body) {
      state.calls.push([method, p, body]);
      if (p !== '/perioexams') throw new Error('the probe must never post anything but /perioexams: ' + p);
      if (refuseExam) return { ok: false, status: 400, data: null, error: 'nope' };
      const exam = { PerioExamNum: state.nextExam++, PatNum: body.PatNum, ExamDate: body.ExamDate, ProvNum: body.ProvNum, Note: body.Note };
      state.exams.push(exam);
      // ONE Probing row per tooth per exam, shared by the facial and lingual
      // strings — Open Dental's one row per (tooth, SequenceType).
      const probing = new Map();
      for (const region of Object.keys(probe.REGIONS)) {
        if (typeof body[region] !== 'string') continue;
        const order = probe.candidateOrder(region, 'patient-right-to-left', 'sweep');
        let i = -1;
        for (const ch of body[region]) {
          if (/[0-9]/.test(ch) && i + 1 < order.length) {
            i += 1;
            const site = order[i];
            if (!probing.has(site.tooth)) {
              probing.set(site.tooth, {
                PerioMeasureNum: state.nextMeasure++, PerioExamNum: exam.PerioExamNum, SequenceType: 'Probing',
                IntTooth: site.tooth, ToothValue: -1, MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1,
              });
            }
            probing.get(site.tooth)[`${site.surface}value`] = Number(ch);
          }
        }
      }
      state.measures.push(...probing.values());
      return { ok: true, status: 201, data: exam };
    },
    client: {
      async delete(p) {
        state.calls.push(['DELETE', p]);
        const n = Number(p.split('/').pop());
        state.exams = state.exams.filter((e) => e.PerioExamNum !== n);
        state.measures = state.measures.filter((m) => m.PerioExamNum !== n);
        return { status: 200 };
      },
    },
  };
  void patNum;
  return { state, od: { client } };
}

function deps(od, record = []) {
  return {
    loadSecrets: async () => {
      record.push('loadSecrets');
    },
    getOd: (office) => {
      record.push('getOd:' + office);
      return od;
    },
    // One page; the fake never holds 100 rows.
    pagedList: async (odGet, p, params) => {
      const res = await odGet(p, params, {});
      return res.ok ? { rows: res.data, truncated: false, error: null, pages: 1 } : { rows: [], truncated: false, error: res.error, pages: 1 };
    },
  };
}

// ── guards ──────────────────────────────────────────────────────────────────

test('only the designated fixtures, per office — 11373 and a cross-office PatNum are refused', async () => {
  assert.equal(probe.isFixture('roland', 12828), true);
  assert.equal(probe.isFixture('valley', 7115), true);
  assert.equal(probe.isFixture('roland', 7115), false, '7115 in roland is a different, real person');
  assert.equal(probe.isFixture('roland', 11373), false);
  assert.equal(probe.isFixture('springfield', 12828), false);

  const record = [];
  const logs = [];
  const code = await probe.main({
    argv: [], env: { ...ENV, HYG_PROBE_PATNUM: '11373' }, deps: deps(fakeOd().od, record), log: (l) => logs.push(l),
    manifestPath: tmpManifest(),
  });
  assert.equal(code, 2);
  assert.deepEqual(record, [], 'no secrets loaded, no office resolved');
  assert.match(logs.join('\n'), /11373 is INVALID/);
});

test('OPENDENTAL_WRITE_DISABLED refuses before anything is loaded', async () => {
  const record = [];
  const code = await probe.main({
    argv: [], env: { ...ENV, OPENDENTAL_WRITE_DISABLED: 'true' }, deps: deps(fakeOd().od, record), log: () => {},
    manifestPath: tmpManifest(),
  });
  assert.equal(code, 2);
  assert.deepEqual(record, []);
});

test('a missing ProvNum is refused — Q7 cannot be answered without one', async () => {
  const record = [];
  const env = { ...ENV };
  delete env.HYG_PROBE_PROVNUM;
  assert.equal(await probe.main({ argv: [], env, deps: deps(fakeOd().od, record), log: () => {}, manifestPath: tmpManifest() }), 2);
  assert.deepEqual(record, []);
});

// ── --dry ───────────────────────────────────────────────────────────────────

test('--dry prints every payload and contacts Open Dental not at all', async () => {
  const fake = fakeOd();
  const record = [];
  const logs = [];
  const manifestPath = tmpManifest();
  const code = await probe.main({ argv: ['--dry'], env: ENV, deps: deps(fake.od, record), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0);
  assert.deepEqual(record, [], 'no secrets, no office handle');
  assert.deepEqual(fake.state.calls, [], 'not one request');
  assert.equal(fs.existsSync(manifestPath), false, 'nothing recorded, because nothing was created');
  const out = logs.join('\n');
  for (const e of probe.experiments({ patNum: 12828, provNum: 7, examDate: '2000-01-01' })) {
    assert.ok(out.includes(`── ${e.id}`), e.id);
    assert.ok(out.includes(JSON.stringify(e.body, null, 2)), `${e.id} payload printed whole`);
  }
});

// ── a run, against a fake that behaves like the docs ─────────────────────────

test('a run creates only its own exams, records each before reading, and derives the documented mapping', async () => {
  const fake = fakeOd();
  const record = [];
  const logs = [];
  const manifestPath = tmpManifest();
  const code = await probe.main({ argv: ['--only', 'mapping,flags'], env: ENV, deps: deps(fake.od, record), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(record.slice(0, 2), ['loadSecrets', 'getOd:roland'], 'secrets load before the office is resolved');

  const writes = fake.state.calls.filter((c) => c[0] !== 'GET');
  assert.deepEqual(writes.map((c) => [c[0], c[1]]), [['POST', '/perioexams'], ['POST', '/perioexams']], 'no measurement row posted, ever');
  assert.equal(writes[0][2].ExamDate, '2000-01-01');
  assert.equal(writes[0][2].ProvNum, 7);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.exams.map((e) => [e.examNum, e.experiment, e.patNum]), [[5001, 'mapping', 12828], [5002, 'flags', 12828]]);

  const out = logs.join('\n');
  assert.match(out, /CREATED PerioExamNum 5001/);
  assert.match(out, /--cleanup 5001,5002/);
  assert.match(out, /UpperFacial: UNIQUE — best fit "patient-right-to-left, sweep" \(48\/48/);
  assert.match(out, /LowerFacial: UNIQUE — best fit "patient-right-to-left, sweep"/);
  assert.match(out, /Q7 exam header: ExamDate=2000-01-01 \(sent 2000-01-01\), ProvNum=7/);
});

test('a refused exam POST writes nothing to the manifest and says a refusal wrote nothing', async () => {
  const fake = fakeOd({ refuseExam: true });
  const logs = [];
  const manifestPath = tmpManifest();
  const code = await probe.main({ argv: ['--only', 'malformed'], env: ENV, deps: deps(fake.od), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.match(logs.join('\n'), /a refusal wrote nothing/);
});

// ── --cleanup ────────────────────────────────────────────────────────────────

test('--cleanup deletes EXACTLY the exam named, confirms it gone, and drops it from the manifest', async () => {
  const fake = fakeOd();
  fake.state.exams.push({ PerioExamNum: 5001, PatNum: 12828 }, { PerioExamNum: 5002, PatNum: 12828 });
  const manifestPath = tmpManifest({ exams: [
    { office: 'roland', patNum: 12828, examNum: 5001, experiment: 'mapping' },
    { office: 'roland', patNum: 12828, examNum: 5002, experiment: 'flags' },
  ] });
  const logs = [];
  const code = await probe.main({ argv: ['--cleanup', '5001'], env: { HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828' }, deps: deps(fake.od), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(fake.state.calls.filter((c) => c[0] === 'DELETE'), [['DELETE', '/perioexams/5001']]);
  assert.deepEqual(fake.state.exams.map((e) => e.PerioExamNum), [5002], 'the other exam is untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).exams.map((e) => e.examNum), [5002]);
  assert.match(logs.join('\n'), /confirmed gone/);
});

test('--cleanup refuses an exam this script did not create, and deletes nothing', async () => {
  const fake = fakeOd();
  fake.state.exams.push({ PerioExamNum: 4242, PatNum: 12828 });
  const logs = [];
  const code = await probe.main({
    argv: ['--cleanup', '4242'], env: { HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828' },
    deps: deps(fake.od), log: (l) => logs.push(l), manifestPath: tmpManifest({ exams: [] }),
  });
  assert.equal(code, 2);
  assert.deepEqual(fake.state.calls, [], 'refused before contacting Open Dental');
  assert.match(logs.join('\n'), /not created by this script/);
});

test('--force-cleanup still refuses an exam that is not the fixture\'s own', async () => {
  const fake = fakeOd();
  fake.state.exams.push({ PerioExamNum: 4242, PatNum: 99999 });
  const logs = [];
  const code = await probe.main({
    argv: ['--cleanup', '4242', '--force-cleanup'], env: { HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828' },
    deps: deps(fake.od), log: (l) => logs.push(l), manifestPath: tmpManifest({ exams: [] }),
  });
  assert.equal(code, 2);
  assert.equal(fake.state.calls.filter((c) => c[0] === 'DELETE').length, 0);
  assert.match(logs.join('\n'), /not one of roland 12828's exams/);
});

test('--cleanup honours OPENDENTAL_WRITE_DISABLED and --dry', async () => {
  const fake = fakeOd();
  fake.state.exams.push({ PerioExamNum: 5001, PatNum: 12828 });
  const manifestPath = tmpManifest({ exams: [{ office: 'roland', patNum: 12828, examNum: 5001 }] });
  const env = { HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828' };
  assert.equal(await probe.main({ argv: ['--cleanup', '5001'], env: { ...env, OPENDENTAL_WRITE_DISABLED: 'true' }, deps: deps(fake.od), log: () => {}, manifestPath }), 2);
  assert.equal(await probe.main({ argv: ['--cleanup', '5001', '--dry'], env, deps: deps(fake.od), log: () => {}, manifestPath }), 0);
  assert.deepEqual(fake.state.calls, []);
});

// ── the mapping derivation ───────────────────────────────────────────────────

/** Read-back rows a region would produce if Open Dental walked it by `candidate`. */
function fabricate(region, written, toothOrder, siteRule, { dropFrom = Infinity } = {}) {
  const order = probe.candidateOrder(region, toothOrder, siteRule);
  const byTooth = new Map();
  written.split('').forEach((ch, i) => {
    if (i >= order.length || i >= dropFrom) return;
    const site = order[i];
    if (!byTooth.has(site.tooth)) {
      byTooth.set(site.tooth, { PerioMeasureNum: i + 1, SequenceType: 'Probing', IntTooth: site.tooth, ToothValue: -1, MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1 });
    }
    byTooth.get(site.tooth)[`${site.surface}value`] = Number(ch);
  });
  return [...byTooth.values()];
}

test('the mapping strings single out EACH of the eight candidate walks, in every region', () => {
  for (const region of Object.keys(probe.REGIONS)) {
    const written = probe.MAPPING_STRINGS[region];
    assert.equal(written.length, 48);
    for (const toothOrder of probe.TOOTH_ORDERS) {
      for (const siteRule of probe.SITE_RULES) {
        const result = probe.deriveMapping({ region, written, rows: fabricate(region, written, toothOrder, siteRule) });
        assert.equal(result.verdict, 'unique', `${region} ${toothOrder} ${siteRule}: ${result.fitting.join(' | ')}`);
        assert.equal(result.best, `${toothOrder}, ${siteRule}`);
      }
    }
  }
});

test('the derived table names the tooth and site of every position', () => {
  const written = probe.MAPPING_STRINGS.LowerFacial;
  const result = probe.deriveMapping({ region: 'LowerFacial', written, rows: fabricate('LowerFacial', written, 'patient-right-to-left', 'sweep') });
  // Patient right on the lower arch is #32, distal first; #25 → #24 crosses the midline mesial-first.
  assert.deepEqual(result.table.slice(0, 3).map((r) => [r.tooth, r.surface]), [[32, 'DB'], [32, 'B'], [32, 'MB']]);
  assert.deepEqual(result.table.slice(21, 27).map((r) => [r.tooth, r.surface]), [[25, 'DB'], [25, 'B'], [25, 'MB'], [24, 'MB'], [24, 'B'], [24, 'DB']]);
  assert.ok(result.table.every((r) => r.readBack === r.written));
  const lines = probe.formatMapping(result);
  assert.match(lines[0], /^LowerFacial: UNIQUE/);
  assert.equal(lines.length, 2 + 48);
});

test('a uniform string is AMBIGUOUS, not a mapping — it cannot tell the walks apart', () => {
  const written = '3'.repeat(48);
  const result = probe.deriveMapping({ region: 'UpperFacial', written, rows: fabricate('UpperFacial', written, 'patient-right-to-left', 'sweep') });
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.fitting.length, 8);
});

test('a half-landed arch fits no walk, and the table shows where it stopped', () => {
  const written = probe.MAPPING_STRINGS.UpperLingual;
  const rows = fabricate('UpperLingual', written, 'patient-right-to-left', 'sweep', { dropFrom: 20 });
  const result = probe.deriveMapping({ region: 'UpperLingual', written, rows });
  assert.equal(result.verdict, 'none');
  assert.equal(result.best, 'patient-right-to-left, sweep');
  assert.equal(result.table[19].readBack, result.table[19].written);
  assert.equal(result.table[20].readBack, null);
});

test('an over-long string reports the characters past the region', () => {
  const written = probe.MAPPING_STRINGS.UpperFacial + '999999';
  const result = probe.deriveMapping({ region: 'UpperFacial', written, rows: fabricate('UpperFacial', written, 'patient-right-to-left', 'sweep') });
  assert.equal(result.overflow, 6);
  assert.equal(result.verdict, 'unique');
});

test('argument parsing refuses what it does not understand', () => {
  assert.deepEqual(probe.parseArgs(['--cleanup', '5001,5002']).cleanup, [5001, 5002]);
  assert.match(probe.parseArgs(['--cleanup', 'abc']).error, /PerioExamNums/);
  assert.match(probe.parseArgs(['--cleanup']).error, /needs a value/);
  assert.match(probe.parseArgs(['--yes']).error, /unknown argument/);
  assert.deepEqual(probe.parseArgs(['--only', 'mapping, deep']).only, ['mapping', 'deep']);
});
