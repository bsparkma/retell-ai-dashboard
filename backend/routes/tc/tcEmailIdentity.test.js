'use strict';

/**
 * /api/tc/email-identity (R5c): the office's reply-to, practice name and
 * practice phone, editable in the app.
 *
 *   W  who: admin + office (tc.notification_defaults); tc, hygiene, doctor 403
 *   R  GET shows what is in force per field and where it came from, plus the
 *      From address read-only
 *   P  PUT saves, reads back, and the next email uses it; null clears to the
 *      app setting; per office
 *   V  validation server-side: one plain email, length caps, single line
 *   S  strict body: a smuggled from / office / extra key is a 400, nothing saved
 *   A  every change: a history row with the prior and new value, and an audit
 *      row with a slug prior_state; a no-op save writes neither
 *   H  honest state: an unreadable control plane is a 503 and changes nothing;
 *      a read-back that disagrees is a 500 and the history rolls back
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const emailIdentity = require('../../config/emailIdentity');
const acsConfig = require('../../config/acsEmail');
const { FakeTenantDb, bootTcApp, api, auditRows } = require('./tcTestUtils');

const URL = (office) => `/api/tc/email-identity?office=${office}`;

const ENV_KEYS = [
  'ACS_EMAIL_FROM',
  'ACS_EMAIL_FROM_ROLAND',
  'ACS_EMAIL_FROM_VALLEY',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'ACS_EMAIL_REPLY_TO_VALLEY',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
];

const IDENTITY = {
  replyTo: 'FrontDesk@Roland.example.test',
  practiceName: 'Roland Example Dental',
  practicePhone: '(918) 555-0142',
};

/** Boot the TC app over an in-memory platform_setting. */
async function boot(t, { role = 'admin', db = new FakeTenantDb(), env = {}, user } = {}) {
  const originals = {
    get: registry.getPlatformSetting,
    set: registry.setPlatformSetting,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  Object.assign(process.env, env);
  const cp = { row: null, fail: false, writes: 0, tamper: null };
  registry.getPlatformSetting = async (key) => {
    if (key !== emailIdentity.SETTING_KEY) return null;
    if (cp.fail) throw new Error('control plane down');
    return cp.row ? { ...cp.row, value: JSON.parse(JSON.stringify(cp.row.value)) } : null;
  };
  registry.setPlatformSetting = async (key, value, by) => {
    cp.writes += 1;
    const stored = cp.tamper ? cp.tamper(value) : value;
    cp.row = { key, value: JSON.parse(JSON.stringify(stored)), updated_at: new Date('2026-10-22T15:00:00Z'), updated_by: by };
    return cp.row;
  };
  emailIdentity.resetCacheForTests();
  const app = await bootTcApp({ db, role, ...(user ? { user } : {}) });
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

const history = (db) => db.table('tc_email_identity_changes');
const identityAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_email_identity');

test('W: admin and office read and write; tc, hygiene and doctor are refused, and nothing is saved', async (t) => {
  for (const role of ['admin', 'office']) {
    const { baseUrl } = await boot(t, { role });
    assert.equal((await api(baseUrl, 'GET', URL('roland'))).status, 200, role);
    assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200, role);
  }
  for (const role of ['tc', 'hygiene', 'doctor']) {
    const { baseUrl, db, cp } = await boot(t, { role });
    assert.equal((await api(baseUrl, 'GET', URL('roland'))).status, 403, role);
    assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 403, role);
    assert.equal(cp.writes, 0, role);
    assert.equal(history(db).length, 0, role);
  }
});

