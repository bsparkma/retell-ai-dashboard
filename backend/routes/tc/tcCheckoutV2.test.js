'use strict';

/**
 * TC's side of checkout v2: the collect-at-checkout list and the records ride
 * the checkout snapshot, and the collect list rides the hygiene intake.
 *
 * ADDITIVE AND OPTIONAL, like existingTx before them: a payload that sends none
 * stores nothing new and reads back exactly as it did.
 *
 * Synthetic: roland 12827 / 12828 are the staging fixtures.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const { bootTcApp, api } = require('./tcTestUtils');

const POST = '/api/tc/hygiene-intakes?office=roland';

const INTAKE = {
  patientName: 'Test, MangoTest',
  odPatientId: 12828,
  diagnosingProvider: 'DOC1',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: false,
  patientInterestLevel: 'unknown',
  flagUrgent: false,
};

const SNAPSHOT = {
  procedures: [],
  priority: null,
  nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: '' },
  notesPending: true,
  frontDeskNote: '',
  financialNote: '',
};

function checkoutBody(snapshot) {
  return {
    kind: 'checkout',
    sourceKey: 'hyg-visit:visit-0002:checkout',
    final: false,
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    provider: 'DOC1',
    providerSeen: 'HYG1',
    operatory: 'Hyg 1',
    visitDate: '2026-09-08',
    snapshot,
  };
}

function checkoutOn(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
}

test('an intake with nothing to collect stores NULL; one with a list stores and reads it back', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const none = await api(baseUrl, 'POST', POST, INTAKE);
    assert.equal(none.status, 201, JSON.stringify(none.body));
    assert.equal(none.body.case.hygieneIntake.collectAtCheckout, null);
    assert.equal(db.table('tc_hygiene_intakes')[0].collect_at_checkout, null);

    const some = await api(baseUrl, 'POST', POST, { ...INTAKE, collectAtCheckout: ['Fl2', 'Mouthwash'] });
    assert.equal(some.status, 201, JSON.stringify(some.body));
    assert.deepEqual(some.body.case.hygieneIntake.collectAtCheckout, ['Fl2', 'Mouthwash']);
  } finally {
    await close();
  }
});

test('an intake with a malformed collect list is refused, not half-stored', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', POST, { ...INTAKE, collectAtCheckout: [''] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(db.table('tc_cases').length, 0);
  } finally {
    await close();
  }
});

test('a checkout snapshot carries the collect list and the records, and an old one still parses', async (t) => {
  checkoutOn(t);
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene' });
  try {
    const old = await api(baseUrl, 'POST', POST, checkoutBody(SNAPSHOT));
    assert.equal(old.status, 201, JSON.stringify(old.body));
    assert.equal(old.body.handoff.snapshot.collectAtCheckout, undefined);
    assert.equal(old.body.handoff.snapshot.records, undefined);

    const v2 = await api(baseUrl, 'POST', POST, {
      ...checkoutBody({
        ...SNAPSHOT,
        collectAtCheckout: ['Sealant', 'Floss picks'],
        records: [{ record: 'Pre-op PA', status: 'needed' }],
      }),
      sourceKey: 'hyg-visit:visit-0003:checkout',
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.deepEqual(v2.body.handoff.snapshot.collectAtCheckout, ['Sealant', 'Floss picks']);
    assert.deepEqual(v2.body.handoff.snapshot.records, [{ record: 'Pre-op PA', status: 'needed' }]);

    const bad = await api(baseUrl, 'POST', POST, {
      ...checkoutBody({ ...SNAPSHOT, records: [{ record: 'Pre-op PA', status: 'maybe' }] }),
      sourceKey: 'hyg-visit:visit-0004:checkout',
    });
    assert.equal(bad.status, 400, 'a record status the slip does not have is refused');
  } finally {
    await close();
  }
});
