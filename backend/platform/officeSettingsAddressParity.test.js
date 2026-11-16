'use strict';

/**
 * Setup polish × MT-2a: the practice ADDRESS is a field INSIDE tc_email_identity
 * (one of the ten dual-written keys), not a new setting key, so it rides the
 * existing dual-write + read-back + parity path unchanged.
 *
 *   L  PUT /api/tc/email-identity?office= with practiceAddress lands identical
 *      values (address included, line breaks kept) in platform_setting and
 *      office_setting
 *   K  still ten keys: no new setting key was added
 *   C  parity compares the address and, with all ten keys clean, logs the OK
 *      line once
 *   D  a drift in the address alone warns naming the FIELD, never the value
 *   F  a bad office_setting read-back of the address rolls BOTH tables back
 *
 * The real registry.setPlatformSetting runs against the in-memory control
 * plane (officeSettingsTestUtils.js), as officeSettingsDualWrite.test.js does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('./registry');
const parity = require('./officeSettingsParity');
const officeSettings = require('./officeSettings');
const { OFFICE_SETTING_KEYS, KIND } = require('./officeSettingKeys');
const { FakeControlPlane } = require('./officeSettingsTestUtils');
const { FakeTenantDb, bootTcApp, api } = require('../routes/tc/tcTestUtils');
const emailIdentity = require('../config/emailIdentity');

const ENV_KEYS = ['ACS_EMAIL_FROM_ROLAND', 'TC_EMAIL_PRACTICE_ADDRESS_ROLAND', 'TC_EMAIL_PRACTICE_ADDRESS_VALLEY'];

const IDENTITY = {
  replyTo: 'frontdesk@roland.example.test',
  practiceName: 'Roland Example Dental',
  practicePhone: '(918) 555-0142',
  practiceAddress: '1 Example St\nExample OK 00000',
};

function resetReaders() {
  emailIdentity.resetCacheForTests();
  officeSettings.resetCacheForTests();
  parity.resetForTests();
}

async function boot(t, cp) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  resetReaders();
  const db = new FakeTenantDb();
  // Honour ROLLBACK, as Postgres does (as officeSettingsDualWrite.test.js does).
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = JSON.stringify([...db.tables.entries()]);
    return { rows: [] };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    db.tables = new Map(JSON.parse(snapshot));
    return { rows: [] };
  });
  const app = await bootTcApp({ db, role: 'admin' });
  registry.setPoolForTests(cp.pool());
  parity.arm();
  const warn = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.after(async () => {
    await app.close();
    registry.setPoolForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetReaders();
  });
  const lines = (m) => m.mock.calls.map((c) => c.arguments.map(String).join(' ')).filter((l) => l.includes('office settings parity'));
  return { baseUrl: app.baseUrl, db, warns: () => lines(warn), logs: () => lines(log) };
}

test('K: the address is a field inside tc_email_identity — still ten dual-written keys, no new one', () => {
  assert.equal(OFFICE_SETTING_KEYS.length, 10);
  assert.equal(KIND.tc_email_identity, 'identity');
  assert.ok(!OFFICE_SETTING_KEYS.some((k) => /address/i.test(k)));
  assert.ok(emailIdentity.STORED_FIELDS.includes('practiceAddress'));
});

test('L + C: a save with the address lands identically in both tables, and parity logs OK', async (t) => {
  const cp = new FakeControlPlane();
  const { baseUrl, warns, logs } = await boot(t, cp);

  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = cp.platformValue('tc_email_identity');
  assert.deepEqual(stored.roland, IDENTITY);
  assert.deepEqual(cp.officeValues('tc_email_identity'), { roland: stored.roland });
  assert.equal(cp.officeValues('tc_email_identity').roland.practiceAddress, '1 Example St\nExample OK 00000');

  // The save's own refresh compared the identity, address included: no drift.
  await parity.settled();
  assert.deepEqual(parity.lastResult('tc_email_identity'), []);
  assert.deepEqual(warns(), []);

  // With the other nine keys clean too, the OK line is logged once.
  for (const k of OFFICE_SETTING_KEYS) {
    if (k === 'tc_email_identity') continue;
    const clean = KIND[k] === 'on' ? { roland: false, valley: false } : { roland: null, valley: null };
    await parity.compare(k, clean);
  }
  await emailIdentity.refreshFromDb();
  await parity.settled();
  assert.deepEqual(logs(), ['[officeSettings] office settings parity OK — 2 office(s), 10 setting(s)']);
  assert.deepEqual(warns(), []);
});

test('D: a drift in the address alone names the field practiceAddress and never logs the address', async (t) => {
  const cp = new FakeControlPlane();
  const { warns } = await boot(t, cp);
  cp.seedPlatform('tc_email_identity', { roland: { practiceAddress: '1 Example St' } });
  cp.seedOffice('roland', 'tc_email_identity', { practiceAddress: '2 Other Example St' });
  await emailIdentity.refreshFromDb();
  await parity.settled();
  assert.equal(emailIdentity.storedValue('roland', 'practiceAddress'), '1 Example St', 'platform_setting is served');
  const w = warns();
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /'tc_email_identity' for 'roland' differs — field\(s\) practiceAddress differ/);
  assert.doesNotMatch(w[0], /Example St/, 'no address in the log');
});

test('F: an office_setting read-back that drops the address rolls BOTH tables back', async (t) => {
  const cp = new FakeControlPlane();
  const { baseUrl, db } = await boot(t, cp);
  assert.equal((await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY)).status, 200);
  const before = { platform: cp.platformValue('tc_email_identity'), office: cp.officeValues('tc_email_identity') };
  const history = db.table('tc_email_identity_changes').length;

  cp.fail.officeReadbackTamper = (rows) =>
    rows.map((x) => {
      if (!x.value || typeof x.value !== 'object') return x;
      const { practiceAddress: _dropped, ...rest } = x.value;
      return { ...x, value: rest };
    });
  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', { ...IDENTITY, practiceAddress: '3 Changed Example St' });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.deepEqual(cp.platformValue('tc_email_identity'), before.platform);
  assert.deepEqual(cp.officeValues('tc_email_identity'), before.office);
  assert.equal(db.table('tc_email_identity_changes').length, history, 'no history row');
});
