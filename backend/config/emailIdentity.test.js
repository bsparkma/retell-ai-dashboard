'use strict';

/**
 * config/emailIdentity.js + the precedence config/acsEmail.js applies (R5c):
 * a value saved in the app beats the app setting; the app setting answers when
 * nothing is saved; neither => null. Against an in-memory control plane.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../platform/registry');
const identity = require('./emailIdentity');
const acs = require('./acsEmail');
// MT-2b: the per-office readers SERVE office_setting. Derive it from this suite's
// getPlatformSetting stubs, as the dual-write stores it (test infra; no assertion changes).
require('../platform/officeSettingsTestUtils').mirrorPlatformStubIntoOfficeSettings(registry);

const ENV_KEYS = [
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'ACS_EMAIL_REPLY_TO_VALLEY',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_VALLEY',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_VALLEY',
  'TC_EMAIL_REFRESH_MINUTES',
];

/** An in-memory platform_setting, swapped into the registry for one test. */
function controlPlane(t, initial = null) {
  const originals = { get: registry.getPlatformSetting, set: registry.setPlatformSetting };
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const cp = { row: initial ? { key: identity.SETTING_KEY, value: initial, updated_at: new Date(), updated_by: 'seed@example.test' } : null, reads: 0, fail: false, writes: [] };
  registry.getPlatformSetting = async (key) => {
    assert.equal(key, identity.SETTING_KEY);
    cp.reads += 1;
    if (cp.fail) throw new Error('control plane down');
    return cp.row ? { ...cp.row, value: JSON.parse(JSON.stringify(cp.row.value)) } : null;
  };
  registry.setPlatformSetting = async (key, value, by) => {
    cp.writes.push({ key, value, by });
    cp.row = { key, value: JSON.parse(JSON.stringify(value)), updated_at: new Date(), updated_by: by };
    return cp.row;
  };
  identity.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = originals.get;
    registry.setPlatformSetting = originals.set;
    for (const k of ENV_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    identity.resetCacheForTests();
  });
  return cp;
}

test('nothing saved, nothing set: every field is null and acsEmail reads null (the office label is the caller\'s)', async (t) => {
  controlPlane(t);
  await identity.refreshFromDb('carein');
  assert.equal(acs.replyToFor('carein', 'roland'), null);
  assert.equal(acs.practiceNameFor('carein', 'roland'), null);
  assert.equal(acs.practiceDetailsFor('carein', 'roland').phone, null);
  const s = acs.identityStateFor('carein', 'roland');
  assert.deepEqual(s.replyTo, { value: null, source: 'none', stored: null, fallback: null, fallbackSetting: 'ACS_EMAIL_REPLY_TO_ROLAND' });
});

test('the app setting answers when nothing is saved — unchanged from before R5c', async (t) => {
  controlPlane(t);
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'Front@Roland.example.test';
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Example Dental';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  await identity.refreshFromDb('carein');
  assert.equal(acs.replyToFor('carein', 'roland'), 'front@roland.example.test');
  assert.equal(acs.practiceNameFor('carein', 'roland'), 'Roland Example Dental');
  assert.equal(acs.practiceDetailsFor('carein', 'roland').phone, '(918) 555-0100');
  assert.equal(acs.identityStateFor('carein', 'roland').practiceName.source, 'env');
});

test('a SAVED value beats the app setting, field by field and office by office', async (t) => {
  controlPlane(t, { roland: { replyTo: 'office@roland.example.test', practicePhone: '(918) 555-0199' } });
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Env Name';
  process.env.ACS_EMAIL_REPLY_TO_VALLEY = 'env@valley.example.test';
  await identity.refreshFromDb('carein');
  assert.equal(acs.replyToFor('carein', 'roland'), 'office@roland.example.test');
  assert.equal(acs.practiceDetailsFor('carein', 'roland').phone, '(918) 555-0199');
  assert.equal(acs.practiceNameFor('carein', 'roland'), 'Env Name', 'a field with nothing saved still falls back');
  assert.equal(acs.replyToFor('carein', 'valley'), 'env@valley.example.test', "roland's saved value is roland's alone");
  const s = acs.identityStateFor('carein', 'roland');
  assert.equal(s.replyTo.source, 'stored');
  assert.equal(s.replyTo.fallback, 'env@roland.example.test');
  assert.equal(s.practiceName.source, 'env');
});

