'use strict';

/**
 * MT-2a parity tripwire + the office_setting reader's cache rules.
 *
 *   D  a divergence logs "office settings parity" ONCE per (key, office),
 *      names the served side (platform_setting), and the reader still SERVES
 *      platform_setting
 *   C  a clean run logs the OK line once per process
 *   I  tc_email_identity divergences name FIELDS only, never a value
 *   U  unarmed (no server.js boot) compares nothing; an unreadable
 *      office_setting compares nothing and changes no answer
 *   R  the reader: one read of all rows per tenant, 5-minute TTL, concurrent
 *      callers share one read, a failed refresh keeps the cache, never read
 *      = null (nobody chose)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('./registry');
const parity = require('./officeSettingsParity');
const officeSettings = require('./officeSettings');
const { FakeControlPlane } = require('./officeSettingsTestUtils');
const tcCheckout = require('../config/tcCheckout');
const hygPilot = require('../config/hygPilot');
const emailIdentity = require('../config/emailIdentity');

const ENV = ['TC_CHECKOUT_ENABLED_ROLAND', 'TC_CHECKOUT_ENABLED_VALLEY', 'HYG_OD_ENABLED_ROLAND', 'HYG_OD_ENABLED_VALLEY'];

function setup(t, { arm = true } = {}) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  const cp = new FakeControlPlane();
  registry.setPoolForTests(cp.pool());
  parity.resetForTests();
  officeSettings.resetCacheForTests();
  tcCheckout.resetCacheForTests();
  hygPilot.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  if (arm) parity.arm();
  const warn = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  t.after(() => {
    registry.setPoolForTests(null);
    parity.resetForTests();
    officeSettings.resetCacheForTests();
    tcCheckout.resetCacheForTests();
    hygPilot.resetCacheForTests();
    emailIdentity.resetCacheForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const lines = (m) => m.mock.calls.map((c) => c.arguments.map(String).join(' '));
  return {
    cp,
    warns: () => lines(warn).filter((l) => l.includes('office settings parity')),
    logs: () => lines(log).filter((l) => l.includes('office settings parity')),
    errors: () => lines(error),
  };
}

test('D: a divergence warns once per (key, office), names the served side, and platform_setting is still served', async (t) => {
  const { cp, warns } = setup(t);
  cp.seedPlatform('tc_checkout_enabled', { roland: true, valley: false });
  cp.seedOffice('roland', 'tc_checkout_enabled', false); // drift
  cp.seedOffice('valley', 'tc_checkout_enabled', false);

  await tcCheckout.refreshFromDb();
  await parity.settled();
  assert.equal(tcCheckout.enabledFor('roland'), true, 'platform_setting is served');
  assert.equal(tcCheckout.officeState('roland').source, 'db');
  assert.deepEqual(warns(), [
    "[officeSettings] office settings parity: 'tc_checkout_enabled' for 'roland' differs — " +
      'platform_setting=true office_setting=false. Serving platform_setting (MT-2a).',
  ]);

  // The same drift on later reads: no second line.
  await tcCheckout.refreshFromDb();
  await tcCheckout.refreshFromDb();
  await parity.settled();
  assert.equal(warns().length, 1);

  // A NEW divergent office for the same key gets its own (single) line.
  cp.seedOffice('valley', 'tc_checkout_enabled', true);
  await tcCheckout.refreshFromDb();
  await parity.settled();
  assert.equal(warns().length, 2);
  assert.match(warns()[1], /'tc_checkout_enabled' for 'valley' differs — platform_setting=false office_setting=true/);
  assert.equal(tcCheckout.enabledFor('valley'), false, 'still platform_setting');
});

test('D: an office absent from office_setting where platform_setting chose is a divergence (switch: null)', async (t) => {
  const { cp, warns } = setup(t);
  cp.seedPlatform('tc_checkout_enabled', { roland: true });
  await tcCheckout.refreshFromDb();
  await parity.settled();
  assert.deepEqual(parity.lastResult('tc_checkout_enabled').map((d) => [d.officeKey, d.platform, d.office]), [
    ['roland', true, null],
  ]);
  assert.equal(warns().length, 1);
});

test('D: a divergence is confirmed against a FRESH office_setting read before it is reported', async (t) => {
  const { cp, warns } = setup(t);
  // Warm the office_setting cache with nothing in it.
  await officeSettings.ensureFresh('carein');
  // A runbook then writes BOTH tables.
  cp.seedPlatform('tc_checkout_enabled', { roland: true });
  cp.seedOffice('roland', 'tc_checkout_enabled', true);
  await tcCheckout.refreshFromDb();
  await parity.settled();
  assert.deepEqual(parity.lastResult('tc_checkout_enabled'), []);
  assert.deepEqual(warns(), []);
});

test('C: a clean comparison of all ten keys logs the OK line ONCE per process', async (t) => {
  const { logs, warns } = setup(t);
  const all = require('./officeSettingKeys').OFFICE_SETTING_KEYS;
  const clean = (k) => {
    const kind = require('./officeSettingKeys').KIND[k];
    if (kind === 'identity') {
      const empty = { replyTo: null, practiceName: null, practicePhone: null, referralBcc: null };
      return { roland: empty, valley: empty };
    }
    if (kind === 'on') return { roland: false, valley: false };
    return { roland: null, valley: null };
  };
  for (const k of all.slice(0, -1)) await parity.compare(k, clean(k));
  assert.deepEqual(logs(), [], 'not until every key has compared');
  await parity.compare(all[all.length - 1], clean(all[all.length - 1]));
  for (const k of all) await parity.compare(k, clean(k));
  assert.deepEqual(logs(), ['[officeSettings] office settings parity OK — 2 office(s), 10 setting(s)']);
  assert.deepEqual(warns(), []);
});

test('I: an identity divergence names the differing FIELDS and never logs a value', async (t) => {
  const { cp, warns } = setup(t);
  cp.seedPlatform('tc_email_identity', {
    roland: { replyTo: 'frontdesk@roland.example.test', practiceName: 'Roland Example Dental' },
  });
  cp.seedOffice('roland', 'tc_email_identity', { replyTo: 'other@roland.example.test', practiceName: 'Roland Example Dental' });
  await emailIdentity.refreshFromDb();
  await parity.settled();
  assert.equal(emailIdentity.storedValue('roland', 'replyTo'), 'frontdesk@roland.example.test', 'platform served');
  const w = warns();
  assert.equal(w.length, 1, JSON.stringify(w)); // valley holds nothing on either side
  assert.match(w[0], /'tc_email_identity' for 'roland' differs — field\(s\) replyTo differ/);
  for (const line of w) {
    assert.doesNotMatch(line, /@|Example Dental/, 'no address, no practice name');
  }
});

test('U: unarmed, nothing is compared; an unreadable office_setting compares nothing and changes no answer', async (t) => {
  {
    const { cp, warns } = setup(t, { arm: false });
    cp.seedPlatform('tc_checkout_enabled', { roland: true });
    await tcCheckout.refreshFromDb();
    await parity.settled();
    assert.equal(parity.lastResult('tc_checkout_enabled'), undefined);
    assert.equal(cp.log.some((s) => s.includes('FROM office_setting')), false, 'office_setting never read');
    assert.deepEqual(warns(), []);
  }
  {
    const { cp, warns, errors } = setup(t);
    cp.seedPlatform('hyg_od_enabled', { roland: true });
    cp.fail.listOfficeSettings = true;
    const r = await hygPilot.refreshFromDb();
    await parity.settled();
    assert.equal(r.ok, true);
    assert.equal(hygPilot.hygEnabledFor('roland'), true);
    assert.equal(parity.lastResult('hyg_od_enabled'), undefined);
    assert.deepEqual(warns(), []);
    assert.equal(errors().filter((l) => l.includes('could not read office_setting')).length, 1);
  }
});

test('R: one read per tenant serves every key; TTL; shared read; failed refresh keeps the cache; never read = null', async (t) => {
  const { cp } = setup(t, { arm: false });
  assert.equal(officeSettings.peek('carein', 'roland', 'tc_checkout_enabled'), null, 'never read = nobody chose');

  cp.seedOffice('roland', 'tc_checkout_enabled', true);
  cp.seedOffice('valley', 'hyg_od_enabled', false);
  const reads = () => cp.log.filter((s) => s.includes('FROM office_setting s')).length;

  const [a, b] = await Promise.all([
    officeSettings.get('carein', 'roland', 'tc_checkout_enabled'),
    officeSettings.get('carein', 'valley', 'hyg_od_enabled'),
  ]);
  assert.equal(reads(), 1, 'concurrent callers share one read of all rows');
  assert.equal(a && a.value, true);
  assert.equal(b && b.value, false);
  assert.equal(a && a.updatedBy, null);
  assert.match(String(a && a.updatedAt), /^2026-11-12T/);
  assert.equal(await officeSettings.get('carein', 'valley', 'tc_checkout_enabled'), null, 'no row = nobody chose');
  assert.equal(reads(), 1, 'fresh within the window');

  // A failed refresh keeps the previous cache.
  cp.fail.listOfficeSettings = true;
  const err = t.mock.method(console, 'error', () => {});
  const r = await officeSettings.refreshFromDb('carein');
  assert.equal(r.ok, false);
  assert.equal(officeSettings.peek('carein', 'roland', 'tc_checkout_enabled').value, true);
  assert.equal(err.mock.callCount(), 1);

  // TTL: TC_SWITCH_REFRESH_MINUTES, default 5.
  assert.equal(officeSettings.refreshMinutes(), 5);
  const saved = process.env.TC_SWITCH_REFRESH_MINUTES;
  process.env.TC_SWITCH_REFRESH_MINUTES = '0.0001';
  t.after(() => {
    if (saved === undefined) delete process.env.TC_SWITCH_REFRESH_MINUTES;
    else process.env.TC_SWITCH_REFRESH_MINUTES = saved;
  });
  cp.fail.listOfficeSettings = false;
  cp.seedOffice('roland', 'tc_checkout_enabled', false);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal((await officeSettings.get('carein', 'roland', 'tc_checkout_enabled')).value, false);

  // Tenants are independent caches.
  assert.equal(await officeSettings.get('another-practice', 'roland', 'tc_checkout_enabled'), null);
});
