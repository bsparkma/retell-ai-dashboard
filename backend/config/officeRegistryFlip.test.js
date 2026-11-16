'use strict';

/**
 * MT-1b: officeAgents and odOffices SERVE the office registry, code maps as fallback.
 *
 *   1. NO BEHAVIOR CHANGE while registry == code. Every getter's output, under
 *      three environments, equals __fixtures__/officeGetters.golden.json, which
 *      was generated from the PRE-FLIP code. Checked with the registry never
 *      read AND with a registry stub equal to the code maps.
 *   2. THE DEFNUM PIN. call 486 / referral 491 at roland, call 451 / referral 452
 *      at valley: exactly these when registry and code agree, and the CODE
 *      values when the registry is unreachable, failed its last read, or is stale.
 *   3. The guards: DefNums never cross, env > registry > code, office keys stay
 *      frozen, 'unknown' never comes from the registry, a disabled row is
 *      ignored, credential names stay code-only, the hygiene floor cannot be
 *      raised, and no getter ever waits on (or triggers) a database read.
 *
 * No database, no Open Dental: platform/registry.listTenantOffices is stubbed,
 * and building an OpenDentalService makes no request. Keys are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../platform/registry');
const officeRegistry = require('../platform/officeRegistry');
const officeAgents = require('./officeAgents');
const odOffices = require('./odOffices');
const { buildSnapshot, ENV_KEYS } = require('./officeGetterSnapshot');
const golden = require('./__fixtures__/officeGetters.golden.json');
// AT-2 EDIT (disclosed): the registry now holds the seed AS PATCHED by control
// migration 1789700000000 (commtype_defnums gains `tc`), so that is what the
// code maps are pinned against. The v1 seed literal itself is unchanged.
const { SEED_OFFICES: SEED_OFFICES_V1, TENANT_SLUG } = require('../migrations/1789500000000_seed_office_registry');
const { applyToSeed } = require('../migrations/1789700000000_office_commtype_tc');
const SEED_OFFICES = applyToSeed(SEED_OFFICES_V1);

const SYNTHETIC_KEYS = {
  OPENDENTAL_CUSTOMER_KEY: 'synthetic-roland-customer-key',
  OPENDENTAL_CUSTOMER_KEY_VALLEY: 'synthetic-valley-customer-key',
};

/** Seed rows as pg returns them (jsonb parsed). Equal to the code maps; pinned by officeRegistry.test.js. */
function seedRows() {
  return JSON.parse(JSON.stringify(SEED_OFFICES));
}

/** @param {any[]} rows @param {string} key */
function row(rows, key) {
  return rows.find((r) => r.office_key === key);
}

/**
 * Stub the control plane, isolate env + console, reset every cache around fn.
 * `state.rows` / `state.fail` / `state.hang` may be changed mid-test.
 * @param {(ctx: { state: { rows: any[], fail: boolean, hang: boolean }, reads: () => number,
 *                 warnings: string[], logs: string[], env: (vars: Record<string, string>) => void }) => Promise<void>} fn
 */
async function withRegistry(fn) {
  const original = registry.listTenantOffices;
  const saved = { warn: console.warn, log: console.log, error: console.error };
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const logs = [];
  const state = { rows: seedRows(), fail: false, hang: false };
  let reads = 0;
  registry.listTenantOffices = async (slug) => {
    reads += 1;
    if (state.hang) return new Promise(() => {});
    await new Promise((r) => setImmediate(r));
    if (state.fail) throw new Error('control plane unreachable');
    return slug === TENANT_SLUG ? JSON.parse(JSON.stringify(state.rows)) : [];
  };
  console.warn = (...a) => warnings.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  const reset = () => {
    officeRegistry.resetCacheForTests();
    officeAgents.resetRegistryParityForTests();
    odOffices.resetRegistryParityForTests();
    odOffices.resetOdOfficeCache();
  };
  for (const k of ENV_KEYS) delete process.env[k];
  reset();
  try {
    await fn({
      state,
      reads: () => reads,
      warnings,
      logs,
      env: (vars) => Object.assign(process.env, vars),
    });
  } finally {
    registry.listTenantOffices = original;
    console.warn = saved.warn;
    console.log = saved.log;
    console.error = saved.error;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    reset();
  }
}

