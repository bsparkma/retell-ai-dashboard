'use strict';

/**
 * Setup polish: the practice ADDRESS, editable per office in Admin → Email
 * identity, exactly like the practice phone.
 *
 *   P  save / clear / precedence: a saved address beats TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>;
 *      null clears back to the app setting; absent leaves it as saved
 *   M  multi-line: CRLF → LF, each line trimmed, blank lines dropped; any other
 *      control character is a 400; over 300 characters is a 400
 *   A  a change writes one history row (practice_address, prior + new) and one
 *      audit row with a slug prior_state
 *   C  the consumers that already read practiceDetailsFor().address pick it up
 *      with no change of their own: the print letterhead prefill, the email
 *      footer and {{practice.address}}, the referral letter
 *   S  setup card P1 turns done once the address is saved here
 *   O  per office: roland's saved address never answers for valley
 *
 * Synthetic office details only; no patient data.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../../platform/registry');
const emailIdentity = require('../../config/emailIdentity');
const acsConfig = require('../../config/acsEmail');
const emailContent = require('../../services/messaging/emailContent');
const printTemplateStore = require('../../services/tc/printTemplateStore');
const { computeSetupStatus } = require('../../services/setupStatus');
const contract = require('../../tc/contract.gen.cjs');
const { FakeTenantDb, bootTcApp, api, auditRows } = require('./tcTestUtils');
// MT-2b: the per-office readers SERVE office_setting. Derive it from this suite's
// getPlatformSetting stubs, as the dual-write stores it (test infra; no assertion changes).
require('../../platform/officeSettingsTestUtils').mirrorPlatformStubIntoOfficeSettings(registry);

const URL = (office) => `/api/tc/email-identity?office=${office}`;

const ENV_KEYS = [
  'ACS_EMAIL_FROM',
  'ACS_EMAIL_FROM_ROLAND',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'TC_EMAIL_PRACTICE_ADDRESS_ROLAND',
  'TC_EMAIL_PRACTICE_ADDRESS_VALLEY',
];

const ENV_ADDRESS = '9 Fallback Rd, Example OK 00000';

const IDENTITY = {
  replyTo: 'frontdesk@roland.example.test',
  practiceName: 'Roland Example Dental',
  practicePhone: '(918) 555-0142',
};

/** Boot the TC app over an in-memory platform_setting (as tcEmailIdentity.test.js does). */
async function boot(t, { db = new FakeTenantDb(), env = {} } = {}) {
  const originals = {
    get: registry.getPlatformSetting,
    set: registry.setPlatformSetting,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  Object.assign(process.env, env);
  const cp = { row: null, writes: 0 };
  registry.getPlatformSetting = async (key) => {
    if (key !== emailIdentity.SETTING_KEY) return null;
    return cp.row ? { ...cp.row, value: JSON.parse(JSON.stringify(cp.row.value)) } : null;
  };
  registry.setPlatformSetting = async (key, value, by) => {
    cp.writes += 1;
    cp.row = { key, value: JSON.parse(JSON.stringify(value)), updated_at: new Date('2026-11-16T15:00:00Z'), updated_by: by };
    return cp.row;
  };
  emailIdentity.resetCacheForTests();
  const app = await bootTcApp({ db, role: 'admin' });
  t.after(async () => {
    await app.close();
    registry.getPlatformSetting = originals.get;
    registry.setPlatformSetting = originals.set;
    for (const k of ENV_KEYS) {
      if (originals.env[k] === undefined) delete process.env[k];
      else process.env[k] = originals.env[k];
    }
    emailIdentity.resetCacheForTests();
  });
  return { ...app, cp };
}

test('P: GET shows the address with its app-setting fallback; a save beats it; null clears back; absent leaves it', async (t) => {
  const { baseUrl, cp } = await boot(t, { env: { TC_EMAIL_PRACTICE_ADDRESS_ROLAND: ENV_ADDRESS } });

  let r = await api(baseUrl, 'GET', URL('roland'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.fields.practiceAddress, {
    value: ENV_ADDRESS,
    source: 'env',
    stored: null,
    fallback: ENV_ADDRESS,
    fallbackSetting: 'TC_EMAIL_PRACTICE_ADDRESS_ROLAND',
  });
  assert.equal(contract.TcEmailIdentityResponse.safeParse(r.body).success, true, 'parses through the shared contract');

  // Saved beats the app setting, and the send path sees it at once.
  r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '1 Example St\nExample OK 00000' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fields.practiceAddress.source, 'stored');
  assert.equal(r.body.fields.practiceAddress.value, '1 Example St\nExample OK 00000');
  assert.equal(r.body.fields.practiceAddress.fallback, ENV_ADDRESS, 'the fallback is still shown');
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, '1 Example St\nExample OK 00000');
  assert.equal(cp.row.value.roland.practiceAddress, '1 Example St\nExample OK 00000');

  // Absent = unchanged (a client that predates the field cannot clear it).
  r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practicePhone: '(918) 555-0143' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fields.practiceAddress.stored, '1 Example St\nExample OK 00000');
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, '1 Example St\nExample OK 00000');

  // null = clear back to the app setting.
  r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.fields.practiceAddress.source, r.body.fields.practiceAddress.stored], ['env', null]);
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, ENV_ADDRESS);
  assert.equal('practiceAddress' in cp.row.value.roland, false, 'nothing saved once cleared');

  // And with no app setting either, the address is simply not set.
  delete process.env.TC_EMAIL_PRACTICE_ADDRESS_ROLAND;
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, null);
  assert.equal(acsConfig.identityStateFor('carein', 'roland').practiceAddress.source, 'none');
});

