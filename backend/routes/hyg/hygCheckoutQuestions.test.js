'use strict';

/**
 * CO-7 — the ask-hygiene thread, hygiene side.
 *
 *   badges   GET /api/hyg/day/checkout-questions answers per AptNum: the open
 *            and total counts on that visit's checkout card — found by the
 *            visit's source key, or by the schedule card's origin AptNum — and
 *            nothing else (no PatNum, no name, no text). Another office's
 *            visits and cards never count. Checkout off → enabled: false.
 *   thread   GET /api/hyg/visit/:aptNum/checkout-questions is the card's thread,
 *            audited; a visit with no card is a 404.
 *   reply    POST …/reply stores a 'hygienist' row with the card's office and
 *            id and the SSO author; the body cannot set any of them; a reply
 *            needs an open question (409 otherwise); it never resolves one.
 *   no OD    the fake Open Dental client is never called.
 *
 * Test patients only; names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const { bootHygApp, api, FakeOd } = require('./hygTestUtils');
const { FakeTenantDb } = require('../tc/tcTestUtils');

const DATE = '2026-11-11';

function switchCheckout(t, byOffice = { roland: true, valley: true }) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
}

async function boot(t, opts = {}) {
  const db = new FakeTenantDb();
  const od = new FakeOd();
  const app = await bootHygApp({ db, od, hygOffices: ['roland', 'valley'], ...opts });
  t.after(() => app.close());
  return { ...app, db, od };
}

/** A hyg visit and its checkout card, as the visit Send stores them. */
function seedVisitCard(db, { office = 'roland', aptNum, patNum = 12827, date = DATE } = {}) {
  const visitId = randomUUID();
  db.table('hyg_visit').push({ visit_id: visitId, office, apt_num: aptNum });
  const handoffId = randomUUID();
  db.table('tc_checkout_handoffs').push({
    handoff_id: handoffId,
    office_id: office,
    source_key: `hyg-visit:${visitId}:checkout`,
    od_patient_id: patNum,
    visit_date: date,
    origin_apt_num: null,
    status: 'open',
  });
  return handoffId;
}

function seedQuestion(db, handoffId, over = {}) {
  const row = {
    question_id: randomUUID(),
    office_id: 'roland',
    handoff_id: handoffId,
    author_email: 'tc@carein.ai',
    author_role: 'tc',
    body: 'Did they want afternoons?',
    created_at: new Date(Date.now() - 60000),
    resolved_at: null,
    ...over,
  };
  db.table('tc_checkout_questions').push(row);
  return row;
}

const badges = (app, office, apts) =>
  api(app.baseUrl, 'GET', `/api/hyg/day/checkout-questions?office=${office}&date=${DATE}&apt=${apts.join(',')}`);

test('badges: open/total per AptNum, found by the visit key or the schedule origin; counts only', async (t) => {
  switchCheckout(t);
  const app = await boot(t);
  const a = seedVisitCard(app.db, { aptNum: 900001 });
  seedQuestion(app.db, a);
  seedQuestion(app.db, a, { body: 'Second' });
  seedQuestion(app.db, a, { author_role: 'hygienist', author_email: 'hygienist@carein.ai', body: 'Reply' });
  seedVisitCard(app.db, { aptNum: 900002 }); // a card with no thread: no badge
  // A schedule card (CO-5b): no hyg visit, made from AptNum 900003.
  const s = randomUUID();
  app.db.table('tc_checkout_handoffs').push({
    handoff_id: s,
    office_id: 'roland',
    source_key: `schedule:${s}`,
    od_patient_id: 12828,
    visit_date: DATE,
    origin_apt_num: 900003,
    status: 'open',
  });
  seedQuestion(app.db, s, { resolved_at: new Date() });

  const res = await badges(app, 'roland', [900001, 900002, 900003]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.enabled, true);
  assert.deepEqual(res.body.badges, [
    { aptNum: 900001, handoffId: a, open: 2, total: 3 },
    { aptNum: 900003, handoffId: s, open: 0, total: 1 },
  ]);
  const text = JSON.stringify(res.body);
  assert.ok(!/12827|12828|afternoons|Reply/.test(text), 'no PatNum, no name, no message text');
  assert.equal(app.od.calls.length, 0, 'no Open Dental read');
  assert.equal(app.od.writes.length, 0, 'no Open Dental write');
});

