'use strict';

/**
 * MT-2b3: the request office gates answer officeRegistry.isTenantOffice for
 * the SESSION tenant. These pin, against the registry in each state:
 *
 *   1. carein, the registry never read / served / mid-blip: roland and valley
 *      pass, everything else is refused, with the SAME bytes the hard-coded
 *      gates sent before MT-2b3.
 *   2. Oracle-free: a made-up office, 'unknown', and ANOTHER tenant's real
 *      office get byte-identical refusals.
 *   3. Any other tenant: its registry offices only; a blip refuses every key
 *      (fail closed); never carein's code maps.
 *   4. No tenant: nothing passes.
 *   5. carein answers synchronously, as the literal gates did.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const officeRegistry = require('./officeRegistry');
const officeGate = require('./officeGate');

/** The exact body every module gate sent for a bad office before MT-2b3. */
const LEGACY_REFUSAL =
  '{"success":false,"error":"office query param is required and must be one of: roland, valley","code":"INVALID_OFFICE"}';

function officeRow(officeKey, sortOrder, status = 'active') {
  return {
    office_key: officeKey,
    display_name: officeKey,
    sort_order: sortOrder,
    retell_agent_ids: [],
    mango_dids: [],
    od_customer_key_secret: null,
    od_customer_key_env: null,
    commtype_defnums: {},
    od_enabled: false,
    hyg_od_enabled: false,
    status,
    updated_at: new Date(0),
    updated_by: null,
  };
}

/** @type {Record<string, unknown[]|Error>} */
let rows = {};
const savedList = registry.listTenantOffices;
const quiet = { warn: console.warn, error: console.error, log: console.log };

test.before(() => {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});
test.beforeEach(() => {
  rows = {};
  registry.listTenantOffices = async (slug) => {
    const v = rows[slug];
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`no registry rows for ${slug}`);
    return v;
  };
  officeRegistry.resetCacheForTests();
});
test.after(() => {
  registry.listTenantOffices = savedList;
  officeRegistry.resetCacheForTests();
  Object.assign(console, quiet);
});

const reqFor = (slug, office) => ({
  tenant: slug === null ? null : { id: 'T', slug },
  query: office === undefined ? {} : { office },
});

/**
 * Run a gate the way Express does; resolve once it has answered.
 * `sync` says whether it had answered before requireOffice returned.
 */
function runGate(gate, req) {
  return new Promise((resolve) => {
    const out = { status: null, text: null, nexted: false, sync: false };
    let returned = false;
    const done = () => {
      out.sync = !returned;
      resolve(out);
    };
    const res = {
      status(code) {
        out.status = code;
        return this;
      },
      json(body) {
        out.text = JSON.stringify(body);
        done();
        return this;
      },
    };
    gate(req, res, (err) => {
      if (err) throw err;
      out.nexted = true;
      done();
    });
    returned = true;
  });
}

const GATE = officeGate.makeRequireOffice('testOffice');
const REFUSED = ['fortsmith', 'unknown', 'Roland', 'VALLEY', '', ' roland', undefined, ['roland', 'valley']];

test('the code-map fallback lists keys without touching Open Dental settings, in codeOffices() order', () => {
  assert.deepEqual(officeRegistry.codeOfficeKeys(), officeRegistry.codeOffices().map((o) => o.officeKey));
  assert.deepEqual(officeRegistry.codeOfficeKeys(), ['roland', 'valley']);
});

test('carein, registry never read: roland/valley pass synchronously; every refusal is the legacy bytes', async () => {
  for (const ok of ['roland', 'valley']) {
    const req = reqFor('carein', ok);
    const r = await runGate(GATE, req);
    assert.equal(r.nexted, true, ok);
    assert.equal(r.sync, true, `${ok}: carein answers before requireOffice returns`);
    assert.equal(req.testOffice, ok);
  }
  for (const bad of REFUSED) {
    const r = await runGate(GATE, reqFor('carein', bad));
    assert.equal(r.nexted, false, String(bad));
    assert.equal(r.sync, true);
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.text, LEGACY_REFUSAL, String(bad));
  }
});

