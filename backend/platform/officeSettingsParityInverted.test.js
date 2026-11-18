'use strict';

/**
 * MT-2b: the office settings parity tripwire, INVERTED. office_setting is the
 * SERVED side; platform_setting (still dual-written) is the rollback copy the
 * tripwire checks against. Same phrase, "office settings parity".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const officeSettings = require('./officeSettings');
const officeRegistry = require('./officeRegistry');
const parity = require('./officeSettingsParity');
const { FakeControlPlane, TENANT_ID } = require('./officeSettingsTestUtils');
const { OFFICE_SETTING_KEYS, mirrorEntries } = require('./officeSettingKeys');

const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
/** @type {FakeControlPlane} */
let fake;
/** @type {string[]} */
let warns;
/** @type {string[]} */
let logs;
const quiet = { warn: console.warn, error: console.error, log: console.log };

/** Seed BOTH tables the way the dual-write leaves them. */
function seedBoth(key, value) {
  fake.seedPlatform(key, value);
  for (const e of mirrorEntries(key, value)) fake.seedOffice(e.officeKey, key, e.value);
}

test.beforeEach(() => {
  fake = new FakeControlPlane({
    tenants: [
      { tenant_id: TENANT_ID, slug: 'carein' },
      { tenant_id: ACME_ID, slug: 'acme' },
    ],
    offices: [
      { tenant_id: TENANT_ID, office_key: 'roland' },
      { tenant_id: TENANT_ID, office_key: 'valley' },
      { tenant_id: ACME_ID, office_key: 'main' },
    ],
  });
  registry.setPoolForTests(fake.pool());
  officeSettings.resetCacheForTests();
  officeRegistry.resetCacheForTests();
  parity.resetForTests();
  warns = [];
  logs = [];
  console.warn = (...a) => warns.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  console.error = () => {};
});
test.afterEach(() => {
  Object.assign(console, quiet);
  parity.resetForTests();
});
test.after(() => {
  registry.setPoolForTests(null);
  officeSettings.resetCacheForTests();
});

test('the SERVED side is office_setting now', () => {
  assert.equal(parity.SERVED, 'office_setting');
});

test('unarmed: an office_setting read compares nothing', async () => {
  seedBoth('tc_checkout_enabled', { roland: true });
  fake.seedPlatform('tc_referrals_enabled', { roland: true }); // divergent on purpose
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.equal(parity.lastResult('tc_checkout_enabled'), undefined);
  assert.deepEqual(warns.filter((w) => w.includes('office settings parity')), []);
});

test('armed, both tables agree: ONE clean line naming office_setting as served, no warning', async () => {
  seedBoth('tc_checkout_enabled', { roland: true, valley: false });
  seedBoth('hyg_od_enabled', { roland: true });
  seedBoth('tc_nurture_enabled', { valley: true });
  seedBoth('tc_email_identity', { roland: { practiceName: 'Roland Test', replyTo: 'front@roland.example.test' } });
  parity.arm();
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  for (const key of OFFICE_SETTING_KEYS) assert.deepEqual(parity.lastResult(key), [], key);
  assert.deepEqual(warns.filter((w) => w.includes('office settings parity')), []);
  const ok = logs.filter((l) => l.includes('office settings parity OK'));
  assert.equal(ok.length, 1);
  assert.match(ok[0], /2 office\(s\), 10 setting\(s\) \(serving office_setting\)/);

  // A second read does not repeat the line.
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.equal(logs.filter((l) => l.includes('office settings parity OK')).length, 1);
});

test('armed, platform_setting drifted: warns ONCE, names office_setting as served, values only for booleans', async () => {
  seedBoth('tc_checkout_enabled', { roland: true });
  fake.seedPlatform('tc_checkout_enabled', { roland: false }); // the rollback copy drifted
  parity.arm();
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.deepEqual(parity.lastResult('tc_checkout_enabled'), [
    { settingKey: 'tc_checkout_enabled', officeKey: 'roland', office: true, platform: false, fields: [] },
  ]);
  const w = warns.filter((x) => x.includes('office settings parity'));
  assert.equal(w.length, 1);
  assert.match(w[0], /'tc_checkout_enabled' for 'roland' differs — office_setting=true platform_setting=false\. Serving office_setting/);

  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.equal(warns.filter((x) => x.includes('office settings parity')).length, 1, 'once per process');
  assert.equal(logs.filter((l) => l.includes('office settings parity OK')).length, 0);
});

