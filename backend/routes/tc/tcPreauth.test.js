'use strict';

/**
 * /api/tc/preauth — CRUD round-trips, status flow with server-stamped dates,
 * strict rejection, office scoping, audit rows.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const MINIMAL = {
  patientName: 'PA Patient',
  preauthType: 'treatment',
  insuranceCarrier: 'Delta Dental',
};

test('create → get → patch round-trip; status always starts pending', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/preauth?office=roland', MINIMAL);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const pa = created.body.preauthCase;
    assert.equal(pa.status, 'pending');
    assert.equal(pa.officeId, 'roland');

    const fetched = await api(baseUrl, 'GET', `/api/tc/preauth/${pa.preauthId}?office=roland`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.preauthCase, pa);

    const patched = await api(baseUrl, 'PUT', `/api/tc/preauth/${pa.preauthId}?office=roland`, {
      referenceNumber: 'REF-123',
      notes: 'Submitted via portal',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.preauthCase.referenceNumber, 'REF-123');

    // status is not patchable here (strict schema).
    const statusViaPut = await api(baseUrl, 'PUT', `/api/tc/preauth/${pa.preauthId}?office=roland`, {
      status: 'approved',
    });
    assert.equal(statusViaPut.status, 400);

    assert.ok(auditRows(db).some((r) => r.resource_type === 'tc_preauth' && r.action === 'CREATE'));
  } finally {
    await close();
  }
});

test('status flow stamps submitted_date and decision_date exactly once', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/preauth?office=roland', MINIMAL);
    const id = created.body.preauthCase.preauthId;

    const submitted = await api(baseUrl, 'POST', `/api/tc/preauth/${id}/status?office=roland`, {
      status: 'submitted',
    });
    assert.equal(submitted.status, 200);
    const submittedDate = submitted.body.preauthCase.submittedDate;
    assert.ok(submittedDate, 'submitted must stamp submitted_date');
    assert.equal(submitted.body.preauthCase.decisionDate, null);

    const approved = await api(baseUrl, 'POST', `/api/tc/preauth/${id}/status?office=roland`, {
      status: 'approved',
    });
    assert.equal(approved.status, 200);
    assert.ok(approved.body.preauthCase.decisionDate, 'approved must stamp decision_date');
    assert.equal(approved.body.preauthCase.submittedDate, submittedDate, 'submitted_date is stamped once');

    const bad = await api(baseUrl, 'POST', `/api/tc/preauth/${id}/status?office=roland`, {
      status: 'granted',
    });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('office scoping + delete', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/preauth?office=valley', MINIMAL);
    const id = created.body.preauthCase.preauthId;

    const cross = await api(baseUrl, 'GET', `/api/tc/preauth/${id}?office=roland`);
    assert.equal(cross.status, 404);
    const crossDelete = await api(baseUrl, 'DELETE', `/api/tc/preauth/${id}?office=roland`);
    assert.equal(crossDelete.status, 404);

    const del = await api(baseUrl, 'DELETE', `/api/tc/preauth/${id}?office=valley`);
    assert.equal(del.status, 200);
    const gone = await api(baseUrl, 'GET', `/api/tc/preauth/${id}?office=valley`);
    assert.equal(gone.status, 404);
  } finally {
    await close();
  }
});

test('strict rejection: unknown keys and bad type → 400, nothing written', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const unknownKey = await api(baseUrl, 'POST', '/api/tc/preauth?office=roland', {
      ...MINIMAL,
      carrier: 'x',
    });
    assert.equal(unknownKey.status, 400);

    const badType = await api(baseUrl, 'POST', '/api/tc/preauth?office=roland', {
      ...MINIMAL,
      preauthType: 'ortho',
    });
    assert.equal(badType.status, 400);

    assert.equal(db.table('tc_preauth_cases').length, 0);
  } finally {
    await close();
  }
});
