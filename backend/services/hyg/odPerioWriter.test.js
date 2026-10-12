'use strict';

/**
 * The perio writer (item 12): three calls, and every refusal happens BEFORE the
 * transport.
 *
 * The fake client below records what reached it. A refusal test asserts it
 * recorded NOTHING — "refused" means Open Dental was never asked.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const writer = require('./odPerioWriter');

function fakeOd({ write = { ok: true, status: 201, data: { PerioExamNum: 7001 } }, del = { ok: true, status: 200, data: null } } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      apiWriteRaw: async (method, path, body, opts) => {
        calls.push({ method, path, body, opts });
        return write;
      },
      apiDeleteRaw: async (path, opts) => {
        calls.push({ method: 'DELETE', path, opts });
        return del;
      },
    },
  };
}

const EXAM = { patNum: 12827, examDate: '2026-09-08', provNum: 7 };

test('the exam carries the strings it was given, the provider, and a note that names nobody', async () => {
  const od = fakeOd();
  const res = await writer.createPerioExam(od, {
    ...EXAM,
    strings: { UpperFacial: '3b2s4p5c6bs7pc8bspc', LowerLingual: '4'.repeat(48) },
  });
  assert.deepEqual(res, { ok: true, examNum: 7001 });
  assert.equal(od.calls.length, 1);
  assert.equal(od.calls[0].method, 'POST');
  assert.equal(od.calls[0].path, '/perioexams');
  assert.deepEqual(od.calls[0].body, {
    PatNum: 12827,
    ExamDate: '2026-09-08',
    ProvNum: 7,
    Note: 'Charted in CareIN.',
    UpperFacial: '3b2s4p5c6bs7pc8bspc',
    LowerLingual: '4'.repeat(48),
  });
});

test('a chart with no expressible arch still gets its exam, with no string at all', async () => {
  const od = fakeOd();
  await writer.createPerioExam(od, { ...EXAM, strings: {} });
  assert.deepEqual(Object.keys(od.calls[0].body).sort(), ['ExamDate', 'Note', 'PatNum', 'ProvNum']);
});

test('a string that could shift readings is refused before Open Dental is asked', async () => {
  for (const bad of ['10 11 19 3', '3x3-3_3 3X3', '', '4'.repeat(49), 'b3', '3bb']) {
    const od = fakeOd();
    const res = await writer.createPerioExam(od, { ...EXAM, strings: { UpperFacial: bad } });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.refused, true);
    assert.equal(res.code, 'BAD_ARCH_STRING');
    assert.equal(od.calls.length, 0, 'the transport was never reached for ' + JSON.stringify(bad));
  }
  const od = fakeOd();
  const res = await writer.createPerioExam(od, { ...EXAM, strings: { UpperRecession: '3' } });
  assert.equal(res.code, 'BAD_ARCH_STRING');
  assert.equal(od.calls.length, 0);
});

test('no provider, no PatNum or no date is refused before the transport', async () => {
  for (const [over, code] of [
    [{ provNum: 0 }, 'NO_PROVIDER'],
    [{ patNum: null }, 'BAD_EXAM'],
    [{ examDate: '09/08/2026' }, 'BAD_EXAM'],
  ]) {
    const od = fakeOd();
    const res = await writer.createPerioExam(od, { ...EXAM, ...over, strings: {} });
    assert.equal(res.code, code);
    assert.equal(od.calls.length, 0);
  }
});

test('a measurement: the six allowed types, never CAL, values -1..19', async () => {
  const values = { ToothValue: -1, MBvalue: 3, Bvalue: -1, DBvalue: 12, MLvalue: 0, Lvalue: 2, DLvalue: 19 };
  const od = fakeOd({ write: { ok: true, status: 201, data: { PerioMeasureNum: 90001 } } });
  const ok = await writer.createPerioMeasure(od, { examNum: 7001, tooth: 3, sequenceType: 'Probing', values });
  assert.deepEqual(ok, { ok: true, measureNum: 90001 });
  assert.deepEqual(od.calls[0].body, { PerioExamNum: 7001, SequenceType: 'Probing', IntTooth: 3, ...values });

  for (const [args, code] of [
    // CAL is the one that must NEVER be writable: Open Dental derives its own,
    // and a CAL CareIN wrote could disagree with the chart of record.
    [{ sequenceType: 'CAL' }, 'SEQUENCE_TYPE_NOT_ALLOWED'],
    [{ sequenceType: 'Recession' }, 'SEQUENCE_TYPE_NOT_ALLOWED'],
    [{ sequenceType: 'MGJ' }, 'SEQUENCE_TYPE_NOT_ALLOWED'],
    /*
     * ITEM 26 allows Mobility as a TYPE — and refuses this row, because these
     * `values` carry surface measurements and a Mobility row must not. Open Dental
     * refuses that one itself (`MBvalue is invalid...`); this is the same refusal,
     * one hop earlier.
     */
    [{ sequenceType: 'Mobility' }, 'BAD_MEASURE'],
    [{ tooth: 33 }, 'BAD_MEASURE'],
    [{ examNum: 0 }, 'BAD_MEASURE'],
    [{ values: { ...values, MBvalue: -2 } }, 'BAD_MEASURE'],
    [{ values: { ...values, MBvalue: 20 } }, 'BAD_MEASURE'],
    [{ values: { ...values, Lvalue: undefined } }, 'BAD_MEASURE'],
  ]) {
    const again = fakeOd();
    const res = await writer.createPerioMeasure(again, {
      examNum: 7001,
      tooth: 3,
      sequenceType: 'Probing',
      values,
      ...args,
    });
    assert.equal(res.code, code, JSON.stringify(args));
    assert.equal(again.calls.length, 0);
  }
});

