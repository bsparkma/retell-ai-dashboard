'use strict';

/**
 * /api/tc/library — per-office config sections: schema-validated upserts,
 * unknown-section rejection, office divergence.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const CROWN_PRICING = {
  economyCents: 89900,
  standardCents: 129900,
  premiumCents: 179900,
  implantCents: 450000,
};

test('upsert round-trip: PUT validates, persists, and replaces per office', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const put = await api(baseUrl, 'PUT', '/api/tc/library/crown_pricing?office=roland', CROWN_PRICING);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.value, CROWN_PRICING);

    const get = await api(baseUrl, 'GET', '/api/tc/library/crown_pricing?office=roland');
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.value, CROWN_PRICING);

    // Replace (upsert path) — still exactly one row for (roland, crown_pricing).
    const replaced = await api(baseUrl, 'PUT', '/api/tc/library/crown_pricing?office=roland', {
      ...CROWN_PRICING,
      economyCents: 99900,
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.value.economyCents, 99900);
    assert.equal(db.table('tc_library_config').length, 1);

    // Offices diverge: valley is untouched.
    const valley = await api(baseUrl, 'GET', '/api/tc/library/crown_pricing?office=valley');
    assert.equal(valley.status, 404);

    const all = await api(baseUrl, 'GET', '/api/tc/library?office=roland');
    assert.deepEqual(Object.keys(all.body.library), ['crown_pricing']);

    assert.ok(auditRows(db).some((r) => r.resource_type === 'tc_library_config' && r.action === 'UPDATE'));
  } finally {
    await close();
  }
});

test('unknown sections and invalid shapes are rejected, nothing written', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const unknown = await api(baseUrl, 'PUT', '/api/tc/library/practice_settings?office=roland', {});
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'UNKNOWN_SECTION');

    // Float dollars in a cents field — the money rule holds for config too.
    const floatMoney = await api(baseUrl, 'PUT', '/api/tc/library/crown_pricing?office=roland', {
      ...CROWN_PRICING,
      economyCents: 899.5,
    });
    assert.equal(floatMoney.status, 400);
    assert.equal(floatMoney.body.code, 'VALIDATION_FAILED');

    // financing_settings absorbs the legacy localStorage shape — validated.
    const badFinancing = await api(baseUrl, 'PUT', '/api/tc/library/financing_settings?office=roland', {
      enabledProviders: { cherry: true },
      serviceFeeEnabled: false,
      serviceFeePercent: 20, // cap is 15
      providerOverrides: {},
    });
    assert.equal(badFinancing.status, 400);

    assert.equal(db.table('tc_library_config').length, 0);
  } finally {
    await close();
  }
});
