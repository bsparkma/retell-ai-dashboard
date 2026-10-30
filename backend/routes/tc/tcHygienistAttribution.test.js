'use strict';

/**
 * Hygienist attribution (Roles PR B). The filterable submissions view and the
 * roster endpoint were removed in CO-2 with the TC app's Hygiene pages.
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
  diagnosingProvider: 'dr.example@carein.ai',
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
 * would pass tests the real database fails). This override implements the one
 * read it still makes: the joined list (the DISTINCT chip read went with GET / in CO-2).
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

  return db;
}

const submit = (baseUrl, body) =>
  api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', { ...INTAKE, ...body });

// --- attribution on submit --------------------------------------------------

test('a submission with no pick is attributed to the signed-in user', async () => {
  const db = dbWithSubmissionReads();
  const { baseUrl, close } = await bootTcApp({
    role: 'hygiene',
    user: { email: 'avery@carein.ai', name: 'Avery', tenantId: 'x' },
    db,
  });
  try {
    const res = await submit(baseUrl, { patientName: 'Patient A' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = db.table('tc_hygiene_intakes')[0];
    assert.equal(row.submitted_by, 'avery@carein.ai', 'audit identity');
    assert.equal(row.submitted_by_name, 'Avery');
    assert.equal(row.hygienist_name, 'Avery', 'defaults to the signed-in display name');
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

// RULING (CO-2): GET / (the Submissions page) and GET /hygienists (the intake
// form's picker) went with the TC app's Hygiene pages, their only callers. The
// tests that pinned their behaviour went with them; this pins that they are
// gone, and that the hygiene app's POST / handoff is not.
test('CO-2: GET / and GET /hygienists are gone; the POST / handoff still lands', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: dbWithSubmissionReads() });
  try {
    const posted = await submit(baseUrl, { hygienistName: 'Dana' });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley')).status, 404);
    assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/hygienists?office=valley')).status, 404);
  } finally {
    await close();
  }
});
