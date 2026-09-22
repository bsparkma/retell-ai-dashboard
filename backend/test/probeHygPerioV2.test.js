'use strict';

/**
 * The v2 perio probe (item 19) — everything provable without a database: the
 * guards, the dry run, that rows only ever go into exams the same run created,
 * that CAL is never sent, and the cleanup rules including the Q6 read-back.
 *
 * NO PHI: 12828 is the designated roland fixture; exam numbers are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = require.resolve('../scripts/probe-hyg-perio-v2.js');

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

const ENV = Object.freeze({ HYG_PROBE_OFFICE: 'roland', HYG_PROBE_PATNUM: '12828', HYG_PROBE_PROVNUM: '15' });

function tmpManifest(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perio-v2-probe-'));
  const file = path.join(dir, 'manifest.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

/** A fake Open Dental: exams, one row per POST, and an exam DELETE that takes its rows. */
function fakeOd({ refuseExam = false, refuseTypes = [] } = {}) {
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
      if (method !== 'POST') throw new Error('the probe must never ' + method);
      if (p === '/perioexams') {
        if (refuseExam) return { ok: false, status: 400, data: null, error: 'nope' };
        const exam = { PerioExamNum: state.nextExam++, PatNum: body.PatNum, ExamDate: body.ExamDate, ProvNum: body.ProvNum, Note: body.Note };
        state.exams.push(exam);
        return { ok: true, status: 201, data: exam };
      }
      if (p === '/periomeasures') {
        if (refuseTypes.includes(body.SequenceType)) return { ok: false, status: 400, data: null, error: 'SequenceType is invalid.' };
        const row = { PerioMeasureNum: state.nextMeasure++, ...body };
        state.measures.push(row);
        return { ok: true, status: 201, data: row };
      }
      throw new Error('unexpected POST ' + p);
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
  return { state, od: { client } };
}

function deps(od, record = []) {
  return {
    loadSecrets: async () => record.push('loadSecrets'),
    getOd: (office) => {
      record.push('getOd:' + office);
      return od;
    },
    pagedList: async (odGet, p, params) => {
      const res = await odGet(p, params, {});
      return res.ok ? { rows: res.data, truncated: false, error: null } : { rows: [], truncated: false, error: res.error };
    },
  };
}

// ── guards ──────────────────────────────────────────────────────────────────

test('roland 12828 ONLY — 12827, 7115, 11373 and every other office are refused before anything loads', async () => {
  assert.equal(probe.isFixture('roland', 12828), true);
  for (const [office, pat] of [['roland', 12827], ['valley', 7115], ['roland', 7115], ['roland', 11373], ['valley', 12828]]) {
    assert.equal(probe.isFixture(office, pat), false, `${office} ${pat}`);
    const record = [];
    const code = await probe.main({
      argv: [], env: { ...ENV, HYG_PROBE_OFFICE: office, HYG_PROBE_PATNUM: String(pat) },
      deps: deps(fakeOd().od, record), log: () => {}, manifestPath: tmpManifest(),
    });
    assert.equal(code, 2);
    assert.deepEqual(record, [], 'no secrets loaded, no office resolved');
  }
});

test('OPENDENTAL_WRITE_DISABLED refuses a run and a cleanup before anything is loaded', async () => {
  const record = [];
  const env = { ...ENV, OPENDENTAL_WRITE_DISABLED: 'true' };
  assert.equal(await probe.main({ argv: [], env, deps: deps(fakeOd().od, record), log: () => {}, manifestPath: tmpManifest() }), 2);
  const manifest = tmpManifest({ exams: [{ office: 'roland', patNum: 12828, examNum: 5001 }] });
  assert.equal(await probe.main({ argv: ['--cleanup', '5001'], env, deps: deps(fakeOd().od, record), log: () => {}, manifestPath: manifest }), 2);
  assert.deepEqual(record, []);
});

test('the dry run prints every payload and contacts nothing', async () => {
  const record = [];
  const logs = [];
  const code = await probe.main({ argv: ['--dry'], env: ENV, deps: deps(fakeOd().od, record), log: (l) => logs.push(l), manifestPath: tmpManifest() });
  assert.equal(code, 0);
  assert.deepEqual(record, []);
  const out = logs.join('\n');
  for (const type of ['GingMargin', 'Furcation', 'Mobility']) assert.match(out, new RegExp(type));
  assert.match(out, /nothing was sent/);
});

test('CAL is never in an experiment, and PUT is never used', async () => {
  for (const e of probe.experiments({ patNum: 12828, provNum: 15, examDate: '2000-01-01' })) {
    for (const row of e.rows) assert.notEqual(row.body.SequenceType, 'CAL', `${e.id}/${row.id}`);
  }
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /'PUT'/);
  assert.doesNotMatch(src, /\.put\s*\(/);
});

// ── the run ─────────────────────────────────────────────────────────────────

