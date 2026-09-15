'use strict';

/**
 * THE PERIO SEND (H4 item 12) — through the real /api/hyg stack, against a fake
 * Open Dental that behaves the way the arch-string probe MEASURED the real one.
 *
 * THE FAKE PARSES STRINGS WITH THE PROBE'S TABLE, NOT THE CODE'S. It reads
 * `new-dashboard/tests/fixtures/perio-arch-probe-staging.json` — the read-back of
 * the staging run — so a send that encoded a string with a wrong table would land
 * readings on the wrong teeth HERE, and the read-back would catch it. Its rules
 * are the findings: every digit takes the next site, a flag letter rides the
 * digit before it, anything else is ignored, a body whose string does not start
 * with a digit is refused and creates nothing, one row per (tooth, SequenceType).
 *
 * The acceptance, as tests:
 *   3. A full 0–9 chart sends ONE POST (write count asserted).
 *   4. An arch with a reading of 10+ takes the per-row path (asserted).
 *   5. A gap mid-arch takes the per-row path; no site is ever written as 0.
 *   6. The read-back compares every site; a mismatch blocks Written and is named.
 *   7. The delete-the-exam undo exists, is guarded, and is tested.
 * Plus: a refused exam creates nothing; a write that landed without answering is
 * adopted, never re-posted; two tabs cannot both step; a confirm that died is
 * put back.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');
const PROBE = require('../../../new-dashboard/tests/fixtures/perio-arch-probe-staging.json');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';
const FIELDS = ['UpperFacial', 'UpperLingual', 'LowerLingual', 'LowerFacial'];
const VALUE_KEY = { MB: 'MBvalue', B: 'Bvalue', DB: 'DBvalue', ML: 'MLvalue', L: 'Lvalue', DL: 'DLvalue' };
const FLAG_BIT = { b: 1, s: 2, p: 4, c: 8 };

/**
 * A fake Open Dental that keeps what is written to it, parses arch strings the
 * way the probe found the real one does, and can be told to misbehave.
 *
 * @param {{ onExam?: Function, onMeasure?: Function, corrupt?: Function }} [opts]
 *   A hook returning an envelope REPLACES the answer; `landed: true` on it still
 *   stores the write — a write that landed and did not answer.
 */
function perioOd({ onExam = null, onMeasure = null, corrupt = null, afterMeasure = null } = {}) {
  const client = new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00', ProvHyg: 7, ProvNum: 1 }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Perio Maint' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
  });
  const state = { exams: [], measures: [], posts: [], deletes: [], nextExam: 7001, nextMeasure: 90001 };

  const publish = () => {
    client.routes['/perioexams'] = state.exams.slice();
    for (const key of Object.keys(client.routes)) {
      if (key.startsWith('/periomeasures')) delete client.routes[key];
    }
    client.routes['/periomeasures'] = state.measures.slice(0, 100);
    for (let offset = 100; offset <= state.measures.length; offset += 100) {
      client.routes['/periomeasures?Offset=' + offset] = state.measures.slice(offset, offset + 100);
    }
  };

  /** One row per (exam, tooth, SequenceType), -1 everywhere until something lands. */
  const rowFor = (examNum, tooth, type) => {
    let row = state.measures.find((m) => m.PerioExamNum === examNum && m.IntTooth === tooth && m.SequenceType === type);
    if (!row) {
      row = {
        PerioMeasureNum: state.nextMeasure++, PerioExamNum: examNum, SequenceType: type, IntTooth: tooth,
        ToothValue: -1, MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1,
      };
      state.measures.push(row);
    }
    return row;
  };

  client.writeRoutes = {
    '/perioexams': (body) => {
      state.posts.push({ path: '/perioexams', body });
      const hooked = onExam ? onExam(body, state) : null;
      if (hooked && !hooked.landed) return hooked;
      // Finding 6: validation happens before creation.
      for (const f of FIELDS) {
        if (f in body && !/^[0-9]/.test(String(body[f]))) {
          return { ok: false, status: 400, data: null, error: `${f} must start with a number from 0-9.` };
        }
      }
      const exam = {
        PerioExamNum: state.nextExam++, PatNum: body.PatNum, ExamDate: body.ExamDate,
        ProvNum: body.ProvNum, Note: body.Note,
      };
      state.exams.push(exam);
      for (const f of FIELDS) {
        if (!(f in body)) continue;
        const table = PROBE.regions[f];
        let pos = -1;
        for (const ch of String(body[f])) {
          if (/[0-9]/.test(ch)) {
            pos += 1; // Findings 4 and 5: every digit takes the NEXT site.
            if (pos >= table.length) continue;
            rowFor(exam.PerioExamNum, table[pos].tooth, 'Probing')[VALUE_KEY[table[pos].surface]] = Number(ch);
          } else if (FLAG_BIT[ch] && pos >= 0 && pos < table.length) {
            // Finding 3: a flag rides the digit before it, and flags stack.
            const row = rowFor(exam.PerioExamNum, table[pos].tooth, 'BleedSupPlaqCalc');
            const key = VALUE_KEY[table[pos].surface];
            row[key] = Math.max(0, row[key]) | FLAG_BIT[ch];
          }
        }
      }
      if (corrupt) corrupt(state, exam);
      publish();
      return hooked || { ok: true, status: 201, data: exam };
    },
    '/periomeasures': (body) => {
      state.posts.push({ path: '/periomeasures', body });
      const hooked = onMeasure ? onMeasure(body, state) : null;
      if (hooked && !hooked.landed) return hooked;
      const row = { PerioMeasureNum: state.nextMeasure++, ...body };
      state.measures.push(row);
      if (afterMeasure) afterMeasure(row);
      publish();
      return hooked || { ok: true, status: 201, data: row };
    },
  };
  client.deleteRoutes = {};
  for (let n = 7001; n <= 7010; n += 1) {
    client.deleteRoutes['/perioexams/' + n] = () => {
      state.deletes.push(n);
      state.exams = state.exams.filter((e) => e.PerioExamNum !== n);
      state.measures = state.measures.filter((m) => m.PerioExamNum !== n);
      publish();
      return { ok: true, status: 200, data: null };
    };
  }
  publish();
  return { client, state };
}

