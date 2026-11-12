'use strict';

/**
 * CO-7 — the ask-hygiene thread, TC side (/api/tc/checkout/:id/questions).
 *
 *   ask       a TC question is stored with the CARD's office and id, the SSO
 *             author and role 'tc' — never the body's; the answer is the thread
 *             read back; a body naming a role, an author or an office is a 400
 *   scope     a thread is (office, handoff): another card's and another office's
 *             questions never appear; another office's card is a 404 that
 *             writes nothing
 *   counts    GET /checkout lists each waiting card's OPEN question count
 *             (`openQuestions`) — a reply does not count, a resolved one does not
 *   resolve   resolves every open TC question once (a second resolve is a no-op
 *             with no audit row); replies are never "resolved"
 *   audit     READ on the thread, CREATE per question, UPDATE on a resolve
 *
 * Test patients only; names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-11-11T16:00:00.000Z');
const TODAY = '2026-11-11';

const SNAPSHOT = {
  procedures: [],
  priority: null,
  nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: '' },
  notesPending: false,
  frontDeskNote: '',
  financialNote: '',
};

async function boot(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  const app = await bootTcApp();
  t.after(async () => {
    await app.close();
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
  return app;
}

function seedCard(db, over = {}) {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:${randomUUID()}:checkout`,
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    provider: 'DOC1',
    provider_seen: 'HYG1',
    operatory: 'Hyg 1',
    visit_date: TODAY,
    payload: SNAPSHOT,
    is_final: true,
    revision: 1,
    submitted_by: 'hygienist@carein.ai',
    updated_by: 'hygienist@carein.ai',
    status: 'open',
    created_at: new Date(NOW.getTime() - 60000),
    updated_at: new Date(NOW.getTime() - 60000),
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

const ask = (baseUrl, id, body, office = 'roland') =>
  api(baseUrl, 'POST', `/api/tc/checkout/${id}/questions?office=${office}`, body);
const thread = (baseUrl, id, office = 'roland') => api(baseUrl, 'GET', `/api/tc/checkout/${id}/questions?office=${office}`);
const resolve = (baseUrl, id, office = 'roland') =>
  api(baseUrl, 'POST', `/api/tc/checkout/${id}/questions/resolve?office=${office}`, {});

test("a question is stored with the card's office and id, the SSO author and role 'tc'; the answer is the read-back", async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  const res = await ask(app.baseUrl, c.handoff_id, { body: '  Did they want the crown done before the holidays?  ' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [row] = app.db.table('tc_checkout_questions');
  assert.equal(row.office_id, 'roland');
  assert.equal(row.handoff_id, c.handoff_id);
  assert.equal(row.author_email, 'tc@carein.ai');
  assert.equal(row.author_role, 'tc');
  assert.equal(row.body, 'Did they want the crown done before the holidays?');
  assert.equal(row.resolved_at ?? null, null); // the column default; this harness leaves it unset
  assert.equal(res.body.thread.open, 1);
  assert.equal(res.body.thread.messages[0].questionId, row.question_id);
  assert.ok(
    auditRows(app.db).some((r) => r.resource_type === 'tc_checkout_question' && r.action === 'CREATE' && r.resource_id === row.question_id)
  );
});

test('the body cannot set the role, the author or the office; an empty or oversized question is refused', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  for (const body of [
    { body: 'x', authorRole: 'hygienist' },
    { body: 'x', authorEmail: 'someone@else' },
    { body: 'x', office: 'valley' },
    { body: '   ' },
    { body: 'x'.repeat(2001) },
    {},
  ]) {
    assert.equal((await ask(app.baseUrl, c.handoff_id, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(app.db.table('tc_checkout_questions').length, 0);
});

test("scope: a thread is one card in one office — another office's card is a 404 that writes nothing", async (t) => {
  const app = await boot(t);
  const mine = seedCard(app.db);
  const other = seedCard(app.db, { od_patient_id: 12828, patient_name: 'Test, MangoTest' });
  const valley = seedCard(app.db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });
  await ask(app.baseUrl, mine.handoff_id, { body: 'Mine' });
  await ask(app.baseUrl, other.handoff_id, { body: 'Other card' });
  await ask(app.baseUrl, valley.handoff_id, { body: 'Valley card' }, 'valley');

  assert.equal((await ask(app.baseUrl, valley.handoff_id, { body: 'cross' }, 'roland')).status, 404);
  assert.equal((await thread(app.baseUrl, valley.handoff_id, 'roland')).status, 404);
  assert.equal((await resolve(app.baseUrl, valley.handoff_id, 'roland')).status, 404);
  assert.equal(app.db.table('tc_checkout_questions').length, 3);

  const t1 = await thread(app.baseUrl, mine.handoff_id);
  assert.equal(t1.status, 200);
  assert.deepEqual(t1.body.thread.messages.map((m) => m.body), ['Mine']);
  const tv = await thread(app.baseUrl, valley.handoff_id, 'valley');
  assert.deepEqual(tv.body.thread.messages.map((m) => m.body), ['Valley card']);
  assert.ok(auditRows(app.db).some((r) => r.resource_type === 'tc_checkout_question' && r.action === 'READ'));
});

test('the list carries each card\'s OPEN count: replies and resolved questions do not count', async (t) => {
  const app = await boot(t);
  const a = seedCard(app.db);
  const b = seedCard(app.db, { od_patient_id: 12828, patient_name: 'Test, MangoTest' });
  seedCard(app.db, { od_patient_id: 12828, office_id: 'roland', status: 'open', patient_name: 'Test, MangoTest' });
  await ask(app.baseUrl, a.handoff_id, { body: 'Q1' });
  await ask(app.baseUrl, a.handoff_id, { body: 'Q2' });
  await ask(app.baseUrl, b.handoff_id, { body: 'Q3' });
  // A hygienist reply on a — written as the hygiene app writes it.
  app.db.table('tc_checkout_questions').push({
    question_id: randomUUID(),
    office_id: 'roland',
    handoff_id: a.handoff_id,
    author_email: 'hygienist@carein.ai',
    author_role: 'hygienist',
    body: 'Yes, before the holidays',
    created_at: new Date(NOW.getTime() + 1000),
    resolved_at: null,
  });

  let list = await api(app.baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.openQuestions, { [a.handoff_id]: 2, [b.handoff_id]: 1 });

  await resolve(app.baseUrl, b.handoff_id);
  list = await api(app.baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.deepEqual(list.body.openQuestions, { [a.handoff_id]: 2 });
});

test('resolve: every open TC question once; replies untouched; a second resolve is a no-op with no audit row', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  await ask(app.baseUrl, c.handoff_id, { body: 'Q1' });
  await ask(app.baseUrl, c.handoff_id, { body: 'Q2' });
  const reply = {
    question_id: randomUUID(),
    office_id: 'roland',
    handoff_id: c.handoff_id,
    author_email: 'hygienist@carein.ai',
    author_role: 'hygienist',
    body: 'Answer',
    created_at: new Date(NOW.getTime() + 1000),
    resolved_at: null,
  };
  app.db.table('tc_checkout_questions').push(reply);

  const first = await resolve(app.baseUrl, c.handoff_id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.resolved, 2);
  assert.equal(first.body.thread.open, 0);
  const tcRows = app.db.table('tc_checkout_questions').filter((r) => r.author_role === 'tc');
  assert.ok(tcRows.every((r) => r.resolved_at === NOW.toISOString()));
  assert.equal(reply.resolved_at, null, 'a reply is never resolved');
  const updates = () => auditRows(app.db).filter((r) => r.resource_type === 'tc_checkout_question' && r.action === 'UPDATE');
  assert.equal(updates().length, 1);

  const second = await resolve(app.baseUrl, c.handoff_id);
  assert.equal(second.status, 200);
  assert.equal(second.body.resolved, 0);
  assert.equal(updates().length, 1);
});

test('checkout switched off for the office: the thread routes answer CHECKOUT_DISABLED', async (t) => {
  const app = await boot(t);
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: false, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  const c = seedCard(app.db);
  const res = await ask(app.baseUrl, c.handoff_id, { body: 'Q' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CHECKOUT_DISABLED');
  assert.equal(app.db.table('tc_checkout_questions').length, 0);
});
