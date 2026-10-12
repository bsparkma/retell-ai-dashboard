'use strict';

/**
 * The TC side of the ortho screening (queue item 33).
 *
 *   - An intake carrying `orthoScreening` stores it (jsonb) and every read of
 *     the case returns it — the case detail renders from this.
 *   - An intake WITHOUT one — TC's own form, the treatment handoff — stores
 *     NULL and reads back exactly as before (acceptance 8, server half).
 *   - The board's list marks screened cases with `hasOrthoScreening`, from one
 *     office-scoped query, without loading children.
 *   - A malformed screening is refused by TC's own contract before any write.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api } = require('./tcTestUtils');
const hygContract = require('../../hyg/contract.gen.cjs');

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

const SCREENING = {
  ...hygContract.emptyOrthoScreening(),
  interest: 'yes',
  concerns: ['crowding'],
  months: [12],
  noteForTc: 'Wants to start before summer.',
};

/** The single-case read goes through loadCaseAggregate's six office-scoped SELECTs. */
async function getCase(baseUrl, caseId) {
  return api(baseUrl, 'GET', `/api/tc/cases/${caseId}?office=roland`);
}

test('an intake WITH a screening stores it, and the case reads it back', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
      ...INTAKE,
      category: 'ortho',
      urgency: 'elective',
      caseType: 'Ortho screening',
      orthoScreening: SCREENING,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.case.hygieneIntake.orthoScreening, SCREENING);
    assert.deepEqual(db.table('tc_hygiene_intakes')[0].ortho_screening, SCREENING);

    const read = await getCase(baseUrl, res.body.case.caseId);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.case.hygieneIntake.orthoScreening, SCREENING);
  } finally {
    await close();
  }
});

test('8 (server): an intake WITHOUT a screening stores NULL and reads back unchanged', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', INTAKE);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.case.hygieneIntake.orthoScreening, null);
    assert.equal(db.table('tc_hygiene_intakes')[0].ortho_screening, null);
    // Every other intake field is exactly what it was.
    const intake = res.body.case.hygieneIntake;
    assert.equal(intake.perioStatus, 'gingivitis');
    assert.deepEqual(intake.radiographs, ['BWX']);
    assert.equal(res.body.case.category, 'single_tooth');

    const read = await getCase(baseUrl, res.body.case.caseId);
    assert.equal(read.status, 200);
    assert.equal(read.body.case.hygieneIntake.orthoScreening, null);
  } finally {
    await close();
  }
});

test('the board list marks a screened case, and only that one', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const plain = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', INTAKE);
    const ortho = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
      ...INTAKE,
      category: 'ortho',
      orthoScreening: SCREENING,
    });
    const list = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const byId = new Map(list.body.cases.map((c) => [c.caseId, c]));
    assert.equal(byId.get(ortho.body.case.caseId).hasOrthoScreening, true);
    assert.equal(byId.get(plain.body.case.caseId).hasOrthoScreening, false);
    // The other office's list cannot see it.
    const valley = await api(baseUrl, 'GET', '/api/tc/cases?office=valley');
    assert.equal(valley.status, 200);
    assert.equal(valley.body.cases.length, 0);
  } finally {
    await close();
  }
});

test('a malformed screening is refused by TC’s contract before anything is written', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const bad = [
      { ...SCREENING, afterOrtho: ['none', 'fmr'] },
      { ...SCREENING, months: [7] },
      { ...SCREENING, unknownKey: true },
    ];
    for (const orthoScreening of bad) {
      const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
        ...INTAKE,
        orthoScreening,
      });
      assert.equal(res.status, 400, JSON.stringify(orthoScreening));
    }
    assert.equal(db.table('tc_cases').length, 0);
    assert.equal(db.table('tc_hygiene_intakes').length, 0);
  } finally {
    await close();
  }
});
