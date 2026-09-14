'use strict';

/**
 * The perio writer (H4 slice 11) — what it will send, and what it refuses to.
 *
 *   - OPENDENTAL_WRITE_DISABLED is honoured, proven against the REAL transport
 *     (config/openDental.js), not a fake that happens to agree.
 *   - CAL, GingMargin, Mobility and Furcation are refused before the transport.
 *   - ProvNum is never left to Open Dental's default.
 *   - A refusal and a non-answer are different answers.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const writer = require('./odPerioWriter');
const { OpenDentalService } = require('../../config/openDental');

function recordingOd(answer = { ok: true, status: 201, data: { PerioExamNum: 7001, PerioMeasureNum: 90001 } }) {
  const calls = [];
  return {
    calls,
    client: {
      async apiWriteRaw(method, path, body, opts) {
        calls.push({ method, path, body, opts });
        return answer;
      },
    },
  };
}

const VALUES = { ToothValue: -1, MBvalue: 3, Bvalue: 2, DBvalue: 3, MLvalue: 3, Lvalue: 3, DLvalue: 4 };

test('OPENDENTAL_WRITE_DISABLED stops a perio write inside the REAL transport, and says so', async () => {
  const saved = process.env.OPENDENTAL_WRITE_DISABLED;
  process.env.OPENDENTAL_WRITE_DISABLED = 'true';
  try {
    const svc = new OpenDentalService();
    let reachedAxios = false;
    svc.client = {
      post: async () => {
        reachedAxios = true;
        return { status: 201, data: {} };
      },
      put: async () => {
        reachedAxios = true;
        return { status: 200, data: {} };
      },
    };
    const od = { client: svc };

    const exam = await writer.createPerioExam(od, { patNum: 12827, examDate: '2026-09-08', provNum: 7 });
    assert.equal(exam.ok, false);
    assert.equal(exam.refused, true, 'a disabled environment is a refusal, not an uncertain write');
    assert.equal(exam.code, 'OD_WRITE_DISABLED');

    const measure = await writer.createPerioMeasure(od, {
      examNum: 7001, tooth: 3, sequenceType: 'Probing', values: VALUES,
    });
    assert.equal(measure.code, 'OD_WRITE_DISABLED');
    assert.equal(reachedAxios, false, 'nothing reached the HTTP client');
  } finally {
    if (saved === undefined) delete process.env.OPENDENTAL_WRITE_DISABLED;
    else process.env.OPENDENTAL_WRITE_DISABLED = saved;
  }
});

test('CAL is never written — nor anything outside v1 scope — and nothing reaches the transport', async () => {
  const od = recordingOd();
  for (const sequenceType of ['CAL', 'GingMargin', 'Mobility', 'Furcation', 'MGJ', 'probing']) {
    const res = await writer.createPerioMeasure(od, { examNum: 7001, tooth: 3, sequenceType, values: VALUES });
    assert.equal(res.ok, false, sequenceType);
    assert.equal(res.code, 'SEQUENCE_TYPE_NOT_ALLOWED', sequenceType);
  }
  assert.deepEqual(od.calls, []);
  assert.deepEqual([...writer.ALLOWED_SEQUENCE_TYPES], ['Probing', 'BleedSupPlaqCalc', 'SkipTooth']);
});

test('the exam header always carries an explicit ProvNum, and refuses without one', async () => {
  const od = recordingOd();
  const res = await writer.createPerioExam(od, { patNum: 12827, examDate: '2026-09-08', provNum: 7 });
  assert.deepEqual(res, { ok: true, examNum: 7001 });
  assert.deepEqual(od.calls[0].body, { PatNum: 12827, ExamDate: '2026-09-08', ProvNum: 7 });
  assert.equal(od.calls[0].path, '/perioexams');

  for (const provNum of [null, 0, undefined]) {
    const refused = await writer.createPerioExam(od, { patNum: 12827, examDate: '2026-09-08', provNum });
    assert.equal(refused.code, 'NO_PROVIDER');
  }
  assert.equal(od.calls.length, 1, 'no exam without a provider reached the transport');
});

test('a measurement posts exactly Open Dental\'s shape, and nothing a CAL could hide in', async () => {
  const od = recordingOd();
  const res = await writer.createPerioMeasure(od, {
    examNum: 7001,
    tooth: 3,
    sequenceType: 'BleedSupPlaqCalc',
    values: { ...VALUES, CAL: 9, MBvalue: 5 },
  });
  assert.deepEqual(res, { ok: true, measureNum: 90001 });
  assert.deepEqual(Object.keys(od.calls[0].body).sort(), [
    'Bvalue', 'DBvalue', 'DLvalue', 'IntTooth', 'Lvalue', 'MBvalue', 'MLvalue',
    'PerioExamNum', 'SequenceType', 'ToothValue',
  ]);
  assert.equal(od.calls[0].body.MBvalue, 5);
});

test('a refusal and a non-answer are different answers', () => {
  assert.equal(writer.failureKind({ ok: false, status: 400, error: 'IntTooth is invalid' }), 'refused');
  assert.equal(writer.failureKind({ ok: false, status: 429, error: 'slow down' }), 'refused');
  assert.equal(writer.failureKind({ ok: false, status: 403, error: 'OD_WRITE_DISABLED: …' }), 'refused');
  // These may have landed. A retry must READ before it posts.
  assert.equal(writer.failureKind({ ok: false, status: 0, error: 'timeout of 30000ms exceeded' }), 'uncertain');
  assert.equal(writer.failureKind({ ok: false, status: 408, error: 'Request Timeout' }), 'uncertain');
  assert.equal(writer.failureKind({ ok: false, status: 503, error: 'Service Unavailable' }), 'uncertain');
});

test('an OK with no number minted is still OK here — the caller reads it back', async () => {
  const od = recordingOd({ ok: true, status: 201, data: {} });
  const res = await writer.createPerioMeasure(od, { examNum: 7001, tooth: 3, sequenceType: 'Probing', values: VALUES });
  assert.deepEqual(res, { ok: true, measureNum: null });
});