/** Run fn with Date.now shifted forward by `ms`. */
function later(ms, fn) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + ms;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

/** The two DefNums each office's handle carries right now. */
function defNums() {
  odOffices.resetOdOfficeCache();
  const view = (k) => {
    const h = odOffices.getOdOffice(k);
    return { call: h.commTypeDefNum, referral: h.referralCommTypeDefNum };
  };
  return { roland: view('roland'), valley: view('valley') };
}

const PINNED = { roland: { call: 486, referral: 491 }, valley: { call: 451, referral: 452 } };

// --- 1. no behavior change while registry == code ------------------------------

test('golden: registry never read → every getter answers exactly as before the flip', async () => {
  await withRegistry(async () => {
    assert.equal(officeRegistry.servedOffices().reason, 'the registry has never been read');
    assert.deepEqual(buildSnapshot(), golden);
  });
});

test('golden: registry stub == code maps → the registry serves, and every getter is unchanged', async () => {
  await withRegistry(async ({ warnings }) => {
    await officeRegistry.refreshFromDb();
    assert.deepEqual(officeRegistry.servedOffices(), {
      byKey: officeRegistry.servedOffices().byKey,
      reason: null,
    });
    assert.equal(officeRegistry.servedOffices().byKey.size, 2);
    assert.deepEqual(buildSnapshot(), golden);
    assert.deepEqual(warnings.filter((w) => w.includes('office registry parity')), []);
  });
});

test('registry == code: getOfficeConfig hands back the SAME code object, not a copy', async () => {
  await withRegistry(async () => {
    await officeRegistry.refreshFromDb();
    assert.equal(officeAgents.getOfficeConfig('valley'), officeAgents.OFFICES.valley);
    assert.equal(officeAgents.getAllOfficeConfigs()[0], officeAgents.OFFICES.roland);
  });
});

// --- 2. the DefNum pin ---------------------------------------------------------

test('DefNum pin: registry and code agree → exactly 486/491 roland, 451/452 valley', async () => {
  await withRegistry(async ({ env }) => {
    env(SYNTHETIC_KEYS);
    await officeRegistry.refreshFromDb();
    assert.equal(officeRegistry.servedOffices().reason, null);
    assert.deepEqual(defNums(), PINNED);
    assert.equal(odOffices.referralChartNoteBlockReason('roland'), null);
    assert.equal(odOffices.referralChartNoteBlockReason('valley'), null);
  });
});

test('DefNum pin: registry unreachable from boot → the CODE values', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    state.fail = true;
    const res = await officeRegistry.refreshFromDb();
    assert.equal(res.ok, false);
    assert.equal(officeRegistry.servedOffices().reason, 'the registry has never been read');
    assert.deepEqual(defNums(), PINNED);
  });
});

test('DefNum pin: a good DIVERGENT read is served, then the CODE values the moment a read fails', async () => {
  await withRegistry(async ({ state, env, warnings }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'roland').commtype_defnums = { call: 777, referral: 778 };
    row(state.rows, 'valley').commtype_defnums = { call: 779, referral: 780 };
    await officeRegistry.refreshFromDb();
    // Proves the flip is real: new, non-crossing DefNums are served.
    assert.deepEqual(defNums(), { roland: { call: 777, referral: 778 }, valley: { call: 779, referral: 780 } });

    state.fail = true;
    await officeRegistry.refreshFromDb();
    assert.equal(officeRegistry.servedOffices().reason, 'the last registry read failed');
    assert.deepEqual(defNums(), PINNED);
    assert.ok(warnings.some((w) => w.includes("'carein' office config is served from the CODE maps: the last registry read failed")));

    // And back again once the control plane answers.
    state.fail = false;
    await officeRegistry.refreshFromDb();
    assert.equal(defNums().roland.call, 777);
  });
});