function examPosts(state) {
  return state.posts.filter((p) => p.path === '/perioexams');
}
function measurePosts(state) {
  return state.posts.filter((p) => p.path === '/periomeasures');
}

/** Every site of the four sweeps at depth(i); bleeding on every seventh. */
function fullMouth(depth = (i) => (i * 7) % 10) {
  let chart = contract.emptyPerioChart();
  for (const f of contract.PERIO_ARCH_STRING_FIELDS) {
    contract.PERIO_ARCH_STRING_SITES[f].forEach((c, i) => {
      chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: depth(i), bleeding: i % 7 === 3 });
    });
  }
  return chart;
}

async function stage(app, chart) {
  assert.equal((await api(app.baseUrl, 'POST', BASE + '/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } })).status, 200);
  const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

function confirmOf(write, over = {}) {
  return { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7, ...over };
}

async function send(app, write, over) {
  return api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write, over) });
}

/** Step until the send is finished, stopped or paused. */
async function drain(app, res, limit = 20) {
  let current = res;
  for (let i = 0; i < limit; i += 1) {
    if (current.status !== 200) return current;
    const s = current.body.send;
    if (!s || !['posting', 'filling'].includes(s.state) || current.body.paused) return current;
    current = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
  }
  return current;
}

function stagedState(app) {
  return app.db.hyg_staged_write.find((w) => w.kind === 'perio').state;
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return { lines, restore: () => (console.log = orig) };
}

test('ACCEPTANCE 3: a full 0–9 chart is ONE write — one POST, four strings, no rows — then Written', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  const logs = captureLogs();
  try {
    const chart = fullMouth();
    const write = await stage(app, chart);
    const done = await drain(app, await send(app, write));
    logs.restore();

    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(contract.HygPerioSendResponseSchema.safeParse(done.body).success, 'the response is the contract');
    assert.equal(done.body.send.state, 'written');
    assert.equal(done.body.stagedWrite.state, 'Written');
    assert.match(done.body.stagedWrite.writtenRef, /^Perio exam 7001: 192 sites read back and match$/);

    // THE WRITE COUNT. Exactly one transport call, and it was the exam.
    assert.equal(app.od.writes.length, 1, 'one write verb, total');
    assert.equal(examPosts(od.state).length, 1);
    assert.equal(measurePosts(od.state).length, 0);
    const body = examPosts(od.state)[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['ExamDate', 'LowerFacial', 'LowerLingual', 'Note', 'PatNum', 'ProvNum', 'UpperFacial', 'UpperLingual']);
    assert.equal(body.ProvNum, 7, 'the hygienist, not the patient primary');
    assert.equal(body.Note, 'Charted in CareIN.');
    assert.equal(body.UpperFacial, contract.planPerioSend(chart).strings.UpperFacial);

    // What landed IS the chart, read with the PROBE's table.
    const landed = contract.normalizePerioChart(require('../../services/hyg/odPerio').chartFromMeasures(od.state.measures).chart);
    assert.deepEqual(contract.comparePerioReadback(chart, landed), []);

    const line = logs.lines.find((l) => l.startsWith('[hygperio] office=roland exam=7001'));
    assert.match(line, /^\[hygperio\] office=roland exam=7001 arches=4 rows=0 deep=0 mismatches=0 ms=\d+$/);
  } finally {
    logs.restore();
    await app.close();
  }
});

