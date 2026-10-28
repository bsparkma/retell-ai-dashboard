'use strict';

/**
 * TC's hygiene intake carries the existing-treatment answers (hygiene Slice 2b).
 *
 * ADDITIVE AND OPTIONAL, the same shape of change item 33 made with the ortho
 * screening: an intake that sends none stores NULL and reads back exactly as it
 * did, and one that sends them stores the array and reads it back.
 *
 * Synthetic: 12828 is the roland TC staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api } = require('./tcTestUtils');

const INTAKE = {
  patientName: 'Test, MangoTest',
  odPatientId: 12828,
  diagnosingProvider: 'DOC1',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: false,
  patientInterestLevel: 'unknown',
  flagUrgent: false,
};

const EXISTING = [
  {
    procNum: 5001,
    code: 'D2740',
    description: 'Crown',
    tooth: '30',
    surface: '',
    dateTp: '2026-06-20',
    priorityName: null,
    scheduled: false,
    clinical: 'worse_urgent',
    patient: 'wants_to_wait',
    waitTimeframe: '3_months',
    note: null,
  },
  {
    procNum: 5002,
    code: 'D2391',
    description: 'Composite',
    tooth: '14',
    surface: 'O',
    dateTp: null,
    priorityName: 'Watch',
    scheduled: true,
    clinical: null,
    patient: 'not_discussed',
    waitTimeframe: null,
    note: null,
  },
];

test('an intake that sends no existing treatment stores NULL and reads back unchanged', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', INTAKE);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.case.hygieneIntake.existingTx, null);
    assert.equal(db.table('tc_hygiene_intakes')[0].existing_tx, null);
  } finally {
    await close();
  }
});

test('an intake WITH existing treatment stores it as a jsonb array and reads it back', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
      ...INTAKE,
      existingTx: EXISTING,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.case.hygieneIntake.existingTx, EXISTING);
    // The fake parses jsonb as the driver does. That caseStore ENCODES the array
    // (a bare JS array would reach Postgres as an ARRAY literal and be refused)
    // is pinned against a real Postgres in the slice's rehearsal.
    assert.deepEqual(db.table('tc_hygiene_intakes')[0].existing_tx, EXISTING);

    const read = await api(baseUrl, 'GET', `/api/tc/cases/${res.body.case.caseId}?office=roland`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
  } finally {
    await close();
  }
});

test('a malformed item is refused by TC’s contract before anything is written', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    for (const bad of [
      [{ ...EXISTING[0], patient: 'maybe' }],
      [{ ...EXISTING[0], fee: 1200 }],
      [{ ...EXISTING[0], procNum: 0 }],
    ]) {
      const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', { ...INTAKE, existingTx: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal(db.table('tc_hygiene_intakes').length, 0);
  } finally {
    await close();
  }
});
