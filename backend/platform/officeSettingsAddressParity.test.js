'use strict';

/**
 * Setup polish × MT-2: the practice ADDRESS is a field INSIDE tc_email_identity
 * (one of the ten per-office keys), not a new setting key, so it rides the
 * existing office_setting write + read-back path unchanged.
 *
 *   K  still ten keys: no new setting key was added
 *   L  PUT /api/tc/email-identity?office= with practiceAddress lands the
 *      address (line breaks kept) in office_setting ONLY (MT-2d single writer)
 *   S  a stale address left in platform_setting (inert history) is never
 *      served: office_setting answers
 *   F  a bad office_setting read-back of the address rolls the write back
 *
 * MT-2d: the former C and D cases pinned the office-settings parity tripwire
 * (an "OK" line, and a drift warning naming the field practiceAddress). The
 * tripwire is retired with the dual-write, so they are replaced by S.
 *
 * The real registry.setOfficeSetting runs against the in-memory control plane
 * (officeSettingsTestUtils.js), as officeSettingsSingleWriter.test.js does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('./registry');
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
}

async function boot(t, cp) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  resetReaders();
  const db = new FakeTenantDb();
  // Honour ROLLBACK, as Postgres does (as officeSettingsSingleWriter.test.js does).
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
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
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
  return { baseUrl: app.baseUrl, db };
}

test('K: the address is a field inside tc_email_identity — still ten per-office keys, no new one', () => {
  assert.equal(OFFICE_SETTING_KEYS.length, 10);
  assert.equal(KIND.tc_email_identity, 'identity');
  assert.ok(!OFFICE_SETTING_KEYS.some((k) => /address/i.test(k)));
  assert.ok(emailIdentity.STORED_FIELDS.includes('practiceAddress'));
});

test('L: a save with the address lands in office_setting only, line breaks kept', async (t) => {
  const cp = new FakeControlPlane();
  const { baseUrl } = await boot(t, cp);

  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(cp.officeValues('tc_email_identity'), { roland: IDENTITY });
  assert.equal(cp.officeValues('tc_email_identity').roland.practiceAddress, '1 Example St\nExample OK 00000');
  assert.equal(cp.platformValue('tc_email_identity'), undefined, 'platform_setting is not written');
  assert.equal(emailIdentity.storedValue('carein', 'roland', 'practiceAddress'), '1 Example St\nExample OK 00000');
});

test('S: a stale address in platform_setting (inert history) is never served', async (t) => {
  const cp = new FakeControlPlane();
  await boot(t, cp);
  cp.seedPlatform('tc_email_identity', { roland: { practiceAddress: '1 Example St' } });
  cp.seedOffice('roland', 'tc_email_identity', { practiceAddress: '2 Other Example St' });
  await emailIdentity.refreshFromDb('carein');
  assert.equal(emailIdentity.storedValue('carein', 'roland', 'practiceAddress'), '2 Other Example St', 'office_setting is served');
  assert.deepEqual(cp.platformValue('tc_email_identity'), { roland: { practiceAddress: '1 Example St' } }, 'history untouched');
});

test('F: an office_setting read-back that drops the address rolls the write back', async (t) => {
  const cp = new FakeControlPlane();
  const { baseUrl, db } = await boot(t, cp);
  assert.equal((await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY)).status, 200);
  const before = cp.officeValues('tc_email_identity');
  const history = db.table('tc_email_identity_changes').length;

  cp.fail.officeReadbackTamper = (rows) =>
    rows.map((x) => {
      if (!x.value || typeof x.value !== 'object') return x;
      const { practiceAddress: _dropped, ...rest } = x.value;
      return { ...x, value: rest };
    });
  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', { ...IDENTITY, practiceAddress: '3 Changed Example St' });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.deepEqual(cp.officeValues('tc_email_identity'), before);
  assert.equal(cp.platformValue('tc_email_identity'), undefined);
  assert.equal(db.table('tc_email_identity_changes').length, history, 'no history row');
});