test("badges never cross offices: valley's visit with the same AptNum, and valley's questions, are not roland's", async (t) => {
  switchCheckout(t);
  const app = await boot(t);
  const v = seedVisitCard(app.db, { office: 'valley', aptNum: 900001, patNum: 7115 });
  seedQuestion(app.db, v, { office_id: 'valley' });
  const r = seedVisitCard(app.db, { office: 'roland', aptNum: 900001 });
  // A row mis-filed under the other office never counts for this card.
  seedQuestion(app.db, r, { office_id: 'valley' });

  const roland = await badges(app, 'roland', [900001]);
  assert.deepEqual(roland.body.badges, []);
  const valley = await badges(app, 'valley', [900001]);
  assert.deepEqual(valley.body.badges, [{ aptNum: 900001, handoffId: v, open: 1, total: 1 }]);
});

test('badges: a card from another day is not this day\'s; bad input is a 400; checkout off → enabled false', async (t) => {
  switchCheckout(t, { roland: false, valley: true });
  const app = await boot(t);
  const old = seedVisitCard(app.db, { office: 'valley', aptNum: 900005, date: '2026-11-10' });
  seedQuestion(app.db, old, { office_id: 'valley' });
  assert.deepEqual((await badges(app, 'valley', [900005])).body.badges, []);
  assert.equal((await api(app.baseUrl, 'GET', `/api/hyg/day/checkout-questions?office=valley&apt=1`)).status, 400);
  assert.equal((await api(app.baseUrl, 'GET', `/api/hyg/day/checkout-questions?office=valley&date=${DATE}&apt=x`)).status, 400);
  const off = await badges(app, 'roland', [900001]);
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.deepEqual(off.body.badges, []);
});

test('thread: the visit card\'s messages, oldest first, audited; no card → 404', async (t) => {
  switchCheckout(t);
  const app = await boot(t);
  const a = seedVisitCard(app.db, { aptNum: 900001 });
  seedQuestion(app.db, a, { body: 'First', created_at: new Date(Date.now() - 120000) });
  seedQuestion(app.db, a, { body: 'Second', created_at: new Date(Date.now() - 60000) });
  const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/checkout-questions?office=roland');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.thread.messages.map((m) => m.body), ['First', 'Second']);
  assert.equal(res.body.thread.open, 2);
  assert.ok(app.db.table('audit_log').some((r) => r.resource_type === 'tc_checkout_question' && r.action === 'READ'));
  assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900009/checkout-questions?office=roland')).status, 404);
});

test("reply: a 'hygienist' row on the card, SSO author; needs an open question; never resolves one", async (t) => {
  switchCheckout(t);
  const app = await boot(t);
  const a = seedVisitCard(app.db, { aptNum: 900001 });
  const reply = (body) => api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout-questions/reply?office=roland', { body });

  // No question yet: nothing to answer.
  let res = await reply({ body: 'Unasked' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_OPEN_QUESTION');

  const q = seedQuestion(app.db, a);
  for (const bad of [{ body: '' }, { body: 'x', authorRole: 'tc' }, { body: 'x', office: 'valley' }]) {
    assert.equal((await reply(bad)).status, 400, JSON.stringify(bad));
  }
  res = await reply({ body: 'Yes — afternoons' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = app.db.table('tc_checkout_questions').find((r) => r.author_role === 'hygienist');
  assert.equal(row.office_id, 'roland');
  assert.equal(row.handoff_id, a);
  assert.equal(row.author_email, 'hygienist@carein.ai');
  assert.equal(row.body, 'Yes — afternoons');
  assert.equal(q.resolved_at, null, 'a reply answers; the front desk resolves');
  assert.equal(res.body.thread.open, 1);
  assert.equal(res.body.thread.messages.length, 2);
  assert.ok(app.db.table('audit_log').some((r) => r.resource_type === 'tc_checkout_question' && r.action === 'CREATE'));
});

test("reply in roland cannot reach valley's card for the same AptNum", async (t) => {
  switchCheckout(t);
  const app = await boot(t);
  const v = seedVisitCard(app.db, { office: 'valley', aptNum: 900001, patNum: 7115 });
  seedQuestion(app.db, v, { office_id: 'valley' });
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout-questions/reply?office=roland', { body: { body: 'cross' } });
  assert.equal(res.status, 404);
  assert.equal(app.db.table('tc_checkout_questions').length, 1);
});
