'use strict';

/**
 * AT-0: the patient paper trail stops losing data — the route side.
 *
 *  1. PUT /api/tc/cases/:id that CHANGES notes also appends a notes_updated
 *     tc_case_events row (full new text in detail, the acting user as actor),
 *     in the same transaction as the overwrite. No change → no row. The
 *     client-loggable events endpoint cannot forge one.
 *  3. Every tc_preauth_cases mutation — create, PUT, status, start-case's link,
 *     DELETE — appends one tc_preauth_events row in its own transaction, with
 *     prior values for what changed. A failed history write rolls the
 *     mutation back (the route answers 500 and never COMMITs).
 *
 * "Same transaction" is proven on the fake by the statement log: the mutation
 * and its history INSERT sit between one BEGIN and its COMMIT, and a history
 * INSERT that throws ends in ROLLBACK with no COMMIT. Real CHECKs, the
 * append-only grants and the migration's down/up are proven against Postgres
 * by scripts/at0-note-history-verify-queries.js.
 *
 * Synthetic data only: roland 12827 "Test 2, Stedi" is the fixture patient.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api } = require('./tcTestUtils');
const contract = require('../../tc/contract.gen.cjs');

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const ACTOR = 'tc@carein.ai';
const CASES = (p = '', office = 'roland') => `/api/tc/cases${p}?office=${office}`;
const PA = (p = '', office = 'roland') => `/api/tc/preauth${p}?office=${office}`;

const NEW_CASE = {
  patientName: 'Test 2, Stedi',
  category: 'single_tooth',
  status: 'pending_tc',
  urgency: 'medium',
  caseValueCents: 120000,
};

async function createCase(baseUrl) {
  const r = await api(baseUrl, 'POST', CASES(), NEW_CASE);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.case;
}

/** The log slice of the LAST transaction that contains a statement matching `re`. */
function txContaining(db, re) {
  const log = db.log.map((l) => l.sql);
  const hit = log.map((s, i) => (re.test(s) ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(hit !== undefined, `no statement matched ${re}`);
  let begin = hit;
  while (begin >= 0 && log[begin] !== 'BEGIN') begin -= 1;
  let end = hit;
  while (end < log.length && log[end] !== 'COMMIT' && log[end] !== 'ROLLBACK') end += 1;
  assert.ok(begin >= 0, 'the statement ran inside a transaction');
  return log.slice(begin, end + 1);
}

// ── 1. Case notes revisions ─────────────────────────────────────────────────

test('notes PUT that changes the text writes one notes_updated row: full text, actor, same transaction', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const text = 'Patient wants to phase the treatment.\nSecond line, kept whole.';

  const r = await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.case.notes, text, 'the column is still the current value');

  const rows = db.table('tc_case_events').filter((e) => e.case_id === c.caseId && e.type === 'notes_updated');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, ACTOR);
  assert.equal(rows[0].office_id, 'roland', 'office from ?office=, server-derived');
  assert.deepEqual(rows[0].detail, { notes: text }, 'the FULL new text, not a diff');
  assert.equal(rows[0].description, 'Case notes edited');

  // The response's timeline carries it, through the contract.
  const ev = r.body.case.events.find((e) => e.type === 'notes_updated');
  assert.ok(ev);
  assert.deepEqual(contract.TcCaseEvent.parse(ev).detail, { notes: text });

  const tx = txContaining(db, /^INSERT INTO tc_case_events/);
  assert.ok(tx.some((s) => /^UPDATE tc_cases SET notes = /.test(s)), 'the overwrite and its history row share a transaction');
  assert.equal(tx[tx.length - 1], 'COMMIT');
});

test('each save is its own revision; clearing is recorded; an unchanged save and a non-notes patch write nothing', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const revisions = () => db.table('tc_case_events').filter((e) => e.case_id === c.caseId && e.type === 'notes_updated');

  await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: 'v1' });
  await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: 'v2' });
  assert.deepEqual(revisions().map((e) => e.detail.notes), ['v1', 'v2'], 'v1 survives the overwrite');

  await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: 'v2' });
  assert.equal(revisions().length, 2, 'saving the same text is not a revision');

  await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { urgency: 'high' });
  assert.equal(revisions().length, 2, 'a patch without notes writes no notes row');

  await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: '' });
  const cleared = revisions().pop();
  assert.deepEqual(cleared.detail, { notes: '' });
  assert.equal(cleared.description, 'Case notes cleared');
});

