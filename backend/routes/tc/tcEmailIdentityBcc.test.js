'use strict';

/**
 * R6.3 — the referral copy inbox ("Send a copy to (BCC)") in Settings → Email
 * identity, PUT/GET /api/tc/email-identity.
 *
 *   - saved in the same platform_setting row as the identity, read back, in
 *     force for the next send at once
 *   - optional: absent leaves the saved copy inbox alone (an older client
 *     cannot clear it); null clears it; blank in the UI = no copy
 *   - one plain address only (a list, a display name, a header break → 400)
 *   - NO app-setting fallback: nothing outside this setting turns copies on
 *   - each change gets a history row (field referral_bcc) and an audit row
 *   - the From never moves; the other three fields behave as before
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const emailIdentity = require('../../config/emailIdentity');
const acsConfig = require('../../config/acsEmail');
const { FakeTenantDb, bootTcApp, api, auditRows } = require('./tcTestUtils');

const URL = (office) => `/api/tc/email-identity?office=${office}`;
const ENV_KEYS = ['ACS_EMAIL_FROM', 'ACS_EMAIL_FROM_ROLAND', 'ACS_EMAIL_REPLY_TO_ROLAND'];
const IDENTITY = { replyTo: 'frontdesk@roland.example.test', practiceName: 'Roland Example Dental', practicePhone: null };
const COPY = 'Referral-Copies@Roland.example.test';

async function boot(t, { role = 'admin', db = new FakeTenantDb() } = {}) {
  const originals = {
    get: registry.getPlatformSetting,
    set: registry.setPlatformSetting,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  const cp = { row: null, writes: 0 };
  registry.getPlatformSetting = async (key) =>
    key === emailIdentity.SETTING_KEY && cp.row ? { ...cp.row, value: JSON.parse(JSON.stringify(cp.row.value)) } : null;
  registry.setPlatformSetting = async (key, value, by) => {
    cp.writes += 1;
    cp.row = { key, value: JSON.parse(JSON.stringify(value)), updated_at: new Date('2026-10-22T15:00:00Z'), updated_by: by };
    return cp.row;
  };
  emailIdentity.resetCacheForTests();
  const app = await bootTcApp({ db, role });
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
  return { ...app, cp, db };
}

const history = (db) => db.table('tc_email_identity_changes');
const audits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_email_identity');

test('a copy inbox is saved (lowercased), read back, and in force for the next send at once', async (t) => {
  const { baseUrl, cp } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', URL('roland'))).body.referralBcc, null, 'none until saved');
  const r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: COPY });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referralBcc, 'referral-copies@roland.example.test');
  assert.equal(cp.row.value.roland.referralBcc, 'referral-copies@roland.example.test');
  assert.equal(emailIdentity.referralBccFor('roland'), 'referral-copies@roland.example.test');
  assert.equal(emailIdentity.referralBccFor('valley'), null, 'per office');
  const contract = require('../../tc/contract.gen.cjs');
  assert.equal(contract.TcEmailIdentityResponse.safeParse(r.body).success, true);
  assert.equal(acsConfig.fromAddressFor('roland'), 'donotreply@roland.example.test', 'the From never moves');
});

test('optional: absent leaves it as saved; null clears it (no copy); the other fields are unaffected', async (t) => {
  const { baseUrl } = await boot(t);
  await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: COPY });
  // An older client that knows nothing of it saves the three fields only.
  const kept = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practicePhone: '(918) 555-0142' });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.referralBcc, 'referral-copies@roland.example.test');
  assert.equal(kept.body.fields.practicePhone.value, '(918) 555-0142');
  const cleared = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: null });
  assert.equal(cleared.body.referralBcc, null);
  assert.equal(emailIdentity.referralBccFor('roland'), null);
  assert.equal(cleared.body.fields.replyTo.value, 'frontdesk@roland.example.test');
});

test('one plain address only; a refused value saves nothing', async (t) => {
  const { baseUrl, cp } = await boot(t);
  for (const bad of [
    'not-an-address',
    'a@x.test, b@x.test',
    'Copies <copies@roland.example.test>',
    'copies@roland.example.test\r\nBcc: someone@else.test',
    '',
    `${'a'.repeat(250)}@x.test`,
    42,
  ]) {
    const r = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(cp.writes, 0);
});

test('no app-setting fallback: no env var turns copies on, and clearing really means no copy', async (t) => {
  const { baseUrl } = await boot(t);
  // Not FIELD_NAMES (which each have an env fallback) — the copy inbox is its own field.
  assert.deepEqual([...emailIdentity.FIELD_NAMES], ['replyTo', 'practiceName', 'practicePhone']);
  assert.deepEqual([...emailIdentity.STORED_FIELDS], ['replyTo', 'practiceName', 'practicePhone', 'referralBcc']);
  const r = await api(baseUrl, 'GET', URL('roland'));
  assert.equal(r.body.fields.referralBcc, undefined, 'not presented as an env-backed field');
  assert.equal(r.body.referralBcc, null);
});

test('each change: a history row (referral_bcc, prior + new) and an audit row; a no-op writes none', async (t) => {
  const db = new FakeTenantDb();
  const { baseUrl, cp } = await boot(t, { db, role: 'office' });
  await api(baseUrl, 'PUT', URL('roland'), IDENTITY);
  const base = history(db).length;
  await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: COPY });
  await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: null });
  assert.deepEqual(
    history(db).slice(base).map((h) => [h.field, h.prior_value, h.new_value]),
    [
      ['referral_bcc', null, 'referral-copies@roland.example.test'],
      ['referral_bcc', 'referral-copies@roland.example.test', null],
    ]
  );
  assert.deepEqual(
    audits(db).slice(-2).map((a) => [a.resource_id, a.prior_state]),
    [
      ['roland/referral_bcc', 'unset'],
      ['roland/referral_bcc', 'stored'],
    ]
  );
  const writes = cp.writes;
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);
  assert.equal(cp.writes, writes, 'absent + already none = nothing changed, nothing written');
});

test('the same people as the rest of the identity: tc is refused', async (t) => {
  const { baseUrl, cp } = await boot(t, { role: 'tc' });
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, referralBcc: COPY })).status, 403);
  assert.equal(cp.writes, 0);
});
