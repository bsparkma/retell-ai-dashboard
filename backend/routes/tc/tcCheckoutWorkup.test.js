'use strict';

/**
 * CO-1 — the checkout workup checklist (POST /api/tc/checkout/:id/workup).
 *
 *   persistence  each box ticks, reads back from the stored row, unticks; a
 *                re-tick keeps the first mark and writes no second audit row
 *   old records  a handoff stored before CO-1 (no workup column value) reads
 *                as the empty checklist, everywhere the handoff is read
 *   identity     the office is the request's and the record the office holds:
 *                another office's id is a 404 that changes nothing, and a body
 *                naming an office or a patient is a 400
 *   honesty      an answered checkout's checklist is a record (409); a tick
 *                against a revised item is stale and does not count
 *   audit        one UPDATE row per change, `checkout_workup:<section>`, with
 *                the box's prior state as a slug
 *   no OD        this harness has no Open Dental client at all
 *
 * Test patients only (roland 12827, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

// 2026-10-29 10:00 in America/Chicago.
const NOW = new Date('2026-10-29T15:00:00.000Z');
const TODAY = '2026-10-29';

const PROC = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  priority: 'urgent',
  status: 'proposed',
  surfaces: ['O'],
  scheduleNext: true,
  note: '',
};

const EXISTING = {
  procNum: 900001,
  code: 'D2391',
  description: 'Resin, one surface, posterior',
  tooth: '30',
  surface: 'O',
  dateTp: '2026-06-01',
  priorityName: null,
  scheduled: false,
  clinical: null,
  patient: 'ready_to_schedule',
  waitTimeframe: null,
  note: null,
};

const SNAPSHOT = {
  procedures: [PROC, { ...PROC, teeth: [14], code: 'Comp', priority: 'preventative' }],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: false,
  frontDeskNote: '',
  financialNote: '',
  existingTx: [EXISTING],
  collectAtCheckout: ['Fl2'],
};

function switchCheckout(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

/** A handoff row as item 49 stored it — with NO workup value, like every pre-CO-1 row. */
function seed(db, over = {}) {
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

const tick = (baseUrl, id, body, office = 'roland') =>
  api(baseUrl, 'POST', `/api/tc/checkout/${id}/workup?office=${office}`, body);

const workupAudits = (db) => auditRows(db).filter((a) => String(a.source_ref || '').startsWith('checkout_workup'));

test('old records: a handoff with no workup value reads as the empty checklist (GET /:id and the list)', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  assert.equal('workup' in row, false, 'seeded exactly as a pre-CO-1 row');

  const one = await api(baseUrl, 'GET', `/api/tc/checkout/${row.handoff_id}?office=roland`);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(one.body.handoff.workup, { workedUp: {}, present: {}, collected: null, referrals: null });
  assert.equal(contract.TcCheckoutHandoff.safeParse(one.body.handoff).success, true);

  const list = await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.deepEqual(list.body.handoffs[0].workup, { workedUp: {}, present: {}, collected: null, referrals: null });

  // The contract's progress count over an untouched record.
  const progress = contract.checkoutWorkupProgress(one.body.handoff);
  assert.deepEqual([progress.done, progress.total], [0, 4]);
});

test('persistence: each box ticks and reads back from the STORED row; untick clears it', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  const id = row.handoff_id;

  for (const body of [
    { section: 'workup', index: 0, done: true },
    { section: 'workup', index: 1, done: true },
    { section: 'present', group: 'ready_to_schedule', done: true },
    { section: 'collect', done: true },
    { section: 'referrals', done: true },
  ]) {
    const r = await tick(baseUrl, id, body);
    assert.equal(r.status, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.unchanged, false);
  }

  // What the database holds, not what the route answered.
  const stored = JSON.parse(db.table('tc_checkout_handoffs')[0].workup);
  assert.equal(stored.workedUp['0'].by, 'tc@carein.ai');
  assert.equal(stored.workedUp['0'].at, NOW.toISOString());
  assert.equal(stored.workedUp['0'].key, contract.checkoutItemKey(PROC));
  assert.ok(stored.present.ready_to_schedule);
  assert.ok(stored.collected);
  assert.ok(stored.referrals);

  const fresh = await api(baseUrl, 'GET', `/api/tc/checkout/${id}?office=roland`);
  const progress = contract.checkoutWorkupProgress(fresh.body.handoff);
  assert.deepEqual([progress.done, progress.total], [4, 4]);
  assert.equal(contract.checkoutWorkupProgressLabel(progress), '4 of 4 sections done');

  const off = await tick(baseUrl, id, { section: 'workup', index: 1, done: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.handoff.workup.workedUp['1'], undefined);
  assert.deepEqual(
    contract.checkoutWorkupProgress(off.body.handoff).sections.map((s) => [s.section, s.done]),
    [['workup', false], ['present', true], ['collect', true], ['referrals', true]]
  );
});