test('DefNum pin: a good divergent read that goes STALE (15 min) → the CODE values', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'roland').commtype_defnums = { call: 777, referral: 778 };
    await officeRegistry.refreshFromDb();
    assert.equal(defNums().roland.call, 777);
    later(15 * 60 * 1000 - 1000, () => assert.equal(defNums().roland.call, 777));
    later(15 * 60 * 1000 + 1, () => {
      assert.equal(officeRegistry.servedOffices().reason, 'the last good registry read is stale');
      assert.deepEqual(defNums(), PINNED);
    });
  });
});

// --- 3. the guards -------------------------------------------------------------

test('DefNums never cross: another office\'s, or the other type\'s, DefNum is refused', async () => {
  await withRegistry(async ({ state, env, warnings }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'valley').commtype_defnums = { call: 486, referral: 491 }; // Roland's
    row(state.rows, 'roland').commtype_defnums = { call: 486, referral: 486 }; // call as referral
    await officeRegistry.refreshFromDb();
    assert.deepEqual(defNums(), PINNED);
    const lines = warnings.filter((w) => w.includes('office registry parity'));
    assert.ok(lines.some((w) => w.includes("'valley' commTypeDefNums.call differs") && w.includes('DefNums never cross')));
    assert.ok(lines.some((w) => w.includes("'valley' commTypeDefNums.referral differs") && w.includes('DefNums never cross')));
    assert.ok(lines.some((w) => w.includes("'roland' commTypeDefNums.referral differs") && w.includes('DefNums never cross')));
  });
});

test('DefNums never cross between two NEW registry values either', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'roland').commtype_defnums = { call: 777, referral: 491 };
    row(state.rows, 'valley').commtype_defnums = { call: 777, referral: 452 };
    await officeRegistry.refreshFromDb();
    assert.deepEqual(defNums(), PINNED);
  });
});

test('a registry DefNum of null is "unconfigured" → the code default, never a refusal', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'valley').commtype_defnums = { call: null, referral: null };
    await officeRegistry.refreshFromDb();
    assert.deepEqual(defNums(), PINNED);
    assert.equal(odOffices.referralChartNoteBlockReason('valley'), null);
  });
});

test('precedence: env override > registry > code default (env rules exactly as before)', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'roland').commtype_defnums = { call: 777, referral: 778 };
    await officeRegistry.refreshFromDb();
    env({ OPENDENTAL_CAREIN_COMMTYPE_DEFNUM: '9001', OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM: '9002' });
    assert.deepEqual(defNums().roland, { call: 9001, referral: 9002 });
    // A non-numeric override falls through to the registry, not to NaN.
    env({ OPENDENTAL_CAREIN_COMMTYPE_DEFNUM: 'abc', OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM: '0' });
    assert.deepEqual(defNums().roland, { call: 777, referral: 778 });
    // Valley has no registry change: env unset → code.
    assert.deepEqual(defNums().valley, PINNED.valley);
  });
});

test('display name, order, lines and agents are served from the registry', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    const rolandAgent = row(state.rows, 'roland').retell_agent_ids[0];
    row(state.rows, 'valley').display_name = 'Riley';
    row(state.rows, 'valley').sort_order = 0;
    row(state.rows, 'valley').mango_dids.push('+15555550100');
    row(state.rows, 'roland').retell_agent_ids = row(state.rows, 'roland').retell_agent_ids.slice(1);
    row(state.rows, 'valley').retell_agent_ids = [rolandAgent];
    await officeRegistry.refreshFromDb();

    assert.deepEqual(officeAgents.getAllOfficeConfigs().map((o) => o.officeName), ['Riley', 'Roland']);
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '(555) 555-0100' }), 'valley');
    assert.equal(officeAgents.getOfficeForCall({ source: 'retell', handler_id: rolandAgent }), 'valley');
    assert.equal(officeAgents.isAgentAllowedForOffice(rolandAgent, 'valley'), true);
    assert.equal(odOffices.getOdOffice('valley').officeName, 'Riley');
    assert.equal(odOffices.describeOffice('valley').officeName, 'Riley');
  });
});

