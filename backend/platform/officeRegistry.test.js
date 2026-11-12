'use strict';

/**
 * MT-1a: the office registry, its seed, its cache, and the parity tripwire.
 *
 *   1. THE PIN. The seed migration's rows equal the code maps field for field.
 *      This is what stops the registry and the code drifting apart while the
 *      registry is dark: change a code map and this goes red.
 *   2. The cache: never-read serves the code maps, a 5-minute TTL, concurrent
 *      callers share one read, and a failed refresh keeps the previous cache.
 *   3. The tripwire: silent on the seed, one warning per divergent field on an
 *      injected divergence, and NO change to any value a consumer is served.
 *
 * No database: platform/registry.listTenantOffices is stubbed. The real schema
 * and seed SQL are exercised by CI's ephemeral-Postgres migrate step.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('./registry');
const officeRegistry = require('./officeRegistry');
const officeAgents = require('../config/officeAgents');
const odOffices = require('../config/odOffices');
const { SEED_OFFICES, TENANT_SLUG } = require('../migrations/1789500000000_seed_office_registry');

/** Every field either parity check owns. */
const ALL_FIELDS = /** @type {const} */ ([
  'row',
  'displayName',
  'sortOrder',
  'retellAgentIds',
  'mangoDids',
  'status',
  'odCustomerKeySecret',
  'odCustomerKeyEnv',
  'commTypeDefNums.call',
  'commTypeDefNums.referral',
  'odEnabled',
  'hygOdEnabled',
]);

/** Deep copy of the seed rows, shaped as pg returns them (jsonb already parsed). */
function seedRows() {
  return JSON.parse(JSON.stringify(SEED_OFFICES));
}

/**
 * Stub the control plane's office read for one test, and capture console output.
 * @param {{ rows?: () => unknown[], fail?: () => boolean }} opts
 * @param {(ctx: { reads: () => number, warnings: string[], logs: string[] }) => Promise<void>} fn
 */
async function withRegistry(opts, fn) {
  const original = registry.listTenantOffices;
  const saved = { warn: console.warn, log: console.log, error: console.error };
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const logs = [];
  let reads = 0;
  registry.listTenantOffices = async (slug) => {
    reads += 1;
    // Yield once so concurrent callers really do overlap.
    await new Promise((r) => setImmediate(r));
    if (opts.fail && opts.fail()) throw new Error('control plane unreachable');
    return slug === TENANT_SLUG ? (opts.rows ? opts.rows() : seedRows()) : [];
  };
  console.warn = (...a) => warnings.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  officeRegistry.resetCacheForTests();
  officeAgents.resetRegistryParityForTests();
  odOffices.resetRegistryParityForTests();
  try {
    await fn({ reads: () => reads, warnings, logs });
  } finally {
    registry.listTenantOffices = original;
    console.warn = saved.warn;
    console.log = saved.log;
    console.error = saved.error;
    officeRegistry.resetCacheForTests();
    officeAgents.resetRegistryParityForTests();
    odOffices.resetRegistryParityForTests();
  }
}

/** Run fn with Date.now shifted forward by `ms`. */
async function later(ms, fn) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + ms;
  try {
    await fn();
  } finally {
    Date.now = realNow;
  }
}

// --- 1. the pin ---------------------------------------------------------------

test('seed == code maps, field for field (the drift pin)', () => {
  const seeded = SEED_OFFICES.map((row) => officeRegistry.mapRow(/** @type {any} */ (row)));
  assert.deepEqual(seeded, officeRegistry.codeOffices());
  assert.deepEqual(officeRegistry.diffOffices(officeRegistry.codeOffices(), seeded, ALL_FIELDS), []);
});

