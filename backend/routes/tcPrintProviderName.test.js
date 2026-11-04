'use strict';

/**
 * Printouts sign with the provider's FULL NAME, not the Open Dental
 * abbreviation the checkout record stores (services/tc/printProviderName.js).
 *
 *   resolve    "DOC1" → "Dr. Jordan Example" from the office's /providers list;
 *              a hygienist prints without "Dr."; ambiguity is a refusal
 *   same       the print dialog shows exactly what the PDF prints
 *   cache      one GET /providers per office per hour, shared by dialog + print;
 *              never across offices
 *   fail-soft  OD down, OD throwing, OD slow, office not connected, no match →
 *              the abbreviation prints exactly as before, never a blank
 *   read-only  the only Open Dental call is a GET, through apiGetRaw; no write
 *              method on the client is touched, and the source names none
 *
 * Test patients only (roland 12827, valley 7115). Provider names synthetic.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const { randomUUID } = require('node:crypto');

const registry = require('../platform/registry');
const odOffices = require('../config/odOffices');
const tcCheckout = require('../config/tcCheckout');
const odConfigCache = require('../services/odConfigCache');
const checkoutRoute = require('./tc/checkout');
const contract = require('../tc/contract.gen.cjs');
const { bootTcApp, api, FakeTenantDb } = require('./tc/tcTestUtils');
const {
  printProviderName,
  fullNameFromRows,
  PRINT_LOOKUP_DEADLINE_MS,
} = require('../services/tc/printProviderName');

const NOW = new Date('2026-10-30T15:00:00.000Z');
const TODAY = '2026-10-30';
const PRINT = (id, office = 'roland') => `/api/tc/checkout/${id}/print?office=${office}`;

const ENV = {
  TC_EMAIL_PRACTICE_NAME_ROLAND: 'Synthetic Roland Dental',
  TC_EMAIL_PRACTICE_PHONE_ROLAND: '(555) 010-0001',
  TC_EMAIL_PRACTICE_ADDRESS_ROLAND: '1 Example Way, Roland, OK',
  TC_EMAIL_PRACTICE_NAME_VALLEY: 'Synthetic Valley Dental',
  TC_EMAIL_PRACTICE_PHONE_VALLEY: '(555) 010-0002',
  TC_EMAIL_PRACTICE_ADDRESS_VALLEY: '2 Example Way, Fort Smith, AR',
  TC_CHECKOUT_ENABLED_ROLAND: 'true',
  TC_CHECKOUT_ENABLED_VALLEY: 'true',
  OPENDENTAL_DEVELOPER_KEY: 'test-developer-key',
  OPENDENTAL_CUSTOMER_KEY: 'test-roland-customer-key',
  OPENDENTAL_CUSTOMER_KEY_VALLEY: 'test-valley-customer-key',
};

/** Synthetic provider lists, per office. ProvNum 7 is a different person in each. */
const PROVIDERS = {
  roland: [
    { ProvNum: 7, Abbr: 'DOC1', FName: 'Jordan', LName: 'Example', IsHygienist: 'false', IsHidden: 'false' },
    { ProvNum: 8, Abbr: 'HYG1', FName: 'Casey', LName: 'Sample', IsHygienist: 'true', IsHidden: 'false' },
  ],
  valley: [{ ProvNum: 7, Abbr: 'DOC1', FName: 'Riley', LName: 'Placeholder', IsHygienist: 'false', IsHidden: 'false' }],
};

const savedEnv = {};
let savedGetPlatformSetting;
let savedTtl;
/** Every Open Dental call, by method. */
let odCalls = [];
let writes = [];
let patched = [];
/** How the fake Open Dental answers: 'ok' | 'error' | 'throw' | 'hang'. */
let odMode = 'ok';