test('oracle-free: another tenant\'s REAL office is refused with the same bytes as a made-up one', async () => {
  rows.acme = [officeRow('main', 1)];
  await officeRegistry.refreshFromDb('acme');
  assert.equal(officeRegistry.isTenantOffice('acme', 'main'), true, 'main IS a real office of acme');

  const madeUp = await runGate(GATE, reqFor('carein', 'fortsmith'));
  const otherTenants = await runGate(GATE, reqFor('carein', 'main'));
  assert.equal(otherTenants.status, 400);
  assert.equal(otherTenants.text, madeUp.text);
  assert.equal(otherTenants.text, LEGACY_REFUSAL);

  // And the reverse: carein's real office, asked for from acme, is refused
  // exactly as a made-up key is, and names only acme's own offices.
  const fromAcmeMadeUp = await runGate(GATE, reqFor('acme', 'fortsmith'));
  const fromAcmeRoland = await runGate(GATE, reqFor('acme', 'roland'));
  assert.equal(fromAcmeRoland.status, 400);
  assert.equal(fromAcmeRoland.text, fromAcmeMadeUp.text);
  assert.equal(
    fromAcmeRoland.text,
    '{"success":false,"error":"office query param is required and must be one of: main","code":"INVALID_OFFICE"}'
  );
});

test('carein, registry served: the registry answers (a third office would pass); roland/valley unchanged', async () => {
  rows.carein = [officeRow('roland', 1), officeRow('valley', 2), officeRow('fortsmith', 3)];
  await officeRegistry.refreshFromDb('carein');
  for (const ok of ['roland', 'valley', 'fortsmith']) {
    assert.equal((await runGate(GATE, reqFor('carein', ok))).nexted, true, ok);
  }
  const r = await runGate(GATE, reqFor('carein', 'nope'));
  assert.equal(r.text.includes('must be one of: roland, valley, fortsmith"'), true, r.text);
});

test('carein, registry BLIP: the code maps answer, so roland/valley pass and refusals keep the legacy bytes', async () => {
  // A good read with only the pair, then a failed read: the blip.
  rows.carein = [officeRow('roland', 1), officeRow('valley', 2)];
  await officeRegistry.refreshFromDb('carein');
  const before = {
    roland: await runGate(GATE, reqFor('carein', 'roland')),
    bad: await runGate(GATE, reqFor('carein', 'fortsmith')),
  };
  rows.carein = new Error('control plane unreachable');
  assert.equal((await officeRegistry.refreshFromDb('carein')).ok, false);
  assert.notEqual(officeRegistry.servedOffices('carein').reason, null, 'the registry is NOT served mid-blip');

  for (const ok of ['roland', 'valley']) {
    const r = await runGate(GATE, reqFor('carein', ok));
    assert.equal(r.nexted, true, `${ok} still passes during the blip`);
    assert.equal(r.sync, true);
  }
  const during = await runGate(GATE, reqFor('carein', 'fortsmith'));
  assert.equal(during.text, LEGACY_REFUSAL);
  assert.equal(during.text, before.bad.text, 'a blip changes no refusal byte for carein');
  assert.equal(before.roland.nexted, true);
});

test('carein, registry BLIP with a registry-only third office: that office is refused until the registry is back', async () => {
  rows.carein = [officeRow('roland', 1), officeRow('valley', 2), officeRow('fortsmith', 3)];
  await officeRegistry.refreshFromDb('carein');
  assert.equal((await runGate(GATE, reqFor('carein', 'fortsmith'))).nexted, true);
  rows.carein = new Error('blip');
  await officeRegistry.refreshFromDb('carein');
  assert.equal((await runGate(GATE, reqFor('carein', 'fortsmith'))).nexted, false, 'the code maps do not know it');
  assert.equal((await runGate(GATE, reqFor('carein', 'roland'))).nexted, true);
});

test('another tenant: its registry offices only, read on demand; never carein\'s code maps', async () => {
  rows.acme = [officeRow('main', 1), officeRow('annex', 2, 'disabled')];
  // Not read yet: the gate reads it before answering.
  const r = await runGate(GATE, reqFor('acme', 'main'));
  assert.equal(r.nexted, true, 'the on-demand read makes main an office');
  assert.equal(r.sync, false, 'a non-carein tenant waits for its registry read');
  for (const bad of ['annex', 'roland', 'valley', 'unknown']) {
    const x = await runGate(GATE, reqFor('acme', bad));
    assert.equal(x.nexted, false, bad);
    assert.equal(x.status, 400, bad);
  }
});

