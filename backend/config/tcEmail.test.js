'use strict';

/** The TC email kill switch's precedence (queue item 40): a mirror of tcEmail.test.js. */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../platform/registry');
const tcEmail = require('./tcEmail');

const originalGet = registry.getPlatformSetting;
const originalEnv = process.env.TC_EMAIL_ENABLED;

test.afterEach(() => {
  registry.getPlatformSetting = originalGet;
  if (originalEnv === undefined) delete process.env.TC_EMAIL_ENABLED;
  else process.env.TC_EMAIL_ENABLED = originalEnv;
  tcEmail.resetCacheForTests();
});

function stubRow(value) {
  registry.getPlatformSetting = async (key) => {
    assert.equal(key, 'tc_email_enabled');
    return value === undefined ? null : { key, value, updated_at: new Date('2026-10-08T12:00:00Z'), updated_by: 'beau@carein.ai' };
  };
}

test('the floor is OFF: nothing read, nothing set', () => {
  delete process.env.TC_EMAIL_ENABLED;
  assert.equal(tcEmail.emailEnabled(), false);
  assert.equal(tcEmail.source(), 'default');
});

test('env fallback: TC_EMAIL_ENABLED=true turns it on when no row exists', async () => {
  process.env.TC_EMAIL_ENABLED = 'true';
  stubRow(undefined);
  await tcEmail.refreshFromDb();
  assert.equal(tcEmail.emailEnabled(), true);
  assert.equal(tcEmail.source(), 'env');
});

test('a stored row beats an ENABLING env var (a stale =true cannot re-enable)', async () => {
  process.env.TC_EMAIL_ENABLED = 'true';
  stubRow(false);
  await tcEmail.refreshFromDb();
  assert.equal(tcEmail.emailEnabled(), false);
  assert.equal(tcEmail.source(), 'db');
});

test('break-glass: TC_EMAIL_ENABLED=false beats a stored true', async () => {
  process.env.TC_EMAIL_ENABLED = 'false';
  stubRow(true);
  await tcEmail.refreshFromDb();
  assert.equal(tcEmail.emailEnabled(), false);
  assert.equal(tcEmail.source(), 'env');
});

test('a stored true with no env turns it on', async () => {
  delete process.env.TC_EMAIL_ENABLED;
  stubRow(true);
  await tcEmail.refreshFromDb();
  assert.equal(tcEmail.emailEnabled(), true);
  assert.equal(tcEmail.state().updatedBy, 'beau@carein.ai');
});

test('a non-boolean row is ignored (falls through), never read as truthy', async () => {
  delete process.env.TC_EMAIL_ENABLED;
  for (const junk of ['true', 1, { on: true }, null]) {
    stubRow(junk);
    await tcEmail.refreshFromDb();
    assert.equal(tcEmail.emailEnabled(), false, JSON.stringify(junk));
  }
});

test('unparseable env values neither enable nor break-glass', async () => {
  stubRow(undefined);
  await tcEmail.refreshFromDb();
  for (const v of ['yes', '1', 'on', '']) {
    process.env.TC_EMAIL_ENABLED = v;
    assert.equal(tcEmail.emailEnabled(), false, v);
  }
});

test('control DB unreachable: refresh never throws and keeps the last good value', async () => {
  delete process.env.TC_EMAIL_ENABLED;
  stubRow(true);
  await tcEmail.refreshFromDb();
  registry.getPlatformSetting = async () => {
    throw new Error('connection refused');
  };
  const r = await tcEmail.refreshFromDb();
  assert.equal(r.ok, false);
  assert.equal(tcEmail.emailEnabled(), true, 'a blip does not flip it');
});

test('control DB never readable since boot: stays OFF (stuck-off is the safe direction)', async () => {
  delete process.env.TC_EMAIL_ENABLED;
  registry.getPlatformSetting = async () => {
    throw new Error('connection refused');
  };
  await tcEmail.refreshFromDb();
  assert.equal(tcEmail.emailEnabled(), false);
});