test('M: multi-line is normalized; another control character or an over-long address is a 400 and saves nothing', async (t) => {
  const { baseUrl, cp } = await boot(t);
  let r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '  1 Example St  \r\n\r\n  Suite 2 \r Example OK 00000  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fields.practiceAddress.stored, '1 Example St\nSuite 2\nExample OK 00000');

  const writes = cp.writes;
  for (const practiceAddress of ['1 Example St\tSuite 2', '1 Example St\u0007', 'x'.repeat(301), '', '   ']) {
    r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress });
    assert.equal(r.status, 400, JSON.stringify(practiceAddress));
  }
  assert.equal(cp.writes, writes, 'nothing saved');
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, '1 Example St\nSuite 2\nExample OK 00000');

  // The phone is still single-line: a line break there is still refused.
  r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practicePhone: '(918)\n555-0142' });
  assert.equal(r.status, 400);
});

test('A: a change writes one practice_address history row and one audit row (slug prior_state, no value)', async (t) => {
  const db = new FakeTenantDb();
  const { baseUrl } = await boot(t, { db });
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);
  const before = db.table('tc_email_identity_changes').length;

  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '1 Example St' })).status, 200);
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '2 Example St' })).status, 200);
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: null })).status, 200);
  // A no-op (same values, address absent) writes nothing.
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);

  const rows = db.table('tc_email_identity_changes').slice(before);
  assert.deepEqual(
    rows.map((h) => [h.office_id, h.field, h.prior_value, h.new_value]),
    [
      ['roland', 'practice_address', null, '1 Example St'],
      ['roland', 'practice_address', '1 Example St', '2 Example St'],
      ['roland', 'practice_address', '2 Example St', null],
    ]
  );
  const audits = auditRows(db).filter((a) => a.resource_id === 'roland/practice_address');
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_type, a.prior_state]),
    [
      ['UPDATE', 'tc_email_identity', 'unset'],
      ['UPDATE', 'tc_email_identity', 'stored'],
      ['UPDATE', 'tc_email_identity', 'stored'],
    ]
  );
  for (const a of audits) assert.doesNotMatch(JSON.stringify(a), /Example St/, 'audit_log holds no address');
});

test('C: every consumer of the address reads the saved one, with no change of its own', async (t) => {
  const { baseUrl } = await boot(t, { env: { TC_EMAIL_PRACTICE_ADDRESS_ROLAND: ENV_ADDRESS } });
  assert.equal(
    (await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '1 Example St\nExample OK 00000' })).status,
    200
  );
  const saved = '1 Example St\nExample OK 00000';

  // 1. The print letterhead prefill (services/tc/printTemplateStore.js).
  assert.equal((await printTemplateStore.prefillFor('carein', 'roland')).address, saved);
  // 2. The email footer every TC email carries, and 3. the {{practice.address}} token
  //    (services/messaging/emailContent.js).
  assert.equal(emailContent.footerFor('carein', 'roland', null).practiceAddress, saved);
  assert.equal(emailContent.practiceValues('carein', 'roland')['practice.address'], saved);
  // 4. The referral letter (routes/tc/referralSend.js officeDetails, not exported):
  //    it reads practiceDetailsFor(office).address and nothing else for the address.
  const src = fs.readFileSync(path.join(__dirname, 'referralSend.js'), 'utf8');
  // MT-2b: officeDetails takes the session tenant first; the address still comes from practiceDetailsFor alone.
  const officeDetailsSrc = /function officeDetails\(tenantSlug, office\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(officeDetailsSrc, /acsConfig\.practiceDetailsFor\(tenantSlug, office\)/);
  assert.match(officeDetailsSrc, /address: details\.address,/);

  // Cleared: every consumer falls back to the app setting together.
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: null })).status, 200);
  assert.equal((await printTemplateStore.prefillFor('carein', 'roland')).address, ENV_ADDRESS);
  assert.equal(emailContent.footerFor('carein', 'roland', null).practiceAddress, ENV_ADDRESS);
  assert.equal(emailContent.practiceValues('carein', 'roland')['practice.address'], ENV_ADDRESS);
});

test('S: setup card P1 turns done once the address is saved here (no app setting needed)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { baseUrl } = await boot(t);
  // Only the P1 reader matters here; the rest may read "could not check".
  const pool = {
    query: async () => {
      throw new Error('not used by P1');
    },
  };
  const p1 = async () => {
    const status = await computeSetupStatus({ office: 'roland', tenantId: 'T1', tenantSlug: 'carein', modules: ['tc'], pool });
    return status.steps.find((s) => s.id === 'P1');
  };

  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);
  let s = await p1();
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /Missing for the letterhead: address\./);

  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '1 Example St' })).status, 200);
  s = await p1();
  assert.equal(s.status, 'done', s.detail);

  // P5 still judges only the three fields an email signs with.
  const status = await computeSetupStatus({ office: 'roland', tenantId: 'T1', tenantSlug: 'carein', modules: ['tc'], pool });
  const p5 = status.steps.find((x) => x.id === 'P5');
  assert.doesNotMatch(p5.detail, /address/i);
});

test('O: per office — roland’s saved address never answers for valley', async (t) => {
  const { baseUrl } = await boot(t, { env: { TC_EMAIL_PRACTICE_ADDRESS_VALLEY: '5 Valley Example Ave' } });
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practiceAddress: '1 Example St' })).status, 200);
  assert.equal(acsConfig.practiceDetailsFor('carein', 'roland').address, '1 Example St');
  assert.equal(acsConfig.practiceDetailsFor('carein', 'valley').address, '5 Valley Example Ave');
  const v = await api(baseUrl, 'GET', URL('valley'));
  assert.equal(v.body.fields.practiceAddress.source, 'env');
  // The office comes from ?office=, never the body.
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, office: 'valley', practiceAddress: 'x' })).status, 400);
});