test('another tenant, registry BLIP: every key is refused (fail closed), with a body that names no office', async () => {
  rows.acme = new Error('control plane unreachable');
  for (const office of ['main', 'roland', 'valley']) {
    const r = await runGate(GATE, reqFor('acme', office));
    assert.equal(r.nexted, false, office);
    assert.equal(r.status, 400);
    assert.equal(
      r.text,
      '{"success":false,"error":"office query param is required and must be one of: ","code":"INVALID_OFFICE"}'
    );
  }
  // A good read, then a failed one: served is dropped at once (MT-1b), so the
  // tenant's own office is refused for as long as the blip lasts.
  rows.acme = [officeRow('main', 1)];
  await officeRegistry.refreshFromDb('acme');
  assert.equal((await runGate(GATE, reqFor('acme', 'main'))).nexted, true);
  rows.acme = new Error('blip');
  await officeRegistry.refreshFromDb('acme');
  assert.equal((await runGate(GATE, reqFor('acme', 'main'))).nexted, false);
});

test('no tenant on the request: nothing passes, not even roland', async () => {
  for (const office of ['roland', 'valley']) {
    const r = await runGate(GATE, reqFor(null, office));
    assert.equal(r.nexted, false, office);
    assert.equal(r.status, 400);
  }
  assert.equal(officeGate.isSessionOffice({}, 'roland'), false);
  assert.equal(officeGate.isSessionOffice(undefined, 'roland'), false);
});

test('isSessionOfficeFresh reads a non-carein tenant before answering, and never throws', async () => {
  rows.acme = [officeRow('main', 1)];
  assert.equal(await officeGate.isSessionOfficeFresh(reqFor('acme'), 'main'), true);
  registry.listTenantOffices = async () => {
    throw new Error('boom');
  };
  officeRegistry.resetCacheForTests();
  assert.equal(await officeGate.isSessionOfficeFresh(reqFor('acme'), 'main'), false);
  assert.equal(await officeGate.isSessionOfficeFresh(reqFor('carein'), 'roland'), true);
});

test('messaging.recordInbound refuses another tenant\'s real office before touching anything', async () => {
  rows.acme = [officeRow('main', 1)];
  const messaging = require('../services/messaging');
  await assert.rejects(
    messaging.recordInbound(reqFor('carein'), { office: 'main', channel: 'sms', fromAddress: '+15555550100', body: 'hi' }),
    /frozen office key/
  );
  await assert.rejects(
    messaging.recordInbound(reqFor('acme'), { office: 'roland', channel: 'sms', fromAddress: '+15555550100', body: 'hi' }),
    /frozen office key/
  );
});

test('isOfficeKeyFormat is the database format only, and is not a gate', () => {
  for (const ok of ['roland', 'valley', 'fortsmith', 'office-3', 'tulsa_2', 'ab', 'a'.repeat(32)]) {
    assert.equal(officeGate.isOfficeKeyFormat(ok), true, ok);
  }
  for (const bad of ['Roland', '', 'a', '1office', 'a'.repeat(33), 'Not An Office', null, undefined, 7, ['roland']]) {
    assert.equal(officeGate.isOfficeKeyFormat(bad), false, String(bad));
  }
  assert.equal(officeGate.OFFICE_KEY_FORMAT.source, '^[a-z][a-z0-9_-]{1,31}$', 'the MT-2b2 CHECK pattern');
});

test('ruling scope: during a blip ONLY the unsubscribe recording path skips the registry; the gates and recordInbound still refuse', async () => {
  rows.acme = new Error('control plane unreachable');
  // The gate refuses acme's office...
  assert.equal((await runGate(GATE, reqFor('acme', 'main'))).nexted, false);
  // ...and so does inbound recording, the other messaging path.
  const messaging = require('../services/messaging');
  await assert.rejects(
    messaging.recordInbound(reqFor('acme'), { office: 'main', channel: 'sms', fromAddress: '+15555550100', body: 'hi' }),
    /frozen office key/
  );
  // The unsubscribe path's check would accept the row's office (pinned end to
  // end in routes/publicLinkTenant.test.js).
  assert.equal(officeGate.isOfficeKeyFormat('main'), true);
  // And the source says which check each path uses.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/messaging/index.js'), 'utf8');
  const unsub = src.slice(src.indexOf('async function recordUnsubscribeLink('), src.indexOf('async function recordInbound('));
  assert.match(unsub, /isOfficeKeyFormat\(m\.office_id\)/);
  assert.doesNotMatch(unsub, /isSessionOffice|ensureSessionOffices/);
});