test('the unknown bucket and a non-office never read a saved value', async (t) => {
  controlPlane(t, { roland: { replyTo: 'office@roland.example.test' }, unknown: { replyTo: 'x@example.test' } });
  await identity.refreshFromDb('carein');
  assert.equal(identity.storedValue('carein', 'unknown', 'replyTo'), null);
  assert.equal(acs.replyToFor('carein', 'unknown'), null);
  assert.equal(acs.replyToFor('carein', 'riley'), null);
});

test('junk saved values are ignored (the app setting answers), never used', async (t) => {
  controlPlane(t, {
    roland: { replyTo: 'Front Desk <front@roland.example.test>', practiceName: 'Line one\nBcc: x@example.test', practicePhone: 5 },
  });
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  await identity.refreshFromDb('carein');
  assert.equal(acs.replyToFor('carein', 'roland'), 'env@roland.example.test');
  assert.equal(acs.practiceNameFor('carein', 'roland'), null);
  assert.equal(acs.practiceDetailsFor('carein', 'roland').phone, null);
});

test('a failed read keeps the previous cache; never read => the app setting answers', async (t) => {
  const cp = controlPlane(t, { roland: { replyTo: 'office@roland.example.test' } });
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  assert.equal(acs.replyToFor('carein', 'roland'), 'env@roland.example.test', 'never read');
  await identity.refreshFromDb('carein');
  assert.equal(acs.replyToFor('carein', 'roland'), 'office@roland.example.test');
  cp.fail = true;
  const r = await identity.refreshFromDb('carein');
  assert.equal(r.ok, false);
  assert.equal(acs.replyToFor('carein', 'roland'), 'office@roland.example.test', 'a blip does not flip it');
});

test('ensureFresh re-reads only once the 5-minute window has passed', async (t) => {
  const cp = controlPlane(t, { roland: { replyTo: 'office@roland.example.test' } });
  await identity.ensureFresh('carein');
  await identity.ensureFresh('carein');
  assert.equal(cp.reads, 1, 'fresh: no second read');
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  Date.now = () => realNow() + 5 * 60 * 1000 + 1;
  await identity.ensureFresh('carein');
  assert.equal(cp.reads, 2, 'stale after 5 minutes: re-read');
});

test('persist writes one office, carries the other through, and reads it back', async (t) => {
  const cp = controlPlane(t, { valley: { practiceName: 'Valley Example Dental' } });
  await identity.persist('carein', 'roland', { replyTo: 'Office@Roland.example.test', practiceName: null, practicePhone: ' (918) 555-0199 ' }, 'admin@example.test');
  assert.deepEqual(cp.row.value, {
    valley: { practiceName: 'Valley Example Dental' },
    roland: { replyTo: 'office@roland.example.test', practicePhone: '(918) 555-0199' },
  });
  assert.equal(cp.row.updated_by, 'admin@example.test');
  assert.equal(acs.replyToFor('carein', 'roland'), 'office@roland.example.test', 'in force immediately, no wait for the timer');
  assert.equal(acs.practiceNameFor('carein', 'valley'), 'Valley Example Dental');
});

test('persist refuses when what is read back is not what was written', async (t) => {
  const cp = controlPlane(t);
  registry.setPlatformSetting = async (key, value, by) => {
    cp.row = { key, value: { roland: { replyTo: 'someone.else@example.test' } }, updated_at: new Date(), updated_by: by };
    return cp.row;
  };
  await assert.rejects(
    identity.persist('carein', 'roland', { replyTo: 'office@roland.example.test', practiceName: null, practicePhone: null }, 'a@example.test'),
    (e) => e.code === 'IDENTITY_READBACK_FAILED'
  );
});

test('persist refuses a non-office and an unusable value before writing anything', async (t) => {
  const cp = controlPlane(t);
  await assert.rejects(identity.persist('carein', 'unknown', { replyTo: null, practiceName: null, practicePhone: null }, 'a@example.test'), (e) => e.code === 'INVALID_OFFICE');
  await assert.rejects(identity.persist('carein', 'roland', { replyTo: 'not an address', practiceName: null, practicePhone: null }, 'a@example.test'), (e) => e.code === 'INVALID_BODY');
  assert.equal(cp.writes.length, 0);
});