test('tc_email_identity divergence names FIELDS only, never a value', async () => {
  seedBoth('tc_email_identity', { roland: { replyTo: 'front@roland.example.test', practicePhone: '555-0100' } });
  fake.seedPlatform('tc_email_identity', { roland: { replyTo: 'other@roland.example.test', practicePhone: '555-0100' } });
  parity.arm();
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  const w = warns.filter((x) => x.includes('office settings parity'));
  assert.equal(w.length, 1);
  assert.match(w[0], /field\(s\) replyTo differ/);
  for (const secret of ['front@roland', 'other@roland', '555-0100', 'example.test']) {
    assert.equal(w[0].includes(secret), false, `logged a value: ${secret}`);
  }
});

test('hygiene: a usable platform map answers for every office; office rows for some offices agree', async () => {
  seedBoth('hyg_od_enabled', { roland: true }); // valley absent = false on both sides
  parity.arm();
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.deepEqual(parity.lastResult('hyg_od_enabled'), []);
});

test('confirm before warning: a write that lands between the reads is not reported', async () => {
  seedBoth('tc_referrals_enabled', { valley: true });
  parity.arm();
  // The SERVED read says valley=true; platform_setting is then rewritten AND
  // office_setting with it (a dual-write) before the comparison reads platform.
  const realGet = registry.getPlatformSetting;
  let calls = 0;
  registry.getPlatformSetting = async (key) => {
    if (key === 'tc_referrals_enabled' && calls++ === 0) {
      fake.seedPlatform('tc_referrals_enabled', { valley: false });
      fake.seedOffice('valley', 'tc_referrals_enabled', false);
    }
    return realGet(key);
  };
  try {
    await officeSettings.refreshFromDb('carein');
    await parity.settled();
  } finally {
    registry.getPlatformSetting = realGet;
  }
  assert.deepEqual(parity.lastResult('tc_referrals_enabled'), []);
  assert.deepEqual(warns.filter((w) => w.includes('office settings parity')), []);
});

test("another tenant's read is never compared with platform_setting (carein's copy)", async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  fake.seedPlatform('tc_checkout_enabled', { roland: true });
  parity.arm();
  await officeSettings.refreshFromDb('acme');
  await parity.settled();
  assert.equal(parity.lastResult('tc_checkout_enabled'), undefined);
});

test('office_setting unreadable: nothing is compared, nothing is warned', async () => {
  seedBoth('tc_checkout_enabled', { roland: true });
  parity.arm();
  fake.fail.listOfficeSettings = true;
  await officeSettings.refreshFromDb('carein');
  await parity.settled();
  assert.equal(parity.lastResult('tc_checkout_enabled'), undefined);
  assert.deepEqual(warns.filter((w) => w.includes('office settings parity')), []);
});

test('platform_setting side uses the pre-MT-2b reader rules', () => {
  assert.equal(parity.platformSideAnswer('tc_checkout_enabled', { roland: 'yes' }, 'roland'), null);
  assert.equal(parity.platformSideAnswer('tc_checkout_enabled', undefined, 'roland'), null);
  assert.equal(parity.platformSideAnswer('hyg_od_enabled', { roland: true }, 'valley'), false);
  assert.equal(parity.platformSideAnswer('hyg_od_enabled', 'junk', 'valley'), null);
  assert.equal(parity.platformSideAnswer('tc_nurture_enabled', { roland: 'true' }, 'roland'), false);
  assert.deepEqual(parity.platformSideAnswer('tc_email_identity', { roland: { practiceName: ' X ' } }, 'roland'), {
    replyTo: null,
    practiceName: 'X',
    practicePhone: null,
    practiceAddress: null,
    referralBcc: null,
  });
});