test('ACCEPTANCE 4: an arch with a 12 goes row by row — with its jaw partner — and the other jaw stays a string', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = contract.withPerioSite(fullMouth(() => 3), 3, 'DB', { depth: 12 });
    const write = await stage(app, chart);
    const first = await send(app, write);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(
      first.body.send.arches.map((a) => [a.field, a.path, a.reason]),
      [
        ['UpperFacial', 'per_row', 'deep'],
        ['UpperLingual', 'per_row', 'partner'],
        ['LowerLingual', 'string', null],
        ['LowerFacial', 'string', null],
      ]
    );
    const done = await drain(app, first);
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));

    // No upper string was sent at all — a 12 can never be in one.
    const exam = examPosts(od.state)[0].body;
    assert.equal('UpperFacial' in exam, false);
    assert.equal('UpperLingual' in exam, false);
    assert.ok(exam.LowerLingual && exam.LowerFacial);

    // One Probing row per upper tooth, #3 DB carrying the 12; bleeding rows where flagged.
    const probing = measurePosts(od.state).filter((p) => p.body.SequenceType === 'Probing');
    assert.deepEqual(probing.map((p) => p.body.IntTooth), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.equal(probing[2].body.DBvalue, 12);
    assert.ok(measurePosts(od.state).every((p) => p.body.IntTooth <= 16), 'nothing row-by-row for the string jaw');
    assert.equal(done.body.send.deepSites, 1);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5: a gap mid-arch goes row by row, and no site that was not charted is written as 0', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    let chart = fullMouth((i) => (i % 4) + 1);
    chart = contract.withPerioSite(chart, 20, 'L', { depth: null, bleeding: false });
    chart = contract.withPerioSite(chart, 22, 'MB', { depth: null, plaque: true });
    const write = await stage(app, chart);
    const done = await drain(app, await send(app, write));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
    assert.deepEqual(done.body.send.arches.map((a) => a.path), ['string', 'string', 'per_row', 'per_row']);

    const posts = measurePosts(od.state);
    assert.ok(posts.length > 0);
    for (const p of posts) {
      const tooth = contract.perioTooth(chart, p.body.IntTooth);
      for (const [surface, key] of Object.entries(VALUE_KEY)) {
        const site = tooth.sites[surface];
        if (site.depth === null && p.body.SequenceType === 'Probing') {
          assert.equal(p.body[key], -1, `#${p.body.IntTooth} ${surface} was not charted and must not be written`);
        }
        if (site.depth === null && !contract.PERIO_FLAGS.some((f) => site[f]) && p.body.SequenceType === 'BleedSupPlaqCalc') {
          assert.equal(p.body[key], -1, `#${p.body.IntTooth} ${surface} flags`);
        }
      }
    }
    const p20 = posts.find((p) => p.body.IntTooth === 20 && p.body.SequenceType === 'Probing');
    assert.equal(p20.body.Lvalue, -1);
    const b22 = posts.find((p) => p.body.IntTooth === 22 && p.body.SequenceType === 'BleedSupPlaqCalc');
    assert.equal(b22.body.MBvalue, 4, 'plaque on a site with no depth still lands, as a flag row');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 6: a read-back that differs by ONE site blocks Written, names the site, and offers the undo', async () => {
  const od = perioOd({
    corrupt: (state, exam) => {
      const row = state.measures.find((m) => m.PerioExamNum === exam.PerioExamNum && m.IntTooth === 14 && m.SequenceType === 'Probing');
      row.Bvalue = row.Bvalue === 9 ? 8 : row.Bvalue + 1;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    const write = await stage(app, chart);
    const done = await drain(app, await send(app, write));
    const s = done.body.send;
    assert.equal(s.state, 'incomplete');
    assert.equal(done.body.stagedWrite.state, 'Failed');
    assert.equal(done.body.stagedWrite.writtenRef, null, 'NOT written');
    assert.equal(s.mismatches.length, 1);
    assert.deepEqual(
      { tooth: s.mismatches[0].tooth, surface: s.mismatches[0].surface, kind: s.mismatches[0].kind },
      { tooth: 14, surface: 'B', kind: 'depth' }
    );
    assert.match(s.errorMessage, /Exam 7001 is in Open Dental but does not match this chart at 1 place: #14 B/);
    assert.match(s.errorMessage, /understates disease/);
    assert.equal(s.canDelete, true);
    assert.match(done.body.stagedWrite.errorMessage, /#14 B/);

    // It does not quietly try again: another step writes nothing more.
    const writesBefore = app.od.writes.length;
    const again = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
    assert.equal(again.body.send.state, 'incomplete');
    assert.equal(app.od.writes.length, writesBefore);

    // And the chart cannot be put back on the list, or re-sent, while the exam stands.
    const retry = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.code, 'PERIO_EXAM_EXISTS');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: the undo deletes EXACTLY the exam this send created, guarded, read back, audited', async () => {
  const od = perioOd({
    // #30 goes row by row (its DL is a gap), and its row lands holding a 0 there.
    afterMeasure: (row) => {
      if (row.IntTooth === 30 && row.SequenceType === 'Probing') row.DLvalue = 0;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    // A chart that leaves #30 DL uncharted, and Open Dental reads a 0 there.
    const chart = contract.withPerioSite(fullMouth(() => 2), 30, 'DL', { depth: null });
    const write = await stage(app, chart);
    const stopped = await drain(app, await send(app, write));
    assert.equal(stopped.body.send.state, 'incomplete', JSON.stringify(stopped.body.send));
    assert.equal(stopped.body.send.examNum, 7001);

    // GUARD: a different exam number is refused, and nothing is deleted.
    const wrong = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7002 } });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'PERIO_EXAM_NOT_DELETABLE');
    assert.equal(od.state.deletes.length, 0);
    // GUARD: a body without the number is a 400.
    const bare = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: {} });
    assert.equal(bare.status, 400);

    // GUARD: not while a step holds the send.
    const row = app.db.hyg_perio_send[0];
    Object.assign(row, { step_token: 'another-tab', step_claimed_at: new Date() });
    const busy = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'PERIO_SEND_BUSY');
    Object.assign(row, { step_token: null, step_claimed_at: null });
    assert.equal(od.state.deletes.length, 0);

    const deleted = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(od.state.deletes, [7001], 'one DELETE, of that exam');
    // Recorded by the harness as [verb name, method, path, …]; matched on the
    // method so this file never names a transport verb (hygNoOdWrites scans it).
    assert.deepEqual(
      app.od.writes.filter((w) => w[1] === 'DELETE').map((w) => w[2]),
      ['/perioexams/7001']
    );
    assert.equal(od.state.exams.length, 0, 'gone from Open Dental, with its rows');
    assert.equal(od.state.measures.length, 0);
    assert.equal(deleted.body.send.state, 'deleted');
    assert.equal(deleted.body.send.deletedBy, 'hygienist@carein.ai');
    assert.equal(deleted.body.send.canDelete, false);
    assert.equal(deleted.body.stagedWrite.state, 'Staged', 'the chart is back on the list, same preview');
    assert.equal(deleted.body.stagedWrite.previewFingerprint, write.previewFingerprint);

    const audited = app.db.audit.filter((a) => a.resource_type === 'hyg_perio_send');
    assert.ok(audited.some((a) => a.action === 'DELETE' && a.result === 'SUCCESS'), 'the delete is audited');
    assert.ok(audited.some((a) => a.action === 'CREATE'), 'and so was the exam it undid');

    // GUARD: once deleted, never again.
    const twice = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } });
    assert.equal(twice.status, 409);
    assert.equal(od.state.deletes.length, 1);
  } finally {
    await app.close();
  }
});