test('a failed revision write rolls the notes overwrite back (500, ROLLBACK, no COMMIT)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  db.onQuery(/^INSERT INTO tc_case_events/, (_text, params) => {
    if (params.includes('notes_updated')) throw new Error('synthetic history failure');
    return { rows: [], rowCount: 1 };
  });
  const r = await api(baseUrl, 'PUT', CASES(`/${c.caseId}`), { notes: 'never half-saved' });
  assert.equal(r.status, 500);
  const tx = txContaining(db, /^UPDATE tc_cases SET notes = /);
  assert.equal(tx[tx.length - 1], 'ROLLBACK');
});

test('a notes PUT on another office\'s case is a 404 and writes no row', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const r = await api(baseUrl, 'PUT', CASES(`/${c.caseId}`, 'valley'), { notes: 'wrong office' });
  assert.equal(r.status, 404);
  assert.equal(db.table('tc_case_events').filter((e) => e.type === 'notes_updated').length, 0);
});

test('notes_updated is server-written only: the client-loggable events endpoint refuses it', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const r = await api(baseUrl, 'POST', CASES(`/${c.caseId}/events`), {
    type: 'notes_updated',
    description: 'forged',
    detail: { notes: 'forged' },
  });
  assert.equal(r.status, 400);
  assert.equal(db.table('tc_case_events').filter((e) => e.type === 'notes_updated').length, 0);
});

// ── 3. Pre-auth history ─────────────────────────────────────────────────────

const PREAUTH = {
  patientName: 'Test 2, Stedi',
  preauthType: 'treatment',
  insuranceCarrier: 'Delta Dental',
  doctorName: 'Avery Roland, DDS',
  phone: '555-0100',
  odPatientId: 12827,
  notes: 'first note',
};

const historyOf = (db, preauthId) =>
  db
    .table('tc_preauth_events')
    .filter((e) => e.preauth_id === preauthId)
    .map((e) => ({ ...e, changes: typeof e.changes === 'string' ? JSON.parse(e.changes) : e.changes }));

async function createPreauth(baseUrl) {
  const r = await api(baseUrl, 'POST', PA(), PREAUTH);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.preauthCase;
}

test('create writes a `created` row in the INSERT\'s transaction: actor, office, every set field from null', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  const [row, ...rest] = historyOf(db, pa.preauthId);
  assert.equal(rest.length, 0);
  assert.equal(row.type, 'created');
  assert.equal(row.actor, ACTOR);
  assert.equal(row.office_id, 'roland');
  assert.deepEqual(row.changes.patientName, { from: null, to: 'Test 2, Stedi' });
  assert.deepEqual(row.changes.status, { from: null, to: 'pending' });
  assert.deepEqual(row.changes.notes, { from: null, to: 'first note' });
  assert.equal(contract.PreauthEventType.parse(row.type), 'created');

  const tx = txContaining(db, /^INSERT INTO tc_preauth_events/);
  assert.ok(tx.some((s) => /^INSERT INTO tc_preauth_cases/.test(s)));
  assert.equal(tx[tx.length - 1], 'COMMIT');
});

