'use strict';

/** The TC texting kill switch's precedence (queue item 39). */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../platform/registry');
const tcSms = require('./tcSms');

const originalGet = registry.getPlatformSetting;
const originalEnv = process.env.TC_SMS_ENABLED;

test.afterEach(() => {
  registry.getPlatformSetting = originalGet;
  if (originalEnv === undefined) delete process.env.TC_SMS_ENABLED;
  else process.env.TC_SMS_ENABLED = originalEnv;
  tcSms.resetCacheForTests();
});

function stubRow(value) {
  registry.getPlatformSetting = async (key) => {
    assert.equal(key, 'tc_sms_enabled');
    return value === undefined ? null : { key, value, updated_at: new Date('2026-10-08T12:00:00Z'), updated_by: 'beau@carein.ai' };
  };
}

test('the floor is OFF: nothing read, nothing set', () => {
  delete process.env.TC_SMS_ENABLED;
  assert.equal(tcSms.smsEnabled(), false);
  assert.equal(tcSms.source(), 'default');
});

test('env fallback: TC_SMS_ENABLED=true turns it on when no row exists', async () => {
  process.env.TC_SMS_ENABLED = 'true';
  stubRow(undefined);
  await tcSms.refreshFromDb();
  assert.equal(tcSms.smsEnabled(), true);
  assert.equal(tcSms.source(), 'env');
});

test('a stored row beats an ENABLING env var (a stale =true cannot re-enable)', async () => {
  process.env.TC_SMS_ENABLED = 'true';
  stubRow(false);
  await tcSms.refreshFromDb();
  assert.equal(tcSms.smsEnabled(), false);
  assert.equal(tcSms.source(), 'db');
});

test('break-glass: TC_SMS_ENABLED=false beats a stored true', async () => {
  process.env.TC_SMS_ENABLED = 'false';
  stubRow(true);
  await tcSms.refreshFromDb();
  assert.equal(tcSms.smsEnabled(), false);
  assert.equal(tcSms.source(), 'env');
});

test('a stored true with no env turns it on', async () => {
  delete process.env.TC_SMS_ENABLED;
  stubRow(true);
  await tcSms.refreshFromDb();
  assert.equal(tcSms.smsEnabled(), true);
  assert.equal(tcSms.state().updatedBy, 'beau@carein.ai');
});

test('a non-boolean row is ignored (falls through), never read as truthy', async () => {
  delete process.env.TC_SMS_ENABLED;
  for (const junk of ['true', 1, { on: true }, null]) {
    stubRow(junk);
    await tcSms.refreshFromDb();
    assert.equal(tcSms.smsEnabled(), false, JSON.stringify(junk));
  }
});

test('unparseable env values neither enable nor break-glass', async () => {
  stubRow(undefined);
  await tcSms.refreshFromDb();
  for (const v of ['yes', '1', 'on', '']) {
    process.env.TC_SMS_ENABLED = v;
    assert.equal(tcSms.smsEnabled(), false, v);
  }
});

test('control DB unreachable: refresh never throws and keeps the last good value', async () => {
  delete process.env.TC_SMS_ENABLED;
  stubRow(true);
  await tcSms.refreshFromDb();
  registry.getPlatformSetting = async () => {
    throw new Error('connection refused');
  };
  const r = await tcSms.refreshFromDb();
  assert.equal(r.ok, false);
  assert.equal(tcSms.smsEnabled(), true, 'a blip does not flip it');
});

test('control DB never readable since boot: stays OFF (stuck-off is the safe direction)', async () => {
  delete process.env.TC_SMS_ENABLED;
  registry.getPlatformSetting = async () => {
    throw new Error('connection refused');
  };
  await tcSms.refreshFromDb();
  assert.equal(tcSms.smsEnabled(), false);
});