test('seed carries the verified per-practice values and nothing else', () => {
  assert.equal(TENANT_SLUG, 'carein');
  const byKey = Object.fromEntries(SEED_OFFICES.map((o) => [o.office_key, o]));
  assert.deepEqual(Object.keys(byKey), ['roland', 'valley']);
  // The unknown bucket is code-only.
  assert.equal(byKey.unknown, undefined);
  // DefNums never cross: 486/491 Roland, 451/452 Riley (valley).
  assert.deepEqual(byKey.roland.commtype_defnums, { call: 486, referral: 491 });
  assert.deepEqual(byKey.valley.commtype_defnums, { call: 451, referral: 452 });
  // All 8 DIDs, each E.164, each on exactly one office.
  const dids = SEED_OFFICES.flatMap((o) => o.mango_dids);
  assert.equal(dids.length, 8);
  assert.equal(new Set(dids).size, 8);
  for (const did of dids) assert.match(did, /^\+1\d{10}$/);
  assert.deepEqual([...dids].sort(), Object.keys(officeAgents.MANGO_LINE_OFFICE).sort());
  // Every mapped agent, and only on Roland today.
  assert.equal(byKey.roland.retell_agent_ids.length, Object.keys(officeAgents.AGENT_OFFICE).length);
  assert.deepEqual(byKey.valley.retell_agent_ids, []);
  // Secret NAMES only.
  assert.equal(byKey.roland.od_customer_key_secret, 'opendental-customer-key');
  assert.equal(byKey.valley.od_customer_key_secret, 'opendental-customer-key-valley');
  assert.deepEqual(
    SEED_OFFICES.map((o) => o.od_customer_key_secret),
    odOffices.secretNames
  );
});

// --- 2. the cache -------------------------------------------------------------

test('never read: the code maps answer, tagged source=code', () => {
  officeRegistry.resetCacheForTests();
  const read = officeRegistry.cachedOffices();
  assert.equal(read.source, 'code');
  assert.deepEqual(read.offices, officeRegistry.codeOffices());
});

test('a read serves the registry rows, and stays fresh for 5 minutes', async () => {
  await withRegistry({}, async ({ reads }) => {
    const first = await officeRegistry.getOffices();
    assert.equal(first.source, 'registry');
    assert.equal(first.offices.length, 2);
    assert.equal(reads(), 1);

    await later(4 * 60 * 1000, async () => {
      await officeRegistry.getOffices();
    });
    assert.equal(reads(), 1, 'inside the window: no re-read');

    await later(5 * 60 * 1000 + 1, async () => {
      await officeRegistry.getOffices();
    });
    assert.equal(reads(), 2, 'past the window: one re-read');
  });
});

test('concurrent callers share one read', async () => {
  await withRegistry({}, async ({ reads }) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => officeRegistry.getOffices()));
    assert.equal(reads(), 1);
    for (const r of results) assert.equal(r.source, 'registry');
  });
});

test('a failed refresh keeps the previous cache', async () => {
  let failing = false;
  const rows = seedRows();
  rows[1].display_name = 'Read Once';
  await withRegistry({ rows: () => rows, fail: () => failing }, async ({ reads, logs }) => {
    const ok = await officeRegistry.refreshFromDb();
    assert.deepEqual(ok, { ok: true, error: null });

    failing = true;
    await later(5 * 60 * 1000 + 1, async () => {
      const read = await officeRegistry.getOffices();
      assert.equal(read.source, 'registry');
      assert.equal(read.offices[1].displayName, 'Read Once');
    });
    assert.equal(reads(), 2);
    assert.ok(logs.some((l) => l.includes('could not read the offices')));
  });
});

test('a failed FIRST read leaves the code maps answering', async () => {
  await withRegistry({ fail: () => true }, async () => {
    const res = await officeRegistry.refreshFromDb();
    assert.equal(res.ok, false);
    const read = officeRegistry.cachedOffices();
    assert.equal(read.source, 'code');
    assert.deepEqual(read.offices, officeRegistry.codeOffices());
  });
});

test('a failed read is logged once per distinct message, not per attempt', async () => {
  await withRegistry({ fail: () => true }, async ({ logs }) => {
    await officeRegistry.refreshFromDb();
    await officeRegistry.refreshFromDb();
    await officeRegistry.refreshFromDb();
    assert.equal(logs.filter((l) => l.includes('could not read the offices')).length, 1);
  });
});

// --- 3. the parity tripwire --------------------------------------------------

