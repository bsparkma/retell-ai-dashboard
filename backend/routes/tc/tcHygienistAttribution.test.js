'use strict';

/**
 * Hygienist attribution and the filterable submissions view (Roles PR B).
 *
 * The thing under test is the SEPARATION: `submitted_by` / `submitted_by_name`
 * remain the audit identity stamped from the session, and `hygienist_name` is
 * the clinical attribution the form supplies. With temp@carein.ai shared
 * between temps, only the second can answer "whose handoff is this?".
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, FakeTenantDb } = require('./tcTestUtils');

const INTAKE = {
  patientName: 'Test Patient',
  diagnosingProvider: 'dr.sparkman@carein.ai',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: true,
  patientInterestLevel: 'warm',
  flagUrgent: false,
  chiefConcern: 'Cracked tooth',
};

/**
 * FakeTenantDb refuses JOINs without an override (a harness that faked one
 * would pass tests the real database fails). This override implements the two
 * reads the submissions view makes: the joined list, and the DISTINCT chip set.
 */
function dbWithSubmissionReads() {
  const db = new FakeTenantDb();

  db.onQuery(/FROM tc_hygiene_intakes i\s+JOIN tc_cases c|FROM tc_hygiene_intakes i JOIN tc_cases c/i, (text, params) => {
    const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
    let intakes = db.table('tc_hygiene_intakes').filter((i) => i.office_id === params[0]);
    if (/i\.submitted_by = \$2/.test(text)) intakes = intakes.filter((i) => i.submitted_by === params[1]);
    if (/i\.hygienist_name = \$2/.test(text)) intakes = intakes.filter((i) => i.hygienist_name === params[1]);
    if (/c\.status = 'hygiene_review'/.test(text)) {
      intakes = intakes.filter((i) => cases.get(i.case_id).status === 'hygiene_review');
    }
    return {
      rows: intakes.map((i) => {
        const c = cases.get(i.case_id);
        return { ...i, patient_name: c.patient_name, case_status: c.status };
      }),
    };
  });

  db.onQuery(/SELECT DISTINCT hygienist_name/i, (_text, params) => {
    const names = new Set(
      db
        .table('tc_hygiene_intakes')
        .filter((i) => i.office_id === params[0] && i.hygienist_name !== '')
        .map((i) => i.hygienist_name)
    );
    return { rows: [...names].sort().map((hygienist_name) => ({ hygienist_name })) };
  });

  return db;
}

const submit = (baseUrl, body) =>
  api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', { ...INTAKE, ...body });

// --- attribution on submit --------------------------------------------------

test('a submission with no pick is attributed to the signed-in user', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'raegan@carein.ai', name: 'Raegan', tenantId: 'x' },
    db,
  });
  try {
    const res = await submit(baseUrl, { patientName: 'Patient A' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = db.table('tc_hygiene_intakes')[0];
    assert.equal(row.submitted_by, 'raegan@carein.ai', 'audit identity');
    assert.equal(row.submitted_by_name, 'Raegan');
    assert.equal(row.hygienist_name, 'Raegan', 'defaults to the signed-in display name');
  } finally {
    await close();
  }
});

test('THE TEMP CASE: a shared login records the name the temp picked, not the account', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await submit(baseUrl, { patientName: 'Patient A', hygienistName: 'Dana' });
    await submit(baseUrl, { patientName: 'Patient B', hygienistName: 'Kim' });

    const rows = db.table('tc_hygiene_intakes');
    assert.equal(rows.length, 2);
    // The audit identity is IDENTICAL for both — that is exactly the problem
    // this field exists to solve, and it must stay true (the session is still
    // recorded faithfully).
    assert.deepEqual([...new Set(rows.map((r) => r.submitted_by))], ['temp@carein.ai']);
    assert.deepEqual([...new Set(rows.map((r) => r.submitted_by_name))], ['Temp Hygienist']);
    // The attribution distinguishes them.
    assert.deepEqual(rows.map((r) => r.hygienist_name).sort(), ['Dana', 'Kim']);
  } finally {
    await close();
  }
});

test('a whitespace-only pick falls back rather than attributing to nobody', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await submit(baseUrl, { patientName: 'Patient A', hygienistName: '   ' });
    assert.equal(db.table('tc_hygiene_intakes')[0].hygienist_name, 'Temp Hygienist');
  } finally {
    await close();
  }
});

test('the client cannot forge the AUDIT identity by sending submittedBy', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    // The strict contract rejects the unknown key outright — submittedBy is
    // omitted from IntakeSubmit, so this is a 400, not a silent ignore.
    const res = await submit(baseUrl, {
      patientName: 'Patient A',
      submittedBy: 'someone.else@carein.ai',
    });
    assert.equal(res.status, 400);
    assert.equal(db.table('tc_hygiene_intakes').length, 0);
  } finally {
    await close();
  }
});