before(() => {
  for (const k of [...Object.keys(ENV), 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
  savedTtl = process.env.OD_CONFIG_CACHE_TTL_MS;
  delete process.env.OD_CONFIG_CACHE_TTL_MS;
  Object.assign(process.env, ENV);
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
  savedGetPlatformSetting = registry.getPlatformSetting;
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedTtl === undefined) delete process.env.OD_CONFIG_CACHE_TTL_MS;
  else process.env.OD_CONFIG_CACHE_TTL_MS = savedTtl;
  registry.getPlatformSetting = savedGetPlatformSetting;
  odOffices.resetOdOfficeCache();
  odConfigCache.resetOdConfigCache();
  tcCheckout.resetCacheForTests();
});
beforeEach(() => {
  registry.getPlatformSetting = async () => null;
  tcCheckout.resetCacheForTests();
  odConfigCache.resetOdConfigCache();
  checkoutRoute.setClockForTests(() => NOW);
  odCalls = [];
  writes = [];
  patched = [];
  odMode = 'ok';
  for (const office of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(office);
    const originals = {};
    for (const m of ['apiGetRaw', 'apiWriteRaw', 'apiDeleteRaw', 'updateAppointment']) originals[m] = client[m];
    patched.push({ client, originals });
    client.apiGetRaw = async (p, params) => {
      odCalls.push({ office, method: 'GET', path: p, params });
      if (odMode === 'throw') throw new Error('socket hang up');
      // Answers, but far too late for a print (a real, ref'd timer, as a socket would be).
      if (odMode === 'hang') {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 504, data: null, error: 'late' }), 1500));
      }
      if (odMode === 'error' || p !== '/providers') return { ok: false, status: 500, data: null, error: 'down' };
      return { ok: true, status: 200, data: PROVIDERS[office] };
    };
    for (const m of ['apiWriteRaw', 'apiDeleteRaw', 'updateAppointment']) {
      client[m] = async (...args) => {
        writes.push({ office, method: m, args });
        throw new Error(`Open Dental write ${m} called from a print`);
      };
    }
  }
});
afterEach(() => {
  for (const { client, originals } of patched) Object.assign(client, originals);
  checkoutRoute.setClockForTests(null);
});

async function bootTc(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

async function postRaw(baseUrl, p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function pdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try {
    return (await parser.getText()).text.replace(/\s+/g, ' ');
  } finally {
    await parser.destroy();
  }
}

function seedCard(db, over = {}) {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `manual:${randomUUID()}`,
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    provider: 'HYG1',
    provider_seen: 'DOC1',
    operatory: 'Hyg 1',
    visit_date: TODAY,
    payload: contract.emptyCheckoutSnapshot(),
    is_final: false,
    revision: 1,
    submitted_by: 'tc@carein.ai',
    updated_by: 'tc@carein.ai',
    status: 'open',
    source: 'manual',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

const EXCUSE = { templateType: 'excuse', timeSeenRange: '', nextAppointmentDate: '', nextAppointmentTime: '' };

// ── 1. Resolution (pure) ─────────────────────────────────────────────────────

test('resolve: the abbreviation becomes "Dr. FName LName"; a hygienist gets no "Dr."', () => {
  assert.equal(fullNameFromRows(PROVIDERS.roland, 'DOC1'), 'Dr. Jordan Example');
  assert.equal(fullNameFromRows(PROVIDERS.roland, 'HYG1'), 'Casey Sample');
  assert.equal(fullNameFromRows([{ Abbr: 'X', FName: 'A', LName: 'B', IsHygienist: true }], 'X'), 'A B');
});

test('resolve: a provider with no abbreviation is matched on the "FName LName" label it was given', () => {
  const rows = [{ ProvNum: 3, Abbr: '', FName: 'Morgan', LName: 'Example', IsHygienist: 'false' }];
  assert.equal(fullNameFromRows(rows, 'Morgan Example'), 'Dr. Morgan Example');
});

test('resolve: no match, two different people under one label, or a match with no name → null (the label prints)', () => {
  assert.equal(fullNameFromRows(PROVIDERS.roland, 'NOPE'), null);
  assert.equal(
    fullNameFromRows(
      [
        { Abbr: 'DUP', FName: 'Avery', LName: 'Example' },
        { Abbr: 'DUP', FName: 'Jamie', LName: 'Example' },
      ],
      'DUP'
    ),
    null
  );
  assert.equal(fullNameFromRows([{ Abbr: 'BARE', FName: '', LName: '' }], 'BARE'), null);
  assert.equal(fullNameFromRows([], 'DOC1'), null);
  assert.equal(fullNameFromRows(null, 'DOC1'), null);
  // The same person listed twice is not ambiguity.
  assert.equal(
    fullNameFromRows(
      [
        { Abbr: 'TWICE', FName: 'Avery', LName: 'Example' },
        { Abbr: 'TWICE', FName: 'Avery', LName: 'Example' },
      ],
      'TWICE'
    ),
    'Dr. Avery Example'
  );
});

// ── 2. The print: dialog and PDF agree, and both sign with the full name ────

test('print: the dialog shows the full name and the excuse letter signs with it', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'tc', db });

  const dialog = await api(baseUrl, 'GET', PRINT(card.handoff_id));
  assert.equal(dialog.status, 200, JSON.stringify(dialog.body));
  const d = contract.TcCheckoutPrintDefaults.parse(dialog.body);
  assert.equal(d.fixed.providerName, 'Dr. Jordan Example');

  const r = await postRaw(baseUrl, PRINT(card.handoff_id), EXCUSE);
  assert.equal(r.status, 200);
  const text = await pdfText(r.buf);
  assert.ok(text.includes('Dr. Jordan Example, Synthetic Roland Dental'), text);
  assert.ok(!text.includes('DOC1'), text);
});