test('the undo deletes exactly /perioexams/{n}, through apiDeleteRaw, and nothing without a number', async () => {
  const od = fakeOd();
  assert.deepEqual(await writer.deletePerioExam(od, { examNum: 7001 }), { ok: true });
  assert.deepEqual(od.calls.map((c) => [c.method, c.path]), [['DELETE', '/perioexams/7001']]);

  const none = fakeOd();
  for (const examNum of [0, -1, null, '7001', 1.5]) {
    const res = await writer.deletePerioExam(none, { examNum });
    assert.equal(res.code, 'BAD_EXAM');
  }
  assert.equal(none.calls.length, 0);
});

test('three answers, not two: refused, uncertain, and the environment switch', async () => {
  assert.equal(writer.failureKind({ status: 400, error: 'UpperLingual must start with a number from 0-9.' }), 'refused');
  assert.equal(writer.failureKind({ status: 408 }), 'uncertain');
  assert.equal(writer.failureKind({ status: 503 }), 'uncertain');
  assert.equal(writer.failureKind({ status: 0, error: 'timeout of 30000ms exceeded' }), 'uncertain');

  const disabled = fakeOd({
    write: { ok: false, status: 403, error: 'OD_WRITE_DISABLED: Open Dental writes are disabled in this environment' },
    del: { ok: false, status: 403, error: 'OD_WRITE_DISABLED: Open Dental writes are disabled in this environment' },
  });
  const exam = await writer.createPerioExam(disabled, { ...EXAM, strings: {} });
  assert.deepEqual([exam.refused, exam.code], [true, 'OD_WRITE_DISABLED']);
  const del = await writer.deletePerioExam(disabled, { examNum: 7001 });
  assert.deepEqual([del.refused, del.code], [true, 'OD_WRITE_DISABLED']);

  const silent = fakeOd({ write: { ok: false, status: 0, error: 'socket hang up' } });
  const lost = await writer.createPerioExam(silent, { ...EXAM, strings: {} });
  assert.deepEqual([lost.refused, lost.code], [false, 'OD_NO_ANSWER']);
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 26: the three v2 types, and the clinical limits Open Dental does not keep
// ─────────────────────────────────────────────────────────────────────────────

const NO_SURFACES = { MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1 };

test('ITEM 26: a GingMargin row goes out per site, ToothValue -1, in the recession family', async () => {
  const values = { ToothValue: -1, ...NO_SURFACES, Bvalue: 2 };
  const od = fakeOd({ write: { ok: true, status: 201, data: { PerioMeasureNum: 90010 } } });
  const res = await writer.createPerioMeasure(od, {
    examNum: 7001,
    tooth: 3,
    sequenceType: 'GingMargin',
    values,
  });
  assert.deepEqual(res, { ok: true, measureNum: 90010 });
  // The body is exactly the shape the probe measured, and §0's family.
  assert.deepEqual(od.calls[0].body, {
    PerioExamNum: 7001,
    SequenceType: 'GingMargin',
    IntTooth: 3,
    ...values,
  });
});

test('ITEM 26: the OTHER gingival-margin family is refused before the transport', async () => {
  // Open Dental accepts 101-119 and stores it verbatim. CareIN never writes it:
  // which sign it means has never been observed, so writing one would be a guess
  // recorded in a chart of record.
  for (const bad of [101, 102, 119]) {
    const od = fakeOd();
    const res = await writer.createPerioMeasure(od, {
      examNum: 7001,
      tooth: 3,
      sequenceType: 'GingMargin',
      values: { ToothValue: -1, ...NO_SURFACES, Bvalue: bad },
    });
    assert.equal(res.code, 'BAD_MEASURE', 'Bvalue=' + bad);
    assert.match(res.error, /recession/);
    assert.equal(od.calls.length, 0, 'and it never reached the transport');
  }
});

test('ITEM 26: a Mobility row is per TOOTH — grade in ToothValue, every surface -1', async () => {
  const od = fakeOd({ write: { ok: true, status: 201, data: { PerioMeasureNum: 90011 } } });
  const res = await writer.createPerioMeasure(od, {
    examNum: 7001,
    tooth: 30,
    sequenceType: 'Mobility',
    values: { ToothValue: 2, ...NO_SURFACES },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(od.calls[0].body, {
    PerioExamNum: 7001,
    SequenceType: 'Mobility',
    IntTooth: 30,
    ToothValue: 2,
    ...NO_SURFACES,
  });

  // 0-3 clinically. Open Dental would take up to 19; a tooth does not.
  for (const grade of [4, 9, 19]) {
    const again = fakeOd();
    const bad = await writer.createPerioMeasure(again, {
      examNum: 7001,
      tooth: 30,
      sequenceType: 'Mobility',
      values: { ToothValue: grade, ...NO_SURFACES },
    });
    assert.equal(bad.code, 'BAD_MEASURE', 'grade=' + grade);
    assert.equal(again.calls.length, 0);
  }
});

test('ITEM 26: furcation is refused on a single-rooted tooth, and above class 3', async () => {
  /*
   * THE TWO CORRUPTION HAZARDS THE PROBE FOUND (§7). Open Dental ACCEPTED AND
   * STORED `Bvalue: 5` on #14, and furcation on #8 — a central incisor. It does
   * not know which teeth have roots to fork, so this file is the only thing
   * between a typo and a permanent row in a chart of record.
   */
  for (const tooth of [8, 9, 6, 22, 27]) {
    const od = fakeOd();
    const res = await writer.createPerioMeasure(od, {
      examNum: 7001,
      tooth,
      sequenceType: 'Furcation',
      values: { ToothValue: -1, ...NO_SURFACES, Bvalue: 2 },
    });
    assert.equal(res.code, 'BAD_MEASURE', 'tooth ' + tooth);
    assert.match(res.error, /multi-rooted/);
    assert.equal(od.calls.length, 0);
  }

  for (const cls of [0, 4, 5, 19]) {
    const od = fakeOd();
    const res = await writer.createPerioMeasure(od, {
      examNum: 7001,
      tooth: 3,
      sequenceType: 'Furcation',
      values: { ToothValue: -1, ...NO_SURFACES, Bvalue: cls },
    });
    assert.equal(res.code, 'BAD_MEASURE', 'class ' + cls);
    assert.equal(od.calls.length, 0);
  }

  // And the eligible teeth DO go through — molars, plus the two-rooted upper
  // first premolars.
  for (const tooth of [1, 3, 5, 12, 14, 16, 19, 30, 32]) {
    const od = fakeOd({ write: { ok: true, status: 201, data: { PerioMeasureNum: 1 } } });
    const res = await writer.createPerioMeasure(od, {
      examNum: 7001,
      tooth,
      sequenceType: 'Furcation',
      values: { ToothValue: -1, ...NO_SURFACES, Bvalue: 3 },
    });
    assert.equal(res.ok, true, 'tooth ' + tooth);
  }
});

test('ITEM 26: a per-site row with ToothValue set, or with nothing measured, is refused', async () => {
  for (const sequenceType of ['GingMargin', 'Furcation']) {
    // ToothValue must be -1 — Open Dental refuses it otherwise, measured.
    const withTooth = fakeOd();
    const a = await writer.createPerioMeasure(withTooth, {
      examNum: 7001,
      tooth: 3,
      sequenceType,
      values: { ToothValue: 1, ...NO_SURFACES, Bvalue: 2 },
    });
    assert.equal(a.code, 'BAD_MEASURE', sequenceType);
    assert.match(a.error, /per site/);
    assert.equal(withTooth.calls.length, 0);

    // A row of six -1s says NOTHING. Open Dental will store one; we will not
    // write one. (Measured: a GingMargin row can carry all -1.)
    const emptyRow = fakeOd();
    const b = await writer.createPerioMeasure(emptyRow, {
      examNum: 7001,
      tooth: 3,
      sequenceType,
      values: { ToothValue: -1, ...NO_SURFACES },
    });
    assert.equal(b.code, 'BAD_MEASURE', sequenceType);
    assert.match(b.error, /says nothing/);
    assert.equal(emptyRow.calls.length, 0);
  }
});
