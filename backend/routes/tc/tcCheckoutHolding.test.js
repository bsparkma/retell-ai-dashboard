'use strict';

/**
 * "Holding" end to end on the TC side: a checkout alert BUILT by the hygiene
 * module (services/hyg/tcHandoffClient.buildCheckoutIntake) with a holding
 * item is submitted, read back on the checkout card, and turned into a case.
 *
 *   - the card lists the holding procedure as 'holding' (the screens label it
 *     "Holding" and draw it last — new-dashboard/tests/tc-checkout-holding)
 *   - the card's priority and the case's urgency come from the NON-holding
 *     items: urgent + holding → high
 *   - holding only → the same case urgency as a checkout with nothing staged
 *   - the holding item's own plan line is 'elective', never 'medium'
 *
 * Synthetic data only (roland 12827).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const tcHandoff = require('../../services/hyg/tcHandoffClient');
const hygContract = require('../../hyg/contract.gen.cjs');
const { bootTcApp, api } = require('./tcTestUtils');

const NOW = new Date('2026-11-16T15:00:00.000Z');
const SUBMIT = (office) => `/api/tc/hygiene-intakes?office=${office}`;
const LIST = (office) => `/api/tc/checkout?office=${office}&view=waiting`;
const ACT = (office, id, verb) => `/api/tc/checkout/${id}/${verb}?office=${office}`;
const CASE = (office, id) => `/api/tc/cases/${id}?office=${office}`;

function switchCheckout(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

let n = 0;
function item(code, priority, teeth = [30]) {
  n += 1;
  return {
    id: `item-${String(n).padStart(4, '0')}`,
    teeth,
    code,
    category: 'Prosth',
    surfaces: [],
    dx: [],
    priority,
    motivation: [],
    status: 'proposed',
    scheduleNext: false,
    photos: [],
    createdBy: 'hygienist@carein.ai',
    createdAt: '2026-11-16T14:00:00.000Z',
  };
}

function built(items, visitId) {
  const r = tcHandoff.buildCheckoutIntake({
    visit: {
      visitId,
      office: 'roland',
      aptNum: 900001,
      patNum: 12827,
      visitDate: '2026-11-16',
      slip: hygContract.emptySlip(),
      items,
      stagedWrites: [],
    },
    snapshot: { patientName: 'Test 2, Stedi', providerName: 'HYG1', doctorName: 'DOC1', opName: 'Hyg 1' },
    date: '2026-11-16',
    final: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.body;
}

async function submitAndSchedule(t, items, visitId) {
  switchCheckout(t);
  const app = await bootTcApp();
  t.after(() => app.close());
  const sub = await api(app.baseUrl, 'POST', SUBMIT('roland'), built(items, visitId));
  assert.ok(sub.status === 201 || sub.status === 200, JSON.stringify(sub.body));
  const list = await api(app.baseUrl, 'GET', LIST('roland'));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.handoffs.length, 1);
  const card = list.body.handoffs[0];
  const out = await api(app.baseUrl, 'POST', ACT('roland', card.handoffId, 'outcome'), { outcome: 'scheduled' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const got = await api(app.baseUrl, 'GET', CASE('roland', out.body.caseId));
  assert.equal(got.status, 200, JSON.stringify(got.body));
  return { card, kase: got.body.case };
}

test('urgent + holding: the card lists the holding item as holding; the card and the case read URGENT / high', async (t) => {
  const { card, kase } = await submitAndSchedule(t, [item('Bridge', 'holding'), item('Implant', 'urgent')], 'visit-0001');
  assert.deepEqual(card.snapshot.procedures.map((p) => [p.code, p.priority]), [
    ['Bridge', 'holding'],
    ['Implant', 'urgent'],
  ]);
  assert.equal(card.snapshot.priority, 'urgent');
  assert.equal(kase.urgency, 'high');
  const items = [...kase.phases[0].items].sort((a, b) => a.position - b.position);
  assert.deepEqual(items.map((i) => [i.procedureName, i.urgency]), [
    ['Bridge', 'elective'],
    ['Implant', 'high'],
  ]);
});

test('holding only: the card has no priority and the case urgency is what a checkout with nothing staged gets', async (t) => {
  const holdingOnly = await submitAndSchedule(t, [item('Bridge', 'holding')], 'visit-0002');
  assert.equal(holdingOnly.card.snapshot.priority, null);
  assert.equal(holdingOnly.card.snapshot.procedures[0].priority, 'holding');

  await t.test('compared with nothing staged', async (tt) => {
    const none = await submitAndSchedule(tt, [], 'visit-0003');
    assert.equal(none.card.snapshot.priority, null);
    assert.equal(holdingOnly.kase.urgency, none.kase.urgency);
    assert.equal(holdingOnly.kase.urgency, 'medium');
  });
});
