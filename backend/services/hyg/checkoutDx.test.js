'use strict';

/**
 * CO-1 — the routing slip's diagnosis reaches the front desk's workup view.
 *
 * The checkout alert used to drop an item's `dx` and `dxNote` on the floor, so
 * "today's diagnosed treatment" could show a code and a tooth but not WHY. It
 * now carries both, ADDITIVELY: an item with no diagnosis sends no key at all,
 * so a visit without one sends exactly the snapshot it always did, and TC's
 * strict submit schema takes either.
 *
 * Synthetic data only (roland 12827).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const tcHandoff = require('./tcHandoffClient');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');

const SNAP = { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' };

function item(over = {}) {
  return {
    id: 'item-1',
    teeth: [30],
    code: 'Crown',
    category: 'Restorative',
    surfaces: [],
    dx: [],
    priority: 'urgent',
    motivation: [],
    status: 'proposed',
    scheduleNext: false,
    photos: [],
    createdBy: 'hygienist@carein.ai',
    createdAt: '2026-10-29T13:00:00.000Z',
    ...over,
  };
}

function build(items) {
  return tcHandoff.buildCheckoutIntake({
    visit: {
      visitId: 'visit-0001',
      office: 'roland',
      aptNum: 900001,
      patNum: 12827,
      visitDate: '2026-10-29',
      slip: contract.emptySlip(),
      items,
      stagedWrites: [],
    },
    snapshot: SNAP,
    date: '2026-10-29',
    final: false,
    existingTx: { status: 'loaded', items: [] },
  });
}

test('an item\'s dx codes and dx note ride on the checkout procedure, verbatim', () => {
  const built = build([item({ dx: ['D', 'RD'], dxNote: 'Under the old filling' })]);
  assert.equal(built.ok, true);
  const p = built.body.snapshot.procedures[0];
  assert.deepEqual(p.dx, ['D', 'RD']);
  assert.equal(p.dxNote, 'Under the old filling');
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);
});

test('no diagnosis sends no key: the body an older visit sent', () => {
  const built = build([item()]);
  const p = built.body.snapshot.procedures[0];
  assert.equal('dx' in p, false);
  assert.equal('dxNote' in p, false);
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);
});

test('only code-shaped dx values travel; the count is capped', () => {
  const built = build([item({ dx: ['D', 'not a code', 'FX', ...Array(30).fill('E')] })]);
  const p = built.body.snapshot.procedures[0];
  assert.deepEqual(p.dx.slice(0, 2), ['D', 'FX']);
  assert.equal(p.dx.length, 20);
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);
});