test('a run creates one exam per experiment, posts rows ONLY into those exams, records them, and emits the fixture', async () => {
  const { state, od } = fakeOd();
  // Somebody else's exam already on the patient: nothing may be posted into it.
  state.exams.push({ PerioExamNum: 4000, PatNum: 12828, ExamDate: '2025-01-01', ProvNum: 15 });
  const manifestPath = tmpManifest();
  const logs = [];
  const code = await probe.main({ argv: [], env: ENV, deps: deps(od), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0, logs.join('\n'));

  const examPosts = state.calls.filter((c) => c[1] === '/perioexams' && c[0] === 'POST');
  assert.equal(examPosts.length, 2);
  for (const post of examPosts) {
    assert.equal(post[2].ExamDate, '2000-01-01');
    assert.match(post[2].Note, /delete with --cleanup/);
  }
  const rowPosts = state.calls.filter((c) => c[1] === '/periomeasures' && c[0] === 'POST');
  const expected = probe.experiments({ patNum: 12828, provNum: 15, examDate: '2000-01-01' }).reduce((n, e) => n + e.rows.length, 0);
  assert.equal(rowPosts.length, expected);
  assert.deepEqual(Array.from(new Set(rowPosts.map((c) => c[2].PerioExamNum))).sort(), [5001, 5002], 'only the exams this run minted');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.exams.map((e) => e.examNum), [5001, 5002]);

  const fixtures = logs.filter((l) => l.startsWith('FIXTURE ')).map((l) => JSON.parse(l.slice(8)));
  assert.deepEqual(fixtures.map((f) => f.experiment), ['types', 'bad']);
  const types = fixtures[0];
  assert.equal(types.examNum, 5001);
  assert.ok(types.readBack.types.includes('GingMargin'));
  assert.equal(types.rows.find((r) => r.id === 'mob-3').landed.verdict, 'exact');
  // A duplicate (tooth, type) is reported as such, not as "exact".
  assert.equal(fixtures[1].rows.find((r) => r.id === 'gm-dup-b').landed.verdict, '2 rows');
  assert.match(logs.join('\n'), /--cleanup 5001,5002/);
});

test('a refused exam sends no rows at all', async () => {
  const { state, od } = fakeOd({ refuseExam: true });
  const code = await probe.main({ argv: [], env: ENV, deps: deps(od), log: () => {}, manifestPath: tmpManifest() });
  assert.equal(code, 1);
  assert.equal(state.calls.filter((c) => c[1] === '/periomeasures' && c[0] === 'POST').length, 0);
});

test('compareLanded: absent, exact, altered', () => {
  const sent = probe.measure('Mobility', 3, { ToothValue: 2 });
  assert.equal(probe.compareLanded(sent, []).verdict, 'absent');
  assert.equal(probe.compareLanded(sent, [{ ...sent, PerioMeasureNum: 1 }]).verdict, 'exact');
  const altered = probe.compareLanded(sent, [{ ...sent, ToothValue: 19 }]);
  assert.equal(altered.verdict, 'altered');
  assert.deepEqual(altered.diffs, ['ToothValue sent 2 holds 19']);
});

// ── cleanup ─────────────────────────────────────────────────────────────────

test('cleanup deletes only manifest exams that are 12828\'s, and proves their v2 rows went too (Q6)', async () => {
  const { state, od } = fakeOd();
  const manifestPath = tmpManifest();
  await probe.main({ argv: [], env: ENV, deps: deps(od), log: () => {}, manifestPath });
  assert.ok(state.measures.some((m) => m.SequenceType === 'GingMargin'));

  // Not in the manifest: refused, nothing deleted.
  const refusedLogs = [];
  assert.equal(await probe.main({ argv: ['--cleanup', '4000'], env: ENV, deps: deps(od), log: (l) => refusedLogs.push(l), manifestPath }), 2);
  assert.equal(state.calls.filter((c) => c[0] === 'DELETE').length, 0);

  const logs = [];
  const code = await probe.main({ argv: ['--cleanup', '5001,5002'], env: ENV, deps: deps(od), log: (l) => logs.push(l), manifestPath });
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(state.calls.filter((c) => c[0] === 'DELETE').map((c) => c[1]), ['/perioexams/5001', '/perioexams/5002']);
  const cleanups = logs.filter((l) => l.startsWith('CLEANUP ')).map((l) => JSON.parse(l.slice(8)));
  assert.deepEqual(cleanups.map((c) => [c.examNum, c.gone, c.rowsAfter]), [[5001, true, 0], [5002, true, 0]]);
  assert.ok(cleanups[0].typesBefore.includes('Furcation'), 'the rows were there before the delete');
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).exams, []);
});

test('even --force-cleanup cannot delete an exam that is not 12828\'s', async () => {
  const { state, od } = fakeOd();
  state.exams.push({ PerioExamNum: 9999, PatNum: 1, ExamDate: '2025-01-01', ProvNum: 1 });
  const code = await probe.main({ argv: ['--cleanup', '9999', '--force-cleanup'], env: ENV, deps: deps(od), log: () => {}, manifestPath: tmpManifest() });
  assert.equal(code, 2);
  assert.equal(state.calls.filter((c) => c[0] === 'DELETE').length, 0);
});