test('parity is silent on the seed', async () => {
  await withRegistry({}, async ({ warnings, logs }) => {
    await officeRegistry.refreshFromDb();
    assert.deepEqual(warnings, []);
    assert.ok(logs.some((l) => l.startsWith('[officeAgents] office registry parity OK')));
    assert.ok(logs.some((l) => l.startsWith('[odOffices] office registry parity OK')));
  });
});

// MT-1b EDIT (disclosed): this test pinned the MT-1a "dark" contract — the
// registry changes nothing a consumer reads. MT-1b reverses exactly that, so
// the setup and the warning counts are unchanged and only the served-value
// expectations below are inverted. The crossed DefNum is still refused.
test('parity warns once per divergent field, and says which side it serves', async () => {
  const rows = seedRows();
  rows[1].display_name = 'Riley';                       // officeAgents field
  rows[1].mango_dids = rows[1].mango_dids.slice(1);     // officeAgents field
  rows[0].commtype_defnums = { call: 451, referral: 491 }; // odOffices field: a crossed DefNum
  rows[1].od_enabled = false;                           // odOffices field
  rows.push({ ...seedRows()[0], office_key: 'fortsmith2', display_name: 'Extra' }); // extra row

  // What consumers are served BEFORE the registry is read.
  const valleyCall = { source: 'mango', called_number: '+14797854390' };
  const before = {
    officeName: officeAgents.getOfficeConfig('valley').officeName,
    valleyLine: officeAgents.getOfficeForCall(valleyCall),
    describeValley: odOffices.describeOffice('valley'),
    describeRoland: odOffices.describeOffice('roland'),
    rolandCommType: odOffices.OFFICE_OD_SETTINGS.roland.defaultCommTypeDefNum,
    valleyOdEnabled: odOffices.OFFICE_OD_SETTINGS.valley.odEnabled,
    offices: officeAgents.getAllOfficeConfigs(),
  };

  await withRegistry({ rows: () => rows }, async ({ warnings }) => {
    await officeRegistry.refreshFromDb();

    const lines = warnings.filter((w) => w.includes('office registry parity'));
    const has = (prefix, officeKey, field) =>
      lines.filter((w) => w.startsWith(`[${prefix}]`) && w.includes(`'${officeKey}' ${field} differs`)).length;
    assert.equal(has('officeAgents', 'valley', 'displayName'), 1);
    assert.equal(has('officeAgents', 'valley', 'mangoDids'), 1);
    assert.equal(has('officeAgents', 'fortsmith2', 'row'), 1);
    assert.equal(has('odOffices', 'roland', 'commTypeDefNums.call'), 1);
    assert.equal(has('odOffices', 'valley', 'odEnabled'), 1);
    assert.equal(lines.length, 5, lines.join('\n'));
    // The extra row is reported by its presence, and the OD check never sees it.
    assert.equal(has('odOffices', 'fortsmith2', 'row'), 0);
    const served = (prefix, officeKey, field) =>
      lines.find((w) => w.startsWith(`[${prefix}]`) && w.includes(`'${officeKey}' ${field} differs`));
    assert.match(served('officeAgents', 'valley', 'displayName'), /Serving the REGISTRY value/);
    assert.match(served('officeAgents', 'valley', 'mangoDids'), /Serving the REGISTRY value/);
    assert.match(served('officeAgents', 'fortsmith2', 'row'), /Serving the CODE value \(not a frozen office key/);
    assert.match(served('odOffices', 'roland', 'commTypeDefNums.call'), /Serving the CODE value \(DefNum 451 belongs to valley call/);
    assert.match(served('odOffices', 'valley', 'odEnabled'), /Serving the REGISTRY value/);

    // Same divergence on the next refresh → no new warning.
    await later(5 * 60 * 1000 + 1, () => officeRegistry.getOffices());
    assert.equal(warnings.filter((w) => w.includes('office registry parity')).length, 5);

    // MT-1b: the registry's values are served, except the refused ones.
    assert.equal(before.officeName, 'Valley Fort Smith');
    assert.equal(officeAgents.getOfficeConfig('valley').officeName, 'Riley');
    assert.equal(before.valleyLine, 'valley');
    assert.equal(officeAgents.getOfficeForCall(valleyCall), 'unknown', 'the dropped line is unmapped, never Roland');
    assert.equal(before.describeValley.officeName, 'Valley Fort Smith');
    assert.deepEqual(odOffices.describeOffice('valley'), {
      officeId: 'valley',
      officeName: 'Riley',
      odConnected: false,
      odBlockedReason: 'Open Dental is not connected for Riley yet',
    });
    // Roland's crossed DefNum was refused, so nothing about Roland moved.
    assert.deepEqual(odOffices.describeOffice('roland'), before.describeRoland);
    // The code maps themselves are never written to.
    assert.equal(odOffices.OFFICE_OD_SETTINGS.roland.defaultCommTypeDefNum, before.rolandCommType);
    assert.equal(odOffices.OFFICE_OD_SETTINGS.valley.odEnabled, before.valleyOdEnabled);
    assert.deepEqual(officeAgents.getAllOfficeConfigs(), [
      before.offices[0],
      { officeId: 'valley', officeName: 'Riley' },
    ]);
    // The registry-only row never becomes an office.
    assert.equal(officeAgents.getOfficeConfig('fortsmith2'), null);
  });
});

test('parity reports a seeded office missing from the registry by presence only', async () => {
  await withRegistry({ rows: () => seedRows().slice(0, 1) }, async ({ warnings }) => {
    await officeRegistry.refreshFromDb();
    const lines = warnings.filter((w) => w.includes('office registry parity'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.ok(lines[0].startsWith("[officeAgents] office registry parity: 'valley' row differs"));
  });
});

test('parity follows a toggled code value (compares the live map, not a snapshot)', async () => {
  const settings = odOffices.OFFICE_OD_SETTINGS.valley;
  const original = settings.odEnabled;
  settings.odEnabled = false;
  try {
    await withRegistry({}, async ({ warnings }) => {
      await officeRegistry.refreshFromDb();
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[odOffices\] office registry parity: 'valley' odEnabled differs — code=false registry=true/);
    });
  } finally {
    settings.odEnabled = original;
  }
});

test('parity ignores every tenant except the code-map tenant', async () => {
  await withRegistry({ rows: () => [] }, async ({ warnings }) => {
    await officeRegistry.refreshFromDb('some-other-practice');
    assert.deepEqual(warnings, []);
  });
});

test('id lists compare as sets: order is not a divergence', () => {
  const code = officeRegistry.codeOffices();
  const reg = code.map((o) => ({ ...o, mangoDids: [...o.mangoDids].reverse(), retellAgentIds: [...o.retellAgentIds].reverse() }));
  assert.deepEqual(officeRegistry.diffOffices(code, reg, ALL_FIELDS), []);
});

test('mapRow: a malformed DefNum reads as UNCONFIGURED (null), never a guess', () => {
  const row = { ...seedRows()[0], commtype_defnums: { call: '486', referral: -1 } };
  assert.deepEqual(officeRegistry.mapRow(row).commTypeDefNums, { call: null, referral: null });
});

test('no secret VALUE can reach the registry shape or the parity log', async () => {
  const saved = process.env.OPENDENTAL_CUSTOMER_KEY;
  process.env.OPENDENTAL_CUSTOMER_KEY = 'synthetic-not-a-real-key-value';
  try {
    const rows = seedRows();
    rows[0].od_customer_key_secret = 'renamed-secret';
    await withRegistry({ rows: () => rows }, async ({ warnings, logs }) => {
      await officeRegistry.refreshFromDb();
      const all = [...warnings, ...logs].join('\n');
      assert.ok(all.includes('renamed-secret'));
      assert.ok(!all.includes('synthetic-not-a-real-key-value'));
      assert.ok(!JSON.stringify(officeRegistry.codeOffices()).includes('synthetic-not-a-real-key-value'));
    });
  } finally {
    if (saved === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY;
    else process.env.OPENDENTAL_CUSTOMER_KEY = saved;
  }
});