// --- the filterable list ----------------------------------------------------

/** Seed three submissions across two attributions under one shared account. */
async function seed(baseUrl) {
  await submit(baseUrl, { patientName: 'Patient A', hygienistName: 'Dana' });
  await submit(baseUrl, { patientName: 'Patient B', hygienistName: 'Dana' });
  await submit(baseUrl, { patientName: 'Patient C', hygienistName: 'Kim' });
}

test('GET / returns the office list plus the distinct hygienists for the chips', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await seed(baseUrl);

    const res = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.intakes.length, 3);
    assert.deepEqual(res.body.hygienists, ['Dana', 'Kim']);
  } finally {
    await close();
  }
});

test('?hygienist= returns that person\'s subset — and the chips stay complete', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await seed(baseUrl);

    const dana = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley&hygienist=Dana');
    assert.equal(dana.body.intakes.length, 2);
    assert.deepEqual(dana.body.intakes.map((i) => i.patient_name).sort(), ['Patient A', 'Patient B']);
    // The chip set is derived from the UNFILTERED data, so choosing one filter
    // never erases the others and strands the user.
    assert.deepEqual(dana.body.hygienists, ['Dana', 'Kim']);

    const kim = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley&hygienist=Kim');
    assert.equal(kim.body.intakes.length, 1);

    const nobody = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley&hygienist=Nobody');
    assert.equal(nobody.body.intakes.length, 0);
    assert.deepEqual(nobody.body.hygienists, ['Dana', 'Kim'], 'still escapable');
  } finally {
    await close();
  }
});

test('GET /mine is UNCHANGED — still session-scoped, not attribution-scoped', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await seed(baseUrl);
    const res = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/mine?office=valley');
    assert.equal(res.status, 200);
    // All three were submitted by the same account, so /mine still returns all
    // three. Nobody's existing view changed; the new list is additive.
    assert.equal(res.body.intakes.length, 3);
  } finally {
    await close();
  }
});

test('the list is office-scoped — a roland submission is unreachable from valley', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'temp@carein.ai', name: 'Temp Hygienist', tenantId: 'x' },
    db,
  });
  try {
    await submit(baseUrl, { patientName: 'Valley Patient', hygienistName: 'Dana' });
    await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
      ...INTAKE,
      patientName: 'Roland Patient',
      hygienistName: 'Kim',
    });

    const valley = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley');
    assert.equal(valley.body.intakes.length, 1);
    assert.deepEqual(valley.body.hygienists, ['Dana'], 'Kim is a roland name and must not leak');
  } finally {
    await close();
  }
});

// --- the roster endpoint ----------------------------------------------------

test('GET /hygienists lists the tenant\'s active hygiene users with derived labels', async () => {
  const registry = require('../../platform/registry');
  const originalByRole = registry.listTenantUsersByRole;
  registry.listTenantUsersByRole = async (_tenantId, role) => {
    assert.equal(role, 'hygiene');
    return [
      { email: 'raegan@carein.ai', role: 'hygiene', status: 'active' },
      { email: 'mary.beth@carein.ai', role: 'hygiene', status: 'active' },
      { email: 'temp@carein.ai', role: 'hygiene', status: 'active' },
    ];
  };

  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: dbWithSubmissionReads() });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/hygienists?office=valley');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.hygienists, [
      { email: 'raegan@carein.ai', label: 'Raegan' },
      { email: 'mary.beth@carein.ai', label: 'Mary Beth' },
      { email: 'temp@carein.ai', label: 'Temp' },
    ]);
  } finally {
    registry.listTenantUsersByRole = originalByRole;
    await close();
  }
});

test('GET /hygienists is reachable by hygiene and refused below it', async () => {
  const registry = require('../../platform/registry');
  const originalByRole = registry.listTenantUsersByRole;
  registry.listTenantUsersByRole = async () => [];
  try {
    // A hygienist needs the picker, so tc.hygiene must admit them.
    const asHygiene = await bootTcApp({ role: 'hygiene', db: dbWithSubmissionReads() });
    try {
      assert.equal(
        (await api(asHygiene.baseUrl, 'GET', '/api/tc/hygiene-intakes/hygienists?office=valley')).status,
        200
      );
    } finally {
      await asHygiene.close();
    }

    // A voice-only tenant is refused by the module gate before any of this.
    const noTc = await bootTcApp({ role: 'admin', modules: ['voice'], db: dbWithSubmissionReads() });
    try {
      const res = await api(noTc.baseUrl, 'GET', '/api/tc/hygiene-intakes/hygienists?office=valley');
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    } finally {
      await noTc.close();
    }
  } finally {
    registry.listTenantUsersByRole = originalByRole;
  }
});