test('print: with no provider seen, the hygiene provider prints — without "Dr."', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db, { provider_seen: '' });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), EXCUSE);
  assert.equal(r.status, 200);
  const text = await pdfText(r.buf);
  assert.ok(text.includes('Casey Sample, Synthetic Roland Dental'), text);
  assert.ok(!text.includes('Dr. Casey'), text);
});

// ── 3. Cache ────────────────────────────────────────────────────────────────

test('cache: dialog + two prints cost ONE GET /providers; a second office reads its own list', async (t) => {
  const db = new FakeTenantDb();
  const roland = seedCard(db);
  const valley = seedCard(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });

  assert.equal((await api(baseUrl, 'GET', PRINT(roland.handoff_id))).status, 200);
  assert.equal((await postRaw(baseUrl, PRINT(roland.handoff_id), EXCUSE)).status, 200);
  assert.equal((await postRaw(baseUrl, PRINT(roland.handoff_id), EXCUSE)).status, 200);
  assert.deepEqual(
    odCalls.map((c) => [c.office, c.method, c.path]),
    [['roland', 'GET', '/providers']]
  );

  // ProvNum/Abbr collide across practices; each office answers from its own list.
  const v = await postRaw(baseUrl, PRINT(valley.handoff_id, 'valley'), EXCUSE);
  assert.equal(v.status, 200);
  const text = await pdfText(v.buf);
  assert.ok(text.includes('Dr. Riley Placeholder, Synthetic Valley Dental'), text);
  assert.ok(!text.includes('Jordan'), text);
  assert.deepEqual(
    odCalls.map((c) => [c.office, c.method, c.path]),
    [
      ['roland', 'GET', '/providers'],
      ['valley', 'GET', '/providers'],
    ]
  );
});

test('cache: a failed read is not kept — the next print asks again and gets the name', async () => {
  odMode = 'error';
  assert.equal(await printProviderName('roland', 'DOC1'), 'DOC1');
  odMode = 'ok';
  assert.equal(await printProviderName('roland', 'DOC1'), 'Dr. Jordan Example');
  assert.equal(await printProviderName('roland', 'DOC1'), 'Dr. Jordan Example');
  assert.equal(odCalls.length, 2);
});