test('PUT writes an `updated` row with PRIOR values for exactly the fields that changed', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  const r = await api(baseUrl, 'PUT', PA(`/${pa.preauthId}`), { notes: 'second note', referenceNumber: 'REF-1', phone: '555-0100' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = historyOf(db, pa.preauthId).pop();
  assert.equal(row.type, 'updated');
  assert.equal(row.actor, ACTOR);
  assert.deepEqual(row.changes, {
    notes: { from: 'first note', to: 'second note' },
    referenceNumber: { from: '', to: 'REF-1' },
  }, 'phone was sent unchanged and is not a change');

  const tx = txContaining(db, /^INSERT INTO tc_preauth_events/);
  assert.ok(tx.some((s) => /^UPDATE tc_preauth_cases SET .*notes = /.test(s)));
  assert.equal(tx[tx.length - 1], 'COMMIT');
});

test('status writes a `status_change` row: the status and the date it stamped, from → to', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  // The fake cannot evaluate the CASE expression; answer the UPDATE as Postgres would.
  db.onQuery(/^UPDATE tc_preauth_cases SET status = \$3/, (_text, params) => {
    const row = db.table('tc_preauth_cases').find((x) => x.office_id === params[0] && x.preauth_id === params[1]);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = params[2];
    if (params[3] && row.submitted_date == null) row.submitted_date = '2026-11-10';
    return { rows: [{ preauth_id: row.preauth_id }], rowCount: 1 };
  });
  const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/status`), { status: 'submitted' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = historyOf(db, pa.preauthId).pop();
  assert.equal(row.type, 'status_change');
  assert.deepEqual(row.changes.status, { from: 'pending', to: 'submitted' });
  assert.deepEqual(row.changes.submittedDate, { from: null, to: '2026-11-10' });
  const tx = txContaining(db, /^INSERT INTO tc_preauth_events/);
  assert.ok(tx.some((s) => /^UPDATE tc_preauth_cases SET status = /.test(s)));
});

test('start-case\'s link is an `updated` row (caseId from null) inside the start-case transaction', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const pa = await createPreauth(baseUrl);
  const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = historyOf(db, pa.preauthId).pop();
  assert.equal(row.type, 'updated');
  assert.deepEqual(row.changes, { caseId: { from: null, to: r.body.caseId } });
  const tx = txContaining(db, /^INSERT INTO tc_preauth_events/);
  assert.ok(tx.some((s) => /^UPDATE tc_preauth_cases SET case_id = \$3/.test(s)));
  assert.equal(tx[tx.length - 1], 'COMMIT');
});

test('DELETE is logged: a `deleted` row holding every prior value, in the DELETE\'s transaction; the row outlives the pre-auth', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  const r = await api(baseUrl, 'DELETE', PA(`/${pa.preauthId}`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.table('tc_preauth_cases').filter((x) => x.preauth_id === pa.preauthId).length, 0, 'the pre-auth is gone');

  const row = historyOf(db, pa.preauthId).pop();
  assert.equal(row.type, 'deleted');
  assert.equal(row.actor, ACTOR);
  assert.deepEqual(row.changes.patientName, { from: 'Test 2, Stedi', to: null });
  assert.deepEqual(row.changes.notes, { from: 'first note', to: null });
  assert.deepEqual(row.changes.insuranceCarrier, { from: 'Delta Dental', to: null });
  assert.deepEqual(row.changes.status, { from: 'pending', to: null });

  const tx = txContaining(db, /^INSERT INTO tc_preauth_events/);
  assert.ok(tx.some((s) => /^DELETE FROM tc_preauth_cases/.test(s)));
  assert.equal(tx[tx.length - 1], 'COMMIT');
});

test('DELETE of an unknown or other-office pre-auth is a 404 and logs nothing', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  assert.equal((await api(baseUrl, 'DELETE', PA(`/${randomUUID()}`))).status, 404);
  assert.equal((await api(baseUrl, 'DELETE', PA(`/${pa.preauthId}`, 'valley'))).status, 404);
  assert.deepEqual(historyOf(db, pa.preauthId).map((e) => e.type), ['created']);
});

test('a failed history write rolls each pre-auth mutation back (500, ROLLBACK)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  db.onQuery(/^INSERT INTO tc_preauth_events/, () => {
    throw new Error('synthetic history failure');
  });
  for (const [method, path, body, mutation] of [
    ['PUT', PA(`/${pa.preauthId}`), { notes: 'x' }, /^UPDATE tc_preauth_cases SET notes = /],
    ['DELETE', PA(`/${pa.preauthId}`), undefined, /^DELETE FROM tc_preauth_cases/],
  ]) {
    const r = await api(baseUrl, method, path, body);
    assert.equal(r.status, 500, `${method}: ${JSON.stringify(r.body)}`);
    const tx = txContaining(db, mutation);
    assert.equal(tx[tx.length - 1], 'ROLLBACK', `${method} rolled back`);
  }
});