test('audit: one UPDATE row per change with the prior state; a repeat tick keeps the first mark and audits nothing', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const id = seed(db).handoff_id;

  assert.equal((await tick(baseUrl, id, { section: 'collect', done: true })).status, 200);
  checkoutRoute.setClockForTests(() => new Date(NOW.getTime() + 60000));
  const again = await tick(baseUrl, id, { section: 'collect', done: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
  assert.equal(again.body.handoff.workup.collected.at, NOW.toISOString(), 'the first mark stands');
  assert.equal((await tick(baseUrl, id, { section: 'collect', done: false })).status, 200);

  const rows = workupAudits(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((a) => [a.action, a.resource_type, a.resource_id, a.source_ref, a.prior_state]),
    [
      ['UPDATE', 'tc_checkout_handoff', id, 'checkout_workup:collect', 'not_done'],
      ['UPDATE', 'tc_checkout_handoff', id, 'checkout_workup:collect', 'done'],
    ]
  );
});

test('office isolation: another office cannot read or tick this record, and nothing changes', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const roland = seed(db);
  const valley = seed(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });

  const cross = await tick(baseUrl, roland.handoff_id, { section: 'referrals', done: true }, 'valley');
  assert.equal(cross.status, 404);
  assert.equal(cross.body.code, 'NOT_FOUND');
  assert.equal(roland.workup, undefined, "roland's row untouched");
  assert.equal(valley.workup, undefined, "valley's row untouched");
  assert.equal(workupAudits(db).length, 0);

  // Its own office's id works, and only that row changes.
  assert.equal((await tick(baseUrl, valley.handoff_id, { section: 'referrals', done: true }, 'valley')).status, 200);
  assert.ok(valley.workup);
  assert.equal(roland.workup, undefined);
});

test('identity: the body names a box, never an office, a patient or a person', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const id = seed(db).handoff_id;
  for (const body of [
    { section: 'referrals', done: true, office: 'valley' },
    { section: 'referrals', done: true, odPatientId: 7115 },
    { section: 'referrals', done: true, by: 'someone.else@carein.ai' },
    { section: 'nope', done: true },
    { section: 'workup', done: true },
  ]) {
    const r = await tick(baseUrl, id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(db.table('tc_checkout_handoffs')[0].workup, undefined);
});

test('a box this snapshot does not have is a named 404, and stores nothing', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const bare = seed(db, { payload: { ...SNAPSHOT, existingTx: undefined, collectAtCheckout: undefined } }).handoff_id;
  assert.equal((await tick(baseUrl, bare, { section: 'workup', index: 5, done: true })).body.code, 'ITEM_NOT_FOUND');
  assert.equal((await tick(baseUrl, bare, { section: 'present', group: 'declined', done: true })).body.code, 'GROUP_NOT_FOUND');
  assert.equal((await tick(baseUrl, bare, { section: 'collect', done: true })).body.code, 'NOTHING_TO_COLLECT');
  // A group key that is not a group at all cannot reach the object either.
  assert.equal((await tick(baseUrl, bare, { section: 'present', group: '__proto__', done: true })).status, 404);
  assert.equal(db.table('tc_checkout_handoffs')[0].workup, undefined);
});

test('an answered checkout is a record: its checklist cannot change (409)', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const id = seed(db, { status: 'nothing_needed', outcome_by: 'tc@carein.ai', outcome_at: NOW }).handoff_id;
  const r = await tick(baseUrl, id, { section: 'referrals', done: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CHECKOUT_NOT_ACTIONABLE');
  assert.equal(workupAudits(db).length, 0);
});

test('a tick against an item the hygienist later revised is STALE and does not count', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  assert.equal((await tick(baseUrl, row.handoff_id, { section: 'workup', index: 0, done: true })).status, 200);
  assert.equal((await tick(baseUrl, row.handoff_id, { section: 'workup', index: 1, done: true })).status, 200);
  // The visit Send revises item 0 (a different tooth).
  row.payload = { ...SNAPSHOT, procedures: [{ ...PROC, teeth: [4] }, SNAPSHOT.procedures[1]] };
  const fresh = (await api(baseUrl, 'GET', `/api/tc/checkout/${row.handoff_id}?office=roland`)).body.handoff;
  assert.equal(contract.checkoutWorkupProgress(fresh).sections[0].done, false, 'stale tick on item 0');
  // Ticking it again records a CURRENT mark.
  const r = await tick(baseUrl, row.handoff_id, { section: 'workup', index: 0, done: true });
  assert.equal(r.body.unchanged, false);
  assert.equal(contract.checkoutWorkupProgress(r.body.handoff).sections[0].done, true);
});

test('switched off for the office: 403 CHECKOUT_DISABLED, nothing stored', async (t) => {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async () => null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
  const { baseUrl, db } = await boot(t);
  const id = seed(db).handoff_id;
  const r = await tick(baseUrl, id, { section: 'referrals', done: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'CHECKOUT_DISABLED');
  assert.equal(db.table('tc_checkout_handoffs')[0].workup, undefined);
});

test('the payload stays additive: a pre-CO-1 snapshot and handoff parse, and dx is optional', () => {
  const procOld = { ...PROC };
  assert.equal(contract.TcCheckoutProcedure.safeParse(procOld).success, true);
  assert.equal(contract.TcCheckoutProcedure.safeParse({ ...PROC, dx: ['D', 'RD'], dxNote: 'mesial' }).success, true);
  assert.equal(contract.TcCheckoutProcedure.safeParse({ ...PROC, dx: ['not a code!'] }).success, false);
  const { existingTx, collectAtCheckout, ...older } = SNAPSHOT;
  void existingTx;
  void collectAtCheckout;
  assert.equal(contract.TcCheckoutSnapshot.safeParse(older).success, true);
});