test('R: GET shows each field with its source and the app-setting fallback, and the From read-only', async (t) => {
  const { baseUrl } = await boot(t, {
    env: { ACS_EMAIL_REPLY_TO_ROLAND: 'env@roland.example.test', TC_EMAIL_PRACTICE_PHONE_ROLAND: '(918) 555-0100' },
  });
  const r = await api(baseUrl, 'GET', URL('roland'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.fields.replyTo, {
    value: 'env@roland.example.test',
    source: 'env',
    stored: null,
    fallback: 'env@roland.example.test',
    fallbackSetting: 'ACS_EMAIL_REPLY_TO_ROLAND',
  });
  assert.equal(r.body.fields.practiceName.source, 'none');
  assert.equal(r.body.fields.practiceName.fallbackSetting, 'TC_EMAIL_PRACTICE_NAME_ROLAND');
  assert.deepEqual(r.body.from, { patientEmail: 'donotreply@roland.example.test', referral: 'donotreply@roland.example.test' });
  assert.equal(r.body.policyKnown, true);
  // The response parses through the shared contract the dashboard uses.
  const contract = require('../../tc/contract.gen.cjs');
  assert.equal(contract.TcEmailIdentityResponse.safeParse(r.body).success, true);
});

test('P: a save is read back, in force for the next email, and null clears back to the app setting', async (t) => {
  const { baseUrl } = await boot(t, { env: { ACS_EMAIL_REPLY_TO_ROLAND: 'env@roland.example.test' } });
  const r = await api(baseUrl, 'PUT', URL('roland'), IDENTITY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.body.fields).map(([k, v]) => [k, [v.value, v.source]])),
    {
      replyTo: ['frontdesk@roland.example.test', 'stored'],
      practiceName: ['Roland Example Dental', 'stored'],
      practicePhone: ['(918) 555-0142', 'stored'],
    }
  );
  assert.equal(r.body.updatedBy, 'tc@carein.ai');
  // The send path reads it right away — no wait for the 5-minute refresh.
  assert.equal(acsConfig.replyToFor('roland'), 'frontdesk@roland.example.test');
  assert.equal(acsConfig.practiceNameFor('roland'), 'Roland Example Dental');

  const cleared = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, replyTo: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(
    [cleared.body.fields.replyTo.value, cleared.body.fields.replyTo.source],
    ['env@roland.example.test', 'env']
  );
  assert.equal(acsConfig.replyToFor('roland'), 'env@roland.example.test');
});

test('P: identities are per office — saving roland leaves valley untouched, and the other way round', async (t) => {
  const { baseUrl, cp } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', URL('valley'), { replyTo: 'front@valley.example.test', practiceName: null, practicePhone: null })).status, 200);
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);
  assert.deepEqual(Object.keys(cp.row.value).sort(), ['roland', 'valley']);
  const valley = await api(baseUrl, 'GET', URL('valley'));
  assert.equal(valley.body.fields.replyTo.value, 'front@valley.example.test');
  assert.equal(valley.body.fields.practiceName.value, null);
  assert.equal(acsConfig.replyToFor('valley'), 'front@valley.example.test');
});