test('an id two offices claim is refused, not guessed: it keeps its CODE mapping', async () => {
  await withRegistry(async ({ state, warnings }) => {
    const rolandAgent = row(state.rows, 'roland').retell_agent_ids[0];
    const valleyLine = row(state.rows, 'valley').mango_dids[0];
    row(state.rows, 'valley').retell_agent_ids = [rolandAgent]; // roland still lists it
    row(state.rows, 'roland').mango_dids.push(valleyLine);       // valley still lists it
    await officeRegistry.refreshFromDb();
    assert.equal(officeAgents.getOfficeForCall({ source: 'retell', handler_id: rolandAgent }), 'roland');
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: valleyLine }), 'valley');
    assert.ok(warnings.some((w) => w.includes(`Retell agent '${rolandAgent}' is claimed by roland and valley`)));
    assert.ok(warnings.some((w) => w.includes(`Mango line '${valleyLine}' is claimed by roland and valley`)));
  });
});

test('a list with one unusable line is refused whole → that office keeps its CODE lines', async () => {
  await withRegistry(async ({ state }) => {
    row(state.rows, 'valley').mango_dids = ['+15555550100', '12'];
    await officeRegistry.refreshFromDb();
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '+15555550100' }), 'unknown');
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '+14797854390' }), 'valley');
  });
});

test("office keys stay frozen and 'unknown' never comes from the registry", async () => {
  await withRegistry(async ({ state }) => {
    // Rows the schema CHECKs would refuse, smuggled past them by the stub.
    state.rows.push({ ...seedRows()[0], office_key: 'unknown', display_name: 'Hijacked', mango_dids: ['+15555550100'] });
    state.rows.push({ ...seedRows()[1], office_key: 'fortsmith2', display_name: 'Extra', mango_dids: ['+15555550101'] });
    await officeRegistry.refreshFromDb();
    assert.equal(officeAgents.getOfficeConfig('unknown').officeName, 'Unmapped');
    assert.equal(officeAgents.getOfficeConfig('fortsmith2'), null);
    assert.deepEqual(officeAgents.getAllOfficeConfigs().map((o) => o.officeId), ['roland', 'valley']);
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '+15555550100' }), 'unknown');
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '+15555550101' }), 'unknown');
    assert.equal(odOffices.odBlockReason('unknown').code, 'OFFICE_UNKNOWN');
    assert.equal(odOffices.odBlockReason('fortsmith2').code, 'OFFICE_UNKNOWN');
    assert.equal(odOffices.isChartTargetOffice('fortsmith2'), false);
  });
});

test("a 'disabled' registry row is ignored: that office serves its CODE values", async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    Object.assign(row(state.rows, 'valley'), {
      status: 'disabled',
      display_name: 'Riley',
      od_enabled: false,
      commtype_defnums: { call: 779, referral: 780 },
    });
    await officeRegistry.refreshFromDb();
    assert.equal(officeAgents.getOfficeConfig('valley').officeName, 'Valley Fort Smith');
    assert.equal(odOffices.isOdReady('valley'), true);
    assert.deepEqual(defNums().valley, PINNED.valley);
  });
});

test('odEnabled is served from the registry (and only narrows to what credentials allow)', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    row(state.rows, 'valley').od_enabled = false;
    await officeRegistry.refreshFromDb();
    assert.equal(odOffices.odBlockReason('valley').code, 'OFFICE_NOT_OD_CONNECTED');
    assert.throws(() => odOffices.getOdOffice('valley'), { code: 'OFFICE_NOT_OD_CONNECTED' });
    assert.equal(odOffices.isOdReady('roland'), true);
  });
});

