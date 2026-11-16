'use strict';

/**
 * MT-2b INVARIANT: tenant 'carein's answers are the same before and after the
 * source flip, for every key x office.
 *
 * BEFORE: platform/__fixtures__/mt2bCareinBefore.json, recorded by running every
 * reader at 82c7a5a (pre-MT-2b) over platform/__fixtures__/mt2bCareinMatrix.js
 * with platform_setting stubbed per fixture.
 *
 * AFTER: the same fixtures, where office_setting holds exactly what the MT-2a
 * dual-write mirrors from that platform_setting value
 * (officeSettingKeys.mirrorEntries — the state parity has confirmed clean in
 * staging and prod), and the MT-2b readers are asked for tenant 'carein'.
 *
 * Two cells CANNOT be reproduced, and the test pins that they are the ONLY two
 * and why neither is reachable:
 *   1. hyg_od_enabled stored as an EMPTY map `{}` with a floor of TRUE. Before:
 *      a usable map answered for every office (OFF). office_setting cannot hold
 *      "an empty map" (the mirror writes no rows), so after: no rows -> the
 *      floor. Unreachable: carein's floor is FALSE for both offices (pinned
 *      below), and a `{}` would have tripped the MT-2a parity warning (false vs
 *      null), which staging and prod report clean.
 *   2. hyg_od_enabled asked for a NON-office ('unknown', 'nope') with a floor of
 *      TRUE and no usable stored answer. Before: the floor. After: OFF — the
 *      MT-2b stuck-off rule (an office that is not the tenant's is OFF).
 *      Strictly narrower, and unreachable: odOffices asks odBlockReason first,
 *      which refuses a non-office before the floor is read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const officeSettings = require('./officeSettings');
const officeRegistry = require('./officeRegistry');
const { FakeControlPlane } = require('./officeSettingsTestUtils');
const { mirrorEntries, realOffices: keyRealOffices } = require('./officeSettingKeys');
const M = require('./__fixtures__/mt2bCareinMatrix');
const BEFORE = require('./__fixtures__/mt2bCareinBefore.json');

const sw = require('../config/tcOfficeSwitch');
const hyg = require('../config/hygPilot');
const nurture = require('../config/tcNurture');
const opps = require('../config/tcOpportunities');
const identity = require('../config/emailIdentity');
const acs = require('../config/acsEmail');
const odOffices = require('../config/odOffices');

const T = 'carein';
const savedEnv = Object.fromEntries(M.allEnvNames().map((n) => [n, process.env[n]]));

/** @param {Record<string, string>} vars */
function setEnv(vars) {
  for (const n of M.allEnvNames()) delete process.env[n];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

let fake = new FakeControlPlane();

/**
 * office_setting := what the dual-write mirrors from `value` for `key`.
 * @param {string} key
 * @param {unknown} value undefined = no row
 */
function seed(key, value) {
  fake = new FakeControlPlane();
  if (value !== undefined) {
    fake.seedPlatform(key, value);
    for (const e of mirrorEntries(key, value)) fake.seedOffice(e.officeKey, key, e.value);
  }
  registry.setPoolForTests(fake.pool());
  officeSettings.resetCacheForTests();
  officeRegistry.resetCacheForTests();
}

const quiet = { warn: console.warn, error: console.error };
test.before(() => {
  console.warn = () => {};
  console.error = () => {};
});
test.after(() => {
  Object.assign(console, quiet);
  registry.setPoolForTests(null);
  officeSettings.resetCacheForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('the six switches answer exactly as before, every fixture x env x office', async () => {
  for (const s of M.SWITCHES) {
    const mod = require(`../config/${s.mod}`);
    for (const [vName, v] of Object.entries(M.BOOL_VALUES)) {
      for (const [eName, e] of Object.entries(M.ENVS)) {
        seed(s.key, v);
        setEnv(Object.fromEntries(Object.entries(e).map(([o, raw]) => [s.prefix + o, raw])));
        assert.equal((await mod.refreshFromDb(T)).ok, true);
        const after = Object.fromEntries(M.QUERY_OFFICES.map((o) => [o, mod.enabledFor(T, o)]));
        assert.deepEqual(after, BEFORE.switches[s.key][`${vName}|${eName}`], `${s.key} ${vName}|${eName}`);
      }
    }
  }
});

test('hygiene answers as before, except the two documented unreachable cells', async () => {
  /** @type {string[]} */
  const differing = [];
  for (const [vName, v] of Object.entries(M.BOOL_VALUES)) {
    for (const [eName, e] of Object.entries(M.ENVS)) {
      seed('hyg_od_enabled', v);
      setEnv(Object.fromEntries(Object.entries(e).map(([o, raw]) => ['HYG_OD_ENABLED_' + o, raw])));
      assert.equal((await hyg.refreshFromDb(T)).ok, true);
      const before = BEFORE.hyg[`${vName}|${eName}`];
      for (const o of M.QUERY_OFFICES) {
        const after = { floorOff: hyg.hygEnabledFor(T, o, false), floorOn: hyg.hygEnabledFor(T, o, true) };
        // The floor carein actually runs with is FALSE: that column must match everywhere.
        assert.equal(after.floorOff, before[o].floorOff, `hyg floorOff ${vName}|${eName} ${o}`);
        if (after.floorOn !== before[o].floorOn) differing.push(`${vName}|${eName}|${o}`);
      }
    }
  }
  // Pinned so the documented set cannot silently grow: every one of them is in
  // the floorOn column (a floor carein never runs with) and is either the empty
  // map or a non-office.
  assert.equal(differing.length, 23, `documented hygiene cells: ${differing.join(', ')}`);
  for (const cell of differing) {
    const [vName, , o] = cell.split('|');
    const isEmptyMap = vName === 'empty';
    const isNonOffice = o === 'unknown' || o === 'nope';
    assert.ok(isEmptyMap || isNonOffice, `unexpected hygiene difference at ${cell}`);
  }
  // And carein's real floor is FALSE for both offices, so neither cell can be reached.
  for (const officeKey of ['roland', 'valley']) {
    assert.equal(odOffices.OFFICE_OD_SETTINGS[officeKey].hygOdEnabled, false, `${officeKey} floor`);
  }
});

test('nurture and opportunities switch on exactly the same offices as before', async () => {
  for (const [vName, v] of Object.entries(M.BOOL_VALUES)) {
    for (const [eName, e] of Object.entries(M.NURTURE_KILL)) {
      seed('tc_nurture_enabled', v);
      setEnv(e);
      const r = await nurture.switchedOnOffices(registry, T);
      assert.deepEqual(r.offices, BEFORE.nurture[`${vName}|${eName}`], `nurture ${vName}|${eName}`);
    }
    for (const [eName, e] of Object.entries(M.OPPS_KILL)) {
      seed('tc_opportunities_sync', v);
      setEnv(e);
      const r = await opps.switchedOnOffices(registry, T);
      assert.deepEqual(r.offices, BEFORE.opportunities[`${vName}|${eName}`], `opportunities ${vName}|${eName}`);
    }
  }
});

test('the email identity resolves exactly as before, field by field, with and without app settings', async () => {
  for (const [vName, v] of Object.entries(M.IDENTITY_VALUES)) {
    for (const [eName, e] of Object.entries(M.IDENTITY_ENVS)) {
      seed('tc_email_identity', v);
      setEnv(e);
      assert.equal((await identity.refreshFromDb(T)).ok, true);
      const after = Object.fromEntries(
        ['roland', 'valley', 'unknown'].map((o) => [
          o,
          {
            replyTo: acs.replyToFor(T, o),
            practiceName: acs.practiceNameFor(T, o),
            details: acs.practiceDetailsFor(T, o),
            referralBcc: identity.referralBccFor(T, o),
            state: o === 'unknown' ? null : acs.identityStateFor(T, o),
          },
        ])
      );
      assert.deepEqual(after, BEFORE.identity[`${vName}|${eName}`], `identity ${vName}|${eName}`);
    }
  }
});

test("carein's office keys are byte-identical: roland, valley — registry unreadable (code maps)", () => {
  seed('tc_checkout_enabled', undefined);
  setEnv({});
  assert.deepEqual(sw.realOffices(T), BEFORE.offices.realOffices);
  assert.deepEqual(keyRealOffices(T), BEFORE.offices.settingKeysRealOffices);
  assert.deepEqual(
    Object.fromEntries(M.QUERY_OFFICES.map((o) => [o, sw.isKnownOffice(T, o)])),
    BEFORE.offices.isKnownOffice
  );
  assert.deepEqual(
    Object.fromEntries(M.QUERY_OFFICES.map((o) => [o, acs.isKnownOffice(o)])),
    BEFORE.offices.acsIsKnownOffice
  );
  assert.equal(JSON.stringify(sw.realOffices(T)), '["roland","valley"]');
});
