'use strict';

/**
 * fix/status-note-drop: POST /api/tc/cases/:id/status with the case's CURRENT
 * status used to answer { changed:false } and silently discard any note the
 * user typed in the Change-status dialog.
 *
 *  - unchanged status + a note  → one note_added event (description = the
 *    note, actor = the signed-in user), in the same transaction; success with
 *    the aggregate, which carries the event.
 *  - unchanged status + no note → a pure no-op: no event, no write.
 *  - an actual change + a note  → today's exact "A → B: note" status_change.
 *
 * "Same transaction" is proven on the fake by the statement log (BEGIN …
 * INSERT … COMMIT). Synthetic data only: roland 12827 "Test 2, Stedi".
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api } = require('./tcTestUtils');

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

const ACTOR = 'tc@carein.ai';
const CASES = (p = '') => `/api/tc/cases${p}?office=roland`;

async function createCase(baseUrl) {
  const r = await api(baseUrl, 'POST', CASES(), {
    patientName: 'Test 2, Stedi',
    category: 'single_tooth',
    status: 'pending_tc',
    urgency: 'medium',
    caseValueCents: 120000,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.case;
}

const eventsOf = (db, caseId) => db.table('tc_case_events').filter((e) => e.case_id === caseId);

test('unchanged status + a note keeps the note as note_added: text, actor, office, same transaction', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const before = eventsOf(db, c.caseId).length;

  const r = await api(baseUrl, 'POST', CASES(`/${c.caseId}/status`), {
    status: 'pending_tc',
    note: '  Left a voicemail, will try Thursday.  ',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.equal(r.body.changed, false, 'the status did not move');
  assert.equal(r.body.noteAdded, true);
  assert.equal(r.body.case.status, 'pending_tc');

  const added = eventsOf(db, c.caseId).slice(before);
  assert.equal(added.length, 1, 'exactly one event');
  assert.equal(added[0].type, 'note_added', 'an EXISTING type — no new vocabulary');
  assert.equal(added[0].description, 'Left a voicemail, will try Thursday.');
  assert.equal(added[0].actor, ACTOR);
  assert.equal(added[0].office_id, 'roland', 'office server-derived');
  assert.equal(added[0].detail, null);

  // The returned aggregate carries it, so the Activity tab shows it at once.
  assert.ok(r.body.case.events.some((e) => e.type === 'note_added' && e.description === added[0].description));

  // Same transaction as the header read; it committed; the status was not touched.
  const log = db.log.map((l) => l.sql);
  const ins = log.map((s, i) => (/^INSERT INTO tc_case_events/.test(s) ? i : -1)).filter((i) => i >= 0).pop();
  let begin = ins;
  while (begin >= 0 && log[begin] !== 'BEGIN') begin -= 1;
  let end = ins;
  while (end < log.length && log[end] !== 'COMMIT' && log[end] !== 'ROLLBACK') end += 1;
  assert.ok(begin >= 0, 'the insert ran inside a transaction');
  assert.equal(log[end], 'COMMIT');
  const tx = log.slice(begin, end + 1);
  assert.ok(tx.some((s) => /FROM tc_cases/.test(s)), 'the header read shares the transaction');
  assert.ok(!tx.some((s) => /^UPDATE tc_cases/.test(s)), 'no status write');
});

test('unchanged status + no note (or whitespace) stays a pure no-op: no event, no write', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const before = eventsOf(db, c.caseId).length;

  for (const body of [{ status: 'pending_tc' }, { status: 'pending_tc', note: '' }, { status: 'pending_tc', note: '   \n ' }]) {
    const logStart = db.log.length;
    const r = await api(baseUrl, 'POST', CASES(`/${c.caseId}/status`), body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, false);
    assert.equal(r.body.noteAdded, false);
    const writes = db.log.slice(logStart).map((l) => l.sql).filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));
    assert.deepEqual(writes, [], `no write for ${JSON.stringify(body)}`);
  }
  assert.equal(eventsOf(db, c.caseId).length, before);
});

test('an actual status change with a note keeps the existing "A → B: note" format, and adds no note_added', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = await createCase(baseUrl);
  const before = eventsOf(db, c.caseId).length;

  const r = await api(baseUrl, 'POST', CASES(`/${c.caseId}/status`), {
    status: 'presented',
    note: 'Walked through the plan',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, true);
  assert.equal(r.body.noteAdded, false);
  assert.equal(r.body.case.status, 'presented');

  const added = eventsOf(db, c.caseId).slice(before);
  assert.deepEqual(added.map((e) => e.type), ['status_change']);
  assert.equal(added[0].description, 'pending_tc → presented: Walked through the plan');
  assert.equal(added[0].actor, ACTOR);
});