test('V: reply-to must be one plain address; caps and single-line rules are enforced; nothing is saved', async (t) => {
  const { baseUrl, cp, db } = await boot(t);
  const bad = [
    { ...IDENTITY, replyTo: 'not an address' },
    { ...IDENTITY, replyTo: 'Front Desk <front@roland.example.test>' },
    { ...IDENTITY, replyTo: 'a@example.test, b@example.test' },
    { ...IDENTITY, practiceName: 'x'.repeat(121) },
    { ...IDENTITY, practiceName: 'Roland\r\nBcc: someone@example.test' },
    { ...IDENTITY, practicePhone: '1'.repeat(41) },
    { ...IDENTITY, practicePhone: '   ' },
    { ...IDENTITY, practiceName: 42 },
  ];
  for (const body of bad) {
    const r = await api(baseUrl, 'PUT', URL('roland'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.success, false);
  }
  assert.equal(cp.writes, 0);
  assert.equal(history(db).length, 0);
  // At the caps exactly: accepted.
  const edge = await api(baseUrl, 'PUT', URL('roland'), { replyTo: 'a@b.co', practiceName: 'x'.repeat(120), practicePhone: '1'.repeat(40) });
  assert.equal(edge.status, 200, JSON.stringify(edge.body));
});

test('S: strict body — a smuggled from, office or extra key is a 400; a missing key is a 400; nothing saved', async (t) => {
  const { baseUrl, cp } = await boot(t);
  for (const body of [
    { ...IDENTITY, from: 'ceo@roland.example.test' },
    { ...IDENTITY, office: 'valley' },
    { ...IDENTITY, practiceAddress: '1 Example St' },
    { replyTo: IDENTITY.replyTo, practiceName: IDENTITY.practiceName },
  ]) {
    const r = await api(baseUrl, 'PUT', URL('roland'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(cp.writes, 0);
  assert.equal(acsConfig.fromAddressFor('roland'), 'donotreply@roland.example.test', 'the From never moves');
  // The office comes from ?office=, and only a real one.
  assert.equal((await api(baseUrl, 'PUT', URL('unknown'), IDENTITY)).status, 400);
  assert.equal((await api(baseUrl, 'PUT', '/api/tc/email-identity', IDENTITY)).status, 400);
});

test('A: each changed field gets a history row (prior + new) and an audit row (slug prior_state); a no-op writes none', async (t) => {
  const db = new FakeTenantDb();
  const { baseUrl, cp } = await boot(t, { db, user: { email: 'Office.Manager@Example.test', name: 'OM', tenantId: 'x' }, role: 'office' });
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), IDENTITY)).status, 200);
  assert.deepEqual(
    history(db).map((h) => [h.office_id, h.field, h.prior_value, h.new_value, h.changed_by]),
    [
      ['roland', 'reply_to', null, 'frontdesk@roland.example.test', 'office.manager@example.test'],
      ['roland', 'practice_name', null, 'Roland Example Dental', 'office.manager@example.test'],
      ['roland', 'practice_phone', null, '(918) 555-0142', 'office.manager@example.test'],
    ]
  );
  assert.deepEqual(
    identityAudits(db).map((a) => [a.action, a.resource_id, a.office, a.prior_state]),
    [
      ['UPDATE', 'roland/reply_to', 'roland', 'unset'],
      ['UPDATE', 'roland/practice_name', 'roland', 'unset'],
      ['UPDATE', 'roland/practice_phone', 'roland', 'unset'],
    ]
  );

  // Change one field: one row each, carrying what it replaced.
  assert.equal((await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, practicePhone: '(918) 555-0199' })).status, 200);
  assert.equal(history(db).length, 4);
  assert.deepEqual(
    [history(db)[3].field, history(db)[3].prior_value, history(db)[3].new_value],
    ['practice_phone', '(918) 555-0142', '(918) 555-0199']
  );
  assert.deepEqual(identityAudits(db).slice(3).map((a) => [a.resource_id, a.prior_state]), [['roland/practice_phone', 'stored']]);

  // The same values again (reply-to in other case): nothing changed, nothing recorded or written.
  const writes = cp.writes;
  const same = await api(baseUrl, 'PUT', URL('roland'), { ...IDENTITY, replyTo: 'FRONTDESK@roland.example.test', practicePhone: '(918) 555-0199' });
  assert.equal(same.status, 200);
  assert.equal(history(db).length, 4);
  assert.equal(identityAudits(db).length, 4);
  assert.equal(cp.writes, writes);

  // Every audit prior_state fits the audit_log grammar; no value is copied into the trail.
  for (const a of identityAudits(db)) {
    assert.match(a.prior_state, /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$/);
    assert.doesNotMatch(JSON.stringify(a), /example\.test|555-01|Example Dental/);
  }
});

test('H: an unreadable control plane is a 503 that changes nothing', async (t) => {
  const { baseUrl, cp, db } = await boot(t);
  cp.fail = true;
  const r = await api(baseUrl, 'PUT', URL('roland'), IDENTITY);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'IDENTITY_UNAVAILABLE');
  assert.equal(cp.writes, 0);
  assert.equal(history(db).length, 0);
});

test('H: a read-back that disagrees with what was asked is a 500, and the history row is rolled back', async (t) => {
  const db = new FakeTenantDb();
  // Make the fake honour ROLLBACK, as Postgres does.
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = JSON.stringify([...db.tables.entries()]);
    return { rows: [] };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    db.tables = new Map(JSON.parse(snapshot));
    return { rows: [] };
  });
  const { baseUrl, cp } = await boot(t, { db });
  cp.tamper = (value) => ({ ...value, roland: { replyTo: 'somebody.else@example.test' } });
  const r = await api(baseUrl, 'PUT', URL('roland'), IDENTITY);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'IDENTITY_READBACK_FAILED');
  assert.equal(history(db).length, 0);
  assert.equal(identityAudits(db).length, 0);
});

test('guards: no Open Dental anywhere in the slice, and the From is not an editable field', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(`${__dirname}/emailIdentity.js`, 'utf8') + fs.readFileSync(`${__dirname}/../../config/emailIdentity.js`, 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(openDental|odOffices|odAccess|odClient)/i);
  assert.deepEqual([...emailIdentity.FIELD_NAMES], ['replyTo', 'practiceName', 'practicePhone']);
  for (const f of emailIdentity.FIELD_NAMES) assert.doesNotMatch(emailIdentity.FIELDS[f].envPrefix, /FROM/);
});