test('the undo refuses a WRITTEN chart — a finished exam is corrected in Open Dental, not deleted from here', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    const done = await drain(app, await send(app, write));
    assert.equal(done.body.send.state, 'written');
    const res = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /corrected in Open Dental/);
    assert.equal(od.state.deletes.length, 0);
    assert.equal(od.state.exams.length, 1);
  } finally {
    await app.close();
  }
});

test('a refused exam creates nothing: the chart says so, there is nothing to undo, and it can be sent again', async () => {
  let refuse = true;
  const od = perioOd({
    onExam: () =>
      refuse ? { ok: false, status: 400, data: null, error: 'ProvNum is not a valid provider.' } : null,
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    const res = await send(app, write);
    assert.equal(res.status, 200);
    assert.equal(res.body.send.state, 'refused');
    assert.equal(res.body.send.examNum, null);
    assert.equal(res.body.send.canDelete, false);
    assert.match(res.body.send.errorMessage, /ProvNum is not a valid provider\. Nothing was created in Open Dental/);
    assert.equal(stagedState(app), 'Failed');
    assert.equal(od.state.exams.length, 0);

    const retry = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(stagedState(app), 'Staged');

    refuse = false;
    const done = await drain(app, await send(app, write));
    assert.equal(done.body.send.state, 'written');
    assert.equal(od.state.exams.length, 1);
  } finally {
    await app.close();
  }
});

test('an exam that LANDED without answering is found by reading and adopted — never posted twice', async () => {
  let n = 0;
  const od = perioOd({
    onExam: () => (++n === 1 ? { ok: false, status: 503, data: null, error: 'upstream timeout', landed: true } : null),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    const first = await send(app, write);
    assert.equal(first.body.send.state, 'posting');
    assert.match(first.body.paused, /did not answer for the exam/);
    assert.equal(od.state.exams.length, 1, 'it landed');

    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
    assert.equal(examPosts(od.state).length, 1, 'ONE exam POST, ever');
    assert.equal(od.state.exams.length, 1);
    assert.equal(done.body.send.examNum, 7001);
  } finally {
    await app.close();
  }
});

test('a row that LANDED without answering is found by reading on the next step — every row posted once', async () => {
  let n = 0;
  const od = perioOd({
    onMeasure: () => (++n === 1 ? { ok: false, status: 0, data: null, error: 'socket hang up', landed: true } : null),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = contract.withPerioSite(fullMouth(() => 4), 9, 'ML', { depth: 11 });
    const write = await stage(app, chart);
    const first = await send(app, write);
    assert.match(first.body.paused, /did not answer for #1 Probing/);

    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
    const probing = measurePosts(od.state).filter((p) => p.body.SequenceType === 'Probing');
    assert.equal(probing.length, 16, 'sixteen upper teeth, sixteen POSTs, none twice');
    assert.equal(new Set(probing.map((p) => p.body.IntTooth)).size, 16);
  } finally {
    await app.close();
  }
});

test('two tabs cannot both step: a held lease writes nothing, a lapsed one is taken over', async () => {
  let answer = false;
  const od = perioOd({ onExam: () => (answer ? null : { ok: false, status: 503, data: null, error: 'down' }) });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    const first = await send(app, write);
    assert.equal(first.body.send.state, 'posting');
    assert.equal(od.state.exams.length, 0, 'that one did not land');

    const row = app.db.hyg_perio_send[0];
    Object.assign(row, { step_token: 'another-tab', step_claimed_at: new Date() });
    answer = true;
    const writes = app.od.writes.length;
    const blocked = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
    assert.match(blocked.body.paused, /Another tab is writing this chart/);
    assert.equal(app.od.writes.length, writes, 'nothing written while another step holds the send');

    row.step_claimed_at = new Date(Date.now() - 10 * 60 * 1000);
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.send.state, 'written');
    assert.equal(od.state.exams.length, 1);
  } finally {
    await app.close();
  }
});

test('the fingerprint gate: a chart changed after it was read is refused, and nothing is written', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    const res = await send(app, write, { previewFingerprint: 'not-what-she-read' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    const provider = await send(app, write, { provNum: 1 });
    assert.equal(provider.body.code, 'PROVIDER_CHANGED');
    const date = await send(app, write, { examDate: '2026-09-09' });
    assert.equal(date.body.code, 'EXAM_DATE_CHANGED');
    assert.deepEqual(app.od.writes, []);
    assert.equal(stagedState(app), 'Staged');
    assert.equal(app.db.hyg_perio_send.length, 0);
  } finally {
    await app.close();
  }
});

test('a confirm that dies before its send is recorded puts the chart back, having written nothing', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    app.db.failOnce = (text) => /INSERT INTO hyg_perio_send/.test(text);
    const res = await send(app, write);
    assert.ok(res.status >= 500, 'the request fails: ' + res.status);
    assert.deepEqual(app.od.writes, []);
    assert.equal(stagedState(app), 'Staged');

    const done = await drain(app, await send(app, write));
    assert.equal(done.body.send.state, 'written');
  } finally {
    await app.close();
  }
});

test('GET /perio/send is our database only, and null before a send', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const before = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(before.status, 200);
    assert.equal(before.body.send, null);
    await stage(app, fullMouth());
    const calls = app.od.calls.length;
    const staged = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(staged.body.send, null);
    assert.equal(staged.body.stagedWrite.state, 'Staged');
    assert.equal(app.od.calls.length, calls, 'no Open Dental read');
  } finally {
    await app.close();
  }
});