// ── 4. Fail-soft ────────────────────────────────────────────────────────────

test('fail-soft: Open Dental answering an error → the PDF signs with the abbreviation, exactly as before', async (t) => {
  odMode = 'error';
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const d = contract.TcCheckoutPrintDefaults.parse((await api(baseUrl, 'GET', PRINT(card.handoff_id))).body);
  assert.equal(d.fixed.providerName, 'DOC1');
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), EXCUSE);
  assert.equal(r.status, 200);
  assert.ok((await pdfText(r.buf)).includes('DOC1, Synthetic Roland Dental'));
});

test('fail-soft: the transport throwing, or no match → the stored label, never blank', async () => {
  odMode = 'throw';
  assert.equal(await printProviderName('roland', 'DOC1'), 'DOC1');
  odMode = 'ok';
  assert.equal(await printProviderName('roland', '  ZZZ9  '), 'ZZZ9');
  assert.equal(await printProviderName('roland', ''), '');
  assert.equal(odCalls.filter((c) => c.path === '/providers').length, 2, 'an empty label asks nothing');
});

test('fail-soft: a slow Open Dental does not hold the print past the deadline', async () => {
  assert.ok(PRINT_LOOKUP_DEADLINE_MS > 0 && PRINT_LOOKUP_DEADLINE_MS <= 5000);
  odMode = 'hang';
  const started = Date.now();
  assert.equal(await printProviderName('roland', 'DOC1', { deadlineMs: 50 }), 'DOC1');
  assert.ok(Date.now() - started < 2000);
});

test('fail-soft: an office with no Open Dental key prints the abbreviation and reaches no client', async () => {
  const savedKey = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  try {
    assert.equal(await printProviderName('valley', 'DOC1'), 'DOC1');
    assert.equal(await printProviderName('unknown', 'DOC1'), 'DOC1');
  } finally {
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = savedKey;
    odOffices.resetOdOfficeCache();
  }
  assert.deepEqual(odCalls, []);
});

// ── 5. Read-only ────────────────────────────────────────────────────────────

test('read-only: every Open Dental call a print makes is a GET of /providers, and no write method is touched', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  await api(baseUrl, 'GET', PRINT(card.handoff_id));
  for (const templateType of ['excuse', 'appointment_card']) {
    assert.equal((await postRaw(baseUrl, PRINT(card.handoff_id), { ...EXCUSE, templateType })).status, 200);
  }
  assert.ok(odCalls.length >= 1);
  for (const c of odCalls) assert.deepEqual([c.method, c.path], ['GET', '/providers']);
  assert.deepEqual(writes, []);
});

test('read-only: the source reaches Open Dental only through the GET-only transport', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const resolver = read('../services/tc/printProviderName.js');
  const printRoute = read('./tc/checkoutPrint.js');
  for (const [name, src] of [
    ['printProviderName.js', resolver],
    ['checkoutPrint.js', printRoute],
  ]) {
    assert.ok(
      !/(apiWriteRaw|apiDeleteRaw|apiPost|apiPut|apiPatch|apiDelete|updateAppointment|bookAppointment|cancelAppointment|createCommLog)/.test(src),
      `${name} must not name an Open Dental write method`
    );
    assert.ok(!/getOdOffice\s*\(/.test(src), `${name} must not hold the office handle (it carries write methods)`);
    assert.ok(!/\.client\b/.test(src), `${name} must not touch the client directly`);
  }
  assert.match(resolver, /require\('\.\.\/\.\.\/routes\/tc\/checkoutAppointments'\)/);
  assert.match(resolver, /odGetForOffice\(office\)/);
  // ...and that transport is apiGetRaw and nothing else.
  const transport = read('./tc/checkoutAppointments.js');
  const members = [...transport.matchAll(/\.client\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(members.length > 0);
  for (const m of members) assert.equal(m, 'apiGetRaw');
});
