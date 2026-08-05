'use strict';

/**
 * /api/tc/cases — CRUD round-trips, strict-contract rejection, office-scoping
 * denial, status-transition rules, audit rows.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const MINIMAL_CASE = {
  patientName: 'Test Patient',
  category: 'implant',
  status: 'diagnosed',
  urgency: 'high',
  caseValueCents: 450000,
};

test('create → get round-trips through the DB (money stays integer cents)', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', {
      ...MINIMAL_CASE,
      phases: [
        {
          position: 0,
          name: 'Phase 1',
          items: [
            {
              position: 0,
              procedureName: 'Implant placement',
              feeCents: 250000,
              insuranceEstCents: 100000,
              patientPortionCents: 150000,
              urgency: 'high',
            },
          ],
        },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const c = created.body.case;
    assert.equal(c.officeId, 'roland');
    assert.equal(c.caseValueCents, 450000);
    assert.equal(c.phases.length, 1);
    assert.equal(c.phases[0].items[0].patientPortionCents, 150000);
    // Server wrote the timeline itself, stamped with the SSO identity.
    assert.equal(c.events.length, 1);
    assert.equal(c.events[0].type, 'case_created');
    assert.equal(c.events[0].actor, 'tc@carein.ai');

    const fetched = await api(baseUrl, 'GET', `/api/tc/cases/${c.caseId}?office=roland`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.case, c);

    // Audit rows: CREATE for the mutation, READ for the fetch.
    const actions = auditRows(db).map((r) => r.action);
    assert.ok(actions.includes('CREATE'), 'create must write an audit row');
    assert.ok(actions.includes('READ'), 'read must write an audit row');
  } finally {
    await close();
  }
});

test('strict contract rejection: float dollars, unknown keys, bad enums → 400', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const cases = [
      { ...MINIMAL_CASE, caseValueCents: 4500.5 }, // float money
      { ...MINIMAL_CASE, caseValue: 4500 }, // unknown key
      { ...MINIMAL_CASE, category: 'bridge' }, // bad enum
      { ...MINIMAL_CASE, status: 'won' }, // bad enum
    ];
    for (const body of cases) {
      const res = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }
    assert.equal(db.table('tc_cases').length, 0, 'no partial writes on rejection');
  } finally {
    await close();
  }
});

test('office scoping: a roland case is unreachable in a valley context', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', MINIMAL_CASE);
    const caseId = created.body.case.caseId;

    const crossGet = await api(baseUrl, 'GET', `/api/tc/cases/${caseId}?office=valley`);
    assert.equal(crossGet.status, 404);

    const crossPatch = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}?office=valley`, { notes: 'x' });
    assert.equal(crossPatch.status, 404);

    const crossDelete = await api(baseUrl, 'DELETE', `/api/tc/cases/${caseId}?office=valley`);
    assert.equal(crossDelete.status, 404);

    const valleyList = await api(baseUrl, 'GET', '/api/tc/cases?office=valley');
    assert.equal(valleyList.body.cases.length, 0);
    const rolandList = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
    assert.equal(rolandList.body.cases.length, 1);
  } finally {
    await close();
  }
});

test('scalar PUT patches fields but never status', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', MINIMAL_CASE);
    const caseId = created.body.case.caseId;

    const patched = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}?office=roland`, {
      notes: 'spouse involved',
      readinessScore: 70,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.case.notes, 'spouse involved');
    assert.equal(patched.body.case.readinessScore, 70);

    const statusViaPut = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}?office=roland`, {
      status: 'accepted',
    });
    assert.equal(statusViaPut.status, 400, 'status must be rejected on the scalar PUT');

    const empty = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}?office=roland`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'EMPTY_PATCH');
  } finally {
    await close();
  }
});

test('status transition writes the status_change event; lost requires a reason', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', MINIMAL_CASE);
    const caseId = created.body.case.caseId;

    const noReason = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, {
      status: 'lost',
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'LOST_REASON_REQUIRED');

    const reasonOnNonLost = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, {
      status: 'presented',
      lostReason: 'moved',
    });
    assert.equal(reasonOnNonLost.status, 400);
    assert.equal(reasonOnNonLost.body.code, 'LOST_REASON_INVALID');

    const ok = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, {
      status: 'presented',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.case.status, 'presented');
    const change = ok.body.case.events.find((e) => e.type === 'status_change');
    assert.ok(change, 'status_change event must be written');
    assert.equal(change.actor, 'tc@carein.ai');
    assert.match(change.description, /diagnosed → presented/);

    // nurture enrollment stamps the clock + a nurture_enrolled event, once.
    const nurture = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, {
      status: 'nurture',
    });
    assert.equal(nurture.status, 200);
    assert.ok(nurture.body.case.nurtureEnrolledAt, 'nurture_enrolled_at must be stamped');
    assert.ok(nurture.body.case.events.some((e) => e.type === 'nurture_enrolled'));

    const updates = auditRows(db).filter((r) => r.action === 'UPDATE');
    assert.ok(updates.length >= 2, 'each transition must audit an UPDATE');
  } finally {
    await close();
  }
});

test('objections and events append with server identity; delete removes the case', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', MINIMAL_CASE);
    const caseId = created.body.case.caseId;

    const objection = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/objections?office=roland`, {
      category: 'cost',
      note: 'Concerned about total',
      patientWords: 'That is a lot of money',
    });
    assert.equal(objection.status, 201, JSON.stringify(objection.body));

    const badEvent = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/events?office=roland`, {
      type: 'contact_attempt',
      description: 'called',
    });
    assert.equal(badEvent.status, 400);
    assert.equal(badEvent.body.code, 'DETAIL_REQUIRED');

    const event = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/events?office=roland`, {
      type: 'contact_attempt',
      description: 'called, left voicemail',
      detail: { channel: 'call', outcome: 'voicemail' },
    });
    assert.equal(event.status, 201);
    assert.equal(event.body.event.actor, 'tc@carein.ai');

    const del = await api(baseUrl, 'DELETE', `/api/tc/cases/${caseId}?office=roland`);
    assert.equal(del.status, 200);
    const gone = await api(baseUrl, 'GET', `/api/tc/cases/${caseId}?office=roland`);
    assert.equal(gone.status, 404);
  } finally {
    await close();
  }
});

test('phases tree replace is atomic and returns the persisted tree', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', MINIMAL_CASE);
    const caseId = created.body.case.caseId;

    const dup = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}/phases?office=roland`, [
      { position: 0, name: 'A', items: [] },
      { position: 0, name: 'B', items: [] },
    ]);
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, 'DUPLICATE_PHASE_POSITION');

    const ok = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}/phases?office=roland`, [
      {
        position: 0,
        name: 'Foundation',
        items: [
          {
            position: 0,
            procedureName: 'Extraction',
            feeCents: 30000,
            insuranceEstCents: 10000,
            patientPortionCents: 20000,
            urgency: 'high',
          },
        ],
      },
    ]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.case.phases.length, 1);
    assert.equal(ok.body.case.phases[0].name, 'Foundation');
    assert.equal(ok.body.case.phases[0].items[0].feeCents, 30000);
  } finally {
    await close();
  }
});