test('credential NAMES are code-only: a renamed key variable can never borrow another office\'s key', async () => {
  await withRegistry(async ({ state, env, warnings }) => {
    env({ OPENDENTAL_CUSTOMER_KEY: SYNTHETIC_KEYS.OPENDENTAL_CUSTOMER_KEY }); // Roland's only
    row(state.rows, 'valley').od_customer_key_env = 'OPENDENTAL_CUSTOMER_KEY';
    row(state.rows, 'valley').od_customer_key_secret = 'opendental-customer-key';
    await officeRegistry.refreshFromDb();
    assert.equal(odOffices.odBlockReason('valley').code, 'OFFICE_OD_KEY_MISSING');
    assert.ok(
      warnings.some((w) => w.includes("'valley' odCustomerKeyEnv differs") && w.includes('Serving the CODE value (credential names are code-only'))
    );
    assert.ok(!warnings.join('\n').includes(SYNTHETIC_KEYS.OPENDENTAL_CUSTOMER_KEY), 'no key VALUE is ever logged');
  });
});

test('the hygiene floor can be lowered by the registry but never raised', async () => {
  await withRegistry(async ({ state, env, warnings }) => {
    env(SYNTHETIC_KEYS);
    for (const r of state.rows) r.hyg_od_enabled = true;
    await officeRegistry.refreshFromDb();
    assert.equal(odOffices.isHygOdReady('roland'), false);
    assert.equal(odOffices.hygOdBlockReason('valley').code, 'OFFICE_HYG_NOT_ENABLED');
    assert.ok(odOffices.hygSwitchState().every((s) => s.hardcoded === false && s.enabled === false));
    assert.ok(warnings.some((w) => w.includes("'roland' hygOdEnabled differs") && w.includes('only lower the hygiene floor')));
  });
});

test('no getter waits on, or triggers, a registry read', async () => {
  await withRegistry(async ({ state, reads, env }) => {
    env(SYNTHETIC_KEYS);
    state.hang = true; // a control plane that never answers
    void officeRegistry.refreshFromDb();
    const before = reads();
    // Synchronous, and the code values, while the read is still hanging.
    assert.deepEqual(defNums(), PINNED);
    assert.equal(officeAgents.getOfficeConfig('valley').officeName, 'Valley Fort Smith');
    assert.equal(officeAgents.getOfficeForCall({ source: 'mango', called_number: '+14797854390' }), 'valley');
    buildSnapshot();
    assert.equal(reads(), before, 'getters never read the control plane');
  });
});

test('a cached handle follows a registry change but keeps its client', async () => {
  await withRegistry(async ({ state, env }) => {
    env(SYNTHETIC_KEYS);
    await officeRegistry.refreshFromDb();
    const first = odOffices.getOdOffice('roland');
    assert.equal(odOffices.getOdOffice('roland'), first, 'unchanged values → the same frozen handle');
    row(state.rows, 'roland').commtype_defnums = { call: 777, referral: 491 };
    await officeRegistry.refreshFromDb();
    const second = odOffices.getOdOffice('roland');
    assert.notEqual(second, first);
    assert.equal(second.commTypeDefNum, 777);
    assert.equal(second.client, first.client);
    assert.ok(Object.isFrozen(second));
    // assertOfficeMatch is untouched by the registry: the key is still the code's.
    assert.equal(odOffices.assertOfficeMatch('roland', second), second);
    assert.throws(() => odOffices.assertOfficeMatch('valley', second), { code: 'OFFICE_MISMATCH' });
  });
});

test('only the code-map tenant is ever served', async () => {
  await withRegistry(async () => {
    await officeRegistry.refreshFromDb('some-other-practice');
    assert.equal(officeRegistry.servedOffices().reason, 'the registry has never been read');
    assert.deepEqual(buildSnapshot(), golden);
  });
});
