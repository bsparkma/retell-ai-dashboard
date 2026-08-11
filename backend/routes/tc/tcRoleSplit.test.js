'use strict';

/**
 * The tc.full / tc.hygiene split, end to end (Roles PR A).
 *
 * A hygienist reaches exactly three things: submit an intake, see their own
 * submissions, see the inbox. Everything else under /api/tc is a 403 — and
 * claiming a case out of the inbox is a 403 too, because claiming makes the
 * caller the case's coordinator.
 *
 * These run the REAL /api/tc stack (tenantContext → requireModule('tc') →
 * requirePermission) against the fake tenant DB, so they cover the wiring, not
 * just the map.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, FakeTenantDb } = require('./tcTestUtils');

/**
 * The two list endpoints these tests touch JOIN tc_cases, which FakeTenantDb
 * refuses without an override (a harness that silently faked a JOIN would pass
 * tests the real database fails). The join RESULT is irrelevant here — these
 * tests are about who gets past the gate — so the overrides return an empty
 * set and the assertions are on the status code.
 */
function dbWithJoins() {
  const db = new FakeTenantDb();
  db.onQuery(/FROM tc_hygiene_intakes i JOIN tc_cases c/i, () => ({ rows: [] }));
  db.onQuery(/SELECT f\.followup_id[\s\S]+JOIN tc_cases c/i, () => ({ rows: [] }));
  return db;
}

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

/** Every tc.full sub-router, with a cheap GET that exists on each. */
const TC_FULL_READS = [
  '/api/tc/cases?office=valley',
  '/api/tc/followups?office=valley',
  '/api/tc/followups/due?office=valley',
  '/api/tc/preauth?office=valley',
  '/api/tc/templates?office=valley',
  '/api/tc/communications?office=valley',
  '/api/tc/library?office=valley',
];

test('hygiene: may submit an intake, list their submissions, and see the inbox', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: dbWithJoins() });
  try {
    const submitted = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));

    const mine = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/mine?office=valley');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));

    const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=valley');
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  } finally {
    await close();
  }
});

test('hygiene: 403 FORBIDDEN on every tc.full sub-router', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: dbWithJoins() });
  try {
    for (const p of TC_FULL_READS) {
      const res = await api(baseUrl, 'GET', p);
      assert.equal(res.status, 403, `hygiene must not reach ${p} (got ${res.status})`);
      assert.equal(res.body.code, 'FORBIDDEN');
      assert.equal(res.body.action, 'tc.full');
    }
  } finally {
    await close();
  }
});

test('hygiene: cannot CLAIM a case out of the inbox — that is a TC action', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: dbWithJoins() });
  try {
    const submitted = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    assert.equal(submitted.status, 201);
    const caseId = submitted.body.case.caseId;

    const claimed = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${caseId}/claim?office=valley`, {});
    assert.equal(claimed.status, 403, 'claiming assigns the caller as the coordinator');
    assert.equal(claimed.body.action, 'tc.full');
  } finally {
    await close();
  }
});

test('tc: reaches the full surface, including claim', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'tc', db: dbWithJoins() });
  try {
    for (const p of TC_FULL_READS) {
      const res = await api(baseUrl, 'GET', p);
      assert.equal(res.status, 200, `tc should reach ${p}: ${JSON.stringify(res.body)}`);
    }

    const submitted = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    assert.equal(submitted.status, 201);
    const claimed = await api(
      baseUrl,
      'POST',
      `/api/tc/hygiene-intakes/${submitted.body.case.caseId}/claim?office=valley`,
      {}
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  } finally {
    await close();
  }
});

test('office: reaches the full TC surface', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'office', db: dbWithJoins() });
  try {
    for (const p of TC_FULL_READS) {
      assert.equal((await api(baseUrl, 'GET', p)).status, 200, `office should reach ${p}`);
    }
  } finally {
    await close();
  }
});

test('a super_admin with a hygiene tenant role still reaches the full TC surface', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', superAdmin: true, db: dbWithJoins() });
  try {
    for (const p of TC_FULL_READS) {
      assert.equal((await api(baseUrl, 'GET', p)).status, 200, `super_admin should reach ${p}`);
    }
  } finally {
    await close();
  }
});

test('the module gate still runs FIRST: an unentitled tenant is refused before the role is consulted', async () => {
  // Ordering matters for the error the user sees: a voice-only practice should
  // learn "you do not have TC", not "you lack tc.full".
  const { baseUrl, close } = await bootTcApp({ role: 'admin', modules: ['voice'] });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/cases?office=valley');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await close();
  }
});

test('hygiene on a voice-only tenant is refused by the module gate, not the role gate', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', modules: ['voice'] });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=valley');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await close();
  }
});
